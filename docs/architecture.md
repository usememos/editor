# Architecture note (step 1)

Status: prototype done. This note records the core decisions for the editor, what the prototype proved, and what is still open.

## Summary of decisions

| Area | Decision |
| --- | --- |
| Packages | `@editor/core` (plain TypeScript, zero runtime dependencies) and `@editor/react` (thin wrapper, React as a peer dependency). Package names use the working name `editor`; the final name is deferred. |
| Document model | A flat list of immutable blocks. Each block has a stable ID and inline content made of text spans with marks. |
| Editing surface | One `contentEditable` root that the editor owns completely. |
| Input | Cancel `beforeinput` and apply a model command. IME composition is the one exception: let the browser edit the DOM, then read the result back on `compositionend`. |
| Rendering | Keyed reconciliation by block ID. A block whose object did not change keeps its DOM element. |
| Undo | Whole-document snapshots. They are cheap because unchanged blocks are shared. Typing within one second is grouped into one undo step. |
| Markdown | Our own parser and serializer. Saving keeps the content but normalizes formatting. |

## Packages

- `core` contains the model, commands, Markdown parser and serializer, the view, and (in step 3) the default slash menu and block-handle UI. It has no dependencies.
- `react` (step 3) exposes `<MarkdownEditor value onChange />`. It creates one `Editor` instance per mount, and calls `setMarkdown` only when the `value` prop differs from the last Markdown the editor emitted. This prevents controlled-input loops.

Core API as of the prototype:

```ts
const editor = new Editor(element, { value, onChange, placeholder });
editor.getMarkdown();
editor.setMarkdown(markdown);
editor.run((state) => commands.setBlockType(state, { type: 'heading', level: 2 }));
editor.toggleMark('bold');
editor.undo(); editor.redo();
editor.destroy();
```

## Document model

`packages/core/src/model.ts`

- A document is `{ blocks: Block[] }`. Blocks are never nested in the model.
- Inline content is an array of `{ text, marks }` spans. Marks are `bold`, `italic`, `strike` and `code`. Links will be a mark with an `href` attribute.
- A caret position is `{ blockId, offset }`, where `offset` counts UTF-16 code units in the block's plain text.
- Every edit returns new objects for the blocks it touches and reuses the rest. The view and history both depend on this.

Why the model is flat: block editors move, convert and select whole blocks. A flat list makes those operations simple array edits, and gives every block a stable ID for the block handle menu.

How the remaining v0 blocks will map onto the flat model (planned for step 3):

| Markdown | Block |
| --- | --- |
| Bullet, ordered and task list items | One `listItem` block per item, with `listType`, `indent` and `checked`. The serializer groups adjacent items back into lists. |
| Block quote | A `quote` block with inline content. |
| Fenced or indented code | A `code` block with `language` and plain text. In this block, Enter inserts a newline. |
| GFM table | A `table` block with rows of cells, each cell holding inline content, plus column alignment. Positions inside a table gain a cell index. |
| Thematic break | A `divider` block with no content. |

## Editing surface

The editor uses one `contentEditable` root, not one per block. With one root, native selection can cross block boundaries, so selecting across paragraphs, Shift+Arrow, and select-all work without custom code. One editable per block (the other common approach) makes cross-block selection a custom feature.

The root's children are block elements (`<p>`, `<h1>`…) marked with `data-block-id`. The editor rebuilds any child it did not create, so the DOM never drifts from the model.

## Input pipeline

`packages/core/src/editor.ts`

1. **`beforeinput`, cancelled.** `insertText`, `insertParagraph`, all `delete*` types, `historyUndo`/`historyRedo` and `format*` are mapped to model commands. For word and line deletes, the editor uses the browser's `getTargetRanges()`, so it follows the platform's own word boundaries.
2. **IME composition, not cancelled.** Browsers do not allow cancelling composition. While a composition is in progress, the editor does not touch the DOM. On `compositionend`, it compares each block's DOM text with the model text, turns the difference into one delete and one insert, and re-renders. If the selection spans blocks when composition starts, the selection is deleted first so the composition always happens inside one block.
3. **Fallback.** Any `input` event the editor did not cancel (some Android keyboards) goes through the same DOM read-back as composition.
4. **Keyboard shortcuts** are handled in `keydown`: undo/redo, Mod+B/I/E and Mod+Shift+X.
5. **Markdown shortcuts.** Typing `#`…`######` and a space at the start of a paragraph turns it into a heading. Undo restores the typed characters. Shortcuts for lists, quotes, code and dividers follow in step 3.

Selection: on `selectionchange`, the DOM selection is read into the model. After each change, the model selection is written back to the DOM. Mapping uses text offsets within a block element.

## Undo and redo

`packages/core/src/history.ts`

- Each entry is a snapshot of `{ doc, selection }` before a change.
- Consecutive typing within one second is one step. Moving the caret, a committed IME composition, or any non-typing command starts a new step.

## Clipboard

- Copy and cut put the selection on the clipboard as Markdown (`text/plain`).
- Paste parses `text/plain` as Markdown. A single pasted block merges into the current block. Several blocks split the current block around them.
- Pasting `text/html` (from web pages and Google Docs) is planned for step 3.

## Markdown parser and serializer

`packages/core/src/markdown/`

- The inline parser implements the CommonMark delimiter-run algorithm for `*` and `_` (including the "rule of three"), code spans, backslash escapes, and GFM `~~` strikethrough.
- The block parser in the prototype handles ATX headings, setext headings and paragraphs only. Step 3 replaces it with the full CommonMark two-phase block parser plus GFM tables and task lists, tested against the CommonMark spec examples.
- The serializer writes `**bold**`, `*italic*`, `~~strike~~`, ATX headings, and one blank line between blocks. It escapes characters that would otherwise change meaning, and moves whitespace out of marked runs (`**foo **bar` is not valid bold).

Normalization on save (accepted, per the agreed scope):

- `__bold__` becomes `**bold**`, `_em_` becomes `*em*`, setext headings become ATX headings.
- Soft line breaks inside a paragraph become spaces. Hard line breaks also become spaces until they are added to the model.
- Empty paragraphs are dropped, because Markdown cannot represent them.
- Leading and trailing spaces in a paragraph are dropped by the parser.

## What the prototype proved

Run `npm test` (33 unit tests) and `npm run test:e2e` (12 browser tests in Chromium). All pass.

Browser tests drive the real editor with keyboard events and cover:

- typing, Enter in the middle and at the end of a block, Backspace and Delete merging blocks
- the `## ` heading shortcut, Backspace at the start of a heading, and undo/redo of each step
- Ctrl+B for the next typed text and for a selection
- typing over a selection that spans three blocks
- Ctrl+Backspace word deletion through `getTargetRanges()`
- pasting multi-block Markdown
- IME composition (Japanese and Korean, simulated through the Chrome DevTools Protocol), inside bold text, and over a cross-block selection
- Backspace on an emoji with a skin-tone modifier removes the whole emoji

## Risks and gaps

- **Only Chromium is tested.** Safari and Firefox fire composition and `beforeinput` events in a different order. Safari's `insertFromComposition` in particular needs testing. This is the largest remaining risk.
- **IME was simulated**, not typed with a real IME on a real OS. Real Chinese and Japanese IMEs, plus Android Gboard and iOS keyboards, need manual testing before v0 ships.
- **Spellcheck and autocorrect** replacements (`insertReplacementText`) are handled but not tested.
- **Performance** is not measured. Snapshot history and keyed rendering should handle documents of a few thousand blocks; this needs a benchmark in step 3.
- **Serializer edge case:** emphasis next to punctuation inside a word, such as `a**"b"**c`, does not parse back as bold. This needs a fallback in step 3.

## Open questions

| Question | Suggested owner / next step |
| --- | --- |
| Final npm package names and repo name | Bob |
| Should hard line breaks (Shift+Enter) be in v0? Today Shift+Enter splits the block. | Bob, decide in the spec (step 2) |
| Should pasting `text/html` be in v0, or only Markdown and plain text? | Bob, decide in the spec (step 2) |
| Which browsers and versions v0 supports (proposed: the last two versions of Chrome, Edge, Firefox and Safari, plus iOS Safari and Android Chrome) | Bob, confirm in the spec (step 2) |
| How to test Safari and Firefox in CI | Claude, add Playwright WebKit and Firefox runs in step 3 |
