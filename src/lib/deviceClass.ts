/**
 * What kind of machine is this, and may it sit this exam?
 *
 * ── WHY THIS MOVED OUT OF submissionService ───────────────────────
 * The detector used to be a private function in submissionService.ts, called
 * once, at startAttempt — which is to say AFTER the student had finished the
 * briefing, granted camera, passed the extension scan and pressed Enter. The
 * server then refused them. Three surfaces need this answer before that point
 * (the assessment card, the briefing gate, the shell's error translation), so
 * it lives here and they all read the same one.
 *
 * ── WHAT THIS CAN AND CANNOT DO ───────────────────────────────────
 * Everything below is an HONEST-MAJORITY signal. A determined candidate can
 * edit the user-agent string, and nothing measured here survives that. What it
 * does do is stop the two accidental bypasses that need no tooling at all:
 *
 *   1. iPadOS 13+ Safari reports "Macintosh; Intel Mac OS X" and omits "iPad"
 *      entirely. The old regex looked for /iPad/ and found nothing, so every
 *      iPad classified as `desktop` and walked into a high-stake exam.
 *   2. iOS Safari's "Request Desktop Website" does the same thing to an
 *      iPhone, and it is two taps from the address bar.
 *
 * Both are closed by one observation: a real Mac reports
 * `navigator.maxTouchPoints === 0`. There is no Apple desktop with a
 * touchscreen, so a Macintosh UA claiming touch points is an iOS device
 * wearing a costume. See IPAD_TOUCH_POINTS_MIN for why the threshold is 1
 * rather than 0.
 *
 * Real device assurance for high-stake exams comes from Safe Exam Browser's
 * header check, not from here. This is the layer that keeps honest students
 * out of a device they were never meant to use, and makes the refusal legible
 * when it happens.
 */

export type DeviceClass = 'desktop' | 'mobile' | 'tablet';

/**
 * A Mac reports 0. An iPad reports 5. The comparison is `> 1` rather than
 * `> 0` because a handful of Windows touch-screen laptops report exactly 1
 * through a stylus digitiser, and those are desktops — but they carry a
 * Windows UA and never reach this branch anyway. The margin is belt and
 * braces for the day a Mac ships a trackpad that reports one point.
 */
const IPAD_TOUCH_POINTS_MIN = 1;

/**
 * The short side of the screen, in CSS pixels, below which a touch device is a
 * phone rather than a tablet. An iPhone 15 Pro Max is 430; an iPad mini is
 * 744. 600 sits in the empty space between the two populations.
 */
const TABLET_MIN_SIDE_PX = 600;

/** Everything the classification looked at, for the audit trail. */
export type DeviceSignals = {
  userAgent: string;
  maxTouchPoints: number;
  /** The primary pointer cannot hover and is imprecise — a finger. */
  coarsePointer: boolean;
  /** Short side of window.screen in CSS px; 0 when unavailable. */
  screenMinSide: number;
  /**
   * The UA claimed a desktop OS and something else disagreed. Not proof of
   * intent — "Request Desktop Website" is one tap and students turn it on for
   * reasons that have nothing to do with an exam — but worth recording, since
   * the server stores it against the attempt and an invigilator reading a
   * roster should be able to see it.
   */
  desktopClaimContradicted: boolean;
};

export type DeviceReading = {
  deviceClass: DeviceClass;
  signals: DeviceSignals;
};

/**
 * Does the primary input device behave like a finger?
 *
 * `pointer: coarse` alone is not enough — a Windows laptop with a touchscreen
 * matches it while a mouse is plugged in. Pairing it with `hover: none` asks
 * whether the primary pointer can hover at all, and a laptop with any mouse
 * or trackpad answers yes. So the two together mean "touch is the only way to
 * drive this", which is a phone or a tablet and not a convertible.
 */
function hasCoarsePrimaryPointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia('(pointer: coarse)').matches
      && window.matchMedia('(hover: none)').matches;
  } catch {
    // matchMedia exists but the query is unsupported — treat as no evidence.
    return false;
  }
}

function readSignals(): DeviceSignals {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const userAgent = nav?.userAgent ?? '';
  const maxTouchPoints = nav?.maxTouchPoints ?? 0;
  const screen = typeof window === 'undefined' ? undefined : window.screen;
  const screenMinSide = screen
    ? Math.min(screen.width ?? 0, screen.height ?? 0)
    : 0;
  return {
    userAgent,
    maxTouchPoints,
    coarsePointer: hasCoarsePrimaryPointer(),
    screenMinSide,
    desktopClaimContradicted: false,
  };
}

/**
 * Classify from signals alone — pure, so the interesting cases are testable
 * without a browser. `detectDeviceClass()` below is the thin wrapper that
 * reads the real ones.
 *
 * Order matters. The desktop-costume check runs FIRST, because the UA it is
 * looking at would otherwise satisfy none of the mobile patterns and fall
 * straight through to `desktop` — which is exactly the bug.
 */
export function classifyDevice(signals: DeviceSignals): DeviceReading {
  const { userAgent: ua, maxTouchPoints, coarsePointer, screenMinSide } = signals;
  const touch = maxTouchPoints > 0 || coarsePointer;

  // ── 1. An Apple desktop UA that reports touch is an iOS device ──
  //
  // Covers iPadOS 13+ (which does this by default) and iPhone/iPad Safari
  // under "Request Desktop Website". Split by screen size for the same reason
  // the honest path does: an iPhone in desktop mode is still a phone, and the
  // exam it may sit is a different question from the one an iPad may.
  const claimsAppleDesktop = /Macintosh|Mac OS X/i.test(ua) && !/iPhone|iPad|iPod/i.test(ua);
  if (claimsAppleDesktop && maxTouchPoints > IPAD_TOUCH_POINTS_MIN) {
    return {
      deviceClass: screenMinSide > 0 && screenMinSide < TABLET_MIN_SIDE_PX ? 'mobile' : 'tablet',
      signals: { ...signals, desktopClaimContradicted: true },
    };
  }

  // ── 2. The honest path — unchanged from the original detector ───
  // These regexes were already right for the overwhelming majority of
  // devices, so they are preserved verbatim rather than rewritten.
  const isTablet =
    /iPad|Tablet|PlayBook|Silk/i.test(ua) ||
    (touch && screenMinSide >= TABLET_MIN_SIDE_PX && /Android/i.test(ua) && !/Mobile/i.test(ua));
  const isMobile =
    /Mobi|Android.*Mobile|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua) ||
    (touch && screenMinSide > 0 && screenMinSide < TABLET_MIN_SIDE_PX);

  if (isTablet) return { deviceClass: 'tablet', signals };
  if (isMobile) return { deviceClass: 'mobile', signals };

  // ── 3. Touch-only, on a UA that names no known mobile OS ────────
  //
  // A phone or tablet running a browser this file has never heard of. The
  // pointer test is the one signal here that no UA string can forge, and it
  // is required to be UNAMBIGUOUS (coarse AND no hover) precisely so that a
  // Surface, a touchscreen ThinkPad or an iMac with a graphics tablet — all
  // of which are desktops, and all of which report touch points — stay
  // desktops. See hasCoarsePrimaryPointer.
  if (coarsePointer && screenMinSide > 0) {
    return {
      deviceClass: screenMinSide < TABLET_MIN_SIDE_PX ? 'mobile' : 'tablet',
      signals,
    };
  }

  return { deviceClass: 'desktop', signals };
}

/** Read the live browser and classify it. */
export function readDevice(): DeviceReading {
  return classifyDevice(readSignals());
}

/** The classification alone, for callers that do not need the signals. */
export function detectDeviceClass(): DeviceClass {
  return readDevice().deviceClass;
}

// ══════════════════════════════════════════════════════════════════
// POLICY
// ══════════════════════════════════════════════════════════════════

/**
 * The two device permissions, as the exam contract holds them.
 *
 * These are the EFFECTIVE values — the ones applyTierDefaults produced and the
 * server re-derived — not an author's raw request. A caller passing the raw
 * assessment fields would be asking a different, softer question than the one
 * startExam will ask, and the two must never disagree.
 */
export type DevicePolicy = {
  allowMobile: boolean;
  allowTablet: boolean;
};

export function deviceAllowed(deviceClass: DeviceClass, policy: DevicePolicy): boolean {
  if (deviceClass === 'mobile') return policy.allowMobile;
  if (deviceClass === 'tablet') return policy.allowTablet;
  return true;
}

/**
 * What to tell a student whose device is refused.
 *
 * Two fields, because the two do different jobs: `title` is the sentence they
 * read first and `detail` is the one that tells them what to do about it.
 * Neither mentions a tier name — "high_stake" is our vocabulary, not theirs.
 */
export function deviceRefusalCopy(
  deviceClass: DeviceClass,
  policy: DevicePolicy,
): { title: string; detail: string } {
  const tabletWelcome = policy.allowTablet && deviceClass === 'mobile';
  if (tabletWelcome) {
    return {
      title: 'This exam needs a larger screen',
      detail:
        'Phones are not permitted for this exam. Open it on a laptop, a desktop computer or a tablet — the same link works, and nothing you have done so far is lost.',
    };
  }
  return {
    title: 'This exam must be taken on a laptop or desktop',
    detail:
      deviceClass === 'tablet'
        ? 'Tablets are not permitted for this exam. Open the same link on a laptop or desktop computer to begin.'
        : 'Phones and tablets are not permitted for this exam. Open the same link on a laptop or desktop computer to begin.',
  };
}

/**
 * A one-word label for the device, for badges and roster columns.
 * Sentence case, because it is read inside sentences as often as beside them.
 */
export function deviceLabel(deviceClass: DeviceClass): string {
  if (deviceClass === 'mobile') return 'Phone';
  if (deviceClass === 'tablet') return 'Tablet';
  return 'Computer';
}
