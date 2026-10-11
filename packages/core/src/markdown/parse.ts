// Block-level Markdown parser.
//
// Prototype scope: ATX and setext headings, paragraphs. Every other block
// construct (lists, quotes, code, tables, thematic breaks, HTML) is read as
// paragraph text for now. Step 3 replaces this with the full CommonMark
// two-phase block parser plus GFM tables and task lists.

import { type Block, type Doc, type HeadingBlock, heading, paragraph } from '../model';
import { parseInline } from './inline';

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;

export function parseMarkdown(src: string): Doc {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];

  const flushParagraph = () => {
    if (para.length === 0) return;
    blocks.push(paragraph(parseInline(joinLines(para))));
    para = [];
  };

  for (const line of lines) {
    if (line.trim() === '') {
      flushParagraph();
      continue;
    }
    const atx = ATX.exec(line);
    if (atx) {
      flushParagraph();
      const level = atx[1]!.length as HeadingBlock['level'];
      blocks.push(heading(level, parseInline(atx[2] ?? '')));
      continue;
    }
    const setext = SETEXT.exec(line);
    if (setext && para.length > 0) {
      const level = setext[1]!.startsWith('=') ? 1 : 2;
      blocks.push(heading(level, parseInline(joinLines(para))));
      para = [];
      continue;
    }
    para.push(line);
  }
  flushParagraph();
  return { blocks };
}

/**
 * Joins paragraph lines. The model has no soft line breaks, so a soft break
 * becomes a space. Hard breaks (trailing backslash or two spaces) also become
 * a space until hard breaks are added to the model.
 */
function joinLines(lines: string[]): string {
  return lines
    .map((l, i) => {
      let s = l.replace(/^[ \t]+/, '');
      if (i < lines.length - 1) s = s.replace(/(\\| {2,})$/, '').replace(/[ \t]+$/, '');
      else s = s.replace(/[ \t]+$/, '');
      return s;
    })
    .join('\n')
    .replace(/\n/g, ' ');
}
