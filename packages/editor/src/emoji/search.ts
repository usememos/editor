// Finding emoji by name for the `emoji()` extension.

export interface Emoji {
  /** The character, such as "🎉". */
  readonly emoji: string;
  /** Its names, the first the main one, such as ["tada"]. Typed as `:tada:` on GitHub. */
  readonly names: readonly string[];
  /** Other words it is found by, such as ["party"]. */
  readonly tags: readonly string[];
}

/** Reads the lines of `data.ts`: the emoji, its names and its tags, separated by tabs. */
export function parseEmoji(data: string): Emoji[] {
  return data.split('\n').map((line) => {
    const [emoji = '', names = '', tags = ''] = line.split('\t');
    return { emoji, names: names.split(' ').filter(Boolean), tags: tags.split(' ').filter(Boolean) };
  });
}

/**
 * Emoji whose names or tags match `query`, best first: a name equal to it,
 * a name starting with it, a word of a name starting with it ("smile" finds
 * "sweat_smile"), a tag starting with it, then a name containing it. Within
 * a rank the data's order is kept, which puts common emoji first.
 */
export function searchEmoji(emoji: readonly Emoji[], query: string, limit = Infinity): Emoji[] {
  const q = query.toLowerCase();
  if (!q) return emoji.slice(0, limit);
  const ranked: Emoji[][] = [[], [], [], [], []];
  for (const e of emoji) {
    const rank = rankOf(e, q);
    if (rank !== null) ranked[rank]!.push(e);
  }
  return ranked.flat().slice(0, limit);
}

function rankOf(e: Emoji, q: string): number | null {
  let best: number | null = null;
  const take = (rank: number) => {
    if (best === null || rank < best) best = rank;
  };
  for (const name of e.names) {
    if (name === q) return 0;
    if (name.startsWith(q)) take(1);
    else if (name.includes(`_${q}`) || name.includes(`-${q}`)) take(2);
    else if (name.includes(q)) take(4);
  }
  if (best === null || best > 3) for (const tag of e.tags) if (tag.startsWith(q)) take(3);
  return best;
}
