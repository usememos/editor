// Random editing on the playground sample, the way a person bangs on an editor by hand:
// typing, Enter, Backspace, arrows, Shift selections, shortcuts, block keys, the slash menu,
// paste, clicks and undo. After every step the view must match the model and the page must
// have no errors. At the end, the saved Markdown must load back as the same blocks, undo must
// return to the original Markdown, and redo to the edited one.
//
// Each run is seeded. A failure prints the seed and the steps; rerun one seed with
// FUZZ_SEED=<seed>, and run longer with FUZZ_RUNS and FUZZ_STEPS. Every push runs
// the same two seeds; a nightly workflow (fuzz.yml) runs many new ones from
// FUZZ_FIRST, so the search keeps finding new paths without slowing each push.

import { expect, md, type Page, test, viewProblems } from './helpers';
import { SAMPLE } from '../playground/sample';

const RUNS = Number(process.env.FUZZ_RUNS ?? 2);
const STEPS = Number(process.env.FUZZ_STEPS ?? 120);
const FIRST = Number(process.env.FUZZ_FIRST ?? 1000);
const SEEDS = process.env.FUZZ_SEED ? [Number(process.env.FUZZ_SEED)] : Array.from({ length: RUNS }, (_, i) => FIRST + i);

/** mulberry32: a small seeded generator, so a failing run can be replayed. */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)]!;
  return { next, int, pick };
}

type Rng = ReturnType<typeof random>;
type Action = { name: string; weight: number; run: (page: Page, rng: Rng) => Promise<string | void> };

const WORDS = ['note', 'plan', 'a', 'Hello world', 'x', '日记', 'naïve', '👍🏽', '#work', '@bob', 'end.', '$5', 'a_b'];
const SHORTCUTS = ['- ', '* ', '1. ', '[ ] ', '[x] ', '# ', '## ', '> ', '```js ', '---', '**b**', '*i*', '`c`', '~~s~~'];
const KEYS = [
  'Enter', 'Enter', 'Shift+Enter', 'Backspace', 'Backspace', 'Backspace', 'Delete', 'Tab', 'Shift+Tab',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End',
  'Shift+ArrowUp', 'Shift+ArrowDown', 'Shift+ArrowLeft', 'Shift+ArrowRight', 'Shift+Home', 'Shift+End',
  'Control+ArrowLeft', 'Control+Shift+ArrowRight', 'Control+Backspace', 'Control+Delete',
];
const MOD_KEYS = [
  'Control+b', 'Control+i', 'Control+e', 'Control+Shift+x', 'Control+Alt+0', 'Control+Alt+1', 'Control+Alt+2',
  'Control+Alt+c', 'Control+Shift+7', 'Control+Shift+8', 'Control+Shift+9', 'Control+a',
];
const SLASH = ['head', 'h3', 'bul', 'num', 'task', 'quo', 'code', 'divi', 'table', 'para'];
const PASTES = ['one\n\n## two', '- a\n- b', 'plain text', '**bold** and [link](https://example.com)', '| a | b |\n| - | - |\n| 1 | 2 |', 'line\nbreak'];

const ACTIONS: Action[] = [
  { name: 'type', weight: 10, run: async (page, rng) => { const w = rng.pick(WORDS); await page.keyboard.type(w); return w; } },
  { name: 'key', weight: 14, run: async (page, rng) => { const k = rng.pick(KEYS); await page.keyboard.press(k); return k; } },
  { name: 'mod', weight: 4, run: async (page, rng) => { const k = rng.pick(MOD_KEYS); await page.keyboard.press(k); return k; } },
  {
    name: 'shortcut',
    weight: 3,
    run: async (page, rng) => {
      const s = rng.pick(SHORTCUTS);
      if (/^[-*1[#>`]/.test(s) && !s.startsWith('**') && !s.startsWith('*i') && !s.startsWith('`c')) await page.keyboard.press('Home');
      await page.keyboard.type(s);
      return s;
    },
  },
  { name: 'undo', weight: 3, run: async (page) => void (await page.keyboard.press('Control+z')) },
  { name: 'redo', weight: 1, run: async (page) => void (await page.keyboard.press('Control+Shift+z')) },
  {
    name: 'slash',
    weight: 2,
    run: async (page, rng) => {
      const q = rng.pick(SLASH);
      await page.keyboard.type(` /${q}`);
      await page.keyboard.press('Enter');
      return q;
    },
  },
  {
    name: 'blocks',
    weight: 2,
    run: async (page, rng) => {
      const k = rng.pick(['Backspace', 'Control+d', 'Shift+ArrowDown', 'Tab', 'Control+Shift+8', 'Enter', 'ArrowLeft', 'Control+b']);
      await page.keyboard.press('Escape');
      await page.keyboard.press(k);
      return k;
    },
  },
  {
    name: 'paste',
    weight: 1,
    run: async (page, rng) => {
      const text = rng.pick(PASTES);
      await page.evaluate((t) => {
        const data = new DataTransfer();
        data.setData('text/plain', t);
        document.activeElement!.dispatchEvent((window as any).clipboardEvent('paste', data));
      }, text);
      return JSON.stringify(text);
    },
  },
  {
    name: 'click',
    weight: 2,
    run: async (page, rng) => {
      const els = page.locator('#editor [data-content], #editor td, #editor th');
      const n = await els.count();
      if (!n) return;
      const i = rng.int(n);
      const box = await els.nth(i).boundingBox();
      if (!box) return;
      await els.nth(i).scrollIntoViewIfNeeded();
      const b = (await els.nth(i).boundingBox())!;
      const x = b.x + rng.next() * b.width;
      const y = b.y + Math.min(b.height - 1, rng.next() * b.height);
      await page.mouse.click(x, y);
      return `${i}`;
    },
  },
];
const TOTAL = ACTIONS.reduce((n, a) => n + a.weight, 0);

function pickAction(rng: Rng): Action {
  let r = rng.next() * TOTAL;
  for (const a of ACTIONS) if ((r -= a.weight) < 0) return a;
  return ACTIONS[0]!;
}

/**
 * The model without IDs, one string per block: what a reload of the saved Markdown must give back.
 * Bold, italic and strikethrough on spaces and line breaks are left out: Markdown cannot always
 * write them (`** a**` is not bold), they do not show, and the serializer moves them outside.
 * Code on a line break is left out too: a code span cannot hold one, so it is saved between two.
 * Empty paragraphs at the end are left out, as the saved Markdown leaves them out.
 */
const shape = (page: Page) =>
  page.evaluate(() => {
    const emphasis = new Set(['bold', 'italic', 'strike']);
    // Spaces and tabs that start or end a line of plain text are not saved (Markdown strips them),
    // so they are left out here too, as the serializer's representableInline does.
    const plain = (span: any) => !span.link && !span.image && !span.token && !span.marks.includes('code') && !span.marks.includes('html');
    const withoutLineEndSpaces = (spans: any[]) => {
      const chars = spans.flatMap((span) => [...(span.text as string)].map((ch) => ({ ch, span })));
      const drop = new Set<number>();
      let lineStart = 0;
      for (let i = 0; i <= chars.length; i++) {
        if (i < chars.length && chars[i]!.ch !== '\n') continue;
        const space = (k: number) => /[ \t]/.test(chars[k]!.ch) && plain(chars[k]!.span);
        let to = lineStart;
        while (to < i && space(to)) to++;
        let from = i;
        while (from > lineStart && space(from - 1)) from--;
        if (to < from) for (const k of [...Array(i - lineStart).keys()].map((n) => n + lineStart)) if (k < to || k >= from) drop.add(k);
        lineStart = i + 1;
      }
      return chars.filter((_, i) => !drop.has(i));
    };
    const inline = (spans: any[]) => {
      const out: any[] = [];
      for (const { ch, span } of withoutLineEndSpaces(spans)) {
        const marks =
          ch === '\n'
            ? span.marks.filter((m: string) => !emphasis.has(m) && m !== 'code')
            : /\s/.test(ch) && !span.marks.includes('code')
              ? span.marks.filter((m: string) => !emphasis.has(m))
              : span.marks;
        const format = JSON.stringify({ marks, link: span.link, token: span.token, image: span.image });
        const last = out[out.length - 1];
        if (last && last.format === format) last.text += ch;
        else out.push({ text: ch, format });
      }
      return out.map((s) => `${JSON.stringify(s.text)}${s.format}`).join(' ');
    };
    const blocks = [...((window as any).editor.state.doc.blocks as any[])];
    while (blocks.length && blocks[blocks.length - 1].type === 'paragraph' && !blocks[blocks.length - 1].content.length) blocks.pop();
    return blocks.map((b) => {
      const { id: _id, content, rows, ...attrs } = b;
      const body = rows ? rows.map((row: any[]) => row.map(inline).join(' | ')).join(' / ') : content ? inline(content) : '';
      return `${JSON.stringify(attrs)} ${body}`;
    });
  });

/** Raw block texts: an edited raw block is source, and reads back as whatever it now says. */
const rawTexts = (page: Page) =>
  page.evaluate(() =>
    ((window as any).editor.state.doc.blocks as any[]).map((b) => (b.type === 'raw' ? b.content.map((s: any) => s.text).join('') : null)),
  );

const frame = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));

for (const seed of SEEDS) {
  test(`random editing keeps the view, the saved Markdown and undo consistent (seed ${seed})`, async ({ page, pageErrors: errors }) => {
    test.setTimeout(STEPS * 1000 + 30_000);
    await page.goto(`/?md=${encodeURIComponent(SAMPLE)}`);
    expect(await md(page)).toBe(SAMPLE);
    const originalRaws = (await rawTexts(page)).filter((t) => t !== null);
    await page.locator('#editor p').first().click();

    const rng = random(seed);
    const log: string[] = [];
    const fail = (what: string) => `${what}\nseed ${seed}, steps:\n${log.map((l, i) => `  ${i + 1}. ${l}`).join('\n')}`;
    for (let step = 0; step < STEPS; step++) {
      // A link prompt or a blur (Escape twice) can take focus away; put it back.
      if (!(await page.evaluate(() => (window as any).editor.hasFocus()))) {
        await page.evaluate(() => (window as any).editor.commands.focus());
        log.push('(refocus)');
      }
      const action = pickAction(rng);
      const detail = await action.run(page, rng);
      log.push(detail === undefined ? action.name : `${action.name} ${detail}`);
      await frame(page);
      expect(errors, fail('page errors')).toEqual([]);
      expect(await viewProblems(page), fail('view out of sync with the model')).toEqual([]);
    }
    const edited = await md(page);
    const before = await shape(page);
    const rawsBefore = await rawTexts(page);

    // Undo all the way gives the original back, and redo all the way the last state. The runs end
    // with steps left to redo when they end on an undo, so those are redone first, then undone again.
    const all = (name: 'undo' | 'redo') =>
      page.evaluate((name) => {
        const editor = (window as any).editor;
        let n = 0;
        while (editor.commands[name]() && n < 10_000) n++;
        return n;
      }, name);
    const ahead = await all('redo');
    const last = await md(page);
    for (let i = 0; i < ahead; i++) await page.evaluate(() => (window as any).editor.commands.undo());
    expect(await md(page), fail(`after ${ahead} redo and undo steps`)).toBe(edited);
    const undone = await all('undo');
    expect(await md(page), fail(`after ${undone} more undo steps`)).toBe(SAMPLE);
    await all('redo');
    expect(await md(page), fail('after redoing every step')).toBe(last);
    expect(await viewProblems(page), fail('view after undo and redo')).toEqual([]);

    // What is shown is what is saved: the saved Markdown loads back as the same blocks.
    await page.evaluate((m) => (window as any).editor.setMarkdown(m), edited);
    const after = await shape(page);
    // Compare up to the first raw block whose source was edited.
    const edits = rawsBefore.findIndex((t) => t !== null && !originalRaws.includes(t));
    const upTo = edits === -1 ? before.length : edits;
    const at = before.slice(0, upTo).findIndex((b, i) => b !== after[i]);
    expect(at, fail(`the saved Markdown loads back differently at block ${at}:\n  shown:    ${before[at]}\n  reloaded: ${after[at]}\n  saved:\n${edited}`)).toBe(-1);
    if (edits === -1) expect(after.length).toBe(before.length);
    expect(errors, fail('page errors')).toEqual([]);
  });
}
