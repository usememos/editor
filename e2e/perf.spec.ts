import { expect, test } from './helpers';

// Release gates (spec): p95 keystroke under 16 ms in a 2,000-block document,
// and 100 KB of Markdown parsed and rendered in under 100 ms.

function bigDoc(blocks: number): string {
  const kinds = [
    (i: number) => `## Section ${i}`,
    (i: number) => `Paragraph ${i} with **bold**, *italic*, \`code\` and a [link](https://example.com/${i}).`,
    (i: number) => `- item ${i}\n- item ${i + 1}`,
    (i: number) => `> quote ${i}`,
    (i: number) => `1. first ${i}\n2. second ${i}`,
  ];
  const parts: string[] = [];
  for (let i = 0; parts.length < blocks; i++) parts.push(kinds[i % kinds.length]!(i));
  return parts.join('\n\n') + '\n';
}

test('typing latency in a 2,000-block document', async ({ page }) => {
  await page.goto('/?empty');
  const md = bigDoc(1600); // list items count as blocks: about 2,000 blocks
  const count = await page.evaluate((m) => {
    const editor = (window as any).editor;
    editor.setMarkdown(m);
    return editor.state.doc.blocks.length;
  }, md);
  expect(count).toBeGreaterThanOrEqual(2000);
  // Put the caret in a block in the middle.
  await page.locator('#editor > p').nth(300).click();
  const times = await page.evaluate(async () => {
    const root = document.getElementById('editor')!;
    // The playground prints the whole document under the editor on every change.
    // Hide it so the test measures the editor, not a 100 KB <pre> reflowing.
    document.getElementById('output')!.style.display = 'none';
    const out: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      root.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', bubbles: true, cancelable: true }));
      out.push(performance.now() - t0);
      // A frame between keystrokes, as in real typing: rAF-scheduled onChange
      // serializes the whole document, and the browser renders.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    return out;
  });
  const sorted = times.slice().sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  const serialize = await page.evaluate(() => {
    const t0 = performance.now();
    (window as any).editor.getMarkdown();
    return performance.now() - t0;
  });
  console.log(`keystroke p95: ${p95.toFixed(2)} ms, median: ${sorted[100]!.toFixed(2)} ms; serialize: ${serialize.toFixed(1)} ms`);
  expect(p95).toBeLessThan(16);
});

test('finding the autocomplete token at the caret in a 2,000-block document', async ({ page }) => {
  // The playground has four suggestions: #tags, @people, [[ pages and the slash menu.
  await page.goto('/?empty');
  const line = 'Notes on #work/planning with @ada and [[Meeting notes]] see /path #a #b @c '.repeat(6);
  await page.evaluate(
    ([doc, line]) => {
      const editor = (window as any).editor;
      editor.setMarkdown(`${doc}\n${line}#wor`);
    },
    [bigDoc(1600), line] as const,
  );
  await page.locator('#editor').click();
  const times = await page.evaluate(() => {
    const editor = (window as any).editor;
    const blocks = editor.state.doc.blocks;
    const last = blocks.length - 1;
    const text = blocks[last].content.map((s: any) => s.text).join('');
    editor.setSelection({ anchor: { block: last, offset: text.length }, focus: { block: last, offset: text.length } });
    // The step that runs on every keystroke: each suggestion's matcher and allow rule.
    const controller = editor.suggestions;
    const out: number[] = [];
    for (let i = 0; i < 500; i++) {
      const t0 = performance.now();
      controller.find(false);
      out.push(performance.now() - t0);
    }
    return out;
  });
  const sorted = times.slice().sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  console.log(`find token p95: ${p95.toFixed(3)} ms, median: ${sorted[250]!.toFixed(3)} ms`);
  expect(p95).toBeLessThan(1);
});

test('finding the autocomplete token at the caret in 100 KB of Markdown in source mode', async ({ page }) => {
  await page.goto('/?source&empty');
  let md = '';
  for (let n = 0; md.length < 100_000; n += 100) md = bigDoc(n);
  await page.evaluate((m) => (window as any).editor.setMarkdown(`${m}\nNotes on #work/planning with @ada see /path #a #b @c #wor`), md);
  await page.locator('#editor').click();
  const times = await page.evaluate(() => {
    const editor = (window as any).editor;
    const id = editor.state.doc.blocks[0].id;
    const end = editor.getMarkdown().length;
    editor.setSelection({ anchor: { blockId: id, offset: end }, focus: { blockId: id, offset: end } });
    const controller = editor.suggestions;
    controller.find(false);
    const out: number[] = [];
    for (let i = 0; i < 500; i++) {
      const t0 = performance.now();
      controller.find(false);
      out.push(performance.now() - t0);
    }
    return out;
  });
  const sorted = times.slice().sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  console.log(`source find token p95: ${p95.toFixed(3)} ms, median: ${sorted[250]!.toFixed(3)} ms`);
  expect(p95).toBeLessThan(1);
});

test('typing latency in source mode with 100 KB of Markdown', async ({ page }) => {
  // Source mode is one block: every keystroke rebuilds its text and highlighting.
  await page.goto('/?source&empty');
  let md = '';
  for (let n = 0; md.length < 100_000; n += 100) md = bigDoc(n);
  await page.evaluate((m) => (window as any).editor.setMarkdown(m), md);
  const times = await page.evaluate(async () => {
    const editor = (window as any).editor;
    const root = document.getElementById('editor')!;
    document.getElementById('output')!.style.display = 'none';
    const id = editor.state.doc.blocks[0].id;
    const mid = Math.floor(editor.getMarkdown().length / 2);
    editor.focus();
    editor.setSelection({ anchor: { blockId: id, offset: mid }, focus: { blockId: id, offset: mid } });
    const out: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      root.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', bubbles: true, cancelable: true }));
      out.push(performance.now() - t0);
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    return out;
  });
  const sorted = times.slice().sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
  console.log(`source keystroke p95: ${p95.toFixed(2)} ms, median: ${sorted[100]!.toFixed(2)} ms`);
  expect(p95).toBeLessThan(16);
});

test('100 KB of Markdown parsed and rendered', async ({ page }) => {
  await page.goto('/?empty');
  let md = '';
  for (let n = 0; md.length < 100_000; n += 100) md = bigDoc(n);
  const ms = await page.evaluate((m) => {
    const t0 = performance.now();
    (window as any).editor.setMarkdown(m);
    document.body.offsetHeight; // include layout
    return performance.now() - t0;
  }, md);
  console.log(`load 100 KB: ${ms.toFixed(1)} ms`);
  expect(ms).toBeLessThan(100);
});
