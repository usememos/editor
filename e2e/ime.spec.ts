import { type Page, expect, test } from '@playwright/test';
import { blocks, md } from './helpers';

// Input methods are simulated two ways:
// - In Chromium, through the Chrome DevTools Protocol, the way an input method
//   drives the browser: the browser edits the DOM and sends its own events.
// - In every browser, by events: the test edits the DOM the way an input method
//   does and sends the events in the order each browser sends them.
// Input that only mobile keyboards send (input that cannot be cancelled,
// autocorrect replacements) is dispatched as events.
// What still needs a real device is listed in docs/ime-checklist.md.

test.beforeEach(async ({ page }) => {
  await page.goto('/?empty');
  await page.locator('#editor').click();
});

// IME input goes through a separate DevTools session, which is not ordered
// with Playwright's own keyboard events. Wait for a rendered frame before each
// step so earlier key presses have been handled, as they would be with a person typing.
async function frame(page: Page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
}

async function compose(page: Page, steps: string[], commit: string) {
  const ime = await startComposing(page, steps);
  await ime.commit(commit);
}

/** Starts a composition and leaves it open, as while the user picks a candidate. */
async function startComposing(page: Page, steps: string[]) {
  const cdp = await page.context().newCDPSession(page);
  const update = async (text: string) => {
    await frame(page);
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    await frame(page);
  };
  for (const text of steps) await update(text);
  return {
    update,
    commit: async (text: string) => {
      await frame(page);
      await cdp.send('Input.insertText', { text });
      await frame(page);
    },
    /** A key the input method consumes: keydown arrives with keyCode 229 and does nothing else. */
    imeKey: async (key: string) => {
      await frame(page);
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: 229 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: 229 });
    },
  };
}

test.describe('input method through the DevTools Protocol', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium only');

  test('a composition is one undo step', async ({ page }) => {
    await page.keyboard.type('Say ');
    await compose(page, ['k', 'こ', 'こんにちは'], 'こんにちは');
    expect(await md(page)).toBe('Say こんにちは\n');
    await page.keyboard.type('!');
    await page.keyboard.press('Control+z');
    expect(await md(page)).toBe('Say こんにちは\n');
  });

  test('composition inside bold text keeps the mark', async ({ page }) => {
    await page.keyboard.press('Control+b');
    await page.keyboard.type('ab');
    await page.keyboard.press('ArrowLeft');
    await compose(page, ['한'], '한');
    expect(await md(page)).toBe('**a한b**\n');
  });

  test('composition over a selection spanning blocks', async ({ page }) => {
    await page.keyboard.type('one');
    await page.keyboard.press('Enter');
    await page.keyboard.type('two');
    await page.keyboard.press('Shift+ArrowUp');
    await compose(page, ['中'], '中');
    expect(await md(page)).toBe('one中\n');
    await expect(page.locator('#editor > *')).toHaveCount(1);
  });

  test('composition starting in an empty block', async ({ page }) => {
    await page.keyboard.press('Enter');
    await compose(page, ['ni', '你'], '你好');
    expect(await blocks(page)).toEqual(['p:', 'p:你好']);
  });

  test('composition in a list item and in a table cell', async ({ page }) => {
    await page.keyboard.type('- ');
    await compose(page, ['に'], 'にほん');
    expect(await blocks(page)).toEqual(['ul0:にほん']);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/table');
    await page.keyboard.press('Enter');
    await compose(page, ['表'], '表');
    expect((await blocks(page))[1]).toBe('table:表||/||/||');
  });

  test('a full-width slash from a Japanese IME opens the slash menu', async ({ page }) => {
    await compose(page, ['／'], '／');
    await expect(page.locator('.mbe-slash-menu')).toBeVisible();
  });

  test('the model follows the composed text before the composition ends', async ({ page }) => {
    await page.evaluate(() => {
      (window as any).changes = 0;
      (window as any).editor.on('change', () => (window as any).changes++);
    });
    const ime = await startComposing(page, ['n', 'に', 'にほん']);
    expect(await md(page)).toBe('にほん\n');
    expect(await page.evaluate(() => (window as any).editor.isEmpty)).toBe(false);
    expect(await page.evaluate(() => (window as any).changes)).toBeGreaterThan(0);
    // The placeholder of the empty document does not cover the composed text.
    await expect(page.locator('#editor > p')).not.toHaveClass(/(^|\s)mbe-empty(\s|$)/);
    await ime.update('にほ');
    expect(await md(page)).toBe('にほ\n');
    await ime.commit('日本');
    expect(await md(page)).toBe('日本\n');
    await expect(page.locator('#editor')).toHaveText('日本');
    // Still one undo step, though the model changed on every update.
    await page.keyboard.press('Control+z');
    expect(await md(page)).toBe('');
  });

  test('saving while composing keeps the composed text', async ({ page }) => {
    // The playground's Save button keeps focus in the editor, so the composition does not end first.
    await page.goto('/');
    await page.evaluate(() => (window as any).editor.setMarkdown(''));
    await page.locator('#editor').click();
    await startComposing(page, ['ni', '你好']);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.locator('#saved pre')).toHaveText('你好\n');
  });

  test('composing in the middle of text keeps the text after the caret', async ({ page }) => {
    await page.keyboard.type('ab');
    await page.keyboard.press('ArrowLeft');
    const ime = await startComposing(page, ['ㅎ', '하', '한']);
    expect(await md(page)).toBe('a한b\n');
    await ime.commit('한');
    expect(await md(page)).toBe('a한b\n');
    await page.keyboard.type('c');
    expect(await md(page)).toBe('a한cb\n');
  });

  test('Korean: a syllable that takes the next consonant splits into two', async ({ page }) => {
    // 가, then ㄴ makes 간, then ㅏ commits 가 and starts 나 in one keystroke.
    const cdp = await page.context().newCDPSession(page);
    await frame(page);
    await cdp.send('Input.imeSetComposition', { text: '가', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.imeSetComposition', { text: '간', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.insertText', { text: '가' });
    await cdp.send('Input.imeSetComposition', { text: '나', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.insertText', { text: '나' });
    await frame(page);
    expect(await md(page)).toBe('가나\n');
    await expect(page.locator('#editor')).toHaveText('가나');
  });

  test('marks chosen before composing apply to all of the composed text', async ({ page }) => {
    await page.keyboard.press('Control+b');
    // The input method replaces "k" with "か": the first composed character is replaced too.
    await compose(page, ['k', 'か', 'かん'], '漢');
    expect(await md(page)).toBe('**漢**\n');
    await expect(page.locator('#editor strong')).toHaveText('漢');
  });

  test('Enter that commits a composition does not split the block or pick a menu item', async ({ page }) => {
    await page.keyboard.type('abc');
    const ime = await startComposing(page, ['に']);
    await ime.imeKey('Enter');
    await ime.commit('に');
    // Safari sends the Enter keydown after compositionend, still with keyCode 229.
    await ime.imeKey('Enter');
    expect(await blocks(page)).toEqual(['p:abcに']);
    await page.keyboard.press('Enter');
    expect(await blocks(page)).toEqual(['p:abcに', 'p:']);

    await compose(page, ['／'], '／');
    await expect(page.locator('.mbe-slash-menu')).toBeVisible();
    await ime.imeKey('Enter');
    await expect(page.locator('.mbe-slash-menu')).toBeVisible();
    expect(await blocks(page)).toEqual(['p:abcに', 'p:／']);
  });

  test('an open suggestion menu filters by the composed text', async ({ page }) => {
    await page.keyboard.type('/');
    await expect(page.locator('.mbe-slash-menu')).toBeVisible();
    const ime = await startComposing(page, ['t', 'ta', 'tab']);
    await expect(page.locator('.mbe-slash-menu [role="option"]').first()).toHaveText(/Table/);
    await ime.commit('tab');
    await page.keyboard.press('Enter');
    expect((await blocks(page))[0]).toMatch(/^table:/);
  });

  test('composition in a heading, a quote and a code block', async ({ page }) => {
    await page.keyboard.type('## ');
    await compose(page, ['見'], '見出し');
    await page.keyboard.press('Enter');
    await page.keyboard.type('> ');
    await compose(page, ['引'], '引用');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('```');
    await page.keyboard.press('Enter');
    await page.keyboard.type('x = ');
    await compose(page, ['代'], '代码');
    expect(await blocks(page)).toEqual(['h2:見出し', 'quote:引用', 'code():x = 代码']);
  });

  test('the formatting toolbar hides while composing', async ({ page }) => {
    await page.keyboard.type('hello');
    await page.keyboard.press('Shift+Home');
    await expect(page.locator('.mbe-toolbar')).toBeVisible();
    const ime = await startComposing(page, ['こ']);
    await expect(page.locator('.mbe-toolbar')).toBeHidden();
    await ime.commit('こ');
    expect(await md(page)).toBe('こ\n');
  });

  test('a widget added while composing does not end the composition', async ({ page }) => {
    await page.keyboard.type('a');
    const ime = await startComposing(page, ['に']);
    // An upload placeholder appears, as when a paste finishes in the background.
    await page.evaluate(() => (window as any).editor.addWidget({ at: 'end', render: (el: HTMLElement) => (el.textContent = 'Uploading') }));
    await ime.update('にほ');
    await ime.commit('日本');
    expect(await md(page)).toBe('a日本\n');
    await expect(page.locator('.mbe-widget')).toHaveText('Uploading');
  });

  test('Enter from a keyboard that sends keyCode 229 picks the open menu item', async ({ page }) => {
    await page.keyboard.type('/tab');
    await expect(page.locator('.mbe-slash-menu')).toBeVisible();
    // Android keyboards: keydown has keyCode 229, then beforeinput insertParagraph.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Unidentified', windowsVirtualKeyCode: 229 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: '\r' });
    await frame(page);
    expect(await blocks(page)).toEqual([expect.stringMatching(/^table:/)]);
  });

  test.describe('the tag popup', () => {
    const tagMenu = (page: Page) => page.locator('.mbe-suggestion-menu:not(.mbe-slash-menu)');
    const labels = (page: Page) => tagMenu(page).locator('.mbe-menu-label');

    test('composed text in a token opens the popup and filters it', async ({ page }) => {
      await page.evaluate(() => (window as any).editor.setMarkdown('see #'));
      await page.keyboard.press('End');
      await expect(tagMenu(page)).toBeHidden();
      const ime = await startComposing(page, ['w', 'wo']);
      await expect(labels(page)).toHaveText(['#work', '#work/meeting', '#work/planning']);
      await ime.commit('wo');
      await expect(labels(page)).toHaveText(['#work', '#work/meeting', '#work/planning']);
    });

    test('a reading that matches nothing keeps the list until it is converted', async ({ page }) => {
      await page.keyboard.type('a #');
      await expect(labels(page)).toHaveCount(7);
      const ime = await startComposing(page, ['r', 'ri', 'riji']);
      // "riji" matches no tag, but the list stays while composing.
      await expect(tagMenu(page)).toBeVisible();
      await ime.commit('日记');
      await expect(labels(page)).toHaveText(['#日记']);
      await page.keyboard.press('Enter');
      expect(await md(page)).toBe('a #日记&#32;\n');
    });

    test('a full-width ＃ opens the popup and a pick writes #', async ({ page }) => {
      await page.keyboard.type('a ');
      await compose(page, ['＃'], '＃');
      await expect(labels(page)).toHaveCount(7);
      await page.keyboard.type('re');
      await expect(labels(page)).toHaveText(['#reading']);
      await page.keyboard.press('Enter');
      expect(await md(page)).toBe('a #reading&#32;\n');
    });

    test('the Enter that commits a composition does not pick, and the block is not re-rendered while composing', async ({ page }) => {
      await page.keyboard.type('a #');
      await expect(tagMenu(page)).toBeVisible();
      await page.evaluate(() => ((window as any).composedBlock = document.querySelector('#editor [data-block-id]')));
      const ime = await startComposing(page, ['w', 'wo']);
      await expect(labels(page)).toHaveText(['#work', '#work/meeting', '#work/planning']);
      expect(await page.evaluate(() => (window as any).composedBlock === document.querySelector('#editor [data-block-id]'))).toBe(true);
      await ime.imeKey('Enter');
      await ime.commit('wo');
      await expect(tagMenu(page)).toBeVisible();
      expect(await md(page)).toBe('a #wo\n');
    });

    test('a click on an item while composing commits the composed text once, then picks', async ({ page }) => {
      await page.keyboard.type('a #');
      await startComposing(page, ['w', 'wo']);
      await expect(labels(page)).toHaveText(['#work', '#work/meeting', '#work/planning']);
      await tagMenu(page).locator('.mbe-menu-item', { hasText: '#work/planning' }).click();
      await frame(page);
      expect(await md(page)).toBe('a #work/planning&#32;\n');
      await page.keyboard.type('x');
      expect(await md(page)).toBe('a #work/planning x\n');
    });
  });

  test('React: a controlled value follows the composition without breaking it', async ({ page }) => {
    await page.goto('/react.html?demo=api');
    const root = page.locator('#controlled .mbe-root');
    await root.click();
    await page.keyboard.press('End');
    // Each update reaches onChange, and the parent passes it back as `value`.
    const ime = await startComposing(page, ['n', 'に', 'にほ']);
    await expect(page.locator('#value')).toHaveText('startにほ\n');
    await ime.update('にほん');
    await ime.commit('日本');
    await expect(root).toHaveText('start日本');
    await expect(page.locator('#value')).toHaveText('start日本\n');
  });
});

// Composition by events, in each browser's order

/** Chromium and Safari send the last input, then compositionend. Firefox sends compositionend first. */
type Order = 'end last' | 'end first';

/**
 * Installs `window.ime` in the page: start, update and commit a composition.
 * The DOM is edited at the selection as an input method does. With `end
 * first`, compositionend comes before the committed text is written.
 */
async function installIme(page: Page) {
  await page.evaluate(() => {
    let node: Text;
    let start = 0;
    let length = 0;
    const target = () => node.parentElement ?? document.getElementById('editor')!;
    const write = (text: string, isComposing: boolean) => {
      target().dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: false, inputType: 'insertCompositionText', data: text, isComposing }));
      node.replaceData(start, length, text);
      length = text.length;
      getSelection()!.collapse(node, start + length);
      target().dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: text, isComposing }));
    };
    (window as any).ime = {
      start() {
        const sel = getSelection()!;
        (sel.focusNode as Node).parentElement!.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
        // The editor may have deleted a selection: start where the caret is now.
        const at = getSelection()!;
        if (at.focusNode!.nodeType === Node.TEXT_NODE) {
          node = at.focusNode as Text;
          start = at.focusOffset;
        } else {
          node = document.createTextNode('');
          at.focusNode!.insertBefore(node, at.focusNode!.childNodes[at.focusOffset] ?? null);
          start = 0;
        }
        length = 0;
      },
      update(text: string) {
        target().dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: text }));
        write(text, true);
      },
      commit(text: string, order: string) {
        if (order === 'end first') {
          target().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: text }));
          write(text, false);
        } else {
          this.update(text);
          target().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: text }));
        }
      },
      compose(steps: string[], text: string, order: string) {
        this.start();
        for (const step of steps) this.update(step);
        this.commit(text, order);
      },
    };
  });
}

const ime = {
  start: (page: Page) => page.evaluate(() => (window as any).ime.start()),
  update: (page: Page, text: string) => page.evaluate((text) => (window as any).ime.update(text), text),
  commit: async (page: Page, text: string, order: Order) => {
    await page.evaluate(({ text, order }) => (window as any).ime.commit(text, order), { text, order });
    await frame(page);
  },
  compose: async (page: Page, steps: string[], text: string, order: Order) => {
    await page.evaluate(({ steps, text, order }) => (window as any).ime.compose(steps, text, order), { steps, text, order });
    await frame(page);
  },
};

for (const [order, browsers] of [['end last', 'Chromium, Safari'], ['end first', 'Firefox']] as const) {
  test.describe(`composition events, compositionend ${order.slice(4)} (${browsers})`, () => {
    test.beforeEach(async ({ page }) => installIme(page));

    test('the model follows the composition, and it is one undo step', async ({ page }) => {
      await ime.start(page);
      await ime.update(page, 'k');
      await ime.update(page, 'か');
      expect(await md(page)).toBe('か\n');
      await expect(page.locator('#editor > p')).not.toHaveClass(/(^|\s)mbe-empty(\s|$)/);
      await ime.commit(page, '漢', order);
      expect(await md(page)).toBe('漢\n');
      await expect(page.locator('#editor')).toHaveText('漢');
      await page.keyboard.type('!');
      await page.keyboard.press('Control+z');
      expect(await md(page)).toBe('漢\n');
      await page.keyboard.press('Control+z');
      expect(await md(page)).toBe('');
    });

    test('in the middle of text, and inside bold text', async ({ page }) => {
      await page.keyboard.type('ab');
      await page.keyboard.press('ArrowLeft');
      await ime.compose(page, ['ㅎ', '한'], '한', order);
      await page.keyboard.type('c');
      expect(await md(page)).toBe('a한cb\n');
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Control+b');
      await page.keyboard.type('xy');
      await page.keyboard.press('ArrowLeft');
      await ime.compose(page, ['中'], '中', order);
      expect(await md(page)).toBe('a한cb\n\n**x中y**\n');
    });

    test('marks chosen before composing apply to all of the composed text', async ({ page }) => {
      await page.keyboard.press('Control+b');
      await ime.compose(page, ['k', 'か'], '漢字', order);
      expect(await md(page)).toBe('**漢字**\n');
      await expect(page.locator('#editor strong')).toHaveText('漢字');
    });

    test('over a selection spanning blocks', async ({ page }) => {
      await page.keyboard.type('one');
      await page.keyboard.press('Enter');
      await page.keyboard.type('two');
      await page.keyboard.press('Shift+ArrowUp');
      await ime.compose(page, ['中'], '中', order);
      expect(await md(page)).toBe('one中\n');
    });

    test('in a heading, a list item, a quote, a code block and a table cell', async ({ page }) => {
      await page.keyboard.type('## ');
      await ime.compose(page, ['見'], '見出し', order);
      await page.keyboard.press('Enter');
      await page.keyboard.type('- ');
      await ime.compose(page, ['に'], 'にほん', order);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await page.keyboard.type('> ');
      await ime.compose(page, ['引'], '引用', order);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await page.keyboard.type('```');
      await page.keyboard.press('Enter');
      await ime.compose(page, ['代'], '代码', order);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.type('/table');
      await page.keyboard.press('Enter');
      await ime.compose(page, ['表'], '表', order);
      expect(await blocks(page)).toEqual(['h2:見出し', 'ul0:にほん', 'quote:引用', 'code():代码', 'table:表||/||/||']);
    });

    test('Korean: two syllables in one keystroke', async ({ page }) => {
      // 간, then ㅏ commits 가 and starts 나 before the next frame.
      await page.evaluate((order) => {
        const ime = (window as any).ime;
        ime.start();
        ime.update('가');
        ime.update('간');
        ime.commit('가', order);
        ime.compose(['나'], '나', order);
      }, order);
      await frame(page);
      expect(await md(page)).toBe('가나\n');
      await expect(page.locator('#editor')).toHaveText('가나');
    });

    test('a full-width slash opens the slash menu', async ({ page }) => {
      await ime.compose(page, ['／'], '／', order);
      await expect(page.locator('.mbe-slash-menu')).toBeVisible();
    });
  });
}

// Mobile keyboards

/** Sends input the way an Android keyboard can: a beforeinput that cannot be cancelled, then the DOM change. */
async function uncancelableInsert(page: Page, text: string) {
  await page.evaluate((text) => {
    const root = document.getElementById('editor')!;
    root.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: text, cancelable: false, bubbles: true }));
    const sel = getSelection()!;
    sel.getRangeAt(0).insertNode(document.createTextNode(text));
    sel.collapseToEnd();
    root.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: text, bubbles: true }));
  }, text);
  await frame(page);
}

test('input that cannot be cancelled is applied once, and shortcuts still work', async ({ page }) => {
  await page.keyboard.type('ab');
  await uncancelableInsert(page, 'x');
  expect(await md(page)).toBe('abx\n');
  await page.keyboard.press('Enter');
  await uncancelableInsert(page, '-');
  await uncancelableInsert(page, ' ');
  await page.keyboard.type('item');
  expect(await blocks(page)).toEqual(['p:abx', 'ul0:item']);
});

/**
 * An autocorrect replacement: `inputType` over the characters `from`–`to` of
 * the first block's text. Returns whether the editor handled it, or
 * 'unsupported' when the engine drops target ranges on events made by a script.
 */
async function replaceWord(page: Page, inputType: 'insertText' | 'insertReplacementText', from: number, to: number, text: string) {
  return page.evaluate(
    ({ inputType, from, to, text }) => {
      const p = document.querySelector('#editor > p')!;
      const node = p.firstChild as Text;
      const range = new StaticRange({ startContainer: node, startOffset: from, endContainer: node, endOffset: to });
      const init: InputEventInit = { inputType, cancelable: true, bubbles: true, targetRanges: [range] };
      if (inputType === 'insertText') init.data = text;
      else {
        init.dataTransfer = new DataTransfer();
        init.dataTransfer.setData('text/plain', text);
      }
      const event = new InputEvent('beforeinput', init);
      if (event.getTargetRanges().length === 0) return 'unsupported';
      return !document.getElementById('editor')!.dispatchEvent(event);
    },
    { inputType, from, to, text },
  );
}

test('autocorrect and word suggestions replace the word they cover', async ({ page }) => {
  await page.keyboard.type('I saw teh');
  // iOS and Android send the replacement with a target range over the word.
  const handled = await replaceWord(page, 'insertText', 6, 9, 'the');
  test.skip(handled === 'unsupported', 'This engine drops target ranges on events made by a script');
  expect(handled).toBe(true);
  expect(await md(page)).toBe('I saw the\n');
  await page.keyboard.type(' cta');
  expect(await replaceWord(page, 'insertReplacementText', 10, 13, 'cat')).toBe(true);
  expect(await md(page)).toBe('I saw the cat\n');
  await page.keyboard.type('!');
  expect(await md(page)).toBe('I saw the cat!\n');
});
