// @vitest-environment happy-dom
//
// Tags and mentions: what the default tags() and mentions() highlight, for
// every input in tags.json, with memos' Markdown options and extensions.
// tags.json says where its expected results come from (its `about`).
//
// Known differences are in known-failures.json under `tags`, keyed by the
// input, like the other layers.
//
// No case uses a character newer than the Unicode version of every Node
// release CI runs: the editor's `\p{…}` classes follow the engine's data.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Editor } from '../../src/editor';
import type { Extension } from '../../src/extension';
import { footnotes } from '../../src/extensions/footnotes';
import { math } from '../../src/extensions/math';
import { mentions, tags } from '../../src/extensions/tags';
import type { MarkdownOptions } from '../../src/markdown/options';

interface Case {
  readonly markdown: string;
  readonly tags: readonly string[];
  readonly mentions: readonly string[];
  readonly description?: string;
  readonly from: string;
  /** Why there is no expected result. */
  readonly ambiguous?: string;
}

const dir = dirname(fileURLToPath(import.meta.url));
const { cases }: { cases: Case[] } = JSON.parse(readFileSync(join(dir, 'tags.json'), 'utf8'));
const known: Record<string, string> = JSON.parse(readFileSync(join(dir, 'known-failures.json'), 'utf8')).tags;

/** memos' dialect (web/src/lib/memo-markdown.ts). */
const MEMO: MarkdownOptions = { breaks: true, setext: false };
/** Raw HTML as its source text: memos renders it with a view, which takes no decorations either. */
const rawHtml: Extension = {
  name: 'raw-html',
  views: {
    html(source, element) {
      element.textContent = source;
    },
  },
};

/** The tags and mentions a reader sees highlighted, as written, in document order. */
function highlighted(markdown: string): { tags: string[]; mentions: string[] } {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    content: markdown,
    editable: false,
    markdown: MEMO,
    extensions: [math(), footnotes(), tags(), mentions(), rawHtml],
    resolveUrl: (url) => url,
  });
  // Read-only, a footnote definition hides where it is written and shows again in the collected section: count the one a reader sees.
  const read = (selector: string) => Array.from(element.querySelectorAll(selector), (el) => (el.closest('.mbe-footnote-collected') ? null : el.textContent!)).filter((t): t is string => t !== null);
  const found = { tags: read('.mbe-tag'), mentions: read('.mbe-mention') };
  editor.destroy();
  element.remove();
  return found;
}

describe('tags and mentions', () => {
  for (const c of cases) {
    const title = `${JSON.stringify(c.markdown)}${c.description ? ` (${c.description})` : ''}`;
    if (c.ambiguous) {
      it.todo(`${title}: ${c.ambiguous}`);
      continue;
    }
    const reason = known[c.markdown];
    (reason ? it.fails : it)(reason ? `${title}: ${reason}` : title, () => {
      expect(highlighted(c.markdown)).toEqual({ tags: c.tags, mentions: c.mentions });
    });
  }
});
