// fileHandler: receives files pasted or dropped into the editor. memos sends
// pasted files to the attachment list and uploads dropped images inline.

import type { Editor } from '../editor';
import type { Extension } from '../extension';
import type { Position } from '../model';

export interface FileHandlerOptions {
  /**
   * Which files to take: MIME types or patterns such as `image/*`, or a test
   * function. Default: every file.
   */
  accept?: readonly string[] | ((file: File) => boolean);
  /**
   * Pasted files. Called only when the clipboard has no plain text, so
   * copying text from a page that also puts an image on the clipboard still
   * pastes the text.
   */
  onPaste?: (ctx: { editor: Editor; files: File[]; event: ClipboardEvent }) => void;
  /** Dropped files, with the document position they were dropped at (null outside text). */
  onDrop?: (ctx: { editor: Editor; files: File[]; event: DragEvent; position: Position | null }) => void;
}

export function fileHandler(options: FileHandlerOptions): Extension {
  const accepts = (file: File): boolean => {
    const accept = options.accept;
    if (!accept) return true;
    if (typeof accept === 'function') return accept(file);
    return accept.some((type) => (type.endsWith('/*') ? file.type.startsWith(type.slice(0, -1)) : file.type === type));
  };
  const filesOf = (data: DataTransfer | null): File[] => Array.from(data?.files ?? []).filter(accepts);
  return {
    name: 'fileHandler',
    handlePaste: ({ editor, event }) => {
      if (!options.onPaste || event.clipboardData?.getData('text/plain')) return false;
      const files = filesOf(event.clipboardData);
      if (files.length === 0) return false;
      options.onPaste({ editor, files, event });
      return true;
    },
    handleDrop: ({ editor, event, position }) => {
      if (!options.onDrop) return false;
      const files = filesOf(event.dataTransfer);
      if (files.length === 0) return false;
      options.onDrop({ editor, files, event, position });
      return true;
    },
  };
}
