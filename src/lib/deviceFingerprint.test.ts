/**
 * Device fingerprint drift.
 *
 * This is the heaviest single factor in the risk score, so the cases that
 * matter most are the ones where it must stay SILENT. A browser withholding a
 * value is not a machine changing, and scoring it as one would put 50 points
 * on a student for toggling a privacy setting or for a WebGL context that
 * failed to create on one poll.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  fingerprintDrift,
  getDeviceFingerprint,
  __resetFingerprintCache,
  type DeviceFingerprint,
} from './deviceFingerprint';

const MACHINE: DeviceFingerprint = {
  gpu: 'ANGLE (Intel, Intel(R) UHD Graphics 620, OpenGL 4.1)',
  cores: 8,
  memory: 8,
  platform: 'Win32',
};

describe('fingerprintDrift — silence', () => {
  it('says nothing when the machine is the same', () => {
    expect(fingerprintDrift(MACHINE, { ...MACHINE })).toEqual([]);
  });

  it('says nothing when a value goes missing', () => {
    // A privacy setting toggled mid-sitting, or a WebGL context that failed to
    // create this time. "Could not read it" is an absence of evidence.
    expect(fingerprintDrift(MACHINE, { ...MACHINE, gpu: '' })).toEqual([]);
    expect(fingerprintDrift(MACHINE, { ...MACHINE, cores: 0 })).toEqual([]);
    expect(fingerprintDrift(MACHINE, { ...MACHINE, memory: 0 })).toEqual([]);
  });

  it('says nothing when a value APPEARS that was missing at baseline', () => {
    // The reverse case: the baseline could not read the GPU, a later poll
    // could. Nothing changed about the machine, only about what it would say.
    const blind = { ...MACHINE, gpu: '' };
    expect(fingerprintDrift(blind, MACHINE)).toEqual([]);
  });

  it('says nothing when there is no baseline to compare against', () => {
    // Attempts created before fingerprinting shipped. They must not start
    // reporting drift the moment this deploys.
    expect(fingerprintDrift(null, MACHINE)).toEqual([]);
    expect(fingerprintDrift(undefined, MACHINE)).toEqual([]);
    expect(fingerprintDrift(MACHINE, null)).toEqual([]);
  });

  it('ignores a field absent from both sides', () => {
    expect(fingerprintDrift({ cores: 8 }, { cores: 8 })).toEqual([]);
  });
});

describe('fingerprintDrift — detection', () => {
  it('catches the GPU changing', () => {
    const drift = fingerprintDrift(MACHINE, { ...MACHINE, gpu: 'llvmpipe (LLVM 15.0.7)' });
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain('gpu');
  });

  it('catches the core count changing', () => {
    // The signal the plan named: a VM swapped in behind an honest check.
    const drift = fingerprintDrift(MACHINE, { ...MACHINE, cores: 2 });
    expect(drift).toEqual(['cores: 8 → 2']);
  });

  it('catches the platform changing', () => {
    expect(fingerprintDrift(MACHINE, { ...MACHINE, platform: 'Linux x86_64' }))
      .toEqual(['platform: Win32 → Linux x86_64']);
  });

  it('reports every field that moved', () => {
    // A wholesale machine change, which is what a resumed-elsewhere sitting
    // actually looks like.
    expect(fingerprintDrift(MACHINE, {
      gpu: 'llvmpipe (LLVM 15.0.7)', cores: 2, memory: 4, platform: 'Linux x86_64',
    })).toHaveLength(4);
  });

  it('bounds each reported value so a long GPU string cannot bloat the record', () => {
    const drift = fingerprintDrift(
      { ...MACHINE, gpu: 'A'.repeat(500) },
      { ...MACHINE, gpu: 'B'.repeat(500) },
    );
    // 40 chars a side plus the field name and arrow — nowhere near the
    // attempt document's ceiling.
    expect(drift[0].length).toBeLessThan(100);
  });
});

describe('getDeviceFingerprint', () => {
  // jsdom's getContext throws "Not implemented" rather than returning null, so
  // each case below installs the browser behaviour it is actually about. Both
  // are real: a browser can refuse a WebGL context (returns null) or have
  // canvas blocked outright (throws).
  const realGetContext = HTMLCanvasElement.prototype.getContext;

  beforeEach(__resetFingerprintCache);
  afterEach(() => { HTMLCanvasElement.prototype.getContext = realGetContext; });

  it('returns the same object on every call within a page load', () => {
    // Caching is not only an optimisation: recomputing per heartbeat would let
    // a transient GPU condition read as the hardware changing underneath the
    // student. The machine cannot change without a new page load.
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    expect(getDeviceFingerprint()).toBe(getDeviceFingerprint());
  });

  it('reports an empty GPU when the browser refuses a WebGL context', () => {
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    const fp = getDeviceFingerprint();
    expect(fp.gpu).toBe('');
    expect(typeof fp.cores).toBe('number');
    expect(typeof fp.platform).toBe('string');
  });

  it('survives a browser that throws on canvas access', () => {
    // A hardened or privacy-patched browser. A detector must never be the
    // thing that stops an exam.
    HTMLCanvasElement.prototype.getContext = (() => {
      throw new Error('canvas blocked');
    }) as never;
    expect(() => getDeviceFingerprint()).not.toThrow();
    expect(getDeviceFingerprint().gpu).toBe('');
  });

  it('falls back to the plain renderer when the debug extension is withheld', () => {
    // Browsers have been progressively restricting WEBGL_debug_renderer_info.
    // The generic string it falls back to cannot tell two machines apart, but
    // it can still tell that the answer changed, which is all this needs.
    HTMLCanvasElement.prototype.getContext = (() => ({
      getExtension: () => null,
      getParameter: () => 'WebKit WebGL',
      RENDERER: 0x1f01,
    })) as never;
    expect(getDeviceFingerprint().gpu).toBe('WebKit WebGL');
  });

  it('never reports a machine that drifts from itself', () => {
    HTMLCanvasElement.prototype.getContext = (() => null) as never;
    const fp = getDeviceFingerprint();
    expect(fingerprintDrift(fp, fp)).toEqual([]);
  });
});
