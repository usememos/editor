import { EditorContent, MarkdownEditor, useEditor } from '@usememos/editor/react';
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

const demo = new URLSearchParams(location.search).get('demo');
createRoot(document.getElementById('app')!).render(demo === 'api' ? <ApiDemo /> : <CommentBox />);
