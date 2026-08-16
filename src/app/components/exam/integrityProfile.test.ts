/**
 * The property that makes this change safe.
 *
 * Everything resolveIntegrityProfile does is a relaxation, so the risk is not
 * that it relaxes too little — it is that a rule written for a phone quietly
 * reaches a desktop and turns a detector off where it was working. The first
 * suite below pins the proctored-desktop case field by field. If that suite
 * passes, no existing high-stake sitting changed behaviour, whatever else
 * moved.
 */

import { describe, it, expect } from 'vitest';
import { resolveIntegrityProfile } from './integrityProfile';

describe('resolveIntegrityProfile — proctored sittings on a desktop are unchanged', () => {
  it('runs every detector at high_stake, exactly as before', () => {
    expect(resolveIntegrityProfile('high_stake', 'desktop')).toMatchObject({
      viewportGeometry: true,
      contextMenuViolation: true,
      renderThrottle: true,
      warningsTerminate: true,
    });
  });

  it('runs every detector at normal, exactly as before', () => {
    expect(resolveIntegrityProfile('normal', 'desktop')).toMatchObject({
      viewportGeometry: true,
      contextMenuViolation: true,
      renderThrottle: true,
      warningsTerminate: true,
    });
  });

  it('treats a legacy attempt with no tier as proctored', () => {
    // Same rule codeEditorPasteAllowed applies to the same input: an absent
    // tier is an old document, and old documents get the strict reading.
    expect(resolveIntegrityProfile(undefined, 'desktop')).toMatchObject({
      viewportGeometry: true,
      warningsTerminate: true,
    });
  });
});

describe('resolveIntegrityProfile — detectors that measure desktop chrome', () => {
  // These three do not produce weaker signal on a phone. They produce FALSE
  // signal: events the device manufactured, written into a log an examiner
  // reads as evidence.
  for (const device of ['mobile', 'tablet'] as const) {
    it(`silences the viewport geometry detector on ${device}`, () => {
      // On Android Chrome the outer/inner gap exceeds the 160px threshold at
      // rest, so the baseline refuses it and the first poll reports DevTools —
      // on every phone, before the student has answered anything.
      expect(resolveIntegrityProfile('normal', device).viewportGeometry).toBe(false);
    });

    it(`silences the render-throttle detector on ${device}`, () => {
      // iOS throttles requestAnimationFrame during scroll momentum, which is
      // what reading a long passage looks like.
      expect(resolveIntegrityProfile('normal', device).renderThrottle).toBe(false);
    });

    it(`does not call a long press a right-click on ${device}`, () => {
      expect(resolveIntegrityProfile('normal', device).contextMenuViolation).toBe(false);
    });
  }

  it('silences them at high_stake too, if a tablet ever gets that far', () => {
    // A tablet reaches a high-stake exam only if the device gate was bypassed,
    // and a bypassed gate is not a reason to start generating false events. The
    // real signal in that case is the attempt's own deviceClass, which the
    // server wrote from the request header.
    expect(resolveIntegrityProfile('high_stake', 'tablet')).toMatchObject({
      viewportGeometry: false,
      renderThrottle: false,
      contextMenuViolation: false,
    });
  });
});

describe('resolveIntegrityProfile — practice does not terminate', () => {
  it('records warnings at mock but never ends the sitting on them', () => {
    // Not "do not count" — violations still fire and the server still counts
    // them. The third one just does not auto-submit a practice paper.
    const p = resolveIntegrityProfile('mock', 'desktop');
    expect(p.warningsTerminate).toBe(false);
  });

  it('holds on a phone, which is where mock is actually sat', () => {
    expect(resolveIntegrityProfile('mock', 'mobile').warningsTerminate).toBe(false);
  });

  it('keeps termination on for both proctored tiers', () => {
    expect(resolveIntegrityProfile('normal', 'desktop').warningsTerminate).toBe(true);
    expect(resolveIntegrityProfile('high_stake', 'desktop').warningsTerminate).toBe(true);
    // Including on a phone: a proctored exam that somehow ran on one is still
    // proctored. Only the chrome-measuring detectors are device-conditional.
    expect(resolveIntegrityProfile('normal', 'mobile').warningsTerminate).toBe(true);
  });
});

describe('resolveIntegrityProfile — the summary the student is shown', () => {
  it('does not promise a practice candidate that they are being watched', () => {
    // The briefing page used to say "This exam is monitored for academic
    // integrity" and "after 3 violations your exam will be automatically
    // terminated" to every candidate, including a mock one for whom both
    // sentences were false.
    expect(resolveIntegrityProfile('mock', 'desktop').summary).toEqual({
      monitored: false,
      terminates: false,
    });
  });

  it('says both to a proctored candidate', () => {
    expect(resolveIntegrityProfile('normal', 'desktop').summary).toEqual({
      monitored: true,
      terminates: true,
    });
  });

  it('never contradicts the behaviour it describes', () => {
    // The summary is copy and the flags are behaviour; the whole point of
    // deriving them together is that they cannot drift.
    for (const tier of ['mock', 'normal', 'high_stake'] as const) {
      for (const device of ['desktop', 'mobile', 'tablet'] as const) {
        const p = resolveIntegrityProfile(tier, device);
        expect(p.summary.terminates).toBe(p.warningsTerminate);
      }
    }
  });
});
