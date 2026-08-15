/**
 * ROLE AUTH — the decisions, which are the part worth checking
 *
 * The async wrappers only sequence Firebase SDK calls; these two functions
 * decide what a failure MEANS, and that is where a wrong answer is a bug a
 * user feels — a password that changed but reported failure, or a reset form
 * that answers "does this account exist?".
 */

import { describe, it, expect } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  RESET_VIA_EMAIL_MESSAGE,
  passwordChangeError,
  resetRequestIsBenign,
} from './roleAuth';

describe('passwordChangeError — what to tell the person', () => {
  it('names the recent-login case, which is actionable', () => {
    // The user CAN fix this one, and only by being told to. A generic
    // "try again" leaves them retrying something that will never work.
    expect(passwordChangeError('auth/requires-recent-login'))
      .toMatch(/sign out and back in/i);
  });

  it('names a weak password', () => {
    expect(passwordChangeError('auth/weak-password')).toMatch(/too weak/i);
  });

  it('returns null for anything it does not recognise', () => {
    // Null, not '' — the caller branches on it to log the raw error and show
    // its own generic message. An empty string would render as a blank error,
    // which reads as success.
    for (const code of ['auth/network-request-failed', 'auth/internal-error', undefined, '']) {
      expect(passwordChangeError(code), String(code)).toBeNull();
    }
  });
});

describe('resetRequestIsBenign — the enumeration boundary', () => {
  it('treats a missing account as success', () => {
    // The load-bearing case. Reporting it honestly turns the reset form into
    // an account-existence oracle.
    expect(resetRequestIsBenign('auth/user-not-found')).toBe(true);
  });

  it('does NOT swallow a malformed address', () => {
    // The divergence the three copies had: Institute and Faculty swallowed
    // auth/invalid-email, Student did not. Resolved toward Student's narrower
    // reading — a typo is visible to the person and reveals nothing about
    // whether an account exists, so an honest error is better UX at no
    // enumeration cost.
    expect(resetRequestIsBenign('auth/invalid-email')).toBe(false);
  });

  it('does not swallow real failures', () => {
    for (const code of ['auth/too-many-requests', 'auth/network-request-failed', undefined]) {
      expect(resetRequestIsBenign(code), String(code)).toBe(false);
    }
  });
});

describe('shared constants', () => {
  it('the reset message is one string, not four', () => {
    expect(RESET_VIA_EMAIL_MESSAGE).toMatch(/email link/i);
  });

  it('the minimum length matches what the contexts enforced', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
  });
});
