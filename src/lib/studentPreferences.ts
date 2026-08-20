/**
 * studentPreferences — what a student has chosen about how their account looks.
 *
 * ── WHY A SEPARATE COLLECTION ─────────────────────────────────────
 * The obvious home for "this student prefers the dark theme" is the student
 * document. It cannot go there: `students/{id}` is deliberately NOT
 * self-writable (firestore.rules, audit N4 — the clause was removed because it
 * let a disabled student flip their own `status` back to active). Widening
 * that rule to carry a colour preference would trade an account-security
 * property for a cosmetic one.
 *
 * So preferences live in their own document, which the student owns outright
 * and which contains nothing anyone else's decisions depend on. The rules for
 * it validate the shape rather than merely the caller, so the document cannot
 * become a free-form key-value store attached to an authenticated identity.
 *
 * ── WHY THE READ IS ALLOWED TO FAIL ───────────────────────────────
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

export interface StudentPreferences {
  /** A theme id, or `'system'` to follow the operating system. */
  theme: ThemeChoice;
  /**
   * `'system'` honours the OS "reduce motion" setting and nothing more.
   * `'reduced'` forces it on for this account, for students who want the
   * calmer interface without changing an OS setting they share with others.
   */
  motion: MotionPreference;
  /** `'compact'` tightens page padding and card spacing; the type scale is untouched. */
  density: DensityPreference;
}

export const DEFAULT_PREFERENCES: StudentPreferences = {
  theme: DEFAULT_CHOICE,
  motion: 'system',
  density: 'comfortable',
};

const COLLECTION = 'studentPreferences';

/**
 * Coerce anything into a valid preference set.
 *
 * Used on BOTH sides — the Firestore document and the localStorage string —
 * because both are equally capable of holding a value written by an older
 * version of this file, or by a theme that has since been renamed.
 */
export function normalisePreferences(raw: unknown): StudentPreferences {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PREFERENCES };
  const r = raw as Record<string, unknown>;
  return {
    theme: isKnownChoice(r.theme) ? r.theme : DEFAULT_PREFERENCES.theme,
    motion: r.motion === 'reduced' ? 'reduced' : 'system',
    density: r.density === 'compact' ? 'compact' : 'comfortable',
  };
}

export function samePreferences(a: StudentPreferences, b: StudentPreferences): boolean {
  return a.theme === b.theme && a.motion === b.motion && a.density === b.density;
}

// ── Local storage ─────────────────────────────────────────────────
//
// Two keys, and the second one is the point. `ef.appearance.<studentId>` is
// the account's choice. `ef.appearance.last` is the same value written without
// an owner, and it exists so the FIRST paint after a refresh is already
// themed: Firebase restores the session asynchronously, so at that moment the
// student id is not yet known and a per-student key cannot be read. Without
// the fallback every reload would flash the default theme.

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

export function readLocalPreferences(studentId?: string | null): StudentPreferences | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const own = studentId ? safeParse(localStorage.getItem(KEY_PREFIX + studentId)) : null;
    if (own) return normalisePreferences(own);
    const last = safeParse(localStorage.getItem(KEY_LAST));
    return last ? normalisePreferences(last) : null;
  } catch {
    return null;
  }
}

export function writeLocalPreferences(studentId: string | null, prefs: StudentPreferences): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const payload = JSON.stringify(prefs);
    if (studentId) localStorage.setItem(KEY_PREFIX + studentId, payload);
    localStorage.setItem(KEY_LAST, payload);
  } catch {
    /* Storage full, or blocked by a privacy setting. The theme still applies
       for this tab; it simply will not be remembered. Not worth surfacing. */
  }
}

/** The localStorage keys this module owns, for the cross-tab listener. */
export function isPreferenceKey(key: string | null, studentId?: string | null): boolean {
  if (!key) return false;
  return key === KEY_LAST || (!!studentId && key === KEY_PREFIX + studentId);
}

// ── Firestore ─────────────────────────────────────────────────────

/** The account's stored preferences, or null when none have been saved. */
export async function loadPreferences(studentId: string): Promise<StudentPreferences | null> {
  try {
    const snap = await getDoc(doc(db, COLLECTION, studentId));
    if (!snap.exists()) return null;
    return normalisePreferences(snap.data());
  } catch (err) {
    console.warn('[studentPreferences] load failed:', err);
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
  studentId: string,
  prefs: StudentPreferences,
): Promise<boolean> {
  try {
    await setDoc(doc(db, COLLECTION, studentId), {
      theme: prefs.theme,
      motion: prefs.motion,
      density: prefs.density,
      updatedAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    console.warn('[studentPreferences] save failed:', err);
    return false;
  }
}
