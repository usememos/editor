// Suggestion matchers: finding the token at the caret. "│" marks the caret.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SuggestionMatcher } from '../src/extensions/suggestion';
import { scanMentions, scanTags } from '../src/extensions/tags';
import { parseInline } from '../src/markdown/inline';
import { defaultMatcher, excludedAt, matchToken } from '../src/suggest/match';
import { suggestionAnchor } from '../src/suggest/anchor';
import { LOADING_DELAY, SourceRunner } from '../src/suggest/source';
import { scanMemosTags } from './fixtures/memos-tags';

/** Runs a matcher on text with a "│" caret. Returns the token's text and the query, or null. */
function run(matcher: SuggestionMatcher, source: string, triggers: readonly string[] = ['#']) {
  const caret = source.indexOf('│');
  const text = source.replace('│', '');
  const m = matcher({ text, caret, content: [{ text, marks: [] }], triggers });
  return m && { token: text.slice(m.from, m.to), from: m.from, query: m.query };
}

describe('default matcher', () => {
  const tag = defaultMatcher();
  it('finds a trigger at the start of a line or after whitespace', () => {
    expect(run(tag, '#│')).toEqual({ token: '#', from: 0, query: '' });
    expect(run(tag, 'hello #wo│')).toEqual({ token: '#wo', from: 6, query: 'wo' });
    expect(run(tag, 'line\n#wo│')).toEqual({ token: '#wo', from: 5, query: 'wo' });
    expect(run(tag, 'a\t#│')?.from).toBe(2);
  });
  it('not after another character, unless allowAnywhere', () => {
    expect(run(tag, 'a#b│')).toBeNull();
    expect(run(tag, 'https://x.com/#a│')).toBeNull();
    expect(run(defaultMatcher({ allowAnywhere: true }), 'a#b│')).toEqual({ token: '#b', from: 1, query: 'b' });
  });
  it('takes the nearest trigger that may start a token', () => {
    expect(run(tag, '#a #b│')?.from).toBe(3);
    // The second "#" follows a letter, so the token starts at the first.
    expect(run(tag, '#foo#bar│')).toEqual({ token: '#foo#bar', from: 0, query: 'foo#bar' });
  });
  it('ends at whitespace; the token runs on past the caret to the next whitespace', () => {
    expect(run(tag, '#tag │')).toBeNull();
    expect(run(tag, '#tag x│')).toBeNull();
    expect(run(tag, '#wo│rk more')).toEqual({ token: '#work', from: 0, query: 'wo' });
    expect(run(tag, '#│work')).toEqual({ token: '#work', from: 0, query: '' });
  });
  it('with allowSpaces: single spaces, and the token ends at the caret', () => {
    const slash = defaultMatcher({ allowSpaces: true });
    expect(run(slash, 'hi /head one│', ['/'])).toEqual({ token: '/head one', from: 3, query: 'head one' });
    expect(run(slash, '/h│eading', ['/'])).toEqual({ token: '/h', from: 0, query: 'h' });
    expect(run(slash, '/a  b│', ['/'])).toBeNull();
    expect(run(slash, '/a\nb│', ['/'])).toBeNull();
  });
  it('closes past maxLength', () => {
    expect(run(defaultMatcher({ maxLength: 3 }), '#abc│')?.query).toBe('abc');
    expect(run(defaultMatcher({ maxLength: 3 }), '#abcd│')).toBeNull();
  });
  it('takes triggers of any length, and several triggers', () => {
    expect(run(tag, 'see [[Mee│', ['[['])).toEqual({ token: '[[Mee', from: 4, query: 'Mee' });
    expect(run(tag, 'see [│', ['[['])).toBeNull();
    expect(run(tag, '＃工作│', ['#', '＃'])).toEqual({ token: '＃工作', from: 0, query: '工作' });
    expect(run(tag, 'x @a│', ['#', '@'])?.query).toBe('a');
  });
});

describe('matchToken with the default tag grammar', () => {
  const tag = matchToken(scanTags);
  it.each([
    ['hello #│', '#', ''],
    ['#wo│', '#wo', 'wo'],
    ['#wo│rk', '#work', 'wo'],
    ['#work/│', '#work/', 'work/'],
    ['#│', '#', ''],
    ['(#wo│)', '#wo', 'wo'],
    ['#工作│', '#工作', '工作'],
    ['#12│', '#12', '12'],
    ['a#b│', '#b', 'b'],
    ['C#│', '#', ''],
    ['##│', '#', ''],
  ])('%s is the token %s with query %s', (source, token, query) => {
    expect(run(tag, source)).toMatchObject({ token, query });
  });
  it.each(['#tag │', 'no tag│', '#a\n│'])('%s has no token', (source) => {
    expect(run(tag, source)).toBeNull();
  });
  it('limits the query to maxLength', () => {
    expect(run(matchToken(scanTags, { maxLength: 3 }), '#abcd│')).toBeNull();
  });
  it('needs the token to start with a trigger', () => {
    expect(run(tag, 'hello #wo│', ['＃'])).toBeNull();
  });
  it('scans other triggers of the same length as the first one', () => {
    expect(run(tag, 'hello ＃wo│', ['#', '＃'])).toEqual({ token: '＃wo', from: 6, query: 'wo' });
    expect(run(tag, 'hello ＃wo│', ['#'])).toBeNull();
  });
  it('works with mentions', () => {
    expect(run(matchToken(scanMentions), 'hi @ste│', ['@'])).toMatchObject({ token: '@ste', query: 'ste' });
    expect(run(matchToken(scanMentions), 'bob@exa│', ['@'])).toBeNull();
    // The scan starts at a word start, so a long word before the @ still counts.
    expect(run(matchToken(scanMentions), `${'b'.repeat(60)}@exa│`, ['@'])).toBeNull();
  });
});

// The strings of memos' tag autocomplete tests (web/tests/editor-tag-autocomplete.test.ts),
// with memos' scanner. Which ones open the popup automatically is memos' `allow`.
describe('matchToken with memos tag grammar', () => {
  const tag = matchToken(scanMemosTags);
  it.each(['hello #', 'hello#', '## heading #', '> text #', '- [ ] #', '#######', '#', '##', '   #'])(
    'a bare hash at the end of %s is a token with an empty query',
    (doc) => {
      expect(run(tag, `${doc}│`)).toEqual({ token: '#', from: doc.length - 1, query: '' });
    },
  );
  it.each([
    ['#t', 't'],
    ['##t', 't'],
    ['#work/', 'work/'],
    ['#work/pr', 'work/pr'],
    ['hello#work/', 'work/'],
    ['first line\n#work/', 'work/'],
    ['#software/hosted/', 'software/hosted/'],
    ['#A‍B', 'A‍B'],
    ['#工作/', '工作/'],
    ["#O'Br", "O'Br"],
    ['#O’Co', 'O’Co'],
    ['##️⃣', '#️⃣'],
  ])('%s has the query %s', (doc, query) => {
    expect(run(tag, `${doc}│`)?.query).toBe(query);
  });
  it.each(['', 'hello world', '# ', '#tag ', '#work//', '&#35;to'])('%s has no token at the end', (doc) => {
    expect(run(tag, `${doc}│`)).toBeNull();
  });
  it('a hash at the caret starts a token before following text', () => {
    expect(run(tag, '#│foo@example.com')).toEqual({ token: '#foo', from: 0, query: '' });
  });
  it('keycap emoji is no tag introducer', () => {
    expect(run(tag, '#️⃣│')).toBeNull();
    expect(run(tag, '#│️⃣')).toBeNull();
    expect(run(tag, '##│️⃣')).toBeNull();
    expect(run(tag, '#first#│️⃣')).toBeNull();
  });
});

describe('excludedAt', () => {
  it('is true in inline code, links and raw HTML', () => {
    const content = parseInline('a `#x` [#y](u) <b>#z</b> #w');
    const text = content.map((s) => s.text).join('');
    expect(excludedAt(content, text.indexOf('#x'))).toBe(true);
    expect(excludedAt(content, text.indexOf('#y'))).toBe(true);
    expect(excludedAt(content, text.indexOf('#w'))).toBe(false);
    expect(excludedAt(content, text.length)).toBe(false);
  });
});

describe('SourceRunner', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** A runner whose results and loading calls are logged. */
  const setup = () => {
    const runner = new SourceRunner<string>();
    const log: string[] = [];
    const handlers = { show: (v: string | null) => log.push(`show ${v}`), loading: () => log.push('loading') };
    return { runner, log, handlers };
  };
  const later = <T>(value: T, ms: number) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

  it('shows a sync result at once', () => {
    const { runner, log, handlers } = setup();
    runner.run(() => 'a', handlers);
    expect(log).toEqual(['show a']);
    expect(runner.pending).toBe(false);
  });

  it('drops a result that arrives after a newer request, and aborts the older signal', async () => {
    const { runner, log, handlers } = setup();
    const signals: AbortSignal[] = [];
    runner.run((signal) => (signals.push(signal), later('slow', 100)), handlers);
    runner.run((signal) => (signals.push(signal), later('fast', 10)), handlers);
    expect(signals.map((s) => s.aborted)).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(200);
    expect(log).toEqual(['show fast']);
  });

  it('debounces: only the last query within the wait is fetched', async () => {
    const { runner, log, handlers } = setup();
    const fetched: string[] = [];
    for (const q of ['a', 'ab', 'abc']) {
      runner.run(() => (fetched.push(q), q), handlers, 50);
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(fetched).toEqual([]);
    await vi.advanceTimersByTimeAsync(50);
    expect(fetched).toEqual(['abc']);
    expect(log).toEqual(['show abc']);
  });

  it(`calls loading after ${LOADING_DELAY} ms pending, not before`, async () => {
    const { runner, log, handlers } = setup();
    runner.run(() => later('a', 500), handlers);
    await vi.advanceTimersByTimeAsync(LOADING_DELAY - 1);
    expect(log).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(log).toEqual(['loading']);
    await vi.advanceTimersByTimeAsync(500);
    expect(log).toEqual(['loading', 'show a']);
  });

  it('a rejection or a throw shows no result; cancel drops everything', async () => {
    const { runner, log, handlers } = setup();
    runner.run(() => Promise.reject(new Error('offline')), handlers);
    await vi.advanceTimersByTimeAsync(0);
    runner.run(() => {
      throw new Error('bug');
    }, handlers);
    runner.run(() => later('x', 10), handlers);
    runner.cancel();
    await vi.advanceTimersByTimeAsync(LOADING_DELAY * 2);
    expect(log).toEqual(['show null', 'show null']);
    expect(runner.pending).toBe(false);
  });
});

describe('suggestionAnchor', () => {
  const box = (left: number, top: number, w = 8, h = 20) => ({ left, top, right: left + w, bottom: top + h });
  it('takes x from the trigger and the line from the caret', () => {
    expect(suggestionAnchor(box(100, 50), box(140, 50, 0), false, null)).toEqual({
      rect: { left: 100, right: 100, top: 50, bottom: 70 },
      align: 'start',
    });
  });
  it('lines up the right edges in right-to-left text', () => {
    expect(suggestionAnchor(box(100, 50), box(60, 50, 0), true, null)).toEqual({
      rect: { left: 108, right: 108, top: 50, bottom: 70 },
      align: 'end',
    });
  });
  it('takes x from the caret when the token wrapped to a later line', () => {
    expect(suggestionAnchor(box(300, 50), box(20, 70, 0), false, null)?.rect).toEqual({ left: 20, right: 20, top: 70, bottom: 90 });
  });
  it('is null while the trigger is outside the visible area', () => {
    const visible = { left: 0, top: 0, right: 500, bottom: 200 };
    expect(suggestionAnchor(box(100, 50), box(140, 50, 0), false, visible)).not.toBeNull();
    expect(suggestionAnchor(box(100, 250), box(140, 250, 0), false, visible)).toBeNull();
    expect(suggestionAnchor(box(100, -30), box(140, -30, 0), false, visible)).toBeNull();
  });
});
