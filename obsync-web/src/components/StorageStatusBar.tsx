import {
  AlertTriangle,
  Cloud,
  Lock,
  LockOpen,
  RefreshCw,
} from 'lucide-react';
import type { ProviderRuntimeStatus, StorageProviderConfig } from '../storage/types';

interface StorageStatusBarProps {
  configs: StorageProviderConfig[];
  statuses: ProviderRuntimeStatus[];
  activeSourceLabel: string;
  usedFallback: boolean;
  isVaultUnlocked: boolean;
  onLockVault: () => void;
  onFlushPending: () => Promise<void>;
  isFlushing: boolean;
  onOpenSettings: () => void;
}

export function StorageStatusBar({
  configs,
  statuses,
  activeSourceLabel,
  usedFallback,
  isVaultUnlocked,
  onLockVault,
  onFlushPending,
  isFlushing,
  onOpenSettings,
}: StorageStatusBarProps) {
  const totalPending = statuses.reduce((sum, s) => sum + s.pendingOps, 0);
  const enabledCount = configs.filter((c) => c.enabled).length;
  const hasAuthExpired = statuses.some((s) => s.state === 'auth-expired');

  return (
    <header className="pt-safe flex items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/90 px-3 py-2 text-xs sm:px-5">
      <div className="flex min-w-0 items-center gap-2">
        <span className="font-bold tracking-tight text-indigo-400 sm:text-sm">
          Obsync
        </span>

        {enabledCount === 0 ? (
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex items-center gap-1 rounded-full border border-amber-700/60 bg-amber-950/50 px-2.5 py-0.5 text-amber-300 hover:bg-amber-900/50"
          >
            <AlertTriangle className="h-3 w-3" />
            <span>Add Storage</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={onOpenSettings}
            className={`flex min-w-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 transition ${
              usedFallback
                ? 'border-amber-600/60 bg-amber-950/50 text-amber-200'
                : 'border-slate-700 bg-slate-800/80 text-slate-300 hover:border-slate-600'
            }`}
            title="Storage status — tap to manage providers & fallbacks"
          >
            <Cloud className="h-3 w-3 shrink-0 text-indigo-400" />
            <span className="truncate">
              {usedFallback ? `Fallback: ${activeSourceLabel}` : activeSourceLabel}
            </span>
          </button>
        )}

        {hasAuthExpired && (
          <button
            type="button"
            onClick={onOpenSettings}
            className="hidden items-center gap-1 rounded-full bg-rose-950/80 px-2 py-0.5 text-rose-300 sm:flex"
          >
            <AlertTriangle className="h-3 w-3" />
            <span>Reconnect provider</span>
          </button>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {totalPending > 0 && (
          <button
            type="button"
            disabled={isFlushing}
            onClick={() => void onFlushPending()}
            className="flex items-center gap-1 rounded-full border border-indigo-500/50 bg-indigo-950/60 px-2.5 py-0.5 text-indigo-200 hover:bg-indigo-900/60 disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3 w-3 ${isFlushing ? 'animate-spin' : ''}`}
            />
            <span>{totalPending} pending</span>
          </button>
        )}

        {isVaultUnlocked ? (
          <button
            type="button"
            onClick={onLockVault}
            className="flex items-center gap-1 rounded-full border border-emerald-700/60 bg-emerald-950/60 px-2.5 py-0.5 font-medium text-emerald-300 hover:bg-emerald-900/60"
            title="Lock Private Vault now"
          >
            <LockOpen className="h-3 w-3" />
            <span>Lock Vault</span>
          </button>
        ) : (
          <span className="hidden items-center gap-1 rounded-full border border-slate-800 bg-slate-900 px-2.5 py-0.5 text-slate-500 sm:flex">
            <Lock className="h-3 w-3" />
            <span>Locked</span>
          </span>
        )}
      </div>
    </header>
  );
}
