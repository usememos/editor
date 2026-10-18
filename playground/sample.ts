export const SAMPLE = `## Weekly notes #work/planning

Standard **Markdown** with *block editing*. Type \`/\` for blocks, \`#\` for tags, or select text for the toolbar.
A single line break stays a line break.

- Ship the editor #work
    - Press Tab to indent
- Read [CommonMark](https://commonmark.org) @alice

1. Numbered
2. Lists

- [x] Task lists
- [ ] Click the box

> Quotes stay quiet.

Inline math $e^{i\\pi} + 1 = 0$ and a footnote[^1].

$$
\\int_0^1 x\\,dx = \\frac{1}{2}
$$

\`\`\`ts
const editor = new Editor({ element, content, onChange });
\`\`\`

\`\`\`mermaid
graph TD
  Write --> Preview
  Preview --> Share
\`\`\`

| Feature | Status |
| :-- | --: |
| Tables | Done |
| Alignment | Done |

---

[^1]: Footnotes are kept as written.
`;
