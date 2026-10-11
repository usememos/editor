# Architecture (v0)

How the editor works, as built in step 3. The spec defines what it must do; this note explains how the code does it and where to find it. "editor" is a working name.

## Summary of decisions

| Area | Decision |
| --- | --- |
| Packages | `@editor/core` (plain TypeScript, zero runtime dependencies) and `@editor/react` (thin wrapper, React 18 or later as a peer dependency). |
| Document model | A flat list of immutable blocks. Each block has a stable ID. Inline content is a list of text spans with marks, a link or an image. |
| Editing surface | One `contentEditable` root that the editor owns completely. Table cells are nested editing hosts. |
| Input | Cancel `beforeinput` and apply a model command. IME composition is the one exception: the browser edits the DOM, and the editor reads the result back on `compositionend`. |
| Rendering | Keyed reconciliation. A block whose object did not change keeps its DOM element. |
| Undo | Whole-document snapshots. They are cheap because unchanged blocks are shared. |
| Markdown | Our own CommonMark 0.31.2 + GFM parser and a normalizing serializer. Saving is stable: `serialize(parse(md))` is a fixed point. |
| Public API | Modeled on Tiptap and ProseMirror: `editor.commands`, `isActive`, `getAttributes`, `on()` events, JSON-safe selections, and extensions as plain objects that add syntax, keys, decorations, suggestion menus and input hooks. Markdown is the only content format. |
| UI | Slash menu, block handle and block menu, formatting toolbar, link popover. All plain DOM, styled with CSS custom properties. |

## Source map

| Path | Contents |
| --- | --- |
| `packages/core/src/model.ts` | Block and span types, constructors, inline helpers, positions. |
| `packages/core/src/commands.ts` | Every edit as a pure function `(state) => state`. |
| `packages/core/src/history.ts` | Undo and redo. |
| `packages/core/src/editor.ts` | The `Editor` class: events, selection sync, menus, clipboard, public API. |
| `packages/core/src/view/dom.ts` | Rendering blocks to DOM, and mapping DOM points to model positions and back. |
| `packages/core/src/ui/` | `Popup` and `Menu`, the toolbar and link popover, the block handle. |
| `packages/core/src/markdown/` | Parser (`blocks.ts`, `inline.ts`, `lower.ts`), serializer (`serialize.ts`), source-preserving save (`source.ts`), entity tables, and an HTML renderer used only by the spec tests (`html.ts`). |
| `packages/core/src/clipboard/` | Document to HTML for copy (`toHtml.ts`), pasted HTML to document (`fromHtml.ts`). |
| `packages/core/src/extension.ts`, `packages/core/src/extensions/` | The `Extension` interface, and the built-in `math()` and `footnotes()` syntax extensions. |
| `packages/core/src/labels.ts` | Every UI string, for localization. |
| `packages/react/src/index.tsx` | `<MarkdownEditor>`. |

## Document model

- A document is `{ blocks: Block[] }`. Blocks are never nested.
- Block types: `paragraph`, `heading` (level 1–6), `listItem` (`listType` bullet, ordered or task; `indent` 0–5; `checked`; `start` on the first ordered item), `quote`, `code` (`language`, plain text), `raw` (Markdown kept as source, plain text; `syntax` is `html`, `markdown` or an extension's name), `table` (`align` per column; rows of cells; row 0 is the header), `divider`.
- Inline content is an array of spans `{ text, marks, link?, image? }`. Marks are `bold`, `italic`, `strike`, `code` and `html` (inline raw HTML). A hard line break is `"\n"` in the text. An image is the single character U+FFFC with an `image` attribute.
- A position is `{ blockId, offset, cell? }`. `offset` counts UTF-16 code units in the block's (or cell's) plain text. `cell` is `{ row, col }` inside a table.
- Every edit returns new objects for the blocks it touches and reuses the rest. Rendering, history and the React wrapper all depend on this.

Why flat: block editors convert, duplicate, delete and select whole blocks. A flat list makes those operations array edits and gives every block a stable ID for the block menu. The cost is that some Markdown structure has no block form; it is kept as a raw block of source (see "Lowering" below).

## Editing surface and rendering

One `contentEditable` root, not one per block, so native selection crosses block boundaries and Shift+Arrow and select-all work without custom code.

- Each root child is a block element with `data-block-id`. The element marked `data-content` holds the inline content. List markers, checkboxes, the code-language input and other chrome sit outside it with `contenteditable="false"`.
- A table block is `contenteditable="false"`; each cell is its own editing host with `data-row` and `data-col`. Selection does not cross cell boundaries.
- `BlockRenderer.render` reuses the element of every block whose object is unchanged, inserts new elements in order, and removes anything else, including nodes the browser inserted on its own. Ordered list numbers are recomputed after each render and cached per element.
- Loading a document (`new Editor`, `setMarkdown`) builds all elements in a fragment and marks them `content-visibility: auto`, so blocks off screen skip layout. Blocks rendered while editing never get that property: Chrome treats a new `content-visibility` block as skipped until the next frame, and an arrow key pressed before then put the caret in the wrong place (found by the browser tests under load).

## Input pipeline

1. **`beforeinput`, cancelled.** `insertText`, `insertParagraph`, `insertLineBreak`, all `delete*` types, `historyUndo`/`historyRedo` and `format*` map to commands. Word and line deletes use the browser's `getTargetRanges()`, so they follow the platform's word boundaries.
2. **IME composition, not cancelled.** While composing, the editor does not touch the DOM or move the selection, and hides the toolbar. On `compositionend` it compares each block's DOM text with the model, applies the difference as one delete and one insert, and re-renders. A cross-block selection is deleted when composition starts, so a composition always stays inside one block. A committed composition is its own undo step.
3. **Fallback.** Any `input` event the editor did not cancel (some Android keyboards) goes through the same read-back.
4. **`keydown`**: an open menu takes the navigation keys first. Then extension key bindings run in order, ending with `defaultKeymap()` (marks, block types, Mod+K, undo/redo, Tab, submit, Escape). A binding that returns true stops the rest and prevents the browser default. Mod+/ (block menu) and Mod+Shift+V (plain paste) are handled by the editor itself.
   ArrowDown on the last line of a code block, table or divider that ends the document adds an empty paragraph below it, and ArrowUp on the first line of one that starts the document adds one above it (`exitBlock`). Elsewhere the browser moves the caret. A click in the empty space below such a final block also adds a paragraph. Enter three times at the end of a code block still leaves it.
5. **Markdown shortcuts** run after typed text: block rules on a space at the start of a block (`#`, `-`, `*`, `+`, `1.`, `[ ]`, `[x]`, `>`, ` ```lang `, `---`) and inline rules when a closing `*`, `_`, `` ` `` or `~` is typed. Undo restores the typed characters.

Selection: on `selectionchange`, the DOM selection is read into the model. After each change, the model selection is written back to the DOM, only when it differs.

## Undo and redo

Each history entry is a snapshot of `{ doc, selection }` from before a change. Typing within one second is one step. Moving the caret, a committed composition, or any other command starts a new step. `setMarkdown` clears the history.

## UI

- **Popups** are appended to `document.body` with `position: fixed`, so a parent with `overflow: hidden` (a chat input, a modal) does not clip them. They copy the editor's theme variables and flip above the anchor when there is no room below.
- **Suggestion menus** (`suggestion()`) open when their trigger character is typed at the start of a block or after a space, and track the query typed after it. Items may be async; results for an outdated query are dropped. A menu with no items hides but keeps tracking, so it comes back when the query matches again. Suggestions do not open in table cells, code or raw blocks.
- **Slash menu** is a suggestion menu. It opens on `/` (or the full-width `／` from Japanese IMEs) at the start of a block or after a space. Typing filters it. Picking a text type (paragraph, heading, list, quote, code) converts the current block in place and keeps its text; a table or divider goes below the block, or replaces it if empty. It shows "No results" until the query passes three characters with no match, then hides. The menu is a listbox wired to the editor with `aria-activedescendant`. It rebuilds only when the query changes, so a late `selectionchange` does not reset the highlighted item.
- **Block handle** appears on hover next to tables and code blocks only, and follows the caret into them on touch devices. It opens the block menu: Duplicate, Delete and, with the caret in a table cell, row, column and alignment actions. Mod+/ opens the same menu from the keyboard inside those blocks. Other blocks have no handle; they change type through the slash menu or Markdown shortcuts.
- **Formatting toolbar** appears over a non-empty selection: bold, italic, strikethrough, code and link. It does not change block types. Buttons show their state with `aria-pressed`. On touch devices it sits below the selection, away from the native selection menu.

## Extension points

- **Key bindings** (`keymap`): see "Input pipeline".
- **Decorations** (`decorations`): a function from one text container (a paragraph, heading, list item, quote or table cell) to CSS classes on ranges of its text. The context lists the ranges of inline code, links, images and tokens, which `textDecorator` skips. Decorations are computed while rendering a block, so they only run for blocks that changed, and they are wrapped in `span.mbe-deco` elements that the DOM-to-model mapping walks through like mark elements.
- **Widgets** (`addWidget`): elements placed after a block element by the renderer, `contenteditable="false"`, and ignored by input handling. A widget follows its block's ID; when a change removes that block, the widget moves to the nearest earlier remaining block (after `setMarkdown`, the block at the same index). Widgets are not in the document, so they are never saved and undo does not touch them.
- **Paste and drop** (`handlePaste`, `handleDrop`): run before the editor's own handling. `fileHandler` is built on them. Dropped text with no handler is parsed as Markdown and inserted at the drop position.
- **Commands** are pure functions `(state) => state` in `commands.ts`; `editor.run(fn)` applies any of them, and `editor.commands` binds the common ones. `run` treats a command that rebuilt the block list without changing any block as a no-op, so `commands.*` return false when nothing changed.
- **Selections as JSON** are block indexes and offsets. Loading the same Markdown always gives the same blocks, so a stored selection fits after a reload; a value that does not fit is clamped and a value that is not a selection is ignored.

## Clipboard

- **Copy and cut** write `text/plain` as Markdown and `text/html` as rendered HTML. The HTML carries the Markdown in a `data-mbe-markdown` attribute, so copying between editors is lossless.
- **Paste** tries, in order: the editor's own HTML, other `text/html` (`htmlToDoc`, which reads tags and inline styles, including Google Docs' wrapper), then `text/plain` as Markdown. Mod+Shift+V pastes plain text. A URL pasted over a selection becomes a link.

## Markdown

**Parser.** The two-phase algorithm from the CommonMark spec, structured like the reference implementation: phase one builds the block tree line by line; phase two parses inline content with all link reference definitions known. GFM adds tables, task items and strikethrough. All 652 CommonMark 0.31.2 examples and the GFM table, task and strikethrough examples pass, checked by rendering the syntax tree to HTML and comparing with the spec output. Nesting is capped at 100 levels for blocks and for inline brackets, so hostile input cannot overflow the stack.

**Lowering** (`lower.ts`) turns the syntax tree into the flat model. The rules are part of the spec:

- Soft line breaks become spaces; hard line breaks become `"\n"`. With the `breaks` option, soft line breaks become `"\n"` too, and the serializer writes a line break as a plain line ending (a backslash only where a plain one would not read back: after an empty line or a trailing space). The `setext: false` option turns off setext headings in the parser.
- Each list item becomes a `listItem` block with `indent` equal to its nesting depth.
- In a block quote each paragraph becomes one `quote` block.
- Structure the flat model cannot hold is not flattened. A top-level list or quote is kept as one `raw` block with `syntax: 'markdown'`, holding its source, when a quote holds anything but paragraphs, or a list item holds more than one paragraph, any block other than a nested list, or lists nested deeper than five levels. A raw block is shown and edited as source and saved verbatim. (`astToDoc`, which has no source, still flattens these; it is used only by tests.)
- Link titles and reference-style link labels are not kept. Links are saved inline.
- A top-level paragraph holding only a no-break space (`&nbsp;`) becomes an empty paragraph. This is how empty lines are saved (see "Serializer").

**Source-preserving save** (`source.ts`). Loading records, for each top-level Markdown block, its source lines and the model blocks it became (a "group"). Blocks are immutable and every edit replaces the blocks it touches, so a group whose blocks are all still the same objects, in the same order, was not edited. Saving writes such a group's original text, and the original text between two groups that are still neighbours. Other blocks go through the serializer. A kept list or quote next to an edited one is rewritten too, because Markdown would merge them, and so is a code fence without its closing line that is no longer last. Link reference definitions that are no longer written are added at the end, so reference links in kept blocks still resolve. With no edits, saving returns the input byte for byte; a test checks this for every spec example.

**Syntax extensions** (`markdown/options.ts`). An extension can add Markdown syntax that the editor keeps as source, so a renderer that knows it (remark-math, footnotes in remark-gfm) shows it and the editor never breaks it.

- An inline syntax names its trigger characters and a `match(text, pos)` function that returns where the construct ends, or -1. The inline parser tries it before the built-in rules at each trigger character. The match becomes a token span (`span.token` holds the syntax name): shown in a muted monospace style, saved verbatim, and not parsed for emphasis or links.
- A block syntax has an `open(line)` function that returns a matcher, and the matcher's `next(line)` says whether each following line continues the block, closes it (the line is part of it), or ends it (the line is not). `interruptsParagraph` says whether it can start without a blank line before it. The match becomes a `raw` block whose `syntax` is the syntax name.
- `escape` lists characters the serializer must escape in plain text, so typed text cannot start the syntax by accident (math escapes `$`).
- Typing the closing character of an inline construct turns the text into a token span, the same way `**bold**` becomes bold.

`math()` follows memos' rules: an inline opener followed by a space, or a single-dollar closer preceded by a space or followed by a digit, is a plain dollar sign, so "costs $5 and $10" stays text. Block math is a `$$` fence. `footnotes()` adds `[^label]` references and `[^label]: text` definitions.

**Serializer** (`serialize.ts`) writes normalized Markdown for edited and new blocks: `**`, `*`, `~~`, ATX headings, `-` bullets, renumbered ordered lists, fenced code, `---`, GFM tables, tight lists. Markdown has no empty paragraph, so an empty line in the editor is written as `&nbsp;`: it renders as an empty line in any CommonMark renderer and reads back as an empty paragraph. Empty lines at the end of the document render as nothing and are not written. It escapes only characters that would change meaning. Where an escape is not enough, it writes a character reference: for example a letter right after closing bold (`**three!**&#98;`) and a leading or trailing space that would otherwise be trimmed (`&#32;`). The tests check save stability for every spec example.

**Entities.** Named character references (`&copy;`) need the WHATWG list of 2,125 names. Node gets it as a table (`entities.ts`, about 11 KB gzipped). Browsers use their own HTML parser instead (`entities.dom.ts`): it decodes `&name;` inside a detached `<textarea>`, whose content is parsed as text, never as elements. The `#entities` import in `packages/core/package.json` picks the file through the `browser` export condition. A browser test checks that both give the same result for every name.

## React wrapper

`<MarkdownEditor>` creates one `Editor` per mount and forwards its `ref` to it. `onChange` fires at most once per animation frame. The wrapper keeps a short queue of the values it emitted, and calls `setMarkdown` only when a new `value` prop is not one of them, so a parent that re-renders with a slightly stale value does not overwrite newer typing. A new `value` that arrives while an IME is composing is held and applied on `compositionend`. `placeholder`, `editable`, `attributes` and `resolveImageSrc` go through `setOptions`. The editor is recreated, keeping its Markdown, only when the names of its extensions change. `onSubmit(markdown)` receives the current Markdown after flushing pending changes.

`useEditor(options, deps)` creates an editor on a detached element and `<EditorContent>` moves that element into the page, as in Tiptap. Autofocus waits until the element is mounted.

## Performance

Measured in headless Chromium in the development container (`npm run test:perf`):

| Gate (spec) | Result |
| --- | --- |
| Keystroke handling under 16 ms at p95 in a 2,000-block document | 7–8 ms p95, 5 ms median, with a frame between keystrokes |
| 100 KB of Markdown parsed and rendered in under 100 ms | 101–125 ms on a cold first load; about 75 ms when warm |
| Core under 40 KB min+gzip | 33.8 KB for browsers (plus 2.3 KB CSS); 45.4 KB for Node, with the entity table |

What made the difference:

- No `::selection` rule and no sibling selectors in the CSS. Both made every selection update restyle the whole document.
- List indentation uses attribute selectors, not an inline custom property per item. Inline styles stop Chrome from sharing computed styles, which doubled style time on load.
- `content-visibility: auto` on loaded blocks (see "Editing surface").
- Full renders build a fragment and insert it once; read-only state is applied only when it changes.

The cold-load result depends on the JavaScript engine warming up: about half of it is the first parse. The container is shared and noisy, so the number should be re-measured on a typical laptop before deciding whether more work is needed.

## Testing

| Command | What it runs |
| --- | --- |
| `npm test` | 1,448 unit, spec and round-trip tests (vitest, Node). |
| `npm run test:e2e` | 45 browser tests in Chromium: editing, menus, toolbar, links, tables, clipboard, IME, React, entity decoding. |
| `npm run test:perf` | The two timing gates, run alone. |
| `npm run typecheck` | TypeScript in strict mode. |

IME is simulated through the Chrome DevTools Protocol. Real input methods are covered by the manual checklist in `docs/ime-checklist.md`.

## Risks and gaps

- **Only Chromium is tested.** Firefox and WebKit could not be installed in the development container. Safari and Firefox fire composition and `beforeinput` events in a different order, so this is the largest remaining risk. Playwright projects for both should be added where the browsers are available.
- **IME was simulated**, not typed with a real IME. The manual checklist needs an owner before release.
- **Spellcheck and autocorrect** replacements (`insertReplacementText`) are handled but not tested.
- **The cold-load gate** is about 5–25% over in this container (see "Performance").
- **Publishing** needs a build: the `#entities` import and `main` point at TypeScript sources today, and must point at built files in step 4.
