/**
 * The exam shell's exemption, checked against the stylesheet itself.
 *
 * ── THE FAILURE THIS CATCHES ──────────────────────────────────────
 * `.ef-exam-scope` keeps a candidate's exam looking the same whatever theme
 * their account carries, by re-declaring the platform palette for that
 * subtree. That works only for as long as it declares EVERY token. Add a
 * token to `:root` and forget the exam scope, and it silently inherits the
 * themed value from `<html>` — one gold border on an otherwise pinned screen,
 * shipped, and noticed by nobody until an invigilator asks why two candidates'
 * screens differ.
 *
 * Nothing else would catch it. A type checker does not read CSS; a render test
 * in jsdom does not compute custom properties from stylesheets; and the value
 * only diverges for accounts that have chosen a theme, which no fixture does
 * by default.
 *
 * ── WHY IT PARSES THE FILE ────────────────────────────────────────
 * Because the file is the source of truth, and the property this needs to
 * assert is about the file's structure rather than about any rendered pixel:
 * two selectors must declare the same set of names. That is a text property,
 * so it is checked as one.
 *
 * ── WHAT MAKES IT PASS TODAY ──────────────────────────────────────
 * The palette declares `:root, .ef-exam-scope { … }` as ONE rule, so the two
 * sets are identical by construction and this assertion is quiet. That is the
 * point: it is not measuring today's file, it is fixing the invariant that
 * makes today's file safe to extend. The day someone adds `:root { --ef-new }`
 * on its own — which is the natural way to add a token, and the way that
 * breaks the exemption — this fails and names the token. Verified by doing
 * exactly that before committing it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The stylesheet with comments removed.
 *
 * Stripped first, and deliberately: the file is mostly prose, and every check
 * below reads either a selector or a declaration. A comment that happens to
 * contain the word `background` is not a rule that paints one — the first
 * version of this test believed otherwise and failed on its own documentation.
 */
const css = readFileSync(join(__dirname, 'palette.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

type Rule = { prelude: string; body: string };

/** Every top-level rule, as a selector list and its declarations. */
function rules(): Rule[] {
  const out: Rule[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const prelude = m[1].trim();
    // Skip the inside of at-rules (`@media … { .x { … } }`) — the outer match
    // is consumed first, so what remains here is always a plain rule.
    if (prelude.startsWith('@')) continue;
    out.push({ prelude, body: m[2] });
  }
  return out;
}

/** Custom-property names declared by any rule whose selector list includes `sel`. */
function tokensUnder(sel: string): Set<string> {
  const found = new Set<string>();
  for (const r of rules()) {
    if (!r.prelude.split(',').some((s) => s.trim() === sel)) continue;
    for (const m of r.body.matchAll(/(--[a-z0-9-]+)\s*:/gi)) found.add(m[1]);
  }
  return found;
}

describe('palette.css', () => {
  it('declares the same token set for :root and for .ef-exam-scope', () => {
    const root = tokensUnder(':root');
    const exam = tokensUnder('.ef-exam-scope');

    expect(root.size).toBeGreaterThan(20); // the parse found a real palette

    const missing = [...root].filter((t) => !exam.has(t));
    expect(
      missing,
      `these tokens are themed but NOT pinned for the exam shell — add them to ` +
        `the .ef-exam-scope block: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('pins accent-color for the exam scope as well as for a themed page', () => {
    // `accent-color` is inherited and resolves where it is DECLARED, so
    // re-declaring the tokens is not enough on its own: without its own
    // declaration the exam scope keeps the themed value it inherited from
    // <html>, and native checkboxes render in the candidate's chosen accent.
    expect(css).toMatch(/html\[data-ef-theme\][^{]*\{[^}]*accent-color/);
    expect(css).toMatch(/\.ef-exam-scope\s*\{[^}]*accent-color/);
  });

  it('gates every themed-page override on the data attribute', () => {
    // Any rule that paints a surface must be scoped to [data-ef-theme], or it
    // reaches the consoles before a theme is mounted — and, worse, the printed
    // and exported views that never mount one.
    const risky = rules()
      .filter((r) => {
        // A declaration that PAINTS, not one that merely names the property —
        // `transition: background-color …` is a rule about timing.
        const paints = r.body
          .split(';')
          .some((d) => /^\s*background(-color)?\s*:/.test(d));
        if (!paints) return false;
        return (
          !r.prelude.includes('[data-ef-theme]') &&
          !r.prelude.includes('.ef-exam-scope') &&
          !r.prelude.includes(':root')
        );
      })
      .map((r) => r.prelude);

    expect(risky, `ungated surface rules: ${risky.join(' | ')}`).toEqual([]);
  });
});
