import { useEffect, useRef } from 'react';
import { Command } from 'cmdk';
import {
  BookOpen,
  Check,
  FileLock2,
  FileText,
  KeyRound,
  Lock,
  Maximize2,
  Palette,
  Plus,
  RefreshCw,
  Search,
  Settings,
  X,
} from 'lucide-react';
import type { PrivateNoteEntry } from '../crypto/vaultCrypto';
import type { FileEntry, ObsyncTheme } from '../storage/types';
import { OBSYNC_THEMES } from '../theme/themes';

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  activeTab: 'public' | 'private' | 'settings';
  hasProviders: boolean;
  isVaultUnlocked: boolean;
  hasUnlockedCredentials: boolean;
  credentialStorage: 'encrypted' | 'memory';
  totalPending: number;
  publicFiles: FileEntry[];
  privateNotes: PrivateNoteEntry[];
  currentTheme: ObsyncTheme;
  onSelectTab: (tab: 'public' | 'private' | 'settings') => void;
  onOpenPublicNote: (path: string) => void;
  onOpenPrivateNote: (noteId: string) => void;
  onNewPublicNote: () => void;
  onNewPrivateNote: () => void;
  onToggleZen: () => void;
  onLockVault: () => void;
  onLockCredentials: () => void;
  onFlushPending: () => void;
  onSelectTheme: (theme: ObsyncTheme) => void;
}

export function CommandPalette({
  open,
  onClose,
  activeTab,
  hasProviders,
  isVaultUnlocked,
  hasUnlockedCredentials,
  credentialStorage,
  totalPending,
  publicFiles,
  privateNotes,
  currentTheme,
  onSelectTab,
  onOpenPublicNote,
  onOpenPrivateNote,
  onNewPublicNote,
  onNewPrivateNote,
  onToggleZen,
  onLockVault,
  onLockCredentials,
  onFlushPending,
  onSelectTheme,
}: CommandPaletteProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      cancelAnimationFrame(frame);
    };
  }, [open, onClose]);

  if (!open) return null;

  const runAndClose = (fn: () => void) => {
    onClose();
    fn();
  };

  const hasQuickActions =
    hasProviders ||
    totalPending > 0 ||
    isVaultUnlocked ||
    (hasUnlockedCredentials && credentialStorage === 'encrypted');

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command Palette"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="animate-backdrop fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-3 pt-[11vh] sm:px-4"
    >
      <div className="animate-modal w-full max-w-lg overflow-hidden rounded-lg border border-base-content/14 bg-base-200 shadow-2xl shadow-black/50">
        <Command label="Command Palette" loop>
          {/* Search Input Bar */}
          <div className="flex items-center gap-2.5 border-b border-base-content/10 px-3.5 py-2.5">
            <Search className="h-4 w-4 shrink-0 text-base-content/45" />
            <Command.Input
              ref={inputRef}
              placeholder="Jump to notes, run actions, or switch theme..."
              className="w-full bg-transparent text-sm text-base-content placeholder:text-base-content/40 outline-none"
            />
            <button
              type="button"
              onClick={onClose}
              aria-label="Close command palette"
              className="btn btn-ghost btn-xs btn-square h-6 min-h-0 w-6 rounded text-base-content/55 hover:text-base-content"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Results List */}
          <Command.List className="custom-scrollbar max-h-[56dvh] overflow-y-auto p-1.5">
            <Command.Empty className="py-10 text-center text-xs text-base-content/50">
              No matching notes, commands, or themes found.
            </Command.Empty>

            {/* Quick Actions (only rendered when at least one action is available) */}
            {hasQuickActions && (
              <Command.Group heading="Quick Actions">
                {hasProviders && (
                  <Command.Item
                    value="Create New Public Note"
                    keywords={['new', 'markdown', 'public']}
                    onSelect={() => runAndClose(onNewPublicNote)}
                  >
                    <Plus className="h-3.5 w-3.5 shrink-0 text-base-content/55" />
                    <span className="flex-1 truncate">Create New Public Note</span>
                    <span className="text-[11px] text-base-content/45">Public</span>
                  </Command.Item>
                )}

                {hasProviders && isVaultUnlocked && (
                  <Command.Item
                    value="Create New Private Note"
                    keywords={['new', 'encrypted', 'vault']}
                    onSelect={() => runAndClose(onNewPrivateNote)}
                  >
                    <Plus className="h-3.5 w-3.5 shrink-0 text-base-content/55" />
                    <span className="flex-1 truncate">Create New Private Note</span>
                    <span className="text-[11px] text-success">Encrypted</span>
                  </Command.Item>
                )}

                {activeTab !== 'settings' && hasProviders && (
                  <Command.Item
                    value="Toggle Focus Zen Mode"
                    keywords={['sidebar', 'distraction-free']}
                    onSelect={() => runAndClose(onToggleZen)}
                  >
                    <Maximize2 className="h-3.5 w-3.5 shrink-0 text-base-content/55" />
                    <span className="flex-1 truncate">Toggle Focus / Zen Mode</span>
                  </Command.Item>
                )}

                {totalPending > 0 && (
                  <Command.Item
                    value="Sync Pending Fallbacks"
                    keywords={['flush', 'queue', 'mirror']}
                    onSelect={() => runAndClose(onFlushPending)}
                  >
                    <RefreshCw className="h-3.5 w-3.5 shrink-0 text-base-content/55" />
                    <span className="flex-1 truncate">Sync Pending Fallbacks</span>
                    <span className="rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums text-primary">
                      {totalPending}
                    </span>
                  </Command.Item>
                )}

                {isVaultUnlocked && (
                  <Command.Item
                    value="Lock Private Vault Now"
                    keywords={['security', 'close']}
                    onSelect={() => runAndClose(onLockVault)}
                  >
                    <Lock className="h-3.5 w-3.5 shrink-0 text-base-content/55" />
                    <span className="flex-1 truncate">Lock Private Vault Now</span>
                  </Command.Item>
                )}

                {hasUnlockedCredentials && credentialStorage === 'encrypted' && (
                  <Command.Item
                    value="Lock API Credentials Clear RAM"
                    keywords={['keys', 'tokens', 'memory']}
                    onSelect={() => runAndClose(onLockCredentials)}
                  >
                    <KeyRound className="h-3.5 w-3.5 shrink-0 text-base-content/55" />
                    <span className="flex-1 truncate">
                      Lock API Credentials (Clear RAM)
                    </span>
                  </Command.Item>
                )}
              </Command.Group>
            )}

            {/* Navigation */}
            <Command.Group heading="Workspace">
              <Command.Item
                value="Public Notes"
                keywords={['workspace', 'markdown']}
                onSelect={() => runAndClose(() => onSelectTab('public'))}
              >
                <BookOpen className="h-3.5 w-3.5 shrink-0 text-base-content/55" />
                <span className="flex-1 truncate">Public Notes</span>
                {activeTab === 'public' && (
                  <span className="text-[11px] text-base-content/45">Current</span>
                )}
              </Command.Item>

              <Command.Item
                value="Private Vault"
                keywords={['workspace', 'encrypted']}
                onSelect={() => runAndClose(() => onSelectTab('private'))}
              >
                <Lock className="h-3.5 w-3.5 shrink-0 text-base-content/55" />
                <span className="flex-1 truncate">Private Vault</span>
                <span
                  className={`text-[11px] ${
                    isVaultUnlocked ? 'text-success' : 'text-base-content/45'
                  }`}
                >
                  {isVaultUnlocked ? 'Unlocked' : 'Locked'}
                </span>
              </Command.Item>

              <Command.Item
                value="Storage & Backup Settings"
                keywords={['providers', 'zip', 'sync']}
                onSelect={() => runAndClose(() => onSelectTab('settings'))}
              >
                <Settings className="h-3.5 w-3.5 shrink-0 text-base-content/55" />
                <span className="flex-1 truncate">Storage &amp; Backup Settings</span>
                {activeTab === 'settings' && (
                  <span className="text-[11px] text-base-content/45">Current</span>
                )}
              </Command.Item>
            </Command.Group>

            {/* Public Notes */}
            {publicFiles.length > 0 && (
              <Command.Group heading={`Public Notes (${publicFiles.length})`}>
                {publicFiles.slice(0, 60).map((f) => {
                  const name = f.path.split('/').pop()!.replace(/\.md$/i, '');
                  const folder = f.path.includes('/')
                    ? f.path.slice(0, f.path.lastIndexOf('/'))
                    : '';
                  return (
                    <Command.Item
                      key={`pub:${f.path}`}
                      value={`public ${name} ${f.path}`}
                      onSelect={() => runAndClose(() => onOpenPublicNote(f.path))}
                    >
                      <FileText className="h-3.5 w-3.5 shrink-0 text-base-content/50" />
                      <span className="flex-1 truncate font-medium">{name}</span>
                      {folder && (
                        <span className="max-w-[140px] truncate text-[11px] text-base-content/45">
                          {folder}
                        </span>
                      )}
                    </Command.Item>
                  );
                })}
              </Command.Group>
            )}

            {/* Private Vault Notes (only when unlocked) */}
            {isVaultUnlocked && privateNotes.length > 0 && (
              <Command.Group heading={`Private Vault (${privateNotes.length})`}>
                {privateNotes.slice(0, 60).map((n) => (
                  <Command.Item
                    key={`priv:${n.id}`}
                    value={`private vault ${n.title} ${n.folder ?? ''}`}
                    onSelect={() => runAndClose(() => onOpenPrivateNote(n.id))}
                  >
                    <FileLock2 className="h-3.5 w-3.5 shrink-0 text-success/80" />
                    <span className="flex-1 truncate font-medium">{n.title}</span>
                    {n.folder && (
                      <span className="max-w-[140px] truncate text-[11px] text-base-content/45">
                        {n.folder}
                      </span>
                    )}
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {/* Theme Selection */}
            <Command.Group heading="Theme">
              {OBSYNC_THEMES.map((t) => {
                const active = t.id === currentTheme;
                return (
                  <Command.Item
                    key={`theme:${t.id}`}
                    value={`Theme ${t.label}`}
                    keywords={['appearance', 'palette', t.id, t.isDark ? 'dark' : 'light']}
                    onSelect={() => runAndClose(() => onSelectTheme(t.id))}
                  >
                    <Palette className="h-3.5 w-3.5 shrink-0 text-base-content/50" />
                    <span className="flex-1 truncate">{t.label}</span>
                    <span
                      data-theme={t.id}
                      className="flex items-center gap-1 rounded border border-base-content/15 bg-base-100 px-1.5 py-0.5"
                    >
                      <span className="h-2 w-2 rounded-full bg-base-content/75" />
                      <span className="h-2 w-2 rounded-full bg-primary" />
                    </span>
                    {active && <Check className="h-3.5 w-3.5 text-primary" />}
                  </Command.Item>
                );
              })}
            </Command.Group>
          </Command.List>

          {/* Keyboard Footer Hints */}
          <div className="hidden items-center justify-between border-t border-base-content/10 bg-base-100/40 px-3.5 py-2 text-[11px] text-base-content/50 sm:flex">
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <kbd className="rounded border border-base-content/15 bg-base-200 px-1 font-mono text-[10px]">↑</kbd>
                <kbd className="rounded border border-base-content/15 bg-base-200 px-1 font-mono text-[10px]">↓</kbd>
                <span>Navigate</span>
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded border border-base-content/15 bg-base-200 px-1 font-mono text-[10px]">↵</kbd>
                <span>Select</span>
              </span>
              <span className="flex items-center gap-1">
                <kbd className="rounded border border-base-content/15 bg-base-200 px-1 font-mono text-[10px]">Esc</kbd>
                <span>Close</span>
              </span>
            </div>
            <span>Obsync</span>
          </div>
        </Command>
      </div>
    </div>
  );
}
