// Footnotes (GFM): `[^label]` references and `[^label]: text` definitions.
// Kept as source and saved verbatim. A definition ends at a blank line, at
// another definition, or at a line that starts another block.

import type { Extension } from '../extension';
import type { BlockSyntax, InlineSyntax } from '../markdown/options';

const reReference = /\[\^(?:[^\]\s\\]|\\.)+\]/y;
const reDefinition = /^\[\^(?:[^\]\s\\]|\\.)+\]:/;
const reBlockStart = /^(?:#{1,6}(?:[ \t]|$)|>|[-*+][ \t]|\d{1,9}[.)][ \t]|`{3,}|~{3,}|\$\$|<[A-Za-z/!?])/;

const inline: InlineSyntax = {
  name: 'footnote',
  triggers: '[',
  match(text, pos) {
    reReference.lastIndex = pos;
    return reReference.test(text) ? reReference.lastIndex : -1;
  },
};

const block: BlockSyntax = {
  name: 'footnote',
  open(line) {
    if (!reDefinition.test(line)) return null;
    return {
      next(l) {
        if (/^[ \t]*$/.test(l)) return 'end';
        const rest = l.replace(/^[ \t]+/, '');
        return reDefinition.test(rest) || reBlockStart.test(rest) ? 'end' : 'continue';
      },
    };
  },
};

export function footnotes(): Extension {
  return { name: 'footnotes', markdown: { inline: [inline], block: [block] } };
}
