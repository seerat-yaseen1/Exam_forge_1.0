/**
 * The "quiet for" badge's rule.
 *
 * This decides when an invigilator gets told to go and look at a student, so
 * both failure directions are real: a badge that never fires leaves the roster
 * exactly as blind as it was, and a badge that fires on ordinary sittings gets
 * ignored — including on the row that mattered. Every null branch below is a
 * case where the honest answer is silence.
 */

import { describe, it, expect } from 'vitest';
import {
  deriveQuiet,
  formatQuiet,
  QUIET_NOTICE_SECONDS,
  QUIET_CONCERN_SECONDS,
  QUIET_ALARM_SECONDS,
} from './heartbeatQuiet';
import type { Attempt } from './submissionService';

const NOW = Date.parse('2026-08-14T10:00:00.000Z');
const agoIso = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

/** Only the fields deriveQuiet reads; the rest of Attempt is irrelevant here. */
function attempt(over: Partial<Attempt> = {}): Attempt {
  return {
    status: 'in_progress',
    securityConfig: { tier: 'normal' },
    lastHeartbeatAt: agoIso(5),
    ...over,
  } as Attempt;
}

describe('deriveQuiet', () => {
  it('says nothing about a student beating normally', () => {
    expect(deriveQuiet(attempt({ lastHeartbeatAt: agoIso(8) }), NOW)).toBeNull();
  });

  it('says nothing right up to the notice threshold', () => {
    expect(deriveQuiet(attempt({ lastHeartbeatAt: agoIso(QUIET_NOTICE_SECONDS - 1) }), NOW))
      .toBeNull();
  });

  it('speaks at the notice threshold', () => {
    expect(deriveQuiet(attempt({ lastHeartbeatAt: agoIso(QUIET_NOTICE_SECONDS) }), NOW))
      .toMatchObject({ tone: 'notice' });
  });

  it('escalates through the three tiers', () => {
    expect(deriveQuiet(attempt({ lastHeartbeatAt: agoIso(90) }), NOW))
      .toMatchObject({ tone: 'notice' });
    expect(deriveQuiet(attempt({ lastHeartbeatAt: agoIso(QUIET_CONCERN_SECONDS) }), NOW))
      .toMatchObject({ tone: 'concern' });
    expect(deriveQuiet(attempt({ lastHeartbeatAt: agoIso(QUIET_ALARM_SECONDS) }), NOW))
      .toMatchObject({ tone: 'alarm' });
    expect(deriveQuiet(attempt({ lastHeartbeatAt: agoIso(3600) }), NOW))
      .toMatchObject({ tone: 'alarm' });
  });

  // ── The silences ───────────────────────────────────────────────

  it('says nothing about a mock sitting, however long it has been silent', () => {
    // Mock never heartbeats (ExamShell gates the effect on the proctored
    // tiers), so an aged stamp there is the absence of a feature, not a
    // signal about the student. Without this every practice row would sit
    // permanently red.
    expect(deriveQuiet(
      attempt({ securityConfig: { tier: 'mock' } as Attempt['securityConfig'],
                lastHeartbeatAt: agoIso(7200) }),
      NOW,
    )).toBeNull();
  });

  it('says nothing about a legacy attempt with no security config', () => {
    expect(deriveQuiet(
      attempt({ securityConfig: undefined, lastHeartbeatAt: agoIso(7200) }), NOW,
    )).toBeNull();
  });

  it('says nothing about a paused attempt', () => {
    // examHeartbeat refuses beats on a frozen attempt, so the stamp is pinned
    // at the moment of the freeze and would age for as long as the
    // invigilator takes to decide — turning their own deliberation into an
    // alarm against the student.
    expect(deriveQuiet(
      attempt({ frozenAt: agoIso(1800) as Attempt['frozenAt'], lastHeartbeatAt: agoIso(1800) }),
      NOW,
    )).toBeNull();
  });

  it('says nothing about a finished attempt', () => {
    for (const status of ['submitted', 'auto_submitted', 'terminated', 'frozen'] as const) {
      expect(deriveQuiet(
        attempt({ status, lastHeartbeatAt: agoIso(7200) }), NOW,
      )).toBeNull();
    }
  });

  it('says nothing before the first beat lands', () => {
    // The opening seconds of a sitting: the attempt exists, the stamp does not.
    expect(deriveQuiet(attempt({ lastHeartbeatAt: null }), NOW)).toBeNull();
    expect(deriveQuiet(attempt({ lastHeartbeatAt: undefined }), NOW)).toBeNull();
  });

  it('says nothing about an unparseable stamp', () => {
    expect(deriveQuiet(attempt({ lastHeartbeatAt: 'not a date' }), NOW)).toBeNull();
  });

  it('says nothing when the viewer\'s clock is behind the server\'s', () => {
    // A future stamp is roster-side clock skew. Reporting a negative age would
    // blame the student for the invigilator's machine.
    expect(deriveQuiet(attempt({ lastHeartbeatAt: agoIso(-300) }), NOW)).toBeNull();
  });

  it('says nothing about a student who has not started', () => {
    expect(deriveQuiet(null, NOW)).toBeNull();
    expect(deriveQuiet(undefined, NOW)).toBeNull();
  });
});

describe('formatQuiet', () => {
  it('reads in seconds only in the sub-minute band', () => {
    expect(formatQuiet({ seconds: 75, tone: 'notice' })).toBe('quiet 1m');
    expect(formatQuiet({ seconds: 300, tone: 'concern' })).toBe('quiet 5m');
    expect(formatQuiet({ seconds: 3600, tone: 'alarm' })).toBe('quiet 60m');
  });
});

describe('the thresholds stay ordered', () => {
  it('notice < concern < alarm', () => {
    expect(QUIET_NOTICE_SECONDS).toBeLessThan(QUIET_CONCERN_SECONDS);
    expect(QUIET_CONCERN_SECONDS).toBeLessThan(QUIET_ALARM_SECONDS);
  });

  it('notice is past several missed beats, not one', () => {
    // The client beats every 15s. A threshold at one or two missed beats would
    // fire on ordinary network jitter and Firestore propagation delay.
    expect(QUIET_NOTICE_SECONDS).toBeGreaterThanOrEqual(45);
  });
});
