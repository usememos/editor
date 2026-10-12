// textDecorator: decorations from a regular expression or a scanner
// function. Matches that overlap inline code, links, images, raw HTML or
// tokens are skipped.

import type { Decoration, TextRange } from '../decorations';
import { overlapsAny } from '../decorations';
import type { Extension } from '../extension';

export interface TextDecoratorOptions {
  /** Extension name. Default "textDecorator". */
  name?: string;
  /** Every match gets `class`. The `g` flag is added if missing. */
  pattern?: RegExp;
  /** Returns ranges to decorate. A range's own `class` replaces the default one. */
  scan?: (text: string) => Iterable<TextRange & { class?: string; attributes?: Readonly<Record<string, string>> }>;
  /** Class for each range. */
  class: string;
  attributes?: Readonly<Record<string, string>>;
}

export function textDecorator(options: TextDecoratorOptions): Extension {
  const pattern = options.pattern && new RegExp(options.pattern.source, options.pattern.flags.includes('g') ? options.pattern.flags : options.pattern.flags + 'g');
  return {
    name: options.name ?? 'textDecorator',
    decorations({ text, excluded }) {
      const out: Decoration[] = [];
      const add = (from: number, to: number, cls = options.class, attributes = options.attributes) => {
        if (to > from && !overlapsAny(from, to, excluded)) out.push(attributes ? { from, to, class: cls, attributes } : { from, to, class: cls });
      };
      if (pattern) for (const m of text.matchAll(pattern)) add(m.index!, m.index! + m[0].length);
      if (options.scan) for (const r of options.scan(text)) add(r.from, r.to, r.class, r.attributes ?? options.attributes);
      return out;
    },
  };
}
