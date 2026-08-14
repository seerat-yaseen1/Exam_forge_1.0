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
import { extensionGateBlocks, fullscreenOk, fullscreenSupported } from './ExamBriefingPage';
import { scanForExtensions, scanForForeignDom } from '../../components/exam/extensionScan';

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

// ══════════════════════════════════════════════════════════════════
// THE EXTENSION ENTRY GATE
// ══════════════════════════════════════════════════════════════════
//
// Both halves of the scan block entry, which is the opposite of how they are
// treated inside the exam — and the asymmetry is deliberate, not an
// inconsistency. Refusing entry is recoverable in seconds by the student
// themselves; a mid-exam freeze has no automatic exit and needs a human. So
// the generic detector, whose false positives are unknowable by construction,
// is allowed to block the cheap one and never the expensive one.
//
// This is now the rule standing between a student and their exam, so it is
// tested rather than trusted.

describe('extensionGateBlocks', () => {
  it('admits a genuinely clean scan', () => {
    expect(extensionGateBlocks({ named: [], foreign: [] })).toBe(false);
  });

  it('blocks on a named extension', () => {
    expect(extensionGateBlocks({ named: ['Question AI'], foreign: [] })).toBe(true);
  });

  it('blocks on an unnamed injected node', () => {
    // The case this change exists for. Previously admitted, on reasoning
    // imported from the freeze path where the cost of being wrong is not the
    // same. An unnamed injector is precisely what the fingerprint list cannot
    // see, so admitting it meant waving through the one finding that had no
    // other way of being caught.
    expect(extensionGateBlocks({ named: [], foreign: ['<div#unknown-sidebar>'] })).toBe(true);
  });

  it('blocks on both together', () => {
    expect(extensionGateBlocks({
      named: ['Wordtune'], foreign: ['<x-thing>'],
    })).toBe(true);
  });

  it('is satisfiable on an ordinary clean machine', () => {
    // Not a tautology — it is the property the whole gate rests on. The app's
    // own Firebase App Check container used to appear in `foreign` on every
    // load, so this gate would have refused every student on every machine.
    // scanForForeignDom's allowlist is what makes an empty result reachable,
    // and if that regresses this gate becomes a total outage rather than a
    // check. Asserted here, against the real scanner, on a page dressed the
    // way the app actually renders.
    document.body.innerHTML = '';
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
    const appCheck = document.createElement('div');
    appCheck.id = 'fire_app_check_[DEFAULT]';
    document.body.appendChild(appCheck);

    expect(extensionGateBlocks({
      named: scanForExtensions(),
      foreign: scanForForeignDom(),
    })).toBe(false);
  });
});
