// ══════════════════════════════════════════════════════════════════
// FIRESTORE WRITE SANITISER
// ══════════════════════════════════════════════════════════════════
//
// Firestore rejects `undefined` outright: a single undefined property makes
// the whole setDoc/updateDoc/addDoc throw
// "Unsupported field value: undefined", taking the entire write with it. The
// failure mode is nastier than it sounds, because the offending key is
// usually an OPTIONAL field that happens to be absent on this particular
// object — so the write succeeds in testing, succeeds for most records, and
// throws on the one that omitted a field nobody thought about.
//
// M3 (audit 2026-08-06): five service files carried a private copy of this
// helper and three wrote without one — subjectService (15 writes),
// questionShareService (5) and erasureService (1). Those three now import
// from here rather than growing a sixth, seventh and eighth copy.
//
// The five existing local copies (assessmentService, firebaseService,
// questionBankService, questionReportService, submissionService) are
// deliberately left alone: they are identical in behaviour, and rewriting
// five working service files to change an import is churn with no user-facing
// effect. This module is where they should land whenever one of them is next
// touched for another reason.

/**
 * Strip `undefined` values from an object destined for Firestore.
 *
 * SHALLOW, like every copy it replaces. Nested objects are passed through
 * untouched, so an undefined two levels down still throws — that is the
 * existing behaviour across all five copies and this is not the change that
 * should alter it. `null` is preserved: Firestore accepts it, and it means
 * something different from absence.
 */
export function removeUndefined<T extends Record<string, any>>(obj: T): T {
  const out: any = {};
  for (const key in obj) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  return out as T;
}
