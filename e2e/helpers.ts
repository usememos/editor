import type { Page } from '@playwright/test';

export const md = (page: Page) => page.evaluate(() => (window as any).editor.getMarkdown() as string);

/** Compact form of the document: "p:text", "h2:text", "ul0:text", "task1[x]:text", "code(js):text", "hr", "table:a|b/c|d". */
export const blocks = (page: Page) =>
  page.evaluate(() => {
    const text = (c: any[]) => c.map((s) => s.text).join('');
    return (window as any).editor.getDoc().blocks.map((b: any) => {
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

export const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
