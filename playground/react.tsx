import { suggestion } from '@usememos/editor';
import { EditorContent, MarkdownEditor, useEditor, useSuggestion } from '@usememos/editor/react';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../packages/editor/src/style.css';

/** A comment box: the use case from the spec. Mod+Enter posts. */
function CommentBox() {
  const [value, setValue] = useState('');
  const [posted, setPosted] = useState<string[]>([]);
  const post = (markdown = value) => {
    if (!markdown.trim()) return;
    setPosted((p) => [...p, markdown]);
    setValue('');
  };
  return (
    <>
      <div className="comment">
        <MarkdownEditor value={value} onChange={setValue} onSubmit={post} placeholder="Leave a comment…" />
      </div>
      <div className="row">
        <span>Markdown is the stored value. ⌘/Ctrl+Enter to post.</span>
        <button onClick={() => post()}>Comment</button>
      </div>
      <ul id="posted">
        {posted.map((p, i) => (
          <li key={i}>{p}</li>
        ))}
      </ul>
    </>
  );
}

/** ?demo=api: live props, outside values, and useEditor. Used by the browser tests. */
function ApiDemo() {
  const [value, setValue] = useState('start');
  const [placeholder, setPlaceholder] = useState('First placeholder');
  const [editable, setEditable] = useState(true);
  const [hookOutput, setHookOutput] = useState('');
  const editor = useEditor({ content: '# From useEditor', autofocus: 'end', onChange: setHookOutput });
  return (
    <>
      <div className="comment" id="controlled">
        <MarkdownEditor value={value} onChange={setValue} placeholder={placeholder} editable={editable} />
      </div>
      <div className="row">
        <button id="set-outside" onClick={() => setValue('from outside')}>Set value</button>
        <button id="clear" onClick={() => setValue('')}>Clear</button>
        <button id="placeholder" onClick={() => setPlaceholder('Second placeholder')}>Placeholder</button>
        <button id="editable" onClick={() => setEditable((e) => !e)}>Editable</button>
      </div>
      <pre id="value">{value}</pre>
      <div className="comment" id="hook">
        <EditorContent editor={editor} />
      </div>
      <pre id="hook-output">{hookOutput}</pre>
    </>
  );
}

/**
 * ?demo=suggest: an @mention popup drawn by the app (`render: false`) with
 * useSuggestion, and items that change while the editor runs. Used by the
 * browser tests.
 */
function SuggestDemo() {
  const [people, setPeople] = useState(['Ada Lovelace', 'Alan Turing']);
  const editor = useEditor({
    content: '',
    extensions: [
      suggestion({
        name: 'people',
        trigger: '@',
        render: false,
        items: ({ query }) =>
          people
            .filter((p) => p.toLowerCase().includes(query.toLowerCase()))
            .map((p) => ({ id: p.split(' ')[0]!.toLowerCase(), label: p })),
      }),
    ],
  });
  const state = useSuggestion(editor, 'people');
  const rect = state?.anchorRect();
  return (
    <>
      <div className="comment" id="suggest">
        <EditorContent editor={editor} />
      </div>
      <div className="row">
        <button id="add-person" onClick={() => setPeople((p) => [...p, 'Grace Hopper'])}>
          Add Grace Hopper
        </button>
      </div>
      {state && rect && state.items.length > 0 && (
        <ul
          id={state.listboxId}
          className="people-popup"
          role="listbox"
          aria-label="People"
          style={{ position: 'fixed', left: rect.left, top: rect.bottom + 4, margin: 0, padding: 4, listStyle: 'none', background: 'Canvas', border: '1px solid GrayText', borderRadius: 8 }}
          onMouseDown={(e) => e.preventDefault()}
        >
          {state.items.map((item, i) => (
            <li
              key={item.id}
              id={state.optionId(i)}
              role="option"
              aria-selected={i === state.active}
              style={{ padding: '2px 8px', borderRadius: 4, background: i === state.active ? 'Highlight' : undefined }}
              onClick={() => editor?.suggestion.accept(i)}
            >
              {item.label}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

const demo = new URLSearchParams(location.search).get('demo');
createRoot(document.getElementById('app')!).render(demo === 'api' ? <ApiDemo /> : demo === 'suggest' ? <SuggestDemo /> : <CommentBox />);
