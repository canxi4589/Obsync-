import { asBufferSource } from '../../crypto/base64';
import type { OfflineCache } from '../offlineCache';
import { assertSafeStoragePath } from '../pathUtils';
import {
  AuthExpiredError,
  type FileEntry,
  type LocalProviderConfig,
  type ReadResult,
  type StorageProvider,
} from '../types';

export interface DirectoryPickerWindow {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
  }) => Promise<FileSystemDirectoryHandle>;
}

interface PermissionCapableHandle {
  queryPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
}

const STAT_CONCURRENCY = 8;

export class LocalFolderProvider implements StorageProvider {
  readonly id: string;
  readonly type = 'local' as const;
  readonly label: string;

  private readonly cache: OfflineCache;
  private readonly injectedHandle?: FileSystemDirectoryHandle;

  constructor(
    config: LocalProviderConfig,
    cache: OfflineCache,
    injectedHandle?: FileSystemDirectoryHandle
  ) {
    this.id = config.id;
    this.label = config.label;
    this.cache = cache;
    this.injectedHandle = injectedHandle;
  }

  static isSupported(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof (window as unknown as DirectoryPickerWindow).showDirectoryPicker === 'function'
    );
  }

  static async pickAndStoreFolder(
    providerId: string,
    cache: OfflineCache
  ): Promise<string> {
    if (!LocalFolderProvider.isSupported()) {
      throw new Error(
        'Local Folder access is not supported in this browser (use Chrome/Edge on Desktop).'
      );
    }
    const picker = (window as unknown as DirectoryPickerWindow).showDirectoryPicker!;
    const handle = await picker({ mode: 'readwrite' });
    await cache.saveFsHandle(providerId, handle);
    return handle.name;
  }

  private async getRootHandle(mode: 'read' | 'readwrite'): Promise<FileSystemDirectoryHandle> {
    const handle =
      this.injectedHandle ??
      (await this.cache.getFsHandle<FileSystemDirectoryHandle>(this.id));

    if (!handle) {
      throw new AuthExpiredError(
        `Local folder handle missing for "${this.label}" — click Reconnect in Settings.`
      );
    }

    const permHandle = handle as unknown as PermissionCapableHandle;
    if (permHandle.queryPermission) {
      const current = await permHandle.queryPermission({ mode });
      if (current !== 'granted') {
        if (permHandle.requestPermission) {
          try {
            const requested = await permHandle.requestPermission({ mode });
            if (requested === 'granted') return handle;
          } catch {
            // Outside user gesture
          }
        }
        throw new AuthExpiredError(
          `Permission required for local folder "${this.label}" — click Reconnect in Settings.`
        );
      }
    }

    return handle;
  }

  async reconnect(): Promise<string> {
    const existing = await this.cache.getFsHandle<FileSystemDirectoryHandle>(this.id);
    if (existing) {
      const perm = existing as unknown as PermissionCapableHandle;
      if (perm.requestPermission) {
        const res = await perm.requestPermission({ mode: 'readwrite' });
        if (res === 'granted') return existing.name;
      }
    }
    return LocalFolderProvider.pickAndStoreFolder(this.id, this.cache);
  }

  async testConnection(): Promise<{ ok: boolean; details: string }> {
    try {
      const root = await this.getRootHandle('readwrite');
      return { ok: true, details: `Connected to local folder "${root.name}"` };
    } catch (err) {
      return {
        ok: false,
        details: err instanceof Error ? err.message : 'Local folder unavailable.',
      };
    }
  }

  private splitPath(path: string): { dirs: string[]; fileName: string } {
    const safe = assertSafeStoragePath(path);
    const segments = safe.split('/').filter(Boolean);
    if (segments.length === 0) {
      throw new Error('Invalid empty file path.');
    }
    const fileName = segments[segments.length - 1];
    return { dirs: segments.slice(0, -1), fileName };
  }

  private canSubdirMatchPrefix(relDirPath: string, filterPrefix: string): boolean {
    if (!filterPrefix) return true;
    const dirWithSlash = `${relDirPath}/`;
    return (
      dirWithSlash.startsWith(filterPrefix) ||
      filterPrefix.startsWith(dirWithSlash) ||
      relDirPath.startsWith(filterPrefix)
    );
  }

  private async walkDir(
    dir: FileSystemDirectoryHandle,
    relPrefix: string,
    filterPrefix: string,
    out: FileEntry[]
  ): Promise<void> {
    const iterable = dir as unknown as {
      entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
    };

    const subdirs: Array<{ handle: FileSystemDirectoryHandle; relPath: string }> = [];
    const matchedFiles: Array<{ handle: FileSystemFileHandle; relPath: string }> = [];

    for await (const [name, entry] of iterable.entries()) {
      if (name.toLowerCase() === '.git') continue;
      const relPath = relPrefix ? `${relPrefix}/${name}` : name;
      if (entry.kind === 'directory') {
        if (this.canSubdirMatchPrefix(relPath, filterPrefix)) {
          subdirs.push({
            handle: entry as FileSystemDirectoryHandle,
            relPath,
          });
        }
      } else if (entry.kind === 'file') {
        if (!filterPrefix || relPath.startsWith(filterPrefix)) {
          matchedFiles.push({
            handle: entry as FileSystemFileHandle,
            relPath,
          });
        }
      }
    }

    // Batch file metadata lookups concurrently
    for (let i = 0; i < matchedFiles.length; i += STAT_CONCURRENCY) {
      const batch = matchedFiles.slice(i, i + STAT_CONCURRENCY);
      const metas = await Promise.all(
        batch.map(async ({ handle, relPath }) => {
          const file = await handle.getFile();
          return {
            path: relPath,
            size: file.size,
            updatedAt: new Date(file.lastModified).toISOString(),
          };
        })
      );
      out.push(...metas);
    }

    for (const sub of subdirs) {
      await this.walkDir(sub.handle, sub.relPath, filterPrefix, out);
    }
  }

  async list(prefix = ''): Promise<FileEntry[]> {
    const root = await this.getRootHandle('read');
    const out: FileEntry[] = [];
    const normPrefix = prefix.replace(/\\/g, '/').replace(/^\/+/, '');
    await this.walkDir(root, '', normPrefix, out);
    return out;
  }

  async read(path: string): Promise<ReadResult | null> {
    const root = await this.getRootHandle('read');
    const { dirs, fileName } = this.splitPath(path);

    let dir = root;
    try {
      for (const seg of dirs) {
        dir = await dir.getDirectoryHandle(seg);
      }
      const fileHandle = await dir.getFileHandle(fileName);
      const file = await fileHandle.getFile();
      const buf = new Uint8Array(await file.arrayBuffer());
      return {
        data: buf,
        etag: `${file.size}-${file.lastModified}`,
      };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError') {
        return null;
      }
      if ((err as { name?: string })?.name === 'NotFoundError') {
        return null;
      }
      throw err;
    }
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const root = await this.getRootHandle('readwrite');
    const { dirs, fileName } = this.splitPath(path);

    let dir = root;
    for (const seg of dirs) {
      dir = await dir.getDirectoryHandle(seg, { create: true });
    }
    const fileHandle = await dir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(asBufferSource(data));
    } finally {
      await writable.close();
    }
  }

  async delete(path: string): Promise<void> {
    const root = await this.getRootHandle('readwrite');
    const { dirs, fileName } = this.splitPath(path);

    let dir = root;
    try {
      for (const seg of dirs) {
        dir = await dir.getDirectoryHandle(seg);
      }
      await dir.removeEntry(fileName);
    } catch (err) {
      if (
        (err instanceof DOMException && err.name === 'NotFoundError') ||
        (err as { name?: string })?.name === 'NotFoundError'
      ) {
        return;
      }
      throw err;
    }
  }
}
