// Spec examples used by spec.test.ts and roundtrip.test.ts.
//
// commonmark-0.31.2.json: the CommonMark 0.31.2 examples, in the shape of
// https://spec.commonmark.org/0.31.2/spec.json (extracted from the spec's
// spec.txt with the logic of its tools/spec_tests.py, tabs restored).
// gfm-extensions.json: the table, strikethrough, autolink and task list
// examples from cmark-gfm's test/spec.txt, with an `extension` field. The task list
// examples are marked "disabled" there; they are included here as "tasklist".

import { readFileSync } from 'node:fs';

export interface SpecExample {
  markdown: string;
  html: string;
  example: number;
  section: string;
  extension?: string;
}

function load(name: string): SpecExample[] {
  return JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')) as SpecExample[];
}

export const commonmark = load('commonmark-0.31.2.json');
export const gfm = load('gfm-extensions.json');
