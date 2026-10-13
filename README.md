# @usememos/editor

A block editor for standard Markdown, for React or any web app.

- Markdown in, Markdown out: CommonMark plus GFM tables, task lists, strikethrough and autolinks. Blocks you did not edit are saved byte for byte.
- Block editing: slash menu, a formatting toolbar, Markdown shortcuts, and a block handle on tables and code blocks.
- One package, `@usememos/editor`, with zero runtime dependencies. It works without a framework, and `@usememos/editor/react` is a thin React wrapper.
- About 55 KB minified and gzipped, plus 3 KB of CSS: a third of what a comparable CodeMirror 6, Tiptap or Lexical setup adds (see [Performance](docs/architecture.md#performance)).

Status: early releases, published to npm as [`@usememos/editor`](https://www.npmjs.com/package/@usememos/editor). Versions follow memos' CalVer (`26.10`, `26.10.1`) and do not signal breaking changes, so pin an exact version. [docs/syntax.md](docs/syntax.md) specifies the Markdown it reads and writes, and [docs/architecture.md](docs/architecture.md) explains how it works.

## Use it

```sh
npm install @usememos/editor
```

React:

```tsx
import { MarkdownEditor } from '@usememos/editor/react';
import '@usememos/editor/style.css';

function CommentBox() {
  const [markdown, setMarkdown] = useState('');
  return <MarkdownEditor value={markdown} onChange={setMarkdown} placeholder="Leave a comment…" onSubmit={post} />;
}
```

Without a framework:

```ts
import { Editor } from '@usememos/editor';
import '@usememos/editor/style.css';

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
| `markdown` | `{ breaks?, setext?, autolinks? }` | Markdown dialect. `breaks: true` reads a single newline as a line break and saves line breaks as plain newlines (as GitHub comments do). `setext: false` turns off setext headings, so `Title`⏎`---` is a paragraph and a divider. `autolinks: false` turns off GFM autolink literals, so a bare `https://…`, `www.…` or e-mail address stays text. See [docs/syntax.md](docs/syntax.md). |
| `extensions` | `Extension[]` | Adds syntax and behavior. Built in: `math()` (`$…$` and `$$` blocks), `footnotes()` (`[^1]` and `[^1]: …`), `tags()` (`#tag`) and `mentions()` (`@name`). Extension syntax is saved verbatim, and shown as source unless the extension renders it (see `views`). |
| `placeholder` | `string` | Shown when the document is empty. |
| `editable` | `boolean` | Default `true`. With `false`, no editing, and links open on click. |
| `taskToggle` | `boolean` | Default `false`. While `editable` is `false`, lets the user tick and untick task items, for example for a memo's owner. Each tick emits `change` with Markdown in which only that item's `[ ]` or `[x]` changed. Ignored while `editable` is `true`. |
| `autofocus` | `boolean \| 'start' \| 'end'` | Focuses the editor on creation, with the caret at the start or the end. |
| `attributes` | `Record<string, string>` | Attributes for the editable root, such as `autocorrect`, `autocapitalize` or `aria-label`. |
| `resolveImageSrc` | `(src) => string` | The URL to display for an image. The saved Markdown keeps the original `src`. |
| `theme` | `{ classes?, tokens?, colorScheme? }` | Your own classes on rendered elements, colors and fonts, and light or dark. See [Theming](#theming). |
| `toolbar` | `boolean` | Shows the formatting toolbar on selection. Default `true`. |
| `popupContainer` | `HTMLElement` | Where menus, the toolbar and the autocomplete popup are appended. Default: the nearest open `<dialog>` or `aria-modal` ancestor of `element`, else `document.body`. |
| `slashMenu` | `false \| string[]` | Built-in slash menu items to show, in order, or `false` for none: `text`, `heading1`, `heading2`, `heading3`, `bulletList`, `numberedList`, `todoList`, `quote`, `code`, `table`, `divider`. |
| `labels` | `Partial<Labels>` | Overrides UI strings, for localization. See `src/labels.ts`. |
| `icons` | `Partial<Record<IconName, string \| Element>>` | Replaces built-in icons, which are [Lucide](https://lucide.dev) icons. A string is shown as text; an element, such as an `<svg>`, is cloned for every place it appears. Names match the `labels` keys of the same controls: the slash menu items, `duplicate`, `delete`, the table actions, `bold`, `italic`, `strike`, `inlineCode`, `link` and `blockHandle`. |
| `onChange` | `(markdown: string, editor) => void` | Called after document changes, at most once per animation frame. |
| `onSubmit` | `(markdown: string, editor) => void` | Called on Mod+Enter or Ctrl+Enter with the current Markdown, for comment boxes and chat inputs. |
| `onFocus`, `onBlur` | `(editor) => void` | Focus events. |
| `className`, `style` | | React only. Set on the element that holds the editor. |

For note-style Markdown, as in the playground, use `markdown: { breaks: true, setext: false }` and `extensions: [math(), footnotes(), tags(), mentions()]`.

`editor.setOptions({ placeholder, editable, taskToggle, attributes, resolveImageSrc, theme })` changes those options while the editor runs. `setOptions({ extensions })` takes new callbacks for `suggestion()` extensions of the same names. The other options are fixed for the editor's lifetime.

In React, `placeholder`, `editable`, `taskToggle`, `attributes`, `resolveImageSrc` and `theme` update live. A change to the names in `extensions` recreates the editor and keeps its Markdown, so an inline array is fine; with the same names, the callbacks of `suggestion()` extensions update live, so `items` may read React state. Other props are read on mount; change the component's `key` to apply new values. A `ref` gives the core `Editor` instance. A `value` that arrives while an input method (IME) is composing text is applied when the composition ends.

For apps that manage the editor instance themselves, `useEditor(options, deps)` creates one and `<EditorContent editor={editor} />` shows it:

```tsx
import { EditorContent, useEditor } from '@usememos/editor/react';

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
| `commands.*` | Edits. Each applies one change, records one undo step, and returns `true` if it did something: `toggleBold`, `toggleItalic`, `toggleStrike`, `toggleCode`, `setParagraph`, `toggleHeading({ level })`, `toggleBulletList`, `toggleOrderedList`, `toggleTaskList`, `toggleBlockquote`, `toggleCodeBlock({ language? })`, `setLink({ href })`, `unsetLink`, `insertText(text, { range? })`, `insertMarkdown(markdown, options?)`, `insertTable({ rows?, cols? })`, `insertDivider`, `indent`, `outdent`, `undo`, `redo`, `selectAll`, `selectBlocks`, `focus(position?)`, `blur`, `scrollIntoView`. `selectBlocks` selects the blocks the selection touches as whole blocks, as Escape does; it returns `false` when read-only. `scrollIntoView` changes nothing in the document: it scrolls the caret into view in the editor's scrolling containers and the window, for example after an `insertMarkdown` from code. |
| `run(fn)` | Applies a custom command: a function from state to a new state, or `null`. The pure commands are exported as `commands` from the package. |
| `isActive(name, attrs?)` | `bold`, `italic`, `strike`, `code`, `link`, or the type of the block with the caret: `paragraph`, `heading`, `bulletList`, `orderedList`, `taskList`, `blockquote`, `codeBlock`, `table`, `divider`, `raw`. `attrs` narrows it, for example `isActive('heading', { level: 2 })`. |
| `getAttributes(name)` | `href` of a link, `level` of a heading, `language` of a code block, `checked` of a task, `syntax` of a raw block. |
| `selectedBlocks` | The blocks of a block selection, in document order, or an empty array when the selection is text. |
| `getSelection()`, `setSelection(selection)` | Read or move the selection. `setSelection` also takes a `SelectionJSON`, and clamps one that does not fit the document. |
| `selectionToJSON()` | The selection as JSON-safe data (block index and offset). It still fits after reloading the same Markdown, so an app can store the caret and restore it. |
| `on(event, handler)` | Subscribes; returns an unsubscribe function. Events: `change` (at most once per frame), `selectionChange`, `focus`, `blur`, `submit`, `suggestionChange` (see [Autocomplete](#autocomplete)). |
| `suggestion.*` | The autocomplete popup: `state`, `open(name?)`, `close()`, `move(delta)`, `accept(index?)`. See [Autocomplete](#autocomplete). |
| `addWidget({ at, render })` | Shows app UI after the block that contains `at` (a position or `'end'`), such as an upload placeholder. Returns a widget with `update(render?)`, `remove()` and `isRemoved`. A widget is never saved and is not part of undo history. It moves with its block; if the block is deleted, it moves to the nearest remaining block. `insertMarkdown(md, { at: widget })` inserts after the widget's block. |
| `positionAtPoint(x, y)` | The document position at a viewport point, or `null`. |
| `submit()` | Emits a pending `change`, then `submit` with the current Markdown, as Mod+Enter does. Returns `false` when nothing listens for `submit`. |
| `root` | The editable element: `element`, or for `useEditor`, the element `<EditorContent>` shows. |
| `isComposing` | True while an input method (IME) is composing text. Replacing the document then would break the composition; the React wrapper waits for it to end. |
| `destroy()`, `isDestroyed` | Removes the editor's content, listeners and popups from the page. After it, every call that would change the editor does nothing and commands return `false`, so a late callback (an upload that finishes after the editor closed) is safe. `getMarkdown()` still returns the last Markdown. |
| `hasFocus()`, `focus()`, `blur()`, `isEditable`, `setOptions(options)` | |

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
textDecorator({ pattern: /\bTODO\b/, class: 'todo' })
```

`tags()` and `mentions()` highlight `#tag` and `@name` (classes `mbe-tag` and `mbe-mention`) and keep `\#` and `\@` as written, so an escaped trigger survives edits. Tags and mentions stay plain text and are saved exactly as typed. `scan` replaces the default grammar (`scanTags`, `scanMentions`); see [docs/syntax.md](docs/syntax.md#tags-and-mentions). For autocomplete, add a `suggestion()` next to them.

#### Autocomplete

`suggestion()` adds an autocomplete popup at the caret, like the ones in Linear, CodeMirror and Monaco. The editor implements the behavior: when the popup opens and closes, keys, async items, placement, IME input and accessibility. The caller decides the syntax: the triggers, what counts as a token, where the popup may open, the items, and what a pick writes. Add one per syntax:

```ts
import { matchToken, mentions, scanMentions, scanTags, suggestion, tags } from '@usememos/editor';

const extensions = [
  tags(),
  mentions(),
  // #tags: the popup opens exactly where tags are highlighted. A pick writes "#work/planning ".
  suggestion({
    name: 'tags',
    trigger: ['#', '＃'],
    match: matchToken(scanTags),
    label: 'Tags',
    items: ({ query }) => knownTags.filter((t) => t.includes(query)).map((t) => ({ id: t, label: `#${t}` })),
  }),
  // @people from a server, searched as the user types.
  suggestion({
    name: 'people',
    trigger: '@',
    match: matchToken(scanMentions),
    debounce: 120,
    items: async ({ query, signal }) =>
      (await searchPeople(query, { signal })).map((p) => ({ id: p.username, label: p.name, detail: `@${p.username}` })),
  }),
  // [[ links, written as Markdown links.
  suggestion({
    name: 'pages',
    trigger: '[[',
    allowSpaces: true,
    items: ({ query }) => findPages(query).map((p) => ({ id: p.slug, label: p.title })),
    command: ({ editor, range, item }) => {
      editor.setSelection({ anchor: range.from, focus: range.to });
      editor.commands.insertMarkdown(`[${item.label}](/p/${item.id})`);
    },
  }),
];
```

| Option | Effect |
| --- | --- |
| `name` | Required, unique. Names the suggestion for `editor.suggestion.open(name)` and live updates. |
| `trigger` | One or more strings that start a token, of any length. The first is what the default command writes, so `['#', '＃']` turns a full-width `＃` into `#`. |
| `items({ query, signal, composing, explicit, editor })` | The items, as an array or a promise. Shown in the order given; the editor does not filter or sort. `signal` is aborted when the query changes or the popup closes. A rejection counts as no items. |
| `command({ editor, range, item, query })` | Applies a pick. `range` covers the whole token, from the trigger to its end, even when the caret is in the middle. Default: writes the first trigger, the item's `value` (default `id`, then `label`) and a space, which is left out before whitespace or closing punctuation. |
| `match` | Finds the token at the caret: `({ text, caret, content, triggers }) => ({ from, to, query }) \| null`. `matchToken(scan)` builds one from a scanner, such as the one given to `tags({ scan })`. Without `match`, the default matcher takes a trigger at the start of a line or after whitespace, followed by text with no whitespace. |
| `allow({ block, cell, from, query, textBefore, excluded, explicit, editor })` | Whether the popup may open for a match. Default: not when the trigger is in inline code, a link, an image, raw HTML or a token (`excluded`). Code and raw blocks never open a popup. `explicit` is true for Ctrl+Space. |
| `allowSpaces`, `allowAnywhere` | Default matcher only: the query may contain single spaces; the trigger may follow any character. |
| `debounce` | Waits this many ms after the last change of the query before calling `items`. Default 0. |
| `limit` | Most items shown. Default 50. |
| `maxLength` | Longest query that keeps the popup open. Default 30. |
| `emptyLabel` | Shown instead of hiding when nothing matches, for queries up to three characters. |
| `label` | Accessible name of the listbox. Default `labels.suggestions`. |
| `render: false` | Draws no popup; see below. |
| `className` | Extra classes on the popup. |

Items have `label`, and optionally `id`, `detail` (secondary text), `icon` (text or an element, such as an avatar `<img>`), `section` (a group heading) and `value`.

The popup opens when typing leaves the caret in a token: right after a trigger, or after typing inside an existing token. Moving the caret into a token does not open it, and deleting never does. Ctrl+Space (also Option+Escape on macOS) opens it for the token at the caret, even where `allow` refused, which is told `explicit: true`. It closes when the caret leaves the token; Escape closes it and keeps it closed for that token. ArrowUp and ArrowDown move through the items, Enter and Tab pick, Page Up and Page Down jump. It opens in table cells. The slash menu is a suggestion too.

With `render: false`, the editor draws nothing; the app draws the popup from `editor.suggestion.state` (`name`, `query`, `range`, `items`, `active`, `loading`, `listboxId`, `optionId(i)`, `anchorRect()`) and the `suggestionChange` event, and calls `editor.suggestion.accept(i)` on click. Keys, async items and the ARIA attributes on the editor root still work. In React, `useSuggestion(editor, name?)` returns the state and re-renders on each change:

```tsx
const editor = useEditor({ extensions: [suggestion({ name: 'people', trigger: '@', render: false, items })] });
const state = useSuggestion(editor, 'people');
const rect = state?.anchorRect();
// <ul role="listbox" id={state.listboxId} style={{ position: 'fixed', left: rect.left, top: rect.bottom + 4 }}>
//   {state.items.map((item, i) => <li role="option" id={state.optionId(i)} aria-selected={i === state.active} onClick={() => editor.suggestion.accept(i)}>…)}
```

The popup lines up with the trigger under the caret's line, follows scrolling, resizing and the on-screen keyboard, and hides while the trigger is scrolled out of view. Its z-index is `var(--mbe-popup-z, 1000)`. See [docs/architecture.md](docs/architecture.md#autocomplete) for how it works.

`fileHandler({ accept, onPaste, onDrop })` receives pasted and dropped files. `accept` takes MIME types or patterns such as `image/*`. `onPaste` runs only when the clipboard has no plain text, so text copied together with an image still pastes as text. `onDrop` gets the document position of the drop. Dropped text without files is inserted where it lands.

`keymap` uses ProseMirror key names: `Mod-` (Cmd on macOS, Ctrl elsewhere), `Ctrl-`, `Alt-`, `Shift-`, `Meta-`, then a key such as `b`, `7`, `Enter` or `Escape`. A handler returns `true` to stop later bindings and the browser default. Bindings in earlier extensions run first. The default bindings are the `defaultKeymap()` extension, added last; pass your own extension named `defaultKeymap` to replace it.

`markdown` adds syntax; see `math()`, `footnotes()`, [docs/syntax.md](docs/syntax.md) and [docs/architecture.md](docs/architecture.md).

`views` shows a syntax rendered instead of as source, keyed by syntax name. While editing, a token shows its source when the caret touches it, and a raw block when the selection is in it; clicking either does the same. Read-only always shows the rendered view. `math()` uses this when given a render function; the core has no math renderer of its own, so pass one such as KaTeX:

```ts
import katex from 'katex';
import 'katex/dist/katex.min.css';

math({ render: (tex, element, options) => katex.render(tex, element, { ...options, throwOnError: false }) });
```

### Theming

`style.css` is two stylesheets: `base.css` holds the layout the editor needs and all spacing between blocks, and `theme.css` the default look. The default look is quiet and compact, like a rendered Markdown view: a 16px body with 24px lines, 8px between blocks, headings close to the body size, muted quotes and list markers, code blocks on a light panel with no border, and tables as a light grid with a shaded header row. Editing and read-only look the same; only the cursor on links and checkboxes changes. It has no border or background of its own, so it fits inside your own card, comment box or chat input.

Every color, font and size in `theme.css` is a CSS custom property (`--mbe-text`, `--mbe-accent`, `--mbe-font`, …). Set them with the `theme` option's tokens, with a color set for light and one for dark; colors you leave out keep the defaults:

```ts
new Editor({
  element,
  theme: {
    tokens: {
      light: { text: '#1f2328', muted: '#6e7781', accent: '#0969da' },
      dark: { text: '#e6edf3', accent: '#58a6ff' },
      font: 'Inter, sans-serif',
      radius: 6,
    },
    colorScheme: 'auto',
  },
});
```

Colors are `text`, `muted`, `background`, `accent`, `link`, `codeBackground`, `border`, `popupBackground`, `popupBorder`, `hover` and `danger`; the other tokens are `font`, `mono`, `fontSize`, `lineHeight`, `radius` and `blockGap` (numbers are pixels). Values can be any CSS, such as `var(--primary)`, so the editor can follow your app's own variables. Menus, the toolbar and the link popover take the same tokens.

`colorScheme` picks light or dark: `auto` (the default) follows `prefers-color-scheme`, or `data-theme="light"` or `data-theme="dark"` on the editor or an ancestor; `light` and `dark` force one; `inherit` follows the page's `color-scheme`, for apps that switch it themselves. Switching tokens or the scheme with `setOptions({ theme })` re-renders nothing.

The `theme` option's `classes` add your own classes to rendered elements, next to the editor's `mbe-*` classes, so the editor can share classes with the rest of your app:

```ts
new Editor({
  element,
  theme: {
    classes: {
      paragraph: 'leading-6',
      heading: { 1: 'text-2xl/8 font-semibold', 2: 'text-xl/7 font-semibold' },
      blockquote: 'border-s-3 ps-3 text-muted-foreground',
      code: 'font-mono bg-muted rounded-md px-1',
      link: 'text-primary underline underline-offset-2',
      token: { math: 'text-primary' },
    },
  },
});
```

Keys use the names of `isActive`: `paragraph`, `heading` (by level), `blockquote`, `bulletList`, `orderedList` and `taskList` (each list item; blocks are flat, so there is no list element), `codeBlock`, `table`, `divider` (the `<hr>`), `raw`, `image`, `bold`, `italic`, `strike`, `code`, `link`, and `token` (inline tokens of an extension syntax, by name). Extensions can add classes too; the editor's own `theme` wins for the same key. `setOptions({ theme })` changes them while the editor runs.

To style the editor entirely with your own classes, import `@usememos/editor/base.css` instead of `style.css`. Spacing between blocks stays in `base.css`, and its rules are more specific than a single class, so margins in your classes do not change it.

## Keyboard

| Keys | Action |
| --- | --- |
| `/` | Slash menu |
| Ctrl+Space; Option+Escape on macOS | Open the autocomplete popup for the token at the caret |
| ArrowUp, ArrowDown, Enter, Tab, Escape | In an open autocomplete popup: move, pick, pick, close |
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
| Escape | Close a menu or the toolbar; otherwise select the block with the caret (or every block a text selection crosses); in a block selection, leave the editor |

With blocks selected: ArrowUp and ArrowDown select the block above or below, Shift extends the selection, Mod+A selects every block, Backspace and Delete delete them, Mod+C, Mod+X and paste copy, cut and replace them as whole blocks, Mod+D duplicates them, and the block type keys, Tab and the mark keys apply to all of them. Enter, ArrowLeft and ArrowRight go back to editing text. Typing does nothing. See [Block selection](docs/architecture.md#block-selection).

Markdown shortcuts at the start of a line: `#`–`######`, `-`, `*`, `+`, `1.`, `[ ]`, `[x]`, `>`, ` ``` `, `---`. Inline: `**bold**`, `*italic*`, `_italic_`, `` `code` ``, `~~strike~~`.

## What saving changes

Blocks you did not edit are saved exactly as they were loaded, byte for byte, including the blank lines between them. `getMarkdown()` right after loading returns the input unchanged.

Blocks you edited, and new blocks, are written in a normalized style: `*` for italic, `**` for bold, `-` for bullets, ATX headings, fenced code, tight lists, renumbered ordered lists, and inline links instead of reference links. Soft line breaks become spaces, unless `markdown.breaks` is on. Structure the editor cannot edit as blocks (a list inside a quote, a code block or second paragraph inside a list item, lists nested more than five levels) is kept as a raw block: the original Markdown, shown and edited as source, saved verbatim. Math and footnote blocks from the extensions are raw blocks too.

## Develop

```sh
npm install
npm run dev        # playground: note composer at /, React at /react.html
npm test           # unit, spec and round-trip tests (vitest)
npm run test:e2e   # browser tests (Playwright, Chromium)
npm run test:perf  # timing gates, run alone
npm run typecheck
npm run build      # the published files, in packages/editor/dist
npm run size       # what each published entry adds to an app, minified and gzipped
```
