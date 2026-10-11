import { Editor, type EditorOptions } from '@editor/core';
import { type CSSProperties, type ForwardedRef, forwardRef, useEffect, useRef } from 'react';

export type { Editor } from '@editor/core';

export interface MarkdownEditorProps
  extends Pick<EditorOptions, 'placeholder' | 'readOnly' | 'autoFocus' | 'toolbar' | 'slashItems' | 'labels'> {
  /** Markdown. The editor updates only when this is not a value it emitted itself. */
  value?: string;
  /** Initial Markdown for uncontrolled use. */
  defaultValue?: string;
  /** Called after document changes, at most once per animation frame. */
  onChange?: (markdown: string) => void;
  /** Called on Mod+Enter with the current Markdown. */
  onSubmit?: (markdown: string) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  className?: string;
  style?: CSSProperties;
}

/**
 * The editor as a React component. A `ref` gives the core `Editor` instance.
 *
 * `placeholder`, `toolbar`, `slashItems` and `labels` are read when the editor
 * mounts. Change the component's `key` to apply new values.
 */
export const MarkdownEditor = forwardRef(function MarkdownEditor(
  props: MarkdownEditorProps,
  ref: ForwardedRef<Editor | null>,
) {
  const container = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  // Values the editor emitted that the parent has not passed back yet, oldest
  // first. While the user keeps typing, React may hand back an older one;
  // those echoes must not reset the document.
  const pending = useRef<string[]>([]);
  // Callbacks are read through a ref so changing them does not remount the editor.
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const p = latest.current;
    const editor = new Editor(container.current!, {
      value: p.value ?? p.defaultValue ?? '',
      placeholder: p.placeholder,
      readOnly: p.readOnly,
      autoFocus: p.autoFocus,
      toolbar: p.toolbar,
      slashItems: p.slashItems,
      labels: p.labels,
      onChange: (markdown) => {
        pending.current.push(markdown);
        if (pending.current.length > 100) pending.current.shift();
        latest.current.onChange?.(markdown);
      },
      onSubmit: (markdown) => latest.current.onSubmit?.(markdown),
      onFocus: () => latest.current.onFocus?.(),
      onBlur: () => latest.current.onBlur?.(),
    });
    editorRef.current = editor;
    pending.current = [];
    assignRef(ref, editor);
    return () => {
      editor.destroy();
      editorRef.current = null;
      assignRef(ref, null);
    };
    // Mount once; see the note on the component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    pending.current = [];
    editor.setMarkdown(props.value);
  }, [props.value]);

  useEffect(() => {
    editorRef.current?.setReadOnly(!!props.readOnly);
  }, [props.readOnly]);

  return <div ref={container} className={props.className} style={props.style} />;
});

function assignRef<T>(ref: ForwardedRef<T>, value: T): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}
