// Markdown dialect options shared by the parser, lowering and serializer.

export interface MarkdownOptions {
  /**
   * A single newline inside a paragraph is a line break (like GitHub
   * comments and remark-breaks), and a line break is saved as a plain
   * newline. Default false: CommonMark soft breaks, which render as spaces.
   */
  readonly breaks?: boolean;
  /**
   * Setext headings (`Title` underlined with `===` or `---`). Default true.
   * With false, `Title`⏎`---` is a paragraph and a divider.
   */
  readonly setext?: boolean;
  /**
   * GFM autolink literals: `www.example.com`, `https://example.com` and
   * `name@example.com` written without angle brackets are links. Default true.
   */
  readonly autolinks?: boolean;
  /** Syntax outside CommonMark and GFM, such as math or footnotes. */
  readonly syntax?: readonly MarkdownSyntax[];
}

/** Syntax added by an extension. Its content is kept as source and saved verbatim. */
export interface MarkdownSyntax {
  readonly inline?: readonly InlineSyntax[];
  readonly block?: readonly BlockSyntax[];
  /** Characters to backslash-escape in plain text, so typed text cannot start this syntax. */
  readonly escape?: string;
}

/**
 * An inline token, such as `$x^2$` or `[^1]`. It becomes a span with
 * `token: name`, shown with the class `mbe-token-<name>` and saved exactly
 * as written.
 */
export interface InlineSyntax {
  readonly name: string;
  /** Characters that can start the token. */
  readonly triggers: string;
  /**
   * Where a token starting at `pos` ends (exclusive), or -1 if there is no
   * token there. `text` is the inline source, with escapes still in it. It is
   * tried before CommonMark syntax, except backslash escapes.
   */
  match(text: string, pos: number): number;
}

/**
 * A block kept as source, such as a `$$` math block or a footnote
 * definition. It becomes a raw block with `syntax: name`.
 */
export interface BlockSyntax {
  readonly name: string;
  /** Whether it can start in the middle of a paragraph, like a code fence. Default false. */
  readonly interruptsParagraph?: boolean;
  /**
   * Called with a line (from its first non-space character) that might start
   * the block. Returns a matcher for the lines that follow, or null.
   */
  open(line: string): BlockSyntaxMatcher | null;
}

export interface BlockSyntaxMatcher {
  /**
   * For each following line: `continue` adds it, `close` adds it and ends
   * the block, `end` ends the block before it.
   */
  next(line: string): 'continue' | 'close' | 'end';
}

export interface ResolvedMarkdown {
  readonly breaks: boolean;
  readonly setext: boolean;
  readonly autolinks: boolean;
  readonly syntax: readonly MarkdownSyntax[];
  readonly inline: readonly InlineSyntax[];
  readonly block: readonly BlockSyntax[];
  readonly escape: string;
}

export const DEFAULT_MARKDOWN: ResolvedMarkdown = { breaks: false, setext: true, autolinks: true, syntax: [], inline: [], block: [], escape: '' };

const resolved = new WeakMap<MarkdownOptions, ResolvedMarkdown>();

export function resolveMarkdown(options: MarkdownOptions | undefined): ResolvedMarkdown {
  if (!options) return DEFAULT_MARKDOWN;
  let r = resolved.get(options);
  if (!r) {
    const syntax = options.syntax ?? [];
    r = {
      breaks: options.breaks ?? false,
      setext: options.setext ?? true,
      autolinks: options.autolinks ?? true,
      syntax,
      inline: syntax.flatMap((s) => s.inline ?? []),
      block: syntax.flatMap((s) => s.block ?? []),
      escape: [...new Set(syntax.map((s) => s.escape ?? '').join(''))].join(''),
    };
    resolved.set(options, r);
  }
  return r;
}
