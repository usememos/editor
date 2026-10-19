// Themes: classes added to rendered elements, and token values written as
// --mbe-* custom properties. The stylesheet does the rest: base.css holds the
// layout the editor needs, theme.css the default look.

import type { HeadingLevel } from './model';

/**
 * Classes added to each rendered element of a type, next to the editor's own
 * `mbe-*` classes, in editing and read-only alike. Keys use the names of
 * `isActive`, plus `image` and `token`. Values are class strings, such as Tailwind utilities.
 */
export interface ThemeClasses {
  /** `<p>` */
  readonly paragraph?: string;
  /** `<h1>` to `<h6>`, by level. */
  readonly heading?: Readonly<Partial<Record<HeadingLevel, string>>>;
  /** `<blockquote>`, one per quote paragraph. */
  readonly blockquote?: string;
  /** Each list item of that type. Blocks are flat, so there is no list container. */
  readonly bulletList?: string;
  readonly orderedList?: string;
  readonly taskList?: string;
  /** The code block's frame, around its language bar and `<pre>`. */
  readonly codeBlock?: string;
  /** The table's frame, around the `<table>`. */
  readonly table?: string;
  /** The `<hr>` of a divider. */
  readonly divider?: string;
  /** The title row of a collapsible section. */
  readonly details?: string;
  /** Raw blocks: Markdown kept as source, or rendered by a view. */
  readonly raw?: string;
  /** `<img>` */
  readonly image?: string;
  /** `<strong>`, `<em>`, `<s>` and inline `<code>`. */
  readonly bold?: string;
  readonly italic?: string;
  readonly strike?: string;
  readonly code?: string;
  /** `<a>` */
  readonly link?: string;
  /** Inline tokens of an extension syntax, as source or rendered, by syntax name, such as `math`. */
  readonly token?: Readonly<Record<string, string>>;
}

/** Colors for one color scheme. Any CSS color. */
export interface ThemeColors {
  readonly text?: string;
  readonly muted?: string;
  readonly background?: string;
  readonly accent?: string;
  /** Defaults to `accent`. */
  readonly link?: string;
  readonly codeBackground?: string;
  readonly border?: string;
  /** Menus, the toolbar and the link popover. */
  readonly popupBackground?: string;
  /** Defaults to `border`. */
  readonly popupBorder?: string;
  /** Highlighted menu items and toolbar buttons. */
  readonly hover?: string;
  readonly danger?: string;
  /** Behind `<mark>` in rendered HTML, as a tint. */
  readonly highlight?: string;
  /** The icon of each callout type, and a light tint of it behind the text. */
  readonly calloutNote?: string;
  readonly calloutTip?: string;
  readonly calloutImportant?: string;
  readonly calloutWarning?: string;
  readonly calloutCaution?: string;
}

/** Values written as --mbe-* custom properties on the root and on popups. Numbers are pixels. */
export interface ThemeTokens {
  /**
   * Colors in both schemes, for values that pick their own, such as
   * `var(--primary)`. `light` and `dark` override them per scheme.
   */
  readonly colors?: ThemeColors;
  /** Colors in the light scheme. Missing values keep `colors`, then the default. */
  readonly light?: ThemeColors;
  /** Colors in the dark scheme. Missing values keep `colors`, then the default dark palette. */
  readonly dark?: ThemeColors;
  readonly font?: string;
  readonly mono?: string;
  readonly fontSize?: string | number;
  readonly lineHeight?: string | number;
  readonly radius?: string | number;
  readonly blockGap?: string | number;
}

/**
 * `auto` follows `prefers-color-scheme`, or `data-theme="light"` or
 * `data-theme="dark"`, or a `light` or `dark` class, on the root or an
 * ancestor. `inherit` follows the page's `color-scheme`, for apps that
 * switch it themselves.
 */
export type ColorScheme = 'auto' | 'light' | 'dark' | 'inherit';

export interface Theme {
  readonly classes?: ThemeClasses;
  readonly tokens?: ThemeTokens;
  /** Default `auto`. */
  readonly colorScheme?: ColorScheme;
}

/**
 * The editor in an app styled with shadcn/ui: colors, font and radius from
 * shadcn's CSS variables (`--foreground`, `--primary`, `--radius`, …), so the
 * editor follows the app's theme, and light or dark from the `dark` class.
 * Spread it to change a part: `{ tokens: { ...shadcnTheme.tokens, radius: 4 } }`.
 */
export const shadcnTheme: Theme = {
  tokens: {
    colors: {
      text: 'var(--foreground)',
      muted: 'var(--muted-foreground)',
      accent: 'var(--primary)',
      codeBackground: 'var(--muted)',
      border: 'var(--border)',
      popupBackground: 'var(--popover)',
      hover: 'var(--accent)',
      danger: 'var(--destructive)',
    },
    font: 'inherit',
    mono: 'var(--font-mono, ui-monospace, monospace)',
    radius: 'calc(var(--radius) - 2px)',
  },
};

/** Merges class maps; a later map wins for the same key, and `heading` and `token` merge per entry. */
export function mergeClasses(maps: readonly (ThemeClasses | undefined)[]): ThemeClasses {
  const out: Record<string, unknown> = {};
  for (const map of maps) {
    for (const [key, value] of Object.entries(map ?? {})) {
      if (value === undefined) continue;
      out[key] = typeof value === 'object' ? { ...(out[key] as object | undefined), ...value } : value;
    }
  }
  return out as ThemeClasses;
}

const COLOR_VARS: Record<keyof ThemeColors, string> = {
  text: '--mbe-text',
  muted: '--mbe-muted',
  background: '--mbe-bg',
  accent: '--mbe-accent',
  link: '--mbe-link',
  codeBackground: '--mbe-code-bg',
  border: '--mbe-border',
  popupBackground: '--mbe-popup-bg',
  popupBorder: '--mbe-popup-border',
  hover: '--mbe-hover',
  danger: '--mbe-danger',
  highlight: '--mbe-highlight',
  calloutNote: '--mbe-callout-note',
  calloutTip: '--mbe-callout-tip',
  calloutImportant: '--mbe-callout-important',
  calloutWarning: '--mbe-callout-warning',
  calloutCaution: '--mbe-callout-caution',
};

const SIZE_VARS = {
  font: '--mbe-font',
  mono: '--mbe-mono',
  fontSize: '--mbe-font-size',
  lineHeight: '--mbe-line-height',
  radius: '--mbe-radius',
  blockGap: '--mbe-block-gap',
} as const;

/** The token properties that change how text measures: a view that laid out text (a diagram) renders again when one changes. */
export const FONT_PROPERTIES: readonly string[] = [SIZE_VARS.font, SIZE_VARS.mono, SIZE_VARS.fontSize, SIZE_VARS.lineHeight];

/**
 * The custom properties for `tokens`. Colors go in `--mbe-<name>-light` and
 * `--mbe-<name>-dark`, which the stylesheet picks between with `light-dark()`;
 * `colors` fills both, and `light` and `dark` win per scheme.
 */
export function tokenProperties(tokens: ThemeTokens | undefined): Map<string, string> {
  const props = new Map<string, string>();
  if (!tokens) return props;
  for (const scheme of ['light', 'dark'] as const) {
    for (const [name, prop] of Object.entries(COLOR_VARS) as [keyof ThemeColors, string][]) {
      const value = tokens[scheme]?.[name] ?? tokens.colors?.[name];
      if (value) props.set(`${prop}-${scheme}`, value);
    }
  }
  for (const [name, prop] of Object.entries(SIZE_VARS)) {
    const value = tokens[name as keyof typeof SIZE_VARS];
    if (value !== undefined && value !== '') props.set(prop, typeof value === 'number' ? `${value}px` : value);
  }
  return props;
}
