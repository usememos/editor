// The editor view: one contentEditable root that the editor fully owns.
//
// Input strategy ("model first, DOM fallback"):
// 1. Most edits arrive as `beforeinput` events. We cancel them, apply the
//    matching command to the model, and re-render the changed blocks.
// 2. IME composition cannot be cancelled. During composition the browser
//    edits the DOM itself and we do not touch it. On `compositionend` we read
//    the changed text back from the DOM and apply it to the model.
// 3. Any other `input` that slipped through (e.g. some Android keyboards) is
//    reconciled the same way as composition.

import * as cmd from './commands';
import { type ChangeKind, History } from './history';
import { parseMarkdown } from './markdown/parse';
import { serializeMarkdown } from './markdown/serialize';
import {
  type Doc,
  type EditorState,
  type Mark,
  type Position,
  type Selection,
  blockIndex,
  caret,
  createState,
  getBlock,
  inlineText,
  isCollapsed,
} from './model';
import { BlockRenderer, domText, domToPosition, positionToDom } from './view/dom';

export interface EditorOptions {
  /** Initial Markdown. */
  value?: string;
  /** Called with the new Markdown after every change to the document. */
  onChange?: (markdown: string, editor: Editor) => void;
  /** Shown in an empty first block. */
  placeholder?: string;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform);

export class Editor {
  readonly root: HTMLElement;
  private state: EditorState;
  private readonly history = new History();
  private readonly renderer: BlockRenderer;
  private composing = false;
  private readonly options: EditorOptions;
  private readonly cleanup: (() => void)[] = [];

  constructor(root: HTMLElement, options: EditorOptions = {}) {
    this.root = root;
    this.options = options;
    this.state = createState(parseMarkdown(options.value ?? ''));
    this.renderer = new BlockRenderer(root);

    root.contentEditable = 'true';
    root.spellcheck = true;
    root.classList.add('mbe-root');
    root.setAttribute('role', 'textbox');
    root.setAttribute('aria-multiline', 'true');
    if (options.placeholder) root.style.setProperty('--mbe-placeholder', JSON.stringify(options.placeholder));

    this.listen(root, 'beforeinput', (e) => this.onBeforeInput(e as InputEvent));
    this.listen(root, 'input', (e) => this.onInput(e as InputEvent));
    this.listen(root, 'compositionstart', () => this.onCompositionStart());
    this.listen(root, 'compositionend', () => this.onCompositionEnd());
    this.listen(root, 'keydown', (e) => this.onKeyDown(e as KeyboardEvent));
    this.listen(root, 'copy', (e) => this.onCopy(e as ClipboardEvent, false));
    this.listen(root, 'cut', (e) => this.onCopy(e as ClipboardEvent, true));
    this.listen(root, 'paste', (e) => this.onPaste(e as ClipboardEvent));
    this.listen(root, 'dragstart', (e) => e.preventDefault());
    this.listen(root, 'drop', (e) => e.preventDefault());
    this.listen(root.ownerDocument, 'selectionchange', () => this.onSelectionChange());

    this.renderer.render(this.state.doc);
  }

  // -------------------------------------------------------------------------
  // Public API

  getMarkdown(): string {
    return serializeMarkdown(this.state.doc);
  }

  /** Replaces the whole document. Clears undo history. */
  setMarkdown(markdown: string): void {
    this.state = createState(parseMarkdown(markdown));
    this.renderer.render(this.state.doc, true);
    this.syncDomSelection();
  }

  getState(): EditorState {
    return this.state;
  }

  getDoc(): Doc {
    return this.state.doc;
  }

  focus(): void {
    this.root.focus();
    this.syncDomSelection();
  }

  /** Applies a command, records history, re-renders, and notifies onChange. */
  run(command: (state: EditorState) => EditorState | null, kind: ChangeKind = 'other'): boolean {
    const next = command(this.state);
    if (!next || next === this.state) return false;
    this.apply(next, kind);
    return true;
  }

  toggleMark(mark: Mark): boolean {
    return this.run((s) => cmd.toggleMark(s, mark));
  }

  undo(): boolean {
    const next = this.history.undo(this.state);
    if (!next) return false;
    this.commit(next);
    return true;
  }

  redo(): boolean {
    const next = this.history.redo(this.state);
    if (!next) return false;
    this.commit(next);
    return true;
  }

  destroy(): void {
    for (const fn of this.cleanup) fn();
    this.root.contentEditable = 'false';
    this.root.replaceChildren();
  }

  // -------------------------------------------------------------------------
  // State updates

  private apply(next: EditorState, kind: ChangeKind): void {
    if (next.doc !== this.state.doc) this.history.record(this.state, kind);
    this.commit(next);
  }

  private commit(next: EditorState): void {
    const docChanged = next.doc !== this.state.doc;
    this.state = next;
    this.renderer.render(next.doc);
    this.syncDomSelection();
    if (docChanged) this.options.onChange?.(this.getMarkdown(), this);
  }

  private syncDomSelection(): void {
    const sel = this.root.ownerDocument.getSelection();
    if (!sel || this.root.ownerDocument.activeElement !== this.root) return;
    const anchor = this.toDom(this.state.selection.anchor);
    const focus = this.toDom(this.state.selection.focus);
    if (!anchor || !focus) return;
    if (
      sel.anchorNode === anchor.node &&
      sel.anchorOffset === anchor.offset &&
      sel.focusNode === focus.node &&
      sel.focusOffset === focus.offset
    ) {
      return;
    }
    sel.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
  }

  private toDom(pos: Position): { node: Node; offset: number } | null {
    const el = this.renderer.elementFor(pos.blockId);
    return el ? positionToDom(el, pos.offset) : null;
  }

  private readDomSelection(): Selection | null {
    const sel = this.root.ownerDocument.getSelection();
    if (!sel || !sel.anchorNode || !sel.focusNode) return null;
    if (!this.root.contains(sel.anchorNode) || !this.root.contains(sel.focusNode)) return null;
    const anchor = domToPosition(this.root, sel.anchorNode, sel.anchorOffset);
    const focus = domToPosition(this.root, sel.focusNode, sel.focusOffset);
    if (!anchor || !focus) return null;
    return { anchor, focus };
  }

  private onSelectionChange(): void {
    if (this.composing) return;
    const selection = this.readDomSelection();
    if (!selection) return;
    const cur = this.state.selection;
    const same =
      selection.anchor.blockId === cur.anchor.blockId &&
      selection.anchor.offset === cur.anchor.offset &&
      selection.focus.blockId === cur.focus.blockId &&
      selection.focus.offset === cur.focus.offset;
    if (same) return;
    this.state = { ...this.state, selection, storedMarks: null };
    this.history.breakGroup();
  }

  /** The browser selection is the source of truth when an event starts. */
  private refreshSelection(): void {
    const selection = this.readDomSelection();
    if (selection) this.state = { ...this.state, selection };
  }

  /** Sets the model selection to the range the browser says an input event affects. */
  private targetRange(e: InputEvent): Selection | null {
    const ranges = e.getTargetRanges?.() ?? [];
    const r = ranges[0];
    if (!r) return null;
    const anchor = domToPosition(this.root, r.startContainer, r.startOffset);
    const focus = domToPosition(this.root, r.endContainer, r.endOffset);
    return anchor && focus ? { anchor, focus } : null;
  }

  // -------------------------------------------------------------------------
  // Input

  private onBeforeInput(e: InputEvent): void {
    if (this.composing || e.isComposing) return;
    const type = e.inputType;
    if (type === 'insertCompositionText' || type === 'deleteCompositionText' || type === 'insertFromComposition') return;

    e.preventDefault();
    this.refreshSelection();

    switch (type) {
      case 'insertText': {
        const text = e.data ?? '';
        if (!text) return;
        this.run((s) => cmd.insertText(s, text), 'typing');
        if (text === ' ') this.run(cmd.applyInputRules);
        return;
      }
      case 'insertReplacementText': {
        const text = e.dataTransfer?.getData('text/plain') ?? e.data ?? '';
        const range = this.targetRange(e);
        this.run((s) => cmd.insertText(range ? { ...s, selection: range } : s, text));
        return;
      }
      case 'insertParagraph':
      case 'insertLineBreak':
        // Hard line breaks inside a block are not in the model yet, so Shift+Enter also splits.
        this.run(cmd.splitBlock);
        return;
      case 'deleteContentBackward':
        this.run(cmd.deleteBackward);
        return;
      case 'deleteContentForward':
        this.run(cmd.deleteForward);
        return;
      case 'deleteWordBackward':
      case 'deleteWordForward':
      case 'deleteSoftLineBackward':
      case 'deleteSoftLineForward':
      case 'deleteHardLineBackward':
      case 'deleteHardLineForward':
      case 'deleteEntireSoftLine': {
        if (!isCollapsed(this.state.selection)) {
          this.run(cmd.deleteSelection);
          return;
        }
        const range = this.targetRange(e);
        if (range && !isCollapsed(range)) {
          this.run((s) => cmd.deleteSelection({ ...s, selection: range }));
        } else {
          this.run(type.endsWith('Backward') ? cmd.deleteBackward : cmd.deleteForward);
        }
        return;
      }
      case 'historyUndo':
        this.undo();
        return;
      case 'historyRedo':
        this.redo();
        return;
      case 'formatBold':
        this.toggleMark('bold');
        return;
      case 'formatItalic':
        this.toggleMark('italic');
        return;
      case 'formatStrikeThrough':
        this.toggleMark('strike');
        return;
      default:
        // Paste, cut and drop have their own handlers. Everything else is ignored
        // so the browser never changes the DOM behind the model's back.
        return;
    }
  }

  private onCompositionStart(): void {
    this.refreshSelection();
    // Replace a non-collapsed selection before the browser starts composing,
    // so the composition always happens inside one block.
    if (!isCollapsed(this.state.selection)) {
      this.run(cmd.deleteSelection);
    }
    this.composing = true;
  }

  private onCompositionEnd(): void {
    this.composing = false;
    // A committed composition is its own undo step.
    this.reconcileFromDom('other');
  }

  private onInput(e: InputEvent): void {
    if (this.composing || e.isComposing) return;
    // Only reached when the browser changed the DOM despite beforeinput.
    this.reconcileFromDom('typing');
  }

  /**
   * Reads block text back from the DOM and applies the difference to the
   * model as one insert/delete per changed block.
   */
  private reconcileFromDom(kind: ChangeKind): void {
    let state = this.state;
    let changed = false;
    for (const block of state.doc.blocks) {
      const el = this.renderer.elementFor(block.id);
      if (!el || !el.isConnected) continue;
      const oldText = inlineText(block.content);
      const newText = domText(el);
      if (oldText === newText) continue;

      let start = 0;
      while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) start++;
      let endOld = oldText.length;
      let endNew = newText.length;
      while (endOld > start && endNew > start && oldText[endOld - 1] === newText[endNew - 1]) {
        endOld--;
        endNew--;
      }
      const inserted = newText.slice(start, endNew);
      const at = { blockId: block.id, offset: start };
      state = cmd.deleteRange(state, at, { blockId: block.id, offset: endOld });
      if (inserted) state = cmd.insertText({ ...state, storedMarks: this.state.storedMarks }, inserted);
      this.renderer.invalidate(block.id);
      changed = true;
    }
    if (!changed) {
      // Text is unchanged but the browser may have altered structure.
      this.renderer.render(this.state.doc, true);
      this.syncDomSelection();
      return;
    }
    const selection = this.readDomSelection() ?? state.selection;
    this.apply({ ...state, selection: clampSelection(state.doc, selection) }, kind);
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.isComposing || e.keyCode === 229) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const key = e.key.toLowerCase();
    const handled = (fn: () => unknown) => {
      e.preventDefault();
      this.refreshSelection();
      fn();
    };

    if (mod && !e.altKey) {
      if (key === 'z' && !e.shiftKey) return handled(() => this.undo());
      if ((key === 'z' && e.shiftKey) || (key === 'y' && !isMac)) return handled(() => this.redo());
      if (key === 'b') return handled(() => this.toggleMark('bold'));
      if (key === 'i') return handled(() => this.toggleMark('italic'));
      if (key === 'e') return handled(() => this.toggleMark('code'));
      if (key === 'x' && e.shiftKey) return handled(() => this.toggleMark('strike'));
    }
    if (e.altKey && !mod && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      return handled(() => this.run((s) => cmd.moveBlocks(s, e.key === 'ArrowUp' ? -1 : 1)));
    }
    if (e.key === 'Tab') {
      // Reserved for list indentation. Keep focus in the editor.
      e.preventDefault();
    }
  }

  private onCopy(e: ClipboardEvent, cut: boolean): void {
    this.refreshSelection();
    if (isCollapsed(this.state.selection) || !e.clipboardData) return;
    e.preventDefault();
    const markdown = serializeMarkdown({ blocks: cmd.selectedBlocks(this.state) });
    e.clipboardData.setData('text/plain', markdown.replace(/\n$/, ''));
    if (cut) this.run(cmd.deleteSelection);
  }

  private onPaste(e: ClipboardEvent): void {
    e.preventDefault();
    this.refreshSelection();
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;
    const fragment = parseMarkdown(text).blocks;
    this.run((s) => cmd.insertBlocks(s, fragment));
  }

  private listen(target: EventTarget, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn);
    this.cleanup.push(() => target.removeEventListener(type, fn));
  }
}

function clampSelection(doc: Doc, sel: Selection): Selection {
  const clamp = (p: Position): Position => {
    if (blockIndex(doc, p.blockId) < 0) {
      const first = doc.blocks[0]!;
      return caret(first.id, 0).anchor;
    }
    const len = inlineText(getBlock(doc, p.blockId).content).length;
    return { blockId: p.blockId, offset: Math.min(p.offset, len) };
  };
  return { anchor: clamp(sel.anchor), focus: clamp(sel.focus) };
}

