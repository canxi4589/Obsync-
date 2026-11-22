import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import {
  bracketMatching,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { openSearchPanel, search, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  placeholder as cmPlaceholder,
  type ViewUpdate,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { GFM } from '@lezer/markdown';

export interface CodeMirrorEditorHandle {
  insertFormat: (prefix: string, suffix?: string, fallbackText?: string) => void;
  openSearch: () => void;
  focus: () => void;
}

interface CodeMirrorEditorProps {
  docKey: string;
  value: string;
  onChange: (next: string) => void;
  onSave?: () => void;
  onCursorChange?: (cursor: { line: number; col: number }) => void;
  placeholderText?: string;
  className?: string;
  centered?: boolean;
}

const obsyncHighlightStyle = HighlightStyle.define([
  {
    tag: [tags.heading1, tags.heading2, tags.heading3, tags.heading4, tags.heading5, tags.heading6],
    color: 'var(--color-base-content)',
    fontWeight: '650',
  },
  { tag: tags.heading1, fontSize: '1.3em' },
  { tag: tags.heading2, fontSize: '1.16em' },
  { tag: tags.heading3, fontSize: '1.06em' },
  { tag: tags.strong, fontWeight: '650', color: 'var(--color-base-content)' },
  {
    tag: tags.emphasis,
    fontStyle: 'italic',
    color: 'color-mix(in oklch, var(--color-base-content) 84%, transparent)',
  },
  { tag: tags.strikethrough, textDecoration: 'line-through', opacity: '0.55' },
  {
    tag: [tags.monospace, tags.labelName],
    color: 'color-mix(in oklch, var(--color-base-content) 90%, transparent)',
    backgroundColor: 'var(--color-base-200)',
    borderRadius: '4px',
    padding: '0 3px',
  },
  {
    tag: tags.quote,
    color: 'color-mix(in oklch, var(--color-base-content) 65%, transparent)',
    fontStyle: 'italic',
  },
  { tag: [tags.link, tags.url], color: 'var(--color-primary)', textDecoration: 'underline' },
  {
    tag: [tags.list, tags.processingInstruction, tags.meta],
    color: 'color-mix(in oklch, var(--color-base-content) 42%, transparent)',
  },
  { tag: tags.contentSeparator, color: 'color-mix(in oklch, var(--color-base-content) 26%, transparent)' },
  { tag: tags.comment, color: 'color-mix(in oklch, var(--color-base-content) 42%, transparent)' },
]);

function buildObsyncTheme(centered: boolean): Extension {
  return EditorView.theme({
    '&': {
      fontSize: '14px',
      height: '100%',
      backgroundColor: 'var(--color-base-100)',
      color: 'var(--color-base-content)',
    },
    '.cm-scroller': {
      fontFamily:
        "ui-monospace, 'SFMono-Regular', 'Cascadia Code', 'JetBrains Mono', Menlo, Monaco, Consolas, monospace",
      lineHeight: '1.75',
      padding: centered ? '1.5rem 1rem 4rem' : '1.25rem 1.25rem 4rem',
    },
    '.cm-content': {
      caretColor: 'var(--color-primary)',
      maxWidth: centered ? '48rem' : 'none',
      margin: centered ? '0 auto' : '0',
      padding: '0.25rem 0',
    },
    '.cm-line': {
      padding: '0 4px',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--color-primary)',
      borderLeftWidth: '2px',
    },
    '.cm-activeLine': {
      backgroundColor: 'color-mix(in oklch, var(--color-base-content) 3.5%, transparent)',
      borderRadius: '4px',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'color-mix(in oklch, var(--color-primary) 24%, transparent) !important',
    },
    '.cm-selectionMatch': {
      backgroundColor: 'color-mix(in oklch, var(--color-base-content) 14%, transparent)',
      borderRadius: '3px',
    },
    '.cm-placeholder': {
      color: 'color-mix(in oklch, var(--color-base-content) 36%, transparent)',
    },
    '.cm-matchingBracket': {
      backgroundColor: 'color-mix(in oklch, var(--color-base-content) 14%, transparent)',
      outline: '1px solid color-mix(in oklch, var(--color-base-content) 28%, transparent)',
      borderRadius: '3px',
    },
  });
}

function wrapSelectionInView(
  view: EditorView,
  prefix: string,
  suffix = '',
  fallbackText = 'text'
): boolean {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to) || fallbackText;
  const insert = `${prefix}${selected}${suffix}`;
  const anchor = from + prefix.length;
  const head = anchor + selected.length;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor, head },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

const CodeMirrorEditor = forwardRef<CodeMirrorEditorHandle, CodeMirrorEditorProps>(
  function CodeMirrorEditor(
    {
      docKey,
      value,
      onChange,
      onSave,
      onCursorChange,
      placeholderText = 'Start writing in Markdown...',
      className = '',
      centered = false,
    },
    ref
  ) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    const onSaveRef = useRef(onSave);
    const onCursorRef = useRef(onCursorChange);
    const initialValueRef = useRef(value);
    const lastDocKeyRef = useRef(docKey);

    onChangeRef.current = onChange;
    onSaveRef.current = onSave;
    onCursorRef.current = onCursorChange;
    initialValueRef.current = value;

    const createExtensions = (isCentered: boolean): Extension[] => [
      history(),
      drawSelection(),
      highlightActiveLine(),
      bracketMatching(),
      indentOnInput(),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of({ spellcheck: 'true' }),
      markdown({ base: markdownLanguage, extensions: [GFM] }),
      syntaxHighlighting(obsyncHighlightStyle),
      buildObsyncTheme(isCentered),
      search({ top: true }),
      cmPlaceholder(placeholderText),
      keymap.of([
        {
          key: 'Mod-s',
          preventDefault: true,
          run: () => {
            onSaveRef.current?.();
            return true;
          },
        },
        {
          key: 'Mod-b',
          preventDefault: true,
          run: (view) => wrapSelectionInView(view, '**', '**', 'bold'),
        },
        {
          key: 'Mod-i',
          preventDefault: true,
          run: (view) => wrapSelectionInView(view, '*', '*', 'italic'),
        },
        {
          key: 'Mod-e',
          preventDefault: true,
          run: (view) => wrapSelectionInView(view, '`', '`', 'code'),
        },
        ...searchKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of((update: ViewUpdate) => {
        if (update.docChanged) {
          onChangeRef.current(update.state.doc.toString());
        }
        if (update.selectionSet || update.docChanged) {
          const head = update.state.selection.main.head;
          const line = update.state.doc.lineAt(head);
          onCursorRef.current?.({
            line: line.number,
            col: head - line.from + 1,
          });
        }
      }),
    ];

    useEffect(() => {
      const parent = hostRef.current;
      if (!parent) return;

      const state = EditorState.create({
        doc: initialValueRef.current,
        extensions: createExtensions(centered),
      });

      const view = new EditorView({ state, parent });
      viewRef.current = view;
      lastDocKeyRef.current = docKey;

      const line = state.doc.lineAt(state.selection.main.head);
      onCursorRef.current?.({ line: line.number, col: 1 });

      return () => {
        view.destroy();
        viewRef.current = null;
      };
      // Recreate cleanly when layout centering changes (split vs full edit)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [centered]);

    // Reset EditorState when switching notes so Undo history stays per-note
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      if (lastDocKeyRef.current !== docKey) {
        lastDocKeyRef.current = docKey;
        const nextState = EditorState.create({
          doc: value,
          extensions: createExtensions(centered),
        });
        view.setState(nextState);
        onCursorRef.current?.({ line: 1, col: 1 });
        return;
      }

      const currentDoc = view.state.doc.toString();
      if (value !== currentDoc) {
        view.dispatch({
          changes: { from: 0, to: currentDoc.length, insert: value },
        });
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [docKey, value]);

    useImperativeHandle(ref, () => ({
      insertFormat(prefix: string, suffix = '', fallbackText = 'text') {
        const view = viewRef.current;
        if (!view) return;
        wrapSelectionInView(view, prefix, suffix, fallbackText);
      },
      openSearch() {
        const view = viewRef.current;
        if (!view) return;
        openSearchPanel(view);
      },
      focus() {
        viewRef.current?.focus();
      },
    }));

    return (
      <div
        ref={hostRef}
        className={`cm-obsync-host ${className}`}
        data-testid="codemirror-editor"
      />
    );
  }
);

export default CodeMirrorEditor;
