# Vendored test suites

Test inputs copied unchanged from public repositories, read by
`packages/editor/scripts/conformance.mjs`. Each keeps its license.

| Folder | Repository | Commit | Files | License |
| --- | --- | --- | --- | --- |
| `cmark-gfm/` | [github/cmark-gfm](https://github.com/github/cmark-gfm) | `27d942c8b0a62d192f616e5bf3578f4b6a89e180` | `test/spec.txt`, `test/extensions.txt`, `test/regression.txt` | BSD-2-Clause; the spec text is CC BY-SA 4.0 |
| `cmark/` | [commonmark/cmark](https://github.com/commonmark/cmark) | `ee05faf6cd95f6c949e2c0d17c73041dea7214fe` | `test/regression.txt` | BSD-2-Clause |
| `commonmark.js/` | [commonmark/commonmark.js](https://github.com/commonmark/commonmark.js) | `898886961b49c1df1175666d03c3ac66c9cc9040` | `test/regression.txt` | BSD-2-Clause |
| `markdown-it/` | [markdown-it/markdown-it](https://github.com/markdown-it/markdown-it) | `a8c00d474ec9b304fad9b71c16d6fa8b4909279e` | `test/fixtures/markdown-it/{commonmark_extras,normalize,strikethrough,tables}.txt` | MIT |
| `micromark-gfm/autolink-literal/` | [micromark/micromark-extension-gfm-autolink-literal](https://github.com/micromark/micromark-extension-gfm-autolink-literal) | `618170c86639742036ecf666d975a6ebac5aac50` | `test/fixtures/*` | MIT |
| `micromark-gfm/table/` | [micromark/micromark-extension-gfm-table](https://github.com/micromark/micromark-extension-gfm-table) | `1511204dae5a01e81588cee417ecd4fb8d2c8aff` | `test/fixtures/*` | MIT |
| `micromark-gfm/strikethrough/` | [micromark/micromark-extension-gfm-strikethrough](https://github.com/micromark/micromark-extension-gfm-strikethrough) | `895451f924c543c6a528e80b7340236e164eb384` | `test/fixtures/*` | MIT |
| `micromark-gfm/task-list-item/` | [micromark/micromark-extension-gfm-task-list-item](https://github.com/micromark/micromark-extension-gfm-task-list-item) | `7902c38c76a6dea80928a54829313b702615d1e1` | `test/fixtures/*` | MIT |

The micromark fixture pairs are Markdown files with the HTML that github.com
rendered for them, which their authors captured from GitHub. The CommonMark
0.31.2 examples come from `test/fixtures/commonmark-0.31.2.json`, which the
spec tests already use.

`../tags.json` copies inputs, not files: the hashtag and mention cases of
[twitter/twitter-text](https://github.com/twitter/twitter-text)
`conformance/extract.yml` (Apache-2.0), and the inputs of
[usememos/memos](https://github.com/usememos/memos) (MIT) tests:
`markdown/parser/tag_test.go`, `mention_test.go` and `markdown_test.go` at
`e051129`, `web/tests/tag-grammar.test.ts`, and `web/tests/remark-tag.test.tsx`
and `remark-mention.test.ts` as they were before `5cfe9c0`.
