// Raw HTML rendered through the host's sanitizer. The editor parses an HTML
// block or an inline run with the browser's parser, into the inert content of
// a <template>, and hands the tree to `sanitizeHtml`; what comes back is
// attached. Without the option the editor renders no HTML at all, and shows
// the source: the editor does no sanitizing of its own, so a host cannot
// mistake a partial one for enough.

import type { Editor } from '../editor';
import type { SyntaxView } from '../extension';

/** What `sanitizeHtml` gets besides the tree. */
export interface SanitizeHtmlContext {
  readonly editor: Editor;
  /**
   * `'block'` for an HTML block, including a section with Markdown between
   * its tags; `'inline'` for a run of inline HTML in a paragraph, heading,
   * list item, quote or table cell.
   */
  readonly kind: 'inline' | 'block';
}

/** The tree to attach, or nothing to show the source instead. */
export type SanitizedHtml = Node | null | undefined | void;

/**
 * Decides what of a piece of raw HTML reaches the page. Gets the HTML parsed
 * into a `DocumentFragment` that is not in the page, so nothing in it has
 * run or loaded yet, and returns the tree to attach: the fragment itself
 * after removing what is not allowed, another node, or nothing to show the
 * source instead. Text in the tree holds the editor's markers for the
 * Markdown between the tags, which the editor renders itself and puts in
 * place of the markers after the sanitizer has run; a sanitizer keeps text,
 * so the markers survive. May return a promise, for a sanitizer loaded on
 * demand: the HTML shows nothing until it settles, and a rejection shows
 * the source.
 */
export type SanitizeHtml = (tree: DocumentFragment, ctx: SanitizeHtmlContext) => SanitizedHtml | PromiseLike<SanitizedHtml>;

const isPromiseLike = <T>(value: T | PromiseLike<T>): value is PromiseLike<T> =>
  typeof (value as PromiseLike<T> | null)?.then === 'function';

/** The `html` view: raw HTML parsed by the browser and passed through `sanitize`. */
export function htmlView(sanitize: SanitizeHtml): SyntaxView {
  return (source, element, kind, ctx) => {
    const template = element.ownerDocument.createElement('template');
    template.innerHTML = source;
    const attach = (tree: SanitizedHtml): void | false => {
      if (!tree) return false;
      element.replaceChildren(tree);
    };
    const result = sanitize(template.content, { editor: ctx.editor, kind });
    return isPromiseLike(result) ? result.then(attach) : attach(result);
  };
}
