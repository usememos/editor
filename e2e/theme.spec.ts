// The theme option: classes on rendered elements, in editing and read-only.

import { expect, type Page, test } from './helpers';

const CLASSES = {
  paragraph: 't-paragraph',
  heading: { 1: 't-h1', 2: 't-h2', 3: 't-h3', 4: 't-h4', 5: 't-h5', 6: 't-h6' },
  blockquote: 't-blockquote',
  bulletList: 't-bullet',
  orderedList: 't-ordered',
  taskList: 't-task',
  codeBlock: 't-code-block',
  table: 't-table',
  divider: 't-divider',
  raw: 't-raw',
  image: 't-image',
  bold: 't-bold',
  italic: 't-italic',
  strike: 't-strike',
  code: 't-code',
  link: 't-link mt-2  extra', // several classes, with extra spaces
  token: { math: 't-math', footnote: 't-footnote' },
};

const DOC = [
  '# h1',
  '## h2',
  '### h3',
  '#### h4',
  '##### h5',
  '###### h6',
  'para **bold** *italic* ~~strike~~ `code` [link](https://example.com) ![img](data:image/gif;base64,R0lGODlhAQABAAAAACw=) $x^2$ ref[^1]',
  '> quote',
  '- bullet',
  '1. ordered',
  '- [ ] task',
  '```js\nlet a\n```',
  '| a | b |\n| - | - |\n| c | d |',
  '---',
  '<div>html</div>',
  '$$\nx\n$$',
  '[^1]: note',
].join('\n\n');

/** For each expected selector, whether every match and at least one element carries the class. */
const SELECTORS: Record<string, string> = {
  '#editor > h1': 't-h1',
  '#editor > h2': 't-h2',
  '#editor > h3': 't-h3',
  '#editor > h4': 't-h4',
  '#editor > h5': 't-h5',
  '#editor > h6': 't-h6',
  '#editor > p': 't-paragraph',
  '#editor > blockquote': 't-blockquote',
  '#editor > [data-list-type="bullet"]': 't-bullet',
  '#editor > [data-list-type="ordered"]': 't-ordered',
  '#editor > [data-list-type="task"]': 't-task',
  '#editor > .mbe-code': 't-code-block',
  '#editor > .mbe-table': 't-table',
  '#editor > .mbe-divider hr': 't-divider',
  '#editor > .mbe-raw': 't-raw',
  // An image, or the box shown when it does not load.
  '#editor .mbe-image': 't-image',
  '#editor strong': 't-bold',
  '#editor em': 't-italic',
  '#editor s': 't-strike',
  '#editor > p code': 't-code',
  '#editor a': 'extra',
  '#editor :is(.mbe-view-math, .mbe-token-math)': 't-math',
  '#editor :is(.mbe-view-footnote, .mbe-token-footnote)': 't-footnote',
};

async function missing(page: Page): Promise<string[]> {
  return page.evaluate((selectors) => {
    const out: string[] = [];
    for (const [selector, cls] of Object.entries(selectors)) {
      const els = Array.from(document.querySelectorAll(selector));
      if (els.length === 0 || els.some((el) => !el.classList.contains(cls))) out.push(`${selector} .${cls}`);
    }
    return out;
  }, SELECTORS);
}

test('theme classes go on every element of their type, editing and read-only', async ({ page }) => {
  await page.goto('/?empty');
  await page.evaluate(
    ([markdown, classes]) => {
      const editor = (window as any).editor;
      editor.setOptions({ theme: { classes } });
      editor.setMarkdown(markdown);
    },
    [DOC, CLASSES] as const,
  );
  expect(await missing(page)).toEqual([]);
  // The editor's own classes stay.
  expect(await page.locator('#editor > h1.mbe-block.mbe-heading.t-h1').count()).toBe(1);
  expect(await page.locator('#editor a.mbe-link.t-link.mt-2.extra').count()).toBe(1);

  // A token shows its source at the caret, and keeps the class.
  await page.locator('#editor > p .mbe-view-math .katex-html').click();
  await expect(page.locator('#editor > p .mbe-token-math')).toHaveClass(/t-math/);
  // A raw block's source keeps the class too.
  await page.locator('#editor > .mbe-view-block[data-syntax="math"]').click();
  await expect(page.locator('#editor > pre.mbe-raw[data-syntax="math"]')).toHaveClass(/t-raw/);

  await page.evaluate(() => (window as any).editor.setOptions({ editable: false }));
  expect(await missing(page)).toEqual([]);
});

test('extensions add theme classes; the editor theme wins per key; setOptions replaces them', async ({ page }) => {
  await page.goto('/?empty');
  const classes = () =>
    page.evaluate(() => {
      // mbe-lazy marks blocks of a loaded document; not part of the theme.
      const of = (selector: string) => document.querySelector(selector)!.className.replace(' mbe-lazy', '');
      return { h1: of('#editor > h1'), h2: of('#editor > h2'), p: of('#editor > p') };
    });
  await page.evaluate(() => {
    const { Editor } = (window as any).core;
    (window as any).editor.destroy();
    (window as any).editor = new Editor({
      element: document.getElementById('editor'),
      content: '# a\n\n## b\n\nc',
      extensions: [
        { name: 'first', theme: { classes: { paragraph: 'from-first', heading: { 1: 'first-h1' } } } },
        { name: 'second', theme: { classes: { paragraph: 'from-second', heading: { 2: 'second-h2' } } } },
      ],
      theme: { classes: { heading: { 1: 'host-h1' } } },
    });
  });
  expect(await classes()).toEqual({
    h1: 'mbe-block mbe-heading host-h1',
    h2: 'mbe-block mbe-heading second-h2',
    p: 'mbe-block mbe-paragraph from-first',
  });

  // Same classes in a new object: no re-render. New classes: every block re-renders.
  const h1 = await page.evaluateHandle(() => document.querySelector('#editor > h1'));
  await page.evaluate(() => (window as any).editor.setOptions({ theme: { classes: { heading: { 1: 'host-h1' } } } }));
  expect(await h1.evaluate((el) => el.isConnected)).toBe(true);
  await page.evaluate(() => (window as any).editor.setOptions({ theme: { classes: { paragraph: 'host-p' } } }));
  expect(await h1.evaluate((el) => el.isConnected)).toBe(false);
  expect(await classes()).toEqual({
    h1: 'mbe-block mbe-heading first-h1',
    h2: 'mbe-block mbe-heading second-h2',
    p: 'mbe-block mbe-paragraph host-p',
  });
});

test('with only base.css, layout and spacing work and the editor sets no colors or fonts', async ({ page }) => {
  const markdown = '## Title\n\none\n\n- a\n- b\n\n1. c\n\n> d\n>\n> e\n\n- [x] done\n\ntwo\n\n---\n\n| a | b |\n| - | - |\n| c | d |';
  const gaps = () =>
    page.evaluate(() => {
      const els = Array.from(document.querySelectorAll<HTMLElement>('#editor > .mbe-block'));
      return els.slice(1).map((el, i) => Math.round(el.getBoundingClientRect().top - els[i]!.getBoundingClientRect().bottom));
    });
  await page.goto('/?md=' + encodeURIComponent(markdown));
  const themed = await gaps();
  // Margins in theme classes do not change the spacing between blocks.
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = '.m40 { margin: 40px 0; }';
    document.head.append(style);
    const m = 'm40';
    (window as any).editor.setOptions({
      theme: { classes: { paragraph: m, heading: { 2: m }, blockquote: m, bulletList: m, orderedList: m, taskList: m, table: m } },
    });
  });
  expect(await page.locator('#editor > .m40').count()).toBe(10); // all blocks but the divider
  expect(await gaps()).toEqual(themed);
  await page.goto('/?base&md=' + encodeURIComponent(markdown));
  // The same rhythm as with the default theme.
  expect(await gaps()).toEqual(themed);
  expect(themed).toEqual([8, 8, 2, 8, 8, 0, 8, 8, 16, 16]);
  const facts = await page.evaluate(() => {
    const root = document.getElementById('editor')!;
    const css = (el: Element, pseudo?: string) => getComputedStyle(el, pseudo);
    const marker = root.querySelector('[data-list-type="bullet"] > .mbe-marker')!;
    const box = root.querySelector<HTMLElement>('.mbe-checkbox')!;
    return {
      text: css(root).getPropertyValue('--mbe-text'),
      font: css(root).fontFamily === css(root.parentElement!).fontFamily,
      color: css(root).color === css(root.parentElement!).color,
      bullet: css(marker, '::before').content,
      marker: marker.getBoundingClientRect().width,
      item: css(marker.parentElement!).display,
      checkbox: [box.offsetWidth, box.offsetHeight],
      cell: parseFloat(css(root.querySelector('td')!).minWidth),
    };
  });
  expect(facts).toMatchObject({ text: '', font: true, color: true, bullet: '"•"', marker: 24, item: 'flex', checkbox: [16, 16] });
  expect(facts.cell).toBeGreaterThan(0);

  // The placeholder and the slash menu still work.
  await page.evaluate(() => (window as any).editor.setMarkdown(''));
  expect(await page.evaluate(() => getComputedStyle(document.querySelector('#editor > p')!, '::before').content)).not.toBe('none');
  await page.locator('#editor').click();
  await page.keyboard.type('/');
  const menu = page.locator('.mbe-suggestion-menu');
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
});

test('theme tokens and colorScheme restyle the editor and its menus without re-rendering', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/?md=' + encodeURIComponent('one\n\ntwo'));
  const first = await page.evaluateHandle(() => document.querySelector('#editor > p'));
  const look = () =>
    page.evaluate(() => {
      const root = document.getElementById('editor')!;
      const [a, b] = Array.from(root.querySelectorAll('p'));
      const css = getComputedStyle(root);
      return {
        color: css.color,
        muted: getComputedStyle(root).getPropertyValue('--mbe-muted').trim(),
        fontSize: getComputedStyle(a!).fontSize,
        gap: Math.round(b!.getBoundingClientRect().top - a!.getBoundingClientRect().bottom),
      };
    });
  const before = await look();
  const setTheme = (theme: unknown) => page.evaluate((t) => (window as any).editor.setOptions({ theme: t }), theme);
  const tokens = { light: { text: 'rgb(1, 2, 3)' }, dark: { text: 'rgb(4, 5, 6)' }, fontSize: 18, blockGap: '12px' };

  await setTheme({ tokens });
  expect(await look()).toMatchObject({ color: 'rgb(1, 2, 3)', fontSize: '18px', gap: 12, muted: before.muted });

  await setTheme({ tokens, colorScheme: 'dark' });
  const dark = await look();
  expect(dark.color).toBe('rgb(4, 5, 6)');
  // A color the theme leaves out keeps the default dark palette.
  expect(dark.muted).toContain('oklch(0.72 0.007 255)');

  // The slash menu takes the tokens and the scheme.
  await page.locator('#editor > p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  const menu = page.locator('.mbe-suggestion-menu');
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((el) => getComputedStyle(el).color)).toBe('rgb(4, 5, 6)');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Backspace');

  // inherit follows the page's color-scheme, as an app that switches it sets it.
  await setTheme({ tokens, colorScheme: 'inherit' });
  await page.evaluate(() => (document.documentElement.style.colorScheme = 'dark'));
  expect((await look()).color).toBe('rgb(4, 5, 6)');
  await page.evaluate(() => (document.documentElement.style.colorScheme = 'light'));
  expect((await look()).color).toBe('rgb(1, 2, 3)');

  // auto follows prefers-color-scheme, and data-theme on an ancestor.
  await setTheme({ tokens });
  await page.emulateMedia({ colorScheme: 'dark' });
  expect((await look()).color).toBe('rgb(4, 5, 6)');
  await page.evaluate(() => (document.body.dataset.theme = 'light'));
  expect((await look()).color).toBe('rgb(1, 2, 3)');

  // Removing the theme restores the defaults. None of this re-rendered a block.
  await page.evaluate(() => delete document.body.dataset.theme);
  await page.emulateMedia({ colorScheme: 'light' });
  await setTheme(undefined);
  expect(await look()).toEqual(before);
  expect(await first.evaluate((el) => el.isConnected)).toBe(true);
});

test('a font token of inherit keeps the sizes of the code language label and raw blocks', async ({ page }) => {
  await page.goto(`/?md=${encodeURIComponent('```js\nlet a = 1;\n```\n\n> quote\n> > nested')}`);
  await page.evaluate(() => (window as any).editor.setOptions({ theme: { tokens: { font: 'inherit', mono: 'inherit', fontSize: 20 } } }));
  const size = (selector: string) => page.locator(selector).evaluate((el) => [getComputedStyle(el).fontSize, getComputedStyle(el).lineHeight]);
  expect(await size('#editor .mbe-code-lang')).toEqual(['12px', '16px']);
  expect(await size('#editor pre.mbe-raw')).toEqual(['14px', '22px']);
});
