import { MarkdownEditor } from '@editor/react';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../packages/core/src/style.css';

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

createRoot(document.getElementById('app')!).render(<CommentBox />);
