# editor

A block editor for standard Markdown. "editor" is a working name.

- Markdown in, Markdown out: CommonMark plus GFM tables, task lists and strikethrough.
- Block editing: slash menu, a formatting toolbar, Markdown shortcuts, and a block handle on tables and code blocks.
- `@editor/core` has zero runtime dependencies and works without a framework. `@editor/react` is a thin React wrapper.

Status: v0 in development. The spec is the source of truth for scope; see [docs/architecture.md](docs/architecture.md) for how it works.

## Use it

React:

```tsx
import { MarkdownEditor } from '@editor/react';
import '@editor/core/style.css';

function CommentBox() {
  const [markdown, setMarkdown] = useState('');
  return <MarkdownEditor value={markdown} onChange={setMarkdown} placeholder="Leave a comment…" onSubmit={post} />;
}
```

Without a framework:

```ts
import { Editor } from '@editor/core';
import '@editor/core/style.css';

const editor = new Editor({
  element: document.querySelector('#editor')!,
  content: '# Hello',
  onChange: (markdown) => save(markdown),
});
```

### Options

The same names work in `new Editor(options)` and as React props, except that React takes `value` instead of `content`.

| Option | Type | Behavior |
| --- | --- | --- |
| `element` | `HTMLElement` | Core only. The editor renders into it. |
| `content` | `string` | Core only. Initial Markdown. |
| `value` | `string` | React only. The editor updates only when `value` differs from the last Markdown it emitted. |
| `defaultValue` | `string` | React only. Initial Markdown for uncontrolled use. |
| `markdown` | `{ breaks?, setext? }` | Markdown dialect. `breaks: true` reads a single newline as a line break and saves line breaks as plain newlines (as GitHub comments and memos do). `setext: false` turns off setext headings, so `Title`⏎`---` is a paragraph and a divider. |
| `extensions` | `Extension[]` | Adds syntax. Built in: `math()` (`$…$` and `$$` blocks) and `footnotes()` (`[^1]` and `[^1]: …`). Extension syntax is shown as source and saved verbatim. |
| `placeholder` | `string` | Shown when the document is empty. |
| `editable` | `boolean` | Default `true`. With `false`, no editing, and links open on click. |
| `autofocus` | `boolean \| 'start' \| 'end'` | Focuses the editor on creation, with the caret at the start or the end. |
| `attributes` | `Record<string, string>` | Attributes for the editable root, such as `autocorrect`, `autocapitalize` or `aria-label`. |
| `resolveImageSrc` | `(src) => string` | The URL to display for an image. The saved Markdown keeps the original `src`. |
| `toolbar` | `boolean` | Shows the formatting toolbar on selection. Default `true`. |
| `slashMenu` | `false \| string[]` | Built-in slash menu items to show, in order, or `false` for none: `text`, `heading1`, `heading2`, `heading3`, `bulletList`, `numberedList`, `todoList`, `quote`, `code`, `table`, `divider`. |
| `labels` | `Partial<Labels>` | Overrides UI strings, for localization. See `src/labels.ts`. |
| `onChange` | `(markdown: string) => void` | Called after document changes, at most once per animation frame. |
| `onSubmit` | `(markdown: string) => void` | Called on Mod+Enter or Ctrl+Enter with the current Markdown, for comment boxes and chat inputs. |
| `onFocus`, `onBlur` | `() => void` | Focus events. |

For memos-style Markdown use `markdown: { breaks: true, setext: false }` and `extensions: [math(), footnotes()]`.

`editor.setOptions({ placeholder, editable, attributes, resolveImageSrc })` changes those options while the editor runs. The other options are fixed for the editor's lifetime.

In React, `placeholder`, `editable`, `attributes` and `resolveImageSrc` update live. A change to the names in `extensions` recreates the editor and keeps its Markdown, so an inline array is fine. Other props are read on mount; change the component's `key` to apply new values. A `ref` gives the core `Editor` instance. A `value` that arrives while an input method (IME) is composing text is applied when the composition ends.

For apps that manage the editor instance themselves, `useEditor(options, deps)` creates one and `<EditorContent editor={editor} />` shows it:

```tsx
import { EditorContent, useEditor } from '@editor/react';

function Composer() {
  const editor = useEditor({ content: '', extensions: [math()], onSubmit: send });
  return <EditorContent editor={editor} />;
}
```

### API

| Member | What it does |
| --- | --- |
| `getMarkdown()` | The document as Markdown. |
| `setMarkdown(markdown, { history? })` | Replaces the document. `history: 'clear'` (default) clears undo history; `'keep'` makes the replacement one undo step. Does not emit `change`. |
| `isEmpty` | True when the document holds only empty paragraphs. |
| `state` | The document and selection, immutable. |
| `commands.*` | Edits. Each applies one change, records one undo step, and returns `true` if it did something: `toggleBold`, `toggleItalic`, `toggleStrike`, `toggleCode`, `setParagraph`, `toggleHeading({ level })`, `toggleBulletList`, `toggleOrderedList`, `toggleTaskList`, `toggleBlockquote`, `toggleCodeBlock({ language? })`, `setLink({ href })`, `unsetLink`, `insertText(text, { range? })`, `insertMarkdown(markdown, options?)`, `insertTable({ rows?, cols? })`, `insertDivider`, `indent`, `outdent`, `undo`, `redo`, `selectAll`, `focus(position?)`, `blur`. |
| `run(fn)` | Applies a custom command: a function from state to a new state, or `null`. The pure commands are exported as `commands` from the package. |
| `isActive(name, attrs?)` | `bold`, `italic`, `strike`, `code`, `link`, or the type of the block with the caret: `paragraph`, `heading`, `bulletList`, `orderedList`, `taskList`, `blockquote`, `codeBlock`, `table`, `divider`, `raw`. `attrs` narrows it, for example `isActive('heading', { level: 2 })`. |
| `getAttributes(name)` | `href` of a link, `level` of a heading, `language` of a code block, `checked` of a task, `syntax` of a raw block. |
| `getSelection()`, `setSelection(selection)` | Read or move the selection. `setSelection` also takes a `SelectionJSON`, and clamps one that does not fit the document. |
| `selectionToJSON()` | The selection as JSON-safe data (block index and offset). It still fits after reloading the same Markdown, so an app can store the caret and restore it. |
| `on(event, handler)` | Subscribes; returns an unsubscribe function. Events: `change` (at most once per frame), `selectionChange`, `focus`, `blur`, `submit`. |
| `addWidget({ at, render })` | Shows app UI after the block that contains `at` (a position or `'end'`), such as an upload placeholder. Returns a widget with `update(render?)`, `remove()` and `isRemoved`. A widget is never saved and is not part of undo history. It moves with its block; if the block is deleted, it moves to the nearest remaining block. `insertMarkdown(md, { at: widget })` inserts after the widget's block. |
| `positionAtPoint(x, y)` | The document position at a viewport point, or `null`. |
| `hasFocus()`, `focus()`, `blur()`, `isEditable`, `setOptions(options)`, `destroy()` | |

`insertMarkdown(markdown, { at, block, select })`: `at` is `'selection'` (default; replaces the selection, like a paste), `'end'`, a position, or a widget; the last three replace nothing. A single paragraph is inserted inline unless `block: true`, which inserts it as its own block and splits the block at the target. `select: 'keep'` keeps the current selection instead of moving the caret after the inserted content.

### Extensions

An extension is a plain object. All fields except `name` are optional.

```ts
const tags: Extension = {
  name: 'tags',
  keymap: { 'Mod-Shift-t': ({ editor }) => editor.commands.insertText('#') },
  decorations: ({ text, excluded }) => [{ from: 0, to: 1, class: 'first-letter' }],
  handlePaste: ({ editor, event }) => false, // true stops the editor's own paste handling
  handleDrop: ({ editor, event, position }) => false, // position: where the drop landed, or null
  onCreate: ({ editor }) => () => {}, // the returned function runs on destroy
};
```

`decorations` returns CSS classes for ranges of a block's text, for highlighting such as `#tags` and `@mentions`. It runs for each paragraph, heading, list item, quote and table cell, only when that block changes, and is never saved. `textDecorator({ pattern | scan, class })` builds one from a regular expression or a scanner function and skips matches inside inline code, links, images and tokens:

```ts
textDecorator({ pattern: /#[\p{L}\p{N}_/-]+/u, class: 'tag' })
```

`suggestion({ char, items, command })` opens a menu when `char` is typed at the start of a line or after a space. `items({ query })` returns the items for the text typed after it, and may be async. `command({ editor, range, item })` applies the pick; `range` covers the trigger and the query. The slash menu is built on the same code. Suggestions do not open inside table cells.

```ts
suggestion({
  char: '#',
  items: async ({ query }) => (await loadTags()).filter((t) => t.startsWith(query)).map((t) => ({ id: t, label: `#${t}` })),
  command: ({ editor, range, item }) => editor.commands.insertText(`#${item.id} `, { range }),
});
```

Other options: `allowSpaces` (the query may contain single spaces), `allowAnywhere` (open inside a word too), `maxLength` (default 30), `emptyLabel` (show this instead of hiding when nothing matches), `className`.

`fileHandler({ accept, onPaste, onDrop })` receives pasted and dropped files. `accept` takes MIME types or patterns such as `image/*`. `onPaste` runs only when the clipboard has no plain text, so text copied together with an image still pastes as text. `onDrop` gets the document position of the drop. Dropped text without files is inserted where it lands.

`keymap` uses ProseMirror key names: `Mod-` (Cmd on macOS, Ctrl elsewhere), `Ctrl-`, `Alt-`, `Shift-`, `Meta-`, then a key such as `b`, `7`, `Enter` or `Escape`. A handler returns `true` to stop later bindings and the browser default. Bindings in earlier extensions run first. The default bindings are the `defaultKeymap()` extension, added last; pass your own extension named `defaultKeymap` to replace it.

`markdown` adds syntax; see `math()` and `footnotes()` and [docs/architecture.md](docs/architecture.md).

### Theming

Every color, font and size is a CSS custom property (`--mbe-text`, `--mbe-accent`, `--mbe-font`, …; see `style.css`). Light and dark follow `prefers-color-scheme`; set `data-theme="light"` or `data-theme="dark"` on the editor or an ancestor to force one. The default theme has no border or background, so it fits inside your own comment box or chat input.

## Keyboard

| Keys | Action |
| --- | --- |
| `/` | Slash menu |
| Mod+B, Mod+I, Mod+E | Bold, italic, inline code |
| Mod+Shift+X, Mod+Shift+S | Strikethrough |
| Mod+K | Link |
| Mod+Alt+0, Mod+Alt+1–3 | Paragraph, heading 1–3 |
| Mod+Alt+C | Code block |
| Mod+Shift+7, 8, 9 | Numbered, bullet, task list |
| Mod+/ | Block menu, in a table or code block |
| Mod+Z, Mod+Shift+Z (Ctrl+Y) | Undo, redo |
| Shift+Enter | Line break inside a block |
| Tab, Shift+Tab | Indent and outdent list items; next and previous table cell |
| Mod+Shift+V | Paste as plain text |
| Mod+Enter, Ctrl+Enter | `submit` |
| Escape | Close a menu or the toolbar; otherwise leave the editor |

Markdown shortcuts at the start of a line: `#`–`######`, `-`, `*`, `+`, `1.`, `[ ]`, `[x]`, `>`, ` ``` `, `---`. Inline: `**bold**`, `*italic*`, `_italic_`, `` `code` ``, `~~strike~~`.

## What saving changes

Blocks you did not edit are saved exactly as they were loaded, byte for byte, including the blank lines between them. `getMarkdown()` right after loading returns the input unchanged.

Blocks you edited, and new blocks, are written in a normalized style: `*` for italic, `**` for bold, `-` for bullets, ATX headings, fenced code, tight lists, renumbered ordered lists, and inline links instead of reference links. Soft line breaks become spaces, unless `markdown.breaks` is on. Structure the editor cannot edit as blocks (a list inside a quote, a code block or second paragraph inside a list item, lists nested more than five levels) is kept as a raw block: the original Markdown, shown and edited as source, saved verbatim. Math and footnote blocks from the extensions are raw blocks too.

## Develop

```sh
npm install
npm run dev        # playground: core at /, React at /react.html, memos setup at /memos.html
npm test           # unit, spec and round-trip tests (vitest)
npm run test:e2e   # browser tests (Playwright, Chromium)
npm run test:perf  # timing gates, run alone
npm run typecheck
```
