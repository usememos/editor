import * as core from '@editor/core';
import { Editor, footnotes, math } from '@editor/core';
import '../packages/core/src/style.css';
import { SAMPLE } from './sample';

const output = document.getElementById('output')!;
const params = new URLSearchParams(location.search);

// ?dialect=memos: the Markdown dialect memos uses.
const memos = params.get('dialect') === 'memos';

const editor = new Editor({
  element: document.getElementById('editor')!,
  ...(memos ? { markdown: { breaks: true, setext: false }, extensions: [math(), footnotes()] } : {}),
  content: params.has('empty') ? '' : (params.get('md') ?? SAMPLE),
  placeholder: 'Write something, or type / for commands…',
  autofocus: params.has('focus'),
  onChange: (md) => (output.textContent = md),
  onSubmit: () => (document.body.dataset.submitted = String(Number(document.body.dataset.submitted ?? 0) + 1)),
});
output.textContent = editor.getMarkdown();
(window as unknown as { editor: Editor }).editor = editor;
// Tests build their own editors with custom extensions from this.
(window as unknown as { core: typeof core }).core = core;
