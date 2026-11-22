import {
  lazy,
  Suspense,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import {
  ArrowLeft,
  Bold,
  Check,
  CheckSquare,
  Code,
  Columns2,
  Edit3,
  Eye,
  Heading2,
  ImageOff,
  Italic,
  Link2,
  Maximize2,
  Minimize2,
  Quote,
  Save,
  Search,
  Trash2,
} from 'lucide-react';
import type { CodeMirrorEditorHandle } from './CodeMirrorEditor';

const CodeMirrorEditor = lazy(() => import('./CodeMirrorEditor'));

marked.setOptions({
  breaks: true,
  gfm: true,
});

const FORBID_TAGS = [
  'form',
  'button',
  'textarea',
  'select',
  'option',
  'style',
  'iframe',
  'object',
  'embed',
  'base',
  'meta',
  'link',
  'script',
];

const FORBID_ATTR = ['style', 'class', 'id', 'formaction', 'action', 'srcdoc'];

const SAFE_HREF_PROTOCOL = /^(https?:|mailto:|#)/i;
const EXTERNAL_URL_PATTERN = /^(https?:)?\/\//i;

let currentBlockExternalImages = false;
let blockedImageCountInRun = 0;
let hooksRegistered = false;

function ensureDomPurifyHooks(): void {
  if (hooksRegistered || typeof DOMPurify.addHook !== 'function') return;
  hooksRegistered = true;

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const tag = node.tagName;

    // Allow only read-only GFM task-list checkboxes; strip all other <input> elements
    if (tag === 'INPUT') {
      const type = (node.getAttribute('type') ?? '').toLowerCase();
      if (type !== 'checkbox') {
        node.parentNode?.removeChild(node);
        return;
      }
      node.setAttribute('disabled', '');
      node.removeAttribute('name');
      node.removeAttribute('value');
      return;
    }

    if (tag === 'A') {
      const href = (node.getAttribute('href') ?? '').trim();
      if (!href) return;

      // Handle http(s):// and protocol-relative // links safely
      if (EXTERNAL_URL_PATTERN.test(href)) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
        return;
      }

      // Allow safe mailto:, hash anchors, or relative links; strip unknown schemes
      const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href);
      if (hasScheme && !SAFE_HREF_PROTOCOL.test(href)) {
        node.removeAttribute('href');
      }
      return;
    }

    if (tag === 'IMG' && currentBlockExternalImages) {
      const src = (node.getAttribute('src') ?? '').trim();
      if (EXTERNAL_URL_PATTERN.test(src)) {
        blockedImageCountInRun++;
        node.removeAttribute('src');
        if (!node.getAttribute('alt')) {
          node.setAttribute('alt', '[External image blocked]');
        }
      }
    }
  });
}

export function sanitizeMarkdownHtml(
  markdown: string,
  opts?: { blockExternalImages?: boolean }
): { html: string; blockedImages: number } {
  ensureDomPurifyHooks();
  const raw = marked.parse(markdown || '*Empty note*', { async: false });
  const htmlInput = typeof raw === 'string' ? raw : '';

  currentBlockExternalImages = opts?.blockExternalImages ?? false;
  blockedImageCountInRun = 0;
  try {
    const html = DOMPurify.sanitize(htmlInput, {
      FORBID_TAGS,
      FORBID_ATTR,
    });
    return { html, blockedImages: blockedImageCountInRun };
  } finally {
    currentBlockExternalImages = false;
  }
}

interface MarkdownViewProps {
  docKey?: string;
  title: string;
  subtitle?: string;
  subtitleIcon?: React.ReactNode;
  content: string;
  onChangeContent: (next: string) => void;
  onSave: () => Promise<void>;
  onDelete?: () => Promise<void>;
  onBack?: () => void;
  isDirty: boolean;
  isSaving: boolean;
  isActive?: boolean;
  blockExternalImages?: boolean;
  allowExternalImagesSession?: boolean;
  onAllowExternalImagesSession?: () => void;
  isZen?: boolean;
  onToggleZen?: () => void;
  headerExtra?: React.ReactNode;
}

type ViewMode = 'preview' | 'edit' | 'split';

export function MarkdownView({
  docKey,
  title,
  subtitle,
  subtitleIcon,
  content,
  onChangeContent,
  onSave,
  onDelete,
  onBack,
  isDirty,
  isSaving,
  isActive = true,
  blockExternalImages = false,
  allowExternalImagesSession = false,
  onAllowExternalImagesSession,
  isZen = false,
  onToggleZen,
  headerExtra,
}: MarkdownViewProps) {
  const [mode, setMode] = useState<ViewMode>('preview');
  const [allowImagesOnce, setAllowImagesOnce] = useState(false);
  const [cursor, setCursor] = useState<{ line: number; col: number }>({
    line: 1,
    col: 1,
  });
  const editorRef = useRef<CodeMirrorEditorHandle | null>(null);

  const effectiveDocKey = docKey ?? subtitle ?? title;

  // Reset per-note image override when switching notes
  useEffect(() => {
    setAllowImagesOnce(false);
  }, [effectiveDocKey]);

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

  const insertFormat = (
    prefix: string,
    suffix = '',
    placeholderText = 'text'
  ) => {
    editorRef.current?.insertFormat(prefix, suffix, placeholderText);
  };

  // Defer preview parsing so typing stays responsive in split mode
  const deferredContent = useDeferredValue(content);
  const effectiveBlockImages =
    blockExternalImages && !allowImagesOnce && !allowExternalImagesSession;

  const { html: safeHtml, blockedImages } = useMemo(() => {
    if (mode === 'edit') {
      return { html: '', blockedImages: 0 };
    }
    return sanitizeMarkdownHtml(deferredContent, {
      blockExternalImages: effectiveBlockImages,
    });
  }, [mode, deferredContent, effectiveBlockImages]);

  const stats = useMemo(() => {
    const trimmed = deferredContent.trim();
    const words = trimmed ? trimmed.split(/\s+/).length : 0;
    const mins = Math.max(1, Math.ceil(words / 220));
    return { words, chars: deferredContent.length, mins };
  }, [deferredContent]);

  return (
    <div className="flex h-full flex-col bg-base-100 text-base-content">
      {/* Header toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-base-content/10 bg-base-100 px-3 py-2 sm:px-5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label="Back to notes list"
              className="btn btn-ghost btn-xs btn-square h-7 min-h-0 w-7 rounded-md border border-base-content/10 md:hidden"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h2 className="truncate text-sm font-semibold tracking-tight text-base-content">
                {title}
              </h2>
              {isDirty && (
                <span
                  title="Unsaved changes"
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
                />
              )}
              {headerExtra}
            </div>
            {subtitle && (
              <p className="flex items-center gap-1 truncate text-[11px] text-base-content/50">
                {subtitleIcon}
                <span className="truncate">{subtitle}</span>
              </p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {/* Segmented Mode Switcher (neutral surface; reserve primary accent for Save) */}
          <div
            role="tablist"
            className="inline-flex items-center rounded-md border border-base-content/10 bg-base-200 p-0.5 text-xs"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'preview'}
              onClick={() => setMode('preview')}
              className={`inline-flex h-6 items-center gap-1.5 rounded-[5px] px-2 text-xs font-medium transition ${
                mode === 'preview'
                  ? 'bg-base-100 text-base-content shadow-xs ring-1 ring-base-content/10'
                  : 'text-base-content/55 hover:text-base-content'
              }`}
            >
              <Eye className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Read</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'edit'}
              onClick={() => setMode('edit')}
              className={`inline-flex h-6 items-center gap-1.5 rounded-[5px] px-2 text-xs font-medium transition ${
                mode === 'edit'
                  ? 'bg-base-100 text-base-content shadow-xs ring-1 ring-base-content/10'
                  : 'text-base-content/55 hover:text-base-content'
              }`}
            >
              <Edit3 className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Edit</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'split'}
              onClick={() => setMode('split')}
              className={`hidden h-6 items-center gap-1.5 rounded-[5px] px-2 text-xs font-medium transition lg:inline-flex ${
                mode === 'split'
                  ? 'bg-base-100 text-base-content shadow-xs ring-1 ring-base-content/10'
                  : 'text-base-content/55 hover:text-base-content'
              }`}
            >
              <Columns2 className="h-3.5 w-3.5" />
              <span>Split</span>
            </button>
          </div>

          {onToggleZen && (
            <button
              type="button"
              onClick={onToggleZen}
              title={isZen ? 'Show sidebar' : 'Focus mode'}
              aria-label={isZen ? 'Show sidebar' : 'Focus mode'}
              className="btn btn-ghost btn-xs btn-square hidden h-7 min-h-0 w-7 rounded-md border border-base-content/10 text-base-content/60 hover:text-base-content md:inline-flex"
            >
              {isZen ? (
                <Minimize2 className="h-3.5 w-3.5" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" />
              )}
            </button>
          )}

          <button
            type="button"
            disabled={isSaving || !isDirty}
            onClick={() => void onSave()}
            className={`btn btn-xs h-7 min-h-0 gap-1.5 rounded-md px-2.5 text-xs font-medium ${
              isDirty
                ? 'btn-primary'
                : 'btn-ghost border border-base-content/10 text-base-content/50'
            }`}
          >
            {isDirty || isSaving ? (
              <Save className="h-3.5 w-3.5" />
            ) : (
              <Check className="h-3.5 w-3.5 text-success" />
            )}
            <span>{isSaving ? 'Saving...' : isDirty ? 'Save' : 'Saved'}</span>
          </button>

          {onDelete && (
            <button
              type="button"
              onClick={() => void onDelete()}
              title="Delete note"
              aria-label="Delete note"
              className="btn btn-ghost btn-xs btn-square h-7 min-h-0 w-7 rounded-md text-base-content/50 hover:bg-error/10 hover:text-error"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Quick Markdown Formatting Bar (Edit / Split mode) */}
      {(mode === 'edit' || mode === 'split') && (
        <div className="custom-scrollbar flex items-center gap-0.5 overflow-x-auto border-b border-base-content/10 bg-base-200/35 px-3 py-1 sm:px-5">
          {[
            {
              label: 'Heading',
              icon: Heading2,
              action: () => insertFormat('## ', '', 'Heading'),
            },
            {
              label: 'Bold',
              icon: Bold,
              action: () => insertFormat('**', '**', 'bold'),
            },
            {
              label: 'Italic',
              icon: Italic,
              action: () => insertFormat('*', '*', 'italic'),
            },
            {
              label: 'Code',
              icon: Code,
              action: () => insertFormat('`', '`', 'code'),
            },
            {
              label: 'Checklist',
              icon: CheckSquare,
              action: () => insertFormat('- [ ] ', '', 'Task'),
            },
            {
              label: 'Quote',
              icon: Quote,
              action: () => insertFormat('> ', '', 'Quote'),
            },
            {
              label: 'Link',
              icon: Link2,
              action: () => insertFormat('[', '](https://)', 'link text'),
            },
          ].map(({ label, icon: Icon, action }) => (
            <button
              key={label}
              type="button"
              onClick={action}
              title={label}
              aria-label={label}
              className="btn btn-ghost btn-xs h-7 min-h-0 shrink-0 gap-1 rounded-md px-2 font-normal text-base-content/60 hover:text-base-content"
            >
              <Icon className="h-3.5 w-3.5" />
              <span className="hidden xl:inline">{label}</span>
            </button>
          ))}

          <div className="mx-1 h-4 w-px shrink-0 bg-base-content/10" />

          <button
            type="button"
            onClick={() => editorRef.current?.openSearch()}
            title="Find & Replace (Ctrl+F)"
            aria-label="Find and replace"
            className="btn btn-ghost btn-xs h-7 min-h-0 shrink-0 gap-1 rounded-md px-2 font-normal text-base-content/60 hover:text-base-content"
          >
            <Search className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">Find</span>
          </button>
        </div>
      )}

      {/* Privacy Banner for Blocked External Images */}
      {blockedImages > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-warning/25 bg-warning/10 px-4 py-2 text-xs text-warning">
          <span className="flex items-center gap-2">
            <ImageOff className="h-3.5 w-3.5 shrink-0" />
            <span>
              Blocked {blockedImages} external image{blockedImages > 1 ? 's' : ''} to
              protect your privacy.
            </span>
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setAllowImagesOnce(true)}
              className="btn btn-soft btn-warning btn-xs h-7 min-h-0 rounded-md px-2.5 text-[11px]"
            >
              Load for this note
            </button>
            {onAllowExternalImagesSession && (
              <button
                type="button"
                onClick={onAllowExternalImagesSession}
                className="btn btn-outline btn-warning btn-xs h-7 min-h-0 rounded-md px-2.5 text-[11px]"
              >
                Allow for session
              </button>
            )}
          </div>
        </div>
      )}

      {/* Main CodeMirror 6 Editor / Markdown Reader Panes */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {(mode === 'edit' || mode === 'split') && (
          <div
            className={`h-full min-h-0 ${
              mode === 'split'
                ? 'w-1/2 border-r border-base-content/10'
                : 'w-full'
            }`}
          >
            <Suspense
              fallback={
                <div className="mx-auto max-w-3xl space-y-3 p-6">
                  <div className="skeleton h-6 w-1/3" />
                  <div className="skeleton h-4 w-full" />
                  <div className="skeleton h-4 w-4/5" />
                </div>
              }
            >
              <CodeMirrorEditor
                ref={editorRef}
                docKey={effectiveDocKey}
                value={content}
                onChange={onChangeContent}
                onSave={() => {
                  if (isDirty && !isSaving) void onSave();
                }}
                onCursorChange={setCursor}
                centered={mode === 'edit'}
              />
            </Suspense>
          </div>
        )}

        {(mode === 'preview' || mode === 'split') && (
          <div
            className={`custom-scrollbar h-full overflow-y-auto px-4 py-5 sm:px-8 sm:py-7 ${
              mode === 'split' ? 'w-1/2' : 'w-full'
            }`}
          >
            <article
              className="markdown-body mx-auto max-w-3xl pb-16"
              dangerouslySetInnerHTML={{ __html: safeHtml }}
            />
          </div>
        )}
      </div>

      {/* Subtle Status Footer */}
      <footer className="flex items-center justify-between gap-2 border-t border-base-content/10 bg-base-100 px-4 py-1.5 text-[11px] tabular-nums text-base-content/50">
        <div className="flex items-center gap-3">
          {(mode === 'edit' || mode === 'split') && (
            <span className="font-mono text-[10.5px] text-base-content/60">
              Ln {cursor.line}, Col {cursor.col}
            </span>
          )}
          <span>
            {stats.words.toLocaleString()} {stats.words === 1 ? 'word' : 'words'}
          </span>
          <span className="hidden sm:inline">
            {stats.chars.toLocaleString()} chars
          </span>
          <span>~{stats.mins} min read</span>
        </div>
        <div className="flex items-center gap-2">
          {isDirty ? (
            <span className="text-warning">
              Unsaved changes <span className="hidden md:inline">· Ctrl+S</span>
            </span>
          ) : (
            <span>Saved</span>
          )}
        </div>
      </footer>
    </div>
  );
}
