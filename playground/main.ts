import { Editor } from '../packages/core/src/index';
import '../packages/core/src/style.css';

const output = document.getElementById('output')!;
const initial = `# Welcome

This is a **prototype** of the block editor. Try *typing*, Enter, Backspace, \`code\`, and ~~strike~~.

Type "## " at the start of a line to make a heading.
`;

const editor = new Editor(document.getElementById('editor')!, {
  value: new URLSearchParams(location.search).has('empty') ? '' : initial,
  placeholder: "Write something…",
  onChange: (md) => (output.textContent = md),
});
output.textContent = editor.getMarkdown();
(window as unknown as { editor: Editor }).editor = editor;
