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
import { fullscreenOk, fullscreenSupported, deviceGateOk } from './ExamBriefingPage';
import { effectiveDevicePolicy } from '../../../lib/deviceClass';
import {
  extensionGateBlocks,
  scanForExtensions,
  scanForForeignDom,
} from '../../components/exam/extensionScan';

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

// ══════════════════════════════════════════════════════════════════
// THE DEVICE ENTRY GATE
// ══════════════════════════════════════════════════════════════════
//
// The device policy used to be enforced in exactly one place: startExam,
// server-side, after the student had finished the briefing and pressed Enter.
// They were then refused with the raw string `DEVICE_NOT_ALLOWED: …`, because
// nothing on the client translated it.
//
// That is the failure the fullscreen gate above was written to fix, and it is
// worse here: a student can put a browser into fullscreen, and cannot turn a
// phone into a laptop. Arriving late at this requirement costs them the walk
// to a different machine plus everything they did on the briefing first.
//
// The server still decides. These tests cover the client asking the same
// question early — and specifically that it derives the EFFECTIVE policy
// rather than reading the stored fields, because a 'normal' exam published
// before phones were locked off stores allowMobile:true and the two answers
// would otherwise disagree.

describe('deviceGateOk', () => {
  const mock = { securityTier: 'mock' as const };
  const normal = { securityTier: 'normal' as const };
  const highStake = { securityTier: 'high_stake' as const };

  it('has no opinion before the assessment loads', () => {
    // Refusing on a null assessment would flash the wrong-device panel on
    // every phone for as long as the fetch takes, including on the practice
    // exams that are allowed to run there.
    expect(deviceGateOk('mobile', null)).toBe(true);
  });

  it('never refuses a desktop', () => {
    for (const a of [mock, normal, highStake]) {
      expect(deviceGateOk('desktop', a)).toBe(true);
    }
  });

  it('lets a practice exam run on a phone', () => {
    // The whole point of the tier. If this breaks, mock stops being the thing
    // that distinguishes it.
    expect(deviceGateOk('mobile', mock)).toBe(true);
    expect(deviceGateOk('tablet', mock)).toBe(true);
  });

  it('refuses phones and tablets at high_stake', () => {
    expect(deviceGateOk('mobile', highStake)).toBe(false);
    expect(deviceGateOk('tablet', highStake)).toBe(false);
  });

  it('refuses phones at normal even where the document says otherwise', () => {
    // An unpublished 'normal' draft carrying allowMobile:true from before the
    // lock. No securityLockedAt, so no grandfather, so the lock applies — and
    // the briefing must reach the same verdict startExam will.
    expect(deviceGateOk('mobile', { ...normal, allowMobile: true })).toBe(false);
  });

  it('honours the grandfather clause for an already-published exam', () => {
    // securityLockedAt present AND allowMobile explicitly true: this exam was
    // published telling students to bring a phone. Refusing it now would
    // strand a candidate mid-window over a device their institution chose.
    expect(deviceGateOk('mobile', {
      ...normal, allowMobile: true, securityLockedAt: '2026-01-01T00:00:00.000Z',
    })).toBe(true);
  });

  it('does not grandfather an exam that never opted in', () => {
    expect(deviceGateOk('mobile', {
      ...normal, allowMobile: false, securityLockedAt: '2026-01-01T00:00:00.000Z',
    })).toBe(false);
  });

  it('lets tablets through at normal when the authority admitted them', () => {
    expect(deviceGateOk('tablet', { ...normal, allowTablet: true })).toBe(true);
    // …and still refuses phones, which is the reason the flag was split.
    expect(deviceGateOk('mobile', { ...normal, allowTablet: true })).toBe(false);
  });

  it('refuses tablets at normal by default', () => {
    expect(deviceGateOk('tablet', normal)).toBe(false);
  });

  it('leaves a legacy assessment with no tier open', () => {
    // Nothing was ever gated on these, and startExam's isLegacy branch says
    // the same. A briefing stricter than the server would refuse a student the
    // server would have admitted.
    expect(deviceGateOk('mobile', {})).toBe(true);
    expect(deviceGateOk('tablet', {})).toBe(true);
  });
});

describe('effectiveDevicePolicy — tablets inherit the pre-split flag', () => {
  it('reads a pre-split normal exam that allowed mobile as allowing tablets', () => {
    // Before the split, one flag covered both. A 'normal' exam that admitted
    // phones certainly admitted tablets, so the absent allowTablet field
    // inherits rather than defaulting to false and silently narrowing an exam
    // that was already published.
    expect(effectiveDevicePolicy({
      securityTier: 'normal', allowMobile: true,
    }).allowTablet).toBe(true);
  });

  it('does not invent a tablet permission from nothing', () => {
    expect(effectiveDevicePolicy({ securityTier: 'normal' }).allowTablet).toBe(false);
  });
});
