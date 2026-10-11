// Extension hooks and the default key bindings.

import { expect, test } from '@playwright/test';
import { blocks, md } from './helpers';

test('default keys: block types, strikethrough, and Escape blurs', async ({ page }) => {
  await page.goto('/?empty');
  await page.locator('#editor').click();
  await page.keyboard.type('title');
  await page.keyboard.press('Control+Alt+2');
  await page.keyboard.press('Enter');
  await page.keyboard.type('item');
  await page.keyboard.press('Control+Shift+8');
  await page.keyboard.press('Enter');
  await page.keyboard.type('todo');
  await page.keyboard.press('Control+Shift+9');
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('Control+Shift+S');
  expect(await blocks(page)).toEqual(['h2:title', 'ul0:item', 'task0[ ]:todo']);
  expect(await md(page)).toBe('## title\n\n- item\n- [ ] ~~todo~~\n');
  await page.keyboard.press('Escape'); // closes the toolbar
  await page.keyboard.press('Escape'); // blurs
  expect(await page.evaluate(() => (window as any).editor.hasFocus())).toBe(false);
});

test('an extension keymap overrides a default key; onCreate cleanup runs on destroy', async ({ page }) => {
  await page.goto('/?empty');
  await page.evaluate(() => {
    const { Editor } = (window as any).core;
    (window as any).editor.destroy();
    const log: string[] = ((window as any).log = []);
    (window as any).editor = new Editor({
      element: document.getElementById('editor'),
      extensions: [
        {
          name: 'custom',
          keymap: { 'Mod-b': () => (log.push('custom bold'), true) },
          onCreate: () => {
            log.push('created');
            return () => log.push('destroyed');
          },
        },
      ],
    });
  });
  await page.locator('#editor').click();
  await page.keyboard.type('x');
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('Control+b');
  await page.keyboard.press('Control+i');
  expect(await md(page)).toBe('*x*\n');
  await page.evaluate(() => (window as any).editor.destroy());
  expect(await page.evaluate(() => (window as any).log)).toEqual(['created', 'custom bold', 'destroyed']);
});

test('handlePaste can take over a paste; dropped text lands at the drop point', async ({ page }) => {
  await page.goto('/?md=hello%20world');
  await page.evaluate(() => {
    const { Editor } = (window as any).core;
    (window as any).editor.destroy();
    const pasted: string[] = ((window as any).pasted = []);
    (window as any).editor = new Editor({
      element: document.getElementById('editor'),
      content: 'hello world',
      extensions: [
        {
          name: 'files',
          handlePaste: ({ event }: { event: ClipboardEvent }) => {
            const text = event.clipboardData?.getData('text/plain') ?? '';
            if (!text.startsWith('FILE:')) return false;
            pasted.push(text);
            return true;
          },
        },
      ],
    });
  });
  const paste = (text: string) =>
    page.evaluate((text) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      document.querySelector('#editor p')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);
  await page.locator('#editor').click();
  await page.keyboard.press('End');
  await paste('FILE:a.png');
  await paste('!');
  expect(await md(page)).toBe('hello world!');
  expect(await page.evaluate(() => (window as any).pasted)).toEqual(['FILE:a.png']);

  const box = await page.locator('#editor p').boundingBox();
  await page.evaluate(
    ({ x, y }) => {
      const data = new DataTransfer();
      data.setData('text/plain', '*X*');
      const p = document.querySelector('#editor p')!;
      p.dispatchEvent(new DragEvent('drop', { dataTransfer: data, clientX: x, clientY: y, bubbles: true, cancelable: true }));
    },
    { x: box!.x + 1, y: box!.y + box!.height / 2 },
  );
  expect(await md(page)).toBe('*X*hello world!');
});

test('textDecorator highlights while typing and never reaches the saved Markdown', async ({ page }) => {
  await page.goto('/?empty');
  await page.evaluate(() => {
    const { Editor, textDecorator } = (window as any).core;
    (window as any).editor.destroy();
    (window as any).editor = new Editor({
      element: document.getElementById('editor'),
      extensions: [textDecorator({ pattern: /#[\w/]+/, class: 'tag', attributes: { 'data-kind': 'tag' } })],
    });
  });
  await page.locator('#editor').click();
  await page.keyboard.type('see #work and `#no` and #a/b');
  await expect(page.locator('#editor .tag')).toHaveText(['#work', '#a/b']);
  await expect(page.locator('#editor .tag').first()).toHaveAttribute('data-kind', 'tag');
  // Typing inside a decorated range works and the caret stays put.
  await page.keyboard.press('Home');
  for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowRight');
  await page.keyboard.type('-x');
  // "-" is not part of a tag, so the tag still ends after "#work".
  await expect(page.locator('#editor .tag')).toHaveText(['#work', '#a/b']);
  expect(await md(page)).toBe('see #work-x and `#no` and #a/b\n');
});

test('suggestion: #tag autocomplete with async items, picked with the keyboard', async ({ page }) => {
  await page.goto('/?empty');
  await page.evaluate(() => {
    const { Editor, suggestion } = (window as any).core;
    (window as any).editor.destroy();
    const tags = ['work', 'work/project', 'reading'];
    (window as any).editor = new Editor({
      element: document.getElementById('editor'),
      extensions: [
        suggestion({
          name: 'tags',
          char: '#',
          className: 'tag-menu',
          items: async ({ query }: { query: string }) => {
            await new Promise((r) => setTimeout(r, 20));
            return tags.filter((t) => t.startsWith(query)).map((t) => ({ label: `#${t}`, id: t }));
          },
          command: ({ editor, range, item }: any) => editor.commands.insertText(`#${item.id} `, { range }),
        }),
      ],
    });
  });
  const menu = page.locator('.tag-menu');
  await page.locator('#editor').click();
  await page.keyboard.type('a#b ');
  await expect(menu).toBeHidden(); // not inside a word
  await page.keyboard.type('#wo');
  await expect(menu.locator('.mbe-menu-item')).toHaveText([/#work$/, /#work\/project/]);
  await page.keyboard.type('x');
  await expect(menu).toBeHidden(); // no matches
  await page.keyboard.press('Backspace');
  await expect(menu).toBeVisible(); // matches again
  await expect(menu.locator('.mbe-menu-item')).toHaveCount(2);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  await page.keyboard.type('done');
  expect(await md(page)).toBe('a#b #work/project done\n');
  // One undo step removes the picked tag and restores the query.
  await page.keyboard.press('Control+z'); // typing "done"
  await page.keyboard.press('Control+z');
  expect(await md(page)).toBe('a#b #wo\n');
  await page.keyboard.type(' #');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.mbe-menu-item')).toHaveCount(3);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
});

test('widgets: shown after their block, never saved, moved when their block is deleted, replaced by Markdown', async ({ page }) => {
  await page.goto('/?md=' + encodeURIComponent('one\n\ntwo\n\nthree'));
  await page.evaluate(() => {
    const editor = (window as any).editor;
    const two = editor.state.doc.blocks[1];
    (window as any).widget = editor.addWidget({
      at: { blockId: two.id, offset: 1 },
      render: (el: HTMLElement) => {
        el.innerHTML = '<span class="upload">Uploading…</span> <button>Retry</button>';
      },
    });
  });
  const children = () => page.locator('#editor').evaluate((root) => Array.from(root.children).map((c) => c.textContent));
  expect(await children()).toEqual(['one', 'two', 'Uploading… Retry', 'three']);
  expect(await md(page)).toBe('one\n\ntwo\n\nthree');

  // Typing in other blocks keeps the widget in place; clicking its button does not edit.
  await page.locator('#editor p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  await page.locator('#editor .mbe-widget button').click();
  expect(await children()).toEqual(['one!', 'two', 'Uploading… Retry', 'three']);

  // Deleting its block moves it to the block before.
  await page.evaluate(() => {
    const editor = (window as any).editor;
    editor.setSelection({ anchor: { block: 0, offset: 4 }, focus: { block: 1, offset: 3 } });
    editor.commands.insertText('');
  });
  expect(await children()).toEqual(['one!', 'Uploading… Retry', 'three']);

  // The upload finishes: insert the image where the widget is, then remove it.
  await page.evaluate(() => {
    const { editor, widget } = window as any;
    widget.update((el: HTMLElement) => void (el.textContent = 'Done'));
    editor.commands.insertMarkdown('![photo](/file/a.png)', { at: widget });
    widget.remove();
  });
  expect(await md(page)).toBe('one!\n\n![photo](/file/a.png)\n\nthree');
  await expect(page.locator('#editor .mbe-widget')).toHaveCount(0);
});

test('fileHandler: pasted and dropped files reach the app; text paste still works', async ({ page }) => {
  await page.goto('/?md=hello');
  await page.evaluate(() => {
    const { Editor, fileHandler } = (window as any).core;
    (window as any).editor.destroy();
    const log: string[] = ((window as any).log = []);
    (window as any).editor = new Editor({
      element: document.getElementById('editor'),
      content: 'hello',
      extensions: [
        fileHandler({
          accept: ['image/*'],
          onPaste: ({ files }: { files: File[] }) => log.push(`paste ${files.map((f) => f.name).join(',')}`),
          onDrop: ({ files, position }: { files: File[]; position: any }) =>
            log.push(`drop ${files.map((f) => f.name).join(',')} at ${position?.offset}`),
        }),
      ],
    });
  });
  const send = (type: 'paste' | 'drop', items: { file?: string; mime?: string; text?: string }[], point?: { x: number; y: number }) =>
    page.evaluate(
      ({ type, items, point }) => {
        const data = new DataTransfer();
        for (const it of items) {
          if (it.file) data.items.add(new File(['x'], it.file, { type: it.mime }));
          if (it.text) data.setData('text/plain', it.text);
        }
        const target = document.querySelector('#editor p')!;
        const event =
          type === 'paste'
            ? new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
            : new DragEvent('drop', { dataTransfer: data, clientX: point!.x, clientY: point!.y, bubbles: true, cancelable: true });
        target.dispatchEvent(event);
      },
      { type, items, point },
    );
  await page.locator('#editor').click();
  await page.keyboard.press('End');
  await send('paste', [{ file: 'shot.png', mime: 'image/png' }, { file: 'notes.pdf', mime: 'application/pdf' }]);
  await send('paste', [{ file: 'copied.png', mime: 'image/png', text: '!' }]);
  const box = await page.locator('#editor p').boundingBox();
  await send('drop', [{ file: 'drop.jpg', mime: 'image/jpeg' }], { x: box!.x + 1, y: box!.y + box!.height / 2 });
  expect(await page.evaluate(() => (window as any).log)).toEqual(['paste shot.png', 'drop drop.jpg at 0']);
  expect(await md(page)).toBe('hello!');
});
