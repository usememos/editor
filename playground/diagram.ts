// A stand-in diagram view for ```mermaid code blocks, until the editor has a
// diagram renderer: the first line is the diagram's header, shown as a
// caption, and every other line is a step in a rounded box, one under the
// other. It shows what a `code:<language>` view gets from the editor: the
// element is not in the page yet, so text is measured on a canvas in the
// editor's font, read from `ctx.editor.root`. The SVG is built with
// `createElementNS` and styled through the CSSOM with the theme's variables,
// so it works under a strict Content Security Policy and follows the theme
// without rendering again; a font change renders it again
// (`editor.refreshViews()`).

import type { SyntaxView } from '@usememos/editor';

const SVG = 'http://www.w3.org/2000/svg';
const PAD_X = 12;
const BOX_HEIGHT = 32;
const GAP = 20;

let measurer: CanvasRenderingContext2D | null = null;

/** The width of `text` in `font`, in CSS pixels. */
function measure(text: string, font: string): number {
  measurer ??= document.createElement('canvas').getContext('2d');
  if (!measurer) return text.length * 8;
  measurer.font = font;
  return measurer.measureText(text).width;
}

export const diagram: SyntaxView = (source, element, _kind, { editor }) => {
  const lines = source
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  const [header = '', ...steps] = lines;
  const style = getComputedStyle(editor.root);
  const font = `${style.fontStyle} ${style.fontWeight} 14px ${style.fontFamily}`;
  const doc = element.ownerDocument;
  const svg = doc.createElementNS(SVG, 'svg');
  const text = (content: string, x: number, y: number, color: string, anchor = 'middle'): SVGTextElement => {
    const t = doc.createElementNS(SVG, 'text');
    t.setAttribute('x', String(x));
    t.setAttribute('y', String(y));
    t.setAttribute('text-anchor', anchor);
    t.setAttribute('dominant-baseline', 'central');
    t.style.setProperty('fill', color);
    t.style.setProperty('font', font);
    t.textContent = content;
    return t;
  };
  const widths = steps.map((s) => Math.ceil(measure(s, font)) + PAD_X * 2);
  const width = Math.max(measure(header, font) + PAD_X * 2, ...widths, 120);
  const height = 24 + steps.length * BOX_HEIGHT + Math.max(0, steps.length - 1) * GAP;
  const center = width / 2;
  svg.append(text(header, PAD_X, 10, 'var(--mbe-muted)', 'start'));
  steps.forEach((step, i) => {
    const top = 24 + i * (BOX_HEIGHT + GAP);
    const box = doc.createElementNS(SVG, 'rect');
    box.setAttribute('x', String(center - widths[i]! / 2));
    box.setAttribute('y', String(top));
    box.setAttribute('width', String(widths[i]));
    box.setAttribute('height', String(BOX_HEIGHT));
    box.setAttribute('rx', '6');
    box.style.setProperty('fill', 'var(--mbe-code-bg)');
    box.style.setProperty('stroke', 'var(--mbe-border)');
    svg.append(box, text(step, center, top + BOX_HEIGHT / 2, 'var(--mbe-text)'));
    if (i > 0) {
      const arrow = doc.createElementNS(SVG, 'path');
      arrow.setAttribute('d', `M${center} ${top - GAP} v${GAP - 6} m-4 -4 l4 4 l4 -4`);
      arrow.style.setProperty('fill', 'none');
      arrow.style.setProperty('stroke', 'var(--mbe-muted)');
      arrow.style.setProperty('stroke-width', '1.5');
      svg.append(arrow);
    }
  });
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', lines.join(', '));
  svg.style.setProperty('display', 'block');
  svg.style.setProperty('max-width', '100%');
  svg.style.setProperty('height', 'auto');
  svg.dataset.font = style.fontFamily;
  element.appendChild(svg);
};
