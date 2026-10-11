import { Editor } from '@editor/core';
import '../packages/core/src/style.css';
import { SAMPLE } from './sample';

const output = document.getElementById('output')!;
const params = new URLSearchParams(location.search);

const editor = new Editor(document.getElementById('editor')!, {
  value: params.has('empty') ? '' : (params.get('md') ?? SAMPLE),
  placeholder: 'Write something, or type / for commands…',
  autoFocus: params.has('focus'),
  onChange: (md) => (output.textContent = md),
  onSubmit: () => (document.body.dataset.submitted = String(Number(document.body.dataset.submitted ?? 0) + 1)),
});
output.textContent = editor.getMarkdown();
(window as unknown as { editor: Editor }).editor = editor;
