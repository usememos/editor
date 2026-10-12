// A note-taking dialect: breaks, no setext headings, math and footnotes. Content
// in these syntaxes is kept as source and saved verbatim.

import { describe, expect, it } from 'vitest';
import { type Block, type Doc, type Span, caret, createState, inlineText, paragraph, plain, withContent } from '../src/model';
import { applyTokenInputRules, insertText } from '../src/commands';
import { footnotes } from '../src/extensions/footnotes';
import { math, mathSource } from '../src/extensions/math';
import type { MarkdownOptions } from '../src/markdown/options';
import { parseMarkdown } from '../src/markdown/parse';
import { serializeMarkdown } from '../src/markdown/serialize';
import { loadMarkdown } from '../src/markdown/source';

const NOTES: MarkdownOptions = { breaks: true, setext: false, syntax: [math().markdown!, footnotes().markdown!] };

const shape = (doc: Doc) => doc.blocks.map(({ id: _id, ...rest }) => rest);
const spans = (md: string) => {
  const block = parseMarkdown(md, NOTES).blocks[0]!;
  return 'content' in block ? block.content.map((s: Span) => (s.token ? `[${s.token}:${s.text}]` : s.text)) : [];
};
/** Saving without the source: how an edited block is written. */
const rewrite = (md: string) => serializeMarkdown(parseMarkdown(md, NOTES), NOTES);

describe('math', () => {
  it('reads inline math as tokens that keep their source', () => {
    expect(spans('Euler $e^{i\\pi}+1=0$ and $\\{a\\}$')).toEqual(['Euler ', '[math:$e^{i\\pi}+1=0$]', ' and ', '[math:$\\{a\\}$]']);
    expect(spans('$$x^2$$ inline')).toEqual(['[math:$$x^2$$]', ' inline']);
    expect(rewrite('Euler $e^{i\\pi}$ and $\\{a\\}$')).toBe('Euler $e^{i\\pi}$ and $\\{a\\}$\n');
  });

  it('treats dollar signs that are not math as text, and escapes them when saving', () => {
    expect(spans('costs $5 and $10')).toEqual(['costs $5 and $10']);
    expect(spans('price \\$5')).toEqual(['price $5']);
    expect(spans('a $ b $ c')).toEqual(['a $ b $ c']);
    expect(rewrite('costs $5 and $10')).toBe('costs \\$5 and \\$10\n');
    expect(rewrite('price \\$5')).toBe('price \\$5\n');
  });

  it('reads $$ fences as raw math blocks, also in the middle of a paragraph', () => {
    const md = 'before\n$$\n\\int_0^1 x\\,dx\n= \\frac12\n$$\nafter';
    expect(shape(parseMarkdown(md, NOTES))).toEqual([
      { type: 'paragraph', content: plain('before') },
      { type: 'raw', syntax: 'math', content: plain('$$\n\\int_0^1 x\\,dx\n= \\frac12\n$$') },
      { type: 'paragraph', content: plain('after') },
    ]);
    expect(rewrite(md)).toBe('before\n\n$$\n\\int_0^1 x\\,dx\n= \\frac12\n$$\n\nafter\n');
  });

  it('ends an unclosed math block with its container', () => {
    expect(shape(parseMarkdown('$$\nx', NOTES))).toEqual([{ type: 'raw', syntax: 'math', content: plain('$$\nx') }]);
  });
});

describe('footnotes', () => {
  it('keeps references and definitions as source', () => {
    const md = 'Text[^1] and[^note].\n\n[^1]: The note.\n[^note]: Another\ncontinued.\n\nAfter.';
    expect(shape(parseMarkdown(md, NOTES))).toEqual([
      {
        type: 'paragraph',
        content: [plain('Text')[0], { text: '[^1]', marks: [], token: 'footnote' }, plain(' and')[0], { text: '[^note]', marks: [], token: 'footnote' }, plain('.')[0]],
      },
      { type: 'raw', syntax: 'footnote', content: plain('[^1]: The note.') },
      { type: 'raw', syntax: 'footnote', content: plain('[^note]: Another\ncontinued.') },
      { type: 'paragraph', content: plain('After.') },
    ]);
    expect(rewrite(md)).toBe('Text[^1] and[^note].\n\n[^1]: The note.\n\n[^note]: Another\ncontinued.\n\nAfter.\n');
  });
});

describe('setext headings and breaks', () => {
  it('reads underlined text as a paragraph and a divider, and single newlines as line breaks', () => {
    expect(shape(parseMarkdown('Title\n---\nline one\nline two', NOTES))).toEqual([
      { type: 'paragraph', content: plain('Title') },
      { type: 'divider' },
      { type: 'paragraph', content: plain('line one\nline two') },
    ]);
  });
});

describe('note content survives an edit next to it', () => {
  const samples = [
    'line one\nline two\nline three',
    '#tag at start\n\n#work/project and #中文',
    'hi @alice, see @bob.',
    'Euler $e^{i\\pi}+1=0$ and $$x^2$$ inline',
    '$$\n\\int_0^1 x\\,dx\n= \\frac12\n$$',
    '$\\{a\\}$ and $a\\\\b$',
    'price \\$5 and \\$10',
    'Text[^1].\n\n[^1]: The note.',
    'Title\n---\n\nmore',
    '> - a\n> - b',
    '> line one\n> line two',
    '> ```\n> code\n> ```',
    '- item\n\n  continued para',
    '- item\n  ```\n  code\n  ```',
    '<details>\n<summary>More</summary>\n\nhidden text\n\n</details>',
    '![photo](/file/attachments/abc123)',
    '- [ ] todo\n- plain\n- [x] done',
    '# Weekly review\n\n## Done\n- shipped login\n- fixed #123\n\n## Next\n1. search\n2. export',
    'Meeting notes 2024-05-01\n\n* Alice: ok\n* Bob: blocked\n\n---\n\nAction items below',
    '1) first\n2) second\n3) third',
    '3. three\n4. four',
    '+ plus\n+ list',
    '- a\n    - b\n        - c',
    '- loose\n\n- list\n\n- items',
    '**bold** __also bold__ *it* _it_ ~~gone~~ ~single~',
    '***both*** and **_mixed_**',
    'Use `npm i` or ``code with ` tick``',
    '```ts\nconst a = 1;\n```\n\n~~~\ntilde fence\n~~~',
    '    indented code\n    block',
    '```mermaid\ngraph TD\n  A-->B\n```',
    '| Name | Qty |\n|:-----|----:|\n| apple | 3 |\n| pear | 10 |',
    '| a | b |\n| --- | --- |\n| `x|y` | \\| pipe |',
    'Visit https://example.com or <https://github.com>.',
    '[link](https://a.com "title") and [ref][r]\n\n[r]: https://r.com',
    '![alt text](https://img.example/a.png "cap") inline image',
    'line with two trailing spaces  \nnext line',
    'backslash break\\\nnext',
    'emoji 🎉 and CJK 你好世界 and RTL שלום',
    '&copy; 2024 &mdash; AT&T &#169;',
    'a <kbd>Ctrl</kbd> + <kbd>C</kbd> and <br> tag',
    '<!-- hidden comment -->\n\nvisible',
    '<div align="center">\n  <img src="x.png">\n</div>',
    '***\n\n___\n\n- - -',
    '>quote without space\n>> nested quote',
    '\\# not a heading and \\* not a bullet',
    '#not-heading and # real heading?',
    '&nbsp;\n\nafter an empty line\n\n&nbsp;\n\nend',
    'Inline $a$, block:\n$$\nb\n$$\nafter',
    'Cost $5, total $10.50 and $ 3 $',
    'Multiple[^a] notes[^b].\n\n[^a]: First.\n[^b]: Second\n    continued.',
  ];
  it('has at least 50 samples', () => expect(samples.length).toBeGreaterThanOrEqual(50));

  for (const md of samples) {
    it(`untouched: ${JSON.stringify(md)}`, () => {
      const { doc, source } = loadMarkdown(md, NOTES);
      expect(serializeMarkdown(doc, { ...NOTES, source })).toBe(md);
    });
    it(JSON.stringify(md), () => {
      const { doc, source } = loadMarkdown(`${md}\n\nedit me`, NOTES);
      const last = doc.blocks.length - 1;
      const edited: Block[] = doc.blocks.map((b, i) => (i === last && b.type === 'paragraph' ? withContent(b, plain('edited')) : b));
      expect(serializeMarkdown({ blocks: edited }, { ...NOTES, source })).toBe(`${md}\n\nedited`);
    });
  }

  it('rewrites the samples without changing what they mean', () => {
    for (const md of samples) {
      const once = rewrite(md);
      expect(shape(parseMarkdown(once, NOTES)), md).toEqual(shape(parseMarkdown(md, NOTES)));
    }
  });
});

describe('typing a token', () => {
  const type = (text: string) => {
    const block = paragraph();
    let state = { ...createState({ blocks: [block] }), selection: caret(block.id, 0) };
    const inline = NOTES.syntax!.flatMap((s) => s.inline ?? []);
    for (const ch of text) {
      state = insertText(state, ch);
      state = applyTokenInputRules(state, inline) ?? state;
    }
    return state.doc.blocks[0]!;
  };

  it('turns $x^2$ into a math token when the closing dollar is typed', () => {
    const block = type('a $x\\{y\\}$ b');
    expect('content' in block && block.content.map((s) => s.token ?? '')).toEqual(['', 'math', '']);
    expect(serializeMarkdown({ blocks: [block] }, NOTES)).toBe('a $x\\{y\\}$ b\n');
  });

  it('leaves prices as text', () => {
    const block = type('costs $5 and $10 ');
    expect('content' in block && inlineText(block.content)).toBe('costs $5 and $10 ');
    expect(serializeMarkdown({ blocks: [block] }, NOTES)).toBe('costs \\$5 and \\$10&#32;\n');
  });

  it('turns [^1] into a footnote reference', () => {
    const block = type('see[^1]');
    expect('content' in block && block.content.map((s) => s.token ?? '')).toEqual(['', 'footnote']);
  });
});

describe('math source', () => {
  it('takes the TeX out of tokens and fenced blocks', () => {
    expect(mathSource('$x^2$', 'inline')).toBe('x^2');
    expect(mathSource('$$\\sum$$', 'inline')).toBe('\\sum');
    expect(mathSource('$$\na\nb\n$$', 'block')).toBe('a\nb');
    expect(mathSource('$$$\na\n  $$$ ', 'block')).toBe('a');
    // An unclosed block runs to the end of the document.
    expect(mathSource('$$\na', 'block')).toBe('a');
  });

  it('adds a math view only when given a render function', () => {
    expect(math().views).toBeUndefined();
    expect(Object.keys(math({ render: () => {} }).views!)).toEqual(['math']);
  });
});
