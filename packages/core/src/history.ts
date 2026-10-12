// Undo/redo. Entries are whole-document snapshots; blocks are shared between
// snapshots, so a snapshot costs one array of references.

import type { Doc, EditorState, Selection } from './model';

export type ChangeKind = 'typing' | 'other';

interface Entry {
  doc: Doc;
  selection: Selection;
}

const GROUP_MS = 1000;
const LIMIT = 500;

export class History {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private lastKind: ChangeKind | null = null;
  private lastTime = 0;

  /** Call before applying a change, with the state the change starts from. */
  record(before: EditorState, kind: ChangeKind, now = Date.now()): void {
    const extendsGroup = kind === 'typing' && this.lastKind === 'typing' && now - this.lastTime < GROUP_MS;
    if (!extendsGroup) {
      this.undoStack.push({ doc: before.doc, selection: before.selection });
      if (this.undoStack.length > LIMIT) this.undoStack.shift();
    }
    this.redoStack = [];
    this.lastKind = kind;
    this.lastTime = now;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.lastKind = null;
  }

  /** Ends the current typing group, e.g. when the caret moves. */
  breakGroup(): void {
    this.lastKind = null;
  }

  undo(current: EditorState): EditorState | null {
    return this.step(current, this.undoStack, this.redoStack);
  }

  redo(current: EditorState): EditorState | null {
    return this.step(current, this.redoStack, this.undoStack);
  }

  /** Moves the newest entry of `from` back into the document, and the current state onto `to`. */
  private step(current: EditorState, from: Entry[], to: Entry[]): EditorState | null {
    const entry = from.pop();
    if (!entry) return null;
    to.push({ doc: current.doc, selection: current.selection });
    this.lastKind = null;
    return { doc: entry.doc, selection: entry.selection, storedMarks: null };
  }
}
