import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  Plus,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { bytesToUtf8, utf8ToBytes } from '../crypto/base64';
import { validatePublicNotePath } from '../storage/pathUtils';
import type { StorageManager } from '../storage/storageManager';
import type { FileEntry } from '../storage/types';
import { MarkdownView } from './MarkdownView';
import { Modal } from './Modal';

export interface PublicNotesCommandSignal {
  id: number;
  type: 'open' | 'new' | 'toggle-zen';
  path?: string;
}

interface PublicNotesViewProps {
  storage: StorageManager;
  primaryKey: string;
  isActive: boolean;
  hasProviders: boolean;
  commandSignal?: PublicNotesCommandSignal | null;
  onFilesChange?: (files: FileEntry[]) => void;
  onSourceChange: (label: string, usedFallback: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onToast: (msg: string, kind?: 'info' | 'error') => void;
  onOpenSettings: () => void;
}

export function PublicNotesView({
  storage,
  primaryKey,
  isActive,
  hasProviders,
  commandSignal,
  onFilesChange,
  onSourceChange,
  onDirtyChange,
  onToast,
  onOpenSettings,
}: PublicNotesViewProps) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingNote, setLoadingNote] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [savedContent, setSavedContent] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [showNewModal, setShowNewModal] = useState(false);
  const [newPathInput, setNewPathInput] = useState('');
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    () => new Set()
  );
  const [isZen, setIsZen] = useState(false);

  const loadedKeyRef = useRef<string | null>(null);
  const lastSignalIdRef = useRef<number>(0);

  useEffect(() => {
    onFilesChange?.(files);
  }, [files, onFilesChange]);

  const refreshList = useCallback(async () => {
    if (!hasProviders) {
      setFiles([]);
      return;
    }
    setLoading(true);
    try {
      const res = await storage.list('');
      onSourceChange(res.sourceLabel, res.usedFallback);
      const mdFiles = res.entries
        .filter(
          (e) =>
            !e.path.startsWith('.obsync-vault/') &&
            !e.path.startsWith('.git/') &&
            !e.path.startsWith('.obsidian/') &&
            !e.path.startsWith('private/') &&
            e.path.toLowerCase().endsWith('.md')
        )
        .sort((a, b) => a.path.localeCompare(b.path));
      setFiles(mdFiles);
    } catch (err) {
      onToast(
        err instanceof Error ? err.message : 'Failed to list public notes.',
        'error'
      );
    } finally {
      setLoading(false);
    }
  }, [hasProviders, storage, onSourceChange, onToast]);

  const isDirty = selectedPath !== null && draftContent !== savedContent;

  useEffect(() => {
    onDirtyChange?.(isDirty);
  }, [isDirty, onDirtyChange]);

  const confirmDiscardIfDirty = useCallback((): boolean => {
    if (!isDirty) return true;
    return window.confirm('You have unsaved changes. Discard them?');
  }, [isDirty]);

  // Reset editor state when primary storage changes
  useEffect(() => {
    loadedKeyRef.current = null;
    setSelectedPath(null);
    setSavedContent('');
    setDraftContent('');
    if (!hasProviders) setFiles([]);
  }, [primaryKey, hasProviders]);

  // Lazy-load the public note tree only once the Public tab is actually opened
  useEffect(() => {
    if (!isActive || !hasProviders) return;
    if (loadedKeyRef.current === primaryKey) return;
    loadedKeyRef.current = primaryKey;
    void refreshList();
  }, [isActive, hasProviders, primaryKey, refreshList]);

  const openNote = useCallback(
    async (path: string) => {
      if (path === selectedPath) return;
      if (!confirmDiscardIfDirty()) return;
      setLoadingNote(true);
      try {
        const res = await storage.read(path);
        onSourceChange(res.sourceLabel, res.usedFallback);
        const text = res.data ? bytesToUtf8(res.data) : '';
        setSelectedPath(path);
        setSavedContent(text);
        setDraftContent(text);
      } catch (err) {
        onToast(
          err instanceof Error ? err.message : 'Failed to read note.',
          'error'
        );
      } finally {
        setLoadingNote(false);
      }
    },
    [selectedPath, confirmDiscardIfDirty, storage, onSourceChange, onToast]
  );

  // Handle commands dispatched from the global Command Palette (Ctrl+K)
  useEffect(() => {
    if (!commandSignal || commandSignal.id === lastSignalIdRef.current) return;
    lastSignalIdRef.current = commandSignal.id;
    if (commandSignal.type === 'new') {
      setShowNewModal(true);
    } else if (commandSignal.type === 'toggle-zen') {
      setIsZen((z) => !z);
    } else if (commandSignal.type === 'open' && commandSignal.path) {
      void openNote(commandSignal.path);
    }
  }, [commandSignal, openNote]);

  const handleSave = async () => {
    if (!selectedPath) return;
    setSaving(true);
    try {
      const bytes = utf8ToBytes(draftContent);
      const summary = await storage.write(
        selectedPath,
        bytes,
        `Update ${selectedPath}`
      );
      setSavedContent(draftContent);
      setFiles((prev) =>
        prev.map((f) =>
          f.path === selectedPath
            ? { ...f, size: bytes.byteLength, updatedAt: new Date().toISOString() }
            : f
        )
      );
      const mirrorMsg =
        summary.queuedFor.length > 0
          ? `Saved to ${summary.primaryWrittenLabel} (${summary.queuedFor.length} fallback queued)`
          : `Saved to ${summary.primaryWrittenLabel}`;
      onToast(mirrorMsg);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Save failed.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedPath) return;
    if (!window.confirm(`Delete "${selectedPath}"?`)) return;
    const deletedPath = selectedPath;
    try {
      await storage.delete(deletedPath, `Delete ${deletedPath}`);
      onToast(`Deleted ${deletedPath}`);
      setSelectedPath(null);
      setSavedContent('');
      setDraftContent('');
      setFiles((prev) => prev.filter((f) => f.path !== deletedPath));
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Delete failed.', 'error');
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirmDiscardIfDirty()) return;
    const validated = validatePublicNotePath(newPathInput);
    if (!validated.ok) {
      onToast(validated.error, 'error');
      return;
    }
    const clean = validated.path;

    setSaving(true);
    try {
      const title = clean.split('/').pop()!.replace(/\.md$/i, '');
      const initial = `# ${title}\n\n`;
      const bytes = utf8ToBytes(initial);
      await storage.write(clean, bytes, `Create ${clean}`);
      setShowNewModal(false);
      setNewPathInput('');
      setSelectedPath(clean);
      setSavedContent(initial);
      setDraftContent(initial);
      setFiles((prev) => {
        const next = prev.filter((f) => f.path !== clean);
        next.push({
          path: clean,
          size: bytes.byteLength,
          updatedAt: new Date().toISOString(),
        });
        next.sort((a, b) => a.path.localeCompare(b.path));
        return next;
      });
      onToast(`Created ${clean}`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Create failed.', 'error');
    } finally {
      setSaving(false);
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

  const { grouped, totalFiltered } = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = q
      ? files.filter((f) => f.path.toLowerCase().includes(q))
      : files;

    const groups = new Map<string, FileEntry[]>();
    for (const f of list) {
      const slash = f.path.lastIndexOf('/');
      const folder = slash > 0 ? f.path.slice(0, slash) : '(Root)';
      const arr = groups.get(folder) ?? [];
      arr.push(f);
      groups.set(folder, arr);
    }

    const sorted = Array.from(groups.entries()).sort(([a], [b]) => {
      if (a === '(Root)') return -1;
      if (b === '(Root)') return 1;
      return a.localeCompare(b);
    });
    return { grouped: sorted, totalFiltered: list.length };
  }, [files, search]);

  if (!hasProviders) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6">
        <div className="w-full max-w-sm rounded-lg border border-base-content/10 bg-base-200/45 p-6 text-left">
          <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-md border border-base-content/12 bg-base-100 text-base-content/75">
            <BookOpen className="h-4 w-4" />
          </div>
          <h2 className="text-sm font-semibold tracking-tight text-base-content">
            Connect a Storage Provider
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-base-content/60">
            Add GitHub, Google Drive, a Local Folder, or S3/R2 in Settings to
            browse and edit your Obsidian notes across desktop and mobile.
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

  return (
    <div className="flex h-full min-h-0">
      {/* Sidebar list */}
      <aside
        className={`flex w-full flex-col border-r border-base-content/10 bg-base-100 md:w-68 lg:w-72 ${
          selectedPath ? 'hidden md:flex' : 'flex'
        } ${isZen ? 'md:hidden' : ''}`}
      >
        <div className="flex items-center justify-between gap-2 border-b border-base-content/10 px-3 py-2.5">
          <div className="flex items-center gap-2">
            <BookOpen className="h-3.5 w-3.5 text-base-content/60" />
            <span className="text-xs font-semibold tracking-tight text-base-content/85">
              Public Notes
            </span>
            <span className="font-mono text-[11px] tabular-nums text-base-content/45">
              {totalFiltered}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void refreshList()}
              className="btn btn-ghost btn-xs btn-square h-7 min-h-0 w-7 rounded-md text-base-content/55 hover:text-base-content"
              title="Refresh list"
              aria-label="Refresh list"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
              />
            </button>
            <button
              type="button"
              onClick={() => setShowNewModal(true)}
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
              placeholder="Filter notes or folders..."
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
          {loading && files.length === 0 ? (
            <div className="space-y-1.5 p-1">
              {[...Array(6)].map((_, i) => (
                <div key={i} className="skeleton h-8 w-full rounded-md" />
              ))}
            </div>
          ) : grouped.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
              <FileText className="mb-2.5 h-5 w-5 text-base-content/35" />
              <p className="text-xs font-medium text-base-content/80">
                {search ? 'No matching notes' : 'No public notes yet'}
              </p>
              <p className="mt-1 text-[11px] text-base-content/50">
                {search
                  ? 'Try a different keyword.'
                  : 'Create your first Markdown note to get started.'}
              </p>
              {!search && (
                <button
                  type="button"
                  onClick={() => setShowNewModal(true)}
                  className="btn btn-ghost btn-xs mt-3.5 h-7 min-h-0 gap-1 rounded-md border border-base-content/14 px-2.5 text-xs font-medium"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>New Public Note</span>
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {grouped.map(([folderName, entries]) => {
                const isCollapsed = !search && collapsedFolders.has(folderName);
                const showFolderHeader =
                  grouped.length > 1 || folderName !== '(Root)';

                return (
                  <div key={folderName}>
                    {showFolderHeader && (
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
                    )}

                    {!isCollapsed && (
                      <ul className="space-y-0.5">
                        {entries.map((f) => {
                          const fileName = f.path.split('/').pop()!.replace(/\.md$/i, '');
                          const isSelected = f.path === selectedPath;
                          return (
                            <li key={f.path} className="note-list-item">
                              <button
                                type="button"
                                onClick={() => void openNote(f.path)}
                                className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition ${
                                  isSelected
                                    ? 'bg-base-content/10 text-base-content'
                                    : 'text-base-content/70 hover:bg-base-content/[0.05] hover:text-base-content'
                                }`}
                              >
                                <FileText
                                  className={`h-3.5 w-3.5 shrink-0 ${
                                    isSelected
                                      ? 'text-base-content/85'
                                      : 'text-base-content/40'
                                  }`}
                                />
                                <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                                  {fileName}
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

      {/* Main Editor/Viewer */}
      <main
        className={`min-w-0 flex-1 ${
          selectedPath ? 'block' : 'hidden md:block'
        }`}
      >
        {loadingNote ? (
          <div className="mx-auto max-w-3xl space-y-4 p-8">
            <div className="skeleton h-8 w-1/3" />
            <div className="skeleton h-4 w-full" />
            <div className="skeleton h-4 w-5/6" />
            <div className="skeleton h-4 w-2/3" />
          </div>
        ) : selectedPath ? (
          <MarkdownView
            docKey={`pub:${selectedPath}`}
            title={selectedPath.split('/').pop()!.replace(/\.md$/i, '')}
            subtitle={selectedPath}
            content={draftContent}
            onChangeContent={setDraftContent}
            onSave={handleSave}
            onDelete={handleDelete}
            onBack={() => {
              if (!confirmDiscardIfDirty()) return;
              setSelectedPath(null);
            }}
            isDirty={isDirty}
            isSaving={saving}
            isActive={isActive}
            isZen={isZen}
            onToggleZen={() => setIsZen((z) => !z)}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center p-6 text-center">
            <BookOpen className="mb-3 h-5 w-5 text-base-content/35" />
            <p className="text-sm font-medium text-base-content/85">
              Select a public note
            </p>
            <p className="mt-1 max-w-xs text-xs text-base-content/50">
              Choose a note from the sidebar, press{' '}
              <kbd className="rounded border border-base-content/15 bg-base-200 px-1 font-mono text-[10px]">
                Ctrl K
              </kbd>
              , or create a new Markdown file.
            </p>
            <button
              type="button"
              onClick={() => setShowNewModal(true)}
              className="btn btn-ghost btn-sm mt-4 h-8 min-h-0 gap-1.5 rounded-md border border-base-content/14 px-3 text-xs font-medium"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Create Note</span>
            </button>
          </div>
        )}
      </main>

      {/* Create Note Modal */}
      <Modal
        open={showNewModal}
        onClose={() => setShowNewModal(false)}
        title="Create Public Note"
        subtitle="Enter a filename or nested folder path (e.g. Journal/2026-11-22.md)."
        maxWidthClass="max-w-md"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-base-content/75">
              File Path
            </label>
            <input
              type="text"
              autoFocus
              required
              value={newPathInput}
              onChange={(e) => setNewPathInput(e.target.value)}
              placeholder="Notes/my-note.md"
              className="input h-9 w-full rounded-md border-base-content/15 bg-base-100 text-sm text-base-content placeholder:text-base-content/40 focus:border-primary/70 focus:outline-none"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowNewModal(false)}
              className="btn btn-ghost btn-sm h-8 min-h-0 rounded-md px-3 text-xs font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="btn btn-primary btn-sm h-8 min-h-0 rounded-md px-3 text-xs font-medium"
            >
              {saving ? 'Creating...' : 'Create Note'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
