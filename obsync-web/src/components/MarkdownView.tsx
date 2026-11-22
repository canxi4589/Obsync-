import { useEffect, useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { Columns2, Edit3, Eye, Save, Trash2 } from 'lucide-react';

marked.setOptions({
  breaks: true,
  gfm: true,
});

let hookRegistered = false;
function ensureDomPurifyHooks(): void {
  if (hookRegistered || typeof DOMPurify.addHook !== 'function') return;
  hookRegistered = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') ?? '';
      if (/^https?:\/\//i.test(href)) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
  });
}

interface MarkdownViewProps {
  title: string;
  subtitle?: string;
  content: string;
  onChangeContent: (next: string) => void;
  onSave: () => Promise<void>;
  onDelete?: () => Promise<void>;
  onBack?: () => void;
  isDirty: boolean;
  isSaving: boolean;
  isActive?: boolean;
  headerExtra?: React.ReactNode;
}

type ViewMode = 'preview' | 'edit' | 'split';

export function MarkdownView({
  title,
  subtitle,
  content,
  onChangeContent,
  onSave,
  onDelete,
  onBack,
  isDirty,
  isSaving,
  isActive = true,
  headerExtra,
}: MarkdownViewProps) {
  const [mode, setMode] = useState<ViewMode>('preview');

  useEffect(() => {
    if (!isActive) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (isDirty && !isSaving) {
          void onSave();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isActive, isDirty, isSaving, onSave]);

  const safeHtml = useMemo(() => {
    ensureDomPurifyHooks();
    const raw = marked.parse(content || '*Empty note*', { async: false });
    return DOMPurify.sanitize(typeof raw === 'string' ? raw : '');
  }, [content]);

  return (
    <div className="flex h-full flex-col bg-slate-950">
      {/* Header toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/70 px-3 py-2.5 sm:px-5">
        <div className="flex min-w-0 items-center gap-2">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800 md:hidden"
            >
              ← Back
            </button>
          )}
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-slate-100 sm:text-base">
              {title}
            </h2>
            {subtitle && (
              <p className="truncate text-xs text-slate-400">{subtitle}</p>
            )}
          </div>
          {headerExtra}
        </div>

        <div className="flex items-center gap-1.5">
          <div className="flex rounded-lg border border-slate-700 bg-slate-900 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setMode('preview')}
              className={`flex items-center gap-1 rounded-md px-2 py-1 ${
                mode === 'preview'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              <Eye className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Read</span>
            </button>
            <button
              type="button"
              onClick={() => setMode('edit')}
              className={`flex items-center gap-1 rounded-md px-2 py-1 ${
                mode === 'edit'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              <Edit3 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Edit</span>
            </button>
            <button
              type="button"
              onClick={() => setMode('split')}
              className={`hidden items-center gap-1 rounded-md px-2 py-1 lg:flex ${
                mode === 'split'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              <Columns2 className="h-3.5 w-3.5" />
              <span>Split</span>
            </button>
          </div>

          <button
            type="button"
            disabled={isSaving || !isDirty}
            onClick={() => void onSave()}
            className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              isDirty
                ? 'bg-indigo-600 text-white hover:bg-indigo-500'
                : 'border border-slate-700 bg-slate-900 text-slate-500'
            } disabled:opacity-50`}
          >
            <Save className="h-3.5 w-3.5" />
            <span>{isSaving ? 'Saving...' : isDirty ? 'Save' : 'Saved'}</span>
          </button>

          {onDelete && (
            <button
              type="button"
              onClick={() => void onDelete()}
              title="Delete note"
              className="rounded-lg border border-rose-900/60 bg-rose-950/30 p-1.5 text-rose-400 hover:bg-rose-900/40"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Content area */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {(mode === 'edit' || mode === 'split') && (
          <textarea
            value={content}
            onChange={(e) => onChangeContent(e.target.value)}
            placeholder="Write Markdown here..."
            spellCheck
            className={`h-full resize-none bg-slate-950 p-4 font-mono text-sm leading-relaxed text-slate-100 outline-none sm:p-6 ${
              mode === 'split'
                ? 'w-1/2 border-r border-slate-800'
                : 'w-full'
            }`}
          />
        )}

        {(mode === 'preview' || mode === 'split') && (
          <div
            className={`h-full overflow-y-auto p-4 sm:p-6 ${
              mode === 'split' ? 'w-1/2' : 'w-full'
            }`}
          >
            <article
              className="markdown-body mx-auto max-w-3xl"
              dangerouslySetInnerHTML={{ __html: safeHtml }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
