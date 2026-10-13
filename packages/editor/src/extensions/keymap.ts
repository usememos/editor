// The default key bindings, as an extension. The editor adds it unless the
// extensions list has one named "defaultKeymap", so an app can replace it;
// bindings in earlier extensions take priority, so an app can override keys.

import { indentCode, moveCell } from '../commands';
import type { Editor } from '../editor';
import type { Extension, KeyHandler } from '../extension';
import { containerContent, getBlock, inlineLength, sameCell } from '../model';
import { isMac } from '../ui/popup';

export function defaultKeymap(): Extension {
  const keymap: Record<string, KeyHandler> = {
    'Mod-b': ({ editor }) => editor.commands.toggleBold(),
    'Mod-i': ({ editor }) => editor.commands.toggleItalic(),
    'Mod-e': ({ editor }) => editor.commands.toggleCode(),
    'Mod-Shift-x': ({ editor }) => editor.commands.toggleStrike(),
    'Mod-Shift-s': ({ editor }) => editor.commands.toggleStrike(),
    'Mod-k': ({ editor }) => (editor.openLinkPopover(), true),
    'Mod-Alt-0': ({ editor }) => editor.commands.setParagraph() || true,
    'Mod-Alt-1': ({ editor }) => editor.commands.toggleHeading({ level: 1 }) || true,
    'Mod-Alt-2': ({ editor }) => editor.commands.toggleHeading({ level: 2 }) || true,
    'Mod-Alt-3': ({ editor }) => editor.commands.toggleHeading({ level: 3 }) || true,
    'Mod-Alt-c': ({ editor }) => editor.commands.toggleCodeBlock() || true,
    'Mod-Shift-7': ({ editor }) => editor.commands.toggleOrderedList() || true,
    'Mod-Shift-8': ({ editor }) => editor.commands.toggleBulletList() || true,
    'Mod-Shift-9': ({ editor }) => editor.commands.toggleTaskList() || true,
    'Mod-a': ({ editor }) => selectAll(editor),
    'Mod-z': ({ editor }) => editor.commands.undo() || true,
    'Mod-Shift-z': ({ editor }) => editor.commands.redo() || true,
    'Mod-Enter': ({ editor }) => editor.submit(),
    'Ctrl-Enter': ({ editor }) => editor.submit(),
    Tab: ({ editor }) => tab(editor, 1),
    'Shift-Tab': ({ editor }) => tab(editor, -1),
    // The first Escape selects the block; Escape in a block selection leaves the editor.
    Escape: ({ editor }) => editor.commands.selectBlocks() || editor.commands.blur(),
  };
  // Ctrl+Y is redo on Windows and Linux; on macOS it is a text editing key.
  if (!isMac) keymap['Ctrl-y'] = ({ editor }) => editor.commands.redo() || true;
  return { name: 'defaultKeymap', keymap };
}

/** Tab and Shift+Tab: next or previous table cell, indent code, or nest list items. Never moves focus out. */
function tab(editor: Editor, delta: 1 | -1): boolean {
  if (editor.isActive('table')) editor.run((s) => moveCell(s, delta));
  else if (editor.isActive('codeBlock')) editor.run((s) => indentCode(s, delta));
  else if (delta === 1) editor.commands.indent();
  else editor.commands.outdent();
  return true;
}

/**
 * Mod+A: the text of the table cell or code block with the caret first, then
 * the whole document. The browser's own select-all stops at a table cell and
 * selects nothing when the document starts with a code block or table.
 */
function selectAll(editor: Editor): boolean {
  const { doc, selection } = editor.state;
  const { anchor, focus } = selection;
  if (anchor.blockId === focus.blockId && sameCell(anchor.cell, focus.cell)) {
    const block = getBlock(doc, focus.blockId);
    const content = focus.cell || block.type === 'code' ? containerContent(block, focus.cell) : null;
    if (content) {
      const end = inlineLength(content);
      if (Math.min(anchor.offset, focus.offset) !== 0 || Math.max(anchor.offset, focus.offset) !== end) {
        editor.setSelection({ anchor: { ...focus, offset: 0 }, focus: { ...focus, offset: end } });
        return true;
      }
    }
  }
  return editor.commands.selectAll();
}
