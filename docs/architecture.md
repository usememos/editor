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
| `packages/core/src/markdown/` | Parser (`blocks.ts`, `inline.ts`, `lower.ts`), serializer (`serialize.ts`), entity tables, and an HTML renderer used only by the spec tests (`html.ts`). |
| `packages/core/src/clipboard/` | Document to HTML for copy (`toHtml.ts`), pasted HTML to document (`fromHtml.ts`). |
| `packages/core/src/labels.ts` | Every UI string, for localization. |
| `packages/react/src/index.tsx` | `<MarkdownEditor>`. |

## Document model

- A document is `{ blocks: Block[] }`. Blocks are never nested.
- Block types: `paragraph`, `heading` (level 1–6), `listItem` (`listType` bullet, ordered or task; `indent` 0–5; `checked`; `start` on the first ordered item), `quote`, `code` (`language`, plain text), `html` (raw HTML block, plain text), `table` (`align` per column; rows of cells; row 0 is the header), `divider`.
- Inline content is an array of spans `{ text, marks, link?, image? }`. Marks are `bold`, `italic`, `strike`, `code` and `html` (inline raw HTML). A hard line break is `"\n"` in the text. An image is the single character U+FFFC with an `image` attribute.
- A position is `{ blockId, offset, cell? }`. `offset` counts UTF-16 code units in the block's (or cell's) plain text. `cell` is `{ row, col }` inside a table.
- Every edit returns new objects for the blocks it touches and reuses the rest. Rendering, history and the React wrapper all depend on this.

Why flat: block editors convert, duplicate, delete and select whole blocks. A flat list makes those operations array edits and gives every block a stable ID for the block menu. The cost is that some Markdown structure is flattened on load; see "Lowering" below.

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
4. **`keydown`** handles shortcuts (marks, Mod+K, Mod+/, undo/redo, Tab, Mod+Enter) and menu navigation.
5. **Markdown shortcuts** run after typed text: block rules on a space at the start of a block (`#`, `-`, `*`, `+`, `1.`, `[ ]`, `[x]`, `>`, ` ```lang `, `---`) and inline rules when a closing `*`, `_`, `` ` `` or `~` is typed. Undo restores the typed characters.

Selection: on `selectionchange`, the DOM selection is read into the model. After each change, the model selection is written back to the DOM, only when it differs.

## Undo and redo

Each history entry is a snapshot of `{ doc, selection }` from before a change. Typing within one second is one step. Moving the caret, a committed composition, or any other command starts a new step. `setMarkdown` clears the history.

## UI

- **Popups** are appended to `document.body` with `position: fixed`, so a parent with `overflow: hidden` (a chat input, a modal) does not clip them. They copy the editor's theme variables and flip above the anchor when there is no room below.
- **Slash menu** opens on `/` (or the full-width `／` from Japanese IMEs) at the start of a block or after a space. Typing filters it. It closes when the query passes three characters with no match. The menu is a listbox wired to the editor with `aria-activedescendant`. It rebuilds only when the query changes, so a late `selectionchange` does not reset the highlighted item.
- **Block handle** appears on hover next to tables and code blocks only, and follows the caret into them on touch devices. It opens the block menu: Duplicate, Delete and, with the caret in a table cell, row, column and alignment actions. Mod+/ opens the same menu from the keyboard inside those blocks. Other blocks have no handle; they change type through the slash menu or the toolbar's Turn into dropdown.
- **Formatting toolbar** appears over a non-empty selection: a Turn into dropdown, bold, italic, strikethrough, code and link. Buttons show their state with `aria-pressed`. On touch devices it sits below the selection, away from the native selection menu.

## Clipboard

- **Copy and cut** write `text/plain` as Markdown and `text/html` as rendered HTML. The HTML carries the Markdown in a `data-mbe-markdown` attribute, so copying between editors is lossless.
- **Paste** tries, in order: the editor's own HTML, other `text/html` (`htmlToDoc`, which reads tags and inline styles, including Google Docs' wrapper), then `text/plain` as Markdown. Mod+Shift+V pastes plain text. A URL pasted over a selection becomes a link.

## Markdown

**Parser.** The two-phase algorithm from the CommonMark spec, structured like the reference implementation: phase one builds the block tree line by line; phase two parses inline content with all link reference definitions known. GFM adds tables, task items and strikethrough. All 652 CommonMark 0.31.2 examples and the GFM table, task and strikethrough examples pass, checked by rendering the syntax tree to HTML and comparing with the spec output. Nesting is capped at 100 levels for blocks and for inline brackets, so hostile input cannot overflow the stack.

**Lowering** (`lower.ts`) turns the syntax tree into the flat model. The rules are part of the spec:

- Soft line breaks become spaces; hard line breaks become `"\n"`.
- Each list item becomes a `listItem` block with `indent` equal to its nesting depth (capped at 5). Paragraphs in one item are joined with `"\n"`. Other blocks inside an item follow it as top-level blocks.
- In a quote, each paragraph becomes a `quote` block. Other structure in a quote (nested quotes, lists, headings, code) is flattened to text lines.
- Link titles and reference-style link labels are not kept. Links are saved inline.

**Serializer** (`serialize.ts`) writes normalized Markdown: `**`, `*`, `~~`, ATX headings, `-` bullets, renumbered ordered lists, fenced code, `---`, GFM tables, tight lists. It escapes only characters that would change meaning. Where an escape is not enough, it writes a character reference: for example a letter right after closing bold (`**three!**&#98;`) and a leading or trailing space that would otherwise be trimmed (`&#32;`). The tests check save stability for every spec example.

**Entities.** Named character references (`&copy;`) need the WHATWG list of 2,125 names. Node gets it as a table (`entities.ts`, about 11 KB gzipped). Browsers use their own HTML parser instead (`entities.dom.ts`): it decodes `&name;` inside a detached `<textarea>`, whose content is parsed as text, never as elements. The `#entities` import in `packages/core/package.json` picks the file through the `browser` export condition. A browser test checks that both give the same result for every name.

## React wrapper

`<MarkdownEditor>` creates one `Editor` per mount and forwards its `ref` to it. `onChange` fires at most once per animation frame. The wrapper keeps a short queue of the values it emitted, and calls `setMarkdown` only when a new `value` prop is not one of them, so a parent that re-renders with a slightly stale value does not overwrite newer typing. `onSubmit(markdown)` receives the current Markdown after flushing pending changes.

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
