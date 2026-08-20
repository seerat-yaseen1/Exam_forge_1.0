/**
 * themes — the colour sets a student can choose between.
 *
 * ── WHY THIS FILE IS THE ONLY SOURCE OF TRUTH ─────────────────────
 * palette.css already reduced the app's 6,315 colour literals to 22 `--ef-*`
 * custom properties. That made a theme possible; it did not make one. This
 * module is the second half: every theme here is a complete set of values for
 * those same properties, so switching theme is one write of ~40 custom
 * properties onto <html> and nothing re-renders.
 *
 * The picker in the Appearance page reads the SAME objects to draw its
 * swatches, which is what stops the chip a student clicks from disagreeing
 * with the colours they get.
 *
 * ── WHY THE SEEDS ARE SMALL AND THE TOKENS ARE DERIVED ────────────
 * A theme is nine colours (`ThemeSeed`). Everything else — the three border
 * weights, the hover surfaces, the tinted status backgrounds, the shadow
 * colour — is mixed from those nine by `buildTokens`. Two reasons:
 *
 *   1. Hand-writing 40 values × 18 themes is 720 chances to pick a tint that
 *      does not belong to its palette. Deriving them means a theme is
 *      internally consistent by construction.
 *   2. Mixing happens HERE, in TypeScript, not in CSS `color-mix()`. The
 *      output is a plain hex string, so a token is inspectable in devtools,
 *      identical in every browser, and testable without a DOM.
 *
 * ── THE CLASSIC THEME IS BYTE-IDENTICAL TO TODAY ──────────────────
 * `classic` does not derive anything: it lists the exact literals currently in
 * palette.css. A student who never opens the picker sees the pixels they saw
 * yesterday, and the light/dark question stays a choice rather than something
 * that happened to them.
 */

// ══════════════════════════════════════════════════════════════════
// §1 — COLOUR MATHS
// ══════════════════════════════════════════════════════════════════

type RGB = [number, number, number];

function parseHex(hex: string): RGB {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function toHex([r, g, b]: RGB): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return `#${[r, g, b].map((n) => clamp(n).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/**
 * Blend `amount` of `a` into `b`. `mix(x, y, 1)` is x; `mix(x, y, 0)` is y.
 *
 * Straight sRGB interpolation, deliberately. Perceptual spaces (oklab) give
 * prettier midpoints between distant hues, but every mix below is between a
 * hue and a near-neutral of the same palette, where the two agree — and sRGB
 * keeps this file dependency-free and its output predictable.
 */
export function mix(a: string, b: string, amount: number): string {
  const [r1, g1, b1] = parseHex(a);
  const [r2, g2, b2] = parseHex(b);
  const t = Math.max(0, Math.min(1, amount));
  return toHex([r1 * t + r2 * (1 - t), g1 * t + g2 * (1 - t), b1 * t + b2 * (1 - t)]);
}

/** Relative luminance, WCAG 2.1 §1.4.3. */
export function luminance(hex: string): number {
  const srgb = parseHex(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

/** WCAG contrast ratio between two colours, 1–21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Black or white, whichever is legible on `bg`.
 *
 * Used for the one token a seed is allowed to get wrong — accent text — as a
 * fallback when a theme does not name one.
 */
export function readableOn(bg: string): string {
  return contrastRatio('#FFFFFF', bg) >= contrastRatio('#0B0B0A', bg) ? '#FFFFFF' : '#0B0B0A';
}

// ══════════════════════════════════════════════════════════════════
// §2 — WHAT A THEME IS
// ══════════════════════════════════════════════════════════════════

export type ThemeMode = 'light' | 'dark';

/** How the picker groups themes. Order here is the order on screen. */
export type ThemeGroup = 'base' | 'light' | 'dark';

export interface ThemeSeed {
  id: string;
  label: string;
  /** One line under the label in the picker. Sets expectations before the click. */
  blurb: string;
  group: ThemeGroup;
  mode: ThemeMode;

  /** The page itself. */
  canvas: string;
  /** Cards, panels, menus — what sits on the canvas. */
  surface: string;
  /** Primary text. In dark themes this is the near-white, not the near-black. */
  ink: string;
  /** Secondary text: labels, timestamps, the quiet half of every row. */
  muted: string;
  /** The one colour that means "this is the action" — buttons, active tabs. */
  accent: string;
  /** Text drawn ON the accent. Defaults to whichever of black/white is legible. */
  accentText?: string;
  /** The default rule between things. */
  border: string;

  /** Status hues. Defaulted per mode; named per theme only when the default clashes. */
  success?: string;
  warning?: string;
  danger?: string;
  info?: string;

  /**
   * Tokens pinned to an exact value, applied after everything is derived.
   *
   * Used by exactly one theme — `classic`, which must reproduce the palette
   * that shipped before themes existed, to the byte. A derived tint that is
   * two levels off is invisible on its own and obvious next to the four other
   * role consoles, which still render from the literals in palette.css.
   */
  overrides?: Record<string, string>;
}

export interface Theme extends ThemeSeed {
  /** The full `--ef-*` map, ready to write onto an element's style. */
  tokens: Record<string, string>;
  /** Three colours for the picker's swatch, background → accent. */
  swatch: [string, string, string];
}

// Status hues that read correctly against a light vs a dark canvas. A dark
// theme needs a LIGHTER green than a light theme does, for the same reason
// body text flips: the contrast is against the surface behind it.
const STATUS: Record<ThemeMode, { success: string; warning: string; danger: string; info: string }> = {
  light: { success: '#2A6B3A', warning: '#7E5A08', danger: '#9B2828', info: '#3B5F97' },
  dark:  { success: '#5FBF88', warning: '#D9AE5A', danger: '#E8807A', info: '#7FA8E8' },
};

/**
 * Expand a nine-colour seed into the complete token set.
 *
 * Every mix below is expressed as "how much hue, blended into what" so the
 * intent survives: `mix(border, canvas, 0.55)` is "a border, faded most of the
 * way into the page" — which is what `--ef-border-subtle` has always meant.
 */
export function buildTokens(seed: ThemeSeed): Record<string, string> {
  const dark = seed.mode === 'dark';
  const status = STATUS[seed.mode];
  const success = seed.success ?? status.success;
  const warning = seed.warning ?? status.warning;
  const danger  = seed.danger  ?? status.danger;
  const info    = seed.info    ?? status.info;
  const accentText = seed.accentText ?? readableOn(seed.accent);

  const { canvas, surface, ink, muted, border } = seed;

  // Tinted status backgrounds sit on `surface`, because that is where every
  // banner and chip in the app is drawn. A dark theme needs a heavier tint to
  // be visible at all — 6% of a hue into near-black is indistinguishable from
  // near-black.
  const tint       = dark ? 0.13 : 0.08;
  const tintBorder = dark ? 0.34 : 0.30;

  const softOn = (hue: string) => mix(hue, surface, tint);
  const edgeOn = (hue: string) => mix(hue, surface, tintBorder);

  return {
    // ── Text ──────────────────────────────────────────────────────
    '--ef-ink': ink,
    '--ef-text-subtle': mix(ink, muted, 0.62),
    '--ef-text-muted': muted,
    // Text that must survive being drawn on the ink colour (inverted chips,
    // the avatar). Not `surface`: in a mid-tone theme those two can collide.
    '--ef-ink-text': readableOn(ink),

    // ── Surfaces ──────────────────────────────────────────────────
    '--ef-canvas': canvas,
    '--ef-surface': surface,
    // The inset/hover shade. Half a step from surface towards the canvas in a
    // light theme; away from it in a dark one, where "raised" must get
    // lighter or it reads as a hole.
    '--ef-canvas-raised': dark ? mix(surface, ink, 0.94) : mix(surface, canvas, 0.45),
    '--ef-surface-hover': dark ? mix(surface, ink, 0.90) : mix(surface, canvas, 0.55),

    // ── Lines ─────────────────────────────────────────────────────
    '--ef-border': border,
    '--ef-border-subtle': mix(border, canvas, 0.5),
    '--ef-border-muted': mix(border, muted, 0.72),
    '--ef-border-strong': mix(border, ink, 0.62),
    '--ef-track': mix(border, muted, 0.45),

    // ── Accent ────────────────────────────────────────────────────
    '--ef-accent': seed.accent,
    '--ef-accent-text': accentText,
    // Hover moves the accent towards the ink in a light theme (deeper) and
    // towards the surface in a dark one (brighter) — in both cases, "more".
    '--ef-accent-hover': dark ? mix(seed.accent, surface, 0.82) : mix(seed.accent, ink, 0.85),
    '--ef-accent-soft': mix(seed.accent, surface, dark ? 0.18 : 0.10),
    '--ef-accent-border': mix(seed.accent, surface, dark ? 0.38 : 0.32),
    '--ef-accent-muted': mix(seed.accent, muted, 0.5),

    // ── Status ────────────────────────────────────────────────────
    '--ef-success': success,
    '--ef-success-strong': dark ? mix(success, surface, 0.88) : mix(success, ink, 0.88),
    '--ef-success-bg': softOn(success),
    '--ef-success-bg-alt': mix(success, surface, tint * 0.75),
    '--ef-success-border': edgeOn(success),
    '--ef-success-border-alt': mix(success, surface, tintBorder * 0.8),

    '--ef-warning': warning,
    '--ef-warning-strong': dark ? mix(warning, surface, 0.88) : mix(warning, ink, 0.9),
    '--ef-warning-bg': softOn(warning),
    '--ef-warning-border': edgeOn(warning),

    '--ef-danger': danger,
    '--ef-danger-strong': dark ? mix(danger, surface, 0.88) : mix(danger, ink, 0.88),
    '--ef-danger-bg': softOn(danger),
    '--ef-danger-border': edgeOn(danger),

    '--ef-info': info,
    '--ef-info-bg': softOn(info),
    '--ef-info-border': edgeOn(info),

    // ── Depth ─────────────────────────────────────────────────────
    // A shadow is a darker version of the PAGE, not a grey. On a dark canvas
    // a grey shadow glows; this one recedes.
    '--ef-shadow-color': dark ? 'rgba(0,0,0,0.55)' : 'rgba(18,17,15,0.10)',
    '--ef-shadow-sm': dark
      ? '0 1px 2px rgba(0,0,0,0.5)'
      : '0 1px 2px rgba(18,17,15,0.06)',
    '--ef-shadow-md': dark
      ? '0 4px 16px rgba(0,0,0,0.55), 0 1px 3px rgba(0,0,0,0.4)'
      : '0 4px 16px rgba(18,17,15,0.07), 0 1px 2px rgba(18,17,15,0.05)',
    '--ef-shadow-lg': dark
      ? '0 18px 48px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.45)'
      : '0 18px 44px rgba(18,17,15,0.12), 0 2px 6px rgba(18,17,15,0.06)',
    '--ef-overlay': dark ? 'rgba(0,0,0,0.68)' : 'rgba(18,17,15,0.34)',

    // ── Focus ─────────────────────────────────────────────────────
    // a11y.css draws the ring from these. Themed, because a near-black ring on
    // a near-black canvas is not an accessibility feature.
    '--focus-ring': seed.accent,
    '--focus-ring-contrast': surface,

    ...seed.overrides,
  };
}

// ══════════════════════════════════════════════════════════════════
// §3 — THE CATALOG
// ══════════════════════════════════════════════════════════════════

const SEEDS: ThemeSeed[] = [
  // ── Base ────────────────────────────────────────────────────────
  {
    id: 'classic',
    label: 'Classic',
    blurb: 'The original paper-white console.',
    group: 'base',
    mode: 'light',
    canvas: '#F7F6F3',
    surface: '#FFFFFF',
    ink: '#0C0C0B',
    muted: '#6B6B66',
    accent: '#0C0C0B',
    accentText: '#FFFFFF',
    border: '#E3E1DB',
    // Pinned rather than inherited from STATUS.light, which carries a darker
    // warning so the newer warm-canvas themes clear AA. Classic's job is to be
    // yesterday's palette, so it keeps yesterday's amber.
    warning: '#92680A',
    // The literals from palette.css, pinned. A student who never opens the
    // picker must see yesterday's pixels — which is what makes this feature
    // additive rather than a redesign everybody was opted into.
    overrides: {
      '--ef-text-subtle': '#4A4A45',
      '--ef-canvas-raised': '#FAFAF8',
      '--ef-border-subtle': '#F0EFEB',
      '--ef-border-muted': '#DDDBD5',
      '--ef-track': '#C8C7C2',
      '--ef-danger-border': '#F2CECE',
      '--ef-danger-bg': '#FDF5F5',
      '--ef-warning-strong': '#8B5E1A',
      '--ef-warning-border': '#F5DFA0',
      '--ef-success-strong': '#1E7B3C',
      '--ef-success-bg': '#F0F9F4',
      '--ef-success-bg-alt': '#F0F7F2',
      '--ef-success-border': '#B8E6C8',
      '--ef-success-border-alt': '#C6DECE',
    },
  },
  {
    id: 'midnight',
    label: 'Midnight',
    blurb: 'The same console, after dark.',
    group: 'base',
    mode: 'dark',
    canvas: '#0F0F0E',
    surface: '#18181A',
    ink: '#F2F1ED',
    muted: '#9B9A94',
    accent: '#F2F1ED',
    accentText: '#141413',
    border: '#2C2C2A',
  },

  // ── Light ───────────────────────────────────────────────────────
  {
    id: 'linen',
    label: 'Linen & Ink',
    blurb: 'Warm paper, deep navy type.',
    group: 'light',
    mode: 'light',
    canvas: '#F3EFE7',
    surface: '#FCFAF6',
    ink: '#1E2430',
    muted: '#5F6373',
    accent: '#28324A',
    accentText: '#F6F3EC',
    border: '#DFD8C9',
  },
  {
    id: 'cognac',
    label: 'Cognac',
    blurb: 'Cream, with a burnt-orange accent.',
    group: 'light',
    mode: 'light',
    canvas: '#F8F1E6',
    surface: '#FFFDF8',
    ink: '#2E1E12',
    muted: '#75604A',
    accent: '#9C5B27',
    accentText: '#FFF8EE',
    border: '#E9DAC1',
  },
  {
    id: 'sage',
    label: 'Sage',
    blurb: 'Cool grey-green, easy for long sessions.',
    group: 'light',
    mode: 'light',
    canvas: '#F1F4F0',
    surface: '#FFFFFF',
    ink: '#1B241F',
    muted: '#5B6A60',
    accent: '#2F6B4F',
    accentText: '#FFFFFF',
    border: '#DBE3DA',
  },
  {
    id: 'porcelain',
    label: 'Porcelain',
    blurb: 'Neutral white with a cobalt accent.',
    group: 'light',
    mode: 'light',
    canvas: '#F2F3F5',
    surface: '#FFFFFF',
    ink: '#15181D',
    muted: '#63666F',
    accent: '#2C5CC5',
    accentText: '#FFFFFF',
    border: '#E0E2E7',
  },
  {
    id: 'blush',
    label: 'Blush',
    blurb: 'Soft rose paper, plum accent.',
    group: 'light',
    mode: 'light',
    canvas: '#F8F1F2',
    surface: '#FFFCFC',
    ink: '#241A20',
    muted: '#725E67',
    accent: '#8C3F63',
    accentText: '#FFF6F8',
    border: '#EBDBDF',
  },
  {
    id: 'daylight',
    label: 'Daylight',
    blurb: 'High contrast, maximum legibility.',
    group: 'light',
    mode: 'light',
    canvas: '#FFFFFF',
    surface: '#FFFFFF',
    ink: '#000000',
    muted: '#4A4A4A',
    accent: '#0B4FD6',
    accentText: '#FFFFFF',
    border: '#B8B8B8',
    danger: '#B3120E',
    success: '#116631',
    warning: '#7A5200',
  },

  // ── Dark ────────────────────────────────────────────────────────
  {
    id: 'onyx',
    label: 'Onyx & Gold',
    blurb: 'Near-black, with a warm gold accent.',
    group: 'dark',
    mode: 'dark',
    canvas: '#0B0C0E',
    surface: '#16171A',
    ink: '#EDEAE3',
    muted: '#9A958A',
    accent: '#C9A24B',
    accentText: '#100F0B',
    border: '#26272B',
  },
  {
    id: 'emerald',
    label: 'Deep Emerald',
    blurb: 'Forest dark, with a jade accent.',
    group: 'dark',
    mode: 'dark',
    canvas: '#0C1815',
    surface: '#132420',
    ink: '#E7EFE9',
    muted: '#8CA69B',
    accent: '#43B189',
    accentText: '#07110E',
    border: '#1E332C',
  },
  {
    id: 'sapphire',
    label: 'Steel & Sapphire',
    blurb: 'Cool slate, with an electric blue.',
    group: 'dark',
    mode: 'dark',
    canvas: '#101419',
    surface: '#191F27',
    ink: '#E7EBF2',
    muted: '#8C93A3',
    accent: '#5B92E0',
    accentText: '#0A0E14',
    border: '#232B36',
  },
  {
    id: 'copper',
    label: 'Slate & Copper',
    blurb: 'Graphite, with a burnished copper.',
    group: 'dark',
    mode: 'dark',
    canvas: '#1A1C1F',
    surface: '#232529',
    ink: '#EDEDEC',
    muted: '#9A9C9F',
    accent: '#D08350',
    accentText: '#14100D',
    border: '#313338',
  },
  {
    id: 'plum',
    label: 'Plum & Champagne',
    blurb: 'Aubergine, with a champagne accent.',
    group: 'dark',
    mode: 'dark',
    canvas: '#1E1420',
    surface: '#2A1D2C',
    ink: '#F1E6E9',
    muted: '#AE96A6',
    accent: '#DFC084',
    accentText: '#1A1209',
    border: '#372738',
  },
  {
    id: 'bordeaux',
    label: 'Bordeaux',
    blurb: 'Deep wine, with an antique gold.',
    group: 'dark',
    mode: 'dark',
    canvas: '#1E0A0E',
    surface: '#2C1016',
    ink: '#F3E7E4',
    muted: '#AE8C89',
    accent: '#CDA75F',
    accentText: '#1B1207',
    border: '#3A1620',
  },
  {
    id: 'ocean',
    label: 'Deep Ocean',
    blurb: 'Navy, with a cyan accent.',
    group: 'dark',
    mode: 'dark',
    canvas: '#0A1220',
    surface: '#111C2E',
    ink: '#E6EDF7',
    muted: '#8794A9',
    accent: '#3FA9C9',
    accentText: '#05101A',
    border: '#1C2A40',
  },
  {
    id: 'graphite',
    label: 'Graphite',
    blurb: 'Pure neutral dark, no colour cast.',
    group: 'dark',
    mode: 'dark',
    canvas: '#141416',
    surface: '#1D1D20',
    ink: '#EDEDED',
    muted: '#9A9A9D',
    accent: '#B9BDC4',
    accentText: '#141416',
    border: '#2A2A2E',
  },
  {
    id: 'nocturne',
    label: 'Nocturne',
    blurb: 'Low-glare dark for late revision.',
    group: 'dark',
    mode: 'dark',
    canvas: '#12130F',
    surface: '#1B1D17',
    ink: '#E6E7DD',
    muted: '#95978A',
    accent: '#A8B87A',
    accentText: '#11130C',
    border: '#282A22',
  },
];

/** Every theme, keyed by id. */
export const THEMES: Record<string, Theme> = Object.fromEntries(
  SEEDS.map((seed) => [
    seed.id,
    {
      ...seed,
      tokens: buildTokens(seed),
      swatch: [seed.canvas, seed.surface, seed.accent] as [string, string, string],
    },
  ]),
);

export const THEME_LIST: Theme[] = SEEDS.map((s) => THEMES[s.id]);

/**
 * The two themes `system` resolves to.
 *
 * Named rather than "the first light one" so that reordering the catalog can
 * never silently change what following the OS means.
 */
export const SYSTEM_LIGHT = 'classic';
export const SYSTEM_DARK = 'midnight';

/** `'system'` is a valid stored preference; it is not a theme. */
export type ThemeChoice = string;
export const SYSTEM_CHOICE = 'system';

export const DEFAULT_CHOICE: ThemeChoice = SYSTEM_CHOICE;

export function isKnownChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && (value === SYSTEM_CHOICE || value in THEMES);
}

/** Turn a stored choice + the OS preference into the theme actually shown. */
export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): Theme {
  if (choice === SYSTEM_CHOICE) return THEMES[prefersDark ? SYSTEM_DARK : SYSTEM_LIGHT];
  return THEMES[choice] ?? THEMES[SYSTEM_LIGHT];
}

export function themesInGroup(group: ThemeGroup): Theme[] {
  return THEME_LIST.filter((t) => t.group === group);
}

export const GROUP_LABELS: Record<ThemeGroup, { title: string; caption: string }> = {
  base:  { title: 'Base',  caption: 'The platform defaults.' },
  light: { title: 'Light', caption: 'Paper-first palettes for bright rooms.' },
  dark:  { title: 'Dark',  caption: 'Low-light palettes for evening study.' },
};
