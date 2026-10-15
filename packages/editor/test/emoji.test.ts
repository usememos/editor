import { describe, expect, it } from 'vitest';
import { EMOJI_DATA } from '../src/emoji/data';
import { parseEmoji, searchEmoji } from '../src/emoji/search';

const all = parseEmoji(EMOJI_DATA);
const names = (query: string, limit?: number) => searchEmoji(all, query, limit).map((e) => e.names[0]);

describe('emoji data', () => {
  it('has every gemoji emoji with a name', () => {
    expect(all.length).toBeGreaterThan(1800);
    for (const e of all) {
      expect(e.emoji).not.toBe('');
      expect(e.names.length).toBeGreaterThan(0);
    }
    expect(all[0]).toEqual({ emoji: '😀', names: ['grinning'], tags: ['smile', 'happy'] });
  });
});

describe('searchEmoji', () => {
  it('puts an exact name first, then names starting with the query', () => {
    expect(names('tada', 3)[0]).toBe('tada');
    expect(names('smile')[0]).toBe('smile');
    const rest = names('smile');
    expect(rest.indexOf('smiley')).toBeLessThan(rest.indexOf('sweat_smile'));
  });

  it('finds a word inside a name, and tags', () => {
    expect(names('smile')).toContain('sweat_smile');
    // "party" is a tag of 🎉, not a name.
    expect(searchEmoji(all, 'party').map((e) => e.emoji)).toContain('🎉');
  });

  it('ranks a name match above a tag match', () => {
    const results = names('heart');
    expect(results[0]).toBe('heart');
    const tagOnly = all.find((e) => e.tags.includes('heart') && !e.names.some((n) => n.includes('heart')));
    if (tagOnly) expect(results.indexOf(tagOnly.names[0]!)).toBeGreaterThan(results.indexOf('heart_eyes'));
  });

  it('is case-insensitive, honors the limit, and lists the first emoji for an empty query', () => {
    expect(names('TADA', 1)).toEqual(['tada']);
    expect(names('a', 5)).toHaveLength(5);
    expect(names('', 2)).toEqual(['grinning', 'smiley']);
  });

  it('finds +1 and other names with symbols', () => {
    expect(names('+1', 1)).toEqual(['+1']);
    expect(names('-1', 1)).toEqual(['-1']);
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(names('zzzzqqq')).toEqual([]);
  });
});
