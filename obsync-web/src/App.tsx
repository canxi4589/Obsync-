import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  Fingerprint,
  KeyRound,
  Lock,
  LockOpen,
  Search,
  Settings,
  Shield,
  X,
} from 'lucide-react';
import {
  derivePassphraseCredentialKey,
  enrollWebAuthnPrfKey,
  unlockCredentialsWithPassphrase,
  unlockCredentialsWithWebAuthn,
  type CredentialUnlockKey,
  type EncryptedCredentialsEnvelope,
} from './crypto/credentialCrypto';
import {
  WrongSecretError,
  type VaultIndex,
  type VaultMeta,
} from './crypto/vaultCrypto';
import {
  hasAnySecrets,
  loadEncryptedCredentialsEnvelope,
  loadPreferences,
  loadStoredProviders,
  mergeProviderSecrets,
  purgeAllBrowserStorage,
  saveEncryptedProviderConfigs,
  savePreferences,
  saveProviderMetadataOnly,
  stripProviderSecrets,
} from './storage/configStore';
import {
  getConnectionFingerprint,
  StorageManager,
} from './storage/storageManager';
import type {
  CredentialStorageMode,
  FileEntry,
  ObsyncTheme,
  ProviderRuntimeStatus,
  StorageProviderConfig,
} from './storage/types';
import { applyThemeToDocument, resolveTheme } from './theme/themes';
import { VaultService } from './vault/vaultService';
import { CommandPalette } from './components/CommandPalette';
import { PasswordInput } from './components/PasswordInput';
import {
  PrivateVaultView,
  type PrivateVaultCommandSignal,
} from './components/PrivateVaultView';
import {
  PublicNotesView,
  type PublicNotesCommandSignal,
} from './components/PublicNotesView';
import { StorageStatusBar } from './components/StorageStatusBar';

const SettingsView = lazy(() => import('./components/SettingsView'));

type Tab = 'public' | 'private' | 'settings';

export function App() {
  const initialStoredRef = useRef<{
    configs: StorageProviderConfig[];
    hasLegacyPlaintextSecrets: boolean;
    envelope: EncryptedCredentialsEnvelope | null;
  } | null>(null);
  if (!initialStoredRef.current) {
    const loaded = loadStoredProviders();
    initialStoredRef.current = {
      configs: loaded.configs,
      hasLegacyPlaintextSecrets: loaded.hasLegacyPlaintextSecrets,
      envelope: loadEncryptedCredentialsEnvelope(),
    };
  }

  const [configs, setConfigs] = useState<StorageProviderConfig[]>(
    () => initialStoredRef.current!.configs
  );
  const [hasLegacyPlaintextSecrets, setHasLegacyPlaintextSecrets] = useState(
    () => initialStoredRef.current!.hasLegacyPlaintextSecrets
  );
  const [encryptedEnvelope, setEncryptedEnvelope] =
    useState<EncryptedCredentialsEnvelope | null>(
      () => initialStoredRef.current!.envelope
    );
  const [credentialKey, setCredentialKey] = useState<CredentialUnlockKey | null>(
    null
  );

  const [prefs, setPrefs] = useState(() => loadPreferences());
  const [tab, setTab] = useState<Tab>(() =>
    initialStoredRef.current!.configs.length === 0 ? 'settings' : 'private'
  );

  // Credential unlock prompt state
  const [credUnlockInput, setCredUnlockInput] = useState('');
  const [credUnlockBusy, setCredUnlockBusy] = useState(false);
  const [credUnlockError, setCredUnlockError] = useState<string | null>(null);

  const storageRef = useRef<StorageManager | null>(null);
  if (!storageRef.current) {
    storageRef.current = new StorageManager(configs);
    if (prefs.credentialStorage === 'memory') {
      storageRef.current.cache.setMemoryOnly(true);
    }
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
  const [hasPendingRecovery, setHasPendingRecovery] = useState(false);
  const [lockEpoch, setLockEpoch] = useState(0);
  const [documentHidden, setDocumentHidden] = useState(
    () => typeof document !== 'undefined' && document.hidden
  );

  const [publicDirty, setPublicDirty] = useState(false);
  const [privateDirty, setPrivateDirty] = useState(false);

  // Command Palette (Ctrl+K / Cmd+K) & DaisyUI Theme state
  const [commandOpen, setCommandOpen] = useState(false);
  const [publicFiles, setPublicFiles] = useState<FileEntry[]>([]);
  const [publicCmdSignal, setPublicCmdSignal] =
    useState<PublicNotesCommandSignal | null>(null);
  const [privateCmdSignal, setPrivateCmdSignal] =
    useState<PrivateVaultCommandSignal | null>(null);
  const currentTheme = resolveTheme(prefs.theme);

  useEffect(() => {
    applyThemeToDocument(currentTheme);
  }, [currentTheme]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const credentialsLocked =
    prefs.credentialStorage === 'encrypted' &&
    encryptedEnvelope !== null &&
    credentialKey === null;

  const primaryKey = useMemo(() => {
    const p = configs.find((c) => c.enabled);
    return p ? getConnectionFingerprint(p) : '';
  }, [configs]);

  const handleUnlockStateChange = useCallback(
    (next: {
      dek: CryptoKey | null;
      meta: VaultMeta | null;
      index: VaultIndex | null;
    }) => {
      setDek(next.dek);
      setMeta(next.meta);
      setIndex(next.index);
    },
    []
  );

  const handleMetaLoaded = useCallback((loadedMeta: VaultMeta | null) => {
    setMeta(loadedMeta);
  }, []);

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
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    return storage.subscribe(() => {
      setStatuses([...storage.getStatuses()]);
    });
  }, [storage]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVis = () => setDocumentHidden(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const applyConfigState = useCallback(
    (next: StorageProviderConfig[]) => {
      const prevPrimary = configs.find((c) => c.enabled);
      const nextPrimary = next.find((c) => c.enabled);
      const primaryChanged =
        (prevPrimary ? getConnectionFingerprint(prevPrimary) : null) !==
        (nextPrimary ? getConnectionFingerprint(nextPrimary) : null);

      setConfigs(next);
      storage.setConfigs(next);
      setActiveSourceLabel(nextPrimary?.label ?? 'No storage');
      setUsedFallback(false);

      if (primaryChanged || next.length === 0) {
        setDek(null);
        setMeta(null);
        setIndex(null);
        setPrivateDirty(false);
        setLockEpoch((e) => e + 1);
        void storage.clearOfflineFiles();
      }
    },
    [configs, storage]
  );

  const handleConfigsChange = useCallback(
    async (
      next: StorageProviderConfig[],
      opts?: {
        overrideKey?: CredentialUnlockKey | null;
        overrideMode?: CredentialStorageMode;
      }
    ): Promise<void> => {
      const effectiveMode = opts?.overrideMode ?? prefs.credentialStorage;
      const effectiveKey =
        opts?.overrideKey !== undefined ? opts.overrideKey : credentialKey;

      applyConfigState(next);

      if (effectiveMode === 'memory') {
        return;
      }

      if (!hasAnySecrets(next)) {
        const env = await saveEncryptedProviderConfigs(next, null);
        setEncryptedEnvelope(env);
        setHasLegacyPlaintextSecrets(false);
        return;
      }

      if (effectiveKey) {
        const env = await saveEncryptedProviderConfigs(next, effectiveKey);
        setEncryptedEnvelope(env);
        setHasLegacyPlaintextSecrets(false);
      } else {
        saveProviderMetadataOnly(next);
      }
    },
    [applyConfigState, credentialKey, prefs.credentialStorage]
  );

  const handleProtectWithPassphrase = useCallback(
    async (
      passphrase: string,
      targetConfigs?: StorageProviderConfig[]
    ): Promise<void> => {
      const key = await derivePassphraseCredentialKey(passphrase, {
        enforceMinLength: true,
      });
      const nextConfigs = targetConfigs ?? configs;
      const nextPrefs = { ...prefs, credentialStorage: 'encrypted' as const };
      storage.cache.setMemoryOnly(false);
      setPrefs(nextPrefs);
      savePreferences(nextPrefs);
      setCredentialKey(key);
      await handleConfigsChange(nextConfigs, {
        overrideKey: key,
        overrideMode: 'encrypted',
      });
      setCredUnlockError(null);
    },
    [configs, prefs, storage.cache, handleConfigsChange]
  );

  const handleProtectWithWebAuthn = useCallback(
    async (targetConfigs?: StorageProviderConfig[]): Promise<void> => {
      const key = await enrollWebAuthnPrfKey();
      const nextConfigs = targetConfigs ?? configs;
      const nextPrefs = { ...prefs, credentialStorage: 'encrypted' as const };
      storage.cache.setMemoryOnly(false);
      setPrefs(nextPrefs);
      savePreferences(nextPrefs);
      setCredentialKey(key);
      await handleConfigsChange(nextConfigs, {
        overrideKey: key,
        overrideMode: 'encrypted',
      });
      setCredUnlockError(null);
    },
    [configs, prefs, storage.cache, handleConfigsChange]
  );

  const handleUnlockCredentialsWithPassphrase = useCallback(
    async (passphrase: string): Promise<void> => {
      if (!encryptedEnvelope) return;
      const { secrets, unlockKey } = await unlockCredentialsWithPassphrase(
        encryptedEnvelope,
        passphrase
      );
      const merged = mergeProviderSecrets(configs, secrets);
      setCredentialKey(unlockKey);
      setConfigs(merged);
      storage.setConfigs(merged);
      setCredUnlockInput('');
      setCredUnlockError(null);
      showToast('API credentials unlocked in memory.');
    },
    [encryptedEnvelope, configs, storage, showToast]
  );

  const handleUnlockCredentialsWithWebAuthn = useCallback(async (): Promise<void> => {
    if (!encryptedEnvelope) return;
    const { secrets, unlockKey } = await unlockCredentialsWithWebAuthn(
      encryptedEnvelope
    );
    const merged = mergeProviderSecrets(configs, secrets);
    setCredentialKey(unlockKey);
    setConfigs(merged);
    storage.setConfigs(merged);
    setCredUnlockError(null);
    showToast('API credentials unlocked with Passkey.');
  }, [encryptedEnvelope, configs, storage, showToast]);

  const handleLockCredentials = useCallback(() => {
    const stripped = stripProviderSecrets(configs);
    setCredentialKey(null);
    setConfigs(stripped);
    storage.setConfigs(stripped);
    showToast('API credentials cleared from memory.');
  }, [configs, storage, showToast]);

  const handleCredentialStorageChange = useCallback(
    async (mode: CredentialStorageMode): Promise<void> => {
      const nextPrefs = { ...prefs, credentialStorage: mode };
      setPrefs(nextPrefs);

      if (mode === 'memory') {
        purgeAllBrowserStorage();
        storage.cache.setMemoryOnly(true);
        await storage.cache.clearAll();
        setCredentialKey(null);
        setEncryptedEnvelope(null);
        setHasLegacyPlaintextSecrets(false);
        return;
      }

      storage.cache.setMemoryOnly(false);
      savePreferences(nextPrefs);
      if (!hasAnySecrets(configs)) {
        await saveEncryptedProviderConfigs(configs, null);
      }
    },
    [prefs, configs, storage.cache]
  );

  const totalPending = statuses.reduce((sum, s) => sum + s.pendingOps, 0);

  useEffect(() => {
    if (!publicDirty && !privateDirty && totalPending === 0) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [publicDirty, privateDirty, totalPending]);

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

  const handleSelectTheme = useCallback(
    (theme: ObsyncTheme) => {
      const next = { ...prefs, theme };
      setPrefs(next);
      savePreferences(next);
      applyThemeToDocument(theme);
    },
    [prefs]
  );

  const handleLockVault = useCallback(() => {
    if (
      privateDirty &&
      !window.confirm(
        'You have unsaved changes in Private Vault. Lock anyway and discard them?'
      )
    ) {
      return;
    }
    setDek(null);
    setIndex(null);
    setPrivateDirty(false);
    setLockEpoch((e) => e + 1);
    showToast('Private Vault locked.');
  }, [privateDirty, showToast]);

  // Wall-clock idle auto-lock (resilient to iOS PWA suspension & laptop sleep)
  const lastActivityRef = useRef<number>(Date.now());
  const isSensitiveSessionActive = !!dek || hasPendingRecovery;

  useEffect(() => {
    if (!isSensitiveSessionActive || prefs.autoLockMinutes <= 0) return;

    const timeoutMs = prefs.autoLockMinutes * 60_000;
    lastActivityRef.current = Date.now();
    let timerId: number | null = null;
    let locked = false;

    const lockNow = () => {
      if (locked) return;
      locked = true;
      if (timerId !== null) window.clearTimeout(timerId);
      setDek(null);
      setIndex(null);
      setPrivateDirty(false);
      setLockEpoch((e) => e + 1);
      showToast('Private Vault auto-locked due to inactivity.');
    };

    const checkAndSchedule = () => {
      if (locked) return true;
      const elapsed = Date.now() - lastActivityRef.current;
      if (elapsed >= timeoutMs) {
        lockNow();
        return true;
      }
      if (timerId !== null) window.clearTimeout(timerId);
      const remaining = Math.max(250, timeoutMs - elapsed);
      timerId = window.setTimeout(() => {
        checkAndSchedule();
      }, remaining);
      return false;
    };

    const onActivity = () => {
      if (checkAndSchedule()) return;
      lastActivityRef.current = Date.now();
      checkAndSchedule();
    };

    const onWakeOrVisible = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      checkAndSchedule();
    };

    checkAndSchedule();

    window.addEventListener('pointerdown', onActivity, { passive: true });
    window.addEventListener('keydown', onActivity, { passive: true });
    window.addEventListener('touchstart', onActivity, { passive: true });
    window.addEventListener('focus', onWakeOrVisible);
    window.addEventListener('pageshow', onWakeOrVisible);
    document.addEventListener('visibilitychange', onWakeOrVisible);

    return () => {
      if (timerId !== null) window.clearTimeout(timerId);
      window.removeEventListener('pointerdown', onActivity);
      window.removeEventListener('keydown', onActivity);
      window.removeEventListener('touchstart', onActivity);
      window.removeEventListener('focus', onWakeOrVisible);
      window.removeEventListener('pageshow', onWakeOrVisible);
      document.removeEventListener('visibilitychange', onWakeOrVisible);
    };
  }, [isSensitiveSessionActive, prefs.autoLockMinutes, showToast]);

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

  const handleUnlockFormSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setCredUnlockError(null);
    setCredUnlockBusy(true);
    try {
      await handleUnlockCredentialsWithPassphrase(credUnlockInput);
    } catch (err) {
      setCredUnlockError(
        err instanceof WrongSecretError
          ? 'Incorrect credential passphrase / PIN.'
          : err instanceof Error
            ? err.message
            : 'Unlock failed.'
      );
    } finally {
      setCredUnlockBusy(false);
    }
  };

  const handleUnlockWebAuthnClick = async () => {
    setCredUnlockError(null);
    setCredUnlockBusy(true);
    try {
      await handleUnlockCredentialsWithWebAuthn();
    } catch (err) {
      setCredUnlockError(
        err instanceof Error ? err.message : 'Passkey unlock failed.'
      );
    } finally {
      setCredUnlockBusy(false);
    }
  };

  const hasEnabledProviders = configs.some((c) => c.enabled);
  const effectiveHasProviders = hasEnabledProviders && !credentialsLocked;
  const activePrivateNotes = useMemo(
    () => (index?.notes ?? []).filter((n) => !n.deleted),
    [index]
  );

  return (
    <div className="flex h-full flex-col bg-base-100 text-base-content md:flex-row">
      {/* Desktop / Tablet Left Navigation Rail */}
      <aside className="hidden w-56 shrink-0 flex-col justify-between border-r border-base-content/10 bg-base-200/60 px-3 pb-3 pt-2 md:flex">
        <div>
          {/* Command Palette Trigger */}
          <button
            type="button"
            onClick={() => setCommandOpen(true)}
            className="mb-4 flex h-7 w-full items-center justify-between gap-2 rounded-md border border-base-content/10 bg-base-100/75 px-2.5 text-xs text-base-content/55 transition hover:border-base-content/20 hover:text-base-content"
          >
            <span className="flex items-center gap-2">
              <Search className="h-3.5 w-3.5" />
              <span>Quick jump…</span>
            </span>
            <kbd className="rounded border border-base-content/12 bg-base-200 px-1.5 py-0.5 font-mono text-[10px] leading-none text-base-content/55">
              Ctrl K
            </kbd>
          </button>

          <div className="mb-1 px-2 text-[10.5px] font-medium uppercase tracking-wider text-base-content/45">
            Workspace
          </div>
          <nav className="space-y-0.5">
            <button
              type="button"
              onClick={() => setTab('public')}
              className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition ${
                tab === 'public'
                  ? 'bg-base-content/10 text-base-content'
                  : 'text-base-content/60 hover:bg-base-content/[0.05] hover:text-base-content'
              }`}
            >
              <BookOpen className="h-3.5 w-3.5 shrink-0 opacity-80" />
              <span>Public Notes</span>
            </button>

            <button
              type="button"
              onClick={() => setTab('private')}
              className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition ${
                tab === 'private'
                  ? 'bg-base-content/10 text-base-content'
                  : 'text-base-content/60 hover:bg-base-content/[0.05] hover:text-base-content'
              }`}
            >
              <span className="flex items-center gap-2.5">
                {dek ? (
                  <LockOpen className="h-3.5 w-3.5 shrink-0 text-success" />
                ) : (
                  <Lock className="h-3.5 w-3.5 shrink-0 opacity-80" />
                )}
                <span>Private Vault</span>
              </span>
              {dek && (
                <span className="h-1.5 w-1.5 rounded-full bg-success" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setTab('settings')}
              className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition ${
                tab === 'settings'
                  ? 'bg-base-content/10 text-base-content'
                  : 'text-base-content/60 hover:bg-base-content/[0.05] hover:text-base-content'
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Settings className="h-3.5 w-3.5 shrink-0 opacity-80" />
                <span>Storage &amp; Backup</span>
              </span>
              {totalPending > 0 && (
                <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums text-primary">
                  {totalPending}
                </span>
              )}
            </button>
          </nav>
        </div>

        {/* Bottom Encryption Status Footer */}
        <div className="border-t border-base-content/10 px-2 pt-3 text-[11px] text-base-content/55">
          <div className="flex items-center gap-2 font-medium text-base-content/85">
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                dek ? 'bg-success' : 'bg-base-content/35'
              }`}
            />
            <span>{dek ? 'Vault Unlocked' : 'Vault Locked'}</span>
          </div>
          <p className="mt-1 pl-3.5 text-[10.5px] text-base-content/55">
            {prefs.credentialStorage === 'memory'
              ? 'RAM-only · zero local writes'
              : 'AES-256-GCM · zero-knowledge'}
          </p>
        </div>
      </aside>

      {/* Right Column: Top Status Bar + Main Content + Mobile Bottom Nav */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <StorageStatusBar
          configs={configs}
          statuses={statuses}
          activeSourceLabel={activeSourceLabel}
          usedFallback={usedFallback}
          isVaultUnlocked={!!dek}
          credentialStorage={prefs.credentialStorage}
          credentialsLocked={credentialsLocked}
          hasUnlockedCredentials={!!credentialKey}
          onLockVault={handleLockVault}
          onLockCredentials={handleLockCredentials}
          onFlushPending={handleFlushPending}
          isFlushing={isFlushing}
          onOpenSettings={() => setTab('settings')}
          onOpenCommandPalette={() => setCommandOpen(true)}
        />

        <div className="min-h-0 flex-1 overflow-hidden">
          {credentialsLocked && tab !== 'settings' ? (
            <div className="custom-scrollbar flex h-full items-center justify-center overflow-y-auto p-4">
              <div className="w-full max-w-md rounded-lg border border-base-content/12 bg-base-200/55 p-6">
                <div className="mb-5 flex items-start gap-3">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-base-content/12 bg-base-100 text-base-content/80">
                    {encryptedEnvelope?.method === 'webauthn-prf' ? (
                      <Fingerprint className="h-4 w-4" />
                    ) : (
                      <KeyRound className="h-4 w-4" />
                    )}
                  </div>
                  <div>
                    <h2 className="text-base font-semibold tracking-tight text-base-content">
                      Unlock Storage Credentials
                    </h2>
                    <p className="mt-0.5 text-xs text-base-content/60">
                      Encrypted at rest · Decrypted tokens live in RAM only
                    </p>
                  </div>
                </div>

                {encryptedEnvelope?.method === 'webauthn-prf' ? (
                  <button
                    type="button"
                    disabled={credUnlockBusy}
                    onClick={() => void handleUnlockWebAuthnClick()}
                    className="btn btn-primary btn-sm h-9 w-full gap-2 rounded-md font-medium"
                  >
                    <Fingerprint className="h-4 w-4" />
                    <span>
                      {credUnlockBusy
                        ? 'Waiting for Passkey...'
                        : 'Unlock with Passkey / Biometrics'}
                    </span>
                  </button>
                ) : (
                  <form onSubmit={handleUnlockFormSubmit} className="space-y-4">
                    <div>
                      <label className="block text-xs font-medium text-base-content/75">
                        Credential Passphrase / PIN
                      </label>
                      <PasswordInput
                        autoFocus
                        required
                        value={credUnlockInput}
                        onChange={(e) => setCredUnlockInput(e.target.value)}
                        placeholder="Enter passphrase or device PIN"
                        wrapperClassName="mt-1.5"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={credUnlockBusy}
                      className="btn btn-primary btn-sm h-9 w-full gap-2 rounded-md font-medium"
                    >
                      <Shield className="h-3.5 w-3.5" />
                      <span>
                        {credUnlockBusy
                          ? 'Decrypting Credentials...'
                          : 'Unlock Storage Keys'}
                      </span>
                    </button>
                  </form>
                )}

                {credUnlockError && (
                  <div role="alert" className="alert alert-soft alert-error mt-3 rounded-md py-2 text-xs">
                    <AlertCircle className="h-4 w-4 shrink-0" />
                    <span>{credUnlockError}</span>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => setTab('settings')}
                  className="btn btn-ghost btn-sm mt-3 h-8 min-h-0 w-full rounded-md text-xs font-normal text-base-content/60 hover:text-base-content"
                >
                  Open Storage Settings / Reset Credentials →
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className={tab === 'public' ? 'h-full' : 'hidden'}>
                <PublicNotesView
                  storage={storage}
                  primaryKey={primaryKey}
                  isActive={tab === 'public' && !credentialsLocked}
                  hasProviders={effectiveHasProviders}
                  commandSignal={publicCmdSignal}
                  onFilesChange={setPublicFiles}
                  onSourceChange={handleSourceChange}
                  onDirtyChange={setPublicDirty}
                  onToast={showToast}
                  onOpenSettings={() => setTab('settings')}
                />
              </div>

              <div className={tab === 'private' ? 'h-full' : 'hidden'}>
                <PrivateVaultView
                  vaultService={vaultService}
                  primaryKey={primaryKey}
                  isActive={tab === 'private' && !credentialsLocked}
                  hasProviders={effectiveHasProviders}
                  dek={dek}
                  meta={meta}
                  index={index}
                  lockEpoch={lockEpoch}
                  documentHidden={documentHidden}
                  autoLockMinutes={prefs.autoLockMinutes}
                  commandSignal={privateCmdSignal}
                  onAutoLockMinutesChange={handleAutoLockMinutesChange}
                  onMetaLoaded={handleMetaLoaded}
                  onUnlockStateChange={handleUnlockStateChange}
                  onPendingRecoveryChange={setHasPendingRecovery}
                  onDirtyChange={setPrivateDirty}
                  onSourceChange={handleSourceChange}
                  onToast={showToast}
                  onOpenSettings={() => setTab('settings')}
                />
              </div>
            </>
          )}

          {tab === 'settings' && (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center gap-2 text-sm text-base-content/60">
                  <span className="loading loading-spinner loading-sm text-primary" />
                  <span>Loading settings...</span>
                </div>
              }
            >
              <SettingsView
                configs={configs}
                statuses={statuses}
                storage={storage}
                defaultGoogleClientId={prefs.defaultGoogleClientId ?? ''}
                currentTheme={currentTheme}
                onSelectTheme={handleSelectTheme}
                credentialStorage={prefs.credentialStorage}
                credentialUnlockMethod={
                  credentialKey?.method ?? encryptedEnvelope?.method ?? null
                }
                hasUnlockedCredentials={!!credentialKey}
                credentialsLocked={credentialsLocked}
                hasLegacyPlaintextSecrets={hasLegacyPlaintextSecrets}
                onCredentialStorageChange={handleCredentialStorageChange}
                onProtectWithPassphrase={handleProtectWithPassphrase}
                onProtectWithWebAuthn={handleProtectWithWebAuthn}
                onUnlockWithPassphrase={handleUnlockCredentialsWithPassphrase}
                onUnlockWithWebAuthn={handleUnlockCredentialsWithWebAuthn}
                onLockCredentials={handleLockCredentials}
                onDefaultGoogleClientIdChange={handleDefaultGoogleClientIdChange}
                onConfigsChange={handleConfigsChange}
                onToast={showToast}
              />
            </Suspense>
          )}
        </div>

        {/* Mobile / iPhone Bottom Navigation */}
        <nav className="pb-safe grid grid-cols-3 border-t border-base-content/10 bg-base-200 px-2 pt-1 md:hidden">
          {(
            [
              {
                id: 'public' as const,
                label: 'Public',
                icon: <BookOpen className="h-4 w-4" />,
              },
              {
                id: 'private' as const,
                label: 'Private',
                icon: dek ? (
                  <LockOpen className="h-4 w-4 text-success" />
                ) : (
                  <Lock className="h-4 w-4" />
                ),
              },
              {
                id: 'settings' as const,
                label: 'Storage',
                icon: <Settings className="h-4 w-4" />,
              },
            ] as const
          ).map((item) => {
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`relative flex min-h-[46px] flex-col items-center justify-center gap-0.5 rounded-md text-[11px] font-medium transition ${
                  active
                    ? 'text-base-content'
                    : 'text-base-content/50 hover:text-base-content/80'
                }`}
              >
                {active && (
                  <span className="absolute top-0 h-0.5 w-8 rounded-full bg-primary" />
                )}
                {item.icon}
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Global Command Palette (Ctrl+K / Cmd+K) */}
      <CommandPalette
        open={commandOpen}
        onClose={() => setCommandOpen(false)}
        activeTab={tab}
        hasProviders={effectiveHasProviders}
        isVaultUnlocked={!!dek}
        hasUnlockedCredentials={!!credentialKey}
        credentialStorage={prefs.credentialStorage}
        totalPending={totalPending}
        publicFiles={publicFiles}
        privateNotes={activePrivateNotes}
        currentTheme={currentTheme}
        onSelectTab={setTab}
        onOpenPublicNote={(path) => {
          setTab('public');
          setPublicCmdSignal({ id: Date.now(), type: 'open', path });
        }}
        onOpenPrivateNote={(noteId) => {
          setTab('private');
          setPrivateCmdSignal({ id: Date.now(), type: 'open', noteId });
        }}
        onNewPublicNote={() => {
          setTab('public');
          setPublicCmdSignal({ id: Date.now(), type: 'new' });
        }}
        onNewPrivateNote={() => {
          setTab('private');
          setPrivateCmdSignal({ id: Date.now(), type: 'new' });
        }}
        onToggleZen={() => {
          if (tab === 'public') {
            setPublicCmdSignal({ id: Date.now(), type: 'toggle-zen' });
          } else if (tab === 'private') {
            setPrivateCmdSignal({ id: Date.now(), type: 'toggle-zen' });
          }
        }}
        onLockVault={handleLockVault}
        onLockCredentials={handleLockCredentials}
        onFlushPending={() => void handleFlushPending()}
        onSelectTheme={handleSelectTheme}
      />

      {/* Floating Toast Notification */}
      {toast && (
        <div
          key={toast.id}
          role="status"
          className={`animate-toast alert fixed bottom-20 left-1/2 z-50 flex w-auto max-w-[92vw] items-center gap-2 rounded-lg border px-3.5 py-2 text-xs font-medium shadow-lg shadow-black/35 md:bottom-5 ${
            toast.kind === 'error'
              ? 'alert-error border-error/40'
              : 'border-base-content/15 bg-base-200 text-base-content'
          }`}
        >
          {toast.kind === 'error' ? (
            <AlertCircle className="h-4 w-4 shrink-0" />
          ) : (
            <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
          )}
          <span className="truncate">{toast.msg}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Dismiss notification"
            className="btn btn-ghost btn-xs btn-square ml-1 h-5 min-h-0 w-5 shrink-0"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
export default App;
