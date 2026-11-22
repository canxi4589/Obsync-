import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  CheckCircle2,
  Cloud,
  CopyCheck,
  Download,
  Fingerprint,
  FolderOpen,
  Github,
  HardDrive,
  KeyRound,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Shield,
  ShieldAlert,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import {
  isWebAuthnPrfSupported,
  MIN_CREDENTIAL_PIN_LENGTH,
  type CredentialUnlockMethod,
} from '../crypto/credentialCrypto';
import { WrongSecretError } from '../crypto/vaultCrypto';
import {
  hasAnySecrets,
  hasMissingCredentials,
  isSharedGitHubPagesOrigin,
} from '../storage/configStore';
import {
  authorizeGoogleDriveAccount,
  clearGoogleDriveToken,
  getGoogleDriveTokenStatus,
  GoogleDriveProvider,
} from '../storage/providers/googleDriveProvider';
import { LocalFolderProvider } from '../storage/providers/localFolderProvider';
import { assertValidS3Endpoint } from '../storage/providers/s3Provider';
import type { StorageManager } from '../storage/storageManager';
import type {
  CredentialStorageMode,
  GitHubProviderConfig,
  GoogleDriveProviderConfig,
  LocalProviderConfig,
  ObsyncTheme,
  ProviderRuntimeStatus,
  ProviderType,
  S3ProviderConfig,
  StorageProviderConfig,
} from '../storage/types';
import { OBSYNC_THEMES } from '../theme/themes';
import { Modal } from './Modal';
import { PasswordInput } from './PasswordInput';

interface SettingsViewProps {
  configs: StorageProviderConfig[];
  statuses: ProviderRuntimeStatus[];
  storage: StorageManager;
  defaultGoogleClientId: string;
  currentTheme: ObsyncTheme;
  onSelectTheme: (theme: ObsyncTheme) => void;
  credentialStorage: CredentialStorageMode;
  credentialUnlockMethod: CredentialUnlockMethod | null;
  hasUnlockedCredentials: boolean;
  credentialsLocked: boolean;
  hasLegacyPlaintextSecrets: boolean;
  onCredentialStorageChange: (mode: CredentialStorageMode) => Promise<void>;
  onProtectWithPassphrase: (
    passphrase: string,
    targetConfigs?: StorageProviderConfig[]
  ) => Promise<void>;
  onProtectWithWebAuthn: (
    targetConfigs?: StorageProviderConfig[]
  ) => Promise<void>;
  onUnlockWithPassphrase: (passphrase: string) => Promise<void>;
  onUnlockWithWebAuthn: () => Promise<void>;
  onLockCredentials: () => void;
  onDefaultGoogleClientIdChange: (clientId: string) => void;
  onConfigsChange: (next: StorageProviderConfig[]) => Promise<void>;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
}

function providerBadge(type: ProviderType) {
  switch (type) {
    case 'github':
      return {
        icon: <Github className="h-4 w-4 text-base-content/85" />,
        bg: 'bg-base-200 border-base-content/12',
      };
    case 'gdrive':
      return {
        icon: <Cloud className="h-4 w-4 text-base-content/85" />,
        bg: 'bg-base-200 border-base-content/12',
      };
    case 'local':
      return {
        icon: <HardDrive className="h-4 w-4 text-base-content/85" />,
        bg: 'bg-base-200 border-base-content/12',
      };
    case 's3':
      return {
        icon: <Server className="h-4 w-4 text-base-content/85" />,
        bg: 'bg-base-200 border-base-content/12',
      };
  }
}

function ToggleSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-xs text-base-content/75 transition hover:text-base-content">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={onChange}
        className="toggle toggle-primary toggle-xs"
      />
      <span>{label}</span>
    </label>
  );
}

const inputCls =
  'input h-9 w-full rounded-md border-base-content/15 bg-base-100 text-sm text-base-content placeholder:text-base-content/40 focus:border-primary/70 focus:outline-none';

const fieldLabelCls = 'mb-1 block text-xs font-medium text-base-content/75';

export function SettingsView({
  configs,
  statuses,
  storage,
  defaultGoogleClientId,
  currentTheme,
  onSelectTheme,
  credentialStorage,
  credentialUnlockMethod,
  hasUnlockedCredentials,
  credentialsLocked,
  hasLegacyPlaintextSecrets,
  onCredentialStorageChange,
  onProtectWithPassphrase,
  onProtectWithWebAuthn,
  onUnlockWithPassphrase,
  onUnlockWithWebAuthn,
  onLockCredentials,
  onDefaultGoogleClientIdChange,
  onConfigsChange,
  onToast,
}: SettingsViewProps) {
  const [showAdd, setShowAdd] = useState(false);
  const [addType, setAddType] = useState<ProviderType>('github');
  const [editingDraft, setEditingDraft] = useState<StorageProviderConfig | null>(
    null
  );
  const [editSecretInput, setEditSecretInput] = useState('');
  const [editAccessKeyInput, setEditAccessKeyInput] = useState('');
  const [, setTick] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [mirrorProgress, setMirrorProgress] = useState<string | null>(null);

  // Credential encryption setup / unlock modals
  const [protectModal, setProtectModal] = useState<{
    pendingConfigs?: StorageProviderConfig[];
    title: string;
    subtitle: string;
  } | null>(null);
  const [protectPin, setProtectPin] = useState('');
  const [protectPinConfirm, setProtectPinConfirm] = useState('');
  const [inlineUnlockPin, setInlineUnlockPin] = useState('');

  const hasGoogleDrive = configs.some((c) => c.type === 'gdrive');
  useEffect(() => {
    if (!hasGoogleDrive) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [hasGoogleDrive]);

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
  const onSharedGitHubPages = isSharedGitHubPagesOrigin();
  const webAuthnAvailable = isWebAuthnPrfSupported();
  const anySecretsInConfigs = hasAnySecrets(configs);

  const commitConfigChangeWithProtection = async (
    next: StorageProviderConfig[],
    successMessage: string
  ) => {
    if (
      credentialStorage === 'encrypted' &&
      hasAnySecrets(next) &&
      !hasUnlockedCredentials
    ) {
      setProtectPin('');
      setProtectPinConfirm('');
      setProtectModal({
        pendingConfigs: next,
        title: 'Encrypt Saved API Credentials',
        subtitle:
          'Protect your GitHub PAT / S3 keys at rest with a Passphrase/PIN or Passkey (WebAuthn PRF), or keep everything strictly in memory for this session.',
      });
      return;
    }

    await onConfigsChange(next);
    onToast(successMessage);
  };

  const moveProvider = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= configs.length) return;
    const copy = [...configs];
    const [item] = copy.splice(index, 1);
    copy.splice(target, 0, item);
    void onConfigsChange(copy);
  };

  const toggleField = (id: string, field: 'enabled' | 'mirrorWrites') => {
    void onConfigsChange(
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
    const next = configs.filter((c) => c.id !== cfg.id);
    if (next.length === 0 || configs[0]?.id === cfg.id) {
      await storage.clearOfflineFiles();
    }
    await onConfigsChange(next);
    onToast(`Removed ${cfg.label}`);
  };

  const syncDriveRootFolderId = (
    providerId: string,
    baseConfigs: StorageProviderConfig[]
  ) => {
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
        if (updated !== configs) await onConfigsChange(updated);
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
          await onConfigsChange(nextConfigs);
        }
        onToast(`Connected ${token.email ?? cfg.label}`);
      } else if (cfg.type === 'local') {
        const provider = storage.getProvider(cfg.id);
        if (provider instanceof LocalFolderProvider) {
          const name = await provider.reconnect();
          await onConfigsChange(
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

  const startEdit = (cfg: StorageProviderConfig) => {
    setEditSecretInput('');
    setEditAccessKeyInput('');
    setEditingDraft({ ...cfg });
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingDraft) return;
    const prev = configs.find((c) => c.id === editingDraft.id);
    const trimmedLabel = editingDraft.label.trim() || editingDraft.label;

    let normalized: StorageProviderConfig;
    if (editingDraft.type === 'github') {
      const nextToken =
        editSecretInput.trim() ||
        (prev?.type === 'github' ? prev.token : editingDraft.token);
      if (!nextToken) {
        onToast('Enter a GitHub Fine-Grained PAT.', 'error');
        return;
      }
      normalized = {
        ...editingDraft,
        label: trimmedLabel,
        owner: editingDraft.owner.trim(),
        repo: editingDraft.repo.trim(),
        branch: editingDraft.branch.trim() || 'main',
        token: nextToken,
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
      const endpoint = editingDraft.endpoint.trim().replace(/\/+$/, '');
      try {
        assertValidS3Endpoint(endpoint);
      } catch (err) {
        onToast(
          err instanceof Error ? err.message : 'Invalid S3 endpoint URL.',
          'error'
        );
        return;
      }
      const nextAccessKey =
        editAccessKeyInput.trim() ||
        (prev?.type === 's3' ? prev.accessKeyId : editingDraft.accessKeyId);
      const nextSecret =
        editSecretInput.trim() ||
        (prev?.type === 's3' ? prev.secretAccessKey : editingDraft.secretAccessKey);
      if (!nextAccessKey || !nextSecret) {
        onToast('Enter both S3/R2 Access Key ID and Secret Access Key.', 'error');
        return;
      }
      normalized = {
        ...editingDraft,
        label: trimmedLabel,
        endpoint,
        region: editingDraft.region.trim() || 'auto',
        bucket: editingDraft.bucket.trim(),
        prefix: editingDraft.prefix?.trim(),
        accessKeyId: nextAccessKey,
        secretAccessKey: nextSecret,
      };
    } else {
      normalized = {
        ...editingDraft,
        label: trimmedLabel,
      };
    }

    const nextConfigs = configs.map((c) =>
      c.id === normalized.id ? normalized : c
    );
    setEditingDraft(null);
    setEditSecretInput('');
    setEditAccessKeyInput('');
    await commitConfigChangeWithProtection(
      nextConfigs,
      `Updated ${normalized.label}`
    );
  };

  const handleAddGitHub = async (e: React.FormEvent) => {
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
    setGhToken('');
    setShowAdd(false);
    await commitConfigChangeWithProtection(
      [...configs, cfg],
      `Added ${cfg.label}`
    );
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
      await onConfigsChange([...configs, cfg]);
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
      await onConfigsChange([...configs, cfg]);
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

  const handleAddS3 = async (e: React.FormEvent) => {
    e.preventDefault();
    const endpoint = s3Endpoint.trim().replace(/\/+$/, '');
    try {
      assertValidS3Endpoint(endpoint);
    } catch (err) {
      onToast(
        err instanceof Error ? err.message : 'Invalid S3 endpoint URL.',
        'error'
      );
      return;
    }

    const id = `s3:${s3Bucket.trim()}:${Date.now()}`;
    const cfg: S3ProviderConfig = {
      id,
      type: 's3',
      label: s3Label.trim() || `S3 (${s3Bucket.trim()})`,
      enabled: true,
      mirrorWrites: true,
      endpoint,
      region: s3Region.trim() || 'auto',
      bucket: s3Bucket.trim(),
      prefix: s3Prefix.trim(),
      accessKeyId: s3AccessKey.trim(),
      secretAccessKey: s3SecretKey.trim(),
    };
    setS3AccessKey('');
    setS3SecretKey('');
    setShowAdd(false);
    await commitConfigChangeWithProtection(
      [...configs, cfg],
      `Added ${cfg.label}`
    );
  };

  const handleProtectPassphraseSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (protectPin.length < MIN_CREDENTIAL_PIN_LENGTH) {
      onToast(
        `Choose a passphrase / PIN with at least ${MIN_CREDENTIAL_PIN_LENGTH} characters.`,
        'error'
      );
      return;
    }
    if (protectPin !== protectPinConfirm) {
      onToast('Passphrases do not match.', 'error');
      return;
    }
    setBusyId('protect');
    try {
      await onProtectWithPassphrase(protectPin, protectModal?.pendingConfigs);
      setProtectPin('');
      setProtectPinConfirm('');
      setProtectModal(null);
      onToast('API credentials encrypted at rest (PBKDF2 + AES-256-GCM).');
    } catch (err) {
      onToast(
        err instanceof Error ? err.message : 'Failed to encrypt credentials.',
        'error'
      );
    } finally {
      setBusyId(null);
    }
  };

  const handleProtectWebAuthnClick = async () => {
    setBusyId('protect');
    try {
      await onProtectWithWebAuthn(protectModal?.pendingConfigs);
      setProtectPin('');
      setProtectPinConfirm('');
      setProtectModal(null);
      onToast('API credentials encrypted with WebAuthn Passkey (PRF).');
    } catch (err) {
      onToast(
        err instanceof Error ? err.message : 'WebAuthn Passkey setup failed.',
        'error'
      );
    } finally {
      setBusyId(null);
    }
  };

  const handleSwitchToMemoryOnly = async (
    pendingConfigs?: StorageProviderConfig[]
  ) => {
    setBusyId('cred-mode');
    try {
      await onCredentialStorageChange('memory');
      if (pendingConfigs) {
        await onConfigsChange(pendingConfigs);
      }
      setProtectModal(null);
      onToast(
        'In-Memory Only mode active — browser storage wiped, zero localStorage/IndexedDB writes.'
      );
    } finally {
      setBusyId(null);
    }
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
      const { exportVaultZip } = await import('../storage/vaultZip');
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
      const { importVaultZip } = await import('../storage/vaultZip');
      const buf = new Uint8Array(await file.arrayBuffer());
      const res = await importVaultZip(storage, buf);
      onToast(
        `Imported ${res.imported} file(s) from ZIP${
          res.skipped > 0 ? ` (${res.skipped} non-vault/unsafe skipped)` : ''
        }.`
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'ZIP import failed.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const totalPending = statuses.reduce((sum, s) => sum + s.pendingOps, 0);

  return (
    <div className="custom-scrollbar h-full overflow-y-auto bg-base-100 px-4 py-6 sm:px-8 sm:py-7">
      <div className="mx-auto max-w-3xl space-y-5 pb-20">
        {/* Page Heading */}
        <div className="flex flex-col gap-3 border-b border-base-content/10 pb-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight text-base-content sm:text-xl">
              Storage &amp; Backup
            </h1>
            <p className="mt-0.5 text-xs text-base-content/60">
              Manage multi-provider failover, credential encryption, themes, and
              portable vault backups.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="btn btn-primary btn-sm h-8 min-h-0 shrink-0 gap-1.5 self-start rounded-md px-3 text-xs font-medium sm:self-auto"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Add Provider</span>
          </button>
        </div>

        {hasLegacyPlaintextSecrets && (
          <div role="alert" className="alert alert-soft alert-error items-start rounded-lg p-4 text-xs">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="flex-1">
              <p className="font-semibold">
                Action Required: Legacy Plaintext API Keys Detected in
                localStorage
              </p>
              <p className="mt-1 leading-relaxed opacity-90">
                Encrypt your saved GitHub PAT / S3 keys now (recommended) or
                switch to In-Memory Only mode to wipe browser storage
                immediately.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() =>
                    setProtectModal({
                      pendingConfigs: configs,
                      title: 'Encrypt Existing API Credentials',
                      subtitle:
                        'Encrypts your GitHub PAT / S3 keys with AES-256-GCM and removes plaintext tokens from localStorage.',
                    })
                  }
                  className="btn btn-error btn-xs h-7 min-h-0 rounded-md px-3 font-medium"
                >
                  Encrypt Credentials Now
                </button>
                <button
                  type="button"
                  onClick={() => void handleSwitchToMemoryOnly()}
                  className="btn btn-outline btn-error btn-xs h-7 min-h-0 rounded-md px-3 font-medium"
                >
                  Wipe &amp; Use In-Memory Only
                </button>
              </div>
            </div>
          </div>
        )}

        {onSharedGitHubPages && (
          <div role="alert" className="alert alert-soft alert-warning items-start rounded-lg p-4 text-xs">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-semibold">
                Shared GitHub Pages Origin Detected
              </p>
              <p className="mt-1 leading-relaxed opacity-90">
                All repositories hosted on{' '}
                <code className="rounded bg-base-100/60 px-1 py-0.5">
                  {window.location.hostname}
                </code>{' '}
                share browser storage. Obsync encrypts stored API credentials at
                rest (keeping decrypted tokens in RAM only) and supports
                In-Memory Only mode for untrusted devices; for full origin
                isolation, deploy Obsync on a dedicated custom domain.
              </p>
            </div>
          </div>
        )}

        {/* Device Credential Protection */}
        <section className="rounded-lg border border-base-content/10 bg-base-200/35 p-4 sm:p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold tracking-tight text-base-content">
                Device Credential Protection
              </h2>
              <p className="mt-0.5 text-xs text-base-content/60">
                GitHub PATs and S3/R2 keys are never stored in plaintext.
              </p>
            </div>
            <span
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium ${
                credentialStorage === 'memory'
                  ? 'border-info/30 bg-info/10 text-info'
                  : credentialsLocked
                    ? 'border-warning/30 bg-warning/10 text-warning'
                    : hasUnlockedCredentials
                      ? 'border-success/30 bg-success/10 text-success'
                      : 'border-base-content/12 bg-base-100/80 text-base-content/75'
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  credentialStorage === 'memory'
                    ? 'bg-info'
                    : credentialsLocked
                      ? 'bg-warning'
                      : hasUnlockedCredentials
                        ? 'bg-success'
                        : 'bg-base-content/45'
                }`}
              />
              {credentialStorage === 'memory'
                ? 'In-Memory Only'
                : credentialsLocked
                  ? `Locked · ${credentialUnlockMethod === 'webauthn-prf' ? 'Passkey' : 'Passphrase'}`
                  : hasUnlockedCredentials
                    ? `Unlocked · ${credentialUnlockMethod === 'webauthn-prf' ? 'Passkey PRF' : 'Passphrase'}`
                    : 'Encrypted at Rest'}
            </span>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            <button
              type="button"
              disabled={busyId === 'cred-mode'}
              onClick={async () => {
                if (credentialStorage === 'encrypted') return;
                await onCredentialStorageChange('encrypted');
                if (anySecretsInConfigs) {
                  setProtectModal({
                    pendingConfigs: configs,
                    title: 'Set Credential Protection',
                    subtitle:
                      'Encrypt your active in-memory API keys so they persist safely on this device.',
                  });
                } else {
                  onToast('Switched to Encrypted-at-Rest storage mode.');
                }
              }}
              className={`flex items-start justify-between gap-3 rounded-md border p-3.5 text-left text-xs transition ${
                credentialStorage === 'encrypted'
                  ? 'border-primary/55 bg-base-100 text-base-content'
                  : 'border-base-content/10 bg-base-100/45 text-base-content/70 hover:border-base-content/20 hover:bg-base-100/75'
              }`}
            >
              <div className="flex items-start gap-2.5">
                <KeyRound
                  className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                    credentialStorage === 'encrypted'
                      ? 'text-primary'
                      : 'text-base-content/45'
                  }`}
                />
                <div>
                  <div className="font-medium text-base-content">
                    Encrypted at Rest
                    <span className="ml-1.5 text-[10.5px] font-normal text-base-content/60">
                      Recommended
                    </span>
                  </div>
                  <div className="mt-1 leading-relaxed text-base-content/60">
                    AES-256-GCM envelope behind Passphrase/PIN or WebAuthn
                    Passkey. Decrypted keys stay strictly in RAM.
                  </div>
                </div>
              </div>
              <span
                className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
                  credentialStorage === 'encrypted'
                    ? 'border-primary'
                    : 'border-base-content/25'
                }`}
              >
                {credentialStorage === 'encrypted' && (
                  <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                )}
              </span>
            </button>

            <button
              type="button"
              disabled={busyId === 'cred-mode'}
              onClick={() => {
                if (credentialStorage === 'memory') return;
                if (
                  !window.confirm(
                    'Switch to In-Memory Only (Untrusted Device) mode? This wipes all stored providers, encrypted keys, and offline cache from this browser immediately.'
                  )
                ) {
                  return;
                }
                void handleSwitchToMemoryOnly();
              }}
              className={`flex items-start justify-between gap-3 rounded-md border p-3.5 text-left text-xs transition ${
                credentialStorage === 'memory'
                  ? 'border-info/55 bg-base-100 text-base-content'
                  : 'border-base-content/10 bg-base-100/45 text-base-content/70 hover:border-base-content/20 hover:bg-base-100/75'
              }`}
            >
              <div className="flex items-start gap-2.5">
                <Shield
                  className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                    credentialStorage === 'memory'
                      ? 'text-info'
                      : 'text-base-content/45'
                  }`}
                />
                <div>
                  <div className="font-medium text-base-content">
                    Session-Only / Untrusted Device
                  </div>
                  <div className="mt-1 leading-relaxed text-base-content/60">
                    In-memory only — writes zero data to localStorage,
                    sessionStorage, or IndexedDB.
                  </div>
                </div>
              </div>
              <span
                className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border ${
                  credentialStorage === 'memory'
                    ? 'border-info'
                    : 'border-base-content/25'
                }`}
              >
                {credentialStorage === 'memory' && (
                  <span className="h-1.5 w-1.5 rounded-full bg-info" />
                )}
              </span>
            </button>
          </div>

          {credentialStorage === 'encrypted' && credentialsLocked && (
            <div className="mt-3 rounded-md border border-warning/30 bg-warning/10 p-3.5">
              {credentialUnlockMethod === 'webauthn-prf' ? (
                <button
                  type="button"
                  disabled={busyId === 'unlock-cred'}
                  onClick={async () => {
                    setBusyId('unlock-cred');
                    try {
                      await onUnlockWithWebAuthn();
                    } catch (err) {
                      onToast(
                        err instanceof Error ? err.message : 'Unlock failed.',
                        'error'
                      );
                    } finally {
                      setBusyId(null);
                    }
                  }}
                  className="btn btn-primary btn-sm h-8 min-h-0 gap-2 rounded-md px-3 text-xs font-medium"
                >
                  <Fingerprint className="h-3.5 w-3.5" />
                  <span>Unlock Stored Keys with Passkey</span>
                </button>
              ) : (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    setBusyId('unlock-cred');
                    try {
                      await onUnlockWithPassphrase(inlineUnlockPin);
                      setInlineUnlockPin('');
                    } catch (err) {
                      onToast(
                        err instanceof WrongSecretError
                          ? 'Incorrect credential passphrase / PIN.'
                          : err instanceof Error
                            ? err.message
                            : 'Unlock failed.',
                        'error'
                      );
                    } finally {
                      setBusyId(null);
                    }
                  }}
                  className="flex flex-wrap items-center gap-2"
                >
                  <PasswordInput
                    required
                    value={inlineUnlockPin}
                    onChange={(e) => setInlineUnlockPin(e.target.value)}
                    placeholder="Enter credential passphrase / PIN"
                    wrapperClassName="min-w-[200px] flex-1"
                    className="h-8 text-xs"
                  />
                  <button
                    type="submit"
                    disabled={busyId === 'unlock-cred'}
                    className="btn btn-primary btn-sm h-8 min-h-0 rounded-md px-3 text-xs font-medium"
                  >
                    Unlock Keys
                  </button>
                </form>
              )}
            </div>
          )}

          {credentialStorage === 'encrypted' && hasUnlockedCredentials && (
            <div className="mt-3.5 flex flex-wrap items-center gap-2 border-t border-base-content/8 pt-3.5">
              <button
                type="button"
                onClick={() => {
                  setProtectPin('');
                  setProtectPinConfirm('');
                  setProtectModal({
                    title: 'Change Credential Protection',
                    subtitle:
                      'Re-encrypt your stored GitHub PAT / S3 keys with a new Passphrase/PIN or WebAuthn Passkey.',
                  });
                }}
                className="btn btn-ghost btn-xs h-7 min-h-0 gap-1.5 rounded-md border border-base-content/14 px-2.5 text-xs font-medium"
              >
                <KeyRound className="h-3.5 w-3.5" />
                <span>Change Passphrase / Switch to Passkey</span>
              </button>
              <button
                type="button"
                onClick={onLockCredentials}
                className="btn btn-ghost btn-xs h-7 min-h-0 gap-1.5 rounded-md border border-base-content/14 px-2.5 text-xs font-medium"
              >
                <Lock className="h-3.5 w-3.5" />
                <span>Lock Keys Now</span>
              </button>
            </div>
          )}
        </section>

        {/* Providers & Priority Order */}
        <section className="rounded-lg border border-base-content/10 bg-base-200/35 p-4 sm:p-5">
          <div>
            <h2 className="text-sm font-semibold tracking-tight text-base-content">
              Storage Providers &amp; Fallback Order
            </h2>
            <p className="mt-0.5 text-xs text-base-content/60">
              Reads try Primary first and automatically fail over down the list.
              Writes mirror concurrently to all Fallbacks with Mirror enabled.
            </p>
          </div>

          {configs.length === 0 ? (
            <div className="mt-4 flex flex-col items-center rounded-md border border-dashed border-base-content/14 bg-base-100/45 px-5 py-7 text-center">
              <Cloud className="mb-2.5 h-6 w-6 text-base-content/35" />
              <p className="text-xs font-medium text-base-content/85">
                No storage providers connected
              </p>
              <p className="mt-1 max-w-sm text-xs text-base-content/55">
                Add GitHub, Google Drive, a Local Disk Folder, or S3 /
                Cloudflare R2 to sync your notes.
              </p>
              <button
                type="button"
                onClick={() => setShowAdd(true)}
                className="btn btn-ghost btn-sm mt-3.5 h-8 min-h-0 gap-1.5 rounded-md border border-base-content/15 bg-base-200/60 px-3 text-xs font-medium hover:bg-base-200"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Connect Provider</span>
              </button>
            </div>
          ) : (
            <div className="mt-4 space-y-2.5">
              {configs.map((cfg, idx) => {
                const st = statusMap.get(cfg.id);
                const gStatus =
                  cfg.type === 'gdrive'
                    ? getGoogleDriveTokenStatus(cfg.id)
                    : null;
                const missingCreds = hasMissingCredentials(cfg);
                const roleLabel = idx === 0 ? 'PRIMARY' : `FALLBACK #${idx}`;
                const badge = providerBadge(cfg.type);

                return (
                  <div
                    key={cfg.id}
                    className={`rounded-md border p-3.5 transition ${
                      cfg.enabled
                        ? 'border-base-content/12 bg-base-100/80'
                        : 'border-base-content/8 bg-base-100/40 opacity-60'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        <div
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md border ${badge.bg}`}
                        >
                          {badge.icon}
                        </div>
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-wide ${
                                idx === 0
                                  ? 'border-primary/35 bg-primary/10 text-primary'
                                  : 'border-base-content/12 bg-base-200 text-base-content/60'
                              }`}
                            >
                              {roleLabel}
                            </span>
                            <span className="truncate text-sm font-medium text-base-content">
                              {cfg.label}
                            </span>
                          </div>

                          <div className="mt-0.5 truncate font-mono text-[11px] text-base-content/55">
                            {cfg.type === 'github' &&
                              `github.com/${cfg.owner}/${cfg.repo} · ${cfg.branch}`}
                            {cfg.type === 'gdrive' &&
                              `Google Drive${
                                cfg.accountEmail ? ` · ${cfg.accountEmail}` : ''
                              } · /${cfg.folderName}`}
                            {cfg.type === 'local' &&
                              `Disk folder · ${cfg.folderName}`}
                            {cfg.type === 's3' &&
                              `${cfg.bucket} (${cfg.region}) · ${cfg.endpoint}`}
                          </div>
                        </div>
                      </div>

                      {/* Priority reorder */}
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => moveProvider(idx, -1)}
                          title="Move higher priority"
                          aria-label="Move higher priority"
                          className="btn btn-ghost btn-xs btn-square h-7 min-h-0 w-7 rounded-md border border-base-content/10"
                        >
                          <ArrowUp className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          disabled={idx === configs.length - 1}
                          onClick={() => moveProvider(idx, 1)}
                          title="Move lower priority"
                          aria-label="Move lower priority"
                          className="btn btn-ghost btn-xs btn-square h-7 min-h-0 w-7 rounded-md border border-base-content/10"
                        >
                          <ArrowDown className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Controls & Status row */}
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-base-content/8 pt-2.5 text-xs">
                      <div className="flex flex-wrap items-center gap-3.5">
                        <ToggleSwitch
                          checked={cfg.enabled}
                          onChange={() => toggleField(cfg.id, 'enabled')}
                          label="Enabled"
                        />
                        {idx > 0 && (
                          <ToggleSwitch
                            checked={cfg.mirrorWrites}
                            onChange={() => toggleField(cfg.id, 'mirrorWrites')}
                            label="Mirror writes"
                          />
                        )}

                        {missingCreds && (
                          <span className="inline-flex items-center gap-1 rounded border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[11px] font-medium text-warning">
                            <AlertTriangle className="h-3 w-3" />
                            <span>
                              {credentialsLocked
                                ? 'Keys locked'
                                : 'Enter credentials'}
                            </span>
                          </span>
                        )}

                        {gStatus && (
                          <span
                            className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10.5px] tabular-nums ${
                              gStatus.connected
                                ? 'border-success/30 bg-success/10 text-success'
                                : 'border-warning/30 bg-warning/10 text-warning'
                            }`}
                          >
                            {gStatus.connected
                              ? `Token ~${gStatus.expiresInMinutes}m`
                              : 'Reconnect needed'}
                          </span>
                        )}

                        {st && st.state === 'ok' && !missingCreds && (
                          <span className="flex items-center gap-1 text-success">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            <span>Ready</span>
                          </span>
                        )}
                        {st && st.state === 'error' && (
                          <span
                            className="flex items-center gap-1 text-error"
                            title={st.lastError}
                          >
                            <XCircle className="h-3.5 w-3.5" />
                            <span className="max-w-[180px] truncate">
                              {st.lastError || 'Error'}
                            </span>
                          </span>
                        )}
                        {st && st.pendingOps > 0 && (
                          <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 font-mono text-[10.5px] tabular-nums text-primary">
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
                            className="btn btn-soft btn-info btn-xs h-7 min-h-0 rounded-md px-2.5 text-xs font-medium"
                          >
                            Reconnect
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => startEdit(cfg)}
                          className="btn btn-ghost btn-xs h-7 min-h-0 gap-1 rounded-md border border-base-content/12 px-2.5 text-xs font-medium"
                          title="Edit provider settings"
                        >
                          <Pencil className="h-3 w-3" />
                          <span>Edit</span>
                        </button>
                        <button
                          type="button"
                          disabled={busyId === cfg.id || missingCreds}
                          onClick={() => void handleTest(cfg.id)}
                          className="btn btn-ghost btn-xs h-7 min-h-0 rounded-md border border-base-content/12 px-2.5 text-xs font-medium"
                        >
                          {busyId === cfg.id ? '...' : 'Test'}
                        </button>
                        {configs.length > 1 && (
                          <button
                            type="button"
                            disabled={credentialsLocked}
                            onClick={() => {
                              const other = configs.find((x) => x.id !== cfg.id);
                              setMirrorSourceId(other?.id ?? '');
                              setMirrorTargetId(cfg.id);
                            }}
                            title="Copy entire vault into this provider"
                            className="btn btn-ghost btn-xs h-7 min-h-0 gap-1 rounded-md border border-base-content/12 px-2.5 text-xs font-medium"
                          >
                            <CopyCheck className="h-3 w-3" />
                            <span>Mirror All</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void removeProvider(cfg)}
                          className="btn btn-ghost btn-xs btn-square h-7 min-h-0 w-7 rounded-md text-base-content/50 hover:bg-error/10 hover:text-error"
                          title="Remove provider"
                          aria-label="Remove provider"
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
        <section className="rounded-lg border border-base-content/10 bg-base-200/35 p-4 sm:p-5">
          <h2 className="text-sm font-semibold tracking-tight text-base-content">
            Sync Queue &amp; Portable Encrypted Backup
          </h2>
          <p className="mt-0.5 text-xs leading-relaxed text-base-content/60">
            Export a ZIP of your still-encrypted{' '}
            <code className="rounded border border-base-content/10 bg-base-100 px-1.5 py-0.5 font-mono text-[11px] text-base-content/85">
              .obsync-vault/
            </code>{' '}
            files to back up or migrate independently of any cloud provider.
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busyId === 'flush' || totalPending === 0 || credentialsLocked}
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
              className="btn btn-ghost btn-sm h-8 min-h-0 gap-1.5 rounded-md border border-base-content/14 bg-base-100/70 px-3 text-xs font-medium tabular-nums"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${busyId === 'flush' ? 'animate-spin' : ''}`}
              />
              <span>Sync Pending ({totalPending})</span>
            </button>

            <button
              type="button"
              disabled={busyId === 'zip' || configs.length === 0 || credentialsLocked}
              onClick={() => void handleExportZip()}
              className="btn btn-ghost btn-sm h-8 min-h-0 gap-1.5 rounded-md border border-base-content/14 bg-base-100/70 px-3 text-xs font-medium"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Export Encrypted ZIP</span>
            </button>

            <button
              type="button"
              disabled={busyId === 'zip' || configs.length === 0 || credentialsLocked}
              onClick={() => zipInputRef.current?.click()}
              className="btn btn-ghost btn-sm h-8 min-h-0 gap-1.5 rounded-md border border-base-content/14 bg-base-100/70 px-3 text-xs font-medium"
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

          <div className="mt-3.5 border-t border-base-content/8 pt-3">
            <ToggleSwitch
              checked={includePublicInZip}
              onChange={() => setIncludePublicInZip((v) => !v)}
              label="Include public Markdown notes in ZIP export"
            />
          </div>
        </section>

        {/* Appearance & Theme Selector */}
        <section className="rounded-lg border border-base-content/10 bg-base-200/35 p-4 sm:p-5">
          <div>
            <h2 className="text-sm font-semibold tracking-tight text-base-content">
              Appearance &amp; Theme
            </h2>
            <p className="mt-0.5 text-xs text-base-content/60">
              Choose an interface palette — also switchable anytime via{' '}
              <kbd className="rounded border border-base-content/15 bg-base-100 px-1 py-0.5 font-mono text-[10px]">
                Ctrl K
              </kbd>
              .
            </p>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {OBSYNC_THEMES.map((t) => {
              const active = t.id === currentTheme;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onSelectTheme(t.id)}
                  className={`group flex flex-col justify-between rounded-md border p-2.5 text-left transition ${
                    active
                      ? 'border-primary/65 bg-base-100'
                      : 'border-base-content/10 bg-base-100/45 hover:border-base-content/22 hover:bg-base-100/80'
                  }`}
                >
                  {/* Miniature workspace palette preview */}
                  <div
                    data-theme={t.id}
                    className="mb-2.5 flex h-11 overflow-hidden rounded border border-base-content/12 bg-base-100"
                  >
                    <div className="flex w-7 flex-col gap-1 border-r border-base-content/10 bg-base-200 p-1.5">
                      <span className="h-1 w-full rounded-full bg-base-content/30" />
                      <span className="h-1 w-3/4 rounded-full bg-base-content/15" />
                      <span className="mt-auto h-1.5 w-1.5 rounded-full bg-primary" />
                    </div>
                    <div className="flex flex-1 flex-col justify-between p-1.5">
                      <div className="space-y-1">
                        <span className="block h-1.5 w-2/3 rounded-full bg-base-content/75" />
                        <span className="block h-1 w-5/6 rounded-full bg-base-content/25" />
                      </div>
                      <div className="flex items-center justify-end">
                        <span className="h-2 w-5 rounded-[2px] bg-primary" />
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-xs font-medium text-base-content">
                      {t.label}
                    </span>
                    {active && <Check className="h-3.5 w-3.5 text-primary" />}
                  </div>
                  <div className="mt-0.5 text-[11px] leading-snug text-base-content/55">
                    {t.description}
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      </div>

      {/* Protect / Encrypt Credentials Modal */}
      <Modal
        open={!!protectModal}
        onClose={() => setProtectModal(null)}
        title={protectModal?.title ?? 'Encrypt Credentials'}
        subtitle={protectModal?.subtitle}
        maxWidthClass="max-w-md"
      >
        <div className="space-y-4">
          {webAuthnAvailable && (
            <div className="rounded-md border border-base-content/12 bg-base-100/70 p-3.5">
              <button
                type="button"
                disabled={busyId === 'protect'}
                onClick={() => void handleProtectWebAuthnClick()}
                className="btn btn-primary btn-sm h-8 min-h-0 w-full gap-2 rounded-md text-xs font-medium"
              >
                <Fingerprint className="h-3.5 w-3.5" />
                <span>
                  {busyId === 'protect'
                    ? 'Waiting for Passkey...'
                    : 'Use Passkey / Biometrics (WebAuthn PRF)'}
                </span>
              </button>
              <p className="mt-2 text-center text-[11px] text-base-content/55">
                Hardware-backed key derivation via Windows Hello / Touch ID /
                Face ID (requires PRF support).
              </p>
            </div>
          )}

          <form
            onSubmit={(e) => void handleProtectPassphraseSubmit(e)}
            className="space-y-2.5 border-t border-base-content/10 pt-3.5"
          >
            <label className="block text-xs font-semibold text-base-content/85">
              Or Encrypt with Passphrase / Device PIN
            </label>
            <p className="text-[11px] text-base-content/55">
              Tip: reuse your Vault Master Password or choose a device PIN (min{' '}
              {MIN_CREDENTIAL_PIN_LENGTH} chars).
            </p>
            <PasswordInput
              required
              minLength={MIN_CREDENTIAL_PIN_LENGTH}
              value={protectPin}
              onChange={(e) => setProtectPin(e.target.value)}
              placeholder={`Passphrase or PIN (min ${MIN_CREDENTIAL_PIN_LENGTH} chars)`}
            />
            <PasswordInput
              required
              minLength={MIN_CREDENTIAL_PIN_LENGTH}
              value={protectPinConfirm}
              onChange={(e) => setProtectPinConfirm(e.target.value)}
              placeholder="Confirm passphrase / PIN"
            />
            <button
              type="submit"
              disabled={busyId === 'protect'}
              className="btn btn-primary btn-sm h-8 min-h-0 w-full rounded-md text-xs font-medium"
            >
              {busyId === 'protect'
                ? 'Deriving Key & Encrypting...'
                : 'Encrypt & Save Credentials'}
            </button>
          </form>

          {protectModal?.pendingConfigs && (
            <div className="border-t border-base-content/10 pt-3">
              <button
                type="button"
                disabled={busyId === 'cred-mode' || busyId === 'protect'}
                onClick={() =>
                  void handleSwitchToMemoryOnly(protectModal.pendingConfigs)
                }
                className="btn btn-ghost btn-sm h-8 min-h-0 w-full rounded-md border border-base-content/14 text-xs font-medium"
              >
                Untrusted Device? Keep in Memory Only (Zero localStorage)
              </button>
            </div>
          )}
        </div>
      </Modal>

      {/* Add Provider Modal */}
      <Modal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        title="Add Storage Provider"
      >
        <div
          role="tablist"
          className="grid grid-cols-2 gap-1 rounded-md border border-base-content/10 bg-base-100 p-1 text-xs sm:grid-cols-4"
        >
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
              role="tab"
              aria-selected={addType === t}
              onClick={() => setAddType(t)}
              className={`h-7 rounded-[5px] text-xs font-medium transition ${
                addType === t
                  ? 'bg-base-300 text-base-content'
                  : 'text-base-content/55 hover:text-base-content'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {addType === 'github' && (
          <form
            onSubmit={(e) => void handleAddGitHub(e)}
            className="mt-4 space-y-3"
          >
            <p className="text-xs leading-relaxed text-base-content/60">
              Use a GitHub Fine-Grained Personal Access Token scoped only to
              your vault repo with <strong className="font-medium text-base-content/85">Contents: Read &amp; Write</strong>.
            </p>
            <div>
              <label className={fieldLabelCls}>Display Label</label>
              <input
                type="text"
                value={ghLabel}
                onChange={(e) => setGhLabel(e.target.value)}
                placeholder="GitHub Primary"
                className={inputCls}
              />
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className={fieldLabelCls}>Owner / Username</label>
                <input
                  type="text"
                  required
                  value={ghOwner}
                  onChange={(e) => setGhOwner(e.target.value)}
                  placeholder="octocat"
                  className={inputCls}
                />
              </div>
              <div>
                <label className={fieldLabelCls}>Repository</label>
                <input
                  type="text"
                  required
                  value={ghRepo}
                  onChange={(e) => setGhRepo(e.target.value)}
                  placeholder="obsidian-vault"
                  className={inputCls}
                />
              </div>
            </div>
            <div>
              <label className={fieldLabelCls}>Branch</label>
              <input
                type="text"
                required
                value={ghBranch}
                onChange={(e) => setGhBranch(e.target.value)}
                placeholder="main"
                className={inputCls}
              />
            </div>
            <div>
              <label className={fieldLabelCls}>Fine-Grained PAT</label>
              <PasswordInput
                required
                value={ghToken}
                onChange={(e) => setGhToken(e.target.value)}
                placeholder="github_pat_..."
              />
            </div>
            <button
              type="submit"
              className="btn btn-primary btn-sm mt-1 h-9 w-full rounded-md font-medium"
            >
              Save GitHub Provider
            </button>
          </form>
        )}

        {addType === 'gdrive' && (
          <form
            onSubmit={(e) => void handleAddGoogleDrive(e)}
            className="mt-4 space-y-3"
          >
            <p className="text-xs leading-relaxed text-base-content/60">
              Add as many Google accounts as you want — each uses least-privilege{' '}
              <code className="rounded bg-base-100 px-1 py-0.5 font-mono text-[11px] text-base-content/85">drive.file</code> access (only
              sees its own <code className="font-mono text-[11px]">ObsyncVault</code> folder).
            </p>
            <div>
              <label className={fieldLabelCls}>Google OAuth Web Client ID</label>
              <input
                type="text"
                required
                value={gdClientId}
                onChange={(e) => setGdClientId(e.target.value)}
                placeholder="...apps.googleusercontent.com"
                className={inputCls}
              />
            </div>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className={fieldLabelCls}>Label (optional)</label>
                <input
                  type="text"
                  value={gdLabel}
                  onChange={(e) => setGdLabel(e.target.value)}
                  placeholder="Personal Drive"
                  className={inputCls}
                />
              </div>
              <div>
                <label className={fieldLabelCls}>Drive Folder</label>
                <input
                  type="text"
                  required
                  value={gdFolder}
                  onChange={(e) => setGdFolder(e.target.value)}
                  placeholder="ObsyncVault"
                  className={inputCls}
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={busyId === 'add-gdrive'}
              className="btn btn-primary btn-sm mt-1 h-9 w-full rounded-md font-medium"
            >
              {busyId === 'add-gdrive'
                ? 'Waiting for Google Sign-In...'
                : 'Sign In & Add Google Account'}
            </button>
          </form>
        )}

        {addType === 'local' && (
          <form
            onSubmit={(e) => void handleAddLocal(e)}
            className="mt-4 space-y-3"
          >
            <p className="text-xs leading-relaxed text-base-content/60">
              Pick your local Obsidian vault folder on disk (Chrome/Edge on
              Windows/Mac). Private notes stay encrypted inside{' '}
              <code className="font-mono text-[11px]">.obsync-vault/</code> on disk — never plaintext.
            </p>
            {!LocalFolderProvider.isSupported() && (
              <div role="alert" className="alert alert-soft alert-warning rounded-md py-2 text-xs">
                Your current browser (e.g. iOS Safari) does not support the File
                System Access API. Use GitHub, Google Drive, or S3/R2 on iPhone.
              </div>
            )}
            <div>
              <label className={fieldLabelCls}>Display Label</label>
              <input
                type="text"
                value={localLabel}
                onChange={(e) => setLocalLabel(e.target.value)}
                placeholder="Windows Vault Folder"
                className={inputCls}
              />
            </div>
            <button
              type="submit"
              disabled={
                !LocalFolderProvider.isSupported() || busyId === 'add-local'
              }
              className="btn btn-primary btn-sm mt-1 h-9 w-full gap-2 rounded-md font-medium"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              <span>Choose Local Folder</span>
            </button>
          </form>
        )}

        {addType === 's3' && (
          <form
            onSubmit={(e) => void handleAddS3(e)}
            className="mt-4 space-y-3"
          >
            <p className="text-xs leading-relaxed text-base-content/60">
              Compatible with Cloudflare R2, Backblaze B2, AWS S3, or
              self-hosted MinIO (HTTPS required except localhost). Ensure bucket
              CORS allows PUT/GET/DELETE from your PWA origin.
            </p>
            <div>
              <label className={fieldLabelCls}>Display Label</label>
              <input
                type="text"
                value={s3Label}
                onChange={(e) => setS3Label(e.target.value)}
                placeholder="Cloudflare R2"
                className={inputCls}
              />
            </div>
            <div>
              <label className={fieldLabelCls}>Endpoint URL</label>
              <input
                type="url"
                required
                value={s3Endpoint}
                onChange={(e) => setS3Endpoint(e.target.value)}
                placeholder="https://<account>.r2.cloudflarestorage.com"
                className={inputCls}
              />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className={fieldLabelCls}>Region</label>
                <input
                  type="text"
                  required
                  value={s3Region}
                  onChange={(e) => setS3Region(e.target.value)}
                  placeholder="auto"
                  className={inputCls}
                />
              </div>
              <div>
                <label className={fieldLabelCls}>Bucket</label>
                <input
                  type="text"
                  required
                  value={s3Bucket}
                  onChange={(e) => setS3Bucket(e.target.value)}
                  placeholder="obsync"
                  className={inputCls}
                />
              </div>
              <div>
                <label className={fieldLabelCls}>Prefix (opt)</label>
                <input
                  type="text"
                  value={s3Prefix}
                  onChange={(e) => setS3Prefix(e.target.value)}
                  placeholder="vault/"
                  className={inputCls}
                />
              </div>
            </div>
            <div>
              <label className={fieldLabelCls}>Access Key ID</label>
              <input
                type="text"
                required
                value={s3AccessKey}
                onChange={(e) => setS3AccessKey(e.target.value)}
                placeholder="Access Key ID"
                className={inputCls}
              />
            </div>
            <div>
              <label className={fieldLabelCls}>Secret Access Key</label>
              <PasswordInput
                required
                value={s3SecretKey}
                onChange={(e) => setS3SecretKey(e.target.value)}
                placeholder="Secret Access Key"
              />
            </div>
            <button
              type="submit"
              className="btn btn-primary btn-sm mt-1 h-9 w-full rounded-md font-medium"
            >
              Save S3 / R2 Provider
            </button>
          </form>
        )}
      </Modal>

      {/* Edit Provider Modal */}
      <Modal
        open={!!editingDraft}
        onClose={() => {
          setEditingDraft(null);
          setEditSecretInput('');
          setEditAccessKeyInput('');
        }}
        title="Edit Provider"
      >
        {editingDraft && (
          <form
            onSubmit={(e) => void handleSaveEdit(e)}
            className="space-y-3"
          >
            <div>
              <label className={fieldLabelCls}>Label</label>
              <input
                type="text"
                required
                value={editingDraft.label}
                onChange={(e) =>
                  setEditingDraft({ ...editingDraft, label: e.target.value })
                }
                className={inputCls}
              />
            </div>

            {editingDraft.type === 'github' && (
              <>
                <div className="grid grid-cols-2 gap-2.5">
                  <div>
                    <label className={fieldLabelCls}>Owner</label>
                    <input
                      type="text"
                      required
                      value={editingDraft.owner}
                      onChange={(e) =>
                        setEditingDraft({ ...editingDraft, owner: e.target.value })
                      }
                      placeholder="Owner"
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className={fieldLabelCls}>Repository</label>
                    <input
                      type="text"
                      required
                      value={editingDraft.repo}
                      onChange={(e) =>
                        setEditingDraft({ ...editingDraft, repo: e.target.value })
                      }
                      placeholder="Repository"
                      className={inputCls}
                    />
                  </div>
                </div>
                <div>
                  <label className={fieldLabelCls}>Branch</label>
                  <input
                    type="text"
                    required
                    value={editingDraft.branch}
                    onChange={(e) =>
                      setEditingDraft({ ...editingDraft, branch: e.target.value })
                    }
                    placeholder="Branch"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={fieldLabelCls}>Fine-Grained PAT</label>
                  <PasswordInput
                    required={!editingDraft.token}
                    value={editSecretInput}
                    onChange={(e) => setEditSecretInput(e.target.value)}
                    placeholder={
                      editingDraft.token
                        ? 'New PAT (leave blank to keep existing)'
                        : 'Enter Fine-Grained PAT'
                    }
                  />
                </div>
              </>
            )}

            {editingDraft.type === 'gdrive' && (
              <>
                <div>
                  <label className={fieldLabelCls}>Google OAuth Client ID</label>
                  <input
                    type="text"
                    required
                    value={editingDraft.clientId}
                    onChange={(e) =>
                      setEditingDraft({ ...editingDraft, clientId: e.target.value })
                    }
                    placeholder="Google OAuth Client ID"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={fieldLabelCls}>Drive Folder Name</label>
                  <input
                    type="text"
                    required
                    value={editingDraft.folderName}
                    onChange={(e) =>
                      setEditingDraft({
                        ...editingDraft,
                        folderName: e.target.value,
                      })
                    }
                    placeholder="Drive Folder Name"
                    className={inputCls}
                  />
                </div>
              </>
            )}

            {editingDraft.type === 's3' && (
              <>
                <div>
                  <label className={fieldLabelCls}>Endpoint URL</label>
                  <input
                    type="url"
                    required
                    value={editingDraft.endpoint}
                    onChange={(e) =>
                      setEditingDraft({ ...editingDraft, endpoint: e.target.value })
                    }
                    placeholder="Endpoint URL"
                    className={inputCls}
                  />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className={fieldLabelCls}>Region</label>
                    <input
                      type="text"
                      required
                      value={editingDraft.region}
                      onChange={(e) =>
                        setEditingDraft({ ...editingDraft, region: e.target.value })
                      }
                      placeholder="Region"
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className={fieldLabelCls}>Bucket</label>
                    <input
                      type="text"
                      required
                      value={editingDraft.bucket}
                      onChange={(e) =>
                        setEditingDraft({ ...editingDraft, bucket: e.target.value })
                      }
                      placeholder="Bucket"
                      className={inputCls}
                    />
                  </div>
                  <div>
                    <label className={fieldLabelCls}>Prefix</label>
                    <input
                      type="text"
                      value={editingDraft.prefix ?? ''}
                      onChange={(e) =>
                        setEditingDraft({ ...editingDraft, prefix: e.target.value })
                      }
                      placeholder="Prefix"
                      className={inputCls}
                    />
                  </div>
                </div>
                <div>
                  <label className={fieldLabelCls}>Access Key ID</label>
                  <input
                    type="text"
                    required={!editingDraft.accessKeyId}
                    value={editAccessKeyInput}
                    onChange={(e) => setEditAccessKeyInput(e.target.value)}
                    placeholder={
                      editingDraft.accessKeyId
                        ? 'New Access Key ID (leave blank to keep existing)'
                        : 'Enter Access Key ID'
                    }
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={fieldLabelCls}>Secret Access Key</label>
                  <PasswordInput
                    required={!editingDraft.secretAccessKey}
                    value={editSecretInput}
                    onChange={(e) => setEditSecretInput(e.target.value)}
                    placeholder={
                      editingDraft.secretAccessKey
                        ? 'New Secret Access Key (leave blank to keep existing)'
                        : 'Enter Secret Access Key'
                    }
                  />
                </div>
              </>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setEditingDraft(null);
                  setEditSecretInput('');
                  setEditAccessKeyInput('');
                }}
                className="btn btn-ghost btn-sm h-8 min-h-0 rounded-md px-3 text-xs font-medium"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary btn-sm h-8 min-h-0 rounded-md px-3 text-xs font-medium"
              >
                Save Changes
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* Mirror All Modal */}
      <Modal
        open={!!mirrorTargetId}
        onClose={() => {
          if (!mirrorProgress) setMirrorTargetId(null);
        }}
        dismissible={!mirrorProgress}
        title="Mirror Entire Vault"
        subtitle={`Copy every file (including encrypted .obsync-vault/) into ${
          configs.find((c) => c.id === mirrorTargetId)?.label ?? ''
        }.`}
        maxWidthClass="max-w-md"
      >
        <div className="space-y-4">
          <div>
            <label className={fieldLabelCls}>Copy From Source</label>
            <select
              value={mirrorSourceId}
              onChange={(e) => setMirrorSourceId(e.target.value)}
              className="select h-9 min-h-0 w-full rounded-md border-base-content/15 bg-base-100 text-sm text-base-content focus:border-primary/70 focus:outline-none"
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
            <div className="rounded-md border border-primary/25 bg-primary/10 px-3 py-2 font-mono text-xs text-primary">
              <span className="block truncate">Copying: {mirrorProgress}</span>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={!!mirrorProgress}
              onClick={() => setMirrorTargetId(null)}
              className="btn btn-ghost btn-sm h-8 min-h-0 rounded-md px-3 text-xs font-medium"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!!mirrorProgress || !mirrorSourceId}
              onClick={() => void handleRunMirror()}
              className="btn btn-primary btn-sm h-8 min-h-0 rounded-md px-3 text-xs font-medium"
            >
              {mirrorProgress ? 'Mirroring...' : 'Start Mirror'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default SettingsView;
