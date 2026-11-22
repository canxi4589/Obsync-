import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Edit2,
  FileLock2,
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
  X,
} from 'lucide-react';
import {
  MIN_MASTER_PASSWORD_LENGTH,
  WrongSecretError,
  type PrivateNoteEntry,
  type VaultIndex,
  type VaultMeta,
} from '../crypto/vaultCrypto';
import type { VaultService } from '../vault/vaultService';
import { MarkdownView } from './MarkdownView';
import { Modal } from './Modal';
import { PasswordInput } from './PasswordInput';

export interface PrivateVaultCommandSignal {
  id: number;
  type: 'open' | 'new' | 'toggle-zen';
  noteId?: string;
}

interface PrivateVaultViewProps {
  vaultService: VaultService;
  primaryKey: string;
  isActive: boolean;
  hasProviders: boolean;
  dek: CryptoKey | null;
  meta: VaultMeta | null;
  index: VaultIndex | null;
  lockEpoch: number;
  documentHidden: boolean;
  autoLockMinutes: number;
  commandSignal?: PrivateVaultCommandSignal | null;
  onAutoLockMinutesChange: (mins: number) => void;
  onMetaLoaded: (meta: VaultMeta | null) => void;
  onUnlockStateChange: (next: {
    dek: CryptoKey | null;
    meta: VaultMeta | null;
    index: VaultIndex | null;
  }) => void;
  onPendingRecoveryChange?: (active: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSourceChange: (label: string, usedFallback: boolean) => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
  onOpenSettings: () => void;
}

function passwordStrength(pw: string): {
  text: string;
  color: string;
  segments: number;
} {
  if (!pw) return { text: 'Enter a master password', color: 'bg-base-300', segments: 0 };
  if (pw.length < MIN_MASTER_PASSWORD_LENGTH) {
    return {
      text: `At least ${MIN_MASTER_PASSWORD_LENGTH} characters required (${pw.length}/${MIN_MASTER_PASSWORD_LENGTH})`,
      color: 'bg-error',
      segments: 1,
    };
  }
  let score = 1;
  if (pw.length >= 16) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;

  if (score <= 2) {
    return {
      text: 'Fair — add mixed case, numbers, or symbols',
      color: 'bg-warning',
      segments: 2,
    };
  }
  if (score === 3) {
    return { text: 'Good strength', color: 'bg-success/80', segments: 3 };
  }
  return { text: 'Strong master password', color: 'bg-success', segments: 4 };
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
  primaryKey,
  isActive,
  hasProviders,
  dek,
  meta,
  index,
  lockEpoch,
  documentHidden,
  autoLockMinutes,
  commandSignal,
  onAutoLockMinutesChange,
  onMetaLoaded,
  onUnlockStateChange,
  onPendingRecoveryChange,
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
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    () => new Set()
  );
  const [isZen, setIsZen] = useState(false);

  // Create / Rename note modals
  const [showNewNote, setShowNewNote] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newFolder, setNewFolder] = useState('');
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameTitle, setRenameTitle] = useState('');
  const [renameFolder, setRenameFolder] = useState('');

  // Security modal
  const [showSecurity, setShowSecurity] = useState(false);
  const [changeCurrentPw, setChangeCurrentPw] = useState('');
  const [changePw, setChangePw] = useState('');
  const [changePwConfirm, setChangePwConfirm] = useState('');
  const [regenCurrentPw, setRegenCurrentPw] = useState('');
  const [upgradeCurrentPw, setUpgradeCurrentPw] = useState('');
  const [upgradeProgress, setUpgradeProgress] = useState<string | null>(null);
  const [freshRecoveryKey, setFreshRecoveryKey] = useState<string | null>(null);
  const [legacyPw, setLegacyPw] = useState('');
  const [legacyFolder, setLegacyFolder] = useState('private');
  const [secBusy, setSecBusy] = useState(false);
  const [allowExternalImagesSession, setAllowExternalImagesSession] = useState(false);

  const lastCheckedKeyRef = useRef<string | null>(null);
  const lastSignalIdRef = useRef<number>(0);

  const closeSecurityModal = useCallback(() => {
    setShowSecurity(false);
    setChangeCurrentPw('');
    setChangePw('');
    setChangePwConfirm('');
    setRegenCurrentPw('');
    setUpgradeCurrentPw('');
    setUpgradeProgress(null);
    setFreshRecoveryKey(null);
    setLegacyPw('');
  }, []);

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
      onMetaLoaded(res.meta);
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : 'Unable to check private vault.'
      );
    } finally {
      setChecking(false);
    }
  }, [hasProviders, vaultService, onSourceChange, onMetaLoaded]);

  useEffect(() => {
    if (lastCheckedKeyRef.current === primaryKey) return;
    lastCheckedKeyRef.current = primaryKey;
    setVaultExists(null);
    if (primaryKey) {
      void checkVault();
    }
  }, [primaryKey, checkVault]);

  useEffect(() => {
    onPendingRecoveryChange?.(pendingRecovery !== null);
  }, [pendingRecovery, onPendingRecoveryChange]);

  const isDirty = selectedNote !== null && draftContent !== savedContent;

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  const confirmDiscardIfDirty = useCallback((): boolean => {
    if (!isDirty) return true;
    return window.confirm('You have unsaved changes. Discard them?');
  }, [isDirty]);

  useEffect(() => {
    if (!dek) {
      setSelectedNote(null);
      setSavedContent('');
      setDraftContent('');
      setAllowExternalImagesSession(false);
      closeSecurityModal();
    }
  }, [dek, closeSecurityModal]);

  useEffect(() => {
    if (lockEpoch === 0) return;
    setPendingRecovery(null);
    setRecoveryAck(false);
    setCopiedRecovery(false);
    setUnlockPw('');
    setRecoveryInput('');
    setNewRecoveryPw('');
    setNewRecoveryConfirm('');
    closeSecurityModal();
  }, [lockEpoch, closeSecurityModal]);

  const handleInitializeVault = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    if (setupPw.length < MIN_MASTER_PASSWORD_LENGTH) {
      setAuthError(
        `Choose a master password with at least ${MIN_MASTER_PASSWORD_LENGTH} characters.`
      );
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
      onMetaLoaded(created.meta);
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

  const handleCopyRecoveryKey = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key);
      setCopiedRecovery(true);
      onToast(
        'Recovery Key copied to clipboard. Clear clipboard after storing it safely.'
      );
    } catch {
      onToast(
        'Clipboard access denied — select and copy the key manually.',
        'error'
      );
    }
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
    if (newRecoveryPw.length < MIN_MASTER_PASSWORD_LENGTH) {
      setAuthError(
        `New password must be at least ${MIN_MASTER_PASSWORD_LENGTH} characters.`
      );
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

  const openNote = useCallback(
    async (entry: PrivateNoteEntry) => {
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
    },
    [dek, selectedNote?.id, confirmDiscardIfDirty, vaultService, onToast]
  );

  // Handle commands dispatched from the global Command Palette (Ctrl+K)
  useEffect(() => {
    if (!commandSignal || commandSignal.id === lastSignalIdRef.current) return;
    lastSignalIdRef.current = commandSignal.id;
    if (!dek) return;
    if (commandSignal.type === 'new') {
      setShowNewNote(true);
    } else if (commandSignal.type === 'toggle-zen') {
      setIsZen((z) => !z);
    } else if (commandSignal.type === 'open' && commandSignal.noteId) {
      const target = (index?.notes ?? []).find(
        (n) => !n.deleted && n.id === commandSignal.noteId
      );
      if (target) {
        void openNote(target);
      }
    }
  }, [commandSignal, dek, index, openNote]);

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
    if (
      !window.confirm(
        `Permanently delete encrypted note "${selectedNote.title}"?`
      )
    ) {
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
      const res =
        draftContent === savedContent
          ? await vaultService.renamePrivateNote(dek, index, {
              id: selectedNote.id,
              title: renameTitle,
              folder: renameFolder,
            })
          : await vaultService.savePrivateNote(dek, index, {
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
    if (!changeCurrentPw) {
      onToast('Enter your current master password to verify.', 'error');
      return;
    }
    if (changePw.length < MIN_MASTER_PASSWORD_LENGTH) {
      onToast(
        `New password must be at least ${MIN_MASTER_PASSWORD_LENGTH} characters.`,
        'error'
      );
      return;
    }
    if (changePw !== changePwConfirm) {
      onToast('New passwords do not match.', 'error');
      return;
    }
    setSecBusy(true);
    try {
      const updated = await vaultService.changeMasterPassword(
        changeCurrentPw,
        changePw,
        meta
      );
      setChangeCurrentPw('');
      setChangePw('');
      setChangePwConfirm('');
      onUnlockStateChange({ dek, meta: updated, index });
      onToast('Master password updated.');
    } catch (err) {
      onToast(
        err instanceof WrongSecretError
          ? 'Current master password is incorrect.'
          : err instanceof Error
            ? err.message
            : 'Password change failed.',
        'error'
      );
    } finally {
      setSecBusy(false);
    }
  };

  const handleRegenerateRecovery = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dek || !meta) return;
    if (!regenCurrentPw) {
      onToast('Enter your current master password to verify.', 'error');
      return;
    }
    if (
      !window.confirm(
        'Generate a new Recovery Key? Your previous Recovery Key will stop working.'
      )
    ) {
      return;
    }
    setSecBusy(true);
    try {
      const res = await vaultService.regenerateRecoveryKeyAndSave(
        regenCurrentPw,
        meta
      );
      setRegenCurrentPw('');
      setFreshRecoveryKey(res.recoveryKey);
      onUnlockStateChange({ dek, meta: res.meta, index });
      onToast('New Recovery Key generated — save it now.');
    } catch (err) {
      onToast(
        err instanceof WrongSecretError
          ? 'Current master password is incorrect.'
          : err instanceof Error
            ? err.message
            : 'Failed to regenerate key.',
        'error'
      );
    } finally {
      setSecBusy(false);
    }
  };

  const handleUpgradeToV2 = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dek || !meta || !index) return;
    if (!upgradeCurrentPw) {
      onToast('Enter your current master password to upgrade.', 'error');
      return;
    }
    setSecBusy(true);
    setUpgradeProgress('Starting upgrade...');
    try {
      const res = await vaultService.upgradeVaultToV2(
        upgradeCurrentPw,
        dek,
        index,
        meta,
        (done, total) => setUpgradeProgress(`Re-encrypting notes (${done}/${total})...`)
      );
      setUpgradeCurrentPw('');
      setFreshRecoveryKey(res.recoveryKey);
      onUnlockStateChange({ dek, meta: res.meta, index: res.index });
      onToast(
        `Upgraded vault to v2 (AAD + HKDF, ${res.reencryptedNotes} note(s) migrated). Save your new Recovery Key!`
      );
    } catch (err) {
      onToast(
        err instanceof WrongSecretError
          ? 'Current master password is incorrect.'
          : err instanceof Error
            ? err.message
            : 'Vault upgrade failed.',
        'error'
      );
    } finally {
      setUpgradeProgress(null);
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

  const toggleFolder = (folder: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
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
      <div className="flex h-full flex-col items-center justify-center p-6">
        <div className="w-full max-w-sm rounded-lg border border-base-content/10 bg-base-200/45 p-6 text-left">
          <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-md border border-base-content/12 bg-base-100 text-base-content/75">
            <Lock className="h-4 w-4" />
          </div>
          <h2 className="text-sm font-semibold tracking-tight text-base-content">
            Configure Storage First
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-base-content/60">
            Your Private Vault stores zero-knowledge AES-256-GCM encrypted files
            across your chosen Primary and Fallback providers.
          </p>
          <button
            type="button"
            onClick={onOpenSettings}
            className="btn btn-primary btn-sm mt-5 h-8 min-h-0 rounded-md px-3.5 text-xs font-medium"
          >
            Open Storage Settings
          </button>
        </div>
      </div>
    );
  }

  // Privacy shield while backgrounded so OS app switcher snapshots cannot capture plaintext
  if (documentHidden && (dek || pendingRecovery)) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-base-100 p-6 text-center">
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-md border border-base-content/12 bg-base-200 text-base-content/70">
          <Lock className="h-4 w-4" />
        </div>
        <p className="text-xs font-medium text-base-content/75">
          Private Vault hidden
        </p>
      </div>
    );
  }

  // Step 2 of Initialization: Show Recovery Key before entering vault
  if (pendingRecovery) {
    return (
      <div className="custom-scrollbar flex h-full items-center justify-center overflow-y-auto p-4">
        <div className="w-full max-w-lg rounded-lg border border-warning/35 bg-base-200/55 p-6">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-warning/30 bg-warning/10 text-warning">
              <ShieldAlert className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold tracking-tight text-base-content">
                Save Your Recovery Key
              </h2>
              <p className="mt-0.5 text-xs text-base-content/60">
                Shown once · Required if you ever forget your master password
              </p>
            </div>
          </div>

          <p className="mt-4 text-xs leading-relaxed text-base-content/75">
            Obsync never stores your master password anywhere. Store this
            160-bit Recovery Key offline or in a password manager —{' '}
            <strong className="font-semibold text-warning">
              not inside your synced vault folder
            </strong>
            .
          </p>

          <div className="mt-3 rounded-md border border-base-content/12 bg-base-100 p-3.5 font-mono text-xs leading-relaxed tracking-wider text-base-content break-all select-all">
            {pendingRecovery.recoveryKey}
          </div>

          <div className="mt-2.5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() =>
                void handleCopyRecoveryKey(pendingRecovery.recoveryKey)
              }
              className="btn btn-ghost btn-xs h-7 min-h-0 gap-1.5 rounded-md border border-base-content/14 px-2.5 text-xs font-medium"
            >
              {copiedRecovery ? (
                <Check className="h-3.5 w-3.5 text-success" />
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
                  `Obsync Private Vault Recovery Key\nCreated: ${new Date().toISOString()}\n\n${pendingRecovery.recoveryKey}\n\nKeep this file offline or in a password manager — DO NOT save it inside your synced Obsidian vault folder.\n`
                )
              }
              className="btn btn-ghost btn-xs h-7 min-h-0 gap-1.5 rounded-md border border-base-content/14 px-2.5 text-xs font-medium"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Download .txt</span>
            </button>
          </div>

          <label className="mt-4 flex cursor-pointer items-center gap-2.5 rounded-md border border-base-content/10 bg-base-100/70 p-3 text-xs text-base-content/85">
            <input
              type="checkbox"
              checked={recoveryAck}
              onChange={(e) => setRecoveryAck(e.target.checked)}
              className="checkbox checkbox-primary checkbox-xs rounded"
            />
            <span>
              I have saved my Recovery Key in a safe place outside my vault.
            </span>
          </label>

          <button
            type="button"
            disabled={!recoveryAck}
            onClick={handleFinishRecoveryStep}
            className="btn btn-primary btn-sm mt-4 h-9 w-full rounded-md font-medium"
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
      <div className="flex h-full flex-col items-center justify-center gap-2.5 p-6 text-xs text-base-content/60">
        <span className="loading loading-spinner loading-sm text-base-content/60" />
        <span>Checking encrypted vault storage...</span>
      </div>
    );
  }

  // First-time Vault Setup
  if (vaultExists === false) {
    const strength = passwordStrength(setupPw);
    return (
      <div className="custom-scrollbar flex h-full items-center justify-center overflow-y-auto p-4">
        <form
          onSubmit={handleInitializeVault}
          className="w-full max-w-md rounded-lg border border-base-content/12 bg-base-200/55 p-6"
        >
          <div className="mb-5 flex items-start gap-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-base-content/12 bg-base-100 text-base-content/80">
              <Shield className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-base font-semibold tracking-tight text-base-content">
                Create Private Vault
              </h2>
              <p className="mt-0.5 text-xs text-base-content/60">
                Zero-knowledge AES-256-GCM v2 · AAD + hidden filenames
              </p>
            </div>
          </div>

          <label className="block text-xs font-medium text-base-content/75">
            Master Password
          </label>
          <PasswordInput
            name="new-password"
            autoComplete="new-password"
            required
            minLength={MIN_MASTER_PASSWORD_LENGTH}
            value={setupPw}
            onChange={(e) => setSetupPw(e.target.value)}
            placeholder={`At least ${MIN_MASTER_PASSWORD_LENGTH} characters`}
            wrapperClassName="mt-1.5"
          />

          {/* 4-segment strength meter */}
          <div className="mt-2">
            <div className="grid grid-cols-4 gap-1">
              {[1, 2, 3, 4].map((seg) => (
                <div
                  key={seg}
                  className={`h-1 rounded-full transition-colors ${
                    strength.segments >= seg
                      ? strength.color
                      : 'bg-base-content/12'
                  }`}
                />
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-base-content/55">
              {strength.text}
            </p>
          </div>

          <label className="mt-3.5 block text-xs font-medium text-base-content/75">
            Confirm Password
          </label>
          <PasswordInput
            name="confirm-password"
            autoComplete="new-password"
            required
            minLength={MIN_MASTER_PASSWORD_LENGTH}
            value={setupConfirm}
            onChange={(e) => setSetupConfirm(e.target.value)}
            placeholder="Re-enter master password"
            wrapperClassName="mt-1.5"
          />

          {authError && (
            <div role="alert" className="alert alert-soft alert-error mt-3 rounded-md py-2 text-xs">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{authError}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={authBusy}
            className="btn btn-primary btn-sm mt-5 h-9 w-full rounded-md font-medium"
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
      <div className="custom-scrollbar flex h-full items-center justify-center overflow-y-auto p-4">
        <div className="w-full max-w-md rounded-lg border border-base-content/12 bg-base-200/55 p-6">
          <div className="mb-5 flex items-start justify-between gap-2">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-base-content/12 bg-base-100 text-base-content/80">
                {recoveryMode ? (
                  <KeyRound className="h-4 w-4" />
                ) : (
                  <Lock className="h-4 w-4" />
                )}
              </div>
              <div>
                <h2 className="text-base font-semibold tracking-tight text-base-content">
                  {recoveryMode ? 'Recover Private Vault' : 'Private Vault Locked'}
                </h2>
                <p className="mt-0.5 text-xs text-base-content/60">
                  {recoveryMode
                    ? 'Unlock with your Recovery Key and set a new password'
                    : 'Decrypt folder & notes in RAM with your master password'}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void checkVault()}
              title="Re-check vault metadata"
              aria-label="Re-check vault metadata"
              className="btn btn-ghost btn-xs btn-square h-7 min-h-0 w-7 rounded-md text-base-content/55 hover:text-base-content"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${checking ? 'animate-spin' : ''}`}
              />
            </button>
          </div>

          {!recoveryMode ? (
            <form onSubmit={handleUnlock} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-base-content/75">
                  Master Password
                </label>
                <PasswordInput
                  name="password"
                  autoComplete="current-password"
                  autoFocus
                  required
                  value={unlockPw}
                  onChange={(e) => setUnlockPw(e.target.value)}
                  placeholder="Enter master password"
                  wrapperClassName="mt-1.5"
                />
              </div>

              {authError && (
                <div role="alert" className="alert alert-soft alert-error rounded-md py-2 text-xs">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{authError}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={authBusy || !meta}
                className="btn btn-primary btn-sm h-9 w-full rounded-md font-medium"
              >
                {authBusy ? 'Unlocking (PBKDF2)...' : 'Unlock Vault'}
              </button>

              <button
                type="button"
                onClick={() => {
                  setRecoveryMode(true);
                  setAuthError(null);
                }}
                className="btn btn-ghost btn-xs h-8 min-h-0 w-full gap-1.5 rounded-md text-xs font-normal text-base-content/60 hover:text-base-content"
              >
                <KeyRound className="h-3.5 w-3.5" />
                <span>Forgot password? Use Recovery Key</span>
              </button>
            </form>
          ) : (
            <form onSubmit={handleRecover} className="space-y-3.5">
              <div>
                <label className="block text-xs font-medium text-base-content/75">
                  Recovery Key
                </label>
                <input
                  type="text"
                  required
                  autoFocus
                  value={recoveryInput}
                  onChange={(e) => setRecoveryInput(e.target.value)}
                  placeholder="OBSYNC-XXXX-XXXX-..."
                  className="input mt-1.5 h-9 w-full rounded-md border-base-content/15 bg-base-100 font-mono text-xs text-base-content placeholder:text-base-content/40 focus:border-primary/70 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-base-content/75">
                  New Master Password (min {MIN_MASTER_PASSWORD_LENGTH} chars)
                </label>
                <PasswordInput
                  autoComplete="new-password"
                  required
                  minLength={MIN_MASTER_PASSWORD_LENGTH}
                  value={newRecoveryPw}
                  onChange={(e) => setNewRecoveryPw(e.target.value)}
                  wrapperClassName="mt-1.5"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-base-content/75">
                  Confirm New Password
                </label>
                <PasswordInput
                  autoComplete="new-password"
                  required
                  minLength={MIN_MASTER_PASSWORD_LENGTH}
                  value={newRecoveryConfirm}
                  onChange={(e) => setNewRecoveryConfirm(e.target.value)}
                  wrapperClassName="mt-1.5"
                />
              </div>

              {authError && (
                <div role="alert" className="alert alert-soft alert-error rounded-md py-2 text-xs">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{authError}</span>
                </div>
              )}

              <button
                type="submit"
                disabled={authBusy}
                className="btn btn-primary btn-sm h-9 w-full rounded-md font-medium"
              >
                {authBusy ? 'Recovering & Re-wrapping...' : 'Reset Password & Unlock'}
              </button>

              <button
                type="button"
                onClick={() => {
                  setRecoveryMode(false);
                  setAuthError(null);
                }}
                className="btn btn-ghost btn-xs h-8 min-h-0 w-full rounded-md text-xs font-normal text-base-content/60 hover:text-base-content"
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
        className={`flex w-full flex-col border-r border-base-content/10 bg-base-100 md:w-68 lg:w-72 ${
          selectedNote ? 'hidden md:flex' : 'flex'
        } ${isZen ? 'md:hidden' : ''}`}
      >
        <div className="flex items-center justify-between gap-2 border-b border-base-content/10 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Lock className="h-3.5 w-3.5 text-success" />
            <span className="text-xs font-semibold tracking-tight text-base-content/85">
              Private Vault
            </span>
            <span className="font-mono text-[11px] tabular-nums text-base-content/45">
              {totalNotes}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowSecurity(true)}
              title="Vault Security, Password & Legacy Import"
              aria-label="Vault security settings"
              className="btn btn-ghost btn-xs btn-square h-7 min-h-0 w-7 rounded-md text-base-content/55 hover:text-base-content"
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void handleRefreshIndex()}
              title="Refresh encrypted index"
              aria-label="Refresh encrypted index"
              className="btn btn-ghost btn-xs btn-square h-7 min-h-0 w-7 rounded-md text-base-content/55 hover:text-base-content"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setShowNewNote(true)}
              className="btn btn-primary btn-xs h-7 min-h-0 gap-1 rounded-md px-2.5 text-xs font-medium"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>New</span>
            </button>
          </div>
        </div>

        <div className="border-b border-base-content/10 p-2">
          <label className="flex h-8 w-full items-center gap-2 rounded-md border border-base-content/10 bg-base-200/60 px-2.5 focus-within:border-primary/60">
            <Search className="h-3.5 w-3.5 shrink-0 text-base-content/45" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search decrypted titles..."
              className="w-full bg-transparent text-xs text-base-content placeholder:text-base-content/40 outline-none"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                aria-label="Clear search"
                className="btn btn-ghost btn-xs btn-square h-5 min-h-0 w-5 text-base-content/50"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </label>
        </div>

        <div className="custom-scrollbar flex-1 overflow-y-auto p-2">
          {groupedNotes.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
              <FileLock2 className="mb-2.5 h-5 w-5 text-base-content/35" />
              <p className="text-xs font-medium text-base-content/80">
                {search ? 'No matching notes' : 'Your private vault is empty'}
              </p>
              <p className="mt-1 text-[11px] text-base-content/50">
                {search
                  ? 'Try a different search term.'
                  : 'Create an encrypted note or import legacy CLI notes via the gear icon.'}
              </p>
              {!search && (
                <button
                  type="button"
                  onClick={() => setShowNewNote(true)}
                  className="btn btn-ghost btn-xs mt-3.5 h-7 min-h-0 gap-1 rounded-md border border-base-content/14 px-2.5 text-xs font-medium"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>New Encrypted Note</span>
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {groupedNotes.map(([folderName, entries]) => {
                const isCollapsed = !search && collapsedFolders.has(folderName);
                return (
                  <div key={folderName}>
                    <button
                      type="button"
                      onClick={() => toggleFolder(folderName)}
                      className="mb-0.5 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-base-content/55 transition hover:bg-base-content/[0.05] hover:text-base-content/85"
                    >
                      {isCollapsed ? (
                        <ChevronRight className="h-3 w-3 shrink-0" />
                      ) : (
                        <ChevronDown className="h-3 w-3 shrink-0" />
                      )}
                      <Folder className="h-3 w-3 shrink-0 opacity-70" />
                      <span className="truncate">{folderName}</span>
                      <span className="ml-auto font-mono text-[10px] tabular-nums text-base-content/40">
                        {entries.length}
                      </span>
                    </button>

                    {!isCollapsed && (
                      <ul className="space-y-0.5">
                        {entries.map((entry) => {
                          const active = selectedNote?.id === entry.id;
                          return (
                            <li key={entry.id} className="note-list-item">
                              <button
                                type="button"
                                onClick={() => void openNote(entry)}
                                className={`flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left transition ${
                                  active
                                    ? 'bg-base-content/10 text-base-content'
                                    : 'text-base-content/70 hover:bg-base-content/[0.05] hover:text-base-content'
                                }`}
                              >
                                <span className="truncate text-[13px] font-medium">
                                  {entry.title}
                                </span>
                                <span className="shrink-0 font-mono text-[10px] tabular-nums text-base-content/40">
                                  {new Date(entry.updatedAt).toLocaleDateString()}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                );
              })}
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
          <div className="mx-auto max-w-3xl space-y-4 p-8">
            <div className="skeleton h-8 w-1/3" />
            <div className="skeleton h-4 w-full" />
            <div className="skeleton h-4 w-5/6" />
            <div className="skeleton h-4 w-2/3" />
          </div>
        ) : selectedNote ? (
          <MarkdownView
            docKey={`priv:${selectedNote.id}`}
            title={selectedNote.title}
            subtitle={
              selectedNote.folder
                ? `${selectedNote.folder}/${selectedNote.title}`
                : selectedNote.title
            }
            subtitleIcon={<Lock className="h-3 w-3 shrink-0 text-success/80" />}
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
            isActive={isActive}
            blockExternalImages
            allowExternalImagesSession={allowExternalImagesSession}
            onAllowExternalImagesSession={() =>
              setAllowExternalImagesSession(true)
            }
            isZen={isZen}
            onToggleZen={() => setIsZen((z) => !z)}
            headerExtra={
              <button
                type="button"
                onClick={() => {
                  setRenameTitle(selectedNote.title);
                  setRenameFolder(selectedNote.folder);
                  setShowRenameModal(true);
                }}
                title="Rename or move folder"
                aria-label="Rename or move note"
                className="btn btn-ghost btn-xs btn-square h-6 min-h-0 w-6 rounded text-base-content/50 hover:text-base-content"
              >
                <Edit2 className="h-3 w-3" />
              </button>
            }
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center p-6 text-center">
            <FileLock2 className="mb-3 h-5 w-5 text-success/75" />
            <p className="text-sm font-medium text-base-content/85">
              Private Vault unlocked
            </p>
            <p className="mt-1 max-w-xs text-xs text-base-content/50">
              Select an encrypted note from the sidebar, press{' '}
              <kbd className="rounded border border-base-content/15 bg-base-200 px-1 font-mono text-[10px]">
                Ctrl K
              </kbd>
              , or create a new one.
            </p>
            <button
              type="button"
              onClick={() => setShowNewNote(true)}
              className="btn btn-ghost btn-sm mt-4 h-8 min-h-0 gap-1.5 rounded-md border border-base-content/14 px-3 text-xs font-medium"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Create Encrypted Note</span>
            </button>
          </div>
        )}
      </main>

      {/* New Private Note Modal */}
      <Modal
        open={showNewNote}
        onClose={() => setShowNewNote(false)}
        title="Create Encrypted Note"
        subtitle="Title and folder stay hidden inside your encrypted index."
        maxWidthClass="max-w-md"
      >
        <form onSubmit={handleCreateNote} className="space-y-3.5">
          <div>
            <label className="block text-xs font-medium text-base-content/75">
              Title
            </label>
            <input
              type="text"
              autoFocus
              required
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Bank Accounts"
              className="input mt-1.5 h-9 w-full rounded-md border-base-content/15 bg-base-100 text-sm text-base-content placeholder:text-base-content/40 focus:border-primary/70 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-base-content/75">
              Folder (optional)
            </label>
            <input
              type="text"
              value={newFolder}
              onChange={(e) => setNewFolder(e.target.value)}
              placeholder="Finance/Personal"
              className="input mt-1.5 h-9 w-full rounded-md border-base-content/15 bg-base-100 text-sm text-base-content placeholder:text-base-content/40 focus:border-primary/70 focus:outline-none"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setShowNewNote(false)}
              className="btn btn-ghost btn-sm h-8 min-h-0 rounded-md px-3 text-xs font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={savingNote}
              className="btn btn-primary btn-sm h-8 min-h-0 rounded-md px-3 text-xs font-medium"
            >
              {savingNote ? 'Creating...' : 'Create Note'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Rename / Move Modal */}
      <Modal
        open={showRenameModal && !!selectedNote}
        onClose={() => setShowRenameModal(false)}
        title="Rename / Move Private Note"
        maxWidthClass="max-w-md"
      >
        <form onSubmit={handleRenameSubmit} className="space-y-3.5">
          <div>
            <label className="block text-xs font-medium text-base-content/75">
              Title
            </label>
            <input
              type="text"
              autoFocus
              required
              value={renameTitle}
              onChange={(e) => setRenameTitle(e.target.value)}
              className="input mt-1.5 h-9 w-full rounded-md border-base-content/15 bg-base-100 text-sm text-base-content focus:border-primary/70 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-base-content/75">
              Folder
            </label>
            <input
              type="text"
              value={renameFolder}
              onChange={(e) => setRenameFolder(e.target.value)}
              placeholder="(Root)"
              className="input mt-1.5 h-9 w-full rounded-md border-base-content/15 bg-base-100 text-sm text-base-content placeholder:text-base-content/40 focus:border-primary/70 focus:outline-none"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setShowRenameModal(false)}
              className="btn btn-ghost btn-sm h-8 min-h-0 rounded-md px-3 text-xs font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={savingNote}
              className="btn btn-primary btn-sm h-8 min-h-0 rounded-md px-3 text-xs font-medium"
            >
              {savingNote ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Security & Import Modal */}
      <Modal
        open={showSecurity}
        onClose={closeSecurityModal}
        title="Private Vault Security"
        badge={
          meta && (
            <span
              className={`rounded border px-1.5 py-0.5 font-mono text-[10.5px] font-medium ${
                meta.version >= 2 && meta.recoveryKdf === 'HKDF-SHA256'
                  ? 'border-success/30 bg-success/10 text-success'
                  : 'border-warning/30 bg-warning/10 text-warning'
              }`}
            >
              {meta.version >= 2 && meta.recoveryKdf === 'HKDF-SHA256'
                ? 'v2 · AAD + HKDF'
                : 'v1 · Legacy'}
            </span>
          )
        }
      >
        <div className="space-y-5">
          {/* One-click Vault v1 -> v2 Migration */}
          {meta && (meta.version < 2 || meta.recoveryKdf !== 'HKDF-SHA256') && (
            <form
              onSubmit={handleUpgradeToV2}
              className="space-y-2.5 rounded-md border border-warning/35 bg-warning/10 p-4"
            >
              <div className="flex items-center gap-2 text-xs font-semibold text-warning">
                <Shield className="h-4 w-4" />
                <span>Upgrade Vault to Format v2</span>
              </div>
              <p className="text-xs leading-relaxed text-base-content/75">
                Adds AES-GCM Associated Authenticated Data (AAD) to prevent
                ciphertext swapping between notes, and switches your Recovery
                Key to instant HKDF-SHA256 (generates a new Recovery Key to
                save).
              </p>
              <PasswordInput
                autoComplete="current-password"
                required
                value={upgradeCurrentPw}
                onChange={(e) => setUpgradeCurrentPw(e.target.value)}
                placeholder="Confirm current master password"
              />
              {upgradeProgress && (
                <p className="text-xs text-primary">{upgradeProgress}</p>
              )}
              <button
                type="submit"
                disabled={secBusy}
                className="btn btn-warning btn-sm h-8 min-h-0 rounded-md px-3 text-xs font-medium"
              >
                {upgradeProgress ? 'Upgrading...' : 'Upgrade Vault to v2'}
              </button>
            </form>
          )}

          {/* Auto-lock timer */}
          <div>
            <label className="block text-xs font-medium text-base-content/75">
              Auto-Lock Idle Timeout
            </label>
            <select
              value={autoLockMinutes}
              onChange={(e) => onAutoLockMinutesChange(Number(e.target.value))}
              className="select mt-1.5 h-9 min-h-0 w-full rounded-md border-base-content/15 bg-base-100 text-sm text-base-content focus:border-primary/70 focus:outline-none"
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
            className="space-y-2.5 border-t border-base-content/10 pt-4"
          >
            <h4 className="text-xs font-semibold text-base-content/85">
              Change Master Password
            </h4>
            <PasswordInput
              autoComplete="current-password"
              required
              value={changeCurrentPw}
              onChange={(e) => setChangeCurrentPw(e.target.value)}
              placeholder="Current master password"
            />
            <PasswordInput
              autoComplete="new-password"
              required
              minLength={MIN_MASTER_PASSWORD_LENGTH}
              value={changePw}
              onChange={(e) => setChangePw(e.target.value)}
              placeholder={`New master password (min ${MIN_MASTER_PASSWORD_LENGTH} chars)`}
            />
            <PasswordInput
              autoComplete="new-password"
              required
              minLength={MIN_MASTER_PASSWORD_LENGTH}
              value={changePwConfirm}
              onChange={(e) => setChangePwConfirm(e.target.value)}
              placeholder="Confirm new password"
            />
            <button
              type="submit"
              disabled={secBusy}
              className="btn btn-primary btn-sm h-8 min-h-0 rounded-md px-3 text-xs font-medium"
            >
              Update Password
            </button>
          </form>

          {/* Regenerate recovery key */}
          <form
            onSubmit={handleRegenerateRecovery}
            className="space-y-2.5 border-t border-base-content/10 pt-4"
          >
            <h4 className="text-xs font-semibold text-base-content/85">
              Recovery Key
            </h4>
            <PasswordInput
              autoComplete="current-password"
              required
              value={regenCurrentPw}
              onChange={(e) => setRegenCurrentPw(e.target.value)}
              placeholder="Confirm current master password"
            />
            <button
              type="submit"
              disabled={secBusy}
              className="btn btn-soft btn-warning btn-sm h-8 min-h-0 gap-1.5 rounded-md px-3 text-xs font-medium"
            >
              <KeyRound className="h-3.5 w-3.5" />
              <span>Generate New Recovery Key</span>
            </button>
            {freshRecoveryKey && (
              <div className="space-y-2.5 rounded-md border border-base-content/12 bg-base-100 p-3">
                <div className="font-mono text-xs text-base-content break-all select-all">
                  {freshRecoveryKey}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void handleCopyRecoveryKey(freshRecoveryKey)}
                    className="btn btn-ghost btn-xs h-7 min-h-0 gap-1 rounded-md border border-base-content/14 px-2.5 text-xs"
                  >
                    <Copy className="h-3 w-3" />
                    <span>Copy Key</span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      downloadTextFile(
                        'obsync-recovery-key.txt',
                        `Obsync Private Vault Recovery Key\nGenerated: ${new Date().toISOString()}\n\n${freshRecoveryKey}\n\nKeep this file offline or in a password manager — DO NOT save it inside your synced vault folder.\n`
                      )
                    }
                    className="btn btn-ghost btn-xs h-7 min-h-0 gap-1 rounded-md border border-base-content/14 px-2.5 text-xs"
                  >
                    <Download className="h-3 w-3" />
                    <span>Download .txt</span>
                  </button>
                </div>
              </div>
            )}
          </form>

          {/* Import legacy C# CLI .enc notes */}
          <form
            onSubmit={handleImportLegacy}
            className="space-y-2.5 border-t border-base-content/10 pt-4"
          >
            <h4 className="text-xs font-semibold text-base-content/85">
              Import Legacy CLI Notes (private/.encrypted/*.enc)
            </h4>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-[11px] font-medium text-base-content/65">
                  Source Folder
                </label>
                <input
                  type="text"
                  value={legacyFolder}
                  onChange={(e) => setLegacyFolder(e.target.value)}
                  placeholder="private"
                  className="input h-9 w-full rounded-md border-base-content/15 bg-base-100 text-sm text-base-content focus:border-primary/70 focus:outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-base-content/65">
                  Legacy Master Password
                </label>
                <PasswordInput
                  required
                  value={legacyPw}
                  onChange={(e) => setLegacyPw(e.target.value)}
                  placeholder="Old CLI master password"
                />
              </div>
            </div>
            <button
              type="submit"
              disabled={secBusy}
              className="btn btn-ghost btn-sm h-8 min-h-0 gap-1.5 rounded-md border border-base-content/14 px-3 text-xs font-medium"
            >
              <Upload className="h-3.5 w-3.5" />
              <span>Import Legacy Notes</span>
            </button>
          </form>
        </div>
      </Modal>
    </div>
  );
}
