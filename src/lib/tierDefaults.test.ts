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
    requireExtensionCheck: false,
    requireSEB: false,
  };

  it('refuses every attempt to soften the tier', () => {
    expect(applyTierDefaults('high_stake', asked)).toMatchObject({
      requireCamera: true,
      allowMobile: false,
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
    expect(applyTierDefaults('normal', { allowMobile: true }).allowMobile).toBe(true);
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

describe('applyTierDefaults — every tier reports itself', () => {
  it('echoes the tier it was given', () => {
    for (const tier of ['mock', 'normal', 'high_stake'] as const) {
      expect(applyTierDefaults(tier).securityTier).toBe(tier);
    }
  });
});
