// Footnotes (GFM): `[^label]` references and `[^label]: text` definitions.
// Kept as source and saved verbatim. A definition ends at a blank line, at
// another definition, or at a line that starts another block.
//
// References render as superscript labels and definitions as a small note
// with the label, like a footnote, unless `render: false`. The renderer
// draws a definition's text as Markdown into the note (see `renderFootnote`
// in view/dom.ts). While editing, either shows its source at the caret, and a
// definition shows where it is written. Read-only, as on GitHub, the
// definitions hide where they are written and the referenced ones are
// collected in a section at the end, in order of first reference, each with
// a backlink per reference; clicking a reference scrolls to its note and a
// backlink to its reference.

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
  // The renderer passes the label part with a slot marker for the text and renders the text into the slot.
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
    views: { footnote: (source, element, kind, ctx) => (kind === 'inline' ? renderReference : renderDefinition)(source, element, kind, ctx) },
    onCreate: ({ editor }) => {
      // Read-only, a reference leads to its note in the collected section, and a backlink to its reference.
      const onClick = (e: MouseEvent) => {
        if (editor.isEditable) return;
        const target = e.target as HTMLElement;
        const ref = target.closest?.<HTMLElement>('.mbe-footnote-ref');
        const back = ref ? null : target.closest?.<HTMLElement>('.mbe-footnote-backref');
        if (!ref && !back) return;
        const inSection = (el: Element) => el.closest('.mbe-footnotes') !== null;
        let to: HTMLElement | undefined;
        if (ref) {
          const notes = [...editor.root.querySelectorAll<HTMLElement>('.mbe-footnote')].filter((d) => d.dataset.label === ref.dataset.label);
          to = notes.find(inSection) ?? notes[0];
        } else if (back) {
          const refs = [...editor.root.querySelectorAll<HTMLElement>('.mbe-footnote-ref')].filter((r) => r.dataset.label === back.dataset.label && !inSection(r));
          to = refs[Number(back.dataset.ref) - 1];
        }
        if (!to) return;
        e.preventDefault();
        to.scrollIntoView({ block: 'center', behavior: 'smooth' });
      };
      editor.root.addEventListener('click', onClick);
      return () => editor.root.removeEventListener('click', onClick);
    },
  };
}
