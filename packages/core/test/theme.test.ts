import { describe, expect, it } from 'vitest';
import { mergeClasses, tokenProperties } from '../src/theme';

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
});
