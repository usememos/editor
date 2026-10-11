// A memos-style composer built only on the public API: the memos dialect,
// #tag autocomplete and highlighting, a formatting bar with active state,
// upload placeholders for pasted and dropped images, caret restore, submit.

import {
  Editor,
  type SelectionJSON,
  fileHandler,
  footnotes,
  math,
  suggestion,
  textDecorator,
} from '@editor/core';
import '../packages/core/src/style.css';

const TAGS = ['work', 'work/meeting', 'work/project', 'reading', 'ideas', 'journal', '日记'];
const DRAFT_KEY = 'mbe-memos-draft';
const CARET_KEY = 'mbe-memos-caret';

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage may be unavailable; the draft just is not kept.
  }
};

const output = document.getElementById('output')!;
const memos = document.getElementById('memos')!;

/** A fake upload: progress over about two seconds, then a URL. */
function upload(file: File, onProgress: (p: number) => void): Promise<string> {
  return new Promise((resolve) => {
    let p = 0;
    const timer = setInterval(() => {
      p += 0.1;
      onProgress(Math.min(p, 1));
      if (p >= 1) {
        clearInterval(timer);
        resolve(URL.createObjectURL(file));
      }
    }, 200);
  });
}

/** Shows an upload placeholder after the block at `at`, then inserts the image there. */
function uploadInline(editor: Editor, file: File, at: Parameters<Editor['addWidget']>[0]['at']) {
  let progress = 0;
  const widget = editor.addWidget({
    at,
    render: (el) => {
      el.innerHTML = `<div class="upload">Uploading ${file.name} <progress max="1" value="${progress}"></progress></div>`;
    },
  });
  void upload(file, (p) => {
    progress = p;
    widget.update();
  }).then((url) => {
    if (widget.isRemoved) return;
    editor.commands.insertMarkdown(`![${file.name}](${url})`, { at: widget, select: 'keep' });
    widget.remove();
  });
}

const editor = new Editor({
  element: document.getElementById('editor')!,
  content: read(DRAFT_KEY) ?? '',
  markdown: { breaks: true, setext: false },
  placeholder: 'Any thoughts…',
  attributes: { autocorrect: 'on', autocapitalize: 'sentences', 'aria-label': 'Memo' },
  extensions: [
    math(),
    footnotes(),
    textDecorator({ name: 'tags', pattern: /#[\p{L}\p{N}_/-]+/u, class: 'tag' }),
    textDecorator({ name: 'mentions', pattern: /@[\w.-]+/, class: 'mention' }),
    suggestion({
      name: 'tags',
      char: '#',
      items: ({ query }) =>
        TAGS.filter((t) => t.toLowerCase().includes(query.toLowerCase()))
          .slice(0, 8)
          .map((t) => ({ id: t, label: `#${t}` })),
      command: ({ editor, range, item }) => editor.commands.insertText(`#${item.id} `, { range }),
    }),
    fileHandler({
      accept: ['image/*'],
      onPaste: ({ editor, files }) => {
        for (const file of files) uploadInline(editor, file, editor.getSelection().focus);
      },
      onDrop: ({ editor, files, position }) => {
        for (const file of files) uploadInline(editor, file, position ?? 'end');
      },
    }),
  ],
  onChange: (markdown) => {
    output.textContent = markdown;
    write(DRAFT_KEY, markdown);
  },
  onSubmit: (markdown) => {
    if (!markdown.trim()) return;
    const li = document.createElement('li');
    const pre = document.createElement('pre');
    pre.textContent = markdown;
    li.appendChild(pre);
    memos.prepend(li);
    editor.setMarkdown('');
    write(DRAFT_KEY, '');
  },
});
output.textContent = editor.getMarkdown();

// Caret restore across reloads.
const caret = read(CARET_KEY);
if (caret) {
  try {
    editor.setSelection(JSON.parse(caret) as SelectionJSON);
  } catch {
    // Ignore a broken value.
  }
}
editor.on('selectionChange', () => write(CARET_KEY, JSON.stringify(editor.selectionToJSON())));

// Formatting bar with active state.
const bar = document.getElementById('bar')!;
const buttons: { label: string; run: () => boolean; active?: () => boolean }[] = [
  { label: 'B', run: () => editor.commands.toggleBold(), active: () => editor.isActive('bold') },
  { label: 'I', run: () => editor.commands.toggleItalic(), active: () => editor.isActive('italic') },
  { label: 'S', run: () => editor.commands.toggleStrike(), active: () => editor.isActive('strike') },
  { label: 'Code', run: () => editor.commands.toggleCode(), active: () => editor.isActive('code') },
  { label: 'H1', run: () => editor.commands.toggleHeading({ level: 1 }), active: () => editor.isActive('heading', { level: 1 }) },
  { label: 'H2', run: () => editor.commands.toggleHeading({ level: 2 }), active: () => editor.isActive('heading', { level: 2 }) },
  { label: '• List', run: () => editor.commands.toggleBulletList(), active: () => editor.isActive('bulletList') },
  { label: '1. List', run: () => editor.commands.toggleOrderedList(), active: () => editor.isActive('orderedList') },
  { label: '☐ Todo', run: () => editor.commands.toggleTaskList(), active: () => editor.isActive('taskList') },
  { label: '❝', run: () => editor.commands.toggleBlockquote(), active: () => editor.isActive('blockquote') },
  { label: '</>', run: () => editor.commands.toggleCodeBlock(), active: () => editor.isActive('codeBlock') },
  {
    label: 'Link',
    run: () => {
      const href = prompt('URL', String(editor.getAttributes('link').href ?? 'https://'));
      return href === null ? false : href ? editor.commands.setLink({ href }) : editor.commands.unsetLink();
    },
    active: () => editor.isActive('link'),
  },
  { label: '#tag', run: () => editor.commands.insertText('#') },
];
const els = buttons.map((b) => {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = b.label;
  // Keep focus and the selection in the editor.
  el.addEventListener('mousedown', (e) => e.preventDefault());
  el.addEventListener('click', () => {
    b.run();
    editor.commands.focus();
  });
  bar.appendChild(el);
  return el;
});
const spacer = document.createElement('span');
spacer.className = 'spacer';
bar.appendChild(spacer);
const save = document.createElement('button');
save.type = 'button';
save.textContent = 'Save';
save.addEventListener('click', () => editor.submit());
bar.appendChild(save);

const refresh = () => buttons.forEach((b, i) => els[i]!.classList.toggle('on', !!b.active?.()));
editor.on('selectionChange', refresh);
refresh();

(window as unknown as { editor: Editor }).editor = editor;
