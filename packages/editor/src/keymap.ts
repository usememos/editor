// Matching keyboard events against ProseMirror-style key names
// ("Mod-Shift-7", "Ctrl-Enter", "Escape").

import type { KeyHandler } from './extension';

interface Binding {
  readonly key: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
  readonly handler: KeyHandler;
}

export function parseKeyName(name: string, handler: KeyHandler, mac: boolean): Binding {
  const parts = name.split(/-(?!$)/);
  let key = parts.pop()!;
  let ctrl = false;
  let alt = false;
  let shift = false;
  let meta = false;
  for (const mod of parts) {
    if (/^(cmd|meta|m)$/i.test(mod)) meta = true;
    else if (/^a(lt)?$/i.test(mod)) alt = true;
    else if (/^(c|ctrl|control)$/i.test(mod)) ctrl = true;
    else if (/^s(hift)?$/i.test(mod)) shift = true;
    else if (/^mod$/i.test(mod)) {
      if (mac) meta = true;
      else ctrl = true;
    } else throw new Error(`Unrecognized modifier name: ${mod}`);
  }
  if (key === 'Space') key = ' ';
  return { key: key.length === 1 ? key.toLowerCase() : key, ctrl, alt, shift, meta, handler };
}

/** The key without layout or Shift effects: "KeyB" → "b", "Digit7" → "7". */
function baseKey(e: KeyboardEvent): string | null {
  const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(e.code);
  return m ? (m[1] ?? m[2]!).toLowerCase() : null;
}

export function matchesKey(binding: Binding, e: KeyboardEvent): boolean {
  if (binding.ctrl !== e.ctrlKey || binding.alt !== e.altKey || binding.meta !== e.metaKey) return false;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  // A printable key typed with Shift (like "?") matches without "Shift-" in the name.
  if (key === binding.key && (binding.shift === e.shiftKey || (e.key.length === 1 && !binding.shift && /[^a-z0-9]/.test(key)))) {
    return true;
  }
  // With Shift or Alt the character changes ("Shift-7" types "&"), so fall back to the physical key.
  return binding.shift === e.shiftKey && baseKey(e) === binding.key;
}

export type { Binding };
