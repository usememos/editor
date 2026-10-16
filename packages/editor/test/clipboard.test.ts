// Clipboard HTML: docToHtml (copy) and htmlToDoc (paste), with happy-dom's
// DOMParser standing in for the browser's.

import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { docToHtml } from '../src/clipboard/toHtml';
import { htmlToDoc, isStyledText } from '../src/clipboard/fromHtml';
import {
  ATOM_CHAR,
  type Doc,
  type Mark,
  type Span,
  codeBlock,
  divider,
  heading,
  htmlBlock,
  listItem,
  paragraph,
  quote,
  sortMarks,
  table,
} from '../src/model';
import { parseMarkdown } from '../src/markdown/parse';

const window = new Window();
const parser = new window.DOMParser() as unknown as DOMParser;
const fromHtml = (html: string) => htmlToDoc(html, parser);

const t = (text: string, ...marks: Mark[]): Span => ({ text, marks: sortMarks(marks) });
const link = (text: string, href: string, ...marks: Mark[]): Span => ({ text, marks: sortMarks(marks), link: href });

function shape(doc: Doc): unknown[] {
  return doc.blocks.map(({ id: _id, ...rest }) => rest);
}

describe('docToHtml', () => {
  it('writes semantic HTML for every block type', () => {
    const doc: Doc = {
      blocks: [
        heading(2, [t('Title & more')]),
        paragraph([t('a '), t('b', 'bold', 'italic'), t(' '), link('l', 'http://x.y/?a=1&b="2"'), t('\n<c>', 'code'), { ...link('m', 'u'), linkTitle: 'Say "hi"' }]),
        codeBlock('js', 'if (a < b) {}'),
        quote([t('one')]),
        quote([t('two')]),
        divider(),
        table(
          ['left', null],
          [
            [[t('h1')], [t('h2')]],
            [[t('x', 'strike')], []],
          ],
        ),
        htmlBlock('<div>raw</div>'),
        paragraph([{ text: ATOM_CHAR, marks: [], image: { src: 'p.png', alt: 'A "pic"', title: 'T' } }]),
      ],
    };
    expect(docToHtml(doc)).toBe(
      '<h2>Title &amp; more</h2>' +
        '<p>a <strong><em>b</em></strong> <a href="http://x.y/?a=1&amp;b=&quot;2&quot;">l</a><code><br>&lt;c&gt;</code><a href="u" title="Say &quot;hi&quot;">m</a></p>' +
        '<pre><code class="language-js">if (a &lt; b) {}</code></pre>' +
        '<blockquote><p>one</p><p>two</p></blockquote>' +
        '<hr>' +
        '<table><thead><tr><th style="text-align: left">h1</th><th>h2</th></tr></thead>' +
        '<tbody><tr><td style="text-align: left"><s>x</s></td><td></td></tr></tbody></table>' +
        '<div>raw</div>' +
        '<p><img src="p.png" alt="A &quot;pic&quot;" title="T"></p>',
    );
  });

  it('nests lists and writes task items with checkboxes', () => {
    const doc: Doc = {
      blocks: [
        listItem('bullet', [t('a')]),
        listItem('ordered', [t('a1')], { indent: 1, start: 3 }),
        listItem('ordered', [t('a2')], { indent: 1 }),
        listItem('task', [t('done')], { indent: 2, checked: true }),
        listItem('bullet', [t('b')]),
        listItem('ordered', [t('c')]),
        listItem('task', [t('todo')]),
      ],
    };
    expect(docToHtml(doc)).toBe(
      '<ul><li>a<ol start="3"><li>a1</li><li>a2<ul><li><input type="checkbox" disabled checked> done</li></ul></li></ol></li>' +
        '<li>b</li></ul>' +
        '<ol><li>c</li></ol>' +
        '<ul><li><input type="checkbox" disabled> todo</li></ul>',
    );
  });

  it('reads back through htmlToDoc', () => {
    const md = [
      '# Title',
      '',
      'Some **bold**, *italic*, ~~gone~~, `code` and a [link](http://e.com).\\',
      'Second line.',
      '',
      '- one',
      '  1. nested',
      '- [x] task',
      '',
      '> quoted',
      '',
      '```ts',
      'let x = 1;',
      '```',
      '',
      '| a | b |',
      '| :-: | --: |',
      '| 1 | 2 |',
      '',
      '---',
      '',
    ].join('\n');
    const doc = parseMarkdown(md);
    expect(shape(fromHtml(docToHtml(doc)))).toEqual(shape(doc));
  });
});

describe('isStyledText', () => {
  it('is true for HTML that only lays out and colors text, as code editors and terminals copy it', () => {
    expect(isStyledText('')).toBe(true);
    expect(isStyledText('# Title')).toBe(true);
    expect(
      isStyledText(
        `<meta charset='utf-8'><div style="color: #cccccc;font-family: Menlo, monospace;white-space: pre;"><div><span style="color: #569cd6;"># Title</span></div><br><div><span>- one</span></div><!-- x --></div>`,
      ),
    ).toBe(true);
  });

  it('is false for HTML with structure or formatting', () => {
    expect(isStyledText('<h1>Title</h1>')).toBe(false);
    expect(isStyledText('<p>a</p>')).toBe(false);
    expect(isStyledText('<div><a href="u">a</a></div>')).toBe(false);
    expect(isStyledText('<pre><code>x</code></pre>')).toBe(false);
    // Bold set by a style, as Google Docs and VS Code write it. VS Code is recognized by its own clipboard type.
    expect(isStyledText('<div><span style="font-weight: bold;">a</span></div>')).toBe(false);
    expect(isStyledText('<span style="font-weight:700">a</span>')).toBe(false);
    expect(isStyledText('<span style="font-style: italic">a</span>')).toBe(false);
    expect(isStyledText('<span style="text-decoration: underline line-through">a</span>')).toBe(false);
  });
});

describe('htmlToDoc', () => {
  it('converts headings, paragraphs and inline formatting', () => {
    const doc = fromHtml(
      '<h3>Head</h3><p>A <b>bold</b> <strong>strong</strong> <i>it</i> <em>em</em> <code>c</code> ' +
        '<s>s</s> <del>d</del> <strike>k</strike> <a href="https://x.y">link</a></p><div>div text</div>',
    );
    expect(shape(doc)).toEqual([
      { type: 'heading', level: 3, content: [t('Head')] },
      {
        type: 'paragraph',
        content: [
          t('A '),
          t('bold', 'bold'),
          t(' '),
          t('strong', 'bold'),
          t(' '),
          t('it', 'italic'),
          t(' '),
          t('em', 'italic'),
          t(' '),
          t('c', 'code'),
          t(' '),
          t('s', 'strike'),
          t(' '),
          t('d', 'strike'),
          t(' '),
          t('k', 'strike'),
          t(' '),
          link('link', 'https://x.y'),
        ],
      },
      { type: 'paragraph', content: [t('div text')] },
    ]);
  });

  it('collapses whitespace like a browser and keeps <br> as a line break', () => {
    const doc = fromHtml('<p>\n  one   <b> two </b>\n three<br>\n  four&nbsp;&nbsp;five </p>');
    expect(shape(doc)).toEqual([{ type: 'paragraph', content: [t('one '), t('two ', 'bold'), t('three\nfour  five')] }]);
  });

  it('converts nested lists, task items and ordered starts', () => {
    const doc = fromHtml(
      '<ol start="4"><li>four<ul><li>sub <em>x</em></li><li><p>para one</p><p>para two</p></li></ul></li><li>five</li></ol>' +
        '<ul><li><input type="checkbox" checked> done</li><li><input type="checkbox"> todo</li></ul>',
    );
    expect(shape(doc)).toEqual([
      { type: 'listItem', listType: 'ordered', indent: 0, checked: false, start: 4, content: [t('four')] },
      { type: 'listItem', listType: 'bullet', indent: 1, checked: false, content: [t('sub '), t('x', 'italic')] },
      { type: 'listItem', listType: 'bullet', indent: 1, checked: false, content: [t('para one\npara two')] },
      { type: 'listItem', listType: 'ordered', indent: 0, checked: false, content: [t('five')] },
      { type: 'listItem', listType: 'task', indent: 0, checked: true, content: [t('done')] },
      { type: 'listItem', listType: 'task', indent: 0, checked: false, content: [t('todo')] },
    ]);
  });

  it('converts quotes, code blocks, tables, images and rules', () => {
    const doc = fromHtml(
      '<blockquote><p>q1</p><p>q2</p></blockquote>' +
        '<pre class="highlight"><code class="language-python">def f():\n    return 1\n</code></pre>' +
        '<table><tr><th align="center">A</th><th style="text-align: right">B</th><th>C</th></tr>' +
        '<tr><td>1</td><td><b>2</b></td></tr></table>' +
        '<p><img src="a.png" alt="Alt" title="T"> after</p><hr>',
    );
    expect(shape(doc)).toEqual([
      { type: 'quote', content: [t('q1')] },
      { type: 'quote', content: [t('q2')] },
      { type: 'code', language: 'python', content: [t('def f():\n    return 1')] },
      {
        type: 'table',
        align: ['center', 'right', null],
        rows: [
          [[t('A')], [t('B')], [t('C')]],
          [[t('1')], [t('2', 'bold')], []],
        ],
      },
      {
        type: 'paragraph',
        content: [{ text: ATOM_CHAR, marks: [], image: { src: 'a.png', alt: 'Alt', title: 'T' } }, t(' after')],
      },
      { type: 'divider' },
    ]);
  });

  it('uses the text of unknown elements and skips scripts, styles and head', () => {
    const doc = fromHtml(
      '<html><head><title>T</title><style>p{}</style></head><body>' +
        '<custom-el>custom <x-y>text</x-y></custom-el><script>alert(1)</script><p>after<span hidden-attr> span</span></p>' +
        '<a href="javascript:alert(1)">no link</a></body></html>',
    );
    expect(shape(doc)).toEqual([
      { type: 'paragraph', content: [t('custom text')] },
      { type: 'paragraph', content: [t('after span')] },
      { type: 'paragraph', content: [t('no link')] },
    ]);
  });

  it('converts a Google Docs clipboard snippet', () => {
    // Shape of what Google Docs puts on the clipboard (styles shortened).
    const span = (style: string, text: string) =>
      `<span style="font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;${style}font-variant:normal;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">${text}</span>`;
    const normal = 'font-weight:400;font-style:normal;text-decoration:none;';
    const p = (inner: string, style = '') =>
      `<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;${style}">${inner}</p>`;
    const li = (level: number, text: string) =>
      `<li dir="ltr" style="list-style-type:disc;font-size:11pt;font-family:Arial,sans-serif;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;" aria-level="${level}">` +
      `<p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;" role="presentation">${span(normal, text)}</p></li>`;
    const td = (inner: string) =>
      `<td style="border-left:solid #000000 1pt;border-right:solid #000000 1pt;border-bottom:solid #000000 1pt;border-top:solid #000000 1pt;vertical-align:top;padding:5pt 5pt 5pt 5pt;overflow:hidden;overflow-wrap:break-word;">${inner}</td>`;
    const html =
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-6c1f2a3b-7fff-4c1d-9e2a-0b1c2d3e4f50">' +
      `<h1 dir="ltr" style="line-height:1.38;margin-top:20pt;margin-bottom:6pt;">${span('font-size:20pt;' + normal, 'Project plan')}</h1>` +
      p(
        span(normal, 'Plain, ') +
          span('font-weight:700;font-style:normal;text-decoration:none;', 'bold') +
          span(normal, ', ') +
          span('font-weight:400;font-style:italic;text-decoration:none;', 'italic') +
          span(normal, ', ') +
          span('font-weight:400;font-style:normal;text-decoration:line-through;', 'struck') +
          span(normal, ' and a ') +
          `<a href="https://example.com/docs" style="text-decoration:none;">${span('font-weight:400;font-style:normal;color:#1155cc;text-decoration:underline;-webkit-text-decoration-skip:none;text-decoration-skip-ink:none;', 'link')}</a>` +
          span(normal, '.') +
          span(normal, '<br />') +
          span(normal, 'Next line'),
      ) +
      '<br />' +
      '<ul style="margin-top:0;margin-bottom:0;padding-inline-start:48px;">' +
      li(1, 'First') +
      `<ul style="margin-top:0;margin-bottom:0;padding-inline-start:48px;">${li(2, 'Nested')}</ul>` +
      li(1, 'Second') +
      '</ul><br />' +
      '<div dir="ltr" style="margin-left:0pt;" align="left"><table style="border:none;border-collapse:collapse;">' +
      '<colgroup><col width="301" /><col width="301" /></colgroup><tbody>' +
      `<tr style="height:0pt">${td(p(span('font-weight:700;font-style:normal;text-decoration:none;', 'Name'), 'line-height:1.2;'))}` +
      `${td(p(span('font-weight:700;font-style:normal;text-decoration:none;', 'Count'), 'text-align: right;'))}</tr>` +
      `<tr style="height:0pt">${td(p(span(normal, 'Apples')))}${td(p(span(normal, '3'), 'text-align: right;'))}</tr>` +
      '</tbody></table></div>' +
      p(`<span style="font-size:11pt;font-family:'Courier New',monospace;color:#000000;font-weight:400;white-space:pre-wrap;">npm test</span>`) +
      '</b><br class="Apple-interchange-newline">';

    expect(shape(fromHtml(html))).toEqual([
      { type: 'heading', level: 1, content: [t('Project plan')] },
      {
        type: 'paragraph',
        content: [
          t('Plain, '),
          t('bold', 'bold'),
          t(', '),
          t('italic', 'italic'),
          t(', '),
          t('struck', 'strike'),
          t(' and a '),
          link('link', 'https://example.com/docs'),
          t('.\nNext line'),
        ],
      },
      { type: 'listItem', listType: 'bullet', indent: 0, checked: false, content: [t('First')] },
      { type: 'listItem', listType: 'bullet', indent: 1, checked: false, content: [t('Nested')] },
      { type: 'listItem', listType: 'bullet', indent: 0, checked: false, content: [t('Second')] },
      {
        type: 'table',
        align: [null, 'right'],
        rows: [
          [[t('Name', 'bold')], [t('Count', 'bold')]],
          [[t('Apples')], [t('3')]],
        ],
      },
      { type: 'paragraph', content: [t('npm test', 'code')] },
    ]);
  });

  it('reads Google Docs checklists', () => {
    const doc = fromHtml(
      '<ul><li role="checkbox" aria-checked="true" aria-level="1"><p role="presentation"><span>Done</span></p></li>' +
        '<li role="checkbox" aria-checked="false" aria-level="1"><p role="presentation"><span>Open</span></p></li></ul>',
    );
    expect(shape(doc)).toEqual([
      { type: 'listItem', listType: 'task', indent: 0, checked: true, content: [t('Done')] },
      { type: 'listItem', listType: 'task', indent: 0, checked: false, content: [t('Open')] },
    ]);
  });

  it('falls back to globalThis.DOMParser', () => {
    const g = globalThis as { DOMParser?: unknown };
    const saved = g.DOMParser;
    g.DOMParser = window.DOMParser;
    try {
      expect(shape(htmlToDoc('<p>x</p>'))).toEqual([{ type: 'paragraph', content: [t('x')] }]);
    } finally {
      g.DOMParser = saved;
    }
  });
});
