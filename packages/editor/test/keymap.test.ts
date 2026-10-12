import { describe, expect, it } from 'vitest';
import { matchesKey, parseKeyName } from '../src/keymap';

const handler = () => true;
const key = (init: Partial<KeyboardEvent>) =>
  ({ key: '', code: '', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...init }) as KeyboardEvent;

describe('key names', () => {
  it('maps Mod to Cmd on macOS and to Ctrl elsewhere', () => {
    expect(matchesKey(parseKeyName('Mod-b', handler, true), key({ key: 'b', code: 'KeyB', metaKey: true }))).toBe(true);
    expect(matchesKey(parseKeyName('Mod-b', handler, true), key({ key: 'b', code: 'KeyB', ctrlKey: true }))).toBe(false);
    expect(matchesKey(parseKeyName('Mod-b', handler, false), key({ key: 'b', code: 'KeyB', ctrlKey: true }))).toBe(true);
  });

  it('requires the exact modifiers', () => {
    const b = parseKeyName('Mod-Shift-z', handler, false);
    expect(matchesKey(b, key({ key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(matchesKey(b, key({ key: 'z', code: 'KeyZ', ctrlKey: true }))).toBe(false);
    expect(matchesKey(parseKeyName('Enter', handler, false), key({ key: 'Enter', ctrlKey: true }))).toBe(false);
  });

  it('falls back to the physical key when Shift or Alt changes the character', () => {
    expect(matchesKey(parseKeyName('Mod-Shift-7', handler, false), key({ key: '&', code: 'Digit7', ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(matchesKey(parseKeyName('Mod-Alt-1', handler, true), key({ key: '¡', code: 'Digit1', metaKey: true, altKey: true }))).toBe(true);
    expect(matchesKey(parseKeyName('Mod-Alt-c', handler, true), key({ key: 'ç', code: 'KeyC', metaKey: true, altKey: true }))).toBe(true);
  });

  it('matches named keys', () => {
    expect(matchesKey(parseKeyName('Shift-Tab', handler, false), key({ key: 'Tab', shiftKey: true }))).toBe(true);
    expect(matchesKey(parseKeyName('Escape', handler, false), key({ key: 'Escape' }))).toBe(true);
    expect(matchesKey(parseKeyName('Ctrl-Enter', handler, true), key({ key: 'Enter', ctrlKey: true }))).toBe(true);
  });
});
