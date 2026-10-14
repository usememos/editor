// Footnotes (GFM): `[^label]` references and `[^label]: text` definitions.
// Kept as source and saved verbatim. A definition ends at a blank line, at
// another definition, or at a line that starts another block.
//
// References render as superscript labels and definitions as a small note
// with the label, like a footnote, unless `render: false`. While editing,
// either shows its source at the caret. When read-only, clicking a reference
// scrolls to its definition.

import type { Extension, SyntaxView } from '../extension';
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

export interface FootnotesOptions {
  /** Render references and definitions instead of showing their source. Default true. */
  readonly render?: boolean;
}

/** The label of `[^label]`, with backslash escapes removed. */
const labelOf = (source: string): string => /^\[\^((?:[^\]\\]|\\.)+)\]/.exec(source)?.[1]?.replace(/\\(.)/g, '$1') ?? '';

const renderReference: SyntaxView = (source, element) => {
  const label = labelOf(source);
  const sup = element.ownerDocument.createElement('sup');
  sup.className = 'mbe-footnote-ref';
  sup.dataset.label = label;
  sup.textContent = label;
  element.appendChild(sup);
};

const renderDefinition: SyntaxView = (source, element) => {
  const label = labelOf(source);
  const doc = element.ownerDocument;
  element.classList.add('mbe-footnote');
  element.dataset.label = label;
  const sup = doc.createElement('sup');
  sup.className = 'mbe-footnote-label';
  sup.textContent = label;
  // The definition's text, its lines joined as one paragraph would be.
  const text = doc.createElement('span');
  text.textContent = source
    .replace(/^\[\^(?:[^\]\\]|\\.)+\]:[ \t]*/, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');
  element.append(sup, text);
};

export function footnotes(options: FootnotesOptions = {}): Extension {
  if (options.render === false) return { name: 'footnotes', markdown: { inline: [inline], block: [block] } };
  return {
    name: 'footnotes',
    markdown: { inline: [inline], block: [block] },
    views: { footnote: (source, element, kind) => (kind === 'inline' ? renderReference : renderDefinition)(source, element, kind) },
    onCreate: ({ editor }) => {
      // Read-only, a reference leads to its definition in the same document.
      const onClick = (e: MouseEvent) => {
        const ref = (e.target as HTMLElement).closest?.<HTMLElement>('.mbe-footnote-ref');
        if (!ref || editor.isEditable) return;
        const definition = [...editor.root.querySelectorAll<HTMLElement>('.mbe-footnote')].find((d) => d.dataset.label === ref.dataset.label);
        if (!definition) return;
        e.preventDefault();
        definition.scrollIntoView({ block: 'center', behavior: 'smooth' });
      };
      editor.root.addEventListener('click', onClick);
      return () => editor.root.removeEventListener('click', onClick);
    },
  };
}
