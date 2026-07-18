/**
 * visibility — client-side audience helpers for assessment result/review
 * visibility (N5 final form, 2026-07-17).
 *
 * MUST stay in lockstep with reviewAudienceAllows in functions/src/index.ts:
 * the server enforces keys (gradeAttempt, getAnswerKeysForReview,
 * getExamQuestions review mode); these helpers drive the matching UI —
 * which sections render in the roster drawer, whether the Reports view is
 * offered, and what the builder writes.
 *
 * Semantics:
 *   Field present  → the array is authoritative per audience.
 *   Field absent (legacy docs) →
 *     • review: the old allowReview boolean governs EVERYONE (staff ≤
 *       students symmetry — an allowReview:false exam shows keys to no one).
 *     • results: students follow the old showResults boolean; staff always
 *       see results (that was the pre-audience behavior, and staff can read
 *       scores off attempt docs regardless — pretending otherwise for legacy
 *       docs would be UI theatre).
 *
 * Note the asymmetry is deliberate: review has real server enforcement, so
 * legacy defaults conservative; results is UI-gating over data staff can
 * already read, so legacy defaults to the status quo.
 */

import type { Assessment } from './assessmentService';

export type VisibilityAudience = 'students' | 'institute' | 'faculty';

export const ALL_AUDIENCES: VisibilityAudience[] = ['students', 'institute', 'faculty'];

/** Defaults for NEW assessments (webOwner decision, 2026-07-17). */
export const DEFAULT_SHOW_RESULTS_TO: VisibilityAudience[] = ['students', 'institute', 'faculty'];
export const DEFAULT_ALLOW_REVIEW_TO: VisibilityAudience[] = ['students'];

type VisibilityFields = Pick<Assessment, 'showResults' | 'allowReview'> & {
  showResultsTo?: VisibilityAudience[];
  allowReviewTo?: VisibilityAudience[];
};

function asAudienceList(v: unknown): VisibilityAudience[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is VisibilityAudience =>
    x === 'students' || x === 'institute' || x === 'faculty');
}

/** May this audience see correct answers / question review? */
export function reviewAudienceAllows(
  a: VisibilityFields,
  audience: VisibilityAudience,
): boolean {
  const list = asAudienceList(a.allowReviewTo);
  if (list) return list.includes(audience);
  return a.allowReview === true;
}

/** May this audience see scores/results detail? */
export function resultsAudienceAllows(
  a: VisibilityFields,
  audience: VisibilityAudience,
): boolean {
  const list = asAudienceList(a.showResultsTo);
  if (list) return list.includes(audience);
  return audience === 'students' ? a.showResults === true : true;
}

/**
 * Derive the arrays a legacy doc implies — used to initialise the builder /
 * behaviour panel when editing an assessment created before audiences
 * existed, so what the editor sees matches what the code enforces.
 */
export function deriveShowResultsTo(a: VisibilityFields): VisibilityAudience[] {
  return asAudienceList(a.showResultsTo)
    ?? (a.showResults ? [...ALL_AUDIENCES] : ['institute', 'faculty']);
}
export function deriveAllowReviewTo(a: VisibilityFields): VisibilityAudience[] {
  return asAudienceList(a.allowReviewTo)
    ?? (a.allowReview ? [...ALL_AUDIENCES] : []);
}