# Markdown syntax

This is the specification of the Markdown the editor reads and writes: each block and inline construct, how it appears in the editor, and how it is saved. It also specifies the built-in syntax extensions and how `#tag` and `@mention` are handled.

## Conformance

- The parser follows **CommonMark 0.31.2** and the **GFM** extensions for tables, task list items, strikethrough and autolink literals.
- All 652 CommonMark 0.31.2 spec examples produce the reference HTML with `autolinks: false` (`test/spec.test.ts`).
- All GFM table, task list item, strikethrough and autolink spec examples produce the reference HTML (`test/spec.test.ts`).
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

An empty paragraph is saved as a paragraph holding only `&nbsp;`. It renders as an empty line in any CommonMark renderer and loads back as an empty paragraph. Empty paragraphs at the end of the document are not saved.

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

### Block quotes

```md
> First paragraph
>
> Second paragraph
```

Each paragraph in a quote becomes one `quote` block. Adjacent quote blocks are saved as one quote, with a `>` line between paragraphs. A quote that holds anything other than paragraphs becomes a raw Markdown block.

### Code blocks

````md
```ts
const x = 1;
```
````

- Fenced code (backticks or tildes) and indented code both load as `code`.
- Only the first word of the info string is kept as `language`: ` ```js title ` is saved as ` ```js `.
- The content is plain text. No inline syntax, decorations or suggestion menus apply inside.

### Tables

```md
| Left | Center | Right |
| :--- | :----: | ----: |
| 1    | 2      | 3     |
```

- Row 0 is the header. Each column has an alignment: `left`, `center`, `right` or none.
- Cells hold inline content. A line break in a cell is saved as `&#10;`, because a table row cannot span lines.
- An edited table is saved with one space around each cell and a delimiter row of `---`, `:--`, `:-:` or `--:`.

### HTML blocks

An HTML block (`<div>`, `<!-- comment -->`, `<details>` and the other CommonMark HTML block starts) loads as a raw block with `syntax: "html"`. It is shown and edited as source and saved verbatim. HTML is never rendered.

A collapsible section loads as **one** raw HTML block, from the line that opens `<details>` to the line that closes it, including blank lines, Markdown and nested `<details>` inside:

```markdown
<details>
<summary>Release notes</summary>

- Fixed sync
- Faster search

</details>
```

CommonMark ends an HTML block at a blank line, so this example is three blocks to a renderer: the opening HTML, a list, and the closing `</details>`. The editor joins them so the section stays together when blocks around it are edited, selected or deleted. The saved text is the same either way. A `<details>` that is never closed is not joined.

### Structure kept as source

The whole top-level list or quote is kept as one raw block with `syntax: "markdown"` when:

- a list item holds more than one paragraph, or any block other than a nested list;
- lists nest more than six levels deep;
- a quote holds anything other than paragraphs.

Each of these examples loads as one raw Markdown block:

```md
- Item

  Second paragraph in the same item
```

```md
> # Heading inside a quote
> Text
```

### Block typing shortcuts

Typed at the start of a paragraph. Undo restores the typed characters.

| Type | Becomes |
| --- | --- |
| `# ` to `###### ` | Heading, level 1 to 6 |
| `- `, `* `, `+ ` | Bullet list item |
| `1. `, `1) ` | Ordered list item, starting at that number |
| `[ ] `, `[x] ` | Task list item (also at the start of a bullet item) |
| `> ` | Quote |
| ` ``` ` or ` ```lang `, then a space | Code block |
| `---` | Divider, on the third `-` |

## Inline syntax

| Construct | Example | Loads as | Saved as (after an edit) |
| --- | --- | --- | --- |
| Emphasis | `*a*`, `_a_` | `italic` mark | `*a*` |
| Strong | `**a**`, `__a__` | `bold` mark | `**a**` |
| Strikethrough (GFM) | `~a~`, `~~a~~` | `strike` mark | `~~a~~` |
| Code span | `` `a` `` | `code` mark | Fence one longer than the longest backtick run inside |
| Link | `[text](https://x "title")` | `link` on the spans | `[text](https://x)` |
| Reference link | `[text][ref]`, `[ref]` | `link` on the spans | `[text](https://x)` |
| Autolink | `<https://x.com>`, `<a@b.co>` | `link` whose text is the URL | `https://x.com`, `a@b.co` (bare, see below) |
| Autolink literal (GFM) | `https://x.com`, `www.x.com`, `a@b.co` | `link` whose text is the URL | Same |
| Image | `![alt](src "title")` | one image atom with `src`, `alt`, `title` | Same |
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
- Link titles and reference labels are not kept: an edited block saves `[text](url "title")` and `[text][ref]` as `[text](url)`. Image titles are kept.
- An image is one inline atom. Its alt text is plain text. `resolveImageSrc` can change the displayed `src` without changing the saved Markdown.

### Autolink literals

With `autolinks: true` (the default), these are links without angle brackets, following the GFM spec:

| Literal | Example | Link destination |
| --- | --- | --- |
| `www.` and a domain | `www.commonmark.org/help` | `http://www.commonmark.org/help` |
| `http://`, `https://` or `ftp://` and a domain | `https://x.com/a_b` | The text |
| E-mail address | `name+tag@example.com` | `mailto:` and the text |

- A `www.` or scheme literal starts at the start of a line, after whitespace, or after `*`, `_`, `~` or `(`. It runs to the next whitespace or `<`.
- The domain has at least one period, and its last two segments contain no `_`. A `_` right after the domain is punctuation, so `_www.example.com_` is emphasis around a link.
- Trailing `?`, `!`, `.`, `,`, `:`, `*`, `_` and `~` are not part of a literal. Nor is a trailing `)` without a matching `(`, nor a trailing `;` or entity-like `&name;`.
- An e-mail address is letters, digits, `.`, `-`, `_` and `+`, then `@`, then a domain of letters, digits, `-` and `_` with at least one period. It may not end with `-` or `_`.
- Literals are not recognized in link text, code spans, raw HTML or extension tokens.
- A link whose text is its own literal is saved bare, as typed, when the result reads back as the same link. Otherwise it is saved in angle brackets (`<https://x.com>`) or as `[text](url)`.
- Typing a space after a literal in plain text makes it a link. Undo restores the plain text.
- Plain text that forms a literal is saved as is and loads back as a link.

| Markdown | Links |
| --- | --- |
| `Visit www.commonmark.org.` | `www.commonmark.org` |
| `(https://x.com/a_(b))` | `https://x.com/a_(b)` |
| `_www.example.com_` | `www.example.com`, in italics |
| `https://localhost:3000` | None: the domain has no period |
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

`#`, `@`, `:` and `=` in running text are not escaped. Where an extension reads a backslash escape as its own token (`tags()` reads `\#`), the serializer writes a character reference instead, such as `&#35;`.

### Inline typing shortcuts

Typing the closing delimiter applies the mark and removes the delimiters: `**a**`, `__a__`, `*a*`, `_a_`, `` `a` ``, `~~a~~`. Text typed next does not continue the mark.

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
- `[^label]: text` starts a raw block that ends at a blank line, at another definition, or at a line that starts another block.
- Without `footnotes()`, `[^1]` is plain text and an edited block saves it as `\[^1\]`.

## Tags and mentions

`#tag` and `@mention` are not Markdown syntax. They are plain text in the document and are saved exactly as typed. The `tags()` and `mentions()` extensions add three things:

1. **Highlighting**: each tag or mention gets a class (`mbe-tag`, `mbe-mention`, or the `class` option). It is a decoration: computed while rendering and never saved.
2. **Escapes**: `\#` and `\@` are kept as written, as `escape` tokens, so an escaped character survives edits and is never highlighted.
3. **Autocomplete**: with the `suggestion` option, typing `#` or `@` opens a suggestion menu.

```ts
import { mentions, tags } from '@usememos/editor';

const extensions = [
  tags({
    suggestion: {
      items: ({ query }) => findTags(query).map((t) => ({ id: t, label: `#${t}` })),
      command: ({ editor, range, item }) => editor.commands.insertText(`#${item.id} `, { range }),
    },
  }),
  mentions(),
];
```

`tags()` and `mentions()` take the same options:

| Option | Effect |
| --- | --- |
| `class` | The class on each match, instead of `mbe-tag` or `mbe-mention`. |
| `attributes` | Attributes added to each match. |
| `scan` | Replaces the default grammar. See [Custom grammar](#custom-grammar). |
| `suggestion` | An autocomplete menu opened by `#` or `@`. See [Suggestion menus](#suggestion-menus). |

### Tag grammar

The default grammar is `scanTags`:

- A tag is `#` followed by one or more segments separated by `/`.
- A segment starts with a letter, number, `_` or emoji, and continues with letters, combining marks, numbers, `_`, `-` and emoji (including joiners, variation selectors and skin tones).
- The `#` is not preceded by a letter, combining mark, number, `_` or `#`.
- A trailing `/` is not part of the tag.
- A tag needs at least one character that is not a digit, `_`, `-` or `/`. `#123` is not a tag.

| Text | Tags |
| --- | --- |
| `#work and #work/meeting` | `#work`, `#work/meeting` |
| `(#ideas)` | `#ideas` |
| `#日记 #हिन्दी #🚀` | `#日记`, `#हिन्दी`, `#🚀` |
| `#2024/q1` | `#2024/q1` |
| `#tag.` | `#tag` |
| `#a/` | `#a` |
| `a#b`, `C#`, `##x` | None |
| `#123`, `#-a`, `# x` | None |
| `#️⃣` (keycap emoji) | None |

### Mention grammar

The default grammar is `scanMentions`:

- A mention is `@` followed by a name of letters, combining marks, numbers, `_`, `.` and `-`.
- The name starts with a letter, number or `_`, and does not end with `.` or `-`.
- The `@` is not preceded by a letter, combining mark, number, `_`, `.`, `+`, `-` or `@`. The middle of an e-mail address is not a mention.

| Text | Mentions |
| --- | --- |
| `@alice, @bob.smith.` | `@alice`, `@bob.smith` |
| `(@carol)` | `@carol` |
| `bob@example.com` | None: an e-mail address, and a link |
| `@-x` | None |

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
| `$#x$` (with `math()`) | Nothing: a token |
| `#x` in a code block, HTML block or raw Markdown block | Nothing: these blocks take no decorations |
| `# heading` | Nothing: a level 1 heading |

### Escapes

- With `tags()`, `\#` loads as an `escape` token and is saved as `\#`, edited or not. Typing `\#` creates the token.
- With `mentions()`, the same holds for `\@`.
- Without these extensions, `\#` follows CommonMark: it loads as `#`, and an edited block saves it as `#`.
- With `tags()`, a lone `#` at the start of a line that needs escaping is saved as `&#35;`, because `\#` would load back as an escape token. For example, `#` followed by bold `work` is saved as `&#35;**work**`.

### Suggestion menus

- A menu opens when its trigger (`#` or `@`) is typed at the start of a block or after whitespace, in a paragraph, heading, list item or quote.
- A menu does not open inside a word, in table cells, in code blocks or in raw blocks.
- A space closes the menu, unless the suggestion sets `allowSpaces`.
- At the start of a paragraph, `#` followed by a space closes the menu and makes a heading.

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
