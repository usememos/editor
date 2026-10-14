// UI strings. Override any of them with the `labels` option.

export const DEFAULT_LABELS = {
  text: 'Text',
  heading1: 'Heading 1',
  heading2: 'Heading 2',
  heading3: 'Heading 3',
  bulletList: 'Bulleted list',
  numberedList: 'Numbered list',
  todoList: 'To-do list',
  /** Accessible name of a task checkbox whose item has no text. */
  task: 'Task',
  quote: 'Quote',
  code: 'Code block',
  table: 'Table',
  divider: 'Divider',
  noResults: 'No results',
  /** Accessible name of an autocomplete popup without its own `label`. */
  suggestions: 'Suggestions',
  /** Accessible name of the slash menu. */
  commands: 'Commands',
  /** Shown in an autocomplete popup while its items are loading. */
  loading: 'Loading…',
  duplicate: 'Duplicate',
  delete: 'Delete',
  bold: 'Bold',
  italic: 'Italic',
  strike: 'Strikethrough',
  inlineCode: 'Code',
  link: 'Link',
  /** The formatting toolbar's menu of paragraph and heading styles. */
  textStyle: 'Text style',
  /** The formatting toolbar's menu of list types. */
  list: 'List',
  linkPlaceholder: 'Paste or type a link…',
  removeLink: 'Remove link',
  slashHint: "Type '/' for commands",
  blockHandle: 'Open block menu',
  listHint: 'List',
  quoteHint: 'Quote',
  language: 'Language',
  /** Shown in a code block's language field when it has none. */
  plainText: 'text',
  /** The copy button of a code block. */
  copyCode: 'Copy code',
  /** The copy button of a code block, just after copying. */
  copied: 'Copied',
  addRowAbove: 'Add row above',
  addRowBelow: 'Add row below',
  addColumnLeft: 'Add column left',
  addColumnRight: 'Add column right',
  deleteRow: 'Delete row',
  deleteColumn: 'Delete column',
  /** The block menu row that opens the Align submenu, and the submenu's title. */
  align: 'Align',
  alignLeft: 'Left',
  alignCenter: 'Center',
  alignRight: 'Right',
  tableSection: 'Table',
  /** The title of the block menu's section of image block actions. */
  imageSection: 'Image',
  /** Removes an image's width, so it shows at its own size. */
  resetImageSize: 'Reset size',
  /** Edits an image's alt text, and names the field that edits it. */
  altText: 'Alt text',
  altTextPlaceholder: 'Describe the image…',
  /** Shown in place of an image that did not load and has no alt text. */
  imageUnavailable: 'Image unavailable',
  /** Accessible name of an image's resize handles. */
  resizeImage: 'Resize image',
};

export type Labels = typeof DEFAULT_LABELS;
