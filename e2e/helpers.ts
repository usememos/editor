import { test as base, expect, type Page } from '@playwright/test';

export { expect, type Page };

/**
 * Playwright's `test`, failing any test whose page throws an uncaught error or
 * logs a console error, even when its own assertions pass.
 */
export const test = base.extend<{ pageErrors: string[]; clipboardEvents: void }>({
  // Firefox's ClipboardEvent constructor ignores `clipboardData`, so tests make
  // their copy, cut and paste events with `clipboardEvent(type, data)`, which
  // puts the data on the event in every browser.
  clipboardEvents: [
    async ({ page }, use) => {
      await page.addInitScript(() => {
        (window as any).clipboardEvent = (type: string, data: DataTransfer) => {
          const event = new ClipboardEvent(type, { bubbles: true, cancelable: true });
          Object.defineProperty(event, 'clipboardData', { value: data });
          return event;
        };
      });
      await use();
    },
    { auto: true },
  ],
  pageErrors: [
    async ({ page }, use) => {
      const errors = failOnPageErrors(page);
      await use(errors);
      expect(errors, 'errors in the page').toEqual([]);
    },
    { auto: true },
  ],
});

export const md = (page: Page) => page.evaluate(() => (window as any).editor.getMarkdown() as string);

/** Compact form of the document: "p:text", "h2:text", "ul0:text", "task1[x]:text", "code(js):text", "hr", "table:a|b/c|d". */
export const blocks = (page: Page) =>
  page.evaluate(() => {
    const text = (c: any[]) => c.map((s) => s.text).join('');
    return (window as any).editor.state.doc.blocks.map((b: any) => {
      switch (b.type) {
        case 'paragraph':
          return `p:${text(b.content)}`;
        case 'heading':
          return `h${b.level}:${text(b.content)}`;
        case 'listItem': {
          const kind = b.listType === 'bullet' ? 'ul' : b.listType === 'ordered' ? 'ol' : 'task';
          return `${kind}${b.indent}${b.listType === 'task' ? (b.checked ? '[x]' : '[ ]') : ''}:${text(b.content)}`;
        }
        case 'quote':
          return `quote:${text(b.content)}`;
        case 'code':
          return `code(${b.language}):${text(b.content)}`;
        case 'divider':
          return 'hr';
        case 'table':
          return `table:${b.rows.map((r: any[]) => r.map(text).join('|')).join('/')}`;
        default:
          return b.type;
      }
    }) as string[];
  });

/**
 * Checks that what the browser shows matches the model: block elements in model order, each
 * content element's text equal to its block's text (or table cell's), and the browser caret
 * inside the block the model selection's focus is in. Returns a list of problems, empty when
 * the view is in sync.
 */
export const viewProblems = (page: Page) =>
  page.evaluate(() => {
    const editor = (window as any).editor;
    const root = document.getElementById('editor')!;
    const problems: string[] = [];
    const text = (c: any[]) => c.map((s: any) => s.text).join('');
    // The same walk as domText in view/dom.ts: text nodes, atoms by their source, fills skipped.
    const domText = (el: Element): string => {
      let out = '';
      for (const child of Array.from(el.childNodes)) {
        if (child.nodeType === 3) out += (child as Text).data;
        else if (child instanceof HTMLElement) {
          if (child.hasAttribute('data-atom')) out += child.dataset.source ?? '￼';
          else if (!child.hasAttribute('data-mbe-fill')) out += domText(child);
        }
      }
      return out;
    };
    const model = editor.state.doc.blocks as any[];
    const els = Array.from(root.children).filter((el) => el.hasAttribute('data-block-id')) as HTMLElement[];
    const ids = els.map((el) => el.getAttribute('data-block-id'));
    if (ids.join() !== model.map((b) => b.id).join()) problems.push(`block order: dom ${ids.join()} vs model ${model.map((b) => b.id).join()}`);
    for (const [i, b] of model.entries()) {
      const el = els.find((e) => e.getAttribute('data-block-id') === b.id);
      if (!el) continue;
      if (b.type === 'table') {
        b.rows.forEach((row: any[], r: number) =>
          row.forEach((cell: any[], c: number) => {
            const cellEl = el.querySelector(`[data-row="${r}"][data-col="${c}"]`);
            if (!cellEl) problems.push(`block ${i}: no element for cell ${r},${c}`);
            else if (domText(cellEl) !== text(cell)) problems.push(`block ${i} cell ${r},${c}: dom ${JSON.stringify(domText(cellEl))} vs model ${JSON.stringify(text(cell))}`);
          }),
        );
        continue;
      }
      if (!b.content && b.text === undefined) continue;
      const content = el.hasAttribute('data-content') ? el : el.querySelector('[data-content]');
      // Raw blocks rendered by a view have no content element until the caret is in them.
      if (!content) continue;
      const expected = b.content ? text(b.content) : b.text;
      if (domText(content) !== expected) problems.push(`block ${i} (${b.type}): dom ${JSON.stringify(domText(content))} vs model ${JSON.stringify(expected)}`);
    }
    const sel = document.getSelection();
    if (editor.hasFocus() && sel && sel.focusNode && editor.selectedBlocks.length === 0) {
      const focusId = editor.state.selection.focus.blockId;
      const blockEl = (sel.focusNode instanceof Element ? sel.focusNode : sel.focusNode.parentElement)?.closest('[data-block-id]');
      if (blockEl && blockEl.getAttribute('data-block-id') !== focusId)
        problems.push(`caret: browser in block ${model.findIndex((b) => b.id === blockEl.getAttribute('data-block-id'))}, model in block ${model.findIndex((b) => b.id === focusId)}`);
    }
    return problems;
  });

/** Collects uncaught errors and console errors in the page. */
function failOnPageErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    // An image that cannot load is the network, not the page: a host the test
    // machine cannot reach, or a blob: URL from before a reload, which Firefox
    // reports as a security error.
    if (m.type() === 'error' && !/^Failed to load resource|may not load data from blob:/.test(m.text())) errors.push(`console.error: ${m.text()}`);
  });
  return errors;
}
