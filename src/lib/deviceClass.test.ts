/**
 * Device classification, and the two ways it can be wrong.
 *
 * A false NEGATIVE — a phone or iPad classified as a desktop — is the bypass
 * this module was written to close: it puts a candidate into a high-stake exam
 * on a device the institution explicitly refused.
 *
 * A false POSITIVE — a Surface, a touchscreen ThinkPad, an iMac with a
 * graphics tablet classified as a phone — locks a student out of an exam they
 * are entitled to sit, on hardware nobody said anything against. That is the
 * worse failure of the two, because the student cannot argue with it and has
 * no second device. Most of the cases below are that half.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyDevice,
  deviceAllowed,
  deviceRefusalCopy,
  type DeviceSignals,
} from './deviceClass';

/**
 * A signals bundle with everything explicit. Defaults describe a plain
 * mouse-driven desktop, so each test states only what makes its device
 * different — which is also the diff a reader wants to see.
 */
function signals(over: Partial<DeviceSignals> = {}): DeviceSignals {
  return {
    userAgent: '',
    maxTouchPoints: 0,
    coarsePointer: false,
    screenMinSide: 1080,
    desktopClaimContradicted: false,
    ...over,
  };
}

const UA = {
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  windowsChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  iPhoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  iPadLegacy:
    'Mozilla/5.0 (iPad; CPU OS 12_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.0 Mobile/15E148 Safari/604.1',
  androidPhone:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36',
  androidTablet:
    'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
};

// ══════════════════════════════════════════════════════════════════
// THE BYPASS THIS MODULE EXISTS TO CLOSE
// ══════════════════════════════════════════════════════════════════

describe('classifyDevice — Apple devices wearing a desktop user-agent', () => {
  it('calls an iPadOS 13+ Safari session a tablet, not a desktop', () => {
    // iPadOS reports a Macintosh UA with no iPad token anywhere in it. The
    // old /iPad/ regex found nothing and returned 'desktop', which is how an
    // iPad walked into a desktop-only exam.
    expect(
      classifyDevice(signals({
        userAgent: UA.macSafari,
        maxTouchPoints: 5,
        coarsePointer: true,
        screenMinSide: 820,
      })).deviceClass,
    ).toBe('tablet');
  });

  it('calls an iPhone in "Request Desktop Website" mode a phone', () => {
    // Same UA swap, two taps from the address bar. The screen gives it away.
    expect(
      classifyDevice(signals({
        userAgent: UA.macSafari,
        maxTouchPoints: 5,
        coarsePointer: true,
        screenMinSide: 393,
      })).deviceClass,
    ).toBe('mobile');
  });

  it('records that the desktop claim was contradicted', () => {
    // Not an accusation — desktop mode is a normal accessibility choice — but
    // the server stores it against the attempt and an invigilator may want it.
    const reading = classifyDevice(signals({
      userAgent: UA.macSafari,
      maxTouchPoints: 5,
      screenMinSide: 820,
    }));
    expect(reading.signals.desktopClaimContradicted).toBe(true);
  });

  it('leaves an honest desktop reading unflagged', () => {
    const reading = classifyDevice(signals({ userAgent: UA.macSafari }));
    expect(reading.deviceClass).toBe('desktop');
    expect(reading.signals.desktopClaimContradicted).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
// THE FALSE POSITIVES — desktops that report touch
// ══════════════════════════════════════════════════════════════════

describe('classifyDevice — touch-capable machines that are still desktops', () => {
  it('does not turn a real Mac into a tablet', () => {
    // maxTouchPoints 0 is what every Mac reports, including one driving a
    // touchscreen display over USB-C.
    expect(
      classifyDevice(signals({ userAgent: UA.macSafari, maxTouchPoints: 0 })).deviceClass,
    ).toBe('desktop');
  });

  it('does not turn a Surface or touchscreen laptop into a phone', () => {
    // Ten touch points, a coarse pointer available, and a 1440px screen. The
    // Apple-costume branch cannot reach it (Windows UA) and the coarse-pointer
    // fallback cannot either, because a trackpad means `hover: none` is false
    // and the caller therefore reports coarsePointer: false.
    expect(
      classifyDevice(signals({
        userAgent: UA.windowsChrome,
        maxTouchPoints: 10,
        coarsePointer: false,
        screenMinSide: 1440,
      })).deviceClass,
    ).toBe('desktop');
  });

  it('does not turn a stylus digitiser into a mobile device', () => {
    // Exactly one touch point, which is why the Apple threshold is `> 1`.
    expect(
      classifyDevice(signals({
        userAgent: UA.macSafari,
        maxTouchPoints: 1,
        screenMinSide: 1080,
      })).deviceClass,
    ).toBe('desktop');
  });

  it('keeps a plain mouse-driven desktop a desktop', () => {
    expect(classifyDevice(signals({ userAgent: UA.windowsChrome })).deviceClass).toBe('desktop');
  });
});

// ══════════════════════════════════════════════════════════════════
// THE HONEST MAJORITY — unchanged behaviour, pinned
// ══════════════════════════════════════════════════════════════════

describe('classifyDevice — devices that announce themselves truthfully', () => {
  it('reads an iPhone as mobile', () => {
    expect(
      classifyDevice(signals({
        userAgent: UA.iPhoneSafari,
        maxTouchPoints: 5,
        coarsePointer: true,
        screenMinSide: 393,
      })).deviceClass,
    ).toBe('mobile');
  });

  it('reads an older iPad as a tablet', () => {
    expect(
      classifyDevice(signals({
        userAgent: UA.iPadLegacy,
        maxTouchPoints: 5,
        coarsePointer: true,
        screenMinSide: 768,
      })).deviceClass,
    ).toBe('tablet');
  });

  it('reads an Android phone as mobile', () => {
    expect(
      classifyDevice(signals({
        userAgent: UA.androidPhone,
        maxTouchPoints: 5,
        coarsePointer: true,
        screenMinSide: 412,
      })).deviceClass,
    ).toBe('mobile');
  });

  it('reads an Android tablet as a tablet', () => {
    // No "Mobile" token — that absence is how Android distinguishes the two.
    expect(
      classifyDevice(signals({
        userAgent: UA.androidTablet,
        maxTouchPoints: 5,
        coarsePointer: true,
        screenMinSide: 800,
      })).deviceClass,
    ).toBe('tablet');
  });

  it('falls back to the pointer when the user-agent names nothing it knows', () => {
    // A browser this file has never heard of. The pointer test is the only
    // signal left, and it is unforgeable by a UA string.
    expect(
      classifyDevice(signals({
        userAgent: 'SomeFutureBrowser/1.0',
        maxTouchPoints: 5,
        coarsePointer: true,
        screenMinSide: 400,
      })).deviceClass,
    ).toBe('mobile');
  });

  it('does not guess from an empty environment', () => {
    // Server-side render, or a browser that reports nothing. Refusing a
    // student on no evidence is worse than letting the server decide.
    expect(classifyDevice(signals({ userAgent: '', screenMinSide: 0 })).deviceClass).toBe('desktop');
  });
});

// ══════════════════════════════════════════════════════════════════
// POLICY
// ══════════════════════════════════════════════════════════════════

describe('deviceAllowed', () => {
  it('never refuses a desktop, whatever the policy says', () => {
    expect(deviceAllowed('desktop', { allowMobile: false, allowTablet: false })).toBe(true);
  });

  it('reads the two permissions independently', () => {
    const tabletOnly = { allowMobile: false, allowTablet: true };
    expect(deviceAllowed('tablet', tabletOnly)).toBe(true);
    expect(deviceAllowed('mobile', tabletOnly)).toBe(false);
  });

  it('lets a practice exam through on anything', () => {
    const mock = { allowMobile: true, allowTablet: true };
    expect(deviceAllowed('mobile', mock)).toBe(true);
    expect(deviceAllowed('tablet', mock)).toBe(true);
  });
});

describe('deviceRefusalCopy', () => {
  it('points a phone at the tablet it is allowed to use', () => {
    // Telling a student "laptop or desktop" when a tablet would have done is
    // a refusal that sends them looking for the wrong machine.
    const copy = deviceRefusalCopy('mobile', { allowMobile: false, allowTablet: true });
    expect(copy.detail).toMatch(/tablet/i);
  });

  it('does not offer a tablet when tablets are refused too', () => {
    const copy = deviceRefusalCopy('mobile', { allowMobile: false, allowTablet: false });
    expect(copy.detail).toMatch(/laptop or desktop/i);
    expect(copy.title).not.toMatch(/larger screen/i);
  });

  it('never says "high_stake" at a student', () => {
    for (const cls of ['mobile', 'tablet'] as const) {
      const copy = deviceRefusalCopy(cls, { allowMobile: false, allowTablet: false });
      expect(`${copy.title} ${copy.detail}`).not.toMatch(/high[_ -]?stake|tier/i);
    }
  });
});
