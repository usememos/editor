import { describe, expect, it } from 'vitest';
import { type Inline, parseInline, parseMarkdown, serializeInline, serializeMarkdown } from '../src/index';

const t = (text: string, ...marks: Inline[number]['marks']) => ({ text, marks });

describe('parseInline', () => {
  it('parses emphasis per CommonMark', () => {
    expect(parseInline('a **b** *c* _d_ ~~e~~ `f`')).toEqual([
      t('a '),
      t('b', 'bold'),
      t(' '),
      t('c', 'italic'),
      t(' '),
      t('d', 'italic'),
      t(' '),
      t('e', 'strike'),
      t(' '),
      t('f', 'code'),
    ]);
  });

  it('handles nested and triple delimiters', () => {
    expect(parseInline('***both***')).toEqual([t('both', 'bold', 'italic')]);
    expect(parseInline('**bold *both* bold**')).toEqual([t('bold ', 'bold'), t('both', 'bold', 'italic'), t(' bold', 'bold')]);
  });

  it('does not treat intraword underscores as emphasis', () => {
    expect(parseInline('snake_case_name')).toEqual([t('snake_case_name')]);
  });

  it('leaves unmatched delimiters as text', () => {
    expect(parseInline('a * b')).toEqual([t('a * b')]);
    expect(parseInline('**open')).toEqual([t('**open')]);
  });

  it('applies backslash escapes and code span rules', () => {
    expect(parseInline('\\*not\\*')).toEqual([t('*not*')]);
    expect(parseInline('`` a`b ``')).toEqual([t('a`b', 'code')]);
    expect(parseInline('`*x*`')).toEqual([t('*x*', 'code')]);
  });

  it('applies the rule of three', () => {
    // CommonMark example 411: *foo**bar** → <em>foo<strong>bar</strong></em>
    expect(parseInline('*foo**bar***')).toEqual([t('foo', 'italic'), t('bar', 'bold', 'italic')]);
  });
});

describe('parseMarkdown', () => {
  it('parses headings and paragraphs', () => {
    const doc = parseMarkdown('# Title\n\nPara one\ncontinues\n\nSetext\n---\n');
    expect(doc.blocks.map((b) => (b.type === 'heading' ? `h${b.level}` : 'p'))).toEqual(['h1', 'p', 'h2']);
    expect(doc.blocks[1]).toMatchObject({ type: 'paragraph', content: [t('Para one continues')] });
  });

  it('strips an ATX closing sequence', () => {
    const [h] = parseMarkdown('## Title ##').blocks;
    expect(h).toMatchObject({ type: 'heading', level: 2, content: [t('Title')] });
  });
});

describe('serialize', () => {
  it('moves whitespace outside marks so the output still parses', () => {
    expect(serializeInline([t('foo ', 'bold'), t('bar')])).toBe('**foo** bar');
  });

  it('escapes Markdown syntax in plain text', () => {
    expect(serializeInline([t('2 * 3 [x] `y` snake_case _z_')])).toBe('2 \\* 3 \\[x\\] \\`y\\` snake_case \\_z\\_');
  });

  it('escapes block syntax at the start of a paragraph', () => {
    expect(serializeMarkdown({ blocks: parseMarkdown('\\# not a heading\n\n1\\. not a list').blocks })).toBe(
      '\\# not a heading\n\n1\\. not a list\n',
    );
  });

  it('picks a code fence longer than any backtick run inside', () => {
    expect(serializeInline([t('a`b', 'code')])).toBe('``a`b``');
  });
});

describe('round trip', () => {
  const cases = [
    '# Heading\n\nA **bold** and *italic* and ~~gone~~ and `code`.\n',
    'Mixed ***both*** and **bold *nested* bold**.\n',
    'Escapes: \\*star\\*, \\_under\\_, \\[link\\], snake_case.\n',
    '## Trailing \\#\n',
    'Overlapping **a*b***_c_ marks.\n',
  ];
  for (const md of cases) {
    it(`keeps ${JSON.stringify(md)}`, () => {
      expect(serializeMarkdown(parseMarkdown(md))).toBe(md);
    });
  }

  it('is stable: parse(serialize(doc)) gives the same content', () => {
    const doc = parseMarkdown('Some *text* with __strong__ and _em_\nacross lines.\n\nTitle\n===\n');
    const once = serializeMarkdown(doc);
    expect(serializeMarkdown(parseMarkdown(once))).toBe(once);
    expect(once).toBe('Some *text* with **strong** and *em* across lines.\n\n# Title\n');
  });
});

describe('performance', () => {
  it('parses 100 KB of Markdown in well under 100 ms', () => {
    const chunk = [
      '# Heading with *emphasis* and `code`',
      '',
      'A paragraph with **bold**, _italic_, ~~strike~~, a [link](https://example.com "title"), an ![image](a.png),',
      'a [reference][ref], <span>inline html</span>, &amp; entities and a hard break\\',
      'on the next line.',
      '',
      '- item one',
      '- item **two**',
      '  - nested [ ] text',
      '  - [x] task',
      '1. first',
      '2. second',
      '',
      '> quoted *text*',
      '> continues',
      '',
      '```js',
      'const answer = 42;',
      '```',
      '',
      '| a | b |',
      '| :- | -: |',
      '| `c` | **d** |',
      '',
      '[ref]: https://example.com/ref',
      '',
      '',
    ].join('\n');
    const src = chunk.repeat(Math.ceil(100_000 / chunk.length));
    expect(src.length).toBeGreaterThanOrEqual(100_000);
    // Warm up the JIT, then take the best of a few runs.
    for (let i = 0; i < 3; i++) parseMarkdown(src);
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      parseMarkdown(src);
      best = Math.min(best, performance.now() - start);
    }
    expect(best).toBeLessThan(100);
  });
});
