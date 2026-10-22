// The Markdown syntax spec (docs/syntax.md) as tests: every example in it,
// plus unusual cases, section by section.
//
// Each case is [markdown, the document it loads as, how it is saved after
// an edit]. SAME means the input itself (with a final newline). Every case
// also checks that an unedited load and save returns the input byte for
// byte, and that the saved form loads back as the same document.

import { describe, expect, it } from 'vitest';
import {
  applyAutolinkInputRule,
  applyBlockInputRules,
  applyInlineInputRules,
  applyTokenInputRules,
  insertText,
} from '../src/commands';
import { decorationContext } from '../src/decorations';
import { footnotes } from '../src/extensions/footnotes';
import { math } from '../src/extensions/math';
import { mentions, tags } from '../src/extensions/tags';
import type { MarkdownOptions } from '../src/markdown/options';
import { parseMarkdown } from '../src/markdown/parse';
import { serializeMarkdown } from '../src/markdown/serialize';
import { loadMarkdown } from '../src/markdown/source';
import { type Block, type Inline, caret, createState, inlineText, paragraph } from '../src/model';
import { blockForm, docForm } from './syntax-helpers';

const NONE: MarkdownOptions = {};
const PLAIN: MarkdownOptions = { autolinks: false };
const MATH: MarkdownOptions = { syntax: [math().markdown!] };
const TAGS: MarkdownOptions = { syntax: [tags().markdown!, mentions().markdown!] };
/** The playground's dialect. */
const NOTES: MarkdownOptions = {
  breaks: true,
  setext: false,
  syntax: [math().markdown!, footnotes().markdown!, tags().markdown!, mentions().markdown!],
};

const SAME = Symbol('same');
type Case = [markdown: string, doc: string[], saved: string | typeof SAME];

function section(name: string, options: MarkdownOptions, cases: Case[]): void {
  describe(name, () => {
    for (const [md, doc, savedAs] of cases) {
      const saved = savedAs === SAME ? md + '\n' : savedAs;
      it(JSON.stringify(md), () => {
        const parsed = parseMarkdown(md, options);
        expect(docForm(parsed), 'loads as').toEqual(doc);
        expect(serializeMarkdown(parsed, options), 'saved after an edit').toBe(saved);
        const { doc: loaded, source } = loadMarkdown(md, options);
        expect(serializeMarkdown(loaded, { ...options, source }), 'saved unedited').toBe(md);
        // Empty lines at the end are not saved, so they do not load back.
        const kept = [...doc];
        while (kept[kept.length - 1] === 'p ') kept.pop();
        expect(docForm(parseMarkdown(saved, options)), 'saved form loads back').toEqual(kept);
        expect(serializeMarkdown(parseMarkdown(saved, options), options), 'saving is stable').toBe(saved);
      });
    }
  });
}

describe('blocks', () => {

  section('Paragraphs and line breaks', NONE, [
    ["Hello world", ["p Hello world"], SAME],
    ["First line\nsecond line", ["p First line second line"], "First line second line\n"],
    ["a\\\nb", ["p a⏎b"], SAME],
    ["a  \nb", ["p a⏎b"], "a\\\nb\n"],
    ["a\\", ["p a\\"], "a\\\\\n"],
    ["trailing spaces   ", ["p trailing spaces"], "trailing spaces\n"],
    ["   leading spaces", ["p leading spaces"], "leading spaces\n"],
    ["a\t\tb", ["p a\t\tb"], SAME],
    ["a\u00a0b", ["p a\u00a0b"], SAME],
    ["emoji 🚀 and 日本語", ["p emoji 🚀 and 日本語"], SAME],
  ]);

  section('Empty lines', NONE, [
    ["Above\n\n&nbsp;\n\nBelow", ["p Above", "p ", "p Below"], SAME],
    ["&nbsp;", ["p "], ""],
    ["Above\n\n&nbsp;\n\n&nbsp;", ["p Above", "p ", "p "], "Above\n"],
    ["a\n\n\n\n\nb", ["p a", "p b"], "a\n\nb\n"],
    ["&nbsp;x", ["p \u00a0x"], "\u00a0x\n"],
  ]);

  section('Headings', NONE, [
    ["# Heading 1", ["h1 Heading 1"], SAME],
    ["###### Heading 6", ["h6 Heading 6"], SAME],
    ["####### seven", ["p ####### seven"], SAME],
    ["## Notes #", ["h2 Notes"], "## Notes\n"],
    ["## Notes \\#", ["h2 Notes #"], SAME],
    ["## a #b #", ["h2 a #b"], "## a #b\n"],
    ["#tag", ["p #tag"], SAME],
    ["#", ["h1 "], SAME],
    ["#\tTab", ["h1 Tab"], "# Tab\n"],
    ["  ## indented", ["h2 indented"], "## indented\n"],
    ["## **bold** heading", ["h2 <b>bold</b> heading"], SAME],
    ["Title\n===", ["h1 Title"], "# Title\n"],
    ["Title\n---", ["h2 Title"], "## Title\n"],
  ]);

  section('Lists', NONE, [
    ["- a\n* b\n+ c", ["bullet:0 a", "bullet:0 b", "bullet:0 c"], "- a\n- b\n- c\n"],
    ["1) a\n2) b", ["ordered:0 a", "ordered:0 b"], "1. a\n2. b\n"],
    ["3. a\n4. b", ["ordered@3:0 a", "ordered:0 b"], SAME],
    ["0. zero", ["ordered@0:0 zero"], SAME],
    ["123456789. big", ["ordered@123456789:0 big"], SAME],
    ["1. a\n1. b\n1. c", ["ordered:0 a", "ordered:0 b", "ordered:0 c"], "1. a\n2. b\n3. c\n"],
    ["10. ten\n11. eleven", ["ordered@10:0 ten", "ordered:0 eleven"], SAME],
    ["1. a\n- b", ["ordered:0 a", "bullet:0 b"], SAME],
    ["- a\n1. b", ["bullet:0 a", "ordered:0 b"], SAME],
    ["- a\n\n- b", ["bullet:0 a", "bullet:0 b"], "- a\n- b\n"],
    ["-\n  a", ["bullet:0 a"], "- a\n"],
    ["- \n- b", ["bullet:0 ", "bullet:0 b"], "-\n- b\n"],
    ["- a\n    - b\n        - c", ["bullet:0 a", "bullet:1 b", "bullet:2 c"], "- a\n  - b\n    - c\n"],
    ["- a\n  - b\n    - c\n      - d\n        - e\n          - f", ["bullet:0 a", "bullet:1 b", "bullet:2 c", "bullet:3 d", "bullet:4 e", "bullet:5 f"], SAME],
  ]);

  section('Task lists', NONE, [
    ["- [ ] t\n- [x] d\n- [X] D", ["task[ ]:0 t", "task[x]:0 d", "task[x]:0 D"], "- [ ] t\n- [x] d\n- [x] D\n"],
    ["* [ ] star task", ["task[ ]:0 star task"], "- [ ] star task\n"],
    ["- [ ]", ["task[ ]:0 "], SAME],
    ["- [x]not task", ["bullet:0 [x]not task"], "- \\[x\\]not task\n"],
  ]);

  section('Block quotes', NONE, [
    ["> a", ["quote a"], SAME],
    ["> a\n>\n> b", ["quote a", "quote b"], SAME],
    ["> a\n\n> b", ["quote a", "new quote b"], SAME],
    ["> a\n\n> b\n>\n> c", ["quote a", "new quote b", "quote c"], SAME],
    ["> - a\n\n> - b", ["quote/bullet:0 a", "new quote/bullet:0 b"], SAME],
    ["> [!NOTE]\n> a\n\n> [!NOTE]\n> b", ["callout(note) a", "new callout(note) b"], SAME],
    ["> [!NOTE]\n> a\n\n> b", ["callout(note) a", "quote b"], SAME],
    ["> a\n\nx\n\n> b", ["quote a", "p x", "quote b"], SAME],
    ["> a\nlazy", ["quote a lazy"], "> a lazy\n"],
    [">", [], ""],
  ]);

  section('Lists in quotes', NONE, [
    ["> ✏️ **Quick note**\n> - Item 1: check xyz\n> - Item 2: check abc", ["quote ✏️ <b>Quick note</b>", "quote/bullet:0 Item 1: check xyz", "quote/bullet:0 Item 2: check abc"], "> ✏️ **Quick note**\n>\n> - Item 1: check xyz\n> - Item 2: check abc\n"],
    ["> Note\n>\n> - a\n> - b", ["quote Note", "quote/bullet:0 a", "quote/bullet:0 b"], SAME],
    ["> Note\n> * a\n> * b", ["quote Note", "quote/bullet:0 a", "quote/bullet:0 b"], "> Note\n>\n> - a\n> - b\n"],
    ["> - a\n>   - b\n> 1. c\n> - [x] d", ["quote/bullet:0 a", "quote/bullet:1 b", "quote/ordered:0 c", "quote/task[x]:0 d"], SAME],
    ["> - a\n>\n> after", ["quote/bullet:0 a", "quote after"], SAME],
    ["> - a\n\n- b", ["quote/bullet:0 a", "bullet:0 b"], SAME],
    ["- a\n\n> - b", ["bullet:0 a", "quote/bullet:0 b"], SAME],
    ["> 3. a\n> 4. b", ["quote/ordered@3:0 a", "quote/ordered:0 b"], SAME],
  ]);

  section('Callouts', NONE, [
    ["> [!TIP]\n> First paragraph\n>\n> Second paragraph", ["callout(tip) First paragraph", "callout(tip) Second paragraph"], SAME],
    ["> [!note]\n> a", ["callout(note) a"], "> [!NOTE]\n> a\n"],
    ["> [!WARNING]  \n> a", ["callout(warning) a"], "> [!WARNING]\n> a\n"],
    ["> [!NOTE]\n>\n> a", ["callout(note) a"], "> [!NOTE]\n> a\n"],
    ["> [!TIP]", ["callout(tip) "], "> [!TIP]\n> &nbsp;\n"],
    ["> [!NOTE]\n> a\n\n> [!CAUTION]\n> b", ["callout(note) a", "callout(caution) b"], SAME],
    ["> [!NOTE]\n> a\n\n> b", ["callout(note) a", "quote b"], SAME],
    ["> [!NOTE] text", ["quote [!NOTE] text"], "> \\[!NOTE\\] text\n"],
    ["> [!FYI]\n> a", ["quote [!FYI] a"], "> \\[!FYI\\] a\n"],
    ["> a\n> [!NOTE]", ["quote a [!NOTE]"], "> a \\[!NOTE\\]\n"],
    ["> [!NOTE]\n> - a\n> - b", ["callout(note)/bullet:0 a", "callout(note)/bullet:0 b"], SAME],
    ["> [!TIP]\n> Steps:\n> 1. a\n> 2. b", ["callout(tip) Steps:", "callout(tip)/ordered:0 a", "callout(tip)/ordered:0 b"], "> [!TIP]\n> Steps:\n>\n> 1. a\n> 2. b\n"],
    ["> [!NOTE]\n>\n> 2. a", ["callout(note)/ordered@2:0 a"], SAME],
  ]);

  section('Callouts with callouts: false', { callouts: false }, [
    ["> [!NOTE]\n> a", ["quote [!NOTE] a"], "> \\[!NOTE\\] a\n"],
  ]);

  section('Code blocks', NONE, [
    ["```ts\nconst x = 1;\n```", ["code(ts) const x = 1;"], SAME],
    ["~~~\ntilde\n~~~", ["code() tilde"], "```\ntilde\n```\n"],
    ["```js title\nx\n```", ["code(js) x"], "```js\nx\n```\n"],
    ["    indented", ["code() indented"], "```\nindented\n```\n"],
    ["```\nunclosed", ["code() unclosed"], "```\nunclosed\n```\n"],
    ["````\n```\n````", ["code() ```"], SAME],
    ["```\n```", ["code() "], SAME],
    ["~~~not strike~~~", ["code(not) "], "```not\n```\n"],
  ]);

  section('Tables', NONE, [
    ["| Left | Center | Right |\n| :--- | :----: | ----: |\n| 1 | 2 | 3 |", ["table(left,center,right) [Left | Center | Right] [1 | 2 | 3]"], "| Left | Center | Right |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n"],
    ["| a |\n| - |", ["table(-) [a]"], "| a |\n| --- |\n"],
    ["a | b\n-- | --\nc | d", ["table(-,-) [a | b] [c | d]"], "| a | b |\n| --- | --- |\n| c | d |\n"],
    // A list item comes before a delimiter row, as in cmark-gfm.
    ["a | b\n- | -", ["p a | b", "bullet:0 | -"], "a | b\n\n- | \\-\n"],
    ["| a | b |\n| - | - |\n| only one |", ["table(-,-) [a | b] [only one | ]"], "| a | b |\n| --- | --- |\n| only one |  |\n"],
    ["| a \\| b |\n| - |\n| `c \\| d` |", ["table(-) [a | b] [<code>c | d</code>]"], "| a \\| b |\n| --- |\n| `c \\| d` |\n"],
  ]);

  section('Thematic breaks', NONE, [
    ["---", ["hr"], SAME],
    ["***", ["hr"], "---\n"],
    ["___", ["hr"], "---\n"],
    ["- - -", ["hr"], "---\n"],
    ["* * *", ["hr"], "---\n"],
    ["--", ["p --"], "\\--\n"],
  ]);

  section('HTML blocks', NONE, [
    ["<div>hi</div>", ["raw(html) <div>hi</div>"], SAME],
    ["<!-- c -->", ["raw(html) <!-- c -->"], SAME],
    ["<br>", ["raw(html) <br>"], SAME],
    ["</close>", ["raw(html) </close>"], SAME],
    ["<not a link>", ["raw(html) <not a link>"], SAME],
    // A <details> element with its title on the next line and a body after a
    // blank line is a collapsible section: a title, the blocks inside, an end.
    ["<details>\n<summary>S</summary>\n\nBody\n</details>", ["details S", "p Body", "/details"], "<details>\n<summary>S</summary>\n\nBody\n\n</details>\n"],
    ["<details open>\n<summary>S</summary>\n\n- a\n- b\n\n</details>", ["details(open) S", "bullet:0 a", "bullet:0 b", "/details"], SAME],
    ["<details>\n<summary>Outer</summary>\n\n<details>\n<summary>Inner</summary>\n\nx\n\n</details>\n\n</details>", ["details Outer", "details Inner", "p x", "/details", "/details"], SAME],
    ["<details>\n<summary>A &amp; B</summary>\n\nx\n\n</details>", ["details A & B", "p x", "/details"], SAME],
    ["<details>\n  <summary>S</summary>\n\nx\n</details>", ["details S", "p x", "/details"], "<details>\n<summary>S</summary>\n\nx\n\n</details>\n"],
    ["para\n\n<details>\n<summary>S</summary>\n\nBody\n</details>\n\nafter", ["p para", "details S", "p Body", "/details", "p after"], "para\n\n<details>\n<summary>S</summary>\n\nBody\n\n</details>\n\nafter\n"],
    // Other shapes stay raw HTML.
    ["<details><summary>S</summary>Body</details>", ["raw(html) <details><summary>S</summary>Body</details>"], SAME],
    ["<details>\n<summary>S</summary>\n</details>", ["raw(html) <details>⏎<summary>S</summary>⏎</details>"], SAME],
    // Never closed: CommonMark's blocks, as before.
    ["<details>\n<summary>S</summary>\n\nBody", ["raw(html) <details>⏎<summary>S</summary>", "p Body"], SAME],
    // Any element with Markdown between its tags, not only <details>.
    ["<div align=\"center\">\n\n**Hi**\n\n</div>", ["raw(html) <div align=\"center\">⏎⏎**Hi**⏎⏎</div>"], SAME],
    ["<p align=\"center\">\n\n![logo](a.png)\n\n</p>\n\nafter", ["raw(html) <p align=\"center\">⏎⏎![logo](a.png)⏎⏎</p>", "p after"], SAME],
    ["<table>\n<tr>\n<td>\n\n- a\n\n</td>\n</tr>\n</table>", ["raw(html) <table>⏎<tr>⏎<td>⏎⏎- a⏎⏎</td>⏎</tr>⏎</table>"], SAME],
    ["<div>\n<details>\n<summary>S</summary>\n\nx\n\n</details>\n\ny\n\n</div>", ["raw(html) <div>⏎<details>⏎<summary>S</summary>⏎⏎x⏎⏎</details>⏎⏎y⏎⏎</div>"], SAME],
    // Closing an outer element closes the ones opened inside it, as in a browser.
    ["<div>\n<span>\n\nx\n\n</div>", ["raw(html) <div>⏎<span>⏎⏎x⏎⏎</div>"], SAME],
    // Void and self-closing tags, comments and closed elements leave nothing open.
    ["<div><img src=\"a.png\"><br/></div>\n\nx", ["raw(html) <div><img src=\"a.png\"><br/></div>", "p x"], SAME],
    ["<!-- <div> -->\n\nx\n\n<div></div>", ["raw(html) <!-- <div> -->", "p x", "raw(html) <div></div>"], SAME],
    ["<div title=\"a > b\">\n\nx\n\n</div>", ["raw(html) <div title=\"a > b\">⏎⏎x⏎⏎</div>"], SAME],
    // A closing tag inside a paragraph is not an HTML block, so it does not close the section.
    ["<div>\n\ntext</div>", ["raw(html) <div>", "p text<html></div></html>"], SAME],
  ]);

  section('HTML blocks with details: false', { details: false }, [
    ["<details>\n<summary>S</summary>\n\nBody\n</details>", ["raw(html) <details>⏎<summary>S</summary>⏎⏎Body⏎</details>"], SAME],
  ]);

  section('Structure kept as source', NONE, [
    ["- a\n\n  para2", ["raw(markdown) - a⏎⏎  para2"], SAME],
    ["- a\n  ```\n  code\n  ```", ["raw(markdown) - a⏎  ```⏎  code⏎  ```"], SAME],
    ["> # h", ["raw(markdown) > # h"], SAME],
    ["> - a\n>\n>   para2", ["raw(markdown) > - a⏎>⏎>   para2"], SAME],
    ["> ```\n> code\n> ```", ["raw(markdown) > ```⏎> code⏎> ```"], SAME],
    [">> nested", ["raw(markdown) >> nested"], SAME],
    ["- a\n  - b\n    - c\n      - d\n        - e\n          - f\n            - g", ["raw(markdown) - a⏎  - b⏎    - c⏎      - d⏎        - e⏎          - f⏎            - g"], SAME],
  ]);

  section('Link reference definitions', NONE, [
    ["[a][r]\n\n[r]: https://x \"T\"", ["p <a \"https://x\">a</a>"], "[a](https://x \"T\")\n"],
    ["[r]\n\n[r]: https://x", ["p <a \"https://x\">r</a>"], "[r](https://x)\n"],
    ["[r]: https://x", [], ""],
    ["[missing]", ["p [missing]"], "\\[missing\\]\n"],
  ]);
});

describe('inline', () => {
  section('Marks', NONE, [
    ["*a* _a_ **a** __a__ ~a~ ~~a~~ `a`", ["p <i>a</i> <i>a</i> <b>a</b> <b>a</b> <s>a</s> <s>a</s> <code>a</code>"], "*a* *a* **a** **a** ~~a~~ ~~a~~ `a`\n"],
    ["***bold italic***", ["p <b><i>bold italic</i></b>"], SAME],
    ["**bold *both* bold**", ["p <b>bold </b><b><i>both</i></b><b> bold</b>"], SAME],
    ["a**b**c", ["p a<b>b</b>c"], SAME],
    ["**a**b", ["p <b>a</b>b"], SAME],
    ["a*b*", ["p a<i>b</i>"], SAME],
    ["snake_case_word", ["p snake_case_word"], SAME],
    ["_a_b", ["p _a_b"], "\\_a_b\n"],
    ["*not closed", ["p *not closed"], "\\*not closed\n"],
    ["** spaced **", ["p ** spaced **"], "\\*\\* spaced \\*\\*\n"],
    ["~one~~", ["p ~one~~"], "\\~one\\~\\~\n"],
  ]);

  section('Code spans', NONE, [
    ["``a`b``", ["p <code>a`b</code>"], SAME],
    ["` `` `", ["p <code>``</code>"], "``` `` ```\n"],
    ["`  a  `", ["p <code> a </code>"], SAME],
    ["``", ["p ``"], "\\`\\`\n"],
    ["`a\nb`", ["p <code>a b</code>"], "`a b`\n"],
  ]);

  section('Links', NONE, [
    ["[text](https://x \"title\")", ["p <a \"https://x\">text</a>"], SAME],
    ["[t](u 'single')", ["p <a \"u\">t</a>"], "[t](u \"single\")\n"],
    ["[t](u 'say \"hi\"')", ["p <a \"u\">t</a>"], "[t](u \"say \\\"hi\\\"\")\n"],
    ["[https://x.com](https://x.com \"T\")", ["p <a \"https://x.com\">https://x.com</a>"], SAME],
    ["[text](<a b>)", ["p <a \"a b\">text</a>"], SAME],
    ["[a [nested] b](u)", ["p <a \"u\">a [nested] b</a>"], "[a \\[nested\\] b](u)\n"],
    ["[a](u)[b](v)", ["p <a \"u\">a</a><a \"v\">b</a>"], SAME],
    ["[*em* link](u)", ["p <a \"u\"><i>em</i></a><a \"u\"> link</a>"], SAME],
    ["[a]()", ["p <a \"\">a</a>"], "[a](<>)\n"],
    ["[a](u(1))", ["p <a \"u(1)\">a</a>"], SAME],
    ["[a](u)b", ["p <a \"u\">a</a>b"], SAME],
    ["[https://x.com](https://y.com)", ["p <a \"https://y.com\">https://x.com</a>"], SAME],
  ]);

  section('Autolinks', NONE, [
    ["<https://x.com>", ["p <a \"https://x.com\">https://x.com</a>"], "https://x.com\n"],
    ["<a@b.co>", ["p <a \"mailto:a@b.co\">a@b.co</a>"], "a@b.co\n"],
    ["<mailto:a@b.co>", ["p <a \"mailto:a@b.co\">mailto:a@b.co</a>"], SAME],
    ["<ftp://x>", ["p <a \"ftp://x\">ftp://x</a>"], "ftp://x\n"],
    ["<https://x.com>.", ["p <a \"https://x.com\">https://x.com</a>."], "https://x.com.\n"],
    ["<https://x.com/a b>", ["p <<a \"https://x.com/a\">https://x.com/a</a> b>"], "\\<https://x.com/a b>\n"],
  ]);

  section('Autolink literals', NONE, [
    ["www.commonmark.org", ["p <a \"http://www.commonmark.org\">www.commonmark.org</a>"], SAME],
    ["Visit www.commonmark.org.", ["p Visit <a \"http://www.commonmark.org\">www.commonmark.org</a>."], SAME],
    ["www.commonmark.org/a.b.", ["p <a \"http://www.commonmark.org/a.b\">www.commonmark.org/a.b</a>."], SAME],
    ["WWW.UPPER.com", ["p <a \"http://WWW.UPPER.com\">WWW.UPPER.com</a>"], SAME],
    ["www.", ["p www."], SAME],
    ["www.x_y.com", ["p www.x_y.com"], SAME],
    ["www.a_b.x.com", ["p <a \"http://www.a_b.x.com\">www.a_b.x.com</a>"], SAME],
    ["https://x", ["p <a \"https://x\">https://x</a>"], SAME],
    ["https://localhost:3000/a", ["p <a \"https://localhost:3000/a\">https://localhost:3000/a</a>"], SAME],
    ["https://-x.com", ["p https://-x.com"], SAME],
    ["http://x.com:8080/p?q=1#f", ["p <a \"http://x.com:8080/p?q=1#f\">http://x.com:8080/p?q=1#f</a>"], SAME],
    ["ftp://f.org/file", ["p <a \"ftp://f.org/file\">ftp://f.org/file</a>"], SAME],
    ["https://x.com/a)", ["p <a \"https://x.com/a\">https://x.com/a</a>)"], SAME],
    ["(https://x.com/a)", ["p (<a \"https://x.com/a\">https://x.com/a</a>)"], SAME],
    ["https://x.com/a))", ["p <a \"https://x.com/a\">https://x.com/a</a>))"], SAME],
    ["https://x.com/(a)(b)", ["p <a \"https://x.com/(a)(b)\">https://x.com/(a)(b)</a>"], SAME],
    ["https://x.com/a;", ["p <a \"https://x.com/a\">https://x.com/a</a>;"], SAME],
    ["www.google.com/search?q=commonmark&hl;", ["p <a \"http://www.google.com/search?q=commonmark\">www.google.com/search?q=commonmark</a>&hl;"], "[www.google.com/search?q=commonmark](http://www.google.com/search?q=commonmark)\\&hl;\n"],
    ["https://x.com.", ["p <a \"https://x.com\">https://x.com</a>."], SAME],
    ["https://x.com,next", ["p <a \"https://x.com,next\">https://x.com,next</a>"], SAME],
    ["https://x.com/<tag>", ["p <a \"https://x.com/\">https://x.com/</a><html><tag></html>"], SAME],
    ["*https://x.com*", ["p <a \"https://x.com\"><i>https://x.com</i></a>"], SAME],
    ["_www.x.com_", ["p <a \"http://www.x.com\"><i>www.x.com</i></a>"], "*www.x.com*\n"],
    ["~https://x.com~", ["p <a \"https://x.com\"><s>https://x.com</s></a>"], "~~https://x.com~~\n"],
    ["www.x.com_", ["p <a \"http://www.x.com\">www.x.com</a>_"], "[www.x.com](http://www.x.com)\\_\n"],
    ["xhttps://x.com", ["p xhttps://x.com"], SAME],
    ["\"https://x.com\"", ["p \"<a \"https://x.com\">https://x.com</a>\""], SAME],
    ["xhttps://x.com 0https://x.com", ["p xhttps://x.com 0<a \"https://x.com\">https://x.com</a>"], SAME],
    // As on GitHub, `www.` followed by more text is a link to `www`; at the end it is not.
    ["www. www.", ["p <a \"http://www\">www</a>. www."], "[www](http://www). www.\n"],
    ["react@0.11.1 a@b.co1", ["p react@0.11.1 a@b.co1"], SAME],
    ["https://x.com/路径", ["p <a \"https://x.com/路径\">https://x.com/路径</a>"], SAME],
    ["https://例子.测试/a", ["p <a \"https://例子.测试/a\">https://例子.测试/a</a>"], SAME],
    ["`https://x.com`", ["p <code>https://x.com</code>"], SAME],
    ["[see www.x.com](https://y)", ["p <a \"https://y\">see www.x.com</a>"], SAME],
    ["foo@bar.baz", ["p <a \"mailto:foo@bar.baz\">foo@bar.baz</a>"], SAME],
    ["foo@bar", ["p foo@bar"], SAME],
    ["a.b-c_d@a.b.", ["p <a \"mailto:a.b-c_d@a.b\">a.b-c_d@a.b</a>."], SAME],
    ["a.b-c_d@a.b-", ["p a.b-c_d@a.b-"], SAME],
    ["a.b-c_d@a.b_", ["p a.b-c_d@a.b_"], "a.b-c_d@a.b\\_\n"],
    ["hello@mail+xyz.example", ["p hello@mail+xyz.example"], SAME],
    ["hello+xyz@mail.example", ["p <a \"mailto:hello+xyz@mail.example\">hello+xyz@mail.example</a>"], SAME],
    ["x@y.z@w.v", ["p x@<a \"mailto:y.z@w.v\">y.z@w.v</a>"], SAME],
    ["**a@b.co**", ["p <a \"mailto:a@b.co\"><b>a@b.co</b></a>"], SAME],
  ]);

  section('Autolink literals off', PLAIN, [
    ["https://x.com and a@b.co", ["p https://x.com and a@b.co"], SAME],
    ["www.x.com", ["p www.x.com"], SAME],
    ["<https://y.org>", ["p <a \"https://y.org\">https://y.org</a>"], SAME],
  ]);

  section('Images', NONE, [
    ["![alt](src \"title\")", ["p <img \"src\" alt=\"alt\" title=\"title\">"], SAME],
    ["![a *b*](s)", ["p <img \"s\" alt=\"a b\">"], "![a b](s)\n"],
    ["![](s)", ["p <img \"s\" alt=\"\">"], SAME],
    ["[![img](i)](u)", ["p <a \"u\"><img \"i\" alt=\"img\"></a>"], SAME],
    ["!not image", ["p !not image"], SAME],
    ["![alt]", ["p ![alt]"], "\\!\\[alt\\]\n"],
  ]);

  section('Inline HTML', NONE, [
    ["<b>bold</b>", ["p <html><b></html>bold<html></b></html>"], SAME],
    ["<span class=\"x\">t</span>", ["p <html><span class=\"x\"></html>t<html></span></html>"], SAME],
    ["a <!-- c --> b", ["p a <html><!-- c --></html> b"], SAME],
    ["a < b > c", ["p a < b > c"], SAME],
    ["<3", ["p <3"], SAME],
  ]);

  section('Backslash escapes', NONE, [
    ["\\*not italic\\*", ["p *not italic*"], SAME],
    ["\\\\", ["p \\"], SAME],
    ["\\a", ["p \\a"], SAME],
    ["\\#\\@\\$", ["p #@$"], "#@$\n"],
    ["1\\. not list", ["p 1. not list"], SAME],
    ["\\- not list", ["p - not list"], SAME],
    ["\\> not quote", ["p > not quote"], SAME],
    ["\\#x", ["p #x"], "#x\n"],
  ]);

  section('Character references', NONE, [
    ["&copy; &#169; &#xA9;", ["p © © ©"], "© © ©\n"],
    ["&nosuch;", ["p &nosuch;"], "\\&nosuch;\n"],
    ["&amp;copy;", ["p &copy;"], "\\&copy;\n"],
    ["AT&T", ["p AT&T"], SAME],
    ["&#0;", ["p �"], "�\n"],
  ]);

  it('drops a space written as a reference at the start of a line when the block is saved', () => {
    // Markdown strips spaces that start a line, so an edited block does not keep them.
    expect(docForm(parseMarkdown('&#32;lead'))).toEqual(['p  lead']);
    expect(serializeMarkdown(parseMarkdown('&#32;lead'))).toBe('lead\n');
    const { doc, source } = loadMarkdown('&#32;lead');
    expect(serializeMarkdown(doc, { source }), 'saved unedited').toBe('&#32;lead');
  });

  section('Math', MATH, [
    ["$x^2$ and $$y$$", ["p <math>$x^2$</math> and <math>$$y$$</math>"], SAME],
    ["costs $5 and $10", ["p costs $5 and $10"], "costs \\$5 and \\$10\n"],
    ["\\$5", ["p $5"], SAME],
    ["$ x $", ["p $ x $"], "\\$ x \\$\n"],
    ["$x $", ["p $x $"], "\\$x \\$\n"],
    ["$x$5", ["p $x$5"], "\\$x\\$5\n"],
    ["$a$$b$", ["p <math>$a$$b$</math>"], SAME],
    // An escaped dollar is not part of a dollar run.
    ["\\$$x$", ["p $<math>$x$</math>"], SAME],
    ["$`code`$", ["p <math>$`code`$</math>"], SAME],
    ["`$x$`", ["p <code>$x$</code>"], SAME],
    ["$$\nx\n$$", ["raw(math) $$⏎x⏎$$"], SAME],
    ["text\n$$\nx\n$$", ["p text", "raw(math) $$⏎x⏎$$"], "text\n\n$$\nx\n$$\n"],
    ["$$\nunclosed", ["raw(math) $$⏎unclosed"], SAME],
    ["$$x$$ rest", ["p <math>$$x$$</math> rest"], SAME],
  ]);

  section('Footnotes', NOTES, [
    ["ref[^1]\n\n[^1]: note\ncontinued", ["p ref<footnote>[^1]</footnote>", "raw(footnote) [^1]: note⏎continued"], SAME],
    ["x[^1][^2]", ["p x<footnote>[^1][^2]</footnote>"], SAME],
    ["[^1]: one\n[^2]: two", ["raw(footnote) [^1]: one", "raw(footnote) [^2]: two"], "[^1]: one\n\n[^2]: two\n"],
    ["[^1]: note\n# heading", ["raw(footnote) [^1]: note", "h1 heading"], "[^1]: note\n\n# heading\n"],
    ["[^1]:no space", ["raw(footnote) [^1]:no space"], SAME],
    // After a blank line, a definition goes on only in lines indented four spaces or a tab (GitHub); blank lines at its end are not part of it.
    ["[^1]: a\n\n    b\n\nc", ["raw(footnote) [^1]: a⏎⏎    b", "p c"], SAME],
    ["[^1]: a\n\n    b\n        code\n\nc", ["raw(footnote) [^1]: a⏎⏎    b⏎        code", "p c"], SAME],
    ["[^1]: a\n\n    b\nlazy\n\n    [^2]: still one", ["raw(footnote) [^1]: a⏎⏎    b⏎lazy⏎⏎    [^2]: still one"], SAME],
    ["[^1]: a\n\n\tb\n\nc", ["raw(footnote) [^1]: a⏎⏎\tb", "p c"], SAME],
    ["[^1]: a\n\nb", ["raw(footnote) [^1]: a", "p b"], SAME],
    ["[^1]: a\n\n\n\nb", ["raw(footnote) [^1]: a", "p b"], "[^1]: a\n\nb\n"],
    ["[^1]: a\n\n  b", ["raw(footnote) [^1]: a", "p b"], "[^1]: a\n\nb\n"],
    ["[^1]: a\n\n[^2]: b", ["raw(footnote) [^1]: a", "raw(footnote) [^2]: b"], SAME],
    ["[^1]: a\n\n# h", ["raw(footnote) [^1]: a", "h1 h"], SAME],
    ["[^a b]", ["p [^a b]"], "\\[^a b\\]\n"],
  ]);

  section('Footnotes off', NONE, [
    ["[^1]", ["p [^1]"], "\\[^1\\]\n"],
  ]);

  section('Tags and mentions', TAGS, [
    ["#work and #work/meeting", ["p #work and #work/meeting"], SAME],
    ["#tag at start", ["p #tag at start"], SAME],
    ["## Notes #work", ["h2 Notes #work"], SAME],
    ["# real heading", ["h1 real heading"], SAME],
    ["C# and a#b", ["p C# and a#b"], SAME],
    ["issue #123", ["p issue #123"], SAME],
    ["\\#escaped", ["p <escape>\\#</escape>escaped"], SAME],
    ["\\#", ["p <escape>\\#</escape>"], SAME],
    ["a \\# b", ["p a <escape>\\#</escape> b"], SAME],
    ["\\# heading", ["p <escape>\\#</escape> heading"], SAME],
    ["\\\\#x", ["p \\#x"], SAME],
    ["\\@nobody", ["p <escape>\\@</escape>nobody"], SAME],
    ["#**work**", ["p #<b>work</b>"], "&#35;**work**\n"],
    ["&#35;**work**", ["p #<b>work</b>"], SAME],
    ["#\\#", ["p #<escape>\\#</escape>"], "&#35;\\#\n"],
    ["**#bold**", ["p <b>#bold</b>"], SAME],
    ["`#code`", ["p <code>#code</code>"], SAME],
    ["[#link](u)", ["p <a \"u\">#link</a>"], SAME],
    ["https://x.com/#anchor", ["p <a \"https://x.com/#anchor\">https://x.com/#anchor</a>"], SAME],
    ["@alice and bob@example.com", ["p @alice and <a \"mailto:bob@example.com\">bob@example.com</a>"], SAME],
    ["1\\. one", ["p 1. one"], SAME],
    ["\\*x\\*", ["p *x*"], SAME],
  ]);

  section('Breaks and setext off', NOTES, [
    ["line one\nline two", ["p line one⏎line two"], SAME],
    ["a  \nb", ["p a⏎b"], "a\nb\n"],
    ["a \nb", ["p a⏎b"], "a\nb\n"],
    ["a\n\nb", ["p a", "p b"], SAME],
    ["Title\n---", ["p Title", "hr"], "Title\n\n---\n"],
    ["Title\n===", ["p Title⏎==="], "Title\n\\===\n"],
    ["$x$ #tag @me https://x.com", ["p <math>$x$</math> #tag @me <a \"https://x.com\">https://x.com</a>"], SAME],
  ]);

  section('Other syntax', NONE, [
    ["==highlight==", ["p ==highlight=="], SAME],
    ["[[wiki link]]", ["p [[wiki link]]"], "\\[\\[wiki link\\]\\]\n"],
    [":emoji:", ["p :emoji:"], SAME],
    ["{attributes}", ["p {attributes}"], SAME],
    ["::: note\nText\n:::", ["p ::: note Text :::"], "::: note Text :::\n"],
  ]);

  section('Other syntax with breaks', NOTES, [
    ["::: note\nText\n:::", ["p ::: note⏎Text⏎:::"], SAME],
  ]);
});

describe('tags and mentions: highlighted ranges', () => {
  const extensions = [tags(), mentions()];
  /** The highlighted text in each text container of the document (table cells included). */
  const highlighted = (md: string, options: MarkdownOptions = TAGS): string[] => {
    const out: string[] = [];
    const scan = (block: Block, content: Inline, cell?: { row: number; col: number }) => {
      const ctx = decorationContext(block, content, cell);
      const text = inlineText(content);
      for (const ext of extensions) for (const d of ext.decorations!(ctx)) out.push(text.slice(d.from, d.to));
    };
    for (const block of parseMarkdown(md, options).blocks) {
      if (block.type === 'table') block.rows.forEach((row, r) => row.forEach((cell, c) => scan(block, cell, { row: r, col: c })));
      else if (block.type !== 'code' && block.type !== 'raw' && 'content' in block) scan(block, block.content);
    }
    return out;
  };
  const cases: [string, string[]][] = [
    // Spec examples
    ['#work and #work/meeting', ['#work', '#work/meeting']],
    ['(#ideas)', ['#ideas']],
    ['#日记 #हिन्दी #🚀', ['#日记', '#हिन्दी', '#🚀']],
    ['#2024/q1', ['#2024/q1']],
    ['#tag.', ['#tag']],
    ['#a/', ['#a']],
    ['a#b, C#, ##x', ['#b', '#x']],
    ['#123, #-a, # x', ['#123', '#-a']],
    ['#️⃣', []],
    ['@alice, @bob.smith.', ['@alice', '@bob']],
    ['(@carol)', ['@carol']],
    ['bob@example.com', []],
    ['@-x', []],
    ['## Weekly notes #work', ['#work']],
    ['- [ ] Ship it #work', ['#work']],
    ['**#bold/tag**', ['#bold/tag']],
    ['#**work**', []],
    ['#wo**rk**', ['#wo']],
    ['`#code`', []],
    ['[#link](https://x)', []],
    ['https://x.com/#anchor', []],
    ['\\#not-a-tag', []],
    ['# heading', []],
    // Unusual cases
    ['> Quote #work', ['#work']],
    ['| a #work |\n| - |\n| @alice |', ['#work', '@alice']],
    ['```\n#x\n```', []],
    ['<div>#x</div>', []],
    ['<span>#x</span>', ['#x']],
    ['#a#b', ['#a', '#b']],
    ['#a,#b;#c', ['#a', '#b', '#c']],
    ['#a/b/c #a//b', ['#a/b/c', '#a']],
    ['#a-b #_x', ['#a-b', '#_x']],
    ['#x_ #x-', ['#x_', '#x-']],
    // `_x #x_` is emphasis, so `#` and `x` are in different runs.
    ['#_x #x_', ['#x']],
    ['#👨‍👩‍👧 #👍🏽 #café #مرحبا', ['#👨‍👩‍👧', '#👍🏽', '#café', '#مرحبا']],
    ['#ab*cd*', ['#ab']],
    ['*#x*', ['#x']],
    ['\\#x #y', ['#y']],
    // An escaped backslash, then a tag.
    ['\\\\#x', ['#x']],
    ['@a_b @a.b.c @日本 @1abc @_x', ['@a', '@a', '@1abc']],
    ['@@x x@y +@z .@w', ['@x', '@z', '@w']],
    ['\\@nobody @somebody', ['@somebody']],
    ['mail a@b.co or @team', ['@team']],
    ['#x $#y$ #z', ['#x', '#y', '#z']],
  ];
  for (const [md, expected] of cases) {
    it(JSON.stringify(md), () => expect(highlighted(md)).toEqual(expected));
  }

  it('skips math tokens when math() is on', () => {
    expect(highlighted('#x $#y$ #z', NOTES)).toEqual(['#x', '#z']);
  });
});

describe('typing', () => {
  /** Types `text` into an empty paragraph, with the editor's input rules in the editor's order. */
  const type = (text: string, options: MarkdownOptions = NOTES): string[] => {
    const block = paragraph();
    let state = { ...createState({ blocks: [block] }), selection: caret(block.id, 0) };
    const inline = (options.syntax ?? []).flatMap((s) => s.inline ?? []);
    for (const ch of text) {
      state = insertText(state, ch);
      if (ch === ' ' || ch === '-') state = applyBlockInputRules(state) ?? state;
      if ('*_`~'.includes(ch)) state = applyInlineInputRules(state) ?? state;
      if (inline.length > 0) state = applyTokenInputRules(state, inline) ?? state;
      if (ch === ' ' && options.autolinks !== false) state = applyAutolinkInputRule(state) ?? state;
    }
    return state.doc.blocks.map(blockForm);
  };
  const cases: [string, string[]][] = [
    // Block shortcuts
    ['# a', ['h1 a']],
    ['###### a', ['h6 a']],
    ['####### a', ['p ####### a']],
    ['- a', ['bullet:0 a']],
    ['* a', ['bullet:0 a']],
    ['+ a', ['bullet:0 a']],
    ['1. a', ['ordered:0 a']],
    ['3) a', ['ordered@3:0 a']],
    ['[ ] a', ['task[ ]:0 a']],
    ['[x] a', ['task[x]:0 a']],
    ['- [ ] a', ['task[ ]:0 a']],
    ['> a', ['quote a']],
    ['[!tip] a', ['callout(tip) a']],
    ['> [!WARNING] a', ['callout(warning) a']],
    ['[!fyi] a', ['p [!fyi] a']],
    ['>>> a', ['details a', 'p ', '/details']],
    ['>> a', ['p >> a']],
    ['```ts ', ['code(ts) ']],
    ['---', ['hr', 'p ']],
    ['a # b', ['p a # b']],
    ['#tag ', ['p #tag ']],
    // Inline shortcuts
    ['**a** ', ['p <b>a</b> ']],
    ['__a__ ', ['p <b>a</b> ']],
    ['*a* ', ['p <i>a</i> ']],
    ['_a_ ', ['p <i>a</i> ']],
    ['`a` ', ['p <code>a</code> ']],
    ['~~a~~ ', ['p <s>a</s> ']],
    ['snake_case_ ', ['p snake_case_ ']],
    ['* a *', ['bullet:0 a *']],
    ['** a **', ['p ** a **']],
    // Autolink literals
    ['go to https://x.com/a. ', ['p go to <a "https://x.com/a">https://x.com/a</a>. ']],
    ['(www.x.com) ', ['p (<a "http://www.x.com">www.x.com</a>) ']],
    ['mail me@x.io ', ['p mail <a "mailto:me@x.io">me@x.io</a> ']],
    ['https://x ', ['p <a "https://x">https://x</a> ']],
    ['https://-x ', ['p https://-x ']],
    ['xhttps://x.com ', ['p xhttps://x.com ']],
    ['`https://x.com` ', ['p <code>https://x.com</code> ']],
    // Tokens and escapes
    ['$x^2$ ', ['p <math>$x^2$</math> ']],
    ['costs $5 ', ['p costs $5 ']],
    ['note[^1] ', ['p note<footnote>[^1]</footnote> ']],
    ['\\#x ', ['p <escape>\\#</escape>x ']],
    ['\\@x ', ['p <escape>\\@</escape>x ']],
    // A typed backslash is text; the second one starts an escape.
    ['\\\\#x ', ['p \\<escape>\\#</escape>x ']],
  ];
  for (const [text, expected] of cases) {
    it(JSON.stringify(text), () => expect(type(text)).toEqual(expected));
  }

  it('leaves typed URLs as text with autolinks: false', () => {
    expect(type('https://x.com ', { autolinks: false })).toEqual(['p https://x.com ']);
  });
});
