// Inputs known to make Markdown parsers slow, ported from the pathological
// suites of cmark, cmark-gfm, commonmark.js, markdown-it and marked. Each is
// generated at a given size and timed through parsing, loading into the
// model and saving with every block written by the serializer.
//
// Two checks, each against the best of three runs:
// - Linear time: four times the input (25 KB to 100 KB) must take less than
//   twelve times as long. A quadratic algorithm takes sixteen times as long.
//   A linear one takes four to ten: small inputs run faster per character
//   (garbage collection and the CPU caches do less work). A case that takes
//   under 100 ms is measured again at four times the size, up to 1.6 MB:
//   when the smaller input takes a few milliseconds, noise alone can exceed
//   the ratio (CI measured 5.3 ms against 69 ms for an input that scales
//   by five from 100 KB up).
// - No case takes a second at 100 KB. Dense syntax like this takes 50 to 200
//   ms at 100 KB in Node, against about 12 ms for plain prose.
//
// Known slow inputs are in known-failures.json under `timing`.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAst, parseMarkdown } from '../../src/markdown/parse';
import { serializeMarkdown } from '../../src/markdown/serialize';

const known: Record<string, string> = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'known-failures.json'), 'utf8')).timing;

/** `unit` repeated to about `bytes` characters. */
const times = (unit: string, bytes: number) => unit.repeat(Math.max(1, Math.round(bytes / unit.length)));
const half = (unit: string, bytes: number) => times(unit, bytes / 2);

/** Each case builds an input of about `bytes` characters. */
const CASES: Record<string, (bytes: number) => string> = {
  // cmark and commonmark.js
  'nested strong emphasis': (b) => half('*a **a ', b) + 'b' + half(' a** a*', b),
  'emphasis closers with no openers': (b) => times('a_ ', b),
  'emphasis openers with no closers': (b) => times('_a ', b),
  'openers and closers, multiple of 3': (b) => 'a**b' + times('c* ', b),
  'link closers with no openers': (b) => times('a]', b),
  'link openers with no closers': (b) => times('[a', b),
  'link openers and emphasis closers': (b) => times('[ a_', b),
  'mismatched openers and closers': (b) => times('*a_ ', b),
  'pattern [ (](': (b) => times('[ (](', b),
  'nested brackets': (b) => half('[', b) + 'a' + half(']', b),
  'nested block quotes': (b) => times('> ', b) + 'a',
  'deeply nested lists': (b) => {
    const lines: string[] = [];
    for (let i = 0, size = 0; size < b; i++) {
      const line = ' '.repeat((i % 500) * 2) + '* a';
      lines.push(line);
      size += line.length + 1;
    }
    return lines.join('\n');
  },
  'backtick runs of growing length': (b) => {
    let out = '';
    for (let i = 0; out.length < b; i++) out += 'e' + '`'.repeat(i % 2000);
    return out;
  },
  'unclosed links, angle brackets': (b) => times('[a](<b', b),
  'unclosed links': (b) => times('[a](b', b),
  'unclosed comments': (b) => '</' + times('<!--', b),
  'many references': (b) => {
    const n = Math.round(b / 12);
    return Array.from({ length: n }, (_, i) => `[${i}]: u`).join('\n') + '\n' + '[0] '.repeat(n);
  },
  'unclosed fences': (b) => times('```\n', b),
  'many list markers on one line': (b) => times('- ', b) + 'a',
  'many heading markers': (b) => times('#', b) + ' a',
  'trailing spaces before line breaks': (b) => times('a  \n', b),
  'backslash line breaks': (b) => times('a\\\n', b),
  'many HTML tags': (b) => times('<a>', b),
  'unclosed HTML attribute': (b) => '<a ' + times('b="c" ', b),
  'many entities': (b) => times('&amp;', b),
  'unfinished entities': (b) => times('&a', b),
  // cmark-gfm
  'table with many rows': (b) => '|a|b|\n|-|-|\n' + times('|x|y|\n', b),
  'wide table with empty rows': (b) => {
    const cols = Math.round(b / 6);
    return '|' + 'a|'.repeat(cols) + '\n|' + '-|'.repeat(cols) + '\n' + '|\n'.repeat(cols);
  },
  'www. followed by dots': (b) => 'www.' + times('a.', b),
  'many @ signs': (b) => times('a@', b),
  'many tildes': (b) => half('~a ', b) + half('~~b ', b),
  // marked's redos cases
  'many underscores': (b) => times('_', b) + 'a',
  'many asterisks': (b) => times('*', b) + 'a',
  'link label with many escapes': (b) => '[' + times('\\[', b) + ']',
  'many unclosed code spans': (b) => times('`a ', b),
  'many brackets after an image start': (b) => '![' + times('[', b),
};

/**
 * Known slow cases run at a size where they take several seconds, so they
 * fail the one-second limit on any machine, whatever the noise in their
 * ratio; and not larger, so a run does not take minutes. Bytes of the
 * larger input.
 */
const SIZE: Record<string, number> = {};

function run(md: string): void {
  parseAst(md, {});
  serializeMarkdown(parseMarkdown(md));
}

/** Milliseconds for one run. */
function once(md: string): number {
  const start = performance.now();
  run(md);
  return performance.now() - start;
}

/**
 * The best of three runs of each input, taking turns, so a busy moment
 * (other test files run in parallel) slows both alike. One run each when
 * the larger takes half a second.
 */
function time(small: string, large: string): [number, number] {
  let a = Infinity;
  let b = Infinity;
  for (let i = 0; i < 3 && (i === 0 || b < 500); i++) {
    a = Math.min(a, once(small));
    b = Math.min(b, once(large));
  }
  return [a, b];
}

describe('timing', () => {
  for (const [name, make] of Object.entries(CASES)) {
    const reason = known[name];
    const size = SIZE[name] ?? 100_000;
    (reason ? it.fails : it)(reason ? `${name}: ${reason}` : name, () => {
      const describe = (bytes: number, [small, large]: [number, number]) =>
        `${small.toFixed(1)} ms at ${bytes / 4000} KB, ${large.toFixed(1)} ms at ${bytes / 1000} KB`;
      let bytes = size;
      let times = time(make(bytes / 4), make(bytes));
      expect(times[1], describe(bytes, times)).toBeLessThan(1000);
      while (times[1] < 100 && bytes < 1_600_000) {
        bytes *= 4;
        times = time(make(bytes / 4), make(bytes));
      }
      if (times[1] >= 20) expect(times[1] / times[0], describe(bytes, times)).toBeLessThan(12);
    }, 120_000);
  }
});
