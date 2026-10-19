import { describe, expect, it } from 'vitest';
import { mergeClasses, shadcnTheme, tokenProperties } from '../src/theme';

describe('mergeClasses', () => {
  it('lets a later map win per key, and merges heading and token per entry', () => {
    expect(
      mergeClasses([
        { paragraph: 'a', heading: { 1: 'h1-a', 2: 'h2-a' }, token: { math: 'm-a' } },
        undefined,
        { paragraph: 'b', heading: { 1: 'h1-b' }, token: { footnote: 'f-b' }, link: undefined },
      ]),
    ).toEqual({ paragraph: 'b', heading: { 1: 'h1-b', 2: 'h2-a' }, token: { math: 'm-a', footnote: 'f-b' } });
  });
});

describe('tokenProperties', () => {
  it('writes colors per scheme and sizes in pixels', () => {
    expect(
      Object.fromEntries(
        tokenProperties({
          light: { text: 'red', codeBackground: '#eee', link: '' },
          dark: { text: 'white' },
          font: 'Inter',
          fontSize: 15,
          radius: '0.5rem',
        }),
      ),
    ).toEqual({
      '--mbe-text-light': 'red',
      '--mbe-code-bg-light': '#eee',
      '--mbe-text-dark': 'white',
      '--mbe-font': 'Inter',
      '--mbe-font-size': '15px',
      '--mbe-radius': '0.5rem',
    });
    expect(tokenProperties(undefined).size).toBe(0);
  });

  it('writes colors to both schemes, and light and dark win per scheme', () => {
    expect(
      Object.fromEntries(
        tokenProperties({
          colors: { text: 'var(--fg)', accent: 'var(--primary)', highlight: 'var(--mark)' },
          dark: { accent: 'white', text: undefined },
        }),
      ),
    ).toEqual({
      '--mbe-text-light': 'var(--fg)',
      '--mbe-accent-light': 'var(--primary)',
      '--mbe-highlight-light': 'var(--mark)',
      '--mbe-text-dark': 'var(--fg)',
      '--mbe-accent-dark': 'white',
      '--mbe-highlight-dark': 'var(--mark)',
    });
  });

  it('shadcnTheme reads every color from a shadcn variable, in both schemes', () => {
    const props = tokenProperties(shadcnTheme.tokens);
    const colors = [...props].filter(([name]) => /-(light|dark)$/.test(name));
    expect(colors.length).toBe(16);
    for (const [, value] of colors) expect(value).toMatch(/^var\(--[a-z-]+\)$/);
    expect(props.get('--mbe-radius')).toBe('calc(var(--radius) - 2px)');
    expect(shadcnTheme.colorScheme).toBeUndefined();
  });
});
