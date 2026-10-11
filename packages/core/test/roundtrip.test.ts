// Lowering rules (Markdown → model), serializer conventions (model →
// Markdown), and the save-stability invariant:
//
//   serialize(parse(serialize(parse(md)))) === serialize(parse(md))
//
// for every CommonMark and GFM spec example, plus seeded random documents
// checking that parse(serialize(doc)) gives back the same content.

import { describe, expect, it } from 'vitest';
import {
  ATOM_CHAR,
  type Block,
  type Doc,
  type Inline,
  type Mark,
  type Span,
  codeBlock,
  divider,
  heading,
  htmlBlock,
  inlineText,
  listItem,
  normalizeInline,
  paragraph,
  quote,
  sortMarks,
  table,
} from '../src/model';
import { parseMarkdown } from '../src/markdown/parse';
import { representableInline, serializeInline, serializeMarkdown } from '../src/markdown/serialize';
import { commonmark, gfm } from './fixtures/examples';
import type { MarkdownOptions } from '../src/markdown/options';
import { footnotes } from '../src/extensions/footnotes';
import { math } from '../src/extensions/math';

const t = (text: string, ...marks: Mark[]): Span => ({ text, marks: sortMarks(marks) });
const link = (text: string, href: string, ...marks: Mark[]): Span => ({ text, marks: sortMarks(marks), link: href });

/** Blocks without their random IDs. */
function shape(doc: Doc): unknown[] {
  return doc.blocks.map(({ id: _id, ...rest }) => rest);
}

const roundTrip = (md: string) => serializeMarkdown(parseMarkdown(md));

describe('save stability on spec examples', () => {
  for (const ex of [...commonmark, ...gfm]) {
    const name = `${ex.extension ? 'GFM ' + ex.extension : 'CommonMark'} example ${ex.example} (${ex.section})`;
    it(name, () => {
      const once = roundTrip(ex.markdown);
      expect(roundTrip(once)).toBe(once);
    });
  }
});

describe('lowering: Markdown → model', () => {
  it('turns soft breaks into spaces and hard breaks into "\\n"', () => {
    expect(shape(parseMarkdown('a\nb  \nc\\\nd'))).toEqual([{ type: 'paragraph', content: [t('a b\nc\nd')] }]);
  });

  it('flattens nested lists into indents up to 5, and keeps deeper lists as source', () => {
    const doc = parseMarkdown('- a\n  - b\n    - c\n      - d\n        - e\n          - f');
    expect(doc.blocks.map((b) => (b.type === 'listItem' ? b.indent : -1))).toEqual([0, 1, 2, 3, 4, 5]);
    const deeper = '- a\n  - b\n    - c\n      - d\n        - e\n          - f\n            - g';
    expect(shape(parseMarkdown(deeper))).toEqual([{ type: 'raw', syntax: 'markdown', content: [t(deeper)] }]);
  });

  it('keeps the start number on the first ordered item and reads task items', () => {
    expect(shape(parseMarkdown('3. a\n4. b\n\n- [ ] t\n- [x] u'))).toEqual([
      { type: 'listItem', listType: 'ordered', indent: 0, checked: false, start: 3, content: [t('a')] },
      { type: 'listItem', listType: 'ordered', indent: 0, checked: false, content: [t('b')] },
      { type: 'listItem', listType: 'task', indent: 0, checked: false, content: [t('t')] },
      { type: 'listItem', listType: 'task', indent: 0, checked: true, content: [t('u')] },
    ]);
  });

  it('keeps lists and quotes the model cannot hold as Markdown source', () => {
    const cases = [
      '- p1\n\n  p2\n- next',
      '- item\n  ```js\n  code\n  ```',
      '- item\n\n  > q',
      '> p1\n> - a\n> - [ ] b',
      '> # H',
      '>     code',
      '> > nested',
    ];
    for (const md of cases) {
      expect(shape(parseMarkdown(`before\n\n${md}\n\nafter`)), md).toEqual([
        { type: 'paragraph', content: [t('before')] },
        { type: 'raw', syntax: 'markdown', content: [t(md)] },
        { type: 'paragraph', content: [t('after')] },
      ]);
    }
  });

  it('lowers each paragraph of a quote to a quote block', () => {
    expect(shape(parseMarkdown('> p1\n>\n> p2\nlazy'))).toEqual([
      { type: 'quote', content: [t('p1')] },
      { type: 'quote', content: [t('p2 lazy')] },
    ]);
  });

  it('resolves references and lowers links, images, raw HTML, code and entities', () => {
    const doc = parseMarkdown('[a][r] ![i](s "t") <b>x</b> `c` &copy; <http://x.y>\n\n[r]: /u "T"');
    expect(shape(doc)).toEqual([
      {
        type: 'paragraph',
        content: [
          link('a', '/u'),
          t(' '),
          { text: ATOM_CHAR, marks: [], image: { src: 's', alt: 'i', title: 't' } },
          t(' '),
          t('<b>', 'html'),
          t('x'),
          t('</b>', 'html'),
          t(' '),
          t('c', 'code'),
          t(' © '),
          link('http://x.y', 'http://x.y'),
        ],
      },
    ]);
  });

  it('lowers code, HTML blocks, dividers and tables', () => {
    const md = '<div>\nhtml\n</div>\n\n---\n\n    indented\n\n~~~ ruby startline=3\nx\n~~~\n\n| a | b |\n|:-|-:|\n| `x\\|y` | **z** |';
    expect(shape(parseMarkdown(md))).toEqual([
      { type: 'raw', syntax: 'html', content: [t('<div>\nhtml\n</div>')] },
      { type: 'divider' },
      { type: 'code', language: '', content: [t('indented')] },
      { type: 'code', language: 'ruby', content: [t('x')] },
      {
        type: 'table',
        align: ['left', 'right'],
        rows: [
          [[t('a')], [t('b')]],
          [[t('x|y', 'code')], [t('z', 'bold')]],
        ],
      },
    ]);
  });
});

describe('serializer conventions', () => {
  const md = (...blocks: Block[]) => serializeMarkdown({ blocks });

  it('writes marks, code spans, links and images', () => {
    expect(
      serializeInline([
        t('b', 'bold'),
        t(' '),
        t('i', 'italic'),
        t(' '),
        t('s', 'strike'),
        t(' '),
        t('a`b', 'code'),
        t(' '),
        link('text', 'http://e.com/x(1)'),
        t(' '),
        link('http://x.y', 'http://x.y'),
        t(' '),
        link('me@x.y', 'mailto:me@x.y'),
        t(' '),
        link('sp', 'a b'),
        t(' '),
        { text: ATOM_CHAR, marks: [], image: { src: 'p.png', alt: 'A *b*', title: 'say "hi"' } },
        t(' '),
        t('<kbd>', 'html'),
      ]),
    ).toBe(
      '**b** *i* ~~s~~ ``a`b`` [text](http://e.com/x(1)) <http://x.y> <me@x.y> [sp](<a b>) ![A \\*b\\*](p.png "say \\"hi\\"") <kbd>',
    );
  });

  it('writes headings, lists, tasks, code, dividers and tables', () => {
    expect(
      md(
        heading(2, [t('Title #')]),
        listItem('bullet', [t('a')]),
        listItem('ordered', [t('one')], { indent: 1, start: 9 }),
        listItem('ordered', [t('two')], { indent: 1 }),
        listItem('ordered', [t('three')], { indent: 1 }),
        listItem('task', [t('nested')], { indent: 2, checked: true }),
        listItem('task', [t('todo')]),
        codeBlock('ts', 'const s = ```;'),
        divider(),
        table(['left', 'center', null], [[[t('a|b')], [t('c')], []], [[t('1')], [t('x', 'bold')], [t('y')]]]),
      ),
    ).toBe(
      [
        '## Title \\#',
        '',
        '- a',
        '',
        '  9. one',
        '  10. two',
        '  11. three',
        '      - [x] nested',
        '- [ ] todo',
        '',
        '````ts',
        'const s = ```;',
        '````',
        '',
        '---',
        '',
        '| a\\|b | c |  |',
        '| :-- | :-: | --- |',
        '| 1 | **x** | y |',
        '',
      ].join('\n'),
    );
  });

  it('numbers consecutive ordered items as one list until another kind interrupts', () => {
    expect(
      md(
        listItem('ordered', [t('a')], { start: 3 }),
        listItem('ordered', [t('b')]),
        listItem('bullet', [t('c')]),
        listItem('ordered', [t('d')]),
        paragraph([t('p')]),
        listItem('ordered', [t('e')]),
      ),
    ).toBe('3. a\n4. b\n- c\n1. d\n\np\n\n1. e\n');
  });

  it('separates a nested list that could not interrupt its parent with a blank line', () => {
    const doc = { blocks: [listItem('bullet', [t('a')]), listItem('ordered', [t('b')], { indent: 1, start: 2 })] };
    expect(serializeMarkdown(doc)).toBe('- a\n\n  2. b\n');
    expect(shape(parseMarkdown(serializeMarkdown(doc)))).toEqual(shape(doc));
  });

  it('writes adjacent quotes as one blockquote and hard breaks as backslashes', () => {
    expect(md(quote([t('one\ntwo')]), quote([t('three')]), paragraph([t('after')]))).toBe(
      '> one\\\n> two\n>\n> three\n\nafter\n',
    );
  });

  it('writes empty paragraphs as &nbsp; and drops them at the end', () => {
    expect(md(paragraph([]), paragraph([t('x')]), quote([]))).toBe('&nbsp;\n\nx\n');
    expect(md(paragraph([t('a')]), paragraph([]), paragraph([]), paragraph([t('b')]), paragraph([]))).toBe(
      'a\n\n&nbsp;\n\n&nbsp;\n\nb\n',
    );
    expect(md(paragraph([]), paragraph([]))).toBe('');
    expect(serializeMarkdown({ blocks: [] })).toBe('');
  });

  it('reads a paragraph holding only a no-break space as an empty line', () => {
    for (const src of ['a\n\n&nbsp;\n\nb\n', 'a\n\n&#160;\n\nb\n', 'a\n\n\u00a0\n\nb\n']) {
      const doc = { blocks: [paragraph([t('a')]), paragraph([]), paragraph([t('b')])] };
      expect(shape(parseMarkdown(src))).toEqual(shape(doc));
    }
    // Only a lone, plain no-break space.
    const bold = { blocks: [paragraph([{ text: '\u00a0', marks: ['bold'] }])] };
    expect(shape(parseMarkdown('**&nbsp;**\n'))).toEqual(shape(bold));
    expect(shape(parseMarkdown('&nbsp;&nbsp;\n'))).toEqual(shape({ blocks: [paragraph([t('\u00a0\u00a0')])] }));
  });

  it('keeps lists on either side of an empty line apart', () => {
    const doc = {
      blocks: [
        listItem('ordered', [t('a')]),
        paragraph([]),
        listItem('ordered', [t('b')]),
        quote([t('q')]),
        paragraph([]),
        quote([t('r')]),
      ],
    };
    expect(serializeMarkdown(doc)).toBe('1. a\n\n&nbsp;\n\n1. b\n\n> q\n\n&nbsp;\n\n> r\n');
    expect(shape(parseMarkdown(serializeMarkdown(doc)))).toEqual(shape(doc));
  });

  it('writes html blocks verbatim', () => {
    expect(md(htmlBlock('<div>\n  *raw*\n</div>'))).toBe('<div>\n  *raw*\n</div>\n');
  });

  it('escapes only what would change meaning', () => {
    expect(serializeInline([t('1+1=2, a*b, 3 < 4 > 2, AT&T, &amp; [x] `y` ~z~ \\ \\* ! snake_case _x_')])).toBe(
      '1+1=2, a\\*b, 3 < 4 > 2, AT&T, \\&amp; \\[x\\] \\`y\\` \\~z\\~ \\ \\\\\\* ! snake_case \\_x\\_',
    );
    // "<" that could start a tag, "!" before a link.
    expect(serializeInline([t('<b> and !'), link('x', 'u')])).toBe('\\<b> and \\![x](u)');
  });

  it('escapes block syntax at the start of every line', () => {
    const lines = ['# h', '- item', '+ item', '1. one', '2) two', '> quote', '---', '===', '| --- | :-: |', '-- x'];
    const out = serializeInline([t(lines.join('\n'))]);
    expect(out).toBe(
      '\\# h\\\n\\- item\\\n\\+ item\\\n1\\. one\\\n2\\) two\\\n\\> quote\\\n\\---\\\n\\===\\\n| \\--- | :-: |\\\n-- x',
    );
    // The same inside list items and quotes.
    expect(md(listItem('bullet', [t('# not a heading\n> not a quote')]), quote([t('- not a list')]))).toBe(
      '- \\# not a heading\\\n  \\> not a quote\n\n> \\- not a list\n',
    );
  });

  it('keeps leading, trailing and line-edge spaces as entities', () => {
    expect(serializeInline([t('  a  \n    b')])).toBe('&#32; a &#32;\\\n&#32;   b');
    expect(md(heading(1, [t('x\ny')]), paragraph([t('end\n')]))).toBe('# x&#10;y\n\nend&#10;\n');
  });

  it('moves whitespace out of marks', () => {
    expect(serializeInline([t(' bold ', 'bold'), t('x')])).toBe('&#32;**bold** x');
  });

  it('uses "_" where "*" would merge with a neighbouring delimiter', () => {
    expect(serializeInline([t('x', 'italic'), t('y', 'bold')])).toBe('*x*__y__');
    expect(serializeInline([t('a', 'bold'), t('b', 'bold', 'italic'), t('c', 'italic')])).toBe('**a*b***_c_');
  });

  it('handles emphasis next to punctuation inside a word', () => {
    // a**"b"**c is not bold in CommonMark; an entity for the outer letter fixes the flanking.
    const inline = [t('a'), t('"b"', 'bold'), t('c')];
    const out = serializeInline(inline);
    expect(out).toBe('&#97;**"b"**&#99;');
    expect(shape(parseMarkdown(out))).toEqual([{ type: 'paragraph', content: inline }]);
  });

  it('escapes pipes in table cells, including code spans', () => {
    expect(md(table([null], [[[t('a|b', 'code')]], [[t(' x ')]]]))).toBe('| `a\\|b` |\n| --- |\n| &#32;x&#32; |\n');
  });
});

// ---------------------------------------------------------------------------
// Seeded random documents: parse(serialize(doc)) must give back the content.

function random(seed: number) {
  let s = seed;
  const next = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const pick = <T>(a: readonly T[]): T => a[Math.floor(next() * a.length)]!;
  return { next, pick };
}

const ALPHABET = 'ab .,"*_~`[]()!<>&#-=+1\\|\n:;é\t'.split('');
const SNIPPETS = ['- ', '1. ', '# ', '> ', '---', '| - |', '```', '    ', '[x] ', '<div>', '==='];
const MARKS: Mark[] = ['bold', 'italic', 'strike', 'code'];

function randomInline(r: ReturnType<typeof random>, allowHtml: boolean): Span[] {
  const text = (max: number) => {
    let out = '';
    const n = 1 + Math.floor(r.next() * max);
    for (let k = 0; k < n; k++) out += r.next() < 0.15 ? r.pick(SNIPPETS) : r.pick(ALPHABET);
    return out;
  };
  const spans: Span[] = [];
  const n = Math.floor(r.next() * 6);
  for (let i = 0; i < n; i++) {
    // Raw HTML at the very start of a block would start an HTML block, which
    // the parser never produces from a paragraph; leave that case out.
    if (allowHtml && i > 0 && r.next() < 0.05) {
      spans.push(t(r.pick(['<b>', '</i>', '<!-- c -->', '<a href="x">']), 'html'));
      continue;
    }
    let span: Span = { text: text(5), marks: sortMarks(MARKS.filter(() => r.next() < 0.25)) };
    if (r.next() < 0.1) span = { ...span, link: r.pick(['http://a.b', 'x y', 'a(b', 'u', 'mailto:a@b.c']) };
    if (r.next() < 0.05) {
      const image = { src: r.pick(['i.png', 'a b.png']), alt: text(3), ...(r.next() < 0.3 ? { title: 'T"q' } : {}) };
      span = { ...span, text: ATOM_CHAR, marks: span.marks.filter((m) => m !== 'code'), image };
    }
    spans.push(span);
  }
  return normalizeInline(spans);
}

function randomBlock(r: ReturnType<typeof random>, prevIndent: number): Block {
  const x = r.next();
  const inline = () => randomInline(r, true);
  if (x < 0.25) return paragraph(inline());
  if (x < 0.35) return heading(r.pick([1, 2, 3, 6] as const), inline());
  if (x < 0.6) {
    const type = r.pick(['bullet', 'ordered', 'task'] as const);
    const indent = Math.min(prevIndent + 1, Math.floor(r.next() * 3));
    return listItem(type, inline(), { indent, checked: r.next() < 0.5, start: r.next() < 0.3 ? r.pick([0, 2, 10]) : undefined });
  }
  if (x < 0.7) return quote(inline());
  if (x < 0.78) return codeBlock(r.pick(['', 'js', 'a`b']), inlineText(randomInline(r, false)).replace(/\t/g, ' '));
  if (x < 0.82) return htmlBlock(r.pick(['<div>\nhi\n</div>', '<!-- x -->']));
  if (x < 0.92) {
    const cols = 1 + Math.floor(r.next() * 3);
    const align = Array.from({ length: cols }, () => r.pick(['left', 'center', 'right', null] as const));
    return table(align, Array.from({ length: 1 + Math.floor(r.next() * 3) }, () => Array.from({ length: cols }, inline)));
  }
  return divider();
}

/** A comparable description of a block's content, as Markdown can represent it. */
function describe_(block: Block): unknown {
  const content = (inline: Inline) =>
    representableInline(inline).map((s) => [s.text, s.marks, s.link, s.image?.src, s.image?.alt, s.image?.title]);
  switch (block.type) {
    case 'table':
      return ['table', block.align, block.rows.map((row) => row.map(content))];
    case 'divider':
      return ['divider'];
    case 'code':
      return ['code', block.language, inlineText(block.content)];
    case 'raw':
      return ['raw', block.syntax, inlineText(block.content)];
    case 'listItem':
      return ['listItem', block.listType, block.indent, block.checked, content(block.content)];
    case 'heading':
      return ['heading', block.level, content(block.content)];
    default:
      return [block.type, content(block.content)];
  }
}

const DIALECTS: { name: string; options: MarkdownOptions }[] = [
  { name: 'CommonMark', options: {} },
  { name: 'breaks', options: { breaks: true } },
  { name: 'breaks, no setext', options: { breaks: true, setext: false } },
  {
    name: 'memos: breaks, no setext, math, footnotes',
    options: { breaks: true, setext: false, syntax: [math().markdown!, footnotes().markdown!] },
  },
];

for (const { name, options } of DIALECTS) {
  describe(`random documents survive a round trip (${name})`, () => {
    it('inline content (paragraphs)', () => {
      const r = random(42);
      for (let i = 0; i < 3000; i++) {
        const inline = randomInline(r, false);
        const md = serializeMarkdown({ blocks: [paragraph(inline)] }, options);
        const back = parseMarkdown(md, options);
        const expected = representableInline(inline).length ? [describe_(paragraph(inline))] : [];
        expect(back.blocks.map(describe_), md).toEqual(expected);
      }
    });

    it('all block types', () => {
      const r = random(7);
      for (let i = 0; i < 1000; i++) {
        const blocks: Block[] = [];
        let indent = -1;
        for (let n = 1 + Math.floor(r.next() * 6); n > 0; n--) {
          const block = randomBlock(r, indent);
          indent = block.type === 'listItem' ? block.indent : -1;
          blocks.push(block);
        }
        const md = serializeMarkdown({ blocks }, options);
        const back = parseMarkdown(md, options);
        // Empty quotes and empty paragraphs at the end are not saved.
        const kept = blocks.filter((b) => !(b.type === 'quote' && b.content.length === 0));
        const emptyParagraph = (b: Block | undefined) => b?.type === 'paragraph' && b.content.length === 0;
        while (emptyParagraph(kept.at(-1))) kept.pop();
        expect(back.blocks.map(describe_), md).toEqual(kept.map(describe_));
        expect(serializeMarkdown(back, options)).toBe(md);
      }
    });
  });

  if (name === 'CommonMark') continue;
  describe(`save stability on spec examples (${name})`, () => {
    for (const ex of [...commonmark, ...gfm]) {
      it(`example ${ex.example}`, () => {
        const once = serializeMarkdown(parseMarkdown(ex.markdown, options), options);
        expect(serializeMarkdown(parseMarkdown(once, options), options)).toBe(once);
      });
    }
  });
}

describe('dialect options', () => {
  it('breaks: a single newline is a line break and is saved as a newline', () => {
    const o = { breaks: true };
    expect(shape(parseMarkdown('a\nb  \nc\\\nd', o))).toEqual([{ type: 'paragraph', content: [t('a\nb\nc\nd')] }]);
    expect(serializeMarkdown(parseMarkdown('a\nb  \nc\\\nd', o), o)).toBe('a\nb\nc\nd\n');
    expect(serializeMarkdown({ blocks: [paragraph([t('a\n\nb')])] }, o)).toBe('a\n\\\nb\n');
    expect(serializeMarkdown({ blocks: [listItem('bullet', [t('a\nb')])] }, o)).toBe('- a\n  b\n');
    expect(serializeMarkdown({ blocks: [quote([t('a\nb')])] }, o)).toBe('> a\n> b\n');
  });

  it('setext: false reads underlines as a divider or text', () => {
    const o = { setext: false };
    expect(shape(parseMarkdown('Title\n---', o))).toEqual([
      { type: 'paragraph', content: [t('Title')] },
      { type: 'divider' },
    ]);
    expect(shape(parseMarkdown('Title\n===', o))).toEqual([{ type: 'paragraph', content: [t('Title ===')] }]);
  });
});
