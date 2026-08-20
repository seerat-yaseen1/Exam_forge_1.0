/**
 * appearancePreferences — how a signed-in account has chosen for the app to look.
 *
 * ── ONE COLLECTION, KEYED BY THE FIREBASE UID ─────────────────────
 * Every role reaches this: web owner, institute admin, faculty, student. They
 * do NOT share an identity scheme — a student is identified by a `studentId`
 * custom claim, faculty by `facultyId`, an institute admin by `instituteId`,
 * and only the web owner is keyed by the Firebase uid itself. Keying the
 * preference document by any of those would need a different rule per role,
 * each provable only for the shapes that role queries.
 *
 * `request.auth.uid` is the one identifier every signed-in principal has, it
 * is unique per principal, and the rule it allows is the strongest one
 * available:
 *
 *     allow read, write: if request.auth.uid == uid;
 *
 * No role predicate, no custom-claim lookup, nothing to get subtly wrong when
 * a fifth role appears.
 *
 * ── WHY NOT A FIELD ON THE ACCOUNT DOCUMENT ───────────────────────
 * `students/{id}` is deliberately NOT self-writable (firestore.rules, audit
 * N4 — the clause was removed because it let a disabled student flip their own
 * `status` back to active), and the staff documents carry permission flags for
 * the same reason. Widening any of them to carry a colour would trade an
 * access-control property for a cosmetic one. This document holds nothing
 * anyone else's decisions depend on, so its owner can have it outright.
 *
 * ── WHY EVERY READ AND WRITE IS ALLOWED TO FAIL ───────────────────
 * Every function here resolves rather than throws. A preference is not worth
 * an error state: if Firestore is unreachable, the locally stored choice is
 * already applied and the account still works. `loadPreferences` returning
 * null means "nothing known", never "something went wrong" — the caller has no
 * different behaviour available for the second case.
 */

import { doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from './firebase';
import { DEFAULT_CHOICE, isKnownChoice, type ThemeChoice } from './themes';

export type MotionPreference = 'system' | 'reduced';
export type DensityPreference = 'comfortable' | 'compact';

export interface AppearancePreferences {
  /** A theme id, or `'system'` to follow the operating system. */
  theme: ThemeChoice;
  /**
   * `'system'` honours the OS "reduce motion" setting and nothing more.
   * `'reduced'` forces it on for this account, for people who want the calmer
   * interface without changing an OS setting they share with others.
   */
  motion: MotionPreference;
  /** `'compact'` tightens page padding and card spacing; the type scale is untouched. */
  density: DensityPreference;
}

export const DEFAULT_PREFERENCES: AppearancePreferences = {
  theme: DEFAULT_CHOICE,
  motion: 'system',
  density: 'comfortable',
};

const COLLECTION = 'appearancePreferences';

/**
 * Coerce anything into a valid preference set.
 *
 * Used on BOTH sides — the Firestore document and the localStorage string —
 * because both are equally capable of holding a value written by an older
 * version of this file, or by a theme that has since been renamed.
 */
export function normalisePreferences(raw: unknown): AppearancePreferences {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PREFERENCES };
  const r = raw as Record<string, unknown>;
  return {
    theme: isKnownChoice(r.theme) ? r.theme : DEFAULT_PREFERENCES.theme,
    motion: r.motion === 'reduced' ? 'reduced' : 'system',
    density: r.density === 'compact' ? 'compact' : 'comfortable',
  };
}

export function samePreferences(a: AppearancePreferences, b: AppearancePreferences): boolean {
  return a.theme === b.theme && a.motion === b.motion && a.density === b.density;
}

// ── Local storage ─────────────────────────────────────────────────
//
// Two keys, and the second one is the point. `ef.appearance.<uid>` is the
// account's choice. `ef.appearance.last` is the same value written without an
// owner, and it exists so the FIRST paint after a refresh is already themed:
// Firebase restores the session asynchronously, so at that moment the uid is
// not yet known and a per-account key cannot be read. Without the fallback
// every reload would flash the default theme.

const KEY_PREFIX = 'ef.appearance.';
const KEY_LAST = 'ef.appearance.last';

function safeParse(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function readLocalPreferences(accountId?: string | null): AppearancePreferences | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const own = accountId ? safeParse(localStorage.getItem(KEY_PREFIX + accountId)) : null;
    if (own) return normalisePreferences(own);
    const last = safeParse(localStorage.getItem(KEY_LAST));
    return last ? normalisePreferences(last) : null;
  } catch {
    return null;
  }
}

export function writeLocalPreferences(
  accountId: string | null,
  prefs: AppearancePreferences,
): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const payload = JSON.stringify(prefs);
    if (accountId) localStorage.setItem(KEY_PREFIX + accountId, payload);
    localStorage.setItem(KEY_LAST, payload);
  } catch {
    /* Storage full, or blocked by a privacy setting. The theme still applies
       for this tab; it simply will not be remembered. Not worth surfacing. */
  }
}

/** The localStorage keys this module owns, for the cross-tab listener. */
export function isPreferenceKey(key: string | null, accountId?: string | null): boolean {
  if (!key) return false;
  return key === KEY_LAST || (!!accountId && key === KEY_PREFIX + accountId);
}

// ── Firestore ─────────────────────────────────────────────────────

/** The account's stored preferences, or null when none have been saved. */
export async function loadPreferences(accountId: string): Promise<AppearancePreferences | null> {
  try {
    const snap = await getDoc(doc(db, COLLECTION, accountId));
    if (!snap.exists()) return null;
    return normalisePreferences(snap.data());
  } catch (err) {
    console.warn('[appearancePreferences] load failed:', err);
    return null;
  }
}

/**
 * Persist the account's preferences.
 *
 * `merge: false` on purpose — the document holds exactly these three fields
 * and nothing else writes to it, so a full overwrite keeps it from
 * accumulating keys that a later version of `normalisePreferences` would have
 * to keep ignoring.
 */
export async function savePreferences(
  accountId: string,
  prefs: AppearancePreferences,
): Promise<boolean> {
  try {
    await setDoc(doc(db, COLLECTION, accountId), {
      theme: prefs.theme,
      motion: prefs.motion,
      density: prefs.density,
      updatedAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    console.warn('[appearancePreferences] save failed:', err);
    return false;
  }
}

// ── Legacy ────────────────────────────────────────────────────────

const LEGACY_STUDENT_COLLECTION = 'studentPreferences';

/**
 * The student-only document this feature shipped with, one release ago.
 *
 * Themes arrived for students first, keyed by `studentId` in a collection of
 * their own. Extending them to the other three roles moved the store to
 * `appearancePreferences/{uid}` for the reason at the top of this file, which
 * would otherwise silently reset the theme of every student who had already
 * chosen one — their device keeps it via localStorage, but a second device
 * would not.
 *
 * So: read the old document once, when the new one does not exist, and let the
 * next save write it forward. Callers pass the legacy id only where one exists
 * (StudentRoot); everyone else passes nothing and never touches this path.
 *
 * DELETE THIS, its rules block, and the old collection together, once one
 * release has passed with the migration in place. It is dead weight after
 * that, and it is written to be removable in one commit.
 */
export async function loadLegacyStudentPreferences(
  studentId: string,
): Promise<AppearancePreferences | null> {
  try {
    const snap = await getDoc(doc(db, LEGACY_STUDENT_COLLECTION, studentId));
    if (!snap.exists()) return null;
    return normalisePreferences(snap.data());
  } catch {
    // Denied or unreachable. There is nothing to recover and nothing to say:
    // the account simply has no stored preference yet.
    return null;
  }
}
