// GFM autolink literals, and #tag and @mention as plain text: how they are
// read, highlighted, typed and saved.

import { describe, expect, it } from 'vitest';
import { applyAutolinkInputRule, applyTokenInputRules, insertText } from '../src/commands';
import { decorationContext } from '../src/decorations';
import { mentions, scanMentions, scanTags, tags } from '../src/extensions/tags';
import type { MarkdownOptions } from '../src/markdown/options';
import { parseMarkdown } from '../src/markdown/parse';
import { serializeMarkdown } from '../src/markdown/serialize';
import { type Inline, type Span, caret, createState, inlineText, paragraph } from '../src/model';

const TAGS: MarkdownOptions = { syntax: [tags().markdown!, mentions().markdown!] };

const content = (md: string, options?: MarkdownOptions): Inline => {
  const block = parseMarkdown(md, options).blocks[0]!;
  return 'content' in block ? block.content : [];
};
const describeSpans = (inline: Inline) =>
  inline.map((s: Span) => (s.link ? `[${s.text}](${s.link})` : s.token ? `{${s.token}:${s.text}}` : s.text));
/** Saving without the source: how an edited block is written. */
const rewrite = (md: string, options?: MarkdownOptions) => serializeMarkdown(parseMarkdown(md, options), options);
const found = (ranges: Iterable<{ from: number; to: number }>, text: string) => [...ranges].map((r) => text.slice(r.from, r.to));

describe('autolink literals', () => {
  it('links www., http(s):// and ftp:// URLs and e-mail addresses', () => {
    expect(describeSpans(content('See https://x.com/a_b, www.example.org. Mail a.b-c_d@a.b!'))).toEqual([
      'See ',
      '[https://x.com/a_b](https://x.com/a_b)',
      ', ',
      '[www.example.org](http://www.example.org)',
      '. Mail ',
      '[a.b-c_d@a.b](mailto:a.b-c_d@a.b)',
      '!',
    ]);
    expect(describeSpans(content('(https://x.com/a_(b)) ftp://f.org'))).toEqual([
      '(',
      '[https://x.com/a_(b)](https://x.com/a_(b))',
      ') ',
      '[ftp://f.org](ftp://f.org)',
    ]);
  });

  it('does not link inside link text, code, or after a letter', () => {
    expect(describeSpans(content('[see www.x.com](http://y)'))).toEqual(['[see www.x.com](http://y)']);
    expect(describeSpans(content('`https://x.com` xhttps://x.com'))).toEqual(['https://x.com', ' xhttps://x.com']);
  });

  it('is off with autolinks: false', () => {
    expect(describeSpans(content('https://x.com', { autolinks: false }))).toEqual(['https://x.com']);
  });

  it('saves literal links bare, and in brackets where bare would not read back', () => {
    expect(rewrite('[www.x.com](http://www.x.com), <https://y.org> and <me@x.y>')).toBe('www.x.com, https://y.org and me@x.y\n');
    expect(rewrite('**https://x.com**')).toBe('**https://x.com**\n');
    // Bare, the "*" after the URL would be part of it.
    expect(rewrite('<https://x.com>\\*')).toBe('<https://x.com>\\*\n');
    expect(serializeMarkdown(parseMarkdown('<https://y.org>'), { autolinks: false })).toBe('<https://y.org>\n');
  });

  it('saves a URL that is plain text so it does not read back as a link', () => {
    const doc = { blocks: [paragraph([{ text: 'see https://x.com and www.y.org, not xhttps://z.com', marks: [] }])] };
    const md = serializeMarkdown(doc);
    expect(md).toBe('see https\\://x.com and www\\.y.org, not xhttps://z.com\n');
    expect(describeSpans(content(md))).toEqual(['see https://x.com and www.y.org, not xhttps://z.com']);
    // Link text and code are never read as literals, and without autolinks nothing is escaped.
    expect(rewrite('[https://x.com](https://y.org) `www.z.org`')).toBe('[https://x.com](https://y.org) `www.z.org`\n');
    expect(serializeMarkdown(doc, { autolinks: false })).toBe('see https://x.com and www.y.org, not xhttps://z.com\n');
  });

  it('saves an e-mail address that is plain text so it does not read back as a link', () => {
    const doc = { blocks: [paragraph([{ text: 'mail bob@x.com or a_b@y.org', marks: [] }])] };
    expect(serializeMarkdown(doc)).toBe('mail bob\\@x.com or a_b\\@y.org\n');
    expect(describeSpans(content(serializeMarkdown(doc)))).toEqual(['mail bob@x.com or a_b@y.org']);
    // With mentions, which read `\\@` as written, the "@" is an entity instead.
    const md = serializeMarkdown(doc, TAGS);
    expect(md).toBe('mail bob&#64;x.com or a_b&#64;y.org\n');
    expect(describeSpans(content(md, TAGS))).toEqual(['mail bob@x.com or a_b@y.org']);
    // Linked addresses still save as links.
    expect(rewrite('mail bob@x.com')).toBe('mail bob@x.com\n');
  });

  it('links a typed URL or e-mail address when a space follows it', () => {
    const type = (text: string) => {
      const block = paragraph();
      let state = { ...createState({ blocks: [block] }), selection: caret(block.id, 0) };
      for (const ch of text) {
        state = insertText(state, ch);
        if (ch === ' ') state = applyAutolinkInputRule(state) ?? state;
      }
      const b = state.doc.blocks[0]!;
      return 'content' in b ? describeSpans(b.content) : [];
    };
    expect(type('go to https://x.com/a. ')).toEqual(['go to ', '[https://x.com/a](https://x.com/a)', '. ']);
    expect(type('(www.x.com) ')).toEqual(['(', '[www.x.com](http://www.x.com)', ') ']);
    expect(type('mail me@x.io ')).toEqual(['mail ', '[me@x.io](mailto:me@x.io)', ' ']);
    expect(type('no https://x ')).toEqual(['no https://x ']);
  });
});

describe('tag grammar', () => {
  const t = (text: string) => found(scanTags(text), text);

  it('finds tags with hierarchy, Unicode letters, marks and emoji', () => {
    expect(t('#work and #work/meeting, (#ideas) #日记 #हिन्दी #🚀 #a_b-c #2024/q1')).toEqual([
      '#work',
      '#work/meeting',
      '#ideas',
      '#日记',
      '#हिन्दी',
      '#🚀',
      '#a_b-c',
      '#2024/q1',
    ]);
  });

  it('skips # after a word character, digit-only tags, keycaps and trailing slashes', () => {
    expect(t('a#b C# ##x #123 #️⃣ # x #-a')).toEqual([]);
    expect(t('#a/ #a//b #tag.')).toEqual(['#a', '#a', '#tag']);
  });

  it('finds mentions, not the middle of e-mail addresses', () => {
    const m = (text: string) => found(scanMentions(text), text);
    expect(m('@alice, @bob.smith. (@carol) bob@example.com a+@x @-x')).toEqual(['@alice', '@bob.smith', '@carol']);
  });
});

describe('tag decorations', () => {
  const decorated = (md: string, options: MarkdownOptions = TAGS) => {
    const block = parseMarkdown(md, options).blocks[0]!;
    if (!('content' in block)) return [];
    const ctx = decorationContext(block, block.content);
    const text = inlineText(block.content);
    return [...tags().decorations!(ctx), ...mentions().decorations!(ctx)].map((d) => text.slice(d.from, d.to));
  };

  it('highlights tags and mentions in plain text and inside one format', () => {
    expect(decorated('## Notes #work and **#bold/tag** @alice')).toEqual(['#work', '#bold/tag', '@alice']);
  });

  it('does not highlight across formatting, or in code, links, URLs and escapes', () => {
    expect(decorated('#**work** #wo**rk**')).toEqual(['#wo']);
    expect(decorated('`#code` [#link](u) https://x.com/#anchor bob@example.com \\#not @ok')).toEqual(['@ok']);
  });
});

describe('tag escapes', () => {
  it('keeps \\# and \\@ as tokens that are saved as written', () => {
    expect(describeSpans(content('\\#not-a-tag and \\@nobody', TAGS))).toEqual(['{escape:\\#}', 'not-a-tag and ', '{escape:\\@}', 'nobody']);
    expect(rewrite('\\#not-a-tag and \\@nobody', TAGS)).toBe('\\#not-a-tag and \\@nobody\n');
    // Without tags(), the escape is plain CommonMark and is dropped on edit.
    expect(rewrite('\\#x')).toBe('#x\n');
  });

  it('turns a typed \\# into an escape token', () => {
    const block = paragraph();
    let state = { ...createState({ blocks: [block] }), selection: caret(block.id, 0) };
    const inline = TAGS.syntax!.flatMap((s) => s.inline ?? []);
    for (const ch of '\\#x') {
      state = insertText(state, ch);
      state = applyTokenInputRules(state, inline) ?? state;
    }
    const b = state.doc.blocks[0]!;
    expect('content' in b && describeSpans(b.content)).toEqual(['{escape:\\#}', 'x']);
    expect(serializeMarkdown(state.doc, TAGS)).toBe('\\#x\n');
  });

  it('writes a character reference where a backslash escape would read back as a token', () => {
    expect(rewrite('# heading', TAGS)).toBe('# heading\n');
    expect(serializeMarkdown({ blocks: [paragraph([{ text: '#', marks: [] }, { text: 'work', marks: ['bold'] }])] }, TAGS)).toBe(
      '&#35;**work**\n',
    );
    expect(rewrite('#tag at the start', TAGS)).toBe('#tag at the start\n');
  });
});
