import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FileText,
  Folder,
  Plus,
  RefreshCw,
  Search,
  Settings,
} from 'lucide-react';
import { bytesToUtf8, utf8ToBytes } from '../crypto/base64';
import { validatePublicNotePath } from '../storage/pathUtils';
import type { StorageManager } from '../storage/storageManager';
import type { FileEntry } from '../storage/types';
import { MarkdownView } from './MarkdownView';

interface PublicNotesViewProps {
  storage: StorageManager;
  primaryKey: string;
  isActive: boolean;
  hasProviders: boolean;
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
  onSourceChange,
  onDirtyChange,
  onToast,
  onOpenSettings,
}: PublicNotesViewProps) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [savedContent, setSavedContent] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [showNewModal, setShowNewModal] = useState(false);
  const [newPathInput, setNewPathInput] = useState('');

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

  const confirmDiscardIfDirty = (): boolean => {
    if (!isDirty) return true;
    return window.confirm('You have unsaved changes. Discard them?');
  };

  useEffect(() => {
    setSelectedPath(null);
    setSavedContent('');
    setDraftContent('');
    void refreshList();
  }, [primaryKey, refreshList]);

  const openNote = async (path: string) => {
    if (path === selectedPath) return;
    if (!confirmDiscardIfDirty()) return;
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
    }
  };

  const handleSave = async () => {
    if (!selectedPath) return;
    setSaving(true);
    try {
      const summary = await storage.write(
        selectedPath,
        utf8ToBytes(draftContent),
        `Update ${selectedPath}`
      );
      setSavedContent(draftContent);
      const mirrorMsg =
        summary.queuedFor.length > 0
          ? `Saved to ${summary.primaryWrittenLabel} (${summary.queuedFor.length} fallback queued)`
          : `Saved to ${summary.primaryWrittenLabel}`;
      onToast(mirrorMsg);
      await refreshList();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Save failed.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedPath) return;
    if (!window.confirm(`Delete "${selectedPath}"?`)) return;
    try {
      await storage.delete(selectedPath, `Delete ${selectedPath}`);
      onToast(`Deleted ${selectedPath}`);
      setSelectedPath(null);
      await refreshList();
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
      await storage.write(clean, utf8ToBytes(initial), `Create ${clean}`);
      setShowNewModal(false);
      setNewPathInput('');
      setSelectedPath(clean);
      setSavedContent(initial);
      setDraftContent(initial);
      await refreshList();
      onToast(`Created ${clean}`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Create failed.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q
      ? files.filter((f) => f.path.toLowerCase().includes(q))
      : files;
  }, [files, search]);

  if (!hasProviders) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <div className="max-w-md rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <Settings className="mx-auto mb-3 h-10 w-10 text-indigo-400" />
          <h2 className="text-lg font-semibold text-slate-100">
            Connect a Storage Provider
          </h2>
          <p className="mt-2 text-sm text-slate-400">
            Add GitHub, Google Drive, a Local Folder, or S3/R2 in Settings to
            browse and edit your Obsidian notes from Windows and iPhone.
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

  return (
    <div className="flex h-full min-h-0">
      {/* Sidebar list */}
      <aside
        className={`flex w-full flex-col border-r border-slate-800 bg-slate-900/40 md:w-72 lg:w-80 ${
          selectedPath ? 'hidden md:flex' : 'flex'
        }`}
      >
        <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-3 py-2.5">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
            Public Notes ({filtered.length})
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void refreshList()}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
              title="Refresh list"
            >
              <RefreshCw
                className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`}
              />
            </button>
            <button
              type="button"
              onClick={() => setShowNewModal(true)}
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
              placeholder="Search public notes..."
              className="w-full bg-transparent text-sm text-slate-100 placeholder-slate-500 outline-none"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <p className="p-4 text-center text-xs text-slate-500">
              {loading ? 'Loading notes...' : 'No Markdown notes found.'}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {filtered.map((f) => {
                const parts = f.path.split('/');
                const fileName = parts.pop()!;
                const folder = parts.join('/');
                const isActive = f.path === selectedPath;
                return (
                  <li key={f.path}>
                    <button
                      type="button"
                      onClick={() => void openNote(f.path)}
                      className={`flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition ${
                        isActive
                          ? 'bg-indigo-600/20 text-indigo-200 ring-1 ring-indigo-500/40'
                          : 'text-slate-300 hover:bg-slate-800/60'
                      }`}
                    >
                      <FileText className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">
                          {fileName}
                        </div>
                        {folder && (
                          <div className="flex items-center gap-1 truncate text-xs text-slate-500">
                            <Folder className="h-3 w-3 shrink-0" />
                            <span className="truncate">{folder}</span>
                          </div>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* Main Editor/Viewer */}
      <main
        className={`min-w-0 flex-1 ${
          selectedPath ? 'block' : 'hidden md:block'
        }`}
      >
        {selectedPath ? (
          <MarkdownView
            title={selectedPath.split('/').pop()!}
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
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-slate-500">
            Select a note from the sidebar or create a new one.
          </div>
        )}
      </main>

      {/* Create Note Modal */}
      {showNewModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <form
            onSubmit={handleCreate}
            className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-xl"
          >
            <h3 className="text-base font-semibold text-slate-100">
              Create Public Note
            </h3>
            <p className="mt-1 text-xs text-slate-400">
              Enter a filename or relative path (e.g.{' '}
              <code className="text-indigo-300">Journal/2026-11-22.md</code>).
            </p>
            <input
              type="text"
              autoFocus
              required
              value={newPathInput}
              onChange={(e) => setNewPathInput(e.target.value)}
              placeholder="Notes/my-note.md"
              className="mt-3 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-indigo-500"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowNewModal(false)}
                className="rounded-xl border border-slate-700 px-3.5 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving}
                className="rounded-xl bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                Create
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
