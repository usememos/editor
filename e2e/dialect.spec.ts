import { expect, md, test } from './helpers';

const open = (page: import('@playwright/test').Page, markdown: string) =>
  page.goto(`/?md=${encodeURIComponent(markdown)}`);

test('line-break dialect: an untouched note saves byte for byte', async ({ page }) => {
  const note = '* one\n* two\nline one\nline two\n\n$$\n\\int x\\,dx\n$$\n\n> - quoted list\n\n> # quoted heading\n\nText[^1]\n\n[^1]: note';
  await open(page, note);
  expect(await md(page)).toBe(note);
  await expect(page.locator('#editor > .mbe-raw[data-syntax="math"]')).toHaveCount(1);
  await expect(page.locator('#editor > .mbe-raw[data-syntax="markdown"]')).toHaveCount(1);
  await expect(page.locator('#editor .mbe-footnote-ref')).toHaveText('1');
});

test('line-break dialect: editing one block leaves the others as they were', async ({ page }) => {
  await open(page, '* one\n* two\n\n\nlast');
  await page.locator('#editor p').click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  expect(await md(page)).toBe('* one\n* two\n\n\nlast!');
});

test('line-break dialect: typed math becomes a formula and keeps its source, typing prices escapes them', async ({ page }) => {
  await page.goto('/?empty');
  await page.locator('#editor').click();
  await page.keyboard.type('a $x\\{y\\}$');
  // The caret touches the token, so it shows as source; moving on renders it.
  await expect(page.locator('#editor .mbe-token-math')).toHaveText('$x\\{y\\}$');
  await page.keyboard.type(' b');
  await expect(page.locator('#editor .mbe-view-math .katex')).toHaveCount(1);
  await expect(page.locator('#editor .mbe-view-math')).toHaveAttribute('data-source', '$x\\{y\\}$');
  await page.keyboard.press('Enter');
  await page.keyboard.type('costs $5');
  expect(await md(page)).toBe('a $x\\{y\\}$ b\n\ncosts \\$5\n');
});

test('line-break dialect: Shift+Enter is saved as a plain newline', async ({ page }) => {
  await page.goto('/?empty');
  await page.locator('#editor').click();
  await page.keyboard.type('one');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('two');
  expect(await md(page)).toBe('one\ntwo\n');
});
