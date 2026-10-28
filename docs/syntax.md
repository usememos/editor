# Markdown syntax

This is the specification of the Markdown the editor reads and writes: each block and inline construct, how it appears in the editor, and how it is saved. It also specifies the built-in syntax extensions and how `#tag` and `@mention` are handled.

## Conformance

- The parser follows **CommonMark 0.31.2** and the **GFM** extensions for tables, task list items, strikethrough and autolink literals, plus GitHub's alerts.
- All 652 CommonMark 0.31.2 spec examples produce the reference HTML with `autolinks: false` (`test/spec.test.ts`).
- All GFM table, task list item, strikethrough and autolink spec examples produce the reference HTML (`test/spec.test.ts`).
- Beyond the spec examples, `test/conformance` checks 1,032 inputs, including GitHub's own rendering of GFM edge cases, against other renderers. `test/conformance/known-failures.json` lists where the editor differs today and why.
- Loading and saving with no edits returns the input byte for byte, for every spec example (`test/source.test.ts`).
- Saving is stable: `serialize(parse(md))` is a fixed point for every spec example (`test/roundtrip.test.ts`).
- Extension syntax is saved exactly as written, whether or not its block was edited (`test/dialect.test.ts`, `test/tags.test.ts`).
- Every example in this document, and unusual cases for each section, load, save and highlight as specified (`test/syntax.test.ts`, `e2e/syntax.spec.ts`).

## Dialect options

The `markdown` editor option sets the dialect.

| Option | Default | Effect |
| --- | --- | --- |
| `breaks` | `false` | `true`: a single newline inside a paragraph is a line break, saved as a plain newline. `false`: a single newline is a CommonMark soft break, which loads as a space. |
| `setext` | `true` | `false`: `Title` followed by `---` is a paragraph and a divider, not a heading. |
| `autolinks` | `true` | `false`: bare URLs and e-mail addresses are plain text. See [Autolink literals](#autolink-literals). |
| `callouts` | `true` | `false`: a GitHub alert such as `> [!NOTE]` is a plain quote whose text starts with `[!NOTE]`. See [Callouts](#callouts). |
| `details` | `true` | `false`: `<details>` is raw HTML, not a collapsible section. See [Collapsible sections](#collapsible-sections). |
| `syntax` | `[]` | Syntax extensions, usually set through extensions such as `math()` and `footnotes()`. |

Examples in this document use the defaults unless they say otherwise. The playground uses `breaks: true`, `setext: false`, `math()`, `footnotes()`, `tags()` and `mentions()`.

## Loading and saving

- Markdown loads into a flat list of blocks (see [architecture.md](architecture.md#document-model)). Blocks are never nested; list nesting is an `indent` number from 0 to 5.
- **Unedited content is saved byte for byte.** Each top-level Markdown block keeps its original text until one of the blocks it became is edited.
- **Edited and new blocks are saved in a normalized form**, listed in the "Saved as" columns below. An edit to one list item rewrites that whole list. An edit to one paragraph of a quote rewrites that whole quote.
- Markdown that the flat model cannot hold, and HTML, is kept as source in a raw block. It is shown and edited as text and saved verbatim.

## Block syntax

| Construct | Example | Loads as | Saved as (after an edit) |
| --- | --- | --- | --- |
| Paragraph | `Hello world` | `paragraph` | Same |
| Empty line | `&nbsp;` on its own | empty `paragraph` | `&nbsp;` |
| ATX heading | `## Title` | `heading`, level 2 | Same |
| Setext heading | `Title` then `===` | `heading`, level 1 | `# Title` |
| Thematic break | `---`, `***`, `___` | `divider` | `---` |
| Bullet list | `- a`, `* a`, `+ a` | `listItem`, `bullet` | `- a` |
| Ordered list | `1. a`, `1) a` | `listItem`, `ordered`, `start` on the first item | `1. a`, numbered from the start |
| Task list | `- [ ] a`, `- [x] a`, `- [X] a` | `listItem`, `task`, `checked` | `- [ ] a`, `- [x] a` |
| Nested list | `- a` then `    - b` | `listItem` with `indent` 0 to 5 | Indented to the parent's content column |
| Block quote | `> a` | one `quote` per paragraph | `> a` |
| Empty quote | `> &nbsp;` | empty `quote` | `> &nbsp;` |
| Callout (GitHub alert) | `> [!NOTE]` then `> a` | one `quote` per paragraph, each with `callout: "note"` | `> [!NOTE]` then `> a` |
| Collapsible section | `<details>`, `<summary>T</summary>`, Markdown, `</details>` | `details` (the title), the blocks inside, `detailsEnd` | See [Collapsible sections](#collapsible-sections) |
| Fenced code | ` ```js ` … ` ``` ` | `code`, `language: "js"` | Backtick fence, language only |
| Indented code | four spaces, then code | `code`, no language | Backtick fence |
| HTML block | `<div>hi</div>`, `<!-- c -->` | `raw`, `syntax: "html"` | Verbatim |
| Table (GFM) | see [Tables](#tables) | `table`, `align` per column | Normalized delimiter row |
| Link reference definition | `[r]: https://x "T"` | No block; links that use it resolve | Not written; links are saved inline |
| Structure the model cannot hold | see [Structure kept as source](#structure-kept-as-source) | `raw`, `syntax: "markdown"` | Verbatim |

### Paragraphs and line breaks

```md
First line
second line
```

- Default: one paragraph, `First line second line`. An edited paragraph is saved on one line.
- With `breaks: true`: one paragraph with a line break between the lines, saved with a plain newline.

A hard line break is a backslash or two trailing spaces at the end of a line. Both load as a line break. An edited one is saved as a backslash, or as a plain newline with `breaks: true`.

```md
a\
b
```

### Empty lines

An empty paragraph is saved as a paragraph holding only `&nbsp;`. It renders as an empty line in any CommonMark renderer and loads back as an empty paragraph. Empty paragraphs at the end of the document are not saved. An empty quote is saved the same way, as `> &nbsp;`, wherever it is.

```md
Above

&nbsp;

Below
```

### Headings

```md
# Heading 1
###### Heading 6
## Notes #
```

- Levels 1 to 6. A trailing run of `#` is the closing sequence and is not part of the text: `## Notes #` is the heading "Notes".
- Setext headings (`Title` underlined with `===` or `---`) load as levels 1 and 2 and are saved as ATX headings. With `setext: false` they are not recognized.
- `#tag`, with no space after `#`, is not a heading. It is a paragraph that starts with a tag.

### Lists

```md
- Bullet
    - Nested bullet
1. Numbered
2. Numbered
- [ ] Open task
- [x] Done task
```

- Each item is one `listItem` block. `indent` is the nesting depth, 0 to 5.
- A list item holds one paragraph and, optionally, nested lists. Anything else makes the whole top-level list a raw Markdown block.
- Loose lists (blank lines between items) load as the same blocks and are saved tight.
- An ordered list keeps its start number: `3. a` then `4. b` is saved as `3. a` then `4. b`.
- A task item starts with `[ ]`, `[x]` or `[X]`; a tab or a line break in the brackets is `[ ]` too, as in GFM. `- [ ]` with nothing after it is an empty task item, as in the memos server. GitHub shows it as the text `[ ]`.

### Block quotes

```md
> First paragraph
>
> Second paragraph
```

Each paragraph in a quote becomes one `quote` block. Adjacent quote blocks are saved as one quote, with a `>` line between paragraphs. Two quotes with a blank line between them stay two quotes: the first block of the second has `quoteStart`, and they are saved with the blank line.

Every other block in a quote becomes its own block with `quote: true` (and `callout` in a callout): a heading, a code block, a table, a divider, an HTML block, an extension's block, and each item of a list, as below. Each is edited as that kind of block, inside the quote, and saved with `> ` before every line. Only a quote inside a quote, or a list the model cannot hold, becomes a raw Markdown block, with `quote: true` as well: the blocks around it in the quote stay blocks (see [Structure kept as source](#structure-kept-as-source)).

```md
> ## Heading in a quote
>
> | Habit | Minutes |
> | --- | --- |
> | Walk | 20 |
>
> ```js
> const room = plan.filter((slot) => !slot.busy);
> ```
```

A list in a quote becomes `listItem` blocks with `quote: true`, next to the quote's paragraphs:

```md
> ✏️ **Quick note**
> - Item 1: check xyz
> - Item 2: check abc
```

- Adjacent quote blocks and quoted list items are one quote. They are saved as one blockquote: the paragraphs and the list as they are saved outside a quote, with `> ` before every line. An edited block of a quote has a `>` line between it and the next: `> ✏️ **Quick note!**`, `>`, `> - Item 1: check xyz`.
- Editing one block of a quote rewrites only that block (a list counts as one block: all its items). The other blocks of the quote are saved as they were written, with the lines between them; a callout's marker line stays as written while the block after it is unchanged.
- A list in a quote follows the rules of other lists: one paragraph per item, nested lists up to six levels. A list that breaks them is kept as one raw Markdown block inside the quote; the rest of the quote stays blocks.
- A list in a quote and a list outside it are separate lists, saved with a blank line between.

### Callouts

```md
> [!TIP]
> First paragraph
>
> Second paragraph
```

A blockquote whose first line is `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]` or `[!CAUTION]` is a callout, as on GitHub. The marker is case-insensitive and must be alone on its line; trailing spaces are allowed.

- Each paragraph becomes a `quote` block with `callout` set to the type in lowercase (`"tip"`). The marker is not part of the text.
- A list in a callout becomes list items with `quote: true` and the same `callout`, as in a quote.
- Adjacent quote blocks and quoted list items with the same `callout` are one blockquote. A different type, a plain quote, or a block with `quoteStart` starts a new one, saved after a blank line.
- A callout that starts with a list is saved with the list right after the marker line (`> [!NOTE]`, then `> - a`). A list that cannot follow a line of text directly (an empty item, or numbered from other than 1) gets a `>` line before it.
- An edited callout is saved with the marker in capitals, on its own line: `> [!TIP]`. An unedited one keeps its original spelling.
- A marker with nothing after it (`> [!TIP]` alone) is an empty callout, saved as `> [!TIP]` then `> &nbsp;`.
- Not callouts: `> [!NOTE] text` (text on the marker's line), an unknown type such as `> [!FYI]`, and a marker after the first line. They stay plain quotes.
- A plain quote whose first line is a marker reads back as a callout. There is no escape for it, because escaping the `[` gives the same text.

### Code blocks

````md
```ts
const x = 1;
```
````

- Fenced code (backticks or tildes) and indented code both load as `code`.
- Only the first word of the info string is kept as `language`: ` ```js title ` is saved as ` ```js `.
- The content is plain text. No inline syntax, decorations or autocomplete popups apply inside.

### Tables

```md
| Left | Center | Right |
| :--- | :----: | ----: |
| 1    | 2      | 3     |
```

- Row 0 is the header. Each column has an alignment: `left`, `center`, `right` or none.
- A row with fewer cells than the header gets empty cells. As in cmark-gfm, a table ends at a row that would bring the empty cells added in the document past a limit (the document's length in characters, and at least 65,536), so a wide header over many short rows cannot make loading slow.
- Cells hold inline content. A line break in a cell is saved as `&#10;`, because a table row cannot span lines.
- An edited table is saved with one space around each cell and a delimiter row of `---`, `:--`, `:-:` or `--:`.
- A `|` in a cell is saved as `\|`, in code spans too, because GFM splits a row into cells before it reads code spans. A `|` right after an odd number of backslashes in a code span cannot be written that way (`` `a\|` `` would end the cell), so it is saved outside the code span: code `a\|b` is saved as `` `a\`\|`b` ``.

### HTML blocks

An HTML block (`<div>`, `<!-- comment -->` and the other CommonMark HTML block starts) loads as a raw block with `syntax: "html"`. It is edited as source and saved verbatim. The editor never renders HTML itself: with an `html` view (see [Extensions](../README.md)) it shows rendered, otherwise as source.

An **HTML section**, an element whose opening and closing tags are in different HTML blocks, loads as **one** raw HTML block, from the line that opens the element to the line that closes it, including blank lines, Markdown and nested sections inside. Centered content is a common case:

```markdown
<div align="center">

**Release notes**

</div>
```

CommonMark ends an HTML block at a blank line, so this example is three blocks to a renderer: the opening HTML, a paragraph, and the closing `</div>`. The editor joins them so the section stays together when blocks around it are edited, selected or deleted. The saved text is the same either way.

- `<details>` written as the editor saves it is a [collapsible section](#collapsible-sections) instead, edited as blocks. Any other element counts: `<details>` in other shapes or with `details: false`, `<div align="center">`, `<p align="center">`, a `<td>` with a list in it, `<blockquote>`, `<section>`.
- A section opens at an HTML block that leaves an element open and ends at the HTML block that closes it. A closing tag closes the elements opened inside it too, as in a browser (`<div><span>` … `</div>`). Void elements (`<img>`, `<br>`), self-closing tags and comments leave nothing open.
- Only HTML blocks count. A closing tag inside a paragraph (`text</div>`) is inline HTML, so it does not close a section. An element that is never closed is not joined.
- Rendered, a section reads as on GitHub: the `html` view gets the section's HTML, and the Markdown between the tags renders as the editor's own blocks inside the element, with footnotes, tags, math and code highlighting as anywhere else. Clicking a section while editing shows its source.
- Markdown between tags on the same lines, without blank lines around it (`<td>**x**</td>`), is part of the HTML block and stays HTML, as in CommonMark.

### Collapsible sections

A `<details>` element is a collapsible section when its opening tag and its `<summary>` are an HTML block of their own, and its `</details>` starts a later HTML block:

```markdown
<details open>
<summary>Release notes</summary>

- Fixed sync
- Faster search

</details>
```

- It loads as a `details` block (the title, with `open: true` for `<details open>`), the blocks between the tags as ordinary blocks, and a `detailsEnd` block. Sections nest.
- The title is plain text. Character references in it are decoded (`&amp;` loads as `&`), and `&`, `<` and `>` are escaped when it is saved.
- The opening tag may have `open` in any HTML spelling (`open`, `open=""`, `open="open"`, any case) and nothing else. A `<summary>` with markup in it, a section on one line, an empty section with no blank line, and a `<details>` that is never closed are not sections: they stay raw HTML, as in [HTML blocks](#html-blocks).
- An edited title is saved as `<details>` or `<details open>`, then `<summary>Title</summary>` on the next line. An unedited one keeps its original text. `</details>` is saved after a blank line.
- Whether a section is shown collapsed is not saved: `open` keeps the value it was loaded with, and a new section has none. Renderers show a section without `open` collapsed.

### Structure kept as source

The whole top-level list is kept as one raw block with `syntax: "markdown"` when:

- a list item holds more than one paragraph, or any block other than a nested list;
- lists nest more than six levels deep.

Inside a quote, only the block the model cannot hold is kept as source, as a raw block with `quote: true`: a quote inside the quote, or a list that breaks the rules above. Its source is the lines as they are inside the quote, without the quote markers; saving puts them back. The blocks around it in the quote stay blocks.

Each of these examples loads as one raw Markdown block:

```md
- Item

  Second paragraph in the same item
```

In this quote, the middle block is a raw block with `quote: true` holding `> A quote inside the quote`, and the two paragraphs are `quote` blocks:

```md
> Text
>
> > A quote inside the quote
>
> More text
```

A raw Markdown block is shown rendered, with the editor's own blocks: a quote or list item the model cannot hold is drawn as a container around its blocks, and a GitHub alert as a callout. While editing, the caret in the block, or a click on it, shows its source, which is edited as plain text. Read-only, it always shows rendered. An extension's own `markdown` view replaces this rendering.

### Block typing shortcuts

Typed at the start of a paragraph. Undo, or Backspace right after the shortcut, restores the typed characters.

| Type | Becomes |
| --- | --- |
| `# ` to `###### ` | Heading, level 1 to 6; in a quote or callout, a heading in it |
| `- `, `* `, `+ ` | Bullet list item; in a quote or callout, a list item in it |
| `1. `, `1) ` | Ordered list item, starting at that number; in a quote or callout, a list item in it |
| `[ ] `, `[x] ` | Task list item (also at the start of a bullet item); in a quote or callout, a list item in it |
| `> ` | Quote; nothing in a quote, which holds no quote |
| `[!note] `, `[!tip] `, `[!important] `, `[!warning] `, `[!caution] ` (any case) | Callout of that type; in a quote, the whole quote becomes the callout |
| `>>> ` | Collapsible section: the rest of the paragraph is its title |
| ` ``` ` or ` ```lang `, then a space | Code block; in a quote or callout, a code block in it |
| `---` | Divider, on the third `-`; in a quote or callout, a divider in it |

## Inline syntax

| Construct | Example | Loads as | Saved as (after an edit) |
| --- | --- | --- | --- |
| Emphasis | `*a*`, `_a_` | `italic` mark | `*a*` |
| Strong | `**a**`, `__a__` | `bold` mark | `**a**` |
| Strikethrough (GFM) | `~a~`, `~~a~~` | `strike` mark | `~~a~~` |
| Code span | `` `a` `` | `code` mark | Fence one longer than the longest backtick run inside |
| Link | `[text](https://x "title")` | `link` and `linkTitle` on the spans | Same |
| Reference link | `[text][ref]`, `[ref]` | `link` on the spans | `[text](https://x)` |
| Autolink | `<https://x.com>`, `<a@b.co>` | `link` whose text is the URL | `https://x.com`, `a@b.co` (bare, see below) |
| Autolink literal (GFM) | `https://x.com`, `www.x.com`, `a@b.co` | `link` whose text is the URL | Same |
| Image | `![alt](src "title")`, `![alt\|center\|320](src)` | one image atom with `src`, `alt`, `title`, `align`, `width`, `height` | Same |
| Hard line break | `\` or two spaces at the end of a line | `"\n"` in the text | `\` then a newline |
| Inline HTML | `<b>`, `<span class="x">` | text with the `html` mark | Verbatim |
| Backslash escape | `\*not italic\*` | the plain character | Escaped only where needed |
| Character reference | `&copy;`, `&#169;` | the decoded character `©` | `©` |

### Marks

```md
**bold**, *italic*, ~~strike~~, `code`, and ***bold italic***
```

Marks combine freely, except that text in a code span takes no other mark. The serializer chooses delimiters and, where needed, character references so the text reads back the same. For example, a letter directly after closing bold is written as `**three!**&#98;`.

### Links and images

```md
[CommonMark](https://commonmark.org)
<https://commonmark.org>
![Diagram](diagram.png "Optional title")
```

- A link is an attribute on text spans. Links do not nest.
- Reference labels are not kept: an edited block saves `[text][ref]` as `[text](url "title")`, with the definition's title. Link and image titles are kept, in double quotes, and show as a tooltip. Changing a link's URL keeps its title.
- An image is one inline atom. Its alt text is plain text. `resolveUrl` can change or drop the displayed `src` without changing the saved Markdown.
- Typing `[text](url)` or `![alt](src)` does not make a link or an image. The characters stay plain text and are saved escaped, so they read back as text: `\[text\](url)`.
- To add a link, select text and press Mod+K, or paste a URL over it. Pasting Markdown, such as `[text](url)` or `![alt](src)`, makes links and images.
- Images also come from the app: `insertMarkdown`, for example after a `fileHandler()` upload.

### Image size and alignment

```md
![Diagram|320](diagram.png)
![Diagram|320x200](diagram.png "Optional title")
![Diagram|center](diagram.png)
![Diagram|right|320](diagram.png)
```

The editor reads a size at the end of an image's description, as Obsidian does, and an alignment before it, as Obsidian's image plugins do. This is not part of CommonMark or GFM.

- The size is `|` and a width, optionally followed by `x` and a height, in whole CSS pixels from 1 to 99999. The image shows at that width, but never wider than its line, and always keeps its aspect ratio. A height is kept in the Markdown and reserves space before the image loads.
- The size is not part of the alt text: `![Diagram|320](d.png)` has the alt text `Diagram`.
- The alignment is `|left`, `|center` or `|right`, at the end or right before the size, in lower case. It is not part of the alt text either. It applies to an image block: an image alone in its paragraph, with no link or formatting and only spaces around it. An image inside text keeps its alignment in the Markdown but shows inline.
- Picking Left in the block menu removes the word; a `|left` that was typed is kept as written.
- Only an unescaped `|` counts. `![a|b](x)`, `![a | 320](x)`, `![a|320px](x)`, `![a|Center](x)`, `![a\|320](x)` and `![a&#124;320](x)` have no size or alignment; their alt text keeps the `|`.
- Alt text that ends like a size or an alignment, with none of its own, is saved with `&#124;` for its last `|`, so it reads back as text: alt text `sales|2024` is saved as `![sales&#124;2024](x)`, and `left|right` as `![left&#124;right](x)`.
- In a table cell the `|` is escaped like every other pipe in the row: `| ![Diagram\|320](d.png) |`.
- Resizing writes a width and drops a height. Reference images (`![Diagram|320][d]`) are read the same way and saved as inline images, like reference links.
- Other renderers ignore both: they show the image at its own size, on the left, and read the alt text as `Diagram|right|320`. memos accepts it, because the image is still a Markdown image and its URL is unchanged.
- Copying writes `<img width="320">` (and `height`), and an aligned image block as `<p style="text-align:center">` around it. Pasting HTML reads `width` and `height` attributes in whole pixels; other sizes, such as `50%`, are not kept.

### Autolink literals

With `autolinks: true` (the default), these are links without angle brackets. The rules follow GitHub (cmark-gfm, and github.com where they differ), including its quirks:

| Literal | Example | Link destination |
| --- | --- | --- |
| `www.` and a domain | `www.commonmark.org/help` | `http://www.commonmark.org/help` |
| `http://`, `https://` or `ftp://` and a domain | `https://x.com/a_b` | The text |
| E-mail address | `name+tag@example.com` | `mailto:` and the text |

- A `www.` literal starts at the start of a line, after a space, tab or line break, or after `*`, `_`, `~` or `(`. A scheme literal starts after anything but an ASCII letter, so `中文https://x.com`, `"https://x.com"` and `0https://x.com` hold links and `xhttps://x.com` does not. `www.` and the scheme may be in any case.
- A literal runs to the next space, tab, line break or `<`. Other characters, including other Unicode spaces and character references, are part of it as written.
- After a scheme, the domain starts with a letter or digit; it needs no period, so `http://localhost:3000` is a link. A `www.` domain needs a period after `www`, which may be the last character before the trailing punctuation: `www. ` links `www`.
- The domain is read up to the first character other than an ASCII letter, digit, `-`, `_` or `.`. A `_` in either of the last two segments read makes it no link, unless the domain has more than ten periods.
- Trailing `?`, `!`, `.`, `,`, `:`, `*`, `_`, `~`, `'` and `"` are not part of a literal. Nor is a trailing `)` without a matching `(`, nor a trailing `;` or entity-like `&name;`.
- An e-mail address is letters, digits, `.`, `-`, `_` and `+`, then `@`, then letters, digits, `-`, `_` and periods followed by a letter or digit, with at least one period. It ends with a letter, so `react@0.11.1` is not an address.
- Literals are not recognized in link text, code spans, raw HTML or extension tokens.
- A link whose text is its own literal is saved bare, as typed, when the result reads back as the same link. Otherwise it is saved in angle brackets (`<https://x.com>`) or as `[text](url)`.
- Typing a space after a literal in plain text makes it a link. Undo, or Backspace right after it, restores the plain text.
- Plain text that forms a literal is saved as is and loads back as a link.

| Markdown | Links |
| --- | --- |
| `Visit www.commonmark.org.` | `www.commonmark.org` |
| `(https://x.com/a_(b))` | `https://x.com/a_(b)` |
| `_www.example.com_` | `www.example.com`, in italics |
| `https://localhost:3000` | `https://localhost:3000` |
| `see "https://x.com"` | `https://x.com` |
| `react@16.7.0` | None: an address ends with a letter |
| `https://-x.com` | None: the domain starts with `-` |
| `www.google.com/search?q=commonmark&hl;` | `www.google.com/search?q=commonmark` |
| `Mail a.b-c_d@a.b.` | `a.b-c_d@a.b` |
| `xhttps://x.com` | None: no boundary before the literal |
| `[see www.x.com](https://y)` | Only the outer link |

### Escaping on save

The serializer escapes only characters that would otherwise change meaning:

- `` ` ``, `*`, `~`, `[` and `]`;
- `_` outside a word;
- `<` before a letter, `/`, `!` or `?`;
- `&` before something that reads as a character reference;
- `!` before `[`;
- a backslash before punctuation;
- characters an extension lists in `escape` (`math()` lists `$`);
- at the start of a line, what would start a block: `#` followed by a space or ending the text, `>`, `-` or `+` followed by a space, `1.`, and so on.

Inline HTML cannot be escaped. When a line break puts HTML that would start an HTML block (a comment, or a tag such as `<div>`) at the start of a line, that line is indented by four spaces, which keeps it in the paragraph. The spaces are not part of the text.

`#`, `@`, `:` and `=` in running text are not escaped. Where an extension reads a backslash escape as its own token (`tags()` reads `\#`), the serializer writes a character reference instead, such as `&#35;`.

### Inline typing shortcuts

Typing the closing delimiter applies the mark and removes the delimiters: `**a**`, `__a__`, `*a*`, `_a_`, `` `a` ``, `~~a~~`. Text typed next does not continue the mark.

- Undo, or Backspace right after the shortcut, before any other edit or caret move, restores the typed characters. They then stay text and are saved escaped: `\*\*a\*\*`.
- A backslash escapes a delimiter, as in CommonMark: typing `\*a*` or `*a\*` leaves the text as typed. Inside a code span a backslash is literal, so `` `a\` `` is code.

Links and images have no typing shortcut; see [Links and images](#links-and-images).

## Syntax extensions

An extension adds syntax outside CommonMark and GFM. The editor keeps the syntax as source and saves it verbatim, edited or not. An inline construct becomes a **token span** (`span.token` holds the syntax name). A block construct becomes a **raw block** whose `syntax` is the name. Inside a token there is no emphasis, link, autolink or decoration. Adjacent tokens of the same syntax form one token: `[^1][^2]` is one footnote token. Typing the last character of an inline construct turns it into a token.

### Math: `math()`

```md
Inline $e^{i\pi} + 1 = 0$ and display $$\sum x$$.

$$
\int_0^1 x\,dx = \frac{1}{2}
$$
```

- Inline: `$…$`, or `$$…$$` on one line, following Pandoc's dollar rules. An opening `$` followed by a space, or a closing `$` preceded by a space or followed by a digit, is a plain dollar sign: `costs $5 and $10` is text.
- Block: a line of two or more `$`, then lines up to a line of at least as many `$`. It can interrupt a paragraph.
- With `render` (for example KaTeX), formulas show rendered, and show their source while the caret is on them. Without `render` they show as source.
- A `$` in plain text is saved as `\$`: `costs $5` becomes `costs \$5` once its block is edited.

### Footnotes: `footnotes()`

```md
A claim that needs a source[^1].

[^1]: The source.
```

- `[^label]` is an inline token.
- `[^label]: text` starts a raw block. The lines that follow continue it until another definition or a line that starts another block. After a blank line it goes on only in lines indented four spaces (or a tab), as on GitHub, so a note can hold several paragraphs and a code block; the four spaces are not part of the text.
- A definition's text renders as Markdown: links, formatting, code, tags and mentions in it show as anywhere else.
- While editing, a definition shows where it is written, as a small note. Read-only, as on GitHub, the definitions hide where they are written and the referenced ones are collected in a section at the end, in order of first reference, each with a backlink (a small arrow) per reference; a definition nothing references does not show. Labels show as written, not renumbered.
- Without `footnotes()`, `[^1]` is plain text and an edited block saves it as `\[^1\]`.

## Tags and mentions

`#tag` and `@mention` are not Markdown syntax. They are plain text in the document and are saved exactly as typed. The `tags()` and `mentions()` extensions add two things:

1. **Highlighting**: each tag or mention gets a class (`mbe-tag`, `mbe-mention`, or the `class` option). It is a decoration: computed while rendering and never saved.
2. **Escapes**: `\#` and `\@` are kept as written, as `escape` tokens, so an escaped character survives edits and is never highlighted.

Autocomplete is a separate `suggestion()` extension. With `matchToken` and the same scanner, the popup opens exactly where the text is highlighted:

```ts
import { matchToken, mentions, scanTags, suggestion, tags } from '@usememos/editor';

const extensions = [
  tags(),
  mentions(),
  suggestion({
    name: 'tags',
    trigger: ['#', '＃'],
    match: matchToken(scanTags),
    items: ({ query }) => findTags(query).map((t) => ({ id: t, label: `#${t}` })),
  }),
];
```

`tags()` and `mentions()` take the same options:

| Option | Effect |
| --- | --- |
| `class` | The class on each match, instead of `mbe-tag` or `mbe-mention`. |
| `attributes` | Attributes added to each match. |
| `scan` | Replaces the default grammar. See [Custom grammar](#custom-grammar). |
| `onClick` | Called with `{ editor, match, event }` when a match is clicked to be followed: a plain click while read-only, Mod+click while editing. `match` is the text as written. Return `true` to handle it. Read-only matches then show a pointer cursor, and mentions underline on hover. |

### Tag grammar

The default grammar is `scanTags`. It is the memos server's (usememos/memos `markdown/parser/tag.go`), applied to the text a reader sees:

- A tag is `#` followed by one or more segments separated by `/`. Anything can come before the `#`.
- A segment starts with a Unicode `XID_Continue` character that is not a combining mark (a letter, digit or `_`), `-`, `+`, `&` or an emoji.
- It continues with `XID_Continue` characters (combining marks included), `-`, `+`, `&` and emoji. Like twitter-text, it also keeps `〃`, `～`, `〜`, the Hebrew `־`, `׳` and `״`, and the Tibetan tsheg `་`.
- An apostrophe (`'` or `’`) between two letters is part of the tag: `#tag's`.
- An emoji is fully qualified: `#*️⃣` and `#♥️` are tags, `#♥` is not. A keycap `#️⃣` is an emoji, not a `#`.
- Joiners and variation selectors are part of the tag as written. Before the first character, they and combining marks are skipped.
- A trailing `/` is not part of the tag. A tag of only digits is a tag: `#2024`.
- Only `#` starts a tag, not the full-width `＃`.

| Text | Tags |
| --- | --- |
| `#work and #work/meeting` | `#work`, `#work/meeting` |
| `(#ideas)` | `#ideas` |
| `#日记 #हिन्दी #🚀` | `#日记`, `#हिन्दी`, `#🚀` |
| `#2024/q1`, `#2024` | `#2024/q1`, `#2024` |
| `#C++ #R&D #tag's` | `#C++`, `#R&D`, `#tag's` |
| `#tag.` | `#tag` |
| `#a/` | `#a` |
| `3pm#work`, `#a#b`, `##x` | `#work`; `#a`, `#b`; `#x` |
| `# x`, `#♥`, `#v²` | None |
| `#️⃣` (keycap emoji) | None |

`test/conformance/tags.json` lists the tags and mentions a reader should see for 696 inputs: the memos server's grammar applied where GitHub's Markdown leaves text, with Unicode cases from twitter-text. Its `about` says where each expected result comes from. `test/conformance/known-failures.json` (under `tags`) lists each difference from the editor and why.

### Mention grammar

The default grammar is `scanMentions`, the memos server's (`markdown/parser/mention.go`):

- A mention is `@` followed by a username: 1 to 36 ASCII letters, digits and `-`, starting and ending with a letter or digit. The username is the longest such run: `@bob.smith` is `@bob`, `@alice_smith` is `@alice`.
- The `@` is not preceded by an ASCII letter, digit or `-`, so the middle of an e-mail address is not a mention. Any other character can come before it: `中文@dave`, `(@carol)`.
- Like twitter-text, a username followed by an accented Latin letter is not a mention: `@alicé`.

| Text | Mentions |
| --- | --- |
| `@alice, @bob.smith.` | `@alice`, `@bob` |
| `(@carol)`, `中文@dave` | `@carol`, `@dave` |
| `bob@example.com` | None: an e-mail address, and a link |
| `@-x`, `@张三` | None |

### Where tags and mentions are highlighted

Highlighting runs in paragraphs, headings, list items, quotes and table cells. The grammar is applied to each run of text with one format separately, and never to inline code, links, images, inline HTML or tokens. So a tag never crosses a change of formatting.

| Markdown | Highlighted |
| --- | --- |
| `## Weekly notes #work` | `#work` |
| `- [ ] Ship it #work` | `#work` |
| `**#bold/tag**` | `#bold/tag` |
| `#**work**` | Nothing: `#` and `work` have different formatting |
| `#wo**rk**` | `#wo` |
| `` `#code` `` | Nothing: inline code |
| `[#link](https://x)` | Nothing: a link |
| `https://x.com/#anchor` | Nothing: an autolink literal |
| `\#not-a-tag` (with `tags()`) | Nothing: `\#` is an escape token |
| `&#35;tag`, `#R&amp;D` | `#tag`, `#R&D`: what a reader sees. memos reads the source, so it finds no tag in the first and `#R` in the second |
| `$#x$` (with `math()`) | Nothing: a token |
| `#x` in a code block, HTML block or raw Markdown block | Nothing: these blocks take no decorations |
| `# heading` | Nothing: a level 1 heading |

### Escapes

- With `tags()`, `\#` loads as an `escape` token and is saved as `\#`, edited or not. Typing `\#` creates the token.
- With `mentions()`, the same holds for `\@`.
- Without these extensions, `\#` follows CommonMark: it loads as `#`, and an edited block saves it as `#`.
- With `tags()`, a lone `#` at the start of a line that needs escaping is saved as `&#35;`, because `\#` would load back as an escape token. For example, `#` followed by bold `work` is saved as `&#35;**work**`.

### Autocomplete

The rules of `suggestion()` (see the README's Autocomplete section), as they apply to tags and mentions:

- With `match: matchToken(scanTags)`, the popup opens where typing leaves the caret in a tag, or right after a `#` that the grammar would accept as a tag start. So it also opens after `a#` or `C#`, where a tag would be highlighted. The query is the text between `#` and the caret: `#work/` gives `work/`.
- Without `match`, the default matcher opens after a trigger at the start of a line or after whitespace, and a space closes the popup unless the suggestion sets `allowSpaces`.
- It opens in paragraphs, headings, list items, quotes and table cells. It does not open in code blocks, raw blocks, inline code, links, images, inline HTML or tokens, unless `allow` says otherwise.
- At the start of a paragraph, `#` followed by a space closes the popup and makes a heading. An `allow` rule can keep a bare `#` there from opening the popup at all; Ctrl+Space still opens it:

```ts
allow: ({ block, query, textBefore, excluded, explicit }) =>
  !excluded && (explicit || query !== '' || block.type !== 'paragraph' || textBefore !== ''),
```

- A pick replaces the whole tag, also the part after the caret, and is one undo step.

### Custom grammar

`scan(text, from, to)` replaces the default grammar. It receives the container's whole text and the bounds of one run of text with one format, and returns `{ from, to }` ranges inside those bounds. Escapes and the run-by-run rule still apply.

```ts
tags({ scan: (text, from, to) => myTagGrammar(text, from, to) });
```

## Other syntax

Syntax that neither CommonMark, GFM nor an extension defines is plain text. It is saved as typed, apart from the escapes in [Escaping on save](#escaping-on-save). Examples: `==highlight==`, `[[wiki link]]`, `:emoji:`, `{attributes}`.

Multi-line constructs from other dialects are read as CommonMark. For example, this container directive loads as one paragraph:

```md
::: note
Text
:::
```

With `breaks: false`, an edited block saves it as `::: note Text :::` on one line. With `breaks: true`, the lines are kept. To keep such a construct as written in every case, add a block syntax extension for it.
