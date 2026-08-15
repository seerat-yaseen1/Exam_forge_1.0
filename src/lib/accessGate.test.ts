/**
 * ACCESS GATE — the admission decision, stated once
 *
 * These assertions are written against the BEHAVIOUR THE THREE CONTEXTS
 * ALREADY HAD, not against a tidier rule invented while extracting it. The
 * extraction is only safe if it is a substitution, so the cases that pin the
 * old expression's quirks — unparseable dates meaning "no expiry", a
 * soft-deleted institute blocking a healthy member — matter more here than the
 * obvious ones.
 */

import { describe, it, expect } from 'vitest';
import { evaluateAccess } from './accessGate';
import { hasExpired } from './instituteValidity';

const T = (iso: string) => Date.parse(iso);
const NOW = T('2026-08-15T00:00:00.000Z');

const liveInstitute = { status: 'active', lifecycleState: 'active', activeUntil: '2027-01-01T00:00:00.000Z' };
const liveMember = { status: 'active', lifecycleState: 'active' };

describe('admission — the happy path', () => {
  it('lets an active member of an active institute in', () => {
    expect(evaluateAccess(liveInstitute, liveMember, NOW)).toBeNull();
  });

  it('lets an institute admin in with no member document', () => {
    // The Institute Admin signs in AS the institute; there is no second doc.
    expect(evaluateAccess(liveInstitute, null, NOW)).toBeNull();
  });
});

describe('disabled — either document can refuse', () => {
  it('a disabled member', () => {
    expect(evaluateAccess(liveInstitute, { ...liveMember, status: 'disabled' }, NOW)).toBe('disabled');
  });

  it('a disabled institute blocks a healthy member', () => {
    expect(evaluateAccess({ ...liveInstitute, status: 'disabled' }, liveMember, NOW)).toBe('disabled');
  });

  it('a SOFT-DELETED member — the divergence that shipped once already', () => {
    // StudentAuthContext records it: soft delete sets lifecycleState, NOT
    // status, and a gate checking only status let deleted accounts sit exams.
    // Fixed in each copy separately, with nothing to catch a missed one.
    expect(evaluateAccess(liveInstitute, { ...liveMember, lifecycleState: 'softDeleted' }, NOW)).toBe('disabled');
  });

  it('a soft-deleted INSTITUTE blocks its members', () => {
    expect(evaluateAccess({ ...liveInstitute, lifecycleState: 'softDeleted' }, liveMember, NOW)).toBe('disabled');
  });

  it('status and lifecycle are independent axes', () => {
    // A disabled person is still lifecycle-active, and vice versa. Both must
    // refuse; neither implies the other.
    expect(evaluateAccess(liveInstitute, { status: 'disabled', lifecycleState: 'active' }, NOW)).toBe('disabled');
    expect(evaluateAccess(liveInstitute, { status: 'active', lifecycleState: 'softDeleted' }, NOW)).toBe('disabled');
  });
});

describe('expiry — the institute window', () => {
  it('refuses after the window closes', () => {
    expect(evaluateAccess({ ...liveInstitute, activeUntil: '2026-08-14T23:59:59.000Z' }, liveMember, NOW))
      .toBe('expired');
  });

  it('admits right up to the boundary', () => {
    // Strictly `<`, matching the original `new Date(activeUntil) < new Date()`.
    expect(evaluateAccess({ ...liveInstitute, activeUntil: '2026-08-15T00:00:00.000Z' }, liveMember, NOW))
      .toBeNull();
  });

  it('treats absent, empty and unparseable as NO expiry — not as 1970', () => {
    // The three shapes instituteValidity's header is about. Getting any of
    // these wrong locks out every institute that never set an expiry, which is
    // the failure mode with the widest blast radius in this whole module.
    for (const activeUntil of [undefined, null, '', '   ', 'not-a-date']) {
      expect(evaluateAccess({ ...liveInstitute, activeUntil }, liveMember, NOW), String(activeUntil))
        .toBeNull();
    }
  });
});

describe('precedence — disabled outranks expired', () => {
  it('reports disabled when both are true', () => {
    // The more specific and more actionable answer. Reporting "expired" would
    // send the person to their institute admin to renew a subscription when
    // what actually happened is that someone disabled their account.
    const dead = { status: 'disabled', lifecycleState: 'active', activeUntil: '2020-01-01T00:00:00.000Z' };
    expect(evaluateAccess(dead, liveMember, NOW)).toBe('disabled');
  });
});

describe('robustness — Firestore documents are not the local interface', () => {
  it('a document missing every field is admitted, not crashed on', () => {
    // Legacy documents predate these fields. Throwing here would turn a
    // cosmetic data gap into a sign-in outage.
    expect(evaluateAccess({}, {}, NOW)).toBeNull();
  });

  it('a null institute does not throw', () => {
    expect(evaluateAccess(null, liveMember, NOW)).toBeNull();
  });

  it('unexpected value types do not throw', () => {
    expect(evaluateAccess({ status: 42, lifecycleState: [], activeUntil: {} }, null, NOW)).toBeNull();
  });
});

describe('hasExpired matches the expression it replaced', () => {
  // The original, verbatim from the three contexts:
  //     const activeUntil = String(inst.activeUntil ?? '');
  //     if (activeUntil && new Date(activeUntil) < new Date()) → expired
  const original = (raw: unknown, now: number) => {
    const activeUntil = String(raw ?? '');
    return Boolean(activeUntil && new Date(activeUntil) < new Date(now));
  };

  it('agrees on every shape that matters', () => {
    const cases: unknown[] = [
      undefined, null, '', '2020-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z',
      '2026-08-15T00:00:00.000Z', 'not-a-date', 0, false,
    ];
    for (const c of cases) {
      expect(hasExpired(c, NOW), `hasExpired(${JSON.stringify(c)})`).toBe(original(c, NOW));
    }
  });

  it("differs ONLY on whitespace-only strings, and denies less", () => {
    // '   ' is truthy, so the original called `new Date('   ')` → Invalid Date
    // → comparison false → not expired. hasExpired trims first and returns
    // false directly. Same answer, reached honestly rather than by NaN.
    expect(hasExpired('   ', NOW)).toBe(false);
    expect(original('   ', NOW)).toBe(false);
  });
});
