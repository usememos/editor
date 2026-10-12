// Named character references in browsers. The browser's own HTML parser
// already knows the full WHATWG list, so this saves shipping the table
// (about 11 KB gzipped). Node and other environments without a DOM get
// entities.ts instead, through the "#entities" import in package.json.

let decoder: HTMLTextAreaElement | null = null;

/** The replacement text for a named entity (without "&" and ";"), or undefined. */
export function lookupEntity(name: string): string | undefined {
  if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(name)) return undefined;
  // Text inside <textarea> is parsed as RCDATA: entities are decoded and no elements are created.
  decoder ??= document.createElement('textarea');
  const source = `&${name};`;
  decoder.innerHTML = source;
  const text = decoder.value;
  // Unknown names stay as written. A legacy name without ";" that is a prefix
  // ("&notit;" decodes as "¬it;") leaves the rest of the name and the ";"
  // behind; only "&semi;" really decodes to text ending in ";".
  if (text === source || (text.endsWith(';') && name !== 'semi')) return undefined;
  return text;
}
