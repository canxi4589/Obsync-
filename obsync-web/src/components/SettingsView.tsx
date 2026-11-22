import { useEffect, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Cloud,
  CopyCheck,
  Download,
  FolderOpen,
  Github,
  HardDrive,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import {
  authorizeGoogleDriveAccount,
  clearGoogleDriveToken,
  getGoogleDriveTokenStatus,
  GoogleDriveProvider,
} from '../storage/providers/googleDriveProvider';
import { LocalFolderProvider } from '../storage/providers/localFolderProvider';
import type { StorageManager } from '../storage/storageManager';
import type {
  GitHubProviderConfig,
  GoogleDriveProviderConfig,
  LocalProviderConfig,
  ProviderRuntimeStatus,
  ProviderType,
  S3ProviderConfig,
  StorageProviderConfig,
} from '../storage/types';
import { exportVaultZip, importVaultZip } from '../storage/vaultZip';

interface SettingsViewProps {
  configs: StorageProviderConfig[];
  statuses: ProviderRuntimeStatus[];
  storage: StorageManager;
  defaultGoogleClientId: string;
  onDefaultGoogleClientIdChange: (clientId: string) => void;
  onConfigsChange: (next: StorageProviderConfig[]) => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
}

function providerIcon(type: ProviderType) {
  switch (type) {
    case 'github':
      return <Github className="h-4 w-4 text-slate-200" />;
    case 'gdrive':
      return <Cloud className="h-4 w-4 text-sky-400" />;
    case 'local':
      return <HardDrive className="h-4 w-4 text-emerald-400" />;
    case 's3':
      return <Server className="h-4 w-4 text-amber-400" />;
  }
}

export function SettingsView({
  configs,
  statuses,
  storage,
  defaultGoogleClientId,
  onDefaultGoogleClientIdChange,
  onConfigsChange,
  onToast,
}: SettingsViewProps) {
  const [showAdd, setShowAdd] = useState(false);
  const [addType, setAddType] = useState<ProviderType>('github');
  const [editingDraft, setEditingDraft] = useState<StorageProviderConfig | null>(null);
  const [, setTick] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [mirrorProgress, setMirrorProgress] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  // Add GitHub form
  const [ghLabel, setGhLabel] = useState('GitHub Primary');
  const [ghOwner, setGhOwner] = useState('');
  const [ghRepo, setGhRepo] = useState('');
  const [ghBranch, setGhBranch] = useState('main');
  const [ghToken, setGhToken] = useState('');

  // Add Google Drive form
  const [gdClientId, setGdClientId] = useState(defaultGoogleClientId);
  const [gdFolder, setGdFolder] = useState('ObsyncVault');
  const [gdLabel, setGdLabel] = useState('');

  // Add Local Folder form
  const [localLabel, setLocalLabel] = useState('Local PC Vault');

  // Add S3 / R2 form
  const [s3Label, setS3Label] = useState('Cloudflare R2');
  const [s3Endpoint, setS3Endpoint] = useState('');
  const [s3Region, setS3Region] = useState('auto');
  const [s3Bucket, setS3Bucket] = useState('');
  const [s3Prefix, setS3Prefix] = useState('');
  const [s3AccessKey, setS3AccessKey] = useState('');
  const [s3SecretKey, setS3SecretKey] = useState('');

  // Mirror modal
  const [mirrorTargetId, setMirrorTargetId] = useState<string | null>(null);
  const [mirrorSourceId, setMirrorSourceId] = useState<string>('');

  // Zip export/import
  const [includePublicInZip, setIncludePublicInZip] = useState(true);
  const zipInputRef = useRef<HTMLInputElement | null>(null);

  const statusMap = new Map(statuses.map((s) => [s.providerId, s]));

  const moveProvider = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= configs.length) return;
    const copy = [...configs];
    const [item] = copy.splice(index, 1);
    copy.splice(target, 0, item);
    onConfigsChange(copy);
  };

  const toggleField = (
    id: string,
    field: 'enabled' | 'mirrorWrites'
  ) => {
    onConfigsChange(
      configs.map((c) => (c.id === id ? { ...c, [field]: !c[field] } : c))
    );
  };

  const removeProvider = async (cfg: StorageProviderConfig) => {
    if (!window.confirm(`Remove storage provider "${cfg.label}"?`)) return;
    if (cfg.type === 'local') {
      await storage.cache.deleteFsHandle(cfg.id);
    }
    if (cfg.type === 'gdrive') {
      clearGoogleDriveToken(cfg.id);
    }
    await storage.cache.clearPendingForProvider(cfg.id);
    onConfigsChange(configs.filter((c) => c.id !== cfg.id));
    onToast(`Removed ${cfg.label}`);
  };

  const syncDriveRootFolderId = (providerId: string, baseConfigs: StorageProviderConfig[]) => {
    const provider = storage.getProvider(providerId);
    if (!(provider instanceof GoogleDriveProvider)) return baseConfigs;
    const rootId = provider.getRootFolderId();
    if (!rootId) return baseConfigs;

    let changed = false;
    const next = baseConfigs.map((c) => {
      if (c.id === providerId && c.type === 'gdrive' && c.rootFolderId !== rootId) {
        changed = true;
        return { ...c, rootFolderId: rootId };
      }
      return c;
    });
    return changed ? next : baseConfigs;
  };

  const handleTest = async (id: string) => {
    setBusyId(id);
    try {
      const res = await storage.testProvider(id);
      if (res.ok) {
        const updated = syncDriveRootFolderId(id, configs);
        if (updated !== configs) onConfigsChange(updated);
      }
      onToast(res.details, res.ok ? 'info' : 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleReconnect = async (cfg: StorageProviderConfig) => {
    setBusyId(cfg.id);
    try {
      if (cfg.type === 'gdrive') {
        const token = await authorizeGoogleDriveAccount(
          cfg.id,
          cfg.clientId,
          cfg.accountEmail
        );
        let nextConfigs = configs;
        if (token.email && token.email !== cfg.accountEmail) {
          nextConfigs = nextConfigs.map((c) =>
            c.id === cfg.id && c.type === 'gdrive'
              ? {
                  ...c,
                  accountEmail: token.email,
                  label: c.label.startsWith('Google Drive')
                    ? `Google Drive (${token.email})`
                    : c.label,
                }
              : c
          );
        }
        await storage.testProvider(cfg.id);
        nextConfigs = syncDriveRootFolderId(cfg.id, nextConfigs);
        if (nextConfigs !== configs) {
          onConfigsChange(nextConfigs);
        }
        onToast(`Connected ${token.email ?? cfg.label}`);
      } else if (cfg.type === 'local') {
        const provider = storage.getProvider(cfg.id);
        if (provider instanceof LocalFolderProvider) {
          const name = await provider.reconnect();
          onConfigsChange(
            configs.map((c) =>
              c.id === cfg.id && c.type === 'local'
                ? { ...c, folderName: name }
                : c
            )
          );
          await storage.testProvider(cfg.id);
          onToast(`Connected local folder "${name}"`);
        }
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Reconnect failed.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingDraft) return;
    const prev = configs.find((c) => c.id === editingDraft.id);
    const trimmedLabel = editingDraft.label.trim() || editingDraft.label;

    let normalized: StorageProviderConfig;
    if (editingDraft.type === 'github') {
      normalized = {
        ...editingDraft,
        label: trimmedLabel,
        owner: editingDraft.owner.trim(),
        repo: editingDraft.repo.trim(),
        branch: editingDraft.branch.trim() || 'main',
        token: editingDraft.token.trim(),
      };
    } else if (editingDraft.type === 'gdrive') {
      const nextClientId = editingDraft.clientId.trim();
      const nextFolderName = editingDraft.folderName.trim() || 'ObsyncVault';
      const prevClientId = prev?.type === 'gdrive' ? prev.clientId : nextClientId;
      const prevFolder = prev?.type === 'gdrive' ? prev.folderName : nextFolderName;
      if (nextClientId !== prevClientId) {
        clearGoogleDriveToken(editingDraft.id);
      }
      onDefaultGoogleClientIdChange(nextClientId);
      normalized = {
        ...editingDraft,
        label: trimmedLabel,
        clientId: nextClientId,
        folderName: nextFolderName,
        rootFolderId:
          prevFolder === nextFolderName ? editingDraft.rootFolderId : undefined,
      };
    } else if (editingDraft.type === 's3') {
      normalized = {
        ...editingDraft,
        label: trimmedLabel,
        endpoint: editingDraft.endpoint.trim().replace(/\/+$/, ''),
        region: editingDraft.region.trim() || 'auto',
        bucket: editingDraft.bucket.trim(),
        prefix: editingDraft.prefix?.trim(),
        accessKeyId: editingDraft.accessKeyId.trim(),
        secretAccessKey: editingDraft.secretAccessKey.trim(),
      };
    } else {
      normalized = {
        ...editingDraft,
        label: trimmedLabel,
      };
    }

    onConfigsChange(
      configs.map((c) => (c.id === normalized.id ? normalized : c))
    );
    setEditingDraft(null);
    onToast(`Updated ${normalized.label}`);
  };

  const handleAddGitHub = (e: React.FormEvent) => {
    e.preventDefault();
    const id = `github:${ghOwner.trim()}/${ghRepo.trim()}:${Date.now()}`;
    const cfg: GitHubProviderConfig = {
      id,
      type: 'github',
      label: ghLabel.trim() || `GitHub (${ghOwner.trim()}/${ghRepo.trim()})`,
      enabled: true,
      mirrorWrites: true,
      owner: ghOwner.trim(),
      repo: ghRepo.trim(),
      branch: ghBranch.trim() || 'main',
      token: ghToken.trim(),
    };
    onConfigsChange([...configs, cfg]);
    setGhToken('');
    setShowAdd(false);
    onToast(`Added ${cfg.label}`);
  };

  const handleAddGoogleDrive = async (e: React.FormEvent) => {
    e.preventDefault();
    const clientId = gdClientId.trim();
    if (!clientId) return;
    onDefaultGoogleClientIdChange(clientId);

    const id = `gdrive:${Date.now()}`;
    setBusyId('add-gdrive');
    try {
      const token = await authorizeGoogleDriveAccount(id, clientId);
      const email = token.email;
      const cfg: GoogleDriveProviderConfig = {
        id,
        type: 'gdrive',
        label:
          gdLabel.trim() ||
          (email ? `Google Drive (${email})` : 'Google Drive'),
        enabled: true,
        mirrorWrites: true,
        clientId,
        accountEmail: email,
        folderName: gdFolder.trim() || 'ObsyncVault',
      };
      onConfigsChange([...configs, cfg]);
      setGdLabel('');
      setShowAdd(false);
      onToast(`Connected & added ${cfg.label}`);
    } catch (err) {
      onToast(
        err instanceof Error ? err.message : 'Google Drive sign-in failed.',
        'error'
      );
    } finally {
      setBusyId(null);
    }
  };

  const handleAddLocal = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = `local:${Date.now()}`;
    setBusyId('add-local');
    try {
      const folderName = await LocalFolderProvider.pickAndStoreFolder(
        id,
        storage.cache
      );
      const cfg: LocalProviderConfig = {
        id,
        type: 'local',
        label: localLabel.trim() || `Local (${folderName})`,
        enabled: true,
        mirrorWrites: true,
        folderName,
      };
      onConfigsChange([...configs, cfg]);
      setShowAdd(false);
      onToast(`Added local folder "${folderName}"`);
    } catch (err) {
      onToast(
        err instanceof Error ? err.message : 'Could not open local folder.',
        'error'
      );
    } finally {
      setBusyId(null);
    }
  };

  const handleAddS3 = (e: React.FormEvent) => {
    e.preventDefault();
    const id = `s3:${s3Bucket.trim()}:${Date.now()}`;
    const cfg: S3ProviderConfig = {
      id,
      type: 's3',
      label: s3Label.trim() || `S3 (${s3Bucket.trim()})`,
      enabled: true,
      mirrorWrites: true,
      endpoint: s3Endpoint.trim().replace(/\/+$/, ''),
      region: s3Region.trim() || 'auto',
      bucket: s3Bucket.trim(),
      prefix: s3Prefix.trim(),
      accessKeyId: s3AccessKey.trim(),
      secretAccessKey: s3SecretKey.trim(),
    };
    onConfigsChange([...configs, cfg]);
    setS3SecretKey('');
    setShowAdd(false);
    onToast(`Added ${cfg.label}`);
  };

  const handleRunMirror = async () => {
    if (!mirrorTargetId || !mirrorSourceId) return;
    setBusyId(mirrorTargetId);
    try {
      const res = await storage.mirrorAllFiles(
        mirrorSourceId,
        mirrorTargetId,
        (done, total, currentPath) => {
          setMirrorProgress(`${done}/${total} ${currentPath}`);
        }
      );
      onToast(
        `Mirrored ${res.copied} file(s)${res.failed ? `, ${res.failed} failed` : ''}.`,
        res.failed ? 'error' : 'info'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Mirror failed.', 'error');
    } finally {
      setMirrorProgress(null);
      setMirrorTargetId(null);
      setBusyId(null);
    }
  };

  const handleExportZip = async () => {
    setBusyId('zip');
    try {
      const bytes = await exportVaultZip(storage, includePublicInZip);
      const blob = new Blob([bytes], { type: 'application/zip' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `obsync-backup-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      onToast('Exported encrypted backup ZIP.');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'ZIP export failed.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleImportZip = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusyId('zip');
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const res = await importVaultZip(storage, buf);
      onToast(`Imported ${res.imported} file(s) from ZIP.`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'ZIP import failed.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const totalPending = statuses.reduce((sum, s) => sum + s.pendingOps, 0);

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-3xl space-y-6 pb-16">
        {/* Providers & Priority Order */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-slate-100">
                Storage Providers & Fallback Order
              </h2>
              <p className="mt-0.5 text-xs text-slate-400">
                Reads try Primary first and automatically fail over down this
                list. Writes go to Primary and mirror to all Fallbacks with
                Mirror enabled.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowAdd(true)}
              className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
            >
              <Plus className="h-4 w-4" />
              <span>Add Provider</span>
            </button>
          </div>

          {configs.length === 0 ? (
            <div className="mt-4 rounded-xl border border-dashed border-slate-700 p-6 text-center text-sm text-slate-400">
              No storage providers configured yet. Add GitHub, Google Drive, a
              Local Folder, or S3/R2.
            </div>
          ) : (
            <div className="mt-4 space-y-3">
              {configs.map((cfg, idx) => {
                const st = statusMap.get(cfg.id);
                const gStatus =
                  cfg.type === 'gdrive'
                    ? getGoogleDriveTokenStatus(cfg.id)
                    : null;
                const roleLabel =
                  idx === 0 ? 'PRIMARY' : `FALLBACK #${idx}`;

                return (
                  <div
                    key={cfg.id}
                    className={`rounded-xl border p-3.5 transition ${
                      cfg.enabled
                        ? 'border-slate-700 bg-slate-950/80'
                        : 'border-slate-800/80 bg-slate-950/30 opacity-65'
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <div className="rounded-lg border border-slate-800 bg-slate-900 p-2">
                          {providerIcon(cfg.type)}
                        </div>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] font-bold tracking-wider ${
                                idx === 0
                                  ? 'bg-indigo-600/30 text-indigo-300'
                                  : 'bg-slate-800 text-slate-400'
                              }`}
                            >
                              {roleLabel}
                            </span>
                            <span className="truncate text-sm font-semibold text-slate-100">
                              {cfg.label}
                            </span>
                          </div>

                          <div className="mt-0.5 text-xs text-slate-400">
                            {cfg.type === 'github' &&
                              `github.com/${cfg.owner}/${cfg.repo} (${cfg.branch})`}
                            {cfg.type === 'gdrive' &&
                              `Google Drive${
                                cfg.accountEmail ? ` · ${cfg.accountEmail}` : ''
                              } · /${cfg.folderName}`}
                            {cfg.type === 'local' &&
                              `Disk folder · ${cfg.folderName} (encrypted vault only for private notes)`}
                            {cfg.type === 's3' &&
                              `${cfg.bucket} (${cfg.region}) · ${cfg.endpoint}`}
                          </div>
                        </div>
                      </div>

                      {/* Priority reorder */}
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => moveProvider(idx, -1)}
                          title="Move higher priority"
                          className="rounded-lg border border-slate-800 p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-30"
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={idx === configs.length - 1}
                          onClick={() => moveProvider(idx, 1)}
                          title="Move lower priority"
                          className="rounded-lg border border-slate-800 p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-30"
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Controls & Status row */}
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-800/80 pt-2.5 text-xs">
                      <div className="flex flex-wrap items-center gap-3">
                        <label className="flex cursor-pointer items-center gap-1.5 text-slate-300">
                          <input
                            type="checkbox"
                            checked={cfg.enabled}
                            onChange={() => toggleField(cfg.id, 'enabled')}
                            className="accent-indigo-600"
                          />
                          <span>Enabled</span>
                        </label>
                        {idx > 0 && (
                          <label className="flex cursor-pointer items-center gap-1.5 text-slate-300">
                            <input
                              type="checkbox"
                              checked={cfg.mirrorWrites}
                              onChange={() => toggleField(cfg.id, 'mirrorWrites')}
                              className="accent-indigo-600"
                            />
                            <span>Mirror writes</span>
                          </label>
                        )}

                        {gStatus && (
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] ${
                              gStatus.connected
                                ? 'bg-emerald-950/70 text-emerald-300'
                                : 'bg-amber-950/70 text-amber-300'
                            }`}
                          >
                            {gStatus.connected
                              ? `Token ~${gStatus.expiresInMinutes}m`
                              : 'Reconnect needed'}
                          </span>
                        )}

                        {st && st.state === 'ok' && (
                          <span className="flex items-center gap-1 text-emerald-400">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            <span>Ready</span>
                          </span>
                        )}
                        {st && st.state === 'error' && (
                          <span
                            className="flex items-center gap-1 text-rose-400"
                            title={st.lastError}
                          >
                            <XCircle className="h-3.5 w-3.5" />
                            <span className="max-w-[180px] truncate">
                              {st.lastError || 'Error'}
                            </span>
                          </span>
                        )}
                        {st && st.pendingOps > 0 && (
                          <span className="rounded bg-indigo-950 px-1.5 py-0.5 text-indigo-300">
                            {st.pendingOps} queued
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-1.5">
                        {(cfg.type === 'gdrive' || cfg.type === 'local') && (
                          <button
                            type="button"
                            disabled={busyId === cfg.id}
                            onClick={() => void handleReconnect(cfg)}
                            className="rounded-lg border border-sky-700/60 bg-sky-950/40 px-2.5 py-1 text-sky-300 hover:bg-sky-900/50"
                          >
                            Reconnect
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setEditingDraft({ ...cfg })}
                          className="flex items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1 text-slate-300 hover:bg-slate-800"
                          title="Edit provider settings"
                        >
                          <Pencil className="h-3 w-3" />
                          <span>Edit</span>
                        </button>
                        <button
                          type="button"
                          disabled={busyId === cfg.id}
                          onClick={() => void handleTest(cfg.id)}
                          className="rounded-lg border border-slate-700 px-2.5 py-1 text-slate-300 hover:bg-slate-800"
                        >
                          {busyId === cfg.id ? '...' : 'Test'}
                        </button>
                        {configs.length > 1 && (
                          <button
                            type="button"
                            onClick={() => {
                              const other = configs.find((x) => x.id !== cfg.id);
                              setMirrorSourceId(other?.id ?? '');
                              setMirrorTargetId(cfg.id);
                            }}
                            title="Copy entire vault into this provider"
                            className="flex items-center gap-1 rounded-lg border border-slate-700 px-2.5 py-1 text-slate-300 hover:bg-slate-800"
                          >
                            <CopyCheck className="h-3 w-3" />
                            <span>Mirror All Here</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void removeProvider(cfg)}
                          className="rounded-lg border border-rose-900/60 p-1 text-rose-400 hover:bg-rose-950/60"
                          title="Remove provider"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Pending Queue & Encrypted ZIP Backup */}
        <section className="rounded-2xl border border-slate-800 bg-slate-900/60 p-4 sm:p-5">
          <h2 className="text-base font-semibold text-slate-100">
            Sync Queue & Portable Encrypted Backup
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Exporting creates a ZIP of your still-encrypted{' '}
            <code>.obsync-vault/</code> files so you can move or restore your
            vault independently of any cloud provider.
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              disabled={busyId === 'flush' || totalPending === 0}
              onClick={async () => {
                setBusyId('flush');
                try {
                  const res = await storage.flushPendingMirrors();
                  onToast(
                    `Synced ${res.flushed} queued op(s); ${res.remaining} remaining.`,
                    res.errors.length ? 'error' : 'info'
                  );
                } finally {
                  setBusyId(null);
                }
              }}
              className="flex items-center gap-1.5 rounded-xl border border-indigo-500/40 bg-indigo-950/60 px-3.5 py-2 text-xs font-medium text-indigo-200 hover:bg-indigo-900/50 disabled:opacity-40"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${busyId === 'flush' ? 'animate-spin' : ''}`}
              />
              <span>Sync Pending Fallbacks ({totalPending})</span>
            </button>

            <button
              type="button"
              disabled={busyId === 'zip' || configs.length === 0}
              onClick={() => void handleExportZip()}
              className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-40"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export Encrypted ZIP</span>
            </button>

            <button
              type="button"
              disabled={busyId === 'zip' || configs.length === 0}
              onClick={() => zipInputRef.current?.click()}
              className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-40"
            >
              <Upload className="h-3.5 w-3.5" />
              <span>Import ZIP</span>
            </button>
            <input
              ref={zipInputRef}
              type="file"
              accept=".zip"
              onChange={(e) => void handleImportZip(e)}
              className="hidden"
            />
          </div>

          <label className="mt-3 flex cursor-pointer items-center gap-2 text-xs text-slate-400">
            <input
              type="checkbox"
              checked={includePublicInZip}
              onChange={(e) => setIncludePublicInZip(e.target.checked)}
              className="accent-indigo-600"
            />
            <span>Include public Markdown notes in ZIP export</span>
          </label>
        </section>
      </div>

      {/* Add Provider Modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-semibold text-slate-100">
                Add Storage Provider
              </h3>
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                className="rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                Cancel
              </button>
            </div>

            {/* Type Selector */}
            <div className="mt-3 grid grid-cols-4 gap-1.5 rounded-xl border border-slate-800 bg-slate-950 p-1 text-xs">
              {(
                [
                  ['github', 'GitHub'],
                  ['gdrive', 'Google Drive'],
                  ['local', 'Local Disk'],
                  ['s3', 'S3 / R2'],
                ] as const
              ).map(([t, label]) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setAddType(t)}
                  className={`rounded-lg py-2 font-medium transition ${
                    addType === t
                      ? 'bg-indigo-600 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {addType === 'github' && (
              <form onSubmit={handleAddGitHub} className="mt-4 space-y-3">
                <p className="text-xs text-slate-400">
                  Use a GitHub Fine-Grained Personal Access Token scoped only to
                  your vault repo with <strong>Contents: Read &amp; Write</strong>.
                </p>
                <input
                  type="text"
                  value={ghLabel}
                  onChange={(e) => setGhLabel(e.target.value)}
                  placeholder="Label (e.g. GitHub Primary)"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    required
                    value={ghOwner}
                    onChange={(e) => setGhOwner(e.target.value)}
                    placeholder="Owner / username"
                    className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                  />
                  <input
                    type="text"
                    required
                    value={ghRepo}
                    onChange={(e) => setGhRepo(e.target.value)}
                    placeholder="Repository name"
                    className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                  />
                </div>
                <input
                  type="text"
                  required
                  value={ghBranch}
                  onChange={(e) => setGhBranch(e.target.value)}
                  placeholder="Branch (e.g. main)"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                />
                <input
                  type="password"
                  required
                  value={ghToken}
                  onChange={(e) => setGhToken(e.target.value)}
                  placeholder="github_pat_..."
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                />
                <button
                  type="submit"
                  className="w-full rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500"
                >
                  Save GitHub Provider
                </button>
              </form>
            )}

            {addType === 'gdrive' && (
              <form onSubmit={handleAddGoogleDrive} className="mt-4 space-y-3">
                <p className="text-xs text-slate-400">
                  Add as many Google accounts as you want — each creates its own
                  backup entry with least-privilege{' '}
                  <code className="text-indigo-300">drive.file</code> access
                  (only sees its own <code>ObsyncVault</code> folder).
                </p>
                <input
                  type="text"
                  required
                  value={gdClientId}
                  onChange={(e) => setGdClientId(e.target.value)}
                  placeholder="Google OAuth Web Client ID (...apps.googleusercontent.com)"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    value={gdLabel}
                    onChange={(e) => setGdLabel(e.target.value)}
                    placeholder="Label (optional)"
                    className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                  />
                  <input
                    type="text"
                    required
                    value={gdFolder}
                    onChange={(e) => setGdFolder(e.target.value)}
                    placeholder="ObsyncVault"
                    className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                  />
                </div>
                <button
                  type="submit"
                  disabled={busyId === 'add-gdrive'}
                  className="w-full rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  {busyId === 'add-gdrive'
                    ? 'Waiting for Google Sign-In...'
                    : 'Sign In & Add Google Account'}
                </button>
              </form>
            )}

            {addType === 'local' && (
              <form onSubmit={handleAddLocal} className="mt-4 space-y-3">
                <p className="text-xs text-slate-400">
                  Pick your local Obsidian vault folder on disk (Chrome/Edge on
                  Windows/Mac). Private notes stay encrypted inside{' '}
                  <code>.obsync-vault/</code> on disk — never plaintext.
                </p>
                {!LocalFolderProvider.isSupported() && (
                  <div className="rounded-xl border border-amber-700/60 bg-amber-950/40 p-3 text-xs text-amber-200">
                    Your current browser (e.g. iOS Safari) does not support the
                    File System Access API. Use GitHub, Google Drive, or S3/R2
                    on iPhone, or use Chrome/Edge on Windows for Local Folder
                    access.
                  </div>
                )}
                <input
                  type="text"
                  value={localLabel}
                  onChange={(e) => setLocalLabel(e.target.value)}
                  placeholder="Label (e.g. Windows Vault Folder)"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                />
                <button
                  type="submit"
                  disabled={
                    !LocalFolderProvider.isSupported() || busyId === 'add-local'
                  }
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-40"
                >
                  <FolderOpen className="h-4 w-4" />
                  <span>Choose Local Folder</span>
                </button>
              </form>
            )}

            {addType === 's3' && (
              <form onSubmit={handleAddS3} className="mt-4 space-y-2.5">
                <p className="text-xs text-slate-400">
                  Compatible with Cloudflare R2, Backblaze B2, AWS S3, or
                  self-hosted MinIO. Ensure bucket CORS allows PUT/GET/DELETE
                  from your PWA origin.
                </p>
                <input
                  type="text"
                  value={s3Label}
                  onChange={(e) => setS3Label(e.target.value)}
                  placeholder="Label (e.g. Cloudflare R2)"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                />
                <input
                  type="url"
                  required
                  value={s3Endpoint}
                  onChange={(e) => setS3Endpoint(e.target.value)}
                  placeholder="https://<account>.r2.cloudflarestorage.com"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                />
                <div className="grid grid-cols-3 gap-2">
                  <input
                    type="text"
                    required
                    value={s3Region}
                    onChange={(e) => setS3Region(e.target.value)}
                    placeholder="auto"
                    className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                  />
                  <input
                    type="text"
                    required
                    value={s3Bucket}
                    onChange={(e) => setS3Bucket(e.target.value)}
                    placeholder="Bucket"
                    className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                  />
                  <input
                    type="text"
                    value={s3Prefix}
                    onChange={(e) => setS3Prefix(e.target.value)}
                    placeholder="Prefix (opt)"
                    className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                  />
                </div>
                <input
                  type="text"
                  required
                  value={s3AccessKey}
                  onChange={(e) => setS3AccessKey(e.target.value)}
                  placeholder="Access Key ID"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                />
                <input
                  type="password"
                  required
                  value={s3SecretKey}
                  onChange={(e) => setS3SecretKey(e.target.value)}
                  placeholder="Secret Access Key"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                />
                <button
                  type="submit"
                  className="w-full rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500"
                >
                  Save S3 / R2 Provider
                </button>
              </form>
            )}
          </div>
        </div>
      )}

      {/* Edit Provider Modal */}
      {editingDraft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <form
            onSubmit={handleSaveEdit}
            className="max-h-[90vh] w-full max-w-lg space-y-3 overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-semibold text-slate-100">
                Edit Provider
              </h3>
              <button
                type="button"
                onClick={() => setEditingDraft(null)}
                className="rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                Cancel
              </button>
            </div>

            <div>
              <label className="block text-xs text-slate-400">Label</label>
              <input
                type="text"
                required
                value={editingDraft.label}
                onChange={(e) =>
                  setEditingDraft({ ...editingDraft, label: e.target.value })
                }
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
              />
            </div>

            {editingDraft.type === 'github' && (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    required
                    value={editingDraft.owner}
                    onChange={(e) =>
                      setEditingDraft({ ...editingDraft, owner: e.target.value })
                    }
                    placeholder="Owner"
                    className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                  />
                  <input
                    type="text"
                    required
                    value={editingDraft.repo}
                    onChange={(e) =>
                      setEditingDraft({ ...editingDraft, repo: e.target.value })
                    }
                    placeholder="Repository"
                    className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                  />
                </div>
                <input
                  type="text"
                  required
                  value={editingDraft.branch}
                  onChange={(e) =>
                    setEditingDraft({ ...editingDraft, branch: e.target.value })
                  }
                  placeholder="Branch"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                />
                <input
                  type="password"
                  required
                  value={editingDraft.token}
                  onChange={(e) =>
                    setEditingDraft({ ...editingDraft, token: e.target.value })
                  }
                  placeholder="Fine-Grained PAT"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                />
              </>
            )}

            {editingDraft.type === 'gdrive' && (
              <>
                <input
                  type="text"
                  required
                  value={editingDraft.clientId}
                  onChange={(e) =>
                    setEditingDraft({ ...editingDraft, clientId: e.target.value })
                  }
                  placeholder="Google OAuth Client ID"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                />
                <input
                  type="text"
                  required
                  value={editingDraft.folderName}
                  onChange={(e) =>
                    setEditingDraft({ ...editingDraft, folderName: e.target.value })
                  }
                  placeholder="Drive Folder Name"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                />
              </>
            )}

            {editingDraft.type === 's3' && (
              <>
                <input
                  type="url"
                  required
                  value={editingDraft.endpoint}
                  onChange={(e) =>
                    setEditingDraft({ ...editingDraft, endpoint: e.target.value })
                  }
                  placeholder="Endpoint URL"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                />
                <div className="grid grid-cols-3 gap-2">
                  <input
                    type="text"
                    required
                    value={editingDraft.region}
                    onChange={(e) =>
                      setEditingDraft({ ...editingDraft, region: e.target.value })
                    }
                    placeholder="Region"
                    className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                  />
                  <input
                    type="text"
                    required
                    value={editingDraft.bucket}
                    onChange={(e) =>
                      setEditingDraft({ ...editingDraft, bucket: e.target.value })
                    }
                    placeholder="Bucket"
                    className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                  />
                  <input
                    type="text"
                    value={editingDraft.prefix ?? ''}
                    onChange={(e) =>
                      setEditingDraft({ ...editingDraft, prefix: e.target.value })
                    }
                    placeholder="Prefix"
                    className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                  />
                </div>
                <input
                  type="text"
                  required
                  value={editingDraft.accessKeyId}
                  onChange={(e) =>
                    setEditingDraft({ ...editingDraft, accessKeyId: e.target.value })
                  }
                  placeholder="Access Key ID"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                />
                <input
                  type="password"
                  required
                  value={editingDraft.secretAccessKey}
                  onChange={(e) =>
                    setEditingDraft({
                      ...editingDraft,
                      secretAccessKey: e.target.value,
                    })
                  }
                  placeholder="Secret Access Key"
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                />
              </>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditingDraft(null)}
                className="rounded-xl border border-slate-700 px-3.5 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-xl bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500"
              >
                Save Changes
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Mirror All Modal */}
      {mirrorTargetId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
          <div className="w-full max-w-md space-y-4 rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-xl">
            <h3 className="text-base font-semibold text-slate-100">
              Mirror Entire Vault
            </h3>
            <p className="text-xs text-slate-400">
              Copy every file (including encrypted <code>.obsync-vault/</code>)
              into{' '}
              <strong className="text-slate-200">
                {configs.find((c) => c.id === mirrorTargetId)?.label}
              </strong>
              .
            </p>
            <div>
              <label className="block text-xs text-slate-400">
                Copy From Source
              </label>
              <select
                value={mirrorSourceId}
                onChange={(e) => setMirrorSourceId(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
              >
                {configs
                  .filter((c) => c.id !== mirrorTargetId)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
              </select>
            </div>
            {mirrorProgress && (
              <p className="truncate font-mono text-xs text-indigo-300">
                Copying: {mirrorProgress}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={!!mirrorProgress}
                onClick={() => setMirrorTargetId(null)}
                className="rounded-xl border border-slate-700 px-3.5 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!!mirrorProgress || !mirrorSourceId}
                onClick={() => void handleRunMirror()}
                className="rounded-xl bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {mirrorProgress ? 'Mirroring...' : 'Start Mirror'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
