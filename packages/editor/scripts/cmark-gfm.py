"""Renders Markdown with cmark-gfm, GitHub's Markdown parser, for conformance.mjs.

Reads a JSON array of Markdown strings on stdin and writes a JSON array of
HTML strings on stdout. Needs the cmarkgfm package (Python bindings that
bundle cmark-gfm): python3 -m pip install cmarkgfm==2025.10.22
"""

import json
import sys

import cmarkgfm
from cmarkgfm.cmark import Options

EXTENSIONS = ["table", "autolink", "strikethrough", "tasklist"]


def render(markdown: str, breaks: bool) -> "str | None":
    """None where the bindings cannot return the output, such as for input with a NUL character."""
    options = Options.CMARK_OPT_UNSAFE
    if breaks:
        options |= Options.CMARK_OPT_HARDBREAKS
    try:
        return cmarkgfm.markdown_to_html_with_extensions(markdown, options=options, extensions=EXTENSIONS)
    except UnicodeDecodeError:
        return None


def main() -> None:
    cases = json.load(sys.stdin)
    json.dump([render(c["markdown"], c.get("breaks", False)) for c in cases], sys.stdout)


if __name__ == "__main__":
    main()
