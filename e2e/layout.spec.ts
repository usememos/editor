// Layout and readability checks a person would otherwise make by eye: nothing
// pushes the page sideways on a phone, and text is readable in light and dark.

import { SAMPLE } from '../playground/sample';
import { expect, type Page, test } from './helpers';

const WIDE = [
  SAMPLE,
  'A long link: https://example.com/a/very/long/path/that/does/not/break/anywhere/at/all/because/it/has/no/spaces/in/it',
  '```\nconst aVeryLongLineOfCodeThatDoesNotWrap = someFunction(withArguments, andMoreArguments, andEvenMoreArguments);\n```',
  '| one | two | three | four | five | six | seven |\n| - | - | - | - | - | - | - |\n| a long cell value | another long cell value | more | more | more | more | more |',
  '#a_really_long_tag_without_any_break_points_at_all_anywhere_in_it and supercalifragilisticexpialidocious_and_more_letters',
].join('\n\n');

// Text widths depend on the font, so this also runs with a wide one.
for (const font of ['', 'DejaVu Sans']) {
  test(`on a phone, nothing makes the page scroll sideways; wide code and tables scroll inside themselves${font ? ` (${font})` : ''}`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 700 });
    await page.goto(`/?md=${encodeURIComponent(WIDE)}`);
    if (font) await page.addStyleTag({ content: `* { font-family: "${font}" !important; }` });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const editor = await page.locator('#editor').boundingBox();
    // Every block fits the editor's width.
    const wider = await page.evaluate((right) => {
      return Array.from(document.querySelectorAll('#editor > .mbe-block'))
        .filter((el) => el.getBoundingClientRect().right > right + 1)
        .map((el) => el.className);
    }, editor!.x + editor!.width);
    expect(wider).toEqual([]);
    // The editor itself does not scroll sideways.
    expect(await page.locator('#editor').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
  });
}

/** WCAG contrast ratio between an element's text color and the first opaque background behind it. */
const contrast = (page: Page, selector: string) =>
  page.evaluate((selector) => {
    const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
    const rgba = (color: string) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data);
    };
    const lum = ([r, g, b]: number[]) =>
      [r!, g!, b!]
        .map((v) => v / 255)
        .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
        .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
    const el = document.querySelector(selector);
    if (!el) return null;
    const fg = rgba(getComputedStyle(el).color);
    let bg = [255, 255, 255, 0];
    for (let n: Element | null = el; n; n = n.parentElement) {
      const c = rgba(getComputedStyle(n).backgroundColor);
      if (c[3]! > 200) {
        bg = c;
        break;
      }
    }
    if (bg[3] === 0) bg = rgba(getComputedStyle(document.body).backgroundColor);
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x);
    return (a! + 0.05) / (b! + 0.05);
  }, selector);

for (const scheme of ['light', 'dark'] as const) {
  test(`${scheme} mode: text, code, tables, menus and the toolbar are readable`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(`/?md=${encodeURIComponent(SAMPLE)}`);
    // WCAG AA: 4.5:1 for body text.
    const checks: [string, number][] = [
      ['#editor p', 4.5],
      ['#editor h2', 4.5],
      ['#editor .mbe-list-item [data-content]', 4.5],
      ['#editor blockquote', 4.5],
      ['#editor .mbe-code code', 4.5],
      ['#editor th', 4.5],
      ['#editor td', 4.5],
      ['#editor a.mbe-link', 4.5],
      ['#editor .mbe-marker', 3],
    ];
    for (const [selector, min] of checks) expect(await contrast(page, selector), `${selector} in ${scheme} mode`).toBeGreaterThanOrEqual(min);

    await page.locator('#editor p').first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' /');
    expect(await contrast(page, '.mbe-slash-menu .mbe-menu-item:not(.mbe-highlighted)'), 'slash menu item').toBeGreaterThanOrEqual(4.5);
    expect(await contrast(page, '.mbe-slash-menu .mbe-highlighted'), 'highlighted slash menu item').toBeGreaterThanOrEqual(4.5);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Shift+Home');
    await expect(page.locator('.mbe-toolbar')).toBeVisible();
    expect(await contrast(page, '.mbe-toolbar button'), 'toolbar button').toBeGreaterThanOrEqual(4.5);
  });
}
