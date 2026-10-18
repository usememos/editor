// Inline raw HTML rendered through the `html` view: runs pair an opening tag
// with its closing tag even when the parser's spans were merged or split.

import { Window } from 'happy-dom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Editor } from '../src/index';
import type { Span } from '../src/model';
import { htmlRuns, splitHtmlSpans } from '../src/view/dom';

const html = (text: string): Span => ({ text, marks: ['html'] });
const plain = (text: string): Span => ({ text, marks: [] });
const text = (spans: readonly Span[]) => spans.map((s) => s.text).join('');

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
});

describe('rendering', () => {
  const window = new Window();
  const saved: Record<string, unknown> = {};
  beforeAll(() => {
    for (const key of ['document', 'window', 'HTMLElement', 'HTMLImageElement', 'Node'] as const) {
      saved[key] = (globalThis as Record<string, unknown>)[key];
      (globalThis as Record<string, unknown>)[key] = key === 'window' ? window : (window as unknown as Record<string, unknown>)[key];
    }
  });
  afterAll(() => Object.assign(globalThis, saved));

  const render = (content: string) => {
    const element = window.document.createElement('div');
    window.document.body.appendChild(element);
    const editor = new Editor({
      element: element as unknown as HTMLElement,
      content,
      editable: false,
      extensions: [{ name: 'views', views: { html: (source: string, el: HTMLElement) => void (el.innerHTML = source) } }],
    });
    return editor.root;
  };

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

  it('renders nested same-name tags as one view', () => {
    const root = render('<span class="a"><span class="b">x</span></span>\n');
    const outer = root.querySelector('p > .mbe-view-html > span.a')!;
    expect(outer.querySelector('span.b')?.textContent).toBe('x');
    expect(root.querySelectorAll('.mbe-view-html').length).toBe(1);
  });
});
