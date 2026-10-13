// The autocomplete popup of suggestion(): when it opens and closes, what a
// pick writes, and the caller's matcher and allow rules.

import { blocks, expect, md, test, type Page } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/?empty');
  await page.evaluate(() => {
    const { Editor, matchToken, scanTags, suggestion, tags } = (window as any).core;
    (window as any).editor.destroy();
    const TAGS = ['work', 'work/planning', 'reading'];
    const PAGES = ['Meeting notes', 'Reading list'];
    (window as any).editor = new Editor({
      element: document.getElementById('editor'),
      extensions: [
        tags(),
        suggestion({
          name: 'tags',
          trigger: ['#', '＃'],
          className: 'tag-menu',
          match: matchToken(scanTags),
          // A bare "#" at the start of a paragraph may become a heading: only Ctrl+Space opens there.
          allow: ({ block, query, textBefore, excluded, explicit }: any) =>
            !excluded && (explicit || query !== '' || block.type !== 'paragraph' || textBefore !== ''),
          items: ({ query }: { query: string }) => TAGS.filter((t) => t.startsWith(query)).map((t) => ({ id: t, label: `#${t}` })),
        }),
        suggestion({
          name: 'links',
          trigger: '[[',
          allowSpaces: true,
          className: 'link-menu',
          items: ({ query }: { query: string }) =>
            PAGES.filter((p) => p.toLowerCase().startsWith(query.toLowerCase())).map((p) => ({ label: p })),
          command: ({ editor, range, item }: any) => editor.commands.insertText(`[[${item.label}]]`, { range }),
        }),
      ],
    });
  });
  await page.locator('#editor').click();
});

const tagMenu = (page: Page) => page.locator('.tag-menu');
const items = (page: Page) => page.locator('.tag-menu:visible .mbe-menu-item');
const load = (page: Page, markdown: string, offset: number) =>
  page.evaluate(
    ([markdown, offset]) => {
      const editor = (window as any).editor;
      editor.setMarkdown(markdown);
      editor.setSelection({ anchor: { block: 0, offset }, focus: { block: 0, offset } });
    },
    [markdown, offset] as const,
  );

test('typing in an existing token opens the popup; moving the caret into it does not', async ({ page }) => {
  await load(page, 'see #wor and more', 8);
  await expect(tagMenu(page)).toBeHidden();
  await page.keyboard.type('k');
  await expect(items(page)).toHaveText(['#work', '#work/planning']);
});

test('a pick replaces the whole token, also after the caret, and is one undo step', async ({ page }) => {
  await load(page, '#rk more', 1);
  await page.keyboard.type('wo');
  await expect(items(page)).toHaveText(['#work', '#work/planning']);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(tagMenu(page)).toBeHidden();
  // The next character is a space, so the default command adds none.
  expect(await md(page)).toBe('#work/planning more');
  await page.keyboard.press('Control+z');
  expect(await md(page)).toBe('#work more');
});

test('the default command writes the first trigger, the value and a space, unless closing punctuation follows', async ({ page }) => {
  await page.keyboard.type('a #rea');
  await page.keyboard.press('Enter');
  await page.keyboard.type('x');
  expect(await md(page)).toBe('a #reading x\n');
  await load(page, '()', 1);
  await page.keyboard.type('#re');
  await page.keyboard.press('Enter');
  expect(await md(page)).toBe('(#reading)');
  // A full-width trigger opens the same popup and becomes ASCII.
  await load(page, 'b', 1);
  await page.keyboard.type(' ＃wo');
  await expect(items(page)).toHaveText(['#work', '#work/planning']);
  await page.keyboard.press('Enter');
  expect(await md(page)).toBe('b #work&#32;');
});

test('allow keeps a bare # at the start of a paragraph closed; Ctrl+Space opens it', async ({ page }) => {
  await page.keyboard.type('#');
  await expect(tagMenu(page)).toBeHidden();
  await page.keyboard.press('Control+Space');
  await expect(items(page)).toHaveText(['#work', '#work/planning', '#reading']);
  await page.keyboard.type('r');
  await expect(items(page)).toHaveText(['#reading']);
  await page.keyboard.press('Enter');
  expect(await md(page)).toBe('#reading&#32;\n');
  // "# " still makes a heading.
  await page.keyboard.press('Enter');
  await page.keyboard.type('# Title');
  expect(await blocks(page)).toEqual(['p:#reading ', 'h1:Title']);
  // Ctrl+Space with no token at the caret does nothing.
  expect(await page.evaluate(() => (window as any).editor.suggestion.open())).toBe(false);
});

test('Escape closes the popup for that token until the caret leaves it', async ({ page }) => {
  await page.keyboard.type('x #w');
  await expect(tagMenu(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tagMenu(page)).toBeHidden();
  // Escape did nothing else: no block selection, still focused.
  expect(await page.evaluate(() => (window as any).editor.selectedBlocks.length)).toBe(0);
  await expect(page.locator('#editor')).toBeFocused();
  await page.keyboard.type('o');
  await expect(tagMenu(page)).toBeHidden();
  // Out of the token and back.
  await page.keyboard.press('Home');
  await expect.poll(() => page.evaluate(() => (window as any).editor.state.selection.focus.offset)).toBe(0);
  await page.keyboard.press('End');
  await page.keyboard.type('r');
  await expect(items(page)).toHaveText(['#work', '#work/planning']);
  await page.keyboard.press('Escape');
  // Ctrl+Space opens it again at once.
  await page.keyboard.press('Control+Space');
  await expect(tagMenu(page)).toBeVisible();
  // A new token opens as usual.
  await page.keyboard.press('Escape');
  await page.keyboard.type(' #');
  await expect(items(page)).toHaveCount(3);
});

test('deleting never opens the popup, and keeps an open one open', async ({ page }) => {
  await load(page, 'a #works', 8);
  await page.keyboard.press('Backspace');
  await expect(tagMenu(page)).toBeHidden();
  await page.keyboard.type('x');
  await page.keyboard.press('Backspace');
  await expect(items(page)).toHaveText(['#work', '#work/planning']);
  await page.keyboard.press('Backspace');
  await expect(items(page)).toHaveText(['#work', '#work/planning']);
});

test('no popup in inline code or link text; it closes on blur and on setMarkdown', async ({ page }) => {
  await load(page, '`code #` and [a #](u)', 6);
  await page.keyboard.type('w');
  await expect(tagMenu(page)).toBeHidden();
  await load(page, 'a', 1);
  await page.keyboard.type(' #w');
  await expect(tagMenu(page)).toBeVisible();
  await page.evaluate(() => (window as any).editor.blur());
  await expect(tagMenu(page)).toBeHidden();
  await page.locator('#editor').click();
  await load(page, 'b', 1);
  await page.keyboard.type(' #w');
  await expect(tagMenu(page)).toBeVisible();
  await page.evaluate(() => (window as any).editor.setMarkdown('new'));
  await expect(tagMenu(page)).toBeHidden();
});

test('a trigger of two characters, with spaces in the query and a custom command', async ({ page }) => {
  const menu = page.locator('.link-menu');
  await page.keyboard.type('see [');
  await expect(menu).toBeHidden();
  await page.keyboard.type('[me');
  await expect(menu.locator('.mbe-menu-item')).toHaveText(['Meeting notes']);
  await page.keyboard.type('eting n');
  await expect(menu.locator('.mbe-menu-item')).toHaveText(['Meeting notes']);
  await page.keyboard.press('Enter');
  expect(await blocks(page)).toEqual(['p:see [[Meeting notes]]']);
});

test('async items: a loading row, earlier items kept while newer ones load, stale results dropped, limit, rejection', async ({ page }) => {
  await page.evaluate(() => {
    const { Editor, suggestion } = (window as any).core;
    (window as any).editor.destroy();
    const TAGS = ['work', 'work/planning', 'reading', 'ideas'];
    const delays: Record<string, number> = { '': 600, w: 400, wo: 20 };
    const aborted: string[] = ((window as any).aborted = []);
    (window as any).editor = new Editor({
      element: document.getElementById('editor'),
      extensions: [
        suggestion({
          name: 'tags',
          trigger: '#',
          className: 'tag-menu',
          limit: 2,
          items: ({ query, signal }: { query: string; signal: AbortSignal }) =>
            new Promise((resolve, reject) => {
              signal.addEventListener('abort', () => aborted.push(query));
              if (query === 'x') return reject(new Error('offline'));
              setTimeout(() => resolve(TAGS.filter((t) => t.startsWith(query)).map((t) => ({ id: t, label: `#${t} (${query})` }))), delays[query] ?? 20);
            }),
        }),
      ],
    });
  });
  await page.locator('#editor').click();
  const menu = page.locator('.tag-menu');
  await page.keyboard.type('a #');
  await expect(menu.locator('.mbe-menu-loading')).toHaveText('Loading…');
  await expect(menu.locator('.mbe-menu-item')).toHaveText(['#work ()', '#work/planning ()']);
  await expect(menu).not.toHaveAttribute('aria-busy');
  await page.keyboard.type('w');
  await expect(menu).toHaveAttribute('aria-busy', 'true');
  await expect(menu.locator('.mbe-menu-item')).toHaveText(['#work ()', '#work/planning ()']);
  await page.keyboard.type('o');
  await expect(menu.locator('.mbe-menu-item')).toHaveText(['#work (wo)', '#work/planning (wo)']);
  await expect(menu).not.toHaveAttribute('aria-busy');
  // The result for "w" arrives later and is dropped; its signal was aborted.
  await page.waitForTimeout(500);
  await expect(menu.locator('.mbe-menu-item')).toHaveText(['#work (wo)', '#work/planning (wo)']);
  expect(await page.evaluate(() => (window as any).aborted)).toContain('w');
  // A rejected request counts as no items.
  await page.keyboard.type(' #x');
  await expect(menu).toBeHidden();
  expect(await md(page)).toBe('a #wo #x\n');
});

test.describe('items, keys and accessibility', () => {
  test.beforeEach(async ({ page }) => {
    await page.evaluate(() => {
      const { Editor, suggestion } = (window as any).core;
      (window as any).editor.destroy();
      const PEOPLE = [
        { id: 'ada', label: 'Ada Lovelace', detail: '@ada', section: 'People', icon: 'A' },
        { id: 'alan', label: 'Alan Turing', detail: '@alan', section: 'People' },
        { id: 'algo', label: 'Algorithms', section: 'Pages' },
      ];
      (window as any).editor = new Editor({
        element: document.getElementById('editor'),
        extensions: [
          suggestion({
            name: 'people',
            trigger: '@',
            label: 'People',
            className: 'people-menu',
            items: ({ query }: { query: string }) => PEOPLE.filter((p) => p.label.toLowerCase().includes(query.toLowerCase())),
          }),
        ],
      });
    });
    await page.locator('#editor').click();
  });

  const menu = (page: Page) => page.locator('.people-menu');
  const highlighted = (page: Page) => page.locator('.people-menu .mbe-menu-item.mbe-highlighted .mbe-menu-label');

  test('rows show sections, details, icons and the matched part of the label', async ({ page }) => {
    await page.keyboard.type('@');
    await expect(menu(page).locator('.mbe-menu-title')).toHaveText(['People', 'Pages']);
    await expect(menu(page).locator('.mbe-menu-title').first()).toHaveAttribute('role', 'presentation');
    await expect(menu(page).locator('.mbe-menu-item .mbe-menu-detail')).toHaveText(['@ada', '@alan']);
    await expect(menu(page).locator('.mbe-menu-item').first().locator('.mbe-menu-icon')).toHaveText('A');
    await page.keyboard.type('Al');
    await expect(menu(page).locator('.mbe-menu-label')).toHaveText(['Alan Turing', 'Algorithms']);
    await expect(menu(page).locator('mark.mbe-menu-match')).toHaveText(['Al', 'Al']);
    // The default command writes the value: the id.
    await page.keyboard.press('Enter');
    expect(await md(page)).toBe('@alan&#32;\n');
  });

  test('arrows wrap, Page keys jump, Tab accepts and Shift+Tab is not taken', async ({ page }) => {
    await page.keyboard.type('x @');
    await expect(highlighted(page)).toHaveText('Ada Lovelace');
    await page.keyboard.press('ArrowUp');
    await expect(highlighted(page)).toHaveText('Algorithms');
    await page.keyboard.press('ArrowDown');
    await expect(highlighted(page)).toHaveText('Ada Lovelace');
    await page.keyboard.press('PageDown');
    await expect(highlighted(page)).toHaveText('Algorithms');
    await page.keyboard.press('PageUp');
    await expect(highlighted(page)).toHaveText('Ada Lovelace');
    await page.keyboard.press('Shift+Tab');
    await expect(highlighted(page)).toHaveText('Ada Lovelace');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Tab');
    await expect(menu(page)).toBeHidden();
    expect(await md(page)).toBe('x @alan&#32;\n');
  });

  test('the highlight stays on the same item when the items change; a hidden popup takes no keys', async ({ page }) => {
    await page.keyboard.type('@a');
    await page.keyboard.press('ArrowUp');
    await expect(highlighted(page)).toHaveText('Algorithms');
    await page.keyboard.type('l');
    await expect(menu(page).locator('.mbe-menu-label')).toHaveText(['Alan Turing', 'Algorithms']);
    await expect(highlighted(page)).toHaveText('Algorithms');
    await page.keyboard.type('z');
    await expect(menu(page)).toBeHidden();
    await page.keyboard.press('Enter');
    expect(await blocks(page)).toEqual(['p:@alz', 'p:']);
  });

  test('ARIA: the root names the listbox and the highlighted option while open', async ({ page }) => {
    const root = page.locator('#editor');
    await expect(root).toHaveAttribute('aria-autocomplete', 'list');
    await expect(root).toHaveAttribute('role', 'textbox');
    await page.keyboard.type('@');
    const id = await menu(page).getAttribute('id');
    await expect(menu(page)).toHaveAttribute('role', 'listbox');
    await expect(menu(page)).toHaveAttribute('aria-label', 'People');
    await expect(menu(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(root).toHaveAttribute('aria-haspopup', 'listbox');
    await expect(root).toHaveAttribute('aria-controls', id!);
    const options = menu(page).locator('[role="option"]');
    await expect(options).toHaveCount(3);
    await page.keyboard.press('ArrowDown');
    const active = await root.getAttribute('aria-activedescendant');
    await expect(options.nth(1)).toHaveAttribute('id', active!);
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(options.nth(0)).toHaveAttribute('aria-selected', 'false');
    await page.keyboard.press('Escape');
    for (const name of ['aria-haspopup', 'aria-controls', 'aria-activedescendant']) await expect(root).not.toHaveAttribute(name);
    await expect(root).toHaveAttribute('aria-autocomplete', 'list');
  });

  test('the slash menu is named Commands', async ({ page }) => {
    await page.keyboard.press('Enter');
    await page.keyboard.type('/');
    await expect(page.locator('.mbe-slash-menu')).toHaveAttribute('aria-label', 'Commands');
  });

  test('a popup that appears late takes no keys but Escape for 75 ms', async ({ page }) => {
    await page.evaluate(() => {
      const { Editor, suggestion } = (window as any).core;
      (window as any).editor.destroy();
      (window as any).editor = new Editor({
        element: document.getElementById('editor'),
        extensions: [
          suggestion({
            name: 'late',
            trigger: '@',
            className: 'late-menu',
            items: () => new Promise((resolve) => ((window as any).release = () => resolve([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }]))),
          }),
        ],
      });
    });
    await page.locator('#editor').click();
    await page.keyboard.type('@');
    const taken = await page.evaluate(async () => {
      const key = (k: string) => {
        const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
        document.getElementById('editor')!.dispatchEvent(e);
        return e.defaultPrevented;
      };
      (window as any).release();
      await new Promise((r) => setTimeout(r, 0));
      const early = key('ArrowDown');
      await new Promise((r) => setTimeout(r, 100));
      return [early, key('ArrowDown')];
    });
    expect(taken).toEqual([false, true]);
    await expect(page.locator('.late-menu .mbe-highlighted')).toHaveText('B');
  });
});
