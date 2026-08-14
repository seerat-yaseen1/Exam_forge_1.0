/**
 * Printing was the one exfiltration route with no cost attached.
 *
 * Copy and paste are intercepted, right-click is blocked, a snipping tool
 * drops focus and fires focus_loss, an AI sidebar is refused at the door.
 * Ctrl+P was not in the intercepted keys, nothing listened for `beforeprint`,
 * and there was no `@media print` rule anywhere in the codebase — so "Save as
 * PDF" handed a student the whole visible paper in one keystroke.
 *
 * Three layers cover three different routes, and the tests are organised the
 * same way. The stylesheet matters most: it is the only one that works against
 * the routes nobody enumerated.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  installPrintGuard,
  buildPrintBlockCss,
  PRINT_GUARD_ATTR,
  PRINT_STYLE_ID,
} from './printGuard';

const cleanups: Array<() => void> = [];

function guard(onPrintAttempt = vi.fn()) {
  const stop = installPrintGuard({ onPrintAttempt });
  cleanups.push(stop);
  return { onPrintAttempt, stop };
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  document.getElementById(PRINT_STYLE_ID)?.remove();
  document.documentElement.removeAttribute(PRINT_GUARD_ATTR);
});

describe('the print stylesheet', () => {
  it('installs a print rule scoped to a live sitting', () => {
    guard();
    const style = document.getElementById(PRINT_STYLE_ID);
    expect(style).not.toBeNull();
    expect(style!.textContent).toContain('@media print');
    expect(document.documentElement.hasAttribute(PRINT_GUARD_ATTR)).toBe(true);
  });

  it('scopes the rule to the guard attribute, never globally', () => {
    // A results page and a briefing must stay printable. The restriction
    // belongs to a sitting in progress, not to the application.
    const css = buildPrintBlockCss();
    for (const line of css.split('\n')) {
      if (line.includes('visibility') || line.includes('content:')) continue;
      if (!line.trim().endsWith('{')) continue;
      if (line.includes('@media')) continue;
      expect(line).toContain(PRINT_GUARD_ATTR);
    }
  });

  it('hides the paper and says why', () => {
    // A blank sheet reads as a bug, and a student who thinks it is a bug tries
    // again — each retry another violation for something they did not know was
    // refused.
    const css = buildPrintBlockCss();
    expect(css).toContain('visibility: hidden');
    expect(css.toLowerCase()).toContain('printing is disabled');
  });

  it('leaves the on-screen layout alone', () => {
    // `display: none` would reflow the live exam when the print media query is
    // evaluated. A detector must not make the page it protects jump.
    expect(buildPrintBlockCss()).not.toContain('display: none');
  });

  it('removes the rule and the marker on cleanup', () => {
    // A print rule that outlived the exam would silently blank the student's
    // own results page.
    const { stop } = guard();
    stop();
    cleanups.pop();
    expect(document.getElementById(PRINT_STYLE_ID)).toBeNull();
    expect(document.documentElement.hasAttribute(PRINT_GUARD_ATTR)).toBe(false);
  });

  it('does not stack a second stylesheet on re-install', () => {
    guard();
    guard();
    expect(document.querySelectorAll(`#${PRINT_STYLE_ID}`)).toHaveLength(1);
  });

  it('a second guard\'s cleanup does not strip the first one\'s rule', () => {
    // Overlapping installs during a remount must not leave a live exam
    // printable because the later cleanup ran first.
    const first = installPrintGuard({ onPrintAttempt: vi.fn() });
    const second = installPrintGuard({ onPrintAttempt: vi.fn() });
    second();
    expect(document.getElementById(PRINT_STYLE_ID)).not.toBeNull();
    first();
    expect(document.getElementById(PRINT_STYLE_ID)).toBeNull();
  });
});

describe('the print event', () => {
  it('reports a print started from anywhere', () => {
    // The browser menu, window.print() from a console, and the OS shortcut all
    // reach printing without a keydown this page ever sees. beforeprint is
    // what makes those visible in the record.
    const { onPrintAttempt } = guard();
    window.dispatchEvent(new Event('beforeprint'));
    expect(onPrintAttempt).toHaveBeenCalledTimes(1);
    expect(onPrintAttempt.mock.calls[0][0]).toMatch(/print/i);
  });

  it('collapses one attempt into one record', () => {
    // A single print can deliver beforeprint AND a matchMedia change, and more
    // than one of each on some browsers. The record should say the student
    // tried to print, once — not carry four rows describing one keystroke.
    const { onPrintAttempt } = guard();
    window.dispatchEvent(new Event('beforeprint'));
    window.dispatchEvent(new Event('beforeprint'));
    window.dispatchEvent(new Event('beforeprint'));
    expect(onPrintAttempt).toHaveBeenCalledTimes(1);
  });

  it('stops reporting once the guard is removed', () => {
    const { onPrintAttempt, stop } = guard();
    stop();
    cleanups.pop();
    window.dispatchEvent(new Event('beforeprint'));
    expect(onPrintAttempt).not.toHaveBeenCalled();
  });

  it('installs without a working matchMedia', () => {
    // Not every environment this runs in has it, and a detector must never be
    // the thing that breaks an exam.
    const real = window.matchMedia;
    // @ts-expect-error — deliberately removing it for this case.
    delete window.matchMedia;
    try {
      expect(() => guard()).not.toThrow();
      window.dispatchEvent(new Event('beforeprint'));
    } finally {
      window.matchMedia = real;
    }
  });
});

describe('the key intercept', () => {
  it('is registered in IntegrityEngine, as its own violation type', async () => {
    // Asserted at the source: the intercept lives with the other blocked keys
    // rather than here, and a print attempt must stay distinguishable from a
    // generic keyboard_block in the record a reviewer reads.
    const { readFileSync } = await import('fs');
    const path = await import('path');
    const engine = readFileSync(
      path.resolve(__dirname, 'IntegrityEngine.tsx'), 'utf8',
    );
    expect(engine).toContain("key === 'p'");
    expect(engine).toContain("'print_attempt'");
    expect(engine).toContain('installPrintGuard');
  });
});
