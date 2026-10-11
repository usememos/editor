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

const editor = new Editor(document.querySelector('#editor')!, {
  value: '# Hello',
  onChange: (markdown) => save(markdown),
});
```

### Options

The same names work on `new Editor(element, options)` and as React props.

| Option | Type | Behavior |
| --- | --- | --- |
| `value` | `string` | Markdown. In React, the editor updates only when `value` differs from the last Markdown it emitted. |
| `defaultValue` | `string` | React only. Initial Markdown for uncontrolled use. |
| `onChange` | `(markdown: string) => void` | Called after document changes, at most once per animation frame. |
| `placeholder` | `string` | Shown when the document is empty. |
| `readOnly` | `boolean` | No editing; links open on click. |
| `autoFocus` | `boolean` | Focuses the editor on mount. |
| `toolbar` | `boolean` | Shows the formatting toolbar on selection. Default `true`. |
| `onSubmit` | `(markdown: string) => void` | Called on Mod+Enter with the current Markdown, for comment boxes and chat inputs. |
| `onFocus`, `onBlur` | `() => void` | Focus events. |
| `slashItems` | `string[]` | Built-in slash menu items to show, in order: `text`, `heading1`, `heading2`, `heading3`, `bulletList`, `numberedList`, `todoList`, `quote`, `code`, `table`, `divider`. |
| `labels` | `Partial<Labels>` | Overrides UI strings, for localization. See `src/labels.ts`. |

In React, `placeholder`, `toolbar`, `slashItems` and `labels` are read on mount; change the component's `key` to apply new values. A `ref` gives the core `Editor` instance.

Core methods: `getMarkdown()`, `setMarkdown(markdown)`, `focus()`, `blur()`, `setReadOnly(readOnly)`, `undo()`, `redo()`, `destroy()`.

### Theming

Every color, font and size is a CSS custom property (`--mbe-text`, `--mbe-accent`, `--mbe-font`, …; see `style.css`). Light and dark follow `prefers-color-scheme`; set `data-theme="light"` or `data-theme="dark"` on the editor or an ancestor to force one. The default theme has no border or background, so it fits inside your own comment box or chat input.

## Keyboard

| Keys | Action |
| --- | --- |
| `/` | Slash menu |
| Mod+B, Mod+I, Mod+E, Mod+Shift+X | Bold, italic, code, strikethrough |
| Mod+K | Link |
| Mod+/ | Block menu, in a table or code block |
| Mod+Z, Mod+Shift+Z (Ctrl+Y) | Undo, redo |
| Shift+Enter | Line break inside a block |
| Tab, Shift+Tab | Indent and outdent list items; next and previous table cell |
| Mod+Shift+V | Paste as plain text |
| Mod+Enter | `onSubmit` |

Markdown shortcuts at the start of a line: `#`–`######`, `-`, `*`, `+`, `1.`, `[ ]`, `[x]`, `>`, ` ``` `, `---`. Inline: `**bold**`, `*italic*`, `_italic_`, `` `code` ``, `~~strike~~`.

## What saving changes

Saving keeps the content but normalizes formatting: `*` for italic, `**` for bold, `-` for bullets, ATX headings, fenced code, tight lists, renumbered ordered lists, and inline links instead of reference links. Soft line breaks become spaces. Structure the editor cannot hold (for example a list inside a quote) is flattened; see the spec's edge cases.

## Develop

```sh
npm install
npm run dev        # playground: core at /, React at /react.html
npm test           # unit, spec and round-trip tests (vitest)
npm run test:e2e   # browser tests (Playwright, Chromium)
npm run test:perf  # timing gates, run alone
npm run typecheck
```
