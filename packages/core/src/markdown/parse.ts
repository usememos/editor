// Markdown → document model: the full CommonMark + GFM parser (blocks.ts and
// inline.ts) followed by lowering to the flat model (lower.ts).

import type { Doc } from '../model';
import { parseAst } from './blocks';
import { astToDoc } from './lower';

export { parseAst } from './blocks';
export { astToDoc } from './lower';

export function parseMarkdown(src: string): Doc {
  return astToDoc(parseAst(src));
}
