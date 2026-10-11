import { type Page, expect, test } from '@playwright/test';

const md = (page: Page) => page.evaluate(() => (window as any).editor.getMarkdown() as string);
const blocks = (page: Page) =>
  page.evaluate(() => (window as any).editor.getDoc().blocks.map((b: any) => b.type === 'heading' ? `h${b.level}` : 'p'));

test.beforeEach(async ({ page }) => {
  await page.goto('/?empty');
  await page.locator('#editor').click();
});

test('typing, Enter and Backspace', async ({ page }) => {
  await page.keyboard.type('Hello world');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second');
  expect(await md(page)).toBe('Hello world\n\nSecond\n');

  // Backspace at the start of the second block merges it into the first.
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Backspace');
  expect(await md(page)).toBe('Hello worldSecond\n');

  // Typing continues at the merge point.
  await page.keyboard.type(' ');
  expect(await md(page)).toBe('Hello world Second\n');
  // The DOM matches the model: one block, same text.
  await expect(page.locator('#editor > *')).toHaveCount(1);
  await expect(page.locator('#editor')).toHaveText('Hello world Second');
});

test('Enter in the middle of a block, then Delete joins it back', async ({ page }) => {
  await page.keyboard.type('abcdef');
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  expect(await md(page)).toBe('abc\n\ndef\n');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Delete');
  expect(await md(page)).toBe('abcdef\n');
});

test('"## " shortcut makes a heading; Backspace at its start reverts it', async ({ page }) => {
  await page.keyboard.type('## Title');
  expect(await blocks(page)).toEqual(['h2']);
  await expect(page.locator('#editor h2')).toHaveText('Title');
  await page.keyboard.press('Enter');
  await page.keyboard.type('body');
  expect(await md(page)).toBe('## Title\n\nbody\n');

  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  expect(await md(page)).toBe('Title\n\nbody\n');
});

test('undo reverts the typing, then the heading shortcut, then the "#"', async ({ page }) => {
  await page.keyboard.type('# Hi');
  expect(await md(page)).toBe('# Hi\n');
  await page.keyboard.press('Control+z');
  expect(await md(page)).toBe('#\n');
  await page.keyboard.press('Control+z');
  expect(await md(page)).toBe('\\# \n');
  await page.keyboard.press('Control+z');
  expect(await md(page)).toBe('');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+Shift+z');
  expect(await md(page)).toBe('# Hi\n');
});

test('marks: Ctrl+B toggles for the next typed text and for a selection', async ({ page }) => {
  await page.keyboard.type('plain ');
  await page.keyboard.press('Control+b');
  await page.keyboard.type('bold');
  await page.keyboard.press('Control+b');
  await page.keyboard.type(' end');
  expect(await md(page)).toBe('plain **bold** end\n');
  await expect(page.locator('#editor strong')).toHaveText('bold');

  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.keyboard.press('Control+i');
  expect(await md(page)).toBe('*plain **bold** end*\n');
});

test('typing over a selection that spans blocks', async ({ page }) => {
  await page.keyboard.type('one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await page.keyboard.press('Enter');
  await page.keyboard.type('three');
  await page.keyboard.press('Control+a');
  // Ctrl+A in a contentEditable root selects all its content.
  await page.keyboard.type('X');
  expect(await md(page)).toBe('X\n');
  await expect(page.locator('#editor > *')).toHaveCount(1);
});

test('Ctrl+Backspace deletes a word', async ({ page }) => {
  await page.keyboard.type('hello brave world');
  await page.keyboard.press('Control+Backspace');
  // Chrome's word deletion keeps the space before the word.
  await expect(page.locator('#editor')).toHaveText('hello brave ');
  expect(await page.evaluate(() => (window as any).editor.getDoc().blocks[0].content[0].text)).toBe('hello brave ');
});

test('pasting Markdown inserts blocks', async ({ page }) => {
  await page.keyboard.type('ab');
  await page.keyboard.press('ArrowLeft');
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', 'one\n\n## two\n\n**three**');
    document.getElementById('editor')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  expect(await md(page)).toBe('aone\n\n## two\n\n**three**b\n');
  await page.keyboard.type('!');
  expect(await md(page)).toBe('aone\n\n## two\n\n**three!**b\n');
});

test('IME composition is applied to the model on compositionend', async ({ page }) => {
  await page.keyboard.type('Say ');
  const cdp = await page.context().newCDPSession(page);
  // Simulates a Japanese IME: intermediate composition text, then the commit.
  await cdp.send('Input.imeSetComposition', { text: 'k', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.imeSetComposition', { text: 'こ', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.imeSetComposition', { text: 'こんにちは', selectionStart: 5, selectionEnd: 5 });
  await cdp.send('Input.insertText', { text: 'こんにちは' });
  expect(await md(page)).toBe('Say こんにちは\n');
  await page.keyboard.type('!');
  expect(await md(page)).toBe('Say こんにちは!\n');
  // Undo removes the composed text as one step.
  await page.keyboard.press('Control+z');
  expect(await md(page)).toBe('Say こんにちは\n');
});

test('IME composition inside bold text keeps the mark', async ({ page }) => {
  await page.keyboard.press('Control+b');
  await page.keyboard.type('ab');
  await page.keyboard.press('ArrowLeft');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.insertText', { text: '한' });
  expect(await md(page)).toBe('**a한b**\n');
});

test('IME composition over a selection spanning blocks', async ({ page }) => {
  await page.keyboard.type('one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await page.keyboard.press('Shift+ArrowUp');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '中', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.insertText', { text: '中' });
  expect(await md(page)).toBe('one中\n');
  await expect(page.locator('#editor > *')).toHaveCount(1);
});

test('emoji Backspace removes the whole grapheme', async ({ page }) => {
  await page.keyboard.type('hi ');
  await page.keyboard.insertText('👍🏽');
  await page.keyboard.press('Backspace');
  expect(await page.evaluate(() => (window as any).editor.getDoc().blocks[0].content[0]?.text)).toBe('hi ');
});
