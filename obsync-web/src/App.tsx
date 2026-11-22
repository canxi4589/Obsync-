import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Lock, LockOpen, Settings } from 'lucide-react';
import type { VaultIndex, VaultMeta } from './crypto/vaultCrypto';
import {
  loadPreferences,
  loadProviderConfigs,
  savePreferences,
  saveProviderConfigs,
} from './storage/configStore';
import { StorageManager } from './storage/storageManager';
import type {
  ProviderRuntimeStatus,
  StorageProviderConfig,
} from './storage/types';
import { VaultService } from './vault/vaultService';
import { PrivateVaultView } from './components/PrivateVaultView';
import { PublicNotesView } from './components/PublicNotesView';
import { SettingsView } from './components/SettingsView';
import { StorageStatusBar } from './components/StorageStatusBar';

type Tab = 'public' | 'private' | 'settings';

export function App() {
  const [configs, setConfigs] = useState<StorageProviderConfig[]>(() =>
    loadProviderConfigs()
  );
  const [prefs, setPrefs] = useState(() => loadPreferences());
  const [tab, setTab] = useState<Tab>(() =>
    loadProviderConfigs().length === 0 ? 'settings' : 'private'
  );

  const storageRef = useRef<StorageManager | null>(null);
  if (!storageRef.current) {
    storageRef.current = new StorageManager(configs);
  }
  const storage = storageRef.current;
  const vaultService = useMemo(() => new VaultService(storage), [storage]);

  const [statuses, setStatuses] = useState<ProviderRuntimeStatus[]>(() =>
    storage.getStatuses()
  );
  const [activeSourceLabel, setActiveSourceLabel] = useState<string>(
    () => configs.find((c) => c.enabled)?.label ?? 'No storage'
  );
  const [usedFallback, setUsedFallback] = useState(false);
  const [isFlushing, setIsFlushing] = useState(false);

  // In-memory unlocked vault state (never persisted to disk/localStorage)
  const [dek, setDek] = useState<CryptoKey | null>(null);
  const [meta, setMeta] = useState<VaultMeta | null>(null);
  const [index, setIndex] = useState<VaultIndex | null>(null);

  // Toast notification
  const [toast, setToast] = useState<{
    id: number;
    msg: string;
    kind: 'info' | 'error';
  } | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback(
    (msg: string, kind: 'info' | 'error' = 'info') => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      setToast({ id: Date.now(), msg, kind });
      toastTimerRef.current = window.setTimeout(() => setToast(null), 4000);
    },
    []
  );

  useEffect(() => {
    return storage.subscribe(() => {
      setStatuses([...storage.getStatuses()]);
    });
  }, [storage]);

  const handleConfigsChange = useCallback(
    (next: StorageProviderConfig[]) => {
      setConfigs(next);
      saveProviderConfigs(next);
      storage.setConfigs(next);
      setActiveSourceLabel(next.find((c) => c.enabled)?.label ?? 'No storage');
      setUsedFallback(false);
    },
    [storage]
  );

  const handleAutoLockMinutesChange = useCallback(
    (mins: number) => {
      const next = { ...prefs, autoLockMinutes: mins };
      setPrefs(next);
      savePreferences(next);
    },
    [prefs]
  );

  const handleDefaultGoogleClientIdChange = useCallback(
    (clientId: string) => {
      const next = { ...prefs, defaultGoogleClientId: clientId };
      setPrefs(next);
      savePreferences(next);
    },
    [prefs]
  );

  const handleLockVault = useCallback(() => {
    setDek(null);
    setIndex(null);
    showToast('Private Vault locked.');
  }, [showToast]);

  // Idle auto-lock timer
  useEffect(() => {
    if (!dek || prefs.autoLockMinutes <= 0) return;

    const timeoutMs = prefs.autoLockMinutes * 60_000;
    let timerId = window.setTimeout(() => {
      setDek(null);
      setIndex(null);
      showToast('Private Vault auto-locked due to inactivity.');
    }, timeoutMs);

    const resetTimer = () => {
      window.clearTimeout(timerId);
      timerId = window.setTimeout(() => {
        setDek(null);
        setIndex(null);
        showToast('Private Vault auto-locked due to inactivity.');
      }, timeoutMs);
    };

    window.addEventListener('pointerdown', resetTimer, { passive: true });
    window.addEventListener('keydown', resetTimer, { passive: true });
    window.addEventListener('touchstart', resetTimer, { passive: true });

    return () => {
      window.clearTimeout(timerId);
      window.removeEventListener('pointerdown', resetTimer);
      window.removeEventListener('keydown', resetTimer);
      window.removeEventListener('touchstart', resetTimer);
    };
  }, [dek, prefs.autoLockMinutes, showToast]);

  const handleSourceChange = useCallback(
    (label: string, fallback: boolean) => {
      setActiveSourceLabel(label);
      setUsedFallback(fallback);
    },
    []
  );

  const handleFlushPending = useCallback(async () => {
    setIsFlushing(true);
    try {
      const res = await storage.flushPendingMirrors();
      showToast(
        `Synced ${res.flushed} pending write(s), ${res.remaining} remaining.`,
        res.errors.length ? 'error' : 'info'
      );
    } finally {
      setIsFlushing(false);
    }
  }, [storage, showToast]);

  const hasEnabledProviders = configs.some((c) => c.enabled);

  return (
    <div className="flex h-full flex-col bg-slate-950 text-slate-100">
      <StorageStatusBar
        configs={configs}
        statuses={statuses}
        activeSourceLabel={activeSourceLabel}
        usedFallback={usedFallback}
        isVaultUnlocked={!!dek}
        onLockVault={handleLockVault}
        onFlushPending={handleFlushPending}
        isFlushing={isFlushing}
        onOpenSettings={() => setTab('settings')}
      />

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* Desktop left rail */}
        <nav className="hidden w-52 shrink-0 flex-col gap-1 border-r border-slate-800 bg-slate-900/50 p-3 md:flex">
          <button
            type="button"
            onClick={() => setTab('public')}
            className={`flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
              tab === 'public'
                ? 'bg-indigo-600/20 text-indigo-300 ring-1 ring-indigo-500/40'
                : 'text-slate-300 hover:bg-slate-800/70'
            }`}
          >
            <BookOpen className="h-4 w-4" />
            <span>Public Notes</span>
          </button>

          <button
            type="button"
            onClick={() => setTab('private')}
            className={`flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
              tab === 'private'
                ? 'bg-indigo-600/20 text-indigo-300 ring-1 ring-indigo-500/40'
                : 'text-slate-300 hover:bg-slate-800/70'
            }`}
          >
            {dek ? (
              <LockOpen className="h-4 w-4 text-emerald-400" />
            ) : (
              <Lock className="h-4 w-4" />
            )}
            <span>Private Vault</span>
          </button>

          <button
            type="button"
            onClick={() => setTab('settings')}
            className={`flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
              tab === 'settings'
                ? 'bg-indigo-600/20 text-indigo-300 ring-1 ring-indigo-500/40'
                : 'text-slate-300 hover:bg-slate-800/70'
            }`}
          >
            <Settings className="h-4 w-4" />
            <span>Storage &amp; Backup</span>
          </button>
        </nav>

        {/* Main view */}
        <div className="min-h-0 flex-1 overflow-hidden">
          {tab === 'public' && (
            <PublicNotesView
              storage={storage}
              hasProviders={hasEnabledProviders}
              onSourceChange={handleSourceChange}
              onToast={showToast}
              onOpenSettings={() => setTab('settings')}
            />
          )}

          {tab === 'private' && (
            <PrivateVaultView
              vaultService={vaultService}
              hasProviders={hasEnabledProviders}
              dek={dek}
              meta={meta}
              index={index}
              autoLockMinutes={prefs.autoLockMinutes}
              onAutoLockMinutesChange={handleAutoLockMinutesChange}
              onUnlockStateChange={(next) => {
                setDek(next.dek);
                setMeta(next.meta);
                setIndex(next.index);
              }}
              onSourceChange={handleSourceChange}
              onToast={showToast}
              onOpenSettings={() => setTab('settings')}
            />
          )}

          {tab === 'settings' && (
            <SettingsView
              configs={configs}
              statuses={statuses}
              storage={storage}
              defaultGoogleClientId={prefs.defaultGoogleClientId ?? ''}
              onDefaultGoogleClientIdChange={handleDefaultGoogleClientIdChange}
              onConfigsChange={handleConfigsChange}
              onToast={showToast}
            />
          )}
        </div>

        {/* Mobile / iPhone bottom navigation */}
        <nav className="pb-safe grid grid-cols-3 border-t border-slate-800 bg-slate-900/95 md:hidden">
          <button
            type="button"
            onClick={() => setTab('public')}
            className={`flex flex-col items-center justify-center gap-0.5 py-2.5 text-[11px] font-medium ${
              tab === 'public' ? 'text-indigo-400' : 'text-slate-400'
            }`}
          >
            <BookOpen className="h-5 w-5" />
            <span>Public</span>
          </button>
          <button
            type="button"
            onClick={() => setTab('private')}
            className={`flex flex-col items-center justify-center gap-0.5 py-2.5 text-[11px] font-medium ${
              tab === 'private' ? 'text-indigo-400' : 'text-slate-400'
            }`}
          >
            {dek ? (
              <LockOpen className="h-5 w-5 text-emerald-400" />
            ) : (
              <Lock className="h-5 w-5" />
            )}
            <span>Private</span>
          </button>
          <button
            type="button"
            onClick={() => setTab('settings')}
            className={`flex flex-col items-center justify-center gap-0.5 py-2.5 text-[11px] font-medium ${
              tab === 'settings' ? 'text-indigo-400' : 'text-slate-400'
            }`}
          >
            <Settings className="h-5 w-5" />
            <span>Storage</span>
          </button>
        </nav>
      </div>

      {/* Toast Banner */}
      {toast && (
        <div
          key={toast.id}
          className={`fixed bottom-20 left-1/2 z-50 -translate-x-1/2 rounded-xl border px-4 py-2 text-xs font-medium shadow-xl md:bottom-6 ${
            toast.kind === 'error'
              ? 'border-rose-700 bg-rose-950/95 text-rose-200'
              : 'border-slate-700 bg-slate-900/95 text-slate-100'
          }`}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
}
export default App;
