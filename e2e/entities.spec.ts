import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const coreSrc = fileURLToPath(new URL('../packages/editor/src', import.meta.url));

// Browsers decode named entities with their own HTML parser (entities.dom.ts)
// instead of the table that Node uses (entities.ts). Both must agree.
test('the browser entity decoder matches the WHATWG table', async ({ page }) => {
  await page.goto('/?empty');
  const mismatches = await page.evaluate(async (src) => {
    const root = '/@fs' + src;
    const table = await import(/* @vite-ignore */ `${root}/markdown/entities.ts`);
    const dom = await import(/* @vite-ignore */ `${root}/markdown/entities.dom.ts`);
    const source: string = await (await fetch(`${root}/markdown/entities.ts?raw`)).text();
    const names = [...source.matchAll(/[;']([A-Za-z][A-Za-z0-9]*):/g)].map((m) => m[1]!);
    // Not entities: legacy names without ";" followed by more letters, unknown names, and odd input.
    const negatives = ['notit', 'ampx', 'copyx', 'foo', 'Amp', 'nbspx', 'lt1', '', '1amp', 'a b', 'amp;lt'];
    const out: string[] = [];
    for (const name of [...names, ...negatives]) {
      const a = table.lookupEntity(name);
      const b = dom.lookupEntity(name);
      if (a !== b) out.push(`${name}: table=${JSON.stringify(a)} dom=${JSON.stringify(b)}`);
    }
    return { count: names.length, out };
  }, coreSrc);
  expect(mismatches.count).toBeGreaterThan(2000);
  expect(mismatches.out).toEqual([]);
});
