import { expect, test } from '@playwright/test';
import { blocks, md } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/?empty');
  await page.locator('#editor').click();
});

async function paste(page: import('@playwright/test').Page, data: Record<string, string>) {
  await page.evaluate((d) => {
    const dt = new DataTransfer();
    for (const [k, v] of Object.entries(d)) dt.setData(k, v);
    document.getElementById('editor')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, data);
}

test('pasting Markdown inserts blocks', async ({ page }) => {
  await page.keyboard.type('ab');
  await page.keyboard.press('ArrowLeft');
  await paste(page, { 'text/plain': 'one\n\n## two\n\n**three**' });
  expect(await md(page)).toBe('aone\n\n## two\n\n**three**b\n');
  await page.keyboard.type('!');
  // "**three!**b" would not parse as bold (a closing "**" after punctuation must not touch a letter),
  // so the serializer writes the letter as a character reference.
  expect(await md(page)).toBe('aone\n\n## two\n\n**three!**&#98;\n');
  expect(await blocks(page)).toEqual(['p:aone', 'h2:two', 'p:three!b']);
});

test('pasting HTML from a web page', async ({ page }) => {
  await paste(page, {
    'text/plain': 'Title Some bold text one two',
    'text/html': '<h1>Title</h1><p>Some <b>bold</b> text</p><ul><li>one</li><li>two</li></ul>',
  });
  expect(await blocks(page)).toEqual(['h1:Title', 'p:Some bold text', 'ul0:one', 'ul0:two']);
  expect(await md(page)).toBe('# Title\n\nSome **bold** text\n\n- one\n- two\n');
});

test('pasting from Google Docs keeps bold set by styles, not the wrapper', async ({ page }) => {
  const html =
    '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1234"><p dir="ltr"><span style="font-weight:400">Hello </span><span style="font-weight:700">world</span></p></b>';
  await paste(page, { 'text/plain': 'Hello world', 'text/html': html });
  expect(await md(page)).toBe('Hello **world**\n');
});

test('Ctrl+Shift+V pastes plain text without parsing Markdown', async ({ page }) => {
  // Simulate the keystroke without triggering the browser's own paste, then the paste event.
  await page.evaluate(() =>
    document.getElementById('editor')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'V', ctrlKey: true, metaKey: true, shiftKey: true, bubbles: true })),
  );
  await paste(page, { 'text/plain': '# not a heading' });
  expect(await blocks(page)).toEqual(['p:# not a heading']);
});

test('copy then paste inside the editor round-trips through Markdown', async ({ page }) => {
  await page.keyboard.type('## Head');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- item');
  await page.keyboard.press('Control+a');
  const data = await page.evaluate(() => {
    const dt = new DataTransfer();
    document.getElementById('editor')!.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true }));
    return { 'text/plain': dt.getData('text/plain'), 'text/html': dt.getData('text/html') };
  });
  expect(data['text/plain']).toBe('## Head\n\n- item');
  expect(data['text/html']).toContain('<h2>');
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await paste(page, data);
  expect(await blocks(page)).toEqual(['h2:Head', 'ul0:item', 'h2:Head', 'ul0:item']);
});

test('undo after paste removes the whole paste', async ({ page }) => {
  await page.keyboard.type('x');
  await paste(page, { 'text/plain': 'a\n\nb\n\nc' });
  await page.keyboard.press('Control+z');
  expect(await blocks(page)).toEqual(['p:x']);
});
