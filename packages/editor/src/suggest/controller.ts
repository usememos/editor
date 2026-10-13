// Suggestion popups: opened by typing a trigger, such as "#", "@" or "/".
//
// The editor tells the controller when text was typed and calls `update`
// after every change of the document, the selection or focus. Opening is
// driven by typing; staying open is derived from state: after each change
// the controller finds the token at the caret again, so the session stays
// correct after undo, paste, autocorrect and composition.
//
// The controller keeps the items and the highlighted one. The built-in
// renderer is a `Menu`; with `render: false` there is none, and the app
// draws the popup from `state` and the `suggestionChange` event.

import type { Editor } from '../editor';
import type { SuggestionConfig, SuggestionItem, SuggestionMatch, SuggestionMatcher, SuggestionRange } from '../extensions/suggestion';
import { type Cell, containerContent, inlineText, isCollapsed, isPlainTextBlock, sameCell } from '../model';
import { Menu, type MenuSection, type Placement, isMac } from '../ui/popup';
import { suggestionAnchor, visibleArea } from './anchor';
import { defaultMatcher, excludedAt, longestAt } from './match';
import { SourceRunner } from './source';

/** The open suggestion, for apps that draw their own popup (`render: false`) or show state elsewhere. */
export interface SuggestionState {
  /** The suggestion's name. */
  readonly name: string;
  readonly query: string;
  /** The whole token, from the trigger to its end. */
  readonly range: SuggestionRange;
  /** The items to show, at most `limit`. Empty while there are none yet, or none match. */
  readonly items: readonly SuggestionItem[];
  /** The highlighted item's index, or -1 when there are no items. */
  readonly active: number;
  /** True while newer items are being loaded. */
  readonly loading: boolean;
  /** The ID the root's `aria-controls` names: give it to your `role="listbox"` element. */
  readonly listboxId: string;
  /** The ID of each `role="option"`; the root's `aria-activedescendant` names the active one. */
  optionId(index: number): string;
  /** Where to put the popup: the caret's line, at the trigger's start edge. Null while the trigger is out of view. */
  anchorRect(): DOMRect | null;
}

/** What the controller needs from the editor. */
export interface SuggestionHost {
  readonly editor: Editor;
  readonly root: HTMLElement;
  /** Sets `aria-activedescendant` on the root for the open popup or menu. */
  syncActiveDescendant(): void;
  /** Runs the UI update, which calls `update`. */
  refresh(): void;
  /** Reads a running composition into the model and ends it. */
  endComposition(): void;
  /** Emits `suggestionChange`. */
  changed(state: SuggestionState | null): void;
}

interface Entry {
  config: SuggestionConfig;
  matcher: SuggestionMatcher;
  readonly triggers: readonly string[];
  /** The built-in popup, or null with `render: false`. */
  readonly menu: Menu | null;
  readonly listboxId: string;
  readonly source: SourceRunner<readonly SuggestionItem[]>;
}

/** A token at the caret that a suggestion accepts. */
interface Found extends SuggestionMatch {
  readonly entry: Entry;
  readonly blockId: string;
  readonly cell?: Cell;
  /** The text of the block or cell. */
  readonly text: string;
}

interface Session extends Found {
  /** Opened with Ctrl+Space. */
  readonly explicit: boolean;
  /** The query whose items were last requested. */
  readonly requested?: string;
}

/** How long a popup that appeared late (async items) ignores keys, as CodeMirror's `interactionDelay`. */
const INTERACTION_DELAY = 75;

/** Characters after a token that make the default command leave out its space. */
const NO_SPACE_BEFORE = /[\s.,;:!?)\]}>'"’”»）」』】、。，．：；！？]/;

let listboxCounter = 0;

export class SuggestionController {
  private readonly entries: readonly Entry[];
  private session: Session | null = null;
  /** The token Escape closed the popup for. It stays closed until the caret leaves it. */
  private dismissed: { blockId: string; cell?: Cell; from: number } | null = null;
  /** The items shown, and the highlighted one. */
  private items: readonly SuggestionItem[] = [];
  private active = -1;
  /** A line shown instead of items: the loading row or the empty label. */
  private message: string | null = null;
  /** The side the popup is on. It stays there while open, unless it no longer fits. */
  private side: Placement = 'below';
  private frame: number | null = null;
  /** The last request was made while composing. */
  private requestedComposing = false;
  /** Until this time (ms), the popup takes no keys but Escape. */
  private keysFrom = 0;
  /** What `suggestionChange` last reported, to emit only changes. */
  private reported = '';
  private readonly cleanup: (() => void)[] = [];

  constructor(
    private readonly host: SuggestionHost,
    configs: readonly SuggestionConfig[],
  ) {
    this.entries = configs.map((config) => {
      let menu: Menu | null = null;
      if (config.render !== false) {
        menu = new Menu(host.root, `mbe-suggestion-menu ${config.className ?? ''}`.trim(), 'listbox');
        menu.el.setAttribute('aria-label', config.label ?? host.editor.labels.suggestions);
        // The listbox is only in the document while shown, so it is always expanded.
        menu.el.setAttribute('aria-expanded', 'true');
        menu.onHighlight = (i) => {
          if (this.session?.entry.menu !== menu || this.active === i) return;
          this.active = i;
          this.host.syncActiveDescendant();
          this.report();
        };
      }
      return {
        config,
        matcher: config.match ?? defaultMatcher(config),
        triggers: typeof config.trigger === 'string' ? [config.trigger] : config.trigger,
        menu,
        listboxId: menu?.el.id ?? `mbe-suggestion-${++listboxCounter}`,
        source: new SourceRunner(),
      };
    });
    if (this.entries.length > 0) host.root.setAttribute('aria-autocomplete', 'list');
    // Follow window resizes and the on-screen keyboard. Scrolling comes through `reposition`.
    const view = host.root.ownerDocument.defaultView;
    if (view && this.entries.some((e) => e.menu)) {
      const schedule = () => this.schedule();
      const targets: EventTarget[] = [view];
      if (view.visualViewport) targets.push(view.visualViewport);
      for (const target of targets) {
        for (const type of target === view ? ['resize'] : ['resize', 'scroll']) {
          target.addEventListener(type, schedule);
          this.cleanup.push(() => target.removeEventListener(type, schedule));
        }
      }
    }
  }

  /** True while a suggestion tracks the token at the caret, shown or not. */
  get isActive(): boolean {
    return this.session !== null;
  }

  /** True while the popup shows items, a loading row or the empty label. Its keys work then. */
  get isOpen(): boolean {
    const session = this.session;
    if (!session || !this.shown) return false;
    return session.entry.menu ? session.entry.menu.isOpen : true;
  }

  /** The ID of the highlighted option while the popup is open. */
  get activeDescendant(): string | null {
    return this.isOpen && this.active >= 0 ? `${this.session!.entry.listboxId}-${this.active}` : null;
  }

  /** The open suggestion, or null. */
  get state(): SuggestionState | null {
    const session = this.session;
    if (!session) return null;
    const { entry, blockId, cell, from, to, query } = session;
    const at = (offset: number) => (cell ? { blockId, offset, cell } : { blockId, offset });
    const listboxId = entry.listboxId;
    return {
      name: entry.config.name,
      query,
      range: { from: at(from), to: at(to) },
      items: this.items,
      active: this.active,
      loading: entry.source.pending,
      listboxId,
      optionId: (index) => `${listboxId}-${index}`,
      anchorRect: () => {
        if (this.session !== session) return null;
        const anchor = this.anchor();
        return anchor ? new DOMRect(anchor.rect.left, anchor.rect.top, 0, anchor.rect.bottom - anchor.rect.top) : null;
      },
    };
  }

  private get shown(): boolean {
    return this.items.length > 0 || this.message !== null;
  }

  private get editor(): Editor {
    return this.host.editor;
  }

  /**
   * Takes new configs for the same suggestions, by name, so callbacks
   * (`items`, `command`, `match`, `allow`) can change while the editor runs.
   */
  setConfigs(configs: readonly SuggestionConfig[]): void {
    for (const config of configs) {
      const entry = this.entries.find((e) => e.config.name === config.name);
      if (!entry || entry.config === config) continue;
      if (config.match !== entry.config.match) entry.matcher = config.match ?? defaultMatcher(config);
      entry.config = config;
    }
  }

  /** After typing: opens the suggestion whose token is at the caret, if any. Returns true when one opened. */
  typed(): boolean {
    if (this.entries.length === 0 || !this.editor.isEditable) return false;
    const found = this.find(false);
    if (!found) return false;
    const dismissed = this.dismissed;
    if (dismissed && dismissed.blockId === found.blockId && sameCell(dismissed.cell, found.cell) && dismissed.from === found.from) return false;
    const session = this.session;
    if (session && session.entry === found.entry && session.blockId === found.blockId && sameCell(session.cell, found.cell) && session.from === found.from) {
      return false;
    }
    this.close();
    this.session = { ...found, explicit: false };
    return true;
  }

  /** Opens the popup for the token at the caret, as Ctrl+Space does. Returns false when there is none. */
  open(name?: string): boolean {
    if (!this.editor.isEditable) return false;
    const only = name === undefined ? undefined : this.entries.find((e) => e.config.name === name);
    if (name !== undefined && !only) return false;
    const found = this.find(true, only);
    if (!found) return false;
    this.close();
    this.dismissed = null;
    this.session = { ...found, explicit: true };
    this.host.refresh();
    return true;
  }

  /** Follows the document and the caret: updates the query, or closes. */
  update(focused: boolean): void {
    const dismissed = this.dismissed;
    if (dismissed) {
      const found = focused ? this.find(true) : null;
      if (!found || found.blockId !== dismissed.blockId || !sameCell(found.cell, dismissed.cell) || found.from !== dismissed.from) {
        this.dismissed = null;
      }
    }
    const session = this.session;
    if (!session) return;
    const found = focused && this.editor.isEditable ? this.find(session.explicit, session.entry) : null;
    // The same token: same block and cell, and the same trigger, unless the
    // text changed (an edit before the trigger moves it).
    const same =
      found &&
      found.blockId === session.blockId &&
      sameCell(found.cell, session.cell) &&
      (found.from === session.from || found.text !== session.text);
    if (!same) {
      this.close();
      return;
    }
    this.session = { ...session, ...found };
    this.refresh();
    this.report();
  }

  close(): void {
    const session = this.session;
    if (session) {
      session.entry.menu?.hide();
      if (session.entry.menu) session.entry.menu.busy = false;
      session.entry.source.cancel();
    }
    this.session = null;
    this.items = [];
    this.active = -1;
    this.message = null;
    this.requestedComposing = false;
    this.side = 'below';
    this.keysFrom = 0;
    for (const name of ['aria-activedescendant', 'aria-controls', 'aria-haspopup']) this.host.root.removeAttribute(name);
    this.report();
  }

  /** Moves the highlight by `delta` items, wrapping around. */
  move(delta: number): void {
    if (!this.session || this.items.length === 0) return;
    this.highlight((((this.active + delta) % this.items.length) + this.items.length) % this.items.length);
  }

  /** Picks the item at `index`, or the highlighted one. Returns false when there is none. */
  accept(index = this.active): boolean {
    const item = this.items[index];
    if (!this.session || !item) return false;
    this.pick(item);
    return true;
  }

  /**
   * Handles a key while the popup is open. Returns true when the key was
   * taken; the caller then prevents its default. Only the popup's keys are
   * taken: arrows, Page Up and Down, Enter, Tab, Escape, and Ctrl+N and
   * Ctrl+P on macOS.
   */
  keydown(e: KeyboardEvent): boolean {
    if (!this.isOpen) return false;
    const plain = !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey;
    if (plain && e.key === 'Escape') {
      this.dismiss();
      return true;
    }
    const emacs = isMac && e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
    const key = e.key;
    let action: 'down' | 'up' | 'pageDown' | 'pageUp' | 'accept' | null = null;
    if (plain && key === 'ArrowDown') action = 'down';
    else if (plain && key === 'ArrowUp') action = 'up';
    else if (emacs && key.toLowerCase() === 'n') action = 'down';
    else if (emacs && key.toLowerCase() === 'p') action = 'up';
    else if (plain && key === 'PageDown') action = 'pageDown';
    else if (plain && key === 'PageUp') action = 'pageUp';
    else if (plain && (key === 'Enter' || key === 'Tab')) action = 'accept';
    if (!action || Date.now() < this.keysFrom) return false;
    if (this.items.length === 0) {
      // A loading row or the empty label: Enter closes the popup and keeps its meaning.
      if (key === 'Enter') this.close();
      return false;
    }
    const menu = this.session!.entry.menu;
    if (action === 'down') this.move(1);
    else if (action === 'up') this.move(-1);
    else if (action === 'accept') this.accept();
    else if (menu) menu.page(action === 'pageDown' ? 1 : -1);
    else this.highlight(Math.max(0, Math.min(this.items.length - 1, this.active + (action === 'pageDown' ? 8 : -8))));
    return true;
  }

  /** Closes the popup and keeps it closed for this token (Escape). */
  dismiss(): void {
    const session = this.session;
    if (session) this.dismissed = { blockId: session.blockId, cell: session.cell, from: session.from };
    this.close();
  }

  /** Closes the popup and forgets dismissed tokens, as when the document is replaced. */
  reset(): void {
    this.dismissed = null;
    this.close();
  }

  /** Follows scrolling, resizing and the on-screen keyboard. */
  reposition(): void {
    if (this.session && this.shown) this.place();
  }

  destroy(): void {
    this.close();
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    for (const fn of this.cleanup) fn();
    for (const { menu } of this.entries) menu?.destroy();
  }

  private schedule(): void {
    if (this.frame !== null || !this.shown) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.reposition();
    });
  }

  private highlight(index: number): void {
    const menu = this.session?.entry.menu;
    // The menu reports the new index through onHighlight.
    if (menu) menu.highlight(index);
    else if (this.active !== index) {
      this.active = index;
      this.host.syncActiveDescendant();
      this.report();
    }
  }

  /** Emits `suggestionChange` when the state differs from the last one reported. */
  private report(): void {
    const s = this.session;
    const key = s
      ? `${s.entry.config.name}\n${s.blockId}\n${s.cell?.row},${s.cell?.col}\n${s.from}\n${s.to}\n${s.query}\n${this.active}\n${s.entry.source.pending}\n${this.message}`
      : '';
    if (key === this.reported && !(s && this.itemsChanged)) return;
    this.reported = key;
    this.itemsChanged = false;
    this.host.changed(this.state);
  }

  private itemsChanged = false;

  /**
   * The token at the caret that a suggestion accepts. When several do, the
   * one that starts closest to the caret wins; on a tie, the earlier one.
   */
  private find(explicit: boolean, only?: Entry): Found | null {
    const { doc, selection } = this.editor.state;
    if (!isCollapsed(selection)) return null;
    const pos = selection.focus;
    const block = doc.blocks.find((b) => b.id === pos.blockId);
    // Code and raw blocks are plain text: never a popup there.
    if (!block || isPlainTextBlock(block)) return null;
    const content = containerContent(block, pos.cell);
    if (!content) return null;
    const text = inlineText(content);
    const caret = pos.offset;
    let best: Found | null = null;
    for (const entry of only ? [only] : this.entries) {
      const match = entry.matcher({ text, caret, content, triggers: entry.triggers });
      if (!match || (best && match.from <= best.from)) continue;
      if (match.from < 0 || match.from >= caret || match.to < caret || match.to > text.length) continue;
      if (!longestAt(text, match.from, entry.triggers, caret)) continue;
      if (match.query.length > (entry.config.maxLength ?? 30)) continue;
      const excluded = excludedAt(content, match.from);
      const allow = entry.config.allow;
      const allowed = allow
        ? allow({ editor: this.editor, block, cell: pos.cell, from: match.from, query: match.query, textBefore: text.slice(0, match.from), excluded, explicit })
        : !excluded;
      if (!allowed) continue;
      best = { ...match, entry, blockId: block.id, cell: pos.cell, text };
    }
    return best;
  }

  /** Asks for items when the query changed, and shows them when they arrive. */
  private refresh(): void {
    const session = this.session!;
    const { menu, source } = session.entry;
    const query = session.query;
    const composing = this.editor.isComposing;
    // A result asked for while composing may have been kept although empty; ask again once composing ends.
    if (session.requested === query && !(this.requestedComposing && !composing)) {
      // Same query: only follow the caret. Rebuilding would reset the item the user moved to.
      if (this.shown) this.place();
      return;
    }
    this.session = { ...session, requested: query };
    const current = this.session;
    const entry = current.entry;
    const live = () => this.session?.entry === entry && this.session.requested === query;
    let sync = true;
    const show = (result: readonly SuggestionItem[] | null) => {
      if (!live()) return;
      const config = entry.config;
      if (menu) menu.busy = false;
      const items = (result ?? []).slice(0, config.limit ?? 50);
      // While composing, the text is often a reading that matches nothing yet (Pinyin "gongzuo" before
      // it becomes 工作): keep the list shown.
      if (items.length === 0 && composing && this.items.length > 0) return this.report();
      const empty = items.length === 0 && (!config.emptyLabel || query.length > 3);
      // Keys wait a moment after a popup appears late, so a key pressed before the user saw it does not pick.
      if (!empty && !sync && !this.isOpen) this.keysFrom = Date.now() + INTERACTION_DELAY;
      // The highlight stays on the same item (by `id`) when it is still there.
      const activeId = this.items[this.active]?.id;
      const kept = activeId === undefined ? -1 : items.findIndex((item) => item.id === activeId);
      const active = items.length === 0 ? -1 : Math.max(0, kept);
      this.items = items;
      this.active = active;
      this.message = items.length === 0 && !empty ? config.emptyLabel! : null;
      this.itemsChanged = true;
      if (menu) {
        if (empty) menu.hide();
        else {
          menu.setSections(sections(items, query, (item) => this.pick(item)), config.emptyLabel);
          menu.highlight(active);
        }
      }
      if (empty) {
        this.host.root.removeAttribute('aria-haspopup');
        this.host.root.removeAttribute('aria-controls');
        this.host.syncActiveDescendant();
      } else {
        this.place();
      }
      this.report();
    };
    // Nothing shown yet after a while: a loading row, which is not an option.
    const loading = () => {
      if (!live() || this.shown) return this.report();
      this.message = this.editor.labels.loading;
      menu?.setMessage(this.message, 'mbe-menu-loading');
      this.place();
      this.report();
    };
    this.requestedComposing = composing;
    source.run(
      (signal) => entry.config.items({ query, editor: this.editor, explicit: current.explicit, composing, signal }),
      { show, loading },
      entry.config.debounce ?? 0,
    );
    sync = false;
    // The items shown stay usable while newer ones load.
    if (source.pending && menu?.isOpen) menu.busy = true;
  }

  /** The popup's anchor, or null while the trigger is out of view. */
  private anchor() {
    const session = this.session!;
    const at = (offset: number) => (session.cell ? { blockId: session.blockId, offset, cell: session.cell } : { blockId: session.blockId, offset });
    const end = session.from + (longestAt(session.text, session.from, session.entry.triggers)?.length ?? 1);
    const trigger = this.editor.textRect(at(session.from), at(end));
    return suggestionAnchor(trigger?.rect ?? null, this.editor.caretRect(), trigger?.rtl ?? false, visibleArea(this.host.root));
  }

  /** Shows the popup under the caret's line, lined up with the trigger, or hides it while the trigger is out of view. */
  private place(): void {
    const session = this.session!;
    const { menu, listboxId } = session.entry;
    const root = this.host.root;
    const anchor = menu ? this.anchor() : null;
    if (menu && anchor) menu.popup.show(anchor.rect, this.side, 4, anchor.align);
    else menu?.hide();
    if (menu) this.side = menu.popup.side;
    if (this.isOpen) {
      root.setAttribute('aria-haspopup', 'listbox');
      root.setAttribute('aria-controls', listboxId);
    } else {
      root.removeAttribute('aria-haspopup');
      root.removeAttribute('aria-controls');
    }
    this.host.syncActiveDescendant();
  }

  private pick(item: SuggestionItem): void {
    // A click while composing: commit the composed text first, then pick for the token as it is now.
    if (this.editor.isComposing) this.host.endComposition();
    const session = this.session;
    if (!session) return;
    const { entry, blockId, cell, from, to, query, text } = session;
    const at = (offset: number) => (cell ? { blockId, offset, cell } : { blockId, offset });
    const range: SuggestionRange = { from: at(from), to: at(to) };
    this.close();
    if (entry.config.command) {
      entry.config.command({ editor: this.editor, range, item, query });
      return;
    }
    const next = text[to];
    const space = next !== undefined && NO_SPACE_BEFORE.test(next) ? '' : ' ';
    this.editor.commands.insertText(entry.triggers[0] + (item.value ?? item.id ?? item.label) + space, { range });
  }
}

function itemId(item: SuggestionItem, index: number): string {
  return item.id ?? `${index}`;
}

/** Menu sections for items: a new section starts where `section` changes. */
function sections(items: readonly SuggestionItem[], query: string, pick: (item: SuggestionItem) => void): MenuSection[] {
  const out: MenuSection[] = [];
  items.forEach((item, i) => {
    let last = out[out.length - 1];
    if (!last || item.section !== last.title) out.push((last = { title: item.section, items: [] }));
    last.items.push({ id: itemId(item, i), label: item.label, detail: item.detail, icon: item.icon, mark: query, run: () => pick(item) });
  });
  return out;
}
