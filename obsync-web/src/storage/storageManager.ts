import { toBuffer } from '../crypto/base64';
import { OfflineCache } from './offlineCache';
import { GitHubProvider } from './providers/githubProvider';
import { GoogleDriveProvider } from './providers/googleDriveProvider';
import { LocalFolderProvider } from './providers/localFolderProvider';
import { S3Provider } from './providers/s3Provider';
import {
  AuthExpiredError,
  type ManagedListResult,
  type ManagedReadResult,
  type MirrorSummary,
  type ProviderHealthState,
  type ProviderRuntimeStatus,
  type StorageProvider,
  type StorageProviderConfig,
} from './types';

export type ProviderFactory = (
  config: StorageProviderConfig,
  cache: OfflineCache
) => StorageProvider;

export function defaultProviderFactory(
  config: StorageProviderConfig,
  cache: OfflineCache
): StorageProvider {
  switch (config.type) {
    case 'github':
      return new GitHubProvider(config);
    case 'gdrive':
      return new GoogleDriveProvider(config);
    case 'local':
      return new LocalFolderProvider(config, cache);
    case 's3':
      return new S3Provider(config);
  }
}

interface ManagedEntry {
  config: StorageProviderConfig;
  provider: StorageProvider;
}

export function getConnectionFingerprint(config: StorageProviderConfig): string {
  switch (config.type) {
    case 'github':
      return JSON.stringify([
        config.type,
        config.owner,
        config.repo,
        config.branch,
        config.token,
      ]);
    case 'gdrive':
      return JSON.stringify([
        config.type,
        config.clientId,
        config.accountEmail ?? '',
        config.folderName,
        config.rootFolderId ?? '',
      ]);
    case 'local':
      return JSON.stringify([config.type, config.id]);
    case 's3':
      return JSON.stringify([
        config.type,
        config.endpoint,
        config.region,
        config.bucket,
        config.prefix ?? '',
        config.accessKeyId,
        config.secretAccessKey,
      ]);
  }
}

export class StorageManager {
  readonly cache: OfflineCache;
  private entries: ManagedEntry[] = [];
  private statuses = new Map<string, ProviderRuntimeStatus>();
  private listeners = new Set<() => void>();
  private readonly factory: ProviderFactory;

  constructor(
    configs: StorageProviderConfig[],
    cache = new OfflineCache(),
    factory: ProviderFactory = defaultProviderFactory
  ) {
    this.cache = cache;
    this.factory = factory;
    this.setConfigs(configs);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  setConfigs(configs: StorageProviderConfig[]): void {
    const previousById = new Map(this.entries.map((e) => [e.config.id, e]));

    this.entries = configs.map((config) => {
      const existing = previousById.get(config.id);
      if (
        existing &&
        getConnectionFingerprint(existing.config) ===
          getConnectionFingerprint(config)
      ) {
        return { config, provider: existing.provider };
      }
      return {
        config,
        provider: this.factory(config, this.cache),
      };
    });

    const validIds = new Set(configs.map((c) => c.id));
    for (const key of this.statuses.keys()) {
      if (!validIds.has(key)) this.statuses.delete(key);
    }
    for (const cfg of configs) {
      if (!this.statuses.has(cfg.id)) {
        this.statuses.set(cfg.id, {
          providerId: cfg.id,
          state: 'idle',
          pendingOps: 0,
        });
      }
    }
    void this.refreshPendingCounts();
    this.notify();
  }

  getConfigs(): StorageProviderConfig[] {
    return this.entries.map((e) => e.config);
  }

  getEnabledEntries(): ManagedEntry[] {
    return this.entries.filter((e) => e.config.enabled);
  }

  getProvider(providerId: string): StorageProvider | undefined {
    return this.entries.find((e) => e.config.id === providerId)?.provider;
  }

  getStatuses(): ProviderRuntimeStatus[] {
    return this.entries.map(
      (e) =>
        this.statuses.get(e.config.id) ?? {
          providerId: e.config.id,
          state: 'idle',
          pendingOps: 0,
        }
    );
  }

  async refreshPendingCounts(): Promise<number> {
    const ops = await this.cache.getPendingOps();
    const counts = new Map<string, number>();
    for (const op of ops) {
      counts.set(op.providerId, (counts.get(op.providerId) ?? 0) + 1);
    }
    for (const entry of this.entries) {
      const existing = this.statuses.get(entry.config.id) ?? {
        providerId: entry.config.id,
        state: 'idle' as ProviderHealthState,
        pendingOps: 0,
      };
      this.statuses.set(entry.config.id, {
        ...existing,
        pendingOps: counts.get(entry.config.id) ?? 0,
      });
    }
    this.notify();
    return ops.length;
  }

  private markSuccess(providerId: string): void {
    const prev = this.statuses.get(providerId) ?? {
      providerId,
      state: 'ok' as ProviderHealthState,
      pendingOps: 0,
    };
    this.statuses.set(providerId, {
      ...prev,
      state: 'ok',
      lastSuccessAt: new Date().toISOString(),
      lastError: undefined,
    });
    this.notify();
  }

  private markError(providerId: string, err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    const state: ProviderHealthState =
      err instanceof AuthExpiredError ? 'auth-expired' : 'error';
    const prev = this.statuses.get(providerId) ?? {
      providerId,
      state,
      pendingOps: 0,
    };
    this.statuses.set(providerId, {
      ...prev,
      state,
      lastError: message,
    });
    this.notify();
    return message;
  }

  async testProvider(providerId: string): Promise<{ ok: boolean; details: string }> {
    const provider = this.getProvider(providerId);
    if (!provider) return { ok: false, details: 'Provider not found.' };
    try {
      const res = await provider.testConnection();
      if (res.ok) {
        this.markSuccess(providerId);
      } else {
        this.markError(providerId, new Error(res.details));
      }
      return res;
    } catch (err) {
      const msg = this.markError(providerId, err);
      return { ok: false, details: msg };
    }
  }

  async list(prefix = ''): Promise<ManagedListResult> {
    const enabled = this.getEnabledEntries();
    if (enabled.length === 0) {
      const cached = await this.cache.listFiles(prefix);
      return {
        entries: cached,
        sourceProviderId: cached.length > 0 ? 'offline-cache' : 'none',
        sourceLabel: cached.length > 0 ? 'Offline Cache' : 'No storage configured',
        usedFallback: cached.length > 0,
        warnings: [],
      };
    }

    const warnings: string[] = [];
    for (let i = 0; i < enabled.length; i++) {
      const { config, provider } = enabled[i];
      try {
        const entries = await provider.list(prefix);
        this.markSuccess(provider.id);
        return {
          entries,
          sourceProviderId: provider.id,
          sourceLabel: config.label,
          usedFallback: i > 0,
          warnings,
        };
      } catch (err) {
        const msg = this.markError(provider.id, err);
        warnings.push(`${config.label}: ${msg}`);
      }
    }

    const cached = await this.cache.listFiles(prefix);
    return {
      entries: cached,
      sourceProviderId: 'offline-cache',
      sourceLabel: 'Offline Cache',
      usedFallback: true,
      warnings,
    };
  }

  async read(path: string): Promise<ManagedReadResult> {
    const cleanPath = path.replace(/^\/+/, '');
    const enabled = this.getEnabledEntries();
    if (enabled.length === 0) {
      const cached = await this.cache.getFile(cleanPath);
      return {
        data: cached ? cached.data : null,
        etag: cached?.etag,
        sourceProviderId: cached ? 'offline-cache' : 'none',
        sourceLabel: cached ? 'Offline Cache' : 'No storage configured',
        usedFallback: !!cached,
        warnings: [],
      };
    }

    const warnings: string[] = [];
    const pendingAll = await this.cache.getPendingOps();
    const pendingSet = new Set(
      pendingAll.filter((o) => o.path === cleanPath).map((o) => o.providerId)
    );

    for (let i = 0; i < enabled.length; i++) {
      const { config, provider } = enabled[i];
      if (pendingSet.has(provider.id)) {
        warnings.push(
          `${config.label}: skipped because a newer change is pending sync`
        );
        continue;
      }

      try {
        const res = await provider.read(cleanPath);
        this.markSuccess(provider.id);

        if (res === null) {
          return {
            data: null,
            sourceProviderId: provider.id,
            sourceLabel: config.label,
            usedFallback: i > 0,
            warnings,
          };
        }

        const buf = toBuffer(res.data);
        await this.cache.putFile(cleanPath, buf, res.etag);
        return {
          data: buf,
          etag: res.etag,
          sourceProviderId: provider.id,
          sourceLabel: config.label,
          usedFallback: i > 0,
          warnings,
        };
      } catch (err) {
        const msg = this.markError(provider.id, err);
        warnings.push(`${config.label}: ${msg}`);
      }
    }

    const cached = await this.cache.getFile(cleanPath);
    return {
      data: cached ? cached.data : null,
      etag: cached?.etag,
      sourceProviderId: 'offline-cache',
      sourceLabel: 'Offline Cache',
      usedFallback: true,
      warnings,
    };
  }

  async write(path: string, data: Uint8Array, message?: string): Promise<MirrorSummary> {
    const cleanPath = path.replace(/^\/+/, '');
    const payload = toBuffer(data);
    await this.cache.putFile(cleanPath, payload);

    const enabled = this.getEnabledEntries();
    if (enabled.length === 0) {
      throw new Error('No storage provider is enabled. Configure one in Settings.');
    }

    let primaryWritten: ManagedEntry | null = null;
    let primaryUsedFallback = false;
    const mirroredTo: string[] = [];
    const queuedFor: MirrorSummary['queuedFor'] = [];

    for (let i = 0; i < enabled.length; i++) {
      const entry = enabled[i];
      const { config, provider } = entry;

      const shouldAttempt = primaryWritten === null || config.mirrorWrites;
      if (!shouldAttempt) continue;

      try {
        await provider.write(cleanPath, payload, message);
        this.markSuccess(provider.id);
        await this.cache.removeMirrorOp(`${provider.id}::${cleanPath}`);

        if (primaryWritten === null) {
          primaryWritten = entry;
          primaryUsedFallback = i > 0;
        } else {
          mirroredTo.push(config.label);
        }
      } catch (err) {
        const reason = this.markError(provider.id, err);
        await this.cache.enqueueMirrorOp({
          id: `${provider.id}::${cleanPath}`,
          providerId: provider.id,
          op: 'write',
          path: cleanPath,
          data: payload,
          message,
          createdAt: new Date().toISOString(),
          lastError: reason,
        });
        queuedFor.push({ providerId: provider.id, label: config.label, reason });
      }
    }

    await this.refreshPendingCounts();

    if (primaryWritten === null) {
      const details = queuedFor.map((q) => `${q.label}: ${q.reason}`).join('; ');
      throw new Error(
        `All storage providers failed. Change was cached locally for retry. (${details})`
      );
    }

    return {
      primaryWrittenProviderId: primaryWritten.provider.id,
      primaryWrittenLabel: primaryWritten.config.label,
      usedFallback: primaryUsedFallback,
      mirroredTo,
      queuedFor,
    };
  }

  async delete(path: string, message?: string): Promise<MirrorSummary> {
    const cleanPath = path.replace(/^\/+/, '');
    await this.cache.deleteFile(cleanPath);

    const enabled = this.getEnabledEntries();
    if (enabled.length === 0) {
      throw new Error('No storage provider is enabled. Configure one in Settings.');
    }

    let primaryWritten: ManagedEntry | null = null;
    let primaryUsedFallback = false;
    const mirroredTo: string[] = [];
    const queuedFor: MirrorSummary['queuedFor'] = [];

    for (let i = 0; i < enabled.length; i++) {
      const entry = enabled[i];
      const { config, provider } = entry;
      const shouldAttempt = primaryWritten === null || config.mirrorWrites;
      if (!shouldAttempt) continue;

      try {
        await provider.delete(cleanPath, message);
        this.markSuccess(provider.id);
        await this.cache.removeMirrorOp(`${provider.id}::${cleanPath}`);

        if (primaryWritten === null) {
          primaryWritten = entry;
          primaryUsedFallback = i > 0;
        } else {
          mirroredTo.push(config.label);
        }
      } catch (err) {
        const reason = this.markError(provider.id, err);
        await this.cache.enqueueMirrorOp({
          id: `${provider.id}::${cleanPath}`,
          providerId: provider.id,
          op: 'delete',
          path: cleanPath,
          message,
          createdAt: new Date().toISOString(),
          lastError: reason,
        });
        queuedFor.push({ providerId: provider.id, label: config.label, reason });
      }
    }

    await this.refreshPendingCounts();

    if (primaryWritten === null) {
      const details = queuedFor.map((q) => `${q.label}: ${q.reason}`).join('; ');
      throw new Error(
        `All storage providers failed to delete "${cleanPath}". Queued locally. (${details})`
      );
    }

    return {
      primaryWrittenProviderId: primaryWritten.provider.id,
      primaryWrittenLabel: primaryWritten.config.label,
      usedFallback: primaryUsedFallback,
      mirroredTo,
      queuedFor,
    };
  }

  async flushPendingMirrors(targetProviderId?: string): Promise<{
    flushed: number;
    remaining: number;
    errors: string[];
  }> {
    const ops = await this.cache.getPendingOps(targetProviderId);
    let flushed = 0;
    const errors: string[] = [];

    for (const op of ops) {
      const entry = this.entries.find((e) => e.config.id === op.providerId);
      if (!entry || !entry.config.enabled) {
        // Provider removed or disabled; drop stale op if removed
        if (!entry) await this.cache.removeMirrorOp(op.id);
        continue;
      }

      try {
        if (op.op === 'write') {
          const data =
            op.data ?? (await this.cache.getFile(op.path))?.data;
          if (!data) {
            await this.cache.removeMirrorOp(op.id);
            continue;
          }
          await entry.provider.write(op.path, data, op.message);
        } else {
          await entry.provider.delete(op.path, op.message);
        }

        await this.cache.removeMirrorOp(op.id);
        this.markSuccess(entry.provider.id);
        flushed++;
      } catch (err) {
        const msg = this.markError(entry.provider.id, err);
        await this.cache.enqueueMirrorOp({ ...op, lastError: msg });
        errors.push(`${entry.config.label} (${op.path}): ${msg}`);
      }
    }

    const remaining = await this.refreshPendingCounts();
    return { flushed, remaining, errors };
  }

  async mirrorAllFiles(
    sourceProviderId: string,
    targetProviderId: string,
    onProgress?: (done: number, total: number, currentPath: string) => void
  ): Promise<{ copied: number; failed: number; errors: string[] }> {
    const source = this.getProvider(sourceProviderId);
    const target = this.getProvider(targetProviderId);
    if (!source || !target) {
      throw new Error('Source or target provider not found.');
    }

    const files = (await source.list('')).filter((f) => !f.path.startsWith('.git/'));
    let copied = 0;
    let failed = 0;
    const errors: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      onProgress?.(i, files.length, file.path);
      try {
        const readRes = await source.read(file.path);
        if (!readRes) continue;
        await target.write(file.path, readRes.data, `Mirror ${file.path}`);
        await this.cache.removeMirrorOp(`${target.id}::${file.path}`);
        copied++;
      } catch (err) {
        failed++;
        const msg = this.markError(target.id, err);
        errors.push(`${file.path}: ${msg}`);
      }
    }

    if (failed === 0) this.markSuccess(target.id);
    await this.refreshPendingCounts();
    onProgress?.(files.length, files.length, '');

    return { copied, failed, errors };
  }
}
