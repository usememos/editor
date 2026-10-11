import { expect, test } from '@playwright/test';
import { md } from './helpers';

const open = (page: import('@playwright/test').Page, markdown: string) =>
  page.goto(`/?dialect=memos&md=${encodeURIComponent(markdown)}`);

test('memos dialect: an untouched memo saves byte for byte', async ({ page }) => {
  const memo = '* one\n* two\nline one\nline two\n\n$$\n\\int x\\,dx\n$$\n\n> - quoted list\n\nText[^1]\n\n[^1]: note';
  await open(page, memo);
  expect(await md(page)).toBe(memo);
  await expect(page.locator('#editor > .mbe-raw[data-syntax="math"]')).toHaveCount(1);
  await expect(page.locator('#editor > .mbe-raw[data-syntax="markdown"]')).toHaveCount(1);
  await expect(page.locator('#editor .mbe-token-footnote')).toHaveText('[^1]');
});

test('memos dialect: editing one block leaves the others as they were', async ({ page }) => {
  await open(page, '* one\n* two\n\n\nlast');
  await page.locator('#editor p').click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  expect(await md(page)).toBe('* one\n* two\n\n\nlast!');
});

test('memos dialect: typing math keeps it as source, typing prices escapes them', async ({ page }) => {
  await page.goto('/?dialect=memos&empty');
  await page.locator('#editor').click();
  await page.keyboard.type('a $x\\{y\\}$ b');
  await expect(page.locator('#editor .mbe-token-math')).toHaveText('$x\\{y\\}$');
  await page.keyboard.press('Enter');
  await page.keyboard.type('costs $5');
  expect(await md(page)).toBe('a $x\\{y\\}$ b\n\ncosts \\$5\n');
});

test('memos dialect: Shift+Enter is saved as a plain newline', async ({ page }) => {
  await page.goto('/?dialect=memos&empty');
  await page.locator('#editor').click();
  await page.keyboard.type('one');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('two');
  expect(await md(page)).toBe('one\ntwo\n');
});
