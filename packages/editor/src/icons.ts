/*! Icons from Lucide (lucide-static 1.55.0), https://lucide.dev
 * ISC License. Copyright (c) 2026 Lucide Icons and Contributors.
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

// Every icon in the editor's UI. The data is copied from lucide-static's
// icon-nodes.json, not imported, so the core keeps zero runtime
// dependencies. To update an icon, copy its new data from the same package
// and change the version above. Icons are built with createElementNS, never
// from markup, so they work under Trusted Types.

import type { Labels } from './labels';

/** An icon: a string is shown as text, an element (such as an `<svg>`) is cloned for every place it appears. */
export type Icon = string | Element;

/** One SVG child: a path's `d`, or a tag and its attributes. */
type IconChild = string | readonly [tag: string, attrs: Readonly<Record<string, string>>];

/** `trash`, used by every delete action. */
const TRASH: readonly IconChild[] = ['M10 11v6', 'M14 11v6', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M3 6h18', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'];

/** The built-in icons, by the `labels` key of the control that shows them (see IconName). The comment names the Lucide icon. */
const ICONS = {
  /** `type` */
  text: ['M12 4v16', 'M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2', 'M9 20h6'],
  /** `heading-1` */
  heading1: ['M4 12h8', 'M4 18V6', 'M12 18V6', 'm17 12 3-2v8'],
  /** `heading-2` */
  heading2: ['M4 12h8', 'M4 18V6', 'M12 18V6', 'M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1'],
  /** `heading-3` */
  heading3: ['M4 12h8', 'M4 18V6', 'M12 18V6', 'M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2', 'M17 17.5c2 1.5 4 .3 4-1.5a2 2 0 0 0-2-2'],
  /** `list` */
  bulletList: ['M3 5h.01', 'M3 12h.01', 'M3 19h.01', 'M8 5h13', 'M8 12h13', 'M8 19h13'],
  /** `list-ordered` */
  numberedList: ['M11 5h10', 'M11 12h10', 'M11 19h10', 'M4 4h1v5', 'M4 9h2', 'M6.5 20H3.4c0-1 2.6-1.925 2.6-3.5a1.5 1.5 0 0 0-2.6-1.02'],
  /** `list-todo` */
  todoList: ['M13 5h8', 'M13 12h8', 'M13 19h8', 'm3 17 2 2 4-4', ['rect', { x: '3', y: '4', width: '6', height: '6', rx: '1' }]],
  /** `text-quote` */
  quote: ['M17 5H3', 'M21 12H8', 'M21 19H8', 'M3 12v7'],
  /** `square-code` */
  code: ['m10 9-3 3 3 3', 'm14 15 3-3-3-3', ['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2' }]],
  /** `table` */
  table: ['M12 3v18', ['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }], 'M3 9h18', 'M3 15h18'],
  /** `minus` */
  divider: ['M5 12h14'],
  /** `copy` */
  duplicate: [['rect', { width: '14', height: '14', x: '8', y: '8', rx: '2', ry: '2' }], 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'],
  /** `copy` */
  copyCode: [['rect', { width: '14', height: '14', x: '8', y: '8', rx: '2', ry: '2' }], 'M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'],
  /** `check` */
  copied: ['M20 6 9 17l-5-5'],
  /** `trash` */
  delete: TRASH,
  /** `arrow-up` */
  addRowAbove: ['m5 12 7-7 7 7', 'M12 19V5'],
  /** `arrow-down` */
  addRowBelow: ['M12 5v14', 'm19 12-7 7-7-7'],
  /** `arrow-left` */
  addColumnLeft: ['m12 19-7-7 7-7', 'M19 12H5'],
  /** `arrow-right` */
  addColumnRight: ['M5 12h14', 'm12 5 7 7-7 7'],
  /** `text-align-start`, the table menu's Align row */
  align: ['M21 5H3', 'M15 12H3', 'M17 19H3'],
  /** `text-align-start` */
  alignLeft: ['M21 5H3', 'M15 12H3', 'M17 19H3'],
  /** `text-align-center` */
  alignCenter: ['M21 5H3', 'M17 12H7', 'M19 19H5'],
  /** `text-align-end` */
  alignRight: ['M21 5H3', 'M21 12H9', 'M21 19H7'],
  /** `align-start-vertical`, an image block's Align row and its Left item */
  imageAlignLeft: [['rect', { width: '9', height: '6', x: '6', y: '14', rx: '2' }], ['rect', { width: '16', height: '6', x: '6', y: '4', rx: '2' }], 'M2 2v20'],
  /** `align-center-vertical` */
  imageAlignCenter: [
    'M12 2v20',
    'M8 10H4a2 2 0 0 1-2-2V6c0-1.1.9-2 2-2h4',
    'M16 10h4a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-4',
    'M8 20H7a2 2 0 0 1-2-2v-2c0-1.1.9-2 2-2h1',
    'M16 14h1a2 2 0 0 1 2 2v2a2 2 0 0 1-2 2h-1',
  ],
  /** `align-end-vertical` */
  imageAlignRight: [['rect', { width: '16', height: '6', x: '2', y: '4', rx: '2' }], ['rect', { width: '9', height: '6', x: '9', y: '14', rx: '2' }], 'M22 22V2'],
  /** `rotate-ccw` */
  resetImageSize: ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5'],
  /** `text-cursor-input` */
  altText: [
    'M12 20h-1a2 2 0 0 1-2-2 2 2 0 0 1-2 2H6',
    'M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-7',
    'M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1',
    'M6 4h1a2 2 0 0 1 2 2 2 2 0 0 1 2-2h1',
    'M9 6v12',
  ],
  /** `trash` */
  deleteRow: TRASH,
  /** `trash` */
  deleteColumn: TRASH,
  /** `bold` */
  bold: ['M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8'],
  /** `italic` */
  italic: [['line', { x1: '19', x2: '10', y1: '4', y2: '4' }], ['line', { x1: '14', x2: '5', y1: '20', y2: '20' }], ['line', { x1: '15', x2: '9', y1: '4', y2: '20' }]],
  /** `strikethrough` */
  strike: ['M16 4H9a3 3 0 0 0-2.83 4', 'M14 12a4 4 0 0 1 0 8H6', ['line', { x1: '4', x2: '20', y1: '12', y2: '12' }]],
  /** `code` */
  inlineCode: ['m16 18 6-6-6-6', 'm8 6-6 6 6 6'],
  /** `link` */
  link: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'],
  /** `image-off` */
  imageUnavailable: [
    ['line', { x1: '2', x2: '22', y1: '2', y2: '22' }],
    'M10.41 10.41a2 2 0 1 1-2.83-2.83',
    ['line', { x1: '13.5', x2: '6', y1: '13.5', y2: '21' }],
    ['line', { x1: '18', x2: '21', y1: '12', y2: '15' }],
    'M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59',
    'M21 15V5a2 2 0 0 0-2-2H9',
  ],
  /** `chevron-down`, after the icon of a toolbar button that opens a menu */
  chevronDown: ['m6 9 6 6 6-6'],
  /** `check`, after the current item of a menu */
  selected: ['M20 6 9 17l-5-5'],
  /** `chevron-right`, at the end of a menu row that opens a submenu */
  chevronRight: ['m9 18 6-6-6-6'],
  /** `grip-vertical` */
  blockHandle: [['circle', { cx: '9', cy: '12', r: '1' }], ['circle', { cx: '9', cy: '5', r: '1' }], ['circle', { cx: '9', cy: '19', r: '1' }], ['circle', { cx: '15', cy: '12', r: '1' }], ['circle', { cx: '15', cy: '5', r: '1' }], ['circle', { cx: '15', cy: '19', r: '1' }]],
} satisfies Partial<Record<keyof Labels | IconPart, readonly IconChild[]>>;

/** Icons not named after a label: parts of controls, and an image block's Align choices, whose labels tables share. */
type IconPart = 'chevronDown' | 'chevronRight' | 'selected' | 'imageAlignLeft' | 'imageAlignCenter' | 'imageAlignRight';

/**
 * Names of the built-in icons. Each is the `labels` key of the control that
 * shows it, except `chevronDown`, `chevronRight` and `selected`, which are
 * parts of controls, and `imageAlignLeft`, `imageAlignCenter` and
 * `imageAlignRight`, an image block's Align choices.
 */
export type IconName = keyof typeof ICONS;

export type Icons = Partial<Record<IconName, Icon>>;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Attributes of every Lucide icon. Size comes from CSS (`.mbe-icon`). */
const SVG_ATTRS: Readonly<Record<string, string>> = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '2',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
  'aria-hidden': 'true',
  focusable: 'false',
};

/** Builds the built-in icon `name` as a new `<svg class="mbe-icon">`. */
export function builtinIcon(doc: Document, name: IconName): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'mbe-icon');
  for (const [attr, value] of Object.entries(SVG_ATTRS)) svg.setAttribute(attr, value);
  for (const child of ICONS[name]) {
    const [tag, attrs] = typeof child === 'string' ? ['path', { d: child }] : child;
    const el = doc.createElementNS(SVG_NS, tag);
    for (const [attr, value] of Object.entries(attrs)) el.setAttribute(attr, value);
    svg.appendChild(el);
  }
  return svg;
}

/** The content of an icon slot: text, a clone of an element, or nothing. */
export function iconNode(doc: Document, icon: Icon | undefined): Node | null {
  if (icon === undefined || icon === '') return null;
  return typeof icon === 'string' ? doc.createTextNode(icon) : doc.importNode(icon, true);
}
