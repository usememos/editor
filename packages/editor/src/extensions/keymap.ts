// The default key bindings, as an extension. The editor adds it unless the
// extensions list has one named "defaultKeymap", so an app can replace it;
// bindings in earlier extensions take priority, so an app can override keys.

import { moveCell } from '../commands';
import type { Extension, KeyHandler } from '../extension';
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
    'Mod-z': ({ editor }) => editor.commands.undo() || true,
    'Mod-Shift-z': ({ editor }) => editor.commands.redo() || true,
    'Mod-Enter': ({ editor }) => editor.submit(),
    'Ctrl-Enter': ({ editor }) => editor.submit(),
    Tab: ({ editor }) => (editor.isActive('table') ? editor.run((s) => moveCell(s, 1)) : editor.commands.indent()) || true,
    'Shift-Tab': ({ editor }) => (editor.isActive('table') ? editor.run((s) => moveCell(s, -1)) : editor.commands.outdent()) || true,
    // The first Escape selects the block; Escape in a block selection leaves the editor.
    Escape: ({ editor }) => editor.commands.selectBlocks() || editor.commands.blur(),
  };
  // Ctrl+Y is redo on Windows and Linux; on macOS it is a text editing key.
  if (!isMac) keymap['Ctrl-y'] = ({ editor }) => editor.commands.redo() || true;
  return { name: 'defaultKeymap', keymap };
}
