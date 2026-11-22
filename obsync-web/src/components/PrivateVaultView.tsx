import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  Edit2,
  Folder,
  KeyRound,
  Lock,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Shield,
  ShieldAlert,
  Upload,
} from 'lucide-react';
import {
  WrongSecretError,
  type PrivateNoteEntry,
  type VaultIndex,
  type VaultMeta,
} from '../crypto/vaultCrypto';
import type { VaultService } from '../vault/vaultService';
import { MarkdownView } from './MarkdownView';

interface PrivateVaultViewProps {
  vaultService: VaultService;
  hasProviders: boolean;
  dek: CryptoKey | null;
  meta: VaultMeta | null;
  index: VaultIndex | null;
  autoLockMinutes: number;
  onAutoLockMinutesChange: (mins: number) => void;
  onUnlockStateChange: (next: {
    dek: CryptoKey | null;
    meta: VaultMeta | null;
    index: VaultIndex | null;
  }) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSourceChange: (label: string, usedFallback: boolean) => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
  onOpenSettings: () => void;
}

function passwordStrengthLabel(pw: string): { text: string; color: string; pct: number } {
  if (!pw) return { text: 'Enter a password', color: 'bg-slate-700', pct: 0 };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;

  if (score <= 2) return { text: 'Weak (use 12+ chars)', color: 'bg-rose-500', pct: 33 };
  if (score <= 3) return { text: 'Fair', color: 'bg-amber-500', pct: 66 };
  return { text: 'Strong', color: 'bg-emerald-500', pct: 100 };
}

function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function PrivateVaultView({
  vaultService,
  hasProviders,
  dek,
  meta,
  index,
  autoLockMinutes,
  onAutoLockMinutesChange,
  onUnlockStateChange,
  onDirtyChange,
  onSourceChange,
  onToast,
  onOpenSettings,
}: PrivateVaultViewProps) {
  const [checking, setChecking] = useState(false);
  const [vaultExists, setVaultExists] = useState<boolean | null>(meta ? true : null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Setup state
  const [setupPw, setSetupPw] = useState('');
  const [setupConfirm, setSetupConfirm] = useState('');
  const [pendingRecovery, setPendingRecovery] = useState<{
    dek: CryptoKey;
    meta: VaultMeta;
    index: VaultIndex;
    recoveryKey: string;
  } | null>(null);
  const [recoveryAck, setRecoveryAck] = useState(false);
  const [copiedRecovery, setCopiedRecovery] = useState(false);

  // Unlock / Recovery state
  const [unlockPw, setUnlockPw] = useState('');
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [recoveryInput, setRecoveryInput] = useState('');
  const [newRecoveryPw, setNewRecoveryPw] = useState('');
  const [newRecoveryConfirm, setNewRecoveryConfirm] = useState('');

  // Unlocked workspace state
  const [search, setSearch] = useState('');
  const [selectedNote, setSelectedNote] = useState<PrivateNoteEntry | null>(null);
  const [savedContent, setSavedContent] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [loadingNote, setLoadingNote] = useState(false);

  // Create / Rename note modals
  const [showNewNote, setShowNewNote] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newFolder, setNewFolder] = useState('');
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameTitle, setRenameTitle] = useState('');
  const [renameFolder, setRenameFolder] = useState('');

  // Security modal
  const [showSecurity, setShowSecurity] = useState(false);
  const [changePw, setChangePw] = useState('');
  const [changePwConfirm, setChangePwConfirm] = useState('');
  const [freshRecoveryKey, setFreshRecoveryKey] = useState<string | null>(null);
  const [legacyPw, setLegacyPw] = useState('');
  const [legacyFolder, setLegacyFolder] = useState('private');
  const [secBusy, setSecBusy] = useState(false);

  const checkVault = useCallback(async () => {
    if (!hasProviders) {
      setVaultExists(null);
      return;
    }
    setChecking(true);
    setAuthError(null);
    try {
      const res = await vaultService.checkVaultExists();
      onSourceChange(res.sourceLabel, res.usedFallback);
      setVaultExists(res.exists);
      if (res.meta) {
        onUnlockStateChange({ dek, meta: res.meta, index });
      }
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : 'Unable to check private vault.'
      );
    } finally {
      setChecking(false);
    }
  }, [hasProviders, vaultService, dek, index, onSourceChange, onUnlockStateChange]);

  useEffect(() => {
    if (!meta) {
      setVaultExists(null);
      if (hasProviders) {
        void checkVault();
      }
    }
  }, [meta, hasProviders, checkVault]);

  const isDirty = selectedNote !== null && draftContent !== savedContent;

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  const confirmDiscardIfDirty = (): boolean => {
    if (!isDirty) return true;
    return window.confirm('You have unsaved changes. Discard them?');
  };

  // Clear local decrypted editor buffers whenever vault locks
  useEffect(() => {
    if (!dek) {
      setSelectedNote(null);
      setSavedContent('');
      setDraftContent('');
      setShowSecurity(false);
      setFreshRecoveryKey(null);
    }
  }, [dek]);

  const handleInitializeVault = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    if (setupPw.length < 6) {
      setAuthError('Choose a password with at least 6 characters.');
      return;
    }
    if (setupPw !== setupConfirm) {
      setAuthError('Passwords do not match.');
      return;
    }

    setAuthBusy(true);
    try {
      const created = await vaultService.initializeNewVault(setupPw);
      setSetupPw('');
      setSetupConfirm('');
      setVaultExists(true);
      setRecoveryAck(false);
      setCopiedRecovery(false);
      setPendingRecovery({
        dek: created.dek,
        meta: created.meta,
        index: created.index,
        recoveryKey: created.recoveryKey,
      });
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : 'Failed to initialize vault.'
      );
    } finally {
      setAuthBusy(false);
    }
  };

  const handleFinishRecoveryStep = () => {
    if (!pendingRecovery) return;
    onUnlockStateChange({
      dek: pendingRecovery.dek,
      meta: pendingRecovery.meta,
      index: pendingRecovery.index,
    });
    setPendingRecovery(null);
    onToast('Private Vault initialized and unlocked.');
  };

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!meta) return;
    setAuthError(null);
    setAuthBusy(true);
    try {
      const res = await vaultService.unlockVault(unlockPw, meta);
      setUnlockPw('');
      onSourceChange(res.sourceLabel, res.usedFallback);
      onUnlockStateChange({ dek: res.dek, meta, index: res.index });
      onToast('Private Vault unlocked.');
    } catch (err) {
      if (err instanceof WrongSecretError) {
        setAuthError('Wrong master password.');
      } else {
        setAuthError(err instanceof Error ? err.message : 'Unlock failed.');
      }
    } finally {
      setAuthBusy(false);
    }
  };

  const handleRecover = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!meta) return;
    setAuthError(null);
    if (newRecoveryPw.length < 6) {
      setAuthError('New password must be at least 6 characters.');
      return;
    }
    if (newRecoveryPw !== newRecoveryConfirm) {
      setAuthError('New passwords do not match.');
      return;
    }

    setAuthBusy(true);
    try {
      const res = await vaultService.recoverVault(
        recoveryInput,
        newRecoveryPw,
        meta
      );
      setRecoveryInput('');
      setNewRecoveryPw('');
      setNewRecoveryConfirm('');
      setRecoveryMode(false);
      onUnlockStateChange({ dek: res.dek, meta: res.meta, index: res.index });
      onToast('Master password reset & vault unlocked.');
    } catch (err) {
      if (err instanceof WrongSecretError) {
        setAuthError('Invalid recovery key.');
      } else {
        setAuthError(err instanceof Error ? err.message : 'Recovery failed.');
      }
    } finally {
      setAuthBusy(false);
    }
  };

  const openNote = async (entry: PrivateNoteEntry) => {
    if (!dek || entry.id === selectedNote?.id) return;
    if (!confirmDiscardIfDirty()) return;
    setLoadingNote(true);
    try {
      const text = await vaultService.readPrivateNote(dek, entry.id);
      setSelectedNote(entry);
      setSavedContent(text);
      setDraftContent(text);
    } catch (err) {
      onToast(
        err instanceof Error ? err.message : 'Failed to decrypt note.',
        'error'
      );
    } finally {
      setLoadingNote(false);
    }
  };

  const handleSaveNote = async () => {
    if (!dek || !index || !selectedNote) return;
    setSavingNote(true);
    try {
      const res = await vaultService.savePrivateNote(dek, index, {
        id: selectedNote.id,
        title: selectedNote.title,
        folder: selectedNote.folder,
        content: draftContent,
      });
      setSelectedNote(res.note);
      setSavedContent(draftContent);
      onUnlockStateChange({ dek, meta, index: res.index });
      onToast(
        res.mirror.queuedFor.length > 0
          ? `Encrypted & saved (${res.mirror.queuedFor.length} fallback queued)`
          : 'Encrypted & synced.'
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Save failed.', 'error');
    } finally {
      setSavingNote(false);
    }
  };

  const handleDeleteNote = async () => {
    if (!dek || !index || !selectedNote) return;
    if (!window.confirm(`Permanently delete encrypted note "${selectedNote.title}"?`)) {
      return;
    }
    try {
      const res = await vaultService.deletePrivateNote(dek, index, selectedNote.id);
      setSelectedNote(null);
      setSavedContent('');
      setDraftContent('');
      onUnlockStateChange({ dek, meta, index: res.index });
      onToast('Private note deleted.');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Delete failed.', 'error');
    }
  };

  const handleCreateNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dek || !index) return;
    if (!confirmDiscardIfDirty()) return;
    const title = newTitle.trim();
    if (!title) return;
    setSavingNote(true);
    try {
      const initial = `# ${title}\n\n`;
      const res = await vaultService.savePrivateNote(dek, index, {
        title,
        folder: newFolder,
        content: initial,
      });
      setShowNewNote(false);
      setNewTitle('');
      setSelectedNote(res.note);
      setSavedContent(initial);
      setDraftContent(initial);
      onUnlockStateChange({ dek, meta, index: res.index });
      onToast(`Created "${res.note.title}"`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Create failed.', 'error');
    } finally {
      setSavingNote(false);
    }
  };

  const handleRenameSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dek || !index || !selectedNote) return;
    setSavingNote(true);
    try {
      const res = await vaultService.savePrivateNote(dek, index, {
        id: selectedNote.id,
        title: renameTitle,
        folder: renameFolder,
        content: draftContent,
      });
      setSelectedNote(res.note);
      setSavedContent(draftContent);
      setShowRenameModal(false);
      onUnlockStateChange({ dek, meta, index: res.index });
      onToast('Note updated.');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Rename failed.', 'error');
    } finally {
      setSavingNote(false);
    }
  };

  const handleRefreshIndex = async () => {
    if (!dek) return;
    try {
      const fresh = await vaultService.refreshIndex(dek);
      onUnlockStateChange({ dek, meta, index: fresh });
      onToast('Refreshed private vault index.');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Refresh failed.', 'error');
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dek || !meta) return;
    if (changePw.length < 6) {
      onToast('Password must be at least 6 characters.', 'error');
      return;
    }
    if (changePw !== changePwConfirm) {
      onToast('Passwords do not match.', 'error');
      return;
    }
    setSecBusy(true);
    try {
      const updated = await vaultService.changeMasterPassword(dek, changePw, meta);
      setChangePw('');
      setChangePwConfirm('');
      onUnlockStateChange({ dek, meta: updated, index });
      onToast('Master password updated instantly.');
    } catch (err) {
      onToast(
        err instanceof Error ? err.message : 'Password change failed.',
        'error'
      );
    } finally {
      setSecBusy(false);
    }
  };

  const handleRegenerateRecovery = async () => {
    if (!dek || !meta) return;
    if (
      !window.confirm(
        'Generate a new Recovery Key? Your previous Recovery Key will stop working.'
      )
    ) {
      return;
    }
    setSecBusy(true);
    try {
      const res = await vaultService.regenerateRecoveryKeyAndSave(dek, meta);
      setFreshRecoveryKey(res.recoveryKey);
      onUnlockStateChange({ dek, meta: res.meta, index });
      onToast('New Recovery Key generated — save it now.');
    } catch (err) {
      onToast(
        err instanceof Error ? err.message : 'Failed to regenerate key.',
        'error'
      );
    } finally {
      setSecBusy(false);
    }
  };

  const handleImportLegacy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dek || !index) return;
    setSecBusy(true);
    try {
      const res = await vaultService.importLegacyPrivateNotes(
        dek,
        index,
        legacyPw,
        legacyFolder
      );
      setLegacyPw('');
      onUnlockStateChange({ dek, meta, index: res.index });
      if (res.imported === 0 && res.failed.length === 0) {
        onToast(`No legacy .enc files found in ${legacyFolder}/.encrypted/`);
      } else {
        onToast(
          `Imported ${res.imported} note(s)${
            res.failed.length ? `, ${res.failed.length} failed` : ''
          }.`
        );
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Legacy import failed.', 'error');
    } finally {
      setSecBusy(false);
    }
  };

  const groupedNotes = useMemo(() => {
    const notes = (index?.notes ?? []).filter((n) => !n.deleted);
    const q = search.trim().toLowerCase();
    const filtered = q
      ? notes.filter(
          (n) =>
            n.title.toLowerCase().includes(q) ||
            n.folder.toLowerCase().includes(q)
        )
      : notes;

    const groups = new Map<string, PrivateNoteEntry[]>();
    for (const n of filtered) {
      const key = n.folder || '(Root)';
      const arr = groups.get(key) ?? [];
      arr.push(n);
      groups.set(key, arr);
    }
    for (const arr of groups.values()) {
      arr.sort((a, b) => a.title.localeCompare(b.title));
    }
    return Array.from(groups.entries()).sort(([a], [b]) => {
      if (a === '(Root)') return -1;
      if (b === '(Root)') return 1;
      return a.localeCompare(b);
    });
  }, [index, search]);

  if (!hasProviders) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <div className="max-w-md rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <Lock className="mx-auto mb-3 h-10 w-10 text-indigo-400" />
          <h2 className="text-lg font-semibold text-slate-100">
            Configure Storage First
          </h2>
          <p className="mt-2 text-sm text-slate-400">
            Your Private Vault stores zero-knowledge AES-256-GCM encrypted files
            across your chosen Primary and Fallback providers.
          </p>
          <button
            type="button"
            onClick={onOpenSettings}
            className="mt-4 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            Open Storage Settings
          </button>
        </div>
      </div>
    );
  }

  // Step 2 of Initialization: Show Recovery Key before entering vault
  if (pendingRecovery) {
    return (
      <div className="flex h-full items-center justify-center overflow-y-auto p-4">
        <div className="w-full max-w-lg rounded-2xl border border-amber-700/60 bg-slate-900 p-6 shadow-2xl">
          <div className="flex items-center gap-2 text-amber-400">
            <ShieldAlert className="h-6 w-6 shrink-0" />
            <h2 className="text-lg font-bold text-slate-100">
              Save Your Recovery Key
            </h2>
          </div>
          <p className="mt-2 text-sm text-slate-300">
            Obsync never stores your master password anywhere. If you ever forget
            your password, this Recovery Key is the{' '}
            <strong className="text-amber-300">only way</strong> to unlock your
            vault and set a new password.
          </p>

          <div className="mt-4 rounded-xl border border-slate-700 bg-slate-950 p-4 font-mono text-sm tracking-wider text-indigo-300 break-all">
            {pendingRecovery.recoveryKey}
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(pendingRecovery.recoveryKey);
                setCopiedRecovery(true);
              }}
              className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700"
            >
              {copiedRecovery ? (
                <Check className="h-3.5 w-3.5 text-emerald-400" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              <span>{copiedRecovery ? 'Copied' : 'Copy Key'}</span>
            </button>

            <button
              type="button"
              onClick={() =>
                downloadTextFile(
                  'obsync-recovery-key.txt',
                  `Obsync Private Vault Recovery Key\nCreated: ${new Date().toISOString()}\n\n${pendingRecovery.recoveryKey}\n\nKeep this file offline or in a password manager.\n`
                )
              }
              className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Download .txt</span>
            </button>
          </div>

          <label className="mt-5 flex cursor-pointer items-center gap-2.5 text-sm text-slate-200">
            <input
              type="checkbox"
              checked={recoveryAck}
              onChange={(e) => setRecoveryAck(e.target.checked)}
              className="h-4 w-4 rounded border-slate-600 accent-indigo-600"
            />
            <span>I have saved my Recovery Key in a safe place.</span>
          </label>

          <button
            type="button"
            disabled={!recoveryAck}
            onClick={handleFinishRecoveryStep}
            className="mt-5 w-full rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Enter Private Vault
          </button>
        </div>
      </div>
    );
  }

  // Checking storage for vault.json
  if (checking && vaultExists === null) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-slate-400">
        Checking encrypted vault storage...
      </div>
    );
  }

  // First-time Vault Setup
  if (vaultExists === false) {
    const strength = passwordStrengthLabel(setupPw);
    return (
      <div className="flex h-full items-center justify-center overflow-y-auto p-4">
        <form
          onSubmit={handleInitializeVault}
          className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-xl"
        >
          <div className="mb-4 flex items-center gap-2.5">
            <div className="rounded-xl bg-indigo-600/20 p-2.5 text-indigo-400">
              <Shield className="h-6 w-6" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-slate-100">
                Create Private Vault
              </h2>
              <p className="text-xs text-slate-400">
                Zero-knowledge AES-256-GCM · Hidden filenames
              </p>
            </div>
          </div>

          <label className="block text-xs font-medium text-slate-300">
            Master Password
          </label>
          <input
            type="password"
            name="new-password"
            autoComplete="new-password"
            required
            value={setupPw}
            onChange={(e) => setSetupPw(e.target.value)}
            placeholder="At least 12 characters recommended"
            className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-indigo-500"
          />

          <div className="mt-2">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
              <div
                className={`h-full transition-all ${strength.color}`}
                style={{ width: `${strength.pct}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-slate-400">{strength.text}</p>
          </div>

          <label className="mt-3 block text-xs font-medium text-slate-300">
            Confirm Password
          </label>
          <input
            type="password"
            name="confirm-password"
            autoComplete="new-password"
            required
            value={setupConfirm}
            onChange={(e) => setSetupConfirm(e.target.value)}
            className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-indigo-500"
          />

          {authError && (
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-rose-800/60 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{authError}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={authBusy}
            className="mt-5 w-full rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {authBusy ? 'Deriving Key & Initializing...' : 'Create Encrypted Vault'}
          </button>
        </form>
      </div>
    );
  }

  // Locked State
  if (!dek || !meta) {
    return (
      <div className="flex h-full items-center justify-center overflow-y-auto p-4">
        <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-xl">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="rounded-xl bg-indigo-600/20 p-2.5 text-indigo-400">
                <Lock className="h-6 w-6" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-slate-100">
                  {recoveryMode ? 'Recover Private Vault' : 'Private Vault Locked'}
                </h2>
                <p className="text-xs text-slate-400">
                  {recoveryMode
                    ? 'Unlock with your Recovery Key and set a new password'
                    : 'Enter your master password to decrypt folder & notes in RAM'}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void checkVault()}
              title="Re-check vault metadata"
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
            >
              <RefreshCw
                className={`h-4 w-4 ${checking ? 'animate-spin' : ''}`}
              />
            </button>
          </div>

          {!recoveryMode ? (
            <form onSubmit={handleUnlock} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-300">
                  Master Password
                </label>
                <input
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  autoFocus
                  required
                  value={unlockPw}
                  onChange={(e) => setUnlockPw(e.target.value)}
                  placeholder="Enter master password"
                  className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-indigo-500"
                />
              </div>

              {authError && (
                <div className="flex items-center gap-2 rounded-xl border border-rose-800/60 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{authError}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={authBusy || !meta}
                className="w-full rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {authBusy ? 'Unlocking (PBKDF2)...' : 'Unlock Vault'}
              </button>

              <button
                type="button"
                onClick={() => {
                  setRecoveryMode(true);
                  setAuthError(null);
                }}
                className="flex w-full items-center justify-center gap-1.5 pt-1 text-xs text-indigo-400 hover:text-indigo-300"
              >
                <KeyRound className="h-3.5 w-3.5" />
                <span>Forgot password? Use Recovery Key</span>
              </button>
            </form>
          ) : (
            <form onSubmit={handleRecover} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-300">
                  Recovery Key
                </label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={recoveryInput}
                  onChange={(e) => setRecoveryInput(e.target.value)}
                  placeholder="OBSYNC-XXXX-XXXX-..."
                  className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 font-mono text-xs text-slate-100 outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300">
                  New Master Password
                </label>
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  value={newRecoveryPw}
                  onChange={(e) => setNewRecoveryPw(e.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-indigo-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300">
                  Confirm New Password
                </label>
                <input
                  type="password"
                  autoComplete="new-password"
                  required
                  value={newRecoveryConfirm}
                  onChange={(e) => setNewRecoveryConfirm(e.target.value)}
                  className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-indigo-500"
                />
              </div>

              {authError && (
                <div className="flex items-center gap-2 rounded-xl border border-rose-800/60 bg-rose-950/50 px-3 py-2 text-xs text-rose-300">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{authError}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={authBusy}
                className="w-full rounded-xl bg-indigo-600 py-2.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {authBusy ? 'Recovering & Re-wrapping...' : 'Reset Password & Unlock'}
              </button>

              <button
                type="button"
                onClick={() => {
                  setRecoveryMode(false);
                  setAuthError(null);
                }}
                className="w-full pt-1 text-center text-xs text-slate-400 hover:text-slate-200"
              >
                ← Back to Password Unlock
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  // Unlocked Private Vault Workspace
  const totalNotes = (index?.notes ?? []).filter((n) => !n.deleted).length;

  return (
    <div className="flex h-full min-h-0">
      {/* Sidebar */}
      <aside
        className={`flex w-full flex-col border-r border-slate-800 bg-slate-900/40 md:w-72 lg:w-80 ${
          selectedNote ? 'hidden md:flex' : 'flex'
        }`}
      >
        <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-3 py-2.5">
          <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-emerald-400">
            <Lock className="h-3.5 w-3.5" />
            <span>Private ({totalNotes})</span>
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowSecurity(true)}
              title="Vault Security, Password & Legacy Import"
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
            >
              <Settings className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => void handleRefreshIndex()}
              title="Refresh encrypted index"
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setShowNewNote(true)}
              className="flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-indigo-500"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>New</span>
            </button>
          </div>
        </div>

        <div className="border-b border-slate-800 p-2.5">
          <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950 px-2.5 py-1.5">
            <Search className="h-4 w-4 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search decrypted titles..."
              className="w-full bg-transparent text-sm text-slate-100 placeholder-slate-500 outline-none"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {groupedNotes.length === 0 ? (
            <div className="p-4 text-center text-xs text-slate-500">
              <p>No private notes yet.</p>
              <p className="mt-1">
                Create one with <strong>+ New</strong> or import old CLI notes
                via the gear icon.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {groupedNotes.map(([folderName, entries]) => (
                <div key={folderName}>
                  <div className="mb-1 flex items-center gap-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                    <Folder className="h-3 w-3" />
                    <span className="truncate">{folderName}</span>
                  </div>
                  <ul className="space-y-0.5">
                    {entries.map((entry) => {
                      const active = selectedNote?.id === entry.id;
                      return (
                        <li key={entry.id}>
                          <button
                            type="button"
                            onClick={() => void openNote(entry)}
                            className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition ${
                              active
                                ? 'bg-indigo-600/20 text-indigo-200 ring-1 ring-indigo-500/40'
                                : 'text-slate-300 hover:bg-slate-800/60'
                            }`}
                          >
                            <span className="truncate font-medium">
                              {entry.title}
                            </span>
                            <span className="shrink-0 text-[10px] text-slate-500">
                              {new Date(entry.updatedAt).toLocaleDateString()}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>

      {/* Main Encrypted Editor */}
      <main
        className={`min-w-0 flex-1 ${
          selectedNote ? 'block' : 'hidden md:block'
        }`}
      >
        {loadingNote ? (
          <div className="flex h-full items-center justify-center text-sm text-slate-400">
            Decrypting note...
          </div>
        ) : selectedNote ? (
          <MarkdownView
            title={selectedNote.title}
            subtitle={
              selectedNote.folder
                ? `🔒 ${selectedNote.folder}/${selectedNote.title}`
                : `🔒 ${selectedNote.title}`
            }
            content={draftContent}
            onChangeContent={setDraftContent}
            onSave={handleSaveNote}
            onDelete={handleDeleteNote}
            onBack={() => {
              if (!confirmDiscardIfDirty()) return;
              setSelectedNote(null);
            }}
            isDirty={isDirty}
            isSaving={savingNote}
            headerExtra={
              <button
                type="button"
                onClick={() => {
                  setRenameTitle(selectedNote.title);
                  setRenameFolder(selectedNote.folder);
                  setShowRenameModal(true);
                }}
                title="Rename or move folder"
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
              >
                <Edit2 className="h-3.5 w-3.5" />
              </button>
            }
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-slate-500">
            Select an encrypted note or tap <strong>+ New</strong> to write one.
          </div>
        )}
      </main>

      {/* New Private Note Modal */}
      {showNewNote && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <form
            onSubmit={handleCreateNote}
            className="w-full max-w-md space-y-3 rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-xl"
          >
            <h3 className="text-base font-semibold text-slate-100">
              Create Encrypted Note
            </h3>
            <div>
              <label className="block text-xs text-slate-400">Title</label>
              <input
                type="text"
                autoFocus
                required
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                placeholder="Bank Accounts"
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400">
                Folder (optional — also hidden in encrypted index)
              </label>
              <input
                type="text"
                value={newFolder}
                onChange={(e) => setNewFolder(e.target.value)}
                placeholder="Finance/Personal"
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-indigo-500"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowNewNote(false)}
                className="rounded-xl border border-slate-700 px-3.5 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingNote}
                className="rounded-xl bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                Create
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Rename / Move Modal */}
      {showRenameModal && selectedNote && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <form
            onSubmit={handleRenameSubmit}
            className="w-full max-w-md space-y-3 rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-xl"
          >
            <h3 className="text-base font-semibold text-slate-100">
              Rename / Move Private Note
            </h3>
            <div>
              <label className="block text-xs text-slate-400">Title</label>
              <input
                type="text"
                autoFocus
                required
                value={renameTitle}
                onChange={(e) => setRenameTitle(e.target.value)}
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400">Folder</label>
              <input
                type="text"
                value={renameFolder}
                onChange={(e) => setRenameFolder(e.target.value)}
                placeholder="(Root)"
                className="mt-1 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-indigo-500"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowRenameModal(false)}
                className="rounded-xl border border-slate-700 px-3.5 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingNote}
                className="rounded-xl bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
              >
                Save Changes
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Security & Import Modal */}
      {showSecurity && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="max-h-[90vh] w-full max-w-lg space-y-5 overflow-y-auto rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="text-base font-semibold text-slate-100">
                Private Vault Security
              </h3>
              <button
                type="button"
                onClick={() => setShowSecurity(false)}
                className="rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                Close
              </button>
            </div>

            {/* Auto-lock timer */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-400">
                Auto-Lock Idle Timeout
              </label>
              <select
                value={autoLockMinutes}
                onChange={(e) => onAutoLockMinutesChange(Number(e.target.value))}
                className="mt-1.5 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
              >
                <option value={1}>1 minute</option>
                <option value={5}>5 minutes</option>
                <option value={10}>10 minutes (recommended)</option>
                <option value={30}>30 minutes</option>
                <option value={0}>Never (lock manually)</option>
              </select>
            </div>

            {/* Change master password */}
            <form
              onSubmit={handleChangePassword}
              className="space-y-2 border-t border-slate-800 pt-4"
            >
              <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Change Master Password
              </h4>
              <input
                type="password"
                autoComplete="new-password"
                value={changePw}
                onChange={(e) => setChangePw(e.target.value)}
                placeholder="New master password"
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
              />
              <input
                type="password"
                autoComplete="new-password"
                value={changePwConfirm}
                onChange={(e) => setChangePwConfirm(e.target.value)}
                placeholder="Confirm new password"
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
              />
              <button
                type="submit"
                disabled={secBusy}
                className="rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                Update Password
              </button>
            </form>

            {/* Regenerate recovery key */}
            <div className="space-y-2 border-t border-slate-800 pt-4">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Recovery Key
              </h4>
              <button
                type="button"
                disabled={secBusy}
                onClick={() => void handleRegenerateRecovery()}
                className="flex items-center gap-1.5 rounded-xl border border-amber-700/60 bg-amber-950/40 px-3.5 py-2 text-xs font-medium text-amber-200 hover:bg-amber-900/50"
              >
                <KeyRound className="h-3.5 w-3.5" />
                <span>Generate New Recovery Key</span>
              </button>
              {freshRecoveryKey && (
                <div className="rounded-xl border border-slate-700 bg-slate-950 p-3 font-mono text-xs text-indigo-300 break-all">
                  {freshRecoveryKey}
                </div>
              )}
            </div>

            {/* Import legacy C# CLI .enc notes */}
            <form
              onSubmit={handleImportLegacy}
              className="space-y-2 border-t border-slate-800 pt-4"
            >
              <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Import Legacy CLI Notes (private/.encrypted/*.enc)
              </h4>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input
                  type="text"
                  value={legacyFolder}
                  onChange={(e) => setLegacyFolder(e.target.value)}
                  placeholder="private"
                  className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                />
                <input
                  type="password"
                  required
                  value={legacyPw}
                  onChange={(e) => setLegacyPw(e.target.value)}
                  placeholder="Old CLI master password"
                  className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={secBusy}
                className="flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-700"
              >
                <Upload className="h-3.5 w-3.5" />
                <span>Import Legacy Notes</span>
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
