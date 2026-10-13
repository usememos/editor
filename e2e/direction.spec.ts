// Right-to-left text: each text block and table cell takes its direction
// from its first strong character (dir="auto").

import { expect, test } from '@playwright/test';

const DOC = 'שלום עולם\n\nHello world\n\n- פריט\n- item\n\n| א | b |\n| - | - |\n| ג | d |\n';

test('blocks and table cells pick their direction from their text', async ({ page }) => {
  await page.goto(`/?md=${encodeURIComponent(DOC)}`);
  const direction = (selector: string) => page.locator(`#editor ${selector}`).evaluateAll((els) => els.map((el) => getComputedStyle(el).direction));
  expect(await direction('> p')).toEqual(['rtl', 'ltr']);
  expect(await direction('> .mbe-list-item')).toEqual(['rtl', 'ltr']);
  expect(await direction('td, th')).toEqual(['rtl', 'ltr', 'rtl', 'ltr']);
  // An RTL list item puts its marker on the right.
  const [marker, content] = await page.locator('#editor > .mbe-list-item').first().evaluate((el) => [
    el.querySelector('.mbe-marker')!.getBoundingClientRect().left,
    el.querySelector('.mbe-content')!.getBoundingClientRect().left,
  ]);
  expect(marker).toBeGreaterThan(content);
});

test('typing Hebrew into an empty paragraph turns it right to left', async ({ page }) => {
  await page.goto(`/?md=${encodeURIComponent('Hello\n')}`);
  await page.locator('#editor p').click();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('שלום');
  expect(await page.locator('#editor > p').evaluateAll((els) => els.map((el) => getComputedStyle(el).direction))).toEqual(['ltr', 'rtl']);
});
