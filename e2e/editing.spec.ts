import { blocks, expect, md, test } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.goto('/?empty');
  await page.locator('#editor').click();
});

test('typing, Enter and Backspace', async ({ page }) => {
  await page.keyboard.type('Hello world');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second');
  expect(await md(page)).toBe('Hello world\n\nSecond\n');

  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Backspace');
  expect(await md(page)).toBe('Hello worldSecond\n');
  await page.keyboard.type(' ');
  expect(await md(page)).toBe('Hello world Second\n');
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

test('Shift+Enter inserts a hard line break', async ({ page }) => {
  await page.keyboard.type('one');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('two');
  // The playground reads single newlines as line breaks, so a line break saves as a plain newline.
  expect(await md(page)).toBe('one\ntwo\n');
  expect(await blocks(page)).toEqual(['p:one\ntwo']);
  // The caret is on the second line: Backspace three times removes "two", once more removes the break.
  for (let i = 0; i < 4; i++) await page.keyboard.press('Backspace');
  expect(await blocks(page)).toEqual(['p:one']);
});

test('"## " shortcut makes a heading; Backspace at its start reverts it', async ({ page }) => {
  await page.keyboard.type('## Title');
  expect(await blocks(page)).toEqual(['h2:Title']);
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
  await page.keyboard.press('Control+z');
  expect(await blocks(page)).toEqual(['h1:']);
  await page.keyboard.press('Control+z');
  expect(await blocks(page)).toEqual(['p:# ']);
  await page.keyboard.press('Control+z');
  expect(await blocks(page)).toEqual(['p:']);
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+Shift+z');
  expect(await md(page)).toBe('# Hi\n');
});

test('lists: shortcuts, Tab nesting, Enter to continue and to exit', async ({ page }) => {
  await page.keyboard.type('- one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter'); // empty nested item: outdent
  await page.keyboard.type('three');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter'); // empty top-level item: end the list
  await page.keyboard.type('after');
  expect(await blocks(page)).toEqual(['ul0:one', 'ul1:two', 'ul0:three', 'p:after']);
  await expect(page.locator('#editor .mbe-list-item')).toHaveCount(3);
});

test('numbered list numbers itself', async ({ page }) => {
  await page.keyboard.type('1. a');
  await page.keyboard.press('Enter');
  await page.keyboard.type('b');
  await page.keyboard.press('Enter');
  await page.keyboard.type('c');
  await expect(page.locator('#editor .mbe-marker')).toHaveText(['1.', '2.', '3.']);
});

test('task list checkbox toggles without moving the caret', async ({ page }) => {
  await page.keyboard.type('[ ] buy milk');
  expect(await blocks(page)).toEqual(['task0[ ]:buy milk']);
  await page.locator('#editor .mbe-checkbox').click();
  expect(await blocks(page)).toEqual(['task0[x]:buy milk']);
  expect(await md(page)).toBe('- [x] buy milk\n');
  await page.keyboard.type('!');
  expect(await blocks(page)).toEqual(['task0[x]:buy milk!']);
});

test('code block: newlines inside, two empty lines exit', async ({ page }) => {
  await page.keyboard.type('```js ');
  await page.keyboard.type('let a = 1;');
  await page.keyboard.press('Enter');
  await page.keyboard.type('a++;');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('after');
  expect(await blocks(page)).toEqual(['code(js):let a = 1;\na++;', 'p:after']);
  expect(await md(page)).toBe('```js\nlet a = 1;\na++;\n```\n\nafter\n');
});

test('"---" makes a divider and Backspace removes it', async ({ page }) => {
  await page.keyboard.type('---');
  await page.keyboard.type('next');
  expect(await blocks(page)).toEqual(['hr', 'p:next']);
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  expect(await blocks(page)).toEqual(['p:next']);
});

test('inline shortcuts', async ({ page }) => {
  await page.keyboard.type('a **bold** and `code` here');
  expect(await md(page)).toBe('a **bold** and `code` here\n');
  await expect(page.locator('#editor strong')).toHaveText('bold');
  await expect(page.locator('#editor code')).toHaveText('code');
});

test('marks: Ctrl+B for the next typed text and for a selection', async ({ page }) => {
  await page.keyboard.type('plain ');
  await page.keyboard.press('Control+b');
  await page.keyboard.type('bold');
  await page.keyboard.press('Control+b');
  await page.keyboard.type(' end');
  expect(await md(page)).toBe('plain **bold** end\n');
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
  await page.keyboard.type('X');
  expect(await md(page)).toBe('X\n');
  await expect(page.locator('#editor > *')).toHaveCount(1);
});

test('Ctrl+Backspace deletes a word', async ({ page }) => {
  await page.keyboard.type('hello brave world');
  await page.keyboard.press('Control+Backspace');
  await expect(page.locator('#editor')).toHaveText('hello brave ');
});

test('emoji Backspace removes the whole grapheme', async ({ page }) => {
  await page.keyboard.type('hi ');
  await page.keyboard.insertText('👍🏽');
  await page.keyboard.press('Backspace');
  expect(await blocks(page)).toEqual(['p:hi ']);
});

test('Ctrl+Enter calls onSubmit', async ({ page }) => {
  await page.keyboard.type('x');
  await page.keyboard.press('Control+Enter');
  await expect(page.locator('body')).toHaveAttribute('data-submitted', '1');
  expect(await md(page)).toBe('x\n');
});

test('read-only mode ignores typing', async ({ page }) => {
  await page.keyboard.type('fixed');
  await page.evaluate(() => (window as any).editor.setOptions({ editable: false }));
  await page.locator('#editor').click();
  await page.keyboard.type('more');
  expect(await md(page)).toBe('fixed\n');
});

test.describe('read-only with task toggling', () => {
  const source = '* [ ] one\n* [X] two\n    * [ ]  nested *x*\n\n[link](https://example.com)\n';

  test.beforeEach(async ({ page }) => {
    await page.evaluate((m) => {
      const editor = (window as any).editor;
      editor.setMarkdown(m);
      (window as any).changes = [];
      editor.on('change', () => (window as any).changes.push(editor.getMarkdown()));
      editor.setOptions({ editable: false, taskToggle: true });
    }, source);
  });

  test('a click ticks a task and changes only its box', async ({ page }) => {
    const root = page.locator('#editor');
    await expect(root).toHaveClass(/mbe-readonly/);
    await expect(root).toHaveClass(/mbe-tasks/);
    await page.locator('#editor .mbe-checkbox').first().click();
    await expect.poll(() => page.evaluate(() => (window as any).changes)).toEqual([
      '* [x] one\n* [X] two\n    * [ ]  nested *x*\n\n[link](https://example.com)\n',
    ]);
    await page.locator('#editor .mbe-checkbox').nth(1).click();
    await expect.poll(md.bind(null, page)).toBe('* [x] one\n* [ ] two\n    * [ ]  nested *x*\n\n[link](https://example.com)\n');
    // The press does not focus the editor or show a caret.
    expect(await page.evaluate(() => (window as any).editor.hasFocus())).toBe(false);
  });

  test('nothing else changes the document', async ({ page }) => {
    await page.locator('#editor .mbe-content').first().click();
    await page.keyboard.type('typed');
    for (const key of ['Backspace', 'Enter', 'Control+b', 'Control+z', 'Control+x']) await page.keyboard.press(key);
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData('text/plain', 'pasted');
      document.querySelector('#editor .mbe-content')!.dispatchEvent((window as any).clipboardEvent('paste', data));
    });
    expect(await page.evaluate(() => (window as any).editor.commands.toggleBold())).toBe(false);
    expect(await md(page)).toBe(source);
    expect(await page.evaluate(() => (window as any).changes)).toEqual([]);
  });

  test('checkboxes are Tab stops with names, and Space ticks them', async ({ page }) => {
    const boxes = page.locator('#editor .mbe-checkbox');
    await expect(boxes.first()).toHaveAttribute('aria-label', 'one');
    await expect(boxes.first()).toBeEnabled();
    await boxes.first().focus();
    await page.keyboard.press('Tab');
    await expect(boxes.nth(1)).toBeFocused();
    await page.keyboard.press('Space');
    await expect.poll(md.bind(null, page)).toBe('* [ ] one\n* [ ] two\n    * [ ]  nested *x*\n\n[link](https://example.com)\n');
    // The re-rendered checkbox keeps focus, so Space ticks it back.
    await expect(boxes.nth(1)).toBeFocused();
    await page.keyboard.press('Space');
    await expect.poll(md.bind(null, page)).toBe(source);
  });

  test('without taskToggle the boxes are disabled; editing restores normal boxes', async ({ page }) => {
    const boxes = page.locator('#editor .mbe-checkbox');
    await page.evaluate(() => (window as any).editor.setOptions({ taskToggle: false }));
    await expect(boxes.first()).toBeDisabled();
    await expect(page.locator('#editor')).not.toHaveClass(/mbe-tasks/);
    await boxes.first().click({ force: true });
    expect(await md(page)).toBe(source);
    await page.evaluate(() => (window as any).editor.setOptions({ editable: true, taskToggle: true }));
    await expect(boxes.first()).toBeEnabled();
    await expect(boxes.first()).toHaveAttribute('tabindex', '-1');
    await expect(boxes.first()).not.toHaveAttribute('aria-label', /.*/);
    await boxes.first().click();
    await expect.poll(md.bind(null, page)).toBe('* [x] one\n* [X] two\n    * [ ]  nested *x*\n\n[link](https://example.com)\n');
  });

  test('ticks are undone after switching back to editing', async ({ page }) => {
    await page.locator('#editor .mbe-checkbox').first().click();
    await page.evaluate(() => (window as any).editor.setOptions({ editable: true }));
    await page.evaluate(() => (window as any).editor.undo());
    expect(await md(page)).toBe(source);
  });
});

test('empty lines are saved as &nbsp; and load back', async ({ page }) => {
  await page.keyboard.type('first');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Enter');
  await page.keyboard.type('second');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  expect(await blocks(page)).toEqual(['p:first', 'p:', 'p:', 'p:second', 'p:', 'p:']);
  // Empty lines at the end are not saved.
  expect(await md(page)).toBe('first\n\n&nbsp;\n\n&nbsp;\n\nsecond\n');
  await page.evaluate((m) => (window as any).editor.setMarkdown(m), await md(page));
  expect(await blocks(page)).toEqual(['p:first', 'p:', 'p:', 'p:second']);
});

test('code block at the end: ArrowDown on the last line leaves it', async ({ page }) => {
  await page.keyboard.type('intro');
  await page.keyboard.press('Enter');
  await page.keyboard.type('```js ');
  await page.keyboard.type('let a = 1;');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('after');
  expect(await blocks(page)).toEqual(['p:intro', 'code(js):let a = 1;', 'p:after']);
  expect(await md(page)).toBe('intro\n\n```js\nlet a = 1;\n```\n\nafter\n');
});

test('code block at the start: ArrowUp adds a paragraph above it', async ({ page }) => {
  await page.evaluate(() => (window as any).editor.setMarkdown('```js\nlet a = 1;\n```\n\nnext\n'));
  await page.locator('#editor .mbe-code [data-content]').click();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.type('before');
  expect(await blocks(page)).toEqual(['p:before', 'code(js):let a = 1;', 'p:next']);
});

test('table at the end: ArrowDown from the last row leaves it', async ({ page }) => {
  await page.evaluate(() => (window as any).editor.setMarkdown('intro\n\n| a | b |\n| - | - |\n| c | d |\n'));
  await page.locator('#editor [data-row="1"][data-col="0"]').click();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('after');
  expect(await blocks(page)).toEqual(['p:intro', 'table:a|b/c|d', 'p:after']);
});

for (const [name, source, last] of [
  ['code block', 'intro\n\n```js\nlet a = 1;\n```\n', 'code(js):let a = 1;'],
  ['table', 'intro\n\n| a | b |\n| - | - |\n| c | d |\n', 'table:a|b/c|d'],
] as const) {
  test(`clicking below a final ${name} adds a paragraph`, async ({ page }) => {
    await page.evaluate((m) => (window as any).editor.setMarkdown(m), source);
    const root = (await page.locator('#editor').boundingBox())!;
    const block = (await page.locator('#editor > *').last().boundingBox())!;
    expect(root.y + root.height - 4).toBeGreaterThan(block.y + block.height);
    await page.mouse.click(root.x + 40, root.y + root.height - 4);
    await page.keyboard.type('after');
    expect(await blocks(page)).toEqual(['p:intro', last, 'p:after']);
  });
}

// Backspace at the start of a block, like Linear: first it becomes a paragraph, then it joins the block above.
for (const [name, source, first] of [
  ['heading', '## Head', 'p:Head'],
  ['bullet item', '- item', 'p:item'],
  ['numbered item', '1. item', 'p:item'],
  ['task item', '- [x] item', 'p:item'],
  ['quote', '> item', 'p:item'],
] as const) {
  test(`Backspace at the start of a ${name} makes it a paragraph, then joins it to the block above`, async ({ page }) => {
    await page.evaluate((m) => (window as any).editor.setMarkdown(m), `above\n\n${source}\n`);
    await page.locator('#editor > *').last().click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Backspace');
    expect(await blocks(page)).toEqual(['p:above', first]);
    await page.keyboard.press('Backspace');
    expect(await blocks(page)).toEqual([`p:above${first.slice(2)}`]);
    // The caret is at the join.
    await page.keyboard.type('|');
    expect(await blocks(page)).toEqual([`p:above|${first.slice(2)}`]);
  });
}

test('Backspace at the start of a nested item outdents it first', async ({ page }) => {
  await page.evaluate(() => (window as any).editor.setMarkdown('- a\n  - b\n'));
  await page.locator('#editor .mbe-list-item').last().click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Backspace');
  expect(await blocks(page)).toEqual(['ul0:a', 'ul0:b']);
});

// Enter at the end of a block: a heading is followed by a paragraph; lists and quotes continue.
for (const [name, source, after] of [
  ['heading', '# Head', ['h1:Head', 'p:next']],
  ['quote', '> quote', ['quote:quote', 'quote:next']],
  ['task item', '- [x] done', ['task0[x]:done', 'task0[ ]:next']],
  ['numbered item', '1. one', ['ol0:one', 'ol0:next']],
] as const) {
  test(`Enter at the end of a ${name}`, async ({ page }) => {
    await page.evaluate((m) => (window as any).editor.setMarkdown(m), `${source}\n`);
    await page.locator('#editor > *').first().click();
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('next');
    expect(await blocks(page)).toEqual(after);
  });
}

test('Enter at the start of a heading adds an empty paragraph above and keeps the heading', async ({ page }) => {
  await page.evaluate(() => (window as any).editor.setMarkdown('# Head\n'));
  await page.locator('#editor h1').click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  expect(await blocks(page)).toEqual(['p:', 'h1:Head']);
  await page.keyboard.type('x');
  expect(await blocks(page)).toEqual(['p:', 'h1:xHead']);
});

test('Enter in an empty quote ends the quote', async ({ page }) => {
  await page.keyboard.type('> said');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('after');
  expect(await blocks(page)).toEqual(['quote:said', 'p:after']);
});

test('Backspace in an empty code block makes it a paragraph', async ({ page }) => {
  await page.keyboard.type('```js ');
  await page.keyboard.press('Backspace');
  expect(await blocks(page)).toEqual(['p:']);
});

test('Tab in a code block inserts two spaces, indents selected lines, and Shift+Tab outdents', async ({ page }) => {
  await page.keyboard.type('```js ');
  await page.keyboard.type('if (a) {');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('b();');
  await page.keyboard.press('Enter');
  await page.keyboard.type('}');
  expect(await blocks(page)).toEqual(['code(js):if (a) {\n  b();\n}']);
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Tab');
  expect(await blocks(page)).toEqual(['code(js):  if (a) {\n    b();\n  }']);
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  expect(await blocks(page)).toEqual(['code(js):if (a) {\nb();\n}']);
  // Focus never leaves the editor.
  expect(await page.evaluate(() => (window as any).editor.hasFocus())).toBe(true);
});

test('Ctrl+A in a table cell or code block selects its text first, then the whole document', async ({ page }) => {
  const selected = () => page.evaluate(() => document.getSelection()!.toString());
  await page.evaluate(() => (window as any).editor.setMarkdown('```js\nlet a;\n```\n\nmiddle\n\n| a | b |\n| - | - |\n| cell | d |\n'));
  await page.locator('#editor td').first().click();
  await page.keyboard.press('Control+a');
  expect(await selected()).toBe('cell');
  await page.keyboard.type('X');
  expect(await blocks(page)).toEqual(['code(js):let a;', 'p:middle', 'table:a|b/X|d']);
  await page.locator('#editor .mbe-code [data-content]').click();
  await page.keyboard.press('Control+a');
  expect(await selected()).toBe('let a;');
  // The browser's own select-all selects nothing when the document starts with a code block.
  await page.keyboard.press('Control+a');
  const all = await page.evaluate(() => (window as any).editor.getSelection());
  const ids = await page.evaluate(() => (window as any).editor.state.doc.blocks.map((b: any) => b.id));
  expect(all.anchor).toEqual({ blockId: ids[0], offset: 0 });
  expect(all.focus.blockId).toBe(ids[2]);
  await page.keyboard.press('Delete');
  expect(await md(page)).toBe('```js\n```\n');
});

test('a nested item whose parent stops being a list item moves out with it, as it saves', async ({ page }) => {
  await page.keyboard.type('- parent');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('child');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await page.keyboard.type('grandchild');
  expect(await blocks(page)).toEqual(['ul0:parent', 'ul1:child', 'ul2:grandchild']);
  await page.locator('#editor .mbe-list-item').first().click();
  await page.keyboard.press('Control+Alt+0');
  expect(await blocks(page)).toEqual(['p:parent', 'ul0:child', 'ul1:grandchild']);
  expect(await md(page)).toBe('parent\n\n- child\n  - grandchild\n');
  // Undo puts the parent and its nesting back in one step.
  await page.keyboard.press('Control+z');
  expect(await blocks(page)).toEqual(['ul0:parent', 'ul1:child', 'ul2:grandchild']);
});
