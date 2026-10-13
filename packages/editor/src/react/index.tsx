import { Editor, type EditorOptions, type SuggestionState } from '@usememos/editor';
import { type CSSProperties, type ForwardedRef, forwardRef, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

export type { Editor, SuggestionState } from '@usememos/editor';

/** Constructor options that the React components take as props. */
type EditorProps = Pick<
  EditorOptions,
  | 'markdown'
  | 'extensions'
  | 'placeholder'
  | 'editable'
  | 'taskToggle'
  | 'autofocus'
  | 'attributes'
  | 'resolveImageSrc'
  | 'theme'
  | 'toolbar'
  | 'slashMenu'
  | 'labels'
  | 'icons'
>;

export interface MarkdownEditorProps extends EditorProps {
  /** Markdown. The editor updates only when this is not a value it emitted itself. */
  value?: string;
  /** Initial Markdown for uncontrolled use. */
  defaultValue?: string;
  /** Called after document changes, at most once per animation frame. */
  onChange?: (markdown: string) => void;
  /** Called on Mod+Enter or Ctrl+Enter with the current Markdown. */
  onSubmit?: (markdown: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  className?: string;
  style?: CSSProperties;
}

/** Options that `setOptions` applies without recreating the editor. `extensions` updates suggestion callbacks only. */
const LIVE = ['placeholder', 'editable', 'taskToggle', 'attributes', 'resolveImageSrc', 'theme', 'extensions'] as const;

/** The extension list's identity for recreating the editor: names, so an inline array does not recreate it on every render. */
const extensionKey = (extensions: EditorOptions['extensions']) => (extensions ?? []).map((e) => e.name).join('\n');

/**
 * The editor as a controlled React component. A `ref` gives the core `Editor`.
 *
 * `placeholder`, `editable`, `taskToggle`, `attributes`, `resolveImageSrc` and `theme` update live.
 * A change to the names in `extensions` recreates the editor, keeping its
 * Markdown; with the same names, the callbacks of `suggestion()` extensions
 * (`items`, `command`, `match`, `allow`) update live. Other props are read
 * when the editor is created; change the component's `key` to apply new values.
 *
 * A `value` that arrives while an input method is composing text is applied
 * when the composition ends, so it does not break the composition.
 */
export const MarkdownEditor = forwardRef(function MarkdownEditor(props: MarkdownEditorProps, ref: ForwardedRef<Editor | null>) {
  const container = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  // Values the editor emitted that the parent has not passed back yet, oldest
  // first. While the user keeps typing, React may hand back an older one;
  // those echoes must not reset the document.
  const pending = useRef<string[]>([]);
  // An outside value that arrived during IME composition.
  const deferred = useRef<string | null>(null);
  // Callbacks are read through a ref so changing them does not recreate the editor.
  const latest = useRef(props);
  latest.current = props;
  const extensions = extensionKey(props.extensions);

  useEffect(() => {
    const { value, defaultValue, onChange, onSubmit, onFocus, onBlur, className, style, ...options } = latest.current;
    const previous = editorRef.current;
    const editor = new Editor({
      ...options,
      element: container.current!,
      content: previous?.getMarkdown() ?? value ?? defaultValue ?? '',
      onChange: (markdown) => {
        pending.current.push(markdown);
        if (pending.current.length > 100) pending.current.shift();
        // Render the parent's update now, as React does for a native input's
        // onChange. Left to React's scheduler, it can still be waiting when
        // the parent sets a new value (clearing the box on submit) that equals
        // the value it last rendered; the value effect would then not run.
        flushSync(() => latest.current.onChange?.(markdown));
      },
      onSubmit: (markdown) => latest.current.onSubmit?.(markdown),
      onFocus: () => latest.current.onFocus?.(),
      onBlur: () => latest.current.onBlur?.(),
    });
    editorRef.current = editor;
    pending.current = [];
    assignRef(ref, editor);
    const root = container.current!;
    const onCompositionEnd = () => {
      // Runs after the editor's own compositionend handler, which was added first.
      const value = deferred.current;
      deferred.current = null;
      if (value !== null && value !== editor.getMarkdown()) {
        pending.current = [];
        editor.setMarkdown(value);
      }
    };
    root.addEventListener('compositionend', onCompositionEnd);
    return () => {
      root.removeEventListener('compositionend', onCompositionEnd);
      editor.destroy();
      if (editorRef.current === editor) editorRef.current = null;
      assignRef(ref, null);
    };
    // Recreate only when the extension names change; see the note on the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extensions]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || props.value === undefined) return;
    const echo = pending.current.indexOf(props.value);
    if (echo >= 0) {
      // The parent caught up to a value the editor emitted.
      pending.current.splice(0, echo + 1);
      return;
    }
    if (props.value === editor.getMarkdown()) return;
    if (editor.isComposing) {
      deferred.current = props.value;
      return;
    }
    pending.current = [];
    editor.setMarkdown(props.value);
  }, [props.value]);

  useLiveOptions(editorRef, props);

  return <div ref={container} className={props.className} style={props.style} />;
});

/** Applies the live options when they change. */
function useLiveOptions(editorRef: { current: Editor | null }, props: EditorProps): void {
  const applied = useRef<{ editor: Editor | null; props: Partial<EditorProps> }>({ editor: null, props: {} });
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (applied.current.editor !== editor) {
      // A new editor was created with these props.
      applied.current = { editor, props: { ...props } };
      return;
    }
    const changed: Partial<Pick<EditorOptions, (typeof LIVE)[number]>> = {};
    let any = false;
    for (const key of LIVE) {
      if (props[key] === applied.current.props[key]) continue;
      (changed as Record<string, unknown>)[key] = key === 'editable' ? (props.editable ?? true) : key === 'taskToggle' ? (props.taskToggle ?? false) : props[key];
      any = true;
    }
    applied.current = { editor, props: { ...props } };
    if (any) editor.setOptions(changed);
  });
}

/**
 * Creates an editor for the lifetime of the component, or until a value in
 * `deps` changes. Returns null until the editor exists. Pair it with
 * `<EditorContent editor={editor} />`, which shows it.
 *
 * Callbacks in `options` are read when called, so they may change between
 * renders without recreating the editor. So do the callbacks of
 * `suggestion()` extensions, matched by name.
 */
export function useEditor(options: Omit<EditorOptions, 'element'>, deps: readonly unknown[] = []): Editor | null {
  const [editor, setEditor] = useState<Editor | null>(null);
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    if (editor && options.extensions) editor.setOptions({ extensions: options.extensions });
  }, [editor, options.extensions]);

  useEffect(() => {
    const o = latest.current;
    const element = document.createElement('div');
    const instance = new Editor({
      ...o,
      element,
      // A detached element cannot take focus; EditorContent focuses once mounted.
      autofocus: false,
      onChange: (markdown, e) => latest.current.onChange?.(markdown, e),
      onSubmit: (markdown, e) => latest.current.onSubmit?.(markdown, e),
      onFocus: (e) => latest.current.onFocus?.(e),
      onBlur: (e) => latest.current.onBlur?.(e),
    });
    if (o.autofocus) pendingAutofocus.set(instance, o.autofocus === 'end' ? 'end' : 'start');
    setEditor(instance);
    return () => {
      instance.destroy();
      setEditor(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return editor;
}

/**
 * The open autocomplete popup of `editor`, or of its suggestion `name`, and
 * a re-render on each change. With `render: false` on a suggestion, draw your
 * own popup from it: put it at `state.anchorRect()`, give the listbox
 * `id={state.listboxId}` and each option `id={state.optionId(i)}`, highlight
 * `state.active`, and call `editor.suggestion.accept(i)` on click.
 */
export function useSuggestion(editor: Editor | null, name?: string): SuggestionState | null {
  const select = (state: SuggestionState | null | undefined) => (state && (name === undefined || state.name === name) ? state : null);
  const [state, setState] = useState<SuggestionState | null>(() => select(editor?.suggestion.state));
  useEffect(() => {
    if (!editor) {
      setState(null);
      return;
    }
    setState(select(editor.suggestion.state));
    return editor.on('suggestionChange', ({ state }) => setState(select(state)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, name]);
  return state;
}

export interface EditorContentProps {
  editor: Editor | null;
  className?: string;
  style?: CSSProperties;
}

/** Shows an editor created with `useEditor`. */
export function EditorContent({ editor, className, style }: EditorContentProps) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = container.current;
    if (!editor || !host) return;
    host.appendChild(editor.root);
    const autofocus = pendingAutofocus.get(editor);
    if (autofocus) {
      pendingAutofocus.delete(editor);
      editor.commands.focus(autofocus);
    }
    return () => {
      if (editor.root.parentNode === host) host.removeChild(editor.root);
    };
  }, [editor]);
  return <div ref={container} className={className} style={style} />;
}

/** Where to focus an editor from `useEditor` once `EditorContent` mounts it. */
const pendingAutofocus = new WeakMap<Editor, 'start' | 'end'>();

function assignRef<T>(ref: ForwardedRef<T>, value: T): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}
