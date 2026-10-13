// Smoke test of the playground composer, which uses only the public API.

import { SAMPLE } from '../playground/sample';
import { expect, md, test } from './helpers';

// Every test gets a new browser context, so storage starts empty. Each test
// loads its page once: WebKit sometimes never sends a navigation request made
// right after another page load, which leaves the test waiting until it times out.

test('playground: tags, formatting bar, image upload, caret restore, submit', async ({ page }) => {
  await page.goto('/');
  const editor = page.locator('#editor');
  await page.evaluate(() => (window as any).editor.setMarkdown(''));
  await editor.click();
  await page.keyboard.type('Plan #wo');
  await page.locator('.mbe-suggestion-menu .mbe-menu-item', { hasText: '#work/planning' }).click();
  await page.keyboard.type('today');
  await expect(editor.locator('.tag')).toHaveText(['#work/planning']);
  expect(await md(page)).toBe('Plan #work/planning today\n');

  // The bar shows the active format at the caret.
  await page.locator('#bar button', { hasText: 'H2' }).click();
  await expect(page.locator('#bar button', { hasText: 'H2' })).toHaveClass(/on/);

  // A pasted image shows an upload placeholder, then becomes Markdown.
  await page.keyboard.press('End');
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(['x'], 'shot.png', { type: 'image/png' }));
    document.querySelector('#editor h2')!.dispatchEvent((window as any).clipboardEvent('paste', data));
  });
  await expect(editor.locator('.mbe-widget .upload')).toBeVisible();
  await expect(editor.locator('.mbe-widget')).toHaveCount(0, { timeout: 5000 });
  expect(await md(page)).toMatch(/^## Plan #work\/planning today\n\n!\[shot\.png\]\(blob:/);

  // The draft and the caret survive a reload.
  await page.locator('#editor h2').click();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
  await page.reload();
  expect(await page.evaluate(() => (window as any).editor.selectionToJSON())).toEqual({
    anchor: { block: 0, offset: 1 },
    focus: { block: 0, offset: 1 },
  });

  await editor.click();
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('#saved li')).toHaveCount(1);
  expect(await md(page)).toBe('');
});

test('editing and read-only look the same', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    el?.blur();
  });
  const editor = page.locator('#editor');
  // The sample has every block type: headings, lists, tasks, quote, math, code, table, divider.
  const editing = await editor.screenshot({ animations: 'disabled' });
  await page.evaluate(() => (window as any).editor.setOptions({ editable: false }));
  const readOnly = await editor.screenshot({ animations: 'disabled' });
  expect(readOnly.equals(editing)).toBe(true);
});

test('block spacing: one gap between blocks, close list items, joined quotes', async ({ page }) => {
  await page.goto('/');
  const gaps = async () =>
    page.evaluate(() => {
      const els = Array.from(document.querySelectorAll<HTMLElement>('#editor > .mbe-block'));
      return els.slice(1).map((el, i) => Math.round(el.getBoundingClientRect().top - els[i]!.getBoundingClientRect().bottom));
    });
  await page.evaluate(() => (window as any).editor.setMarkdown('## Title\n\none\n\n- a\n- b\n\n1. c\n\n> d\n>\n> e\n\ntwo\n\n---\n\nthree'));
  // h2→p, p→li, li→li, bullet→numbered list, li→quote, quote→quote, quote→p, p→hr, hr→p
  expect(await gaps()).toEqual([8, 8, 2, 8, 8, 0, 8, 16, 16]);
  // Marks follow edits: a paragraph between two items splits one list into two.
  await page.evaluate(() => {
    const editor = (window as any).editor;
    editor.setMarkdown('- a\n- b\n- c');
    editor.setSelection({ anchor: { block: 1, offset: 0 }, focus: { block: 1, offset: 0 } });
    editor.commands.toggleBulletList();
  });
  expect(await gaps()).toEqual([8, 8]);
  await page.evaluate(() => (window as any).editor.commands.toggleBulletList());
  expect(await gaps()).toEqual([2, 2]);
});

test('the sample shows every kind of block and saves byte for byte', async ({ page }) => {
  await page.goto('/');
  const editor = page.locator('#editor');
  await expect(editor.locator('h2')).toHaveCount(1);
  await expect(editor.locator('.mbe-list-item')).toHaveCount(7);
  await expect(editor.locator('.mbe-checkbox')).toHaveCount(2);
  await expect(editor.locator('.mbe-checkbox:checked')).toHaveCount(1);
  await expect(editor.locator('blockquote')).toHaveText('Quotes stay quiet.');
  await expect(editor.locator('.katex')).toHaveCount(2); // inline and block math, rendered
  await expect(editor.locator('.mbe-code')).toHaveCount(1);
  await expect(editor.locator('table th')).toHaveText(['Feature', 'Status']);
  await expect(editor.locator('hr')).toHaveCount(1);
  await expect(editor.locator('.mbe-token-footnote')).toHaveText('[^1]');
  await expect(editor.locator('.tag')).toHaveText(['#work/planning', '#work']);
  await expect(editor.locator('.mention')).toHaveText('@alice');
  await expect(editor.locator('a.mbe-link')).toHaveText('CommonMark');
  await expect(page.locator('#output')).toHaveText(SAMPLE);
  expect(await md(page)).toBe(SAMPLE);
});

const BAR: [label: string, markdown: string][] = [
  ['B', '**hello**'],
  ['I', '*hello*'],
  ['S', '~~hello~~'],
  ['`', '`hello`'],
  ['H1', '# hello'],
  ['H2', '## hello'],
  ['•', '- hello'],
  ['1.', '1. hello'],
  ['☐', '- [ ] hello'],
  ['❝', '> hello'],
  ['{ }', '```\nhello\n```'],
];

for (const [label, markdown] of BAR) {
  test(`bar: "${label}" applies its format, shows it as on, and a second click removes it`, async ({ page }) => {
    await page.goto('/?md=hello%0A');
    await page.locator('#editor p').click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    const button = page.locator('#bar button', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) });
    await expect(button).not.toHaveClass(/\bon\b/);
    await button.click();
    expect(await md(page)).toBe(`${markdown}\n`);
    await expect(button).toHaveClass(/\bon\b/);
    // Focus stays in the editor.
    expect(await page.evaluate(() => (window as any).editor.hasFocus())).toBe(true);
    await button.click();
    expect(await md(page)).toBe('hello\n');
    await expect(button).not.toHaveClass(/\bon\b/);
  });
}

test('bar: Link asks for a URL, links the selection, and an empty answer removes the link', async ({ page }) => {
  await page.goto('/?md=hello%0A');
  await page.locator('#editor p').click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  const link = page.locator('#bar button', { hasText: 'Link' });
  page.once('dialog', (d) => d.accept('https://example.com'));
  await link.click();
  expect(await md(page)).toBe('[hello](https://example.com)\n');
  await expect(link).toHaveClass(/\bon\b/);
  page.once('dialog', (d) => {
    expect(d.defaultValue()).toBe('https://example.com');
    return d.accept('');
  });
  await link.click();
  expect(await md(page)).toBe('hello\n');
  // Cancel changes nothing.
  page.once('dialog', (d) => d.dismiss());
  await link.click();
  expect(await md(page)).toBe('hello\n');
});

test('bar: Read-only stops typing, checkboxes and the slash menu; switching back allows them', async ({ page }) => {
  await page.goto(`/?md=${encodeURIComponent('- [ ] task\n\ntext\n')}`);
  const toggle = page.locator('#toggle-readonly');
  await toggle.click();
  await expect(toggle).toHaveClass(/\bon\b/);
  await page.locator('#editor p').click();
  await page.keyboard.type('x /');
  await page.locator('#editor .mbe-checkbox').click({ force: true });
  await page.keyboard.press('Backspace');
  await expect(page.locator('.mbe-slash-menu')).toBeHidden();
  expect(await md(page)).toBe('- [ ] task\n\ntext\n');
  await toggle.click();
  await expect(toggle).not.toHaveClass(/\bon\b/);
  await page.locator('#editor .mbe-checkbox').click();
  await page.locator('#editor p').click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  expect(await md(page)).toBe('- [x] task\n\ntext!\n');
});

/** Relative luminance of a CSS color, read back through a canvas so any color syntax works. */
const luminance = (page: import('@playwright/test').Page, selector: string, property: 'color' | 'background-color' = 'color') =>
  page.evaluate(
    ([selector, property]) => {
      const color = getComputedStyle(document.querySelector(selector)!).getPropertyValue(property);
      const ctx = document.createElement('canvas').getContext('2d')!;
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = Array.from(ctx.getImageData(0, 0, 1, 1).data).map((v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    },
    [selector, property] as const,
  );

test('bar: Theme cycles Warm, Dark and Light, and the editor follows each', async ({ page }) => {
  await page.goto('/');
  const theme = page.locator('#bar button', { hasText: /^Theme:/ });
  await expect(theme).toHaveText('Theme: Default');
  await theme.click();
  await expect(theme).toHaveText('Theme: Warm');
  expect(await page.locator('#editor p').first().evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Georgia');
  await theme.click();
  await expect(theme).toHaveText('Theme: Dark');
  expect(await luminance(page, '#editor p')).toBeGreaterThan(0.5);
  await theme.click();
  await expect(theme).toHaveText('Theme: Light');
  expect(await luminance(page, '#editor p')).toBeLessThan(0.1);
  await theme.click();
  await expect(theme).toHaveText('Theme: Default');
  expect(await md(page)).toBe(SAMPLE);
});

test('bar: Save adds the note to the saved list and leaves an empty editor with its placeholder', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => (window as any).editor.setMarkdown('first note'));
  await page.locator('#bar button', { hasText: 'Save' }).click();
  await expect(page.locator('#saved li')).toHaveText(['first note']);
  expect(await md(page)).toBe('');
  const placeholder = await page.locator('#editor > p').first().evaluate((el) => getComputedStyle(el, '::before').content);
  expect(placeholder).toContain('Write something');
  // An empty editor saves nothing.
  await page.locator('#bar button', { hasText: 'Save' }).click();
  await expect(page.locator('#saved li')).toHaveCount(1);
});

test('the other playground pages load: empty, plain CommonMark, base.css only, React', async ({ page }) => {
  await page.goto('/?plain');
  await expect(page.locator('#editor .katex')).toHaveCount(0); // no math extension: $…$ is text
  await expect(page.locator('#editor .tag')).toHaveCount(0);
  expect(await md(page)).toBe(SAMPLE);
  await page.goto('/?base');
  await expect(page.locator('#editor h2')).toHaveCount(1);
  await page.goto('/?empty');
  expect(await md(page)).toBe('');
  await page.goto('/react.html');
  await expect(page.locator('.mbe-root')).toHaveCount(1);
});
