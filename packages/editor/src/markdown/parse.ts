// Markdown → document model: the full CommonMark + GFM parser (blocks.ts and
// inline.ts) followed by lowering to the flat model (lower.ts).

import type { Doc } from '../model';
import { parseAst } from './blocks';
import type { MarkdownOptions } from './options';
import { loadMarkdown } from './source';

export { parseAst } from './blocks';

export function parseMarkdown(src: string, options?: MarkdownOptions): Doc {
  return loadMarkdown(src, options, false).doc;
}
