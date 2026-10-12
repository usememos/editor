# Architecture (v0)

How the editor works: the decisions behind it, how the code carries them out, and where to find it.

## Principles

The editor is a block editor whose storage format is Markdown. Every design decision below follows from these five rules. A change that breaks one of them needs a decision recorded here first.

1. **Markdown is the stored format; blocks are the editing model.** Loading parses Markdown into blocks. Every edit is an operation on blocks. Saving writes the blocks back to Markdown. There is no second format (no JSON document) for an app to store.
2. **Every block type has a Markdown form.** The editor adds no block type that CommonMark or GFM cannot write (no toggles, callouts, columns or colored text). Syntax outside CommonMark and GFM enters only through an extension that defines how it is written (see "Syntax extensions"), and is saved exactly as written.
3. **Nothing is lost on save.** Blocks the user did not edit are saved byte for byte. Markdown the block model cannot hold is kept as a raw block, shown as source and saved verbatim, never flattened or dropped.
4. **After parsing, the editor behaves like a block editor.** Whole blocks can be selected, deleted, copied, cut, pasted over, duplicated and changed in type together (see "Block selection"). A block-editor feature is added only when it is needed, and only when its result can be written as Markdown.
5. **Edits are pure functions on immutable blocks.** Each command in `commands.ts` takes a state and returns a new one, replaces only the blocks it changes, and keeps block IDs. Rendering, undo, the React wrapper and source-preserving save all rely on this.

Other products confirm the split behind rules 1 and 2. Editors that keep Markdown as the stored format (Milkdown, MDXEditor, Tiptap's Markdown extension) limit their block types to what Markdown can write. Block editors with types Markdown cannot write (Notion, BlockNote) store their own format, and BlockNote's documentation calls its Markdown export "lossy".

## Summary of decisions

| Area | Decision |
| --- | --- |
| Package | One package, `@usememos/editor`: plain TypeScript with zero runtime dependencies. A thin React wrapper is the `@usememos/editor/react` subpath, with React 18 or later as an optional peer dependency. |
| Document model | A flat list of immutable blocks. Each block has a stable ID. Inline content is a list of text spans with marks, a link or an image. |
| Editing surface | One `contentEditable` root that the editor owns completely. Table cells are nested editing hosts. |
| Input | Cancel `beforeinput` and apply a model command. IME composition is the one exception: the browser edits the DOM, and the editor reads the result back into the model on every `input`. |
| Rendering | Keyed reconciliation. A block whose object did not change keeps its DOM element. |
| Undo | Whole-document snapshots. They are cheap because unchanged blocks are shared. |
| Markdown | Our own CommonMark 0.31.2 + GFM parser and a normalizing serializer. Saving is stable: `serialize(parse(md))` is a fixed point. |
| Public API | Modeled on Tiptap and ProseMirror: `editor.commands`, `isActive`, `getAttributes`, `on()` events, JSON-safe selections, and extensions as plain objects that add syntax, keys, decorations, suggestion menus and input hooks. Markdown is the only content format. |
| UI | Slash menu, block handle and block menu, formatting toolbar, link popover. All plain DOM, styled with CSS custom properties. |

## Source map

| Path | Contents |
| --- | --- |
| `packages/editor/src/model.ts` | Block and span types, constructors, inline helpers, positions. |
| `packages/editor/src/commands.ts` | Every edit as a pure function `(state) => state`. |
| `packages/editor/src/history.ts` | Undo and redo. |
| `packages/editor/src/editor.ts` | The `Editor` class: events, selection sync, menus, clipboard, public API. |
| `packages/editor/src/keymap.ts` | Parsing key names such as `Mod-Shift-x` and matching them to key events. |
| `packages/editor/src/decorations.ts`, `packages/editor/src/widgets.ts` | Text decorations, and app UI placed between blocks. |
| `packages/editor/src/view/dom.ts` | Rendering blocks to DOM, and mapping DOM points to model positions and back. |
| `packages/editor/src/view/reveal.ts` | Which rendered views show their source for a given selection. |
| `packages/editor/src/ui/` | `Popup` and `Menu`, the toolbar and link popover, the block handle. |
| `packages/editor/src/markdown/` | Parser (`blocks.ts`, `inline.ts`, `autolink.ts`, `lower.ts`), serializer (`serialize.ts`), source-preserving save (`source.ts`), dialect options and syntax extensions (`options.ts`), entity tables, and an HTML renderer used only by the spec tests (`html.ts`). |
| `packages/editor/src/clipboard/` | Document to HTML for copy (`toHtml.ts`), pasted HTML to document (`fromHtml.ts`). |
| `packages/editor/src/extension.ts`, `packages/editor/src/extensions/` | The `Extension` interface, and the built-in extensions: `math()`, `footnotes()`, `tags()`, `mentions()`, `suggestion()`, `textDecorator()`, `fileHandler()` and `defaultKeymap()`. |
| `packages/editor/src/theme.ts` | The `theme` option's types, and merging class maps from extensions and the editor. |
| `packages/editor/src/base.css`, `theme.css`, `style.css` | Layout and block spacing; the default look; both together. |
| `packages/editor/src/labels.ts` | Every UI string, for localization. |
| `packages/editor/src/react/index.tsx` | `<MarkdownEditor>`, `useEditor` and `<EditorContent>`. |

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

1. **`beforeinput`, cancelled.** `insertText`, `insertParagraph`, `insertLineBreak`, all `delete*` types, `historyUndo`/`historyRedo` and `format*` map to commands. Word and line deletes use the browser's `getTargetRanges()`, so they follow the platform's word boundaries. So does `insertText` when its target range covers text while the selection is a caret: that is how mobile autocorrect and word suggestions replace a word. `insertParagraph` picks the item of an open suggestion menu, because Android keyboards send Enter with keyCode 229, which `keydown` ignores.
2. **IME composition, not cancelled.** While composing, the editor does not re-render the composed block or move the selection, and hides the toolbar. On each `input` it compares the block's DOM text with the model and applies the difference as one delete and one insert, so `change`, `getMarkdown()`, `isEmpty` and an open suggestion menu follow the composed text (on Android every word is a composition). The renderer adopts the browser's DOM for the new block object instead of rebuilding it, and only updates its empty state, so the placeholder does not cover composed text. Marks stored before composing (Mod+B, then compose) apply to all of the composed text. The first change records one undo step for the whole composition. On `compositionend` the committed text is read once more; the block is rendered from the model on the next frame, so input that arrives after `compositionend` in the same task (Firefox sends the last `input` then) still counts as the composition, and nothing is re-rendered between two compositions in one keystroke (Korean syllables). A cross-block selection is deleted when composition starts, so a composition always stays inside one block.
3. **Fallback.** An `input` event the editor did not cancel goes through the same read-back, and typed text then runs the Markdown shortcuts. A `beforeinput` that cannot be cancelled (from some Android keyboards) for typed text, a replacement, or a deletion inside one text container is left to the browser and read back, so it is not applied twice.
4. **`keydown`**: an open menu takes the navigation keys first. A block selection takes its own keys next (see "Block selection"). Then extension key bindings run in order, ending with `defaultKeymap()` (marks, block types, Mod+K, undo/redo, Tab, submit, Escape). A binding that returns true stops the rest and prevents the browser default. Mod+/ (block menu) and Mod+Shift+V (plain paste) are handled by the editor itself.
   ArrowDown on the last line of a code block, table or divider that ends the document adds an empty paragraph below it, and ArrowUp on the first line of one that starts the document adds one above it (`exitBlock`). Elsewhere the browser moves the caret. A click in the empty space below such a final block also adds a paragraph. Enter three times at the end of a code block still leaves it.
5. **Markdown shortcuts** run after typed text: block rules on a space at the start of a block (`#`, `-`, `*`, `+`, `1.`, `[ ]`, `[x]`, `>`, ` ```lang `, `---`) and inline rules when a closing `*`, `_`, `` ` `` or `~` is typed. Undo restores the typed characters.

Selection: on `selectionchange`, the DOM selection is read into the model. After each change, the model selection is written back to the DOM, only when it differs.

## Block selection

Escape selects the blocks the selection touches as whole blocks: the block with the caret, or every block a text selection crosses. A table, code block or divider is selected the same way. The selected blocks are highlighted (`mbe-block-selected` on each block element, `mbe-block-selecting` on the root).

| Keys | While blocks are selected |
| --- | --- |
| ArrowUp, ArrowDown | Select the block above or below the selection |
| Shift+ArrowUp, Shift+ArrowDown | Extend or shrink the selection by one block |
| Mod+A | Select every block |
| Backspace, Delete | Delete the selected blocks |
| Mod+C, Mod+X | Copy or cut them as Markdown |
| Paste | Replace them with the pasted blocks |
| Mod+D | Duplicate them; the copies become the selection |
| Block type keys, Tab, Shift+Tab, mark keys | Apply to every selected block; the same blocks stay selected |
| Enter | Back to editing text, with the caret at the end of the last selected block |
| ArrowLeft, ArrowRight | Back to editing text, at the start of the first selected block or the end of the last |
| Escape | Leave the editor (the escape hatch from Tab-trapping that memos relies on) |
| Typing | Nothing |

A click in the text, a blur, `setSelection`, `setMarkdown` or turning editing off ends the block selection.

How it works:

- The editor holds the block selection as the IDs of its anchor and head blocks (`blockSel` in `editor.ts`). It is not part of `EditorState`, so commands stay unaware of it.
- While it is set, the model selection spans the selected blocks, from the start of the first to the end of the last (`spanBlocks`). That is why block type, indent and mark commands need no special case: they already act on every block a selection touches. After each change the span is recomputed from the same IDs, which commands keep.
- The browser selection is a collapsed caret at the start of the head block, hidden with `caret-color: transparent`. Focus stays in the editor, so keys still arrive, and there is no native text highlight. Selection changes from the browser are ignored while blocks are selected: the browser may move that caret out of a divider, and a click ends block selection on `mousedown` anyway.
- Delete, duplicate and paste are pure commands on a block range: `deleteBlocks`, `duplicateBlocks` and `replaceBlocks`. Each re-nests list items that would end up deeper than the item above allows, for example the nested items of a deleted parent.
- Copying whole blocks uses `serializeBlocks`, so a selected empty line is copied as `&nbsp;` rather than dropped as trailing whitespace.

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
- **Views** (`views`): a function that renders the source of a token or raw block of one syntax into an element the renderer provides (a span or a div). A token with a view renders as one `contenteditable="false"` atom that counts as many characters as its source (`data-source` holds it), so DOM-to-model mapping and the IME read-back still see the source. A raw block with a view renders as a `contenteditable="false"` block with no content element, like a divider. Which views show their source is a pure function of the state (`view/reveal.ts`): a token that either end of the selection touches (edges included) and a raw block that holds either end, only while editable and focused. The renderer keeps each block's revealed views next to its element and rebuilds a block when they change, the same way it rebuilds a block whose object changed. Every render goes through `Editor.paint`, which recomputes them; selection, focus and editability changes call `refreshRevealed`, which paints only when they differ. While a mouse button is down nothing changes until mouseup, so a drag is not disturbed. A click on a view puts the caret in its source, and an arrow key that would skip a rendered block steps into its source instead. Rendered elements are cached by source (least recently used, 500 entries) and cloned, so typing next to a formula does not re-run the renderer.
- **Widgets** (`addWidget`): elements placed after a block element by the renderer, `contenteditable="false"`, and ignored by input handling. A widget follows its block's ID; when a change removes that block, the widget moves to the nearest earlier remaining block (after `setMarkdown`, the block at the same index). Widgets are not in the document, so they are never saved and undo does not touch them.
- **Paste and drop** (`handlePaste`, `handleDrop`): run before the editor's own handling. `fileHandler` is built on them. Dropped text with no handler is parsed as Markdown and inserted at the drop position.
- **Commands** are pure functions `(state) => state` in `commands.ts`; `editor.run(fn)` applies any of them, and `editor.commands` binds the common ones. `run` treats a command that rebuilt the block list without changing any block as a no-op, so `commands.*` return false when nothing changed.
- **Selections as JSON** are block indexes and offsets. Loading the same Markdown always gives the same blocks, so a stored selection fits after a reload; a value that does not fit is clamped and a value that is not a selection is ignored.

## Styling

`style.css` imports `base.css` (layout the editor needs, and every margin between blocks) and `theme.css` (colors, fonts, borders and backgrounds). `base.css` sets no colors or fonts; its menus use system colors (`Canvas`, `Highlight`) so they stay readable without `theme.css`. Its spacing selectors are at least two classes strong, so a host's single utility class with a margin cannot change the rhythm. The `theme.classes` option adds host classes to elements in the same pass that builds them (`renderBlock`, `wrapMarks`, `renderSpan`), so they apply when editing and when read-only alike. Changing the classes re-renders every block; setting the same classes again does nothing. Colors are `light-dark()` values that read `--mbe-<name>-light` and `--mbe-<name>-dark` with the default palette as fallback, so one rule covers both schemes and `theme.tokens` only sets those variables on the root; `theme.colorScheme` sets the root's `color-scheme`. Neither re-renders. Popups live in `document.body`, so they copy the computed variables and the root's `color-scheme` when they open. The default look styles the document like a rendered Markdown view, and the same rules apply when editing and when read-only: read-only adds no visual change except the pointer cursor on links and checkboxes. Checkboxes use `appearance: none`, so a disabled checkbox is not greyed out by the browser, and the code block language field has the same color when disabled. Every block has the block gap above and below, and vertical margins collapse, so blocks sit one gap apart and a heading's or divider's larger margin wins. Blocks are siblings in one flat list, so list and quote grouping depends on neighbours. The renderer marks it with attributes after each render (`data-list-start` on the first item of a list, including where a numbered list meets a bullet list, and `data-quote-joined` on a quote block that follows another), and the CSS uses those: list items sit 2px apart with the gap around the list, and joined quote blocks show one unbroken bar. See the sibling selector note under Performance. A browser test compares screenshots of the sample document in both modes.

## Clipboard

- **Copy and cut** write `text/plain` as Markdown and `text/html` as rendered HTML. With a block selection they copy the whole blocks. The HTML carries the Markdown in a `data-mbe-markdown` attribute, so copying between editors is lossless.
- **Paste** tries, in order: the editor's own HTML, other `text/html` (`htmlToDoc`, which reads tags and inline styles, including Google Docs' wrapper), then `text/plain` as Markdown. Mod+Shift+V pastes plain text. A URL pasted over a selection becomes a link.

## Markdown

**Parser.** The two-phase algorithm from the CommonMark spec, structured like the reference implementation: phase one builds the block tree line by line; phase two parses inline content with all link reference definitions known. GFM adds tables, task items, strikethrough and autolink literals. A `www.` or `http(s)://` literal is matched where its text run starts, as cmark-gfm does, so it can run over `_` and `&`; e-mail literals are found afterwards in the final text nodes outside links. Typing a space after a literal links it (`applyAutolinkInputRule`), and the serializer writes a literal link bare when the output reads back the same. All 652 CommonMark 0.31.2 examples (checked with `autolinks: false`) and the GFM table, task, strikethrough and autolink examples pass, checked by rendering the syntax tree to HTML and comparing with the spec output. Nesting is capped at 100 levels for blocks and for inline brackets, so hostile input cannot overflow the stack.

**Lowering** (`lower.ts`) turns the syntax tree into the flat model. The rules are part of the spec:

- Soft line breaks become spaces; hard line breaks become `"\n"`. With the `breaks` option, soft line breaks become `"\n"` too, and the serializer writes a line break as a plain line ending (a backslash only where a plain one would not read back: after an empty line or a trailing space). The `setext: false` option turns off setext headings in the parser.
- Each list item becomes a `listItem` block with `indent` equal to its nesting depth.
- In a block quote each paragraph becomes one `quote` block.
- Structure the flat model cannot hold is not flattened. A top-level list or quote is kept as one `raw` block with `syntax: 'markdown'`, holding its source, when a quote holds anything but paragraphs, or a list item holds more than one paragraph, any block other than a nested list, or lists nested deeper than five levels. A raw block is shown and edited as source and saved verbatim.
- A collapsible section, from an HTML block that opens `<details>` to the HTML block that closes it, is one `raw` block with `syntax: 'html'`, holding all its source lines (`detailsEnd` in `source.ts`). CommonMark would end the HTML block at the first blank line and parse what follows as Markdown.
- Link titles and reference-style link labels are not kept. Links are saved inline.
- A top-level paragraph holding only a no-break space (`&nbsp;`) becomes an empty paragraph. This is how empty lines are saved (see "Serializer").

**Source-preserving save** (`source.ts`). Loading records, for each top-level Markdown block, its source lines and the model blocks it became (a "group"). Blocks are immutable and every edit replaces the blocks it touches, so a group whose blocks are all still the same objects, in the same order, was not edited. Saving writes such a group's original text, and the original text between two groups that are still neighbours. Other blocks go through the serializer. A kept list or quote next to an edited one is rewritten too, because Markdown would merge them, and so is a code fence without its closing line that is no longer last. The same check applies to two kept groups that were not neighbours in the source, which happens when the blocks between them are deleted: two lists that now meet are rewritten as one list, and a kept group that starts with indentation right after a list is rewritten so it does not become part of the list's last item. Link reference definitions that are no longer written are added at the end, so reference links in kept blocks still resolve. With no edits, saving returns the input byte for byte; a test checks this for every spec example.

**Syntax extensions** (`markdown/options.ts`). An extension can add Markdown syntax that the editor keeps as source, so a renderer that knows it (remark-math, footnotes in remark-gfm) shows it and the editor never breaks it.

- An inline syntax names its trigger characters and a `match(text, pos)` function that returns where the construct ends, or -1. The inline parser tries it before the built-in rules at each trigger character. The match becomes a token span (`span.token` holds the syntax name): shown in a muted monospace style, saved verbatim, and not parsed for emphasis or links.
- A block syntax has an `open(line)` function that returns a matcher, and the matcher's `next(line)` says whether each following line continues the block, closes it (the line is part of it), or ends it (the line is not). `interruptsParagraph` says whether it can start without a blank line before it. The match becomes a `raw` block whose `syntax` is the syntax name.
- `escape` lists characters the serializer must escape in plain text, so typed text cannot start the syntax by accident (math escapes `$`). Where an inline syntax reads a backslash escape as its own token (`tags()` keeps `\#`), the serializer writes a character reference instead (`&#35;`).
- Typing the closing character of an inline construct turns the text into a token span, the same way `**bold**` becomes bold.

`math({ render })` renders formulas through the host's renderer (the playground uses KaTeX); without `render` math stays source. `math()` follows Pandoc's rules for dollar math: an inline opener followed by a space, or a single-dollar closer preceded by a space or followed by a digit, is a plain dollar sign, so "costs $5 and $10" stays text. Block math is a `$$` fence. `footnotes()` adds `[^label]` references and `[^label]: text` definitions. `tags()` and `mentions()` add no syntax of their own except the `\#` and `\@` escape tokens: tags and mentions are plain text, highlighted by a decorator that scans each run of text with one format separately, so formatting, code, links, images and tokens split or exclude them.

**Serializer** (`serialize.ts`) writes normalized Markdown for edited and new blocks: `**`, `*`, `~~`, ATX headings, `-` bullets, renumbered ordered lists, fenced code, `---`, GFM tables, tight lists. Markdown has no empty paragraph, so an empty line in the editor is written as `&nbsp;`: it renders as an empty line in any CommonMark renderer and reads back as an empty paragraph. Empty lines at the end of the document render as nothing and are not written. It escapes only characters that would change meaning. Where an escape is not enough, it writes a character reference: for example a letter right after closing bold (`**three!**&#98;`) and a leading or trailing space that would otherwise be trimmed (`&#32;`). The tests check save stability for every spec example.

**Entities.** Named character references (`&copy;`) need the WHATWG list of 2,125 names. Node gets it as a table (`entities.ts`, about 11 KB gzipped). Browsers use their own HTML parser instead (`entities.dom.ts`): it decodes `&name;` inside a detached `<textarea>`, whose content is parsed as text, never as elements. The `#entities` import in `packages/editor/package.json` picks the built file through the `browser` condition. In development, aliases in `tsconfig.json`, the playground's Vite config and `vitest.config.ts` point it at the source files instead. A browser test checks that both give the same result for every name.

## React wrapper

`<MarkdownEditor>` creates one `Editor` per mount and forwards its `ref` to it. `onChange` fires at most once per animation frame. The wrapper keeps a short queue of the values it emitted, and calls `setMarkdown` only when a new `value` prop is not one of them, so a parent that re-renders with a slightly stale value does not overwrite newer typing. A new `value` that arrives while an IME is composing is held and applied on `compositionend`. `placeholder`, `editable`, `attributes` and `resolveImageSrc` go through `setOptions`. The editor is recreated, keeping its Markdown, only when the names of its extensions change. `onSubmit(markdown)` receives the current Markdown after flushing pending changes.

`useEditor(options, deps)` creates an editor on a detached element and `<EditorContent>` moves that element into the page, as in Tiptap. Autofocus waits until the element is mounted.

## Performance

Measured on 2026-10-12 in headless Chromium in the development container (`npm run test:perf`; sizes with esbuild, minified, gzip -9, every export):

| Gate (spec) | Result |
| --- | --- |
| Keystroke handling under 16 ms at p95 in a 2,000-block document | 13.4 ms p95, 8.7 ms median, with a frame between keystrokes. Pass. |
| 100 KB of Markdown parsed and rendered in under 100 ms | 211–221 ms on a cold first load. Fail. It was 101–125 ms at v0. |

Bundle size has no fixed limit. The goal is a normal size for a Markdown editor, not the smallest possible one, so check the size when a change adds a lot of code. Today the core is 45.9 KB min+gzip for browsers plus 3.0 KB of CSS (33.8 KB at v0, before the extensions, theme and autolinks), and the React entry is 1.2 KB.

What made the difference:

- No `::selection` rule and no sibling selectors in the CSS. Both made every selection update restyle the whole document. A `+` rule that can match any block also made each keystroke restyle and re-lay out every block after the caret (typing p95 went from about 10 ms to 25 ms in the 2,000-block test), so spacing that depends on the block above comes from attributes the renderer sets (see Styling).
- List indentation uses attribute selectors, not an inline custom property per item. Inline styles stop Chrome from sharing computed styles, which doubled style time on load.
- `content-visibility: auto` on loaded blocks (see "Editing surface").
- Full renders build a fragment and insert it once; read-only state is applied only when it changes.

The cold-load result depends on the JavaScript engine warming up: about half of it is the first parse. The container is shared and noisy, so the number should be re-measured on a typical laptop before deciding whether more work is needed.

## Testing

| Command | What it runs |
| --- | --- |
| `npm test` | Unit, spec and round-trip tests (vitest, Node), including every example in `docs/syntax.md`. |
| `npm run test:e2e` | Browser tests in Chromium: editing, block selection, menus, toolbar, links, tables, clipboard, IME, extensions, themes, React, entity decoding. |
| `npm run test:e2e:themed` | The same browser tests with a class on every `theme.classes` key, to show theme classes change no behavior. |
| `npm run test:perf` | The two timing gates, run alone. |
| `npm run typecheck` | TypeScript in strict mode. |
| `npm run build` | The published files in `packages/editor/dist`: ES modules bundled with esbuild (`index.js`, `react.js`, the two entity files), the stylesheets, and type declarations from `tsc`. |

CI (`.github/workflows/ci.yml`) runs the typecheck, unit tests, build and the Chromium and themed browser tests on every push to main and every pull request. The timing gates are left out because shared runners are too noisy for them.

IME is simulated through the Chrome DevTools Protocol. Real input methods are covered by the manual checklist in `docs/ime-checklist.md`.

## Risks and gaps

- **Only Chromium is tested.** Firefox and WebKit could not be installed in the development container. Safari and Firefox fire composition and `beforeinput` events in a different order, so this is the largest remaining risk. Playwright projects for both should be added where the browsers are available.
- **IME was simulated**, not typed with a real IME. `e2e/ime.spec.ts` drives composition through the Chrome DevTools Protocol and dispatches the events mobile keyboards send; `docs/ime-checklist.md` lists what still needs a real device. The manual checklist needs an owner before release.
- **Spellcheck and autocorrect** replacements (`insertReplacementText`) are handled but not tested.
- **The load-time gate fails** (see "Performance"). Load time should be measured on a laptop before deciding what to optimize.
