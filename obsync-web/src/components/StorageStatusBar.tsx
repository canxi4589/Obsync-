import {
  AlertTriangle,
  Cloud,
  KeyRound,
  LockOpen,
  RefreshCw,
  Search,
  Shield,
} from 'lucide-react';
import type {
  CredentialStorageMode,
  ProviderRuntimeStatus,
  StorageProviderConfig,
} from '../storage/types';

interface StorageStatusBarProps {
  configs: StorageProviderConfig[];
  statuses: ProviderRuntimeStatus[];
  activeSourceLabel: string;
  usedFallback: boolean;
  isVaultUnlocked: boolean;
  credentialStorage: CredentialStorageMode;
  credentialsLocked: boolean;
  hasUnlockedCredentials: boolean;
  onLockVault: () => void;
  onLockCredentials: () => void;
  onFlushPending: () => Promise<void>;
  isFlushing: boolean;
  onOpenSettings: () => void;
  onOpenCommandPalette: () => void;
}

export function StorageStatusBar({
  configs,
  statuses,
  activeSourceLabel,
  usedFallback,
  isVaultUnlocked,
  credentialStorage,
  credentialsLocked,
  hasUnlockedCredentials,
  onLockVault,
  onLockCredentials,
  onFlushPending,
  isFlushing,
  onOpenSettings,
  onOpenCommandPalette,
}: StorageStatusBarProps) {
  const totalPending = statuses.reduce((sum, s) => sum + s.pendingOps, 0);
  const enabledCount = configs.filter((c) => c.enabled).length;
  const hasAuthExpired = statuses.some((s) => s.state === 'auth-expired');
  const hasError = statuses.some((s) => s.state === 'error');

  const dotColor =
    credentialsLocked || usedFallback
      ? 'bg-warning'
      : hasError || hasAuthExpired
        ? 'bg-error'
        : 'bg-success';

  return (
    <header className="pt-safe sticky top-0 z-30 flex min-h-11 items-center justify-between gap-2 border-b border-base-content/10 bg-base-100 px-3 pb-1.5 text-xs sm:px-5">
      {/* Left: Active Storage Status */}
      <div className="flex min-w-0 items-center gap-2">
        {enabledCount === 0 ? (
          <button
            type="button"
            onClick={onOpenSettings}
            className="inline-flex h-7 items-center gap-2 rounded-md border border-base-content/12 bg-base-200/60 px-2.5 text-xs font-medium text-base-content/75 transition hover:border-base-content/22 hover:text-base-content"
            title="Configure a storage provider"
          >
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
            <span>No storage connected</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={onOpenSettings}
            className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition ${
              usedFallback
                ? 'border-warning/35 bg-warning/10 text-warning hover:border-warning/50'
                : 'border-base-content/10 bg-base-200/60 text-base-content/85 hover:border-base-content/20 hover:text-base-content'
            }`}
            title="Storage status — click to manage providers & fallbacks"
          >
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor}`} />
            <Cloud className="hidden h-3 w-3 shrink-0 text-base-content/55 sm:inline" />
            <span className="max-w-[125px] truncate sm:max-w-[220px]">
              {usedFallback ? `Fallback: ${activeSourceLabel}` : activeSourceLabel}
            </span>
          </button>
        )}

        {credentialStorage === 'memory' && (
          <button
            type="button"
            onClick={onOpenSettings}
            title="In-memory only mode: zero data written to localStorage or IndexedDB"
            className="hidden h-7 items-center gap-1.5 rounded-md border border-info/25 bg-info/10 px-2 text-[11px] font-medium text-info sm:inline-flex"
          >
            <Shield className="h-3 w-3" />
            <span>RAM-only</span>
          </button>
        )}

        {credentialsLocked && (
          <button
            type="button"
            onClick={onOpenSettings}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-warning/30 bg-warning/10 px-2 text-xs font-medium text-warning transition hover:border-warning/50"
          >
            <KeyRound className="h-3 w-3" />
            <span className="hidden sm:inline">Unlock Keys</span>
          </button>
        )}

        {!credentialsLocked && hasAuthExpired && (
          <button
            type="button"
            onClick={onOpenSettings}
            className="hidden h-7 items-center gap-1.5 rounded-md border border-error/30 bg-error/10 px-2 text-xs font-medium text-error transition hover:border-error/50 sm:inline-flex"
          >
            <AlertTriangle className="h-3 w-3" />
            <span>Reconnect</span>
          </button>
        )}
      </div>

      {/* Right: Mobile Command Trigger + Active Security / Sync Controls */}
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          onClick={onOpenCommandPalette}
          aria-label="Open command palette"
          title="Command Palette (Ctrl+K)"
          className="inline-flex h-7 items-center gap-1.5 rounded-md border border-base-content/12 bg-base-200/60 px-2 text-xs text-base-content/70 transition hover:border-base-content/22 hover:text-base-content md:hidden"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Jump</span>
        </button>

        {totalPending > 0 && (
          <button
            type="button"
            disabled={isFlushing}
            onClick={() => void onFlushPending()}
            className="btn btn-soft btn-primary btn-xs h-7 min-h-0 gap-1.5 rounded-md px-2.5 font-medium tabular-nums"
          >
            <RefreshCw
              className={`h-3 w-3 ${isFlushing ? 'animate-spin' : ''}`}
            />
            <span>{totalPending}</span>
            <span className="hidden sm:inline">pending</span>
          </button>
        )}

        {hasUnlockedCredentials && credentialStorage === 'encrypted' && (
          <button
            type="button"
            onClick={onLockCredentials}
            title="Clear decrypted API tokens from memory"
            className="hidden h-7 items-center gap-1.5 rounded-md border border-base-content/12 px-2.5 text-xs font-medium text-base-content/75 transition hover:border-base-content/22 hover:bg-base-200 hover:text-base-content sm:inline-flex"
          >
            <KeyRound className="h-3 w-3 text-base-content/55" />
            <span>Lock Keys</span>
          </button>
        )}

        {isVaultUnlocked && (
          <button
            type="button"
            onClick={onLockVault}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-success/30 bg-success/10 px-2.5 text-xs font-medium text-success transition hover:border-success/50 hover:bg-success/15"
            title="Lock Private Vault now"
          >
            <LockOpen className="h-3 w-3" />
            <span>Lock</span>
            <span className="hidden sm:inline">Vault</span>
          </button>
        )}
      </div>
    </header>
  );
}
