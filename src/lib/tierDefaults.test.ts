/**
 * The security tier's floor.
 *
 * applyTierDefaults is where a tier stops being a label and becomes a set of
 * enforced controls. The tests that matter here are the LOCKS: a locked
 * control that quietly honours an override is a tier promising more than it
 * delivers, and nothing downstream would notice — the exam would publish,
 * students would sit it, and the gap would only be visible to whoever read
 * the stored document.
 *
 * The server re-derives all of this in startExam and never trusts these
 * values, so this suite covers the authoring side of the same rule. Both
 * sides are asserted because they can drift apart, and did: requireSEB was
 * disable-able at high_stake in both until D-10.
 */

import { describe, it, expect } from 'vitest';
import { applyTierDefaults } from './assessmentService';

describe('applyTierDefaults — high_stake locks', () => {
  const asked = {
    requireCamera: false,
    allowMobile: true,
    allowTablet: true,
    requireExtensionCheck: false,
    requireSEB: false,
  };

  it('refuses every attempt to soften the tier', () => {
    expect(applyTierDefaults('high_stake', asked)).toMatchObject({
      requireCamera: true,
      allowMobile: false,
      allowTablet: false,
      requireExtensionCheck: true,
      requireSEB: true,
    });
  });

  it('locks SEB specifically (D-10)', () => {
    // It was the one high-stake control an authority could switch off, and the
    // only one that reaches remote desktop, VPNs and userscript managers. A
    // school without an SEB rollout runs 'normal' — the tier that means web
    // deterrents only — rather than a high-stake exam that cannot enforce it.
    expect(applyTierDefaults('high_stake', { requireSEB: false }).requireSEB).toBe(true);
    expect(applyTierDefaults('high_stake').requireSEB).toBe(true);
    expect(applyTierDefaults('high_stake', { requireSEB: true }).requireSEB).toBe(true);
  });

  it('still allows the one setting the tier does not fix', () => {
    // autoResume is a convenience, not a control — it decides whether a
    // cleared extension check releases the student without an invigilator.
    expect(applyTierDefaults('high_stake', { autoResume: true }).autoResume).toBe(true);
    expect(applyTierDefaults('high_stake').autoResume).toBe(false);
  });
});

describe('applyTierDefaults — the other tiers stay tunable', () => {
  it('normal keeps SEB opt-in in both directions', () => {
    expect(applyTierDefaults('normal').requireSEB).toBe(false);
    expect(applyTierDefaults('normal', { requireSEB: true }).requireSEB).toBe(true);
    expect(applyTierDefaults('normal', { requireSEB: false }).requireSEB).toBe(false);
  });

  it('normal defaults to proctored but honours an authority override', () => {
    expect(applyTierDefaults('normal')).toMatchObject({
      requireCamera: true, allowMobile: false, requireExtensionCheck: true,
    });
    expect(applyTierDefaults('normal', { requireCamera: false }).requireCamera).toBe(false);
  });

  it('mock refuses SEB even when asked for it', () => {
    // Practice is not assessed, so locking a rehearsal behind a browser the
    // student may not have installed costs them the rehearsal for nothing.
    expect(applyTierDefaults('mock').requireSEB).toBe(false);
    expect(applyTierDefaults('mock', { requireSEB: true }).requireSEB).toBe(false);
  });

  it('mock leaves the deterrents off by default', () => {
    expect(applyTierDefaults('mock')).toMatchObject({
      requireCamera: false, allowMobile: true, requireExtensionCheck: false,
    });
  });
});

// ══════════════════════════════════════════════════════════════════
// THE DEVICE AXES
// ══════════════════════════════════════════════════════════════════
//
// `allowMobile` used to cover phones AND tablets, and at 'normal' it was a
// default rather than a lock. Both halves of that changed together, because
// each one is what made the other tolerable: phones can be locked off at
// 'normal' precisely because tablets survived as a separate opt-in, and
// tablets can be opt-in precisely because they are no longer the same switch
// as a phone.

describe('applyTierDefaults — phones', () => {
  it('locks phones off at normal, whatever the author asks for', () => {
    // The lock is the change. It was `?? false` — an author could tick phones
    // back on, and then "normal" said nothing about the device at all. The
    // deterrents this tier advertises do not survive a phone: fullscreen does
    // not exist on iOS Safari, and the viewport detectors read an on-screen
    // keyboard as a docked DevTools panel.
    expect(applyTierDefaults('normal').allowMobile).toBe(false);
    expect(applyTierDefaults('normal', { allowMobile: true }).allowMobile).toBe(false);
    expect(applyTierDefaults('normal', { allowMobile: false }).allowMobile).toBe(false);
  });

  it('locks phones off at high_stake', () => {
    expect(applyTierDefaults('high_stake', { allowMobile: true }).allowMobile).toBe(false);
  });

  it('leaves phones welcome at mock, in both directions', () => {
    // Practice is the tier that means "sit this anywhere", and it has to keep
    // meaning that or the phone-locking above just removes a capability.
    expect(applyTierDefaults('mock').allowMobile).toBe(true);
    expect(applyTierDefaults('mock', { allowMobile: false }).allowMobile).toBe(false);
  });
});

describe('applyTierDefaults — tablets', () => {
  it('is normal\'s one device opt-in, off by default', () => {
    // Off by default so 'normal' out of the box still means a computer;
    // available so an authority that has thought about a 13-inch iPad with a
    // keyboard is not forced to permit a 6-inch phone to get it.
    expect(applyTierDefaults('normal').allowTablet).toBe(false);
    expect(applyTierDefaults('normal', { allowTablet: true }).allowTablet).toBe(true);
    expect(applyTierDefaults('normal', { allowTablet: false }).allowTablet).toBe(false);
  });

  it('locks tablets off at high_stake', () => {
    expect(applyTierDefaults('high_stake', { allowTablet: true }).allowTablet).toBe(false);
  });

  it('leaves tablets welcome at mock', () => {
    expect(applyTierDefaults('mock').allowTablet).toBe(true);
    expect(applyTierDefaults('mock', { allowTablet: false }).allowTablet).toBe(false);
  });

  it('never permits a tablet where it refuses a phone at the same tier', () => {
    // Not a rule the code states anywhere, so it is asserted here: a tablet is
    // the more permissive device of the two, and a tier that allowed phones
    // while refusing tablets would be incoherent rather than strict.
    for (const tier of ['mock', 'normal', 'high_stake'] as const) {
      const d = applyTierDefaults(tier);
      if (d.allowMobile) expect(d.allowTablet).toBe(true);
    }
  });
});

describe('applyTierDefaults — every tier reports itself', () => {
  it('echoes the tier it was given', () => {
    for (const tier of ['mock', 'normal', 'high_stake'] as const) {
      expect(applyTierDefaults(tier).securityTier).toBe(tier);
    }
  });
});
