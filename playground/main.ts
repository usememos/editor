// The playground: a note composer built only on the public API. It uses
// line breaks, no setext headings, math rendered with KaTeX, footnotes and
// a stand-in diagram view for ```mermaid blocks (diagram.ts);
// #tag and @mention highlighting; three autocomplete popups as examples of
// callers (#tags, @people from a fake async search, and [[ page links),
// plus :emoji from @usememos/editor/emoji;
// a formatting bar with active state; upload placeholders for
// pasted and dropped images; the draft and caret kept across reloads; and
// Mod+Enter to save.
//
// URL parameters: ?md=… loads that Markdown, ?empty starts empty, ?focus
// focuses on load, ?plain uses plain CommonMark with no extensions.

import katex from 'katex';
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  type IconNode,
  Italic,
  Link,
  List,
  ListOrdered,
  ListTodo,
  SquareCode,
  Strikethrough,
  TextQuote,
  createElement,
} from 'lucide';
import 'katex/dist/katex.min.css';
import * as core from '@usememos/editor';
import {
  Editor,
  type EditorOptions,
  type Theme,
  type SelectionJSON,
  fileHandler,
  footnotes,
  math,
  matchToken,
  mentions,
  scanMentions,
  scanTags,
  suggestion,
  tags,
} from '@usememos/editor';
import { emoji } from '@usememos/editor/emoji';
import style from '../packages/editor/src/style.css?inline';
import baseStyle from '../packages/editor/src/base.css?inline';
import { diagram } from './diagram';
import { SAMPLE } from './sample';

const TAGS = ['work', 'work/meeting', 'work/planning', 'reading', 'ideas', 'journal', '日记'];
const PEOPLE = [
  { username: 'ada', name: 'Ada Lovelace' },
  { username: 'alan', name: 'Alan Turing' },
  { username: 'grace', name: 'Grace Hopper' },
  { username: 'katherine', name: 'Katherine Johnson' },
  { username: 'linus', name: 'Linus Torvalds' },
];
const PAGES = ['Meeting notes', 'Project plan', 'Reading list', 'Weekly review'];

/** A fake people search that answers after a delay, as a server would, and stops when aborted. */
function searchPeople(query: string, signal: AbortSignal): Promise<typeof PEOPLE> {
  return new Promise((resolve, reject) => {
    const q = query.toLowerCase();
    const timer = setTimeout(() => resolve(PEOPLE.filter((p) => p.username.startsWith(q) || p.name.toLowerCase().includes(q))), 150);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });
}
const DRAFT_KEY = 'mbe-playground-draft';
const CARET_KEY = 'mbe-playground-caret';

const params = new URLSearchParams(location.search);
const plain = params.has('plain');

// ?base loads only base.css: layout without the default look.
const styleEl = document.createElement('style');
styleEl.textContent = params.has('base') ? baseStyle : style;
document.head.append(styleEl);
const fromUrl = params.has('md') || params.has('empty');

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
// Draft writes wait until typing pauses (a 100 KB draft on every keystroke is slow), and flush when the page goes away.
const pending = new Map<string, () => string>();
let saveTimer = 0;
const flush = () => {
  clearTimeout(saveTimer);
  for (const [key, value] of pending) write(key, value());
  pending.clear();
};
const saveLater = (key: string, value: () => string) => {
  pending.set(key, value);
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flush, 400);
};
const saveNow = (key: string, value: string) => {
  pending.delete(key);
  write(key, value);
};
addEventListener('pagehide', flush);

const output = document.getElementById('output')!;
const saved = document.getElementById('saved')!;

/** A fake upload: progress over about two seconds, then a local URL. */
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

const composer: Partial<EditorOptions> = {
  markdown: { breaks: true, setext: false },
  // Uploaded images are blob: URLs here; the default policy would drop them.
  resolveUrl: (url, kind) => (kind === 'image' && url.startsWith('blob:') ? url : core.defaultResolveUrl(url, kind)),
  attributes: { autocorrect: 'on', autocapitalize: 'sentences', 'aria-label': 'Note' },
  extensions: [
    math({ render: (tex, el, options) => katex.render(tex, el, { ...options, throwOnError: false }) }),
    footnotes(),
    // ```mermaid blocks render as a diagram; the code shows at the caret.
    { name: 'diagrams', views: { 'code:mermaid': diagram } },
    tags({ class: 'tag' }),
    mentions({ class: 'mention' }),
    // #tags: opens where a tag is highlighted, and lists known tags. A pick writes "#tag ".
    suggestion({
      name: 'tags',
      trigger: ['#', '＃'],
      match: matchToken(scanTags),
      label: 'Tags',
      items: ({ query }) =>
        TAGS.filter((t) => t.toLowerCase().includes(query.toLowerCase()))
          .slice(0, 8)
          .map((t) => ({ id: t, label: `#${t}` })),
    }),
    // @people: an async search with a debounce, details and icons. A pick writes "@username ".
    suggestion({
      name: 'people',
      trigger: ['@', '＠'],
      match: matchToken(scanMentions),
      label: 'People',
      debounce: 80,
      items: async ({ query, signal }) =>
        (await searchPeople(query, signal)).map((p) => ({ id: p.username, label: p.name, detail: `@${p.username}`, icon: p.name[0] })),
    }),
    // [[ links: titles with spaces, written as a Markdown link.
    suggestion({
      name: 'pages',
      trigger: '[[',
      allowSpaces: true,
      label: 'Pages',
      items: ({ query }) =>
        PAGES.filter((p) => p.toLowerCase().includes(query.toLowerCase())).map((p) => ({ id: p, label: p, section: 'Pages' })),
      command: ({ editor, range, item }) => {
        editor.setSelection({ anchor: range.from, focus: range.to });
        editor.commands.insertMarkdown(`[${item.label}](#${item.label.toLowerCase().replace(/\s+/g, '-')})`);
      },
    }),
    // :emoji by GitHub's names; a pick writes the emoji itself.
    emoji(),
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
};

// Test hook: `npm run test:e2e:themed` runs every browser test with a class on every theme key.
const testTheme = document.cookie.includes('mbe-themed=1')
  ? {
      classes: {
        ...Object.fromEntries(
          ['paragraph', 'blockquote', 'bulletList', 'orderedList', 'taskList', 'codeBlock', 'table', 'divider', 'raw', 'image']
            .concat(['bold', 'italic', 'strike', 'code', 'link'])
            .map((key) => [key, `t-${key}`]),
        ),
        heading: { 1: 't-h1', 2: 't-h2', 3: 't-h3', 4: 't-h4', 5: 't-h5', 6: 't-h6' },
        token: { math: 't-math', footnote: 't-footnote' },
      },
    }
  : undefined;

const editor = new Editor({
  element: document.getElementById('editor')!,
  ...(plain ? {} : composer),
  theme: testTheme,
  content: params.has('empty') ? '' : (params.get('md') ?? read(DRAFT_KEY) ?? SAMPLE),
  placeholder: 'Write something, or type / for commands…',
  mode: params.has('source') ? 'source' : 'rich',
  autofocus: params.has('focus'),
  onChange: (markdown) => {
    output.textContent = markdown;
    if (!fromUrl) saveLater(DRAFT_KEY, () => markdown);
  },
  onSubmit: (markdown) => {
    document.body.dataset.submitted = String(Number(document.body.dataset.submitted ?? 0) + 1);
    if (!markdown.trim() || fromUrl) return;
    const li = document.createElement('li');
    const pre = document.createElement('pre');
    pre.textContent = markdown;
    li.appendChild(pre);
    saved.prepend(li);
    editor.setMarkdown('');
    saveNow(DRAFT_KEY, '');
  },
});
output.textContent = editor.getMarkdown();

// The caret survives a reload.
const caret = fromUrl ? null : read(CARET_KEY);
if (caret) {
  try {
    editor.setSelection(JSON.parse(caret) as SelectionJSON);
  } catch {
    // Ignore a broken value.
  }
}
// The caret is a few bytes, so it is saved at once. Firefox may not show a
// write made while the page unloads to the page that replaces it.
editor.on('selectionChange', () => {
  if (!fromUrl) saveNow(CARET_KEY, JSON.stringify(editor.selectionToJSON()));
});

// Formatting bar with active state: [Lucide icon, title, command, isActive name, attributes].
// The icons match the editor's own, which are Lucide too.
type Name = Parameters<Editor['isActive']>[0];
const commands = editor.commands;
const marks: [IconNode, string, () => unknown, Name, Record<string, unknown>?][] = [
  [Bold, 'Bold', () => commands.toggleBold(), 'bold'],
  [Italic, 'Italic', () => commands.toggleItalic(), 'italic'],
  [Strikethrough, 'Strikethrough', () => commands.toggleStrike(), 'strike'],
  [Code, 'Inline code', () => commands.toggleCode(), 'code'],
  [Heading1, 'Heading 1', () => commands.toggleHeading({ level: 1 }), 'heading', { level: 1 }],
  [Heading2, 'Heading 2', () => commands.toggleHeading({ level: 2 }), 'heading', { level: 2 }],
  [List, 'Bullet list', () => commands.toggleBulletList(), 'bulletList'],
  [ListOrdered, 'Numbered list', () => commands.toggleOrderedList(), 'orderedList'],
  [ListTodo, 'Task list', () => commands.toggleTaskList(), 'taskList'],
  [TextQuote, 'Quote', () => commands.toggleBlockquote(), 'blockquote'],
  [SquareCode, 'Code block', () => commands.toggleCodeBlock(), 'codeBlock'],
  [Link, 'Link', () => {
    const href = prompt('URL', String(editor.getAttributes('link').href ?? 'https://'));
    if (href === null) return;
    if (href) commands.setLink({ href });
    else commands.unsetLink();
  }, 'link'],
];

const bar = document.getElementById('bar')!;
/** A bar button showing text, or a Lucide icon named by its title. */
function button(label: string | IconNode, title: string, onClick: () => unknown, className = ''): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  if (typeof label === 'string') el.textContent = label;
  else {
    el.append(createElement(label, { width: 16, height: 16, 'aria-hidden': 'true' }));
    el.setAttribute('aria-label', title);
  }
  el.title = title;
  el.className = className;
  // Keep focus and the selection in the editor.
  el.addEventListener('mousedown', (e) => e.preventDefault());
  el.addEventListener('click', onClick);
  bar.appendChild(el);
  return el;
}
const els = marks.map(([icon, title, run]) => button(icon, title, () => (run(), commands.focus())));
bar.appendChild(Object.assign(document.createElement('span'), { className: 'spacer' }));
const readOnly = button('Read-only', 'Switch between editing and read-only. Both look the same.', () => {
  editor.setOptions({ editable: !editor.isEditable });
  readOnly.classList.toggle('on', !editor.isEditable);
});
readOnly.id = 'toggle-readonly';
// Source mode: the document as Markdown text. An app would remember the choice.
const source = button('Source', 'Switch between blocks and Markdown text', () => {
  editor.setOptions({ mode: editor.mode === 'source' ? 'rich' : 'source' });
  source.classList.toggle('on', editor.mode === 'source');
});
source.id = 'toggle-source';
source.classList.toggle('on', editor.mode === 'source');

// Example themes: tokens only, so switching restyles without re-rendering.
const themes: [string, Theme | undefined][] = [
  ['Default', testTheme],
  ['Warm', {
    ...testTheme,
    tokens: {
      light: { text: '#3b2f2a', muted: '#8a7466', accent: '#b4542a', codeBackground: '#f3e7dc', border: '#e8d9cc', hover: '#f6ece3' },
      dark: { text: '#efe4da', muted: '#b39d8e', accent: '#e58a5c', codeBackground: '#3a2e28', border: '#4a3b33', popupBackground: '#2c231f', hover: '#43352d' },
      font: 'Georgia, serif',
      radius: 4,
    },
  }],
  // The page switches its own color-scheme, as an app with a theme setting does; the editor follows it.
  ['Dark', { ...testTheme, colorScheme: 'inherit' }],
  ['Light', { ...testTheme, colorScheme: 'inherit' }],
];
let themeIndex = 0;
const themeButton = button('Theme: Default', 'Cycle example themes', () => {
  themeIndex = (themeIndex + 1) % themes.length;
  const [name, theme] = themes[themeIndex]!;
  document.documentElement.style.colorScheme = theme?.colorScheme === 'inherit' ? name.toLowerCase() : '';
  editor.setOptions({ theme });
  themeButton.textContent = `Theme: ${name}`;
});
button('Save', 'Save (Mod+Enter)', () => editor.submit(), 'primary');

// Once per frame, not inside the keystroke.
let frame = 0;
const refresh = () => {
  frame = 0;
  marks.forEach(([, , , name, attrs], i) => els[i]!.classList.toggle('on', editor.isActive(name, attrs)));
};
editor.on('selectionChange', () => (frame ||= requestAnimationFrame(refresh)));
refresh();

(window as unknown as { editor: Editor }).editor = editor;
// Tests build their own editors with custom extensions from this.
(window as unknown as { core: typeof core }).core = core;
