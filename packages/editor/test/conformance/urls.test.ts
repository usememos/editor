// @vitest-environment happy-dom
//
// URL safety: no input may render a link, image or other URL that a browser
// would run as script, with the default `resolveUrl` (relative URLs and
// `http`, `https`, `mailto` and `tel`; see `defaultResolveUrl`).
//
// Inputs come from markdown-it's `xss.txt`, micromark's dangerous-protocol
// tests, commonmark.js's safe-mode tests and memos' security tests, plus URLs
// that a browser reads differently from how they are written: it drops
// leading and trailing control characters and spaces, and every tab and line
// break, before it reads the scheme (the WHATWG URL standard), so
// `java&#9;script:` is `javascript:`.
//
// A case may also name a URL that must still render, so the policy is not
// stricter than it says.
//
// Known failures are in known-failures.json under `urls`, keyed by the input.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Editor } from '../../src/editor';

interface Case {
  readonly markdown: string;
  readonly from: string;
  /** A URL that must render, as an `href` or `src`. */
  readonly keeps?: string;
}

const MARKDOWN_IT = 'markdown-it xss.txt';
const MICROMARK = 'micromark dangerous-protocols.js';
const COMMONMARK_JS = 'commonmark.js safe mode';
const MEMOS = 'memos security tests';
const WHATWG = 'WHATWG URL parsing';

const CASES: Case[] = [
  { markdown: '[normal link](javascript)', from: MARKDOWN_IT, keeps: 'javascript' },
  { markdown: '[xss link](javascript:alert(1))', from: MARKDOWN_IT },
  { markdown: '[xss link](JAVASCRIPT:alert(1))', from: MARKDOWN_IT },
  { markdown: '[xss link](vbscript:alert(1))', from: MARKDOWN_IT },
  { markdown: '[xss link](VBSCRIPT:alert(1))', from: MARKDOWN_IT },
  { markdown: '[xss link](file:///123)', from: MARKDOWN_IT },
  { markdown: '[xss link](&#34;&#62;&#60;script&#62;alert&#40;&#34;xss&#34;&#41;&#60;/script&#62;)', from: MARKDOWN_IT },
  { markdown: '[xss link](&#74;avascript:alert(1))', from: MARKDOWN_IT },
  { markdown: '[xss link](&#x26;#74;avascript:alert(1))', from: MARKDOWN_IT },
  { markdown: '[xss link](\\&#74;avascript:alert(1))', from: MARKDOWN_IT },
  { markdown: '[xss link](<javascript:alert(1)>)', from: MARKDOWN_IT },
  { markdown: '[xss link](javascript&#x3A;alert(1))', from: MARKDOWN_IT },
  { markdown: '[xss link](data:text/html;base64,PHNjcmlwdD5hbGVydCgnWFNTJyk8L3NjcmlwdD4K)', from: MARKDOWN_IT },
  { markdown: '[normal link](/javascript:link)', from: MARKDOWN_IT, keeps: '/javascript:link' },
  { markdown: '![xss link](javascript:alert(1))', from: MARKDOWN_IT },
  { markdown: '<javascript&#x3A;alert(1)>', from: MARKDOWN_IT },
  { markdown: '<javascript:alert(1)>', from: MARKDOWN_IT },
  { markdown: 'javascript&#x3A;alert(1)', from: MARKDOWN_IT },
  { markdown: 'javascript:alert(1)', from: MARKDOWN_IT },
  { markdown: '[test]\n\n[test]: javascript:alert(1)', from: MARKDOWN_IT },

  { markdown: '<http://a>', from: MICROMARK, keeps: 'http://a' },
  { markdown: '<https://a>', from: MICROMARK, keeps: 'https://a' },
  { markdown: '<irc:///help>', from: MICROMARK },
  { markdown: '<mailto:a>', from: MICROMARK, keeps: 'mailto:a' },
  { markdown: '![](http://a)', from: MICROMARK, keeps: 'http://a' },
  { markdown: '![](https://a)', from: MICROMARK, keeps: 'https://a' },
  { markdown: '![](irc:///help)', from: MICROMARK },
  { markdown: '![](mailto:a)', from: MICROMARK },
  { markdown: '![](#a)', from: MICROMARK, keeps: '#a' },
  { markdown: '![](?a)', from: MICROMARK, keeps: '?a' },
  { markdown: '![](/a)', from: MICROMARK, keeps: '/a' },
  { markdown: '![](./a)', from: MICROMARK, keeps: './a' },
  { markdown: '![](../a)', from: MICROMARK, keeps: '../a' },
  { markdown: '![](a#b:c)', from: MICROMARK, keeps: 'a#b:c' },
  { markdown: '![](a?b:c)', from: MICROMARK, keeps: 'a?b:c' },
  { markdown: '![](a/b:c)', from: MICROMARK, keeps: 'a/b:c' },
  // micromark's link cases have no text; the editor shows a link with no text as plain text (decision D5).
  { markdown: '[x](javascript:alert(1))', from: MICROMARK },
  { markdown: '[x](http://a)', from: MICROMARK, keeps: 'http://a' },
  { markdown: '[x](irc:///help)', from: MICROMARK },
  { markdown: '[x](mailto:a)', from: MICROMARK, keeps: 'mailto:a' },
  { markdown: '[x](#a)', from: MICROMARK, keeps: '#a' },
  { markdown: '[x](?a)', from: MICROMARK, keeps: '?a' },
  { markdown: '[x](a#b:c)', from: MICROMARK, keeps: 'a#b:c' },
  { markdown: '[x](a?b:c)', from: MICROMARK, keeps: 'a?b:c' },
  { markdown: '[x](a/b:c)', from: MICROMARK, keeps: 'a/b:c' },

  { markdown: '[link](vbscript:msgbox(1))', from: COMMONMARK_JS },
  { markdown: '[link](file:///etc/passwd)', from: COMMONMARK_JS },
  { markdown: '![img](data:text/html,x)', from: COMMONMARK_JS },
  { markdown: '[link](https://example.com/view?src=data:image/png)', from: COMMONMARK_JS, keeps: 'https://example.com/view?src=data:image/png' },
  { markdown: '[link](https://example.com/download?to=file:report)', from: COMMONMARK_JS, keeps: 'https://example.com/download?to=file:report' },
  { markdown: '![img](https://example.com/wiki/vbscript:_basics)', from: COMMONMARK_JS, keeps: 'https://example.com/wiki/vbscript:_basics' },

  { markdown: '[phone me](tel:+440000000000)', from: MEMOS, keeps: 'tel:+440000000000' },
  { markdown: '[x](javascript:alert(1)) [y](data:text/html,hi) [z](vbscript:msgbox)', from: MEMOS },
  { markdown: '<span style="position:fixed;inset:0;z-index:99999">overlay</span>', from: MEMOS },
  { markdown: '<div onclick="alert(1)">a<script>alert(2)</script><img src="https://img.example/a.png" onerror="alert(3)"></div>', from: MEMOS },
  { markdown: '<p><a href="javascript:alert(1)">x</a></p>', from: MEMOS },
  { markdown: '<iframe src="https://evil.example/embed/abc123" title="demo"></iframe>', from: MEMOS },
  { markdown: '<picture><source srcset="http://tracker.example/a.png"><img src="https://img.example/a.png"></picture>', from: MEMOS },

  { markdown: '[a](java&#9;script:alert(1))', from: WHATWG },
  { markdown: '[a](java&#10;script:alert(1))', from: WHATWG },
  { markdown: '[a](java&#13;script:alert(1))', from: WHATWG },
  { markdown: '[a](<java\tscript:alert(1)>)', from: WHATWG },
  { markdown: '[a](&#1;javascript:alert(1))', from: WHATWG },
  { markdown: '[a](&#31;javascript:alert(1))', from: WHATWG },
  { markdown: '[a](&#32;javascript:alert(1))', from: WHATWG },
  { markdown: '[a](javascript:alert(1)&#1;)', from: WHATWG },
  { markdown: '[a](JaVaScRiPt:alert(1))', from: WHATWG },
  { markdown: '![a](java&#9;script:alert(1))', from: WHATWG },
  { markdown: '[a][r]\n\n[r]: java&#9;script:alert(1)', from: WHATWG },
  { markdown: '[a](%6Aavascript:alert(1))', from: WHATWG, keeps: '%6Aavascript:alert(1)' },
  { markdown: '[a](<" onmouseover="alert(1)>)', from: WHATWG },
  { markdown: '![a" onerror="alert(1)](x.png)', from: WHATWG, keeps: 'x.png' },
];

const dir = dirname(fileURLToPath(import.meta.url));
const known: Record<string, string> = JSON.parse(readFileSync(join(dir, 'known-failures.json'), 'utf8')).urls;

const SAFE_SCHEMES = ['http', 'https', 'mailto', 'tel'];
const URL_ATTRIBUTES = ['href', 'src', 'srcset', 'action', 'formaction', 'xlink:href', 'poster', 'data'];

/** Whether a browser would load `url` with a scheme outside the default policy. */
function unsafe(url: string): boolean {
  // As the WHATWG URL parser reads it: no leading or trailing C0 controls or spaces, no tabs or line breaks.
  const read = url.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '').replace(/[\t\n\r]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(read);
  return scheme !== null && !SAFE_SCHEMES.includes(scheme[1]!.toLowerCase());
}

/** Everything in the rendered DOM that could run script or load a disallowed URL. */
function problems(element: Element): string[] {
  const out: string[] = [];
  for (const el of Array.from(element.querySelectorAll('*'))) {
    if (['script', 'iframe', 'object', 'embed', 'frame'].includes(el.localName)) out.push(`<${el.localName}>`);
    for (const { name, value } of Array.from(el.attributes)) {
      if (/^on/i.test(name)) out.push(`${name}="${value}"`);
      if (URL_ATTRIBUTES.includes(name) && unsafe(value)) out.push(`${name}=${JSON.stringify(value)}`);
    }
  }
  return out;
}

/** The URLs rendered as `href` or `src`. */
const urls = (element: Element) =>
  Array.from(element.querySelectorAll('[href], [src]'), (el) => el.getAttribute('href') ?? el.getAttribute('src'));

describe('URL safety', () => {
  for (const c of CASES) {
    const reason = known[c.markdown];
    const title = `${JSON.stringify(c.markdown)} (${c.from})`;
    (reason ? it.fails : it)(reason ? `${title}: ${reason}` : title, () => {
      const element = document.createElement('div');
      document.body.appendChild(element);
      const editor = new Editor({ element, content: c.markdown, editable: false });
      try {
        expect(problems(element)).toEqual([]);
        if (c.keeps) expect(urls(element)).toContain(c.keeps);
      } finally {
        editor.destroy();
        element.remove();
      }
    });
  }
});
