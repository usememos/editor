import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { expect, test } from './helpers';

const markdownSrc = (file: string) => fileURLToPath(new URL(`../packages/editor/src/markdown/${file}`, import.meta.url));

/** A module bundled into a script that sets `window[name]`. The tests run against a built playground, which has neither file on its own. */
async function script(file: string, name: string): Promise<string> {
  const result = await build({ entryPoints: [markdownSrc(file)], bundle: true, write: false, format: 'iife', globalName: name });
  return result.outputFiles[0]!.text;
}

// Browsers decode named entities with their own HTML parser (entities.dom.ts)
// instead of the table that Node uses (entities.ts). Both must agree.
test('the browser entity decoder matches the WHATWG table', async ({ page }) => {
  await page.goto('/?empty');
  await page.addScriptTag({ content: await script('entities.ts', 'entityTable') });
  await page.addScriptTag({ content: await script('entities.dom.ts', 'entityDom') });
  const source = readFileSync(markdownSrc('entities.ts'), 'utf8');
  const names = [...source.matchAll(/[;']([A-Za-z][A-Za-z0-9]*):/g)].map((m) => m[1]!);
  // Not entities: legacy names without ";" followed by more letters, unknown names, and odd input.
  const negatives = ['notit', 'ampx', 'copyx', 'foo', 'Amp', 'nbspx', 'lt1', '', '1amp', 'a b', 'amp;lt'];
  const mismatches = await page.evaluate((all) => {
    const { entityTable: table, entityDom: dom } = window as any;
    const out: string[] = [];
    for (const name of all) {
      const a = table.lookupEntity(name);
      const b = dom.lookupEntity(name);
      if (a !== b) out.push(`${name}: table=${JSON.stringify(a)} dom=${JSON.stringify(b)}`);
    }
    return out;
  }, [...names, ...negatives]);
  expect(names.length).toBeGreaterThan(2000);
  expect(mismatches).toEqual([]);
});
