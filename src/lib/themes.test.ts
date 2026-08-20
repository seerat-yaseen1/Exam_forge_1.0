/**
 * themes — what the catalog has to keep being true.
 *
 * A theme is data, so the usual argument for not testing data applies right up
 * until the data is the interface. These four groups check the properties a
 * reviewer would otherwise have to verify by opening eighteen palettes in a
 * browser and squinting:
 *
 *   §1  the maths does what the derivations assume,
 *   §2  `classic` is still byte-identical to the pre-theme palette,
 *   §3  every theme is legible — this is the one that earns the file,
 *   §4  a stored preference can never resolve to nothing.
 */

import { describe, it, expect } from 'vitest';
import {
  contrastRatio,
  DEFAULT_CHOICE,
  isKnownChoice,
  luminance,
  mix,
  readableOn,
  resolveTheme,
  SYSTEM_CHOICE,
  SYSTEM_DARK,
  SYSTEM_LIGHT,
  THEME_LIST,
  THEMES,
} from './themes';

// ══════════════════════════════════════════════════════════════════
// §1 — Colour maths
// ══════════════════════════════════════════════════════════════════

describe('mix', () => {
  it('returns the endpoints at 1 and 0', () => {
    expect(mix('#FF0000', '#0000FF', 1)).toBe('#FF0000');
    expect(mix('#FF0000', '#0000FF', 0)).toBe('#0000FF');
  });

  it('interpolates linearly in sRGB', () => {
    expect(mix('#000000', '#FFFFFF', 0.5)).toBe('#808080');
  });

  it('accepts three-digit hex', () => {
    expect(mix('#FFF', '#000', 1)).toBe('#FFFFFF');
  });

  it('clamps out-of-range amounts rather than producing invalid channels', () => {
    expect(mix('#FF0000', '#0000FF', 4)).toBe('#FF0000');
    expect(mix('#FF0000', '#0000FF', -2)).toBe('#0000FF');
  });
});

describe('contrast', () => {
  it('puts black on white at the WCAG maximum', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#3A6EA5', '#FFFFFF')).toBeCloseTo(contrastRatio('#FFFFFF', '#3A6EA5'), 6);
  });

  it('orders by luminance', () => {
    expect(luminance('#FFFFFF')).toBeGreaterThan(luminance('#808080'));
    expect(luminance('#808080')).toBeGreaterThan(luminance('#000000'));
  });

  it('picks the legible text colour for a background', () => {
    expect(readableOn('#0B0C0E')).toBe('#FFFFFF');
    expect(readableOn('#F7F6F3')).toBe('#0B0B0A');
  });
});

// ══════════════════════════════════════════════════════════════════
// §2 — Classic is the pre-theme palette, unchanged
// ══════════════════════════════════════════════════════════════════

describe('the classic theme', () => {
  // Transcribed from palette.css as it stood before themes existed. If a
  // derivation in buildTokens starts producing a different tint, this is what
  // notices — the difference is invisible alone and obvious beside the Web
  // Owner console, which still resolves these same literals from CSS.
  const PRE_THEME_PALETTE: Record<string, string> = {
    '--ef-ink': '#0C0C0B',
    '--ef-text-muted': '#6B6B66',
    '--ef-text-subtle': '#4A4A45',
    '--ef-surface': '#FFFFFF',
    '--ef-canvas': '#F7F6F3',
    '--ef-canvas-raised': '#FAFAF8',
    '--ef-border': '#E3E1DB',
    '--ef-border-subtle': '#F0EFEB',
    '--ef-border-muted': '#DDDBD5',
    '--ef-track': '#C8C7C2',
    '--ef-danger': '#9B2828',
    '--ef-danger-border': '#F2CECE',
    '--ef-danger-bg': '#FDF5F5',
    '--ef-warning': '#92680A',
    '--ef-warning-strong': '#8B5E1A',
    '--ef-warning-border': '#F5DFA0',
    '--ef-success': '#2A6B3A',
    '--ef-success-strong': '#1E7B3C',
    '--ef-success-bg': '#F0F9F4',
    '--ef-success-bg-alt': '#F0F7F2',
    '--ef-success-border': '#B8E6C8',
    '--ef-success-border-alt': '#C6DECE',
  };

  it.each(Object.entries(PRE_THEME_PALETTE))('%s is still %s', (token, value) => {
    expect(THEMES.classic.tokens[token]).toBe(value);
  });

  it('is what following the system resolves to in light mode', () => {
    expect(resolveTheme(SYSTEM_CHOICE, false).id).toBe('classic');
  });
});

// ══════════════════════════════════════════════════════════════════
// §3 — Every theme has to be readable
// ══════════════════════════════════════════════════════════════════

describe.each(THEME_LIST.map((t) => [t.label, t] as const))('%s', (_label, theme) => {
  const t = theme.tokens;

  it('meets AA for body text on both the page and a card', () => {
    expect(contrastRatio(t['--ef-ink'], t['--ef-canvas'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(t['--ef-ink'], t['--ef-surface'])).toBeGreaterThanOrEqual(4.5);
  });

  it('meets AA for secondary text, which carries every label and timestamp', () => {
    expect(contrastRatio(t['--ef-text-muted'], t['--ef-surface'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(t['--ef-text-muted'], t['--ef-canvas'])).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the accent legible under its own text', () => {
    // Buttons and badges: --ef-accent-text is drawn ON --ef-accent.
    expect(contrastRatio(t['--ef-accent-text'], t['--ef-accent'])).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps the accent visible as a link colour on both backgrounds', () => {
    // 3:1 is the AA floor for large text and UI components. The accent is used
    // for tab underlines, focus rings and icon strokes, not for paragraphs.
    expect(contrastRatio(t['--ef-accent'], t['--ef-surface'])).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(t['--ef-accent'], t['--ef-canvas'])).toBeGreaterThanOrEqual(3);
  });

  it('keeps status text readable on its own tinted background', () => {
    for (const hue of ['success', 'warning', 'danger'] as const) {
      const fg = t[`--ef-${hue}`];
      const bg = t[`--ef-${hue}-bg`];
      expect({ hue, ratio: contrastRatio(fg, bg) }).toEqual({
        hue,
        ratio: expect.any(Number),
      });
      expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('separates the page from the cards on it', () => {
    // Not a contrast requirement — an "are these actually two colours" one. A
    // theme whose canvas and surface are the same renders every card as a
    // floating text block. Daylight is the deliberate exception: it is a
    // maximum-contrast theme where cards are told apart by their border.
    if (theme.id !== 'daylight') {
      expect(t['--ef-canvas']).not.toBe(t['--ef-surface']);
    }
    expect(contrastRatio(t['--ef-border'], t['--ef-surface'])).toBeGreaterThan(1.05);
  });

  it('carries the whole token set', () => {
    // A theme missing a token inherits the previous theme's value, because
    // applying a theme writes properties rather than replacing them.
    const expected = Object.keys(THEMES.classic.tokens);
    expect(Object.keys(t).sort()).toEqual(expected.sort());
  });

  it('declares a focus ring that is visible against its own surface', () => {
    expect(contrastRatio(t['--focus-ring'], t['--ef-surface'])).toBeGreaterThanOrEqual(3);
  });
});

describe('the catalog', () => {
  it('has unique ids', () => {
    const ids = THEME_LIST.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('offers both a light and a dark answer in every group that claims one', () => {
    expect(THEME_LIST.filter((t) => t.mode === 'light').length).toBeGreaterThan(1);
    expect(THEME_LIST.filter((t) => t.mode === 'dark').length).toBeGreaterThan(1);
  });

  it('names a swatch that actually comes from the theme', () => {
    for (const t of THEME_LIST) {
      expect(t.swatch).toEqual([t.canvas, t.surface, t.accent]);
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// §4 — A stored choice always resolves to something
// ══════════════════════════════════════════════════════════════════

describe('resolveTheme', () => {
  it('follows the OS when the choice is system', () => {
    expect(resolveTheme(SYSTEM_CHOICE, true).id).toBe(SYSTEM_DARK);
    expect(resolveTheme(SYSTEM_CHOICE, false).id).toBe(SYSTEM_LIGHT);
  });

  it('ignores the OS once a theme is chosen explicitly', () => {
    expect(resolveTheme('onyx', false).id).toBe('onyx');
    expect(resolveTheme('cognac', true).id).toBe('cognac');
  });

  it('falls back rather than returning undefined for a theme that no longer exists', () => {
    // The case that matters: a student picked a theme, it was renamed in a
    // later release, and their stored preference now names nothing.
    expect(resolveTheme('a-theme-we-removed', false).id).toBe(SYSTEM_LIGHT);
  });

  it('recognises every shipped id, and nothing else', () => {
    expect(isKnownChoice(SYSTEM_CHOICE)).toBe(true);
    for (const t of THEME_LIST) expect(isKnownChoice(t.id)).toBe(true);
    expect(isKnownChoice('nope')).toBe(false);
    expect(isKnownChoice(null)).toBe(false);
    expect(isKnownChoice(42)).toBe(false);
  });

  it('defaults to following the system', () => {
    expect(DEFAULT_CHOICE).toBe(SYSTEM_CHOICE);
  });
});
