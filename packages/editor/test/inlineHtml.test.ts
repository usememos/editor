// Inline raw HTML rendered through the `html` view: runs pair an opening tag
// with its closing tag even when the parser's spans were merged or split.

import { Window } from 'happy-dom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Editor } from '../src/index';
import { type Span, containerContent } from '../src/model';
import { htmlRuns, splitHtmlSpans, tokenKey } from '../src/view/dom';
import { revealedViews } from '../src/view/reveal';

const html = (text: string): Span => ({ text, marks: ['html'] });
const plain = (text: string): Span => ({ text, marks: [] });
const text = (spans: readonly Span[]) => spans.map((s) => s.text).join('');
const linked = (span: Span, link = 'https://example.org'): Span => ({ ...span, link });

describe('htmlRuns', () => {
  it('pairs tags that normalizeInline merged into one span', () => {
    // `</rt></ruby><ruby>` is one span after parsing: three tags.
    const inline = [html('<ruby>'), plain('風'), html('<rt>'), plain('か'), html('</rt></ruby><ruby>'), plain('邪'), html('<rt>'), plain('ぜ'), html('</rt></ruby>')];
    const first = '<ruby>風<rt>か</rt></ruby>';
    expect(htmlRuns(inline)).toEqual([
      { from: 0, to: first.length },
      { from: first.length, to: text(inline).length },
    ]);
  });

  it('splits merged spans one tag each and rejoins a tag an edit cut in two', () => {
    expect(splitHtmlSpans([html('</rt></ruby><ruby>')]).map((s) => s.text)).toEqual(['</rt>', '</ruby>', '<ruby>']);
    expect(splitHtmlSpans([html('<ru'), html('by>'), plain('x'), html('</ruby>')]).map((s) => s.text)).toEqual(['<ruby>', 'x', '</ruby>']);
    expect(htmlRuns([html('<ru'), html('by>'), plain('x'), html('</ruby>')])).toEqual([{ from: 0, to: '<ruby>x</ruby>'.length }]);
    // A comment and the text around it inside one span.
    expect(splitHtmlSpans([html('<!-- a -->b<br>')]).map((s) => s.text)).toEqual(['<!-- a -->', 'b', '<br>']);
  });

  it('keeps nested same-name tags in one run and a lone closing tag on its own', () => {
    const nested = [html('<span>'), html('<span>'), plain('x'), html('</span>'), html('</span>')];
    expect(htmlRuns(nested)).toEqual([{ from: 0, to: text(nested).length }]);
    expect(htmlRuns([plain('a'), html('</b>'), plain('c')])).toEqual([{ from: 1, to: 5 }]);
  });

  it('pairs tags inside a link and across its edges', () => {
    const inside = [plain('see '), linked(html('<ruby>')), linked(plain('風')), linked(html('<rt>')), linked(plain('か')), linked(html('</rt></ruby>')), plain(' now')];
    expect(htmlRuns(inside)).toEqual([{ from: 4, to: 4 + '<ruby>風<rt>か</rt></ruby>'.length }]);
    // Opened outside the link and closed inside it.
    expect(htmlRuns([html('<kbd>'), plain('Ctrl '), linked(plain('x')), linked(html('</kbd>'))])).toEqual([{ from: 0, to: 17 }]);
    // Opened in one link, closed in another.
    expect(htmlRuns([linked(html('<kbd>')), linked(plain('x'), 'https://a.example'), linked(html('</kbd>'), 'https://b.example')])).toEqual([{ from: 0, to: 12 }]);
  });
});

describe('rendering', () => {
  const window = new Window();
  const saved: Record<string, unknown> = {};
  beforeAll(() => {
    for (const key of ['document', 'window', 'HTMLElement', 'HTMLImageElement', 'HTMLInputElement', 'Node', 'Range'] as const) {
      saved[key] = (globalThis as Record<string, unknown>)[key];
      (globalThis as Record<string, unknown>)[key] = key === 'window' ? window : (window as unknown as Record<string, unknown>)[key];
    }
  });
  afterAll(() => Object.assign(globalThis, saved));

  const views = { html: (source: string, el: HTMLElement) => void (el.innerHTML = source) };
  const create = (content: string, editable = false, html: (source: string, el: HTMLElement) => void | false = views.html) => {
    const element = window.document.createElement('div');
    window.document.body.appendChild(element);
    return new Editor({ element: element as unknown as HTMLElement, content, editable, extensions: [{ name: 'views', views: { html } }] });
  };
  const render = (content: string) => create(content).root;

  it('renders ruby pairs through the html view in a paragraph and a table cell', () => {
    const ruby = '<ruby>風<rt>か</rt></ruby><ruby>邪<rt>ぜ</rt></ruby>';
    const root = render(`| kanji | kana |\n| :--- | :--- |\n| ${ruby} | かぜ |\n\nsay ${ruby} here\n`);
    const cell = root.querySelector('td')!;
    const paragraph = root.querySelector('p')!;
    for (const container of [cell, paragraph]) {
      const rubies = Array.from(container.querySelectorAll('ruby'));
      expect(rubies.map((r) => r.textContent)).toEqual(['風か', '邪ぜ']);
      expect(rubies.map((r) => r.querySelector('rt')?.textContent)).toEqual(['か', 'ぜ']);
      // The tags never show as text.
      expect(container.textContent).not.toContain('<');
    }
    expect(paragraph.textContent).toBe('say 風か邪ぜ here');
  });

  it('renders a run inside a link through the html view, in the link', () => {
    const ruby = '<ruby>風<rt>か</rt></ruby><ruby>邪<rt>ぜ</rt></ruby>';
    const root = render(`| kanji | translation |\n| :--- | :--- |\n| [${ruby}](https://example.org) | Cold |\n\nsee [${ruby}](https://example.org "cold") here\n`);
    const cell = root.querySelector('td')!;
    const paragraph = root.querySelector('p')!;
    for (const container of [cell, paragraph]) {
      const links = Array.from(container.querySelectorAll('a'));
      expect(links.length).toBe(1);
      const a = links[0]!;
      expect(a.getAttribute('href')).toBe('https://example.org');
      expect(Array.from(a.querySelectorAll('ruby')).map((r) => r.textContent)).toEqual(['風か', '邪ぜ']);
      expect(a.querySelectorAll('.mbe-view-html').length).toBe(2);
      expect(container.querySelectorAll('.mbe-raw-html').length).toBe(0);
      expect(container.textContent).not.toContain('<');
    }
    expect(paragraph.querySelector('a')!.title).toBe('cold');
    expect(paragraph.textContent).toBe('see 風か邪ぜ here');
    // Each atom still counts as its run's source for DOM-to-model mapping.
    expect(Array.from(paragraph.querySelectorAll('.mbe-view-html')).map((el) => (el as HTMLElement).dataset.source)).toEqual(['<ruby>風<rt>か</rt></ruby>', '<ruby>邪<rt>ぜ</rt></ruby>']);
  });

  it('renders a run that crosses a link edge as a browser pairs the tags, the linked text in its own <a>', () => {
    // `<kbd>Ctrl <a>x</kbd></a>` in other renderers; the browser makes it `<kbd>Ctrl <a>x</a></kbd>`.
    let paragraph = render('<kbd>Ctrl [x</kbd>](https://example.org "t")\n').querySelector('p')!;
    let view = paragraph.querySelector('.mbe-view-html') as HTMLElement;
    expect(view.dataset.source).toBe('<kbd>Ctrl x</kbd>');
    expect(view.parentElement).toBe(paragraph);
    const kbd = paragraph.querySelector('kbd')!;
    expect(kbd.textContent).toBe('Ctrl x');
    expect(kbd.querySelector('a')!.textContent).toBe('x');
    expect(kbd.querySelector('a')!.getAttribute('href')).toBe('https://example.org');
    expect(kbd.querySelector('a')!.title).toBe('t');
    expect(paragraph.querySelectorAll('.mbe-raw-html').length).toBe(0);
    // Opened inside a link and closed after it: the link's text stays linked, the rest does not.
    paragraph = render('[a <b>x](https://example.org) y</b>\n').querySelector('p')!;
    view = paragraph.querySelector('.mbe-view-html') as HTMLElement;
    expect(view.parentElement).toBe(paragraph);
    expect(Array.from(paragraph.querySelectorAll('a')).map((a) => a.textContent)).toEqual(['a ', 'x']);
    expect(paragraph.querySelector('b')!.textContent).toBe('x y');
    expect(paragraph.querySelector('b > a')!.textContent).toBe('x');
    expect(paragraph.textContent).toBe('a x y');
    // Opened in one link, closed in another.
    paragraph = render('[<i>x](https://a.example) [y</i>](https://b.example)\n').querySelector('p')!;
    expect(paragraph.querySelectorAll('.mbe-view-html').length).toBe(1);
    expect(Array.from(paragraph.querySelectorAll('i > a')).map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['x', 'https://a.example'],
      ['y', 'https://b.example'],
    ]);
    expect(paragraph.textContent).toBe('x y');
  });

  it('renders the tags as text when the view declines a run, inside or across a link', () => {
    const declining = (source: string, el: HTMLElement): void | false => (source.includes('<kbd>') ? false : void (el.innerHTML = source));
    const paragraph = create('[<i>a</i>](https://example.org) <kbd>b [c</kbd>](https://example.org) [<kbd>d</kbd>](https://example.org)\n', false, declining).root.querySelector('p')!;
    expect(paragraph.querySelectorAll('.mbe-view-html').length).toBe(1);
    expect(paragraph.querySelector('a > .mbe-view-html > i')!.textContent).toBe('a');
    expect(Array.from(paragraph.querySelectorAll('.mbe-raw-html')).map((el) => el.textContent)).toEqual(['<kbd>', '</kbd>', '<kbd>', '</kbd>']);
    expect(Array.from(paragraph.querySelectorAll('a')).map((a) => a.textContent)).toEqual(['a', 'c</kbd>', '<kbd>d</kbd>']);
    expect(paragraph.textContent).toBe('a <kbd>b c</kbd> <kbd>d</kbd>');
  });

  it('reveals a linked run at the caret', () => {
    const editor = create('see [<ruby>風<rt>か</rt></ruby>](https://example.org) here\n', true);
    const block = editor.state.doc.blocks[0]!;
    const content = containerContent(block)!;
    const htmlViews = new Map([['html', views.html]]);
    // The caret inside the run reveals it; outside, nothing is revealed.
    const inRun = { blockId: block.id, offset: 'see <ruby>風'.length };
    expect(revealedViews({ ...editor.state, selection: { anchor: inRun, focus: inRun } }, htmlViews, true).get(block.id)).toEqual(new Set([tokenKey(undefined, 4)]));
    const after = { blockId: block.id, offset: content.map((s) => s.text).join('').length };
    expect(revealedViews({ ...editor.state, selection: { anchor: after, focus: after } }, htmlViews, true).size).toBe(0);
    // Rendered with the caret in the run, the link holds the run's source instead of the view.
    editor.focus();
    expect(editor.hasFocus()).toBe(true);
    editor.setSelection({ anchor: inRun, focus: inRun });
    const a = editor.root.querySelector('p a')!;
    expect(a.querySelectorAll('.mbe-view-html').length).toBe(0);
    expect(Array.from(a.querySelectorAll('.mbe-raw-html')).map((el) => el.textContent)).toEqual(['<ruby>', '<rt>', '</rt>', '</ruby>']);
    expect(a.textContent).toBe('<ruby>風<rt>か</rt></ruby>');
    editor.setSelection({ anchor: after, focus: after });
    expect(editor.root.querySelectorAll('p a .mbe-view-html').length).toBe(1);
  });

  it('renders nested same-name tags as one view', () => {
    const root = render('<span class="a"><span class="b">x</span></span>\n');
    const outer = root.querySelector('p > .mbe-view-html > span.a')!;
    expect(outer.querySelector('span.b')?.textContent).toBe('x');
    expect(root.querySelectorAll('.mbe-view-html').length).toBe(1);
  });
});
