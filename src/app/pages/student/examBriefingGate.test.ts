/**
 * The briefing page's fullscreen entry condition.
 *
 * This gate was previously not a gate: `isFullscreen` sat in the readiness
 * effect's dependency array and was never read in its body, so the button said
 * "recommended" and let the student through. The shell caught them afterwards
 * with its own overlay, so nothing was ever answerable outside fullscreen —
 * but the attempt had already been created by then, and a requirement enforced
 * after the point of no return is a worse experience for the honest student
 * and no additional obstacle to anyone else.
 *
 * The interesting half is the exemption. `document.fullscreenEnabled` is false
 * on iOS Safari and inside an iframe without `allow="fullscreen"`, and on
 * those the requirement cannot be satisfied at all — enforcing it there locks
 * a student out of an exam their institution deliberately permitted them to
 * sit on that device.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { fullscreenOk, fullscreenSupported } from './ExamBriefingPage';

/**
 * `fullscreenEnabled` is a getter on the Document prototype in jsdom and is
 * not writable by assignment, so each case installs an own-property override
 * and removes it afterwards. Overriding the real thing rather than injecting a
 * seam keeps the test honest about what the function actually reads.
 */
function setFullscreenEnabled(value: boolean | undefined) {
  if (value === undefined) {
    delete (document as unknown as Record<string, unknown>).fullscreenEnabled;
    return;
  }
  Object.defineProperty(document, 'fullscreenEnabled', {
    value, configurable: true, writable: true,
  });
}

const realRequest = document.documentElement.requestFullscreen;

function setRequestFullscreen(fn: unknown) {
  Object.defineProperty(document.documentElement, 'requestFullscreen', {
    value: fn, configurable: true, writable: true,
  });
}

afterEach(() => {
  setFullscreenEnabled(undefined);
  setRequestFullscreen(realRequest);
});

describe('fullscreenSupported', () => {
  it('is true when the document allows it and the method exists', () => {
    setFullscreenEnabled(true);
    setRequestFullscreen(() => Promise.resolve());
    expect(fullscreenSupported()).toBe(true);
  });

  it('is false when a permissions policy forbids it', () => {
    // An iframe without allow="fullscreen" — the API is present and refuses.
    setFullscreenEnabled(false);
    setRequestFullscreen(() => Promise.resolve());
    expect(fullscreenSupported()).toBe(false);
  });

  it('is false when the method is missing entirely', () => {
    setFullscreenEnabled(true);
    setRequestFullscreen(undefined);
    expect(fullscreenSupported()).toBe(false);
  });
});

describe('fullscreenOk', () => {
  it('refuses entry on a capable browser that is not in fullscreen', () => {
    setFullscreenEnabled(true);
    setRequestFullscreen(() => Promise.resolve());
    expect(fullscreenOk(false)).toBe(false);
  });

  it('allows entry on a capable browser once fullscreen is active', () => {
    setFullscreenEnabled(true);
    setRequestFullscreen(() => Promise.resolve());
    expect(fullscreenOk(true)).toBe(true);
  });

  it('does not strand a student whose browser cannot go fullscreen', () => {
    // The requirement is unsatisfiable here. Blocking would not make this
    // sitting more secure, only impossible — the same bargain allowMobile
    // already strikes, and the shell's other detectors still run.
    setFullscreenEnabled(false);
    setRequestFullscreen(() => Promise.resolve());
    expect(fullscreenOk(false)).toBe(true);
  });
});
