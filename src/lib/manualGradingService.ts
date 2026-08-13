/**
 * MANUAL MARKING — the client half
 *
 * A machine cannot mark an essay. The scorer says so by setting
 * `scores.requiresManualReview` and awarding nothing, and until this existed
 * nothing in the platform could ever clear that flag — a paper carrying one
 * text question could be sat and scored but never finished (audit G-01).
 *
 * Everything that matters happens server-side, in the `setManualMark`
 * callable: it validates the award against the marks the question was worth ON
 * THE PAPER THE STUDENT SAT, refuses to overwrite a judge's verdict, writes
 * the grading record to a staff-only collection, and re-scores the whole
 * attempt through the same scorer every other grading path uses. That last
 * part is why there is no "recalculate" call here to pair with this one: the
 * mark and the totals move together or not at all.
 *
 * The marks themselves come back on the attempt document, which the roster is
 * already subscribed to — so a caller normally does not need the response.
 */

import { httpsCallable } from 'firebase/functions';
import {
  collection, documentId, getDocs, query, where,
} from 'firebase/firestore';
import { db, functions } from './firebase';
import type { AttemptScores } from './submissionService';

/** Longest note the server will store. Mirrored here to fail fast in the UI. */
export const MAX_FEEDBACK_CHARS = 4000;

/**
 * The staff-only record of one hand-marked answer.
 *
 * NOT what the student sees. The award reaches them through the attempt's
 * `gradedAnswers` and totals, and the note reaches them only when the exam's
 * review audience includes students — both handled server-side. This is the
 * record ABOUT the marking: who did it, under which role, when, and how often
 * it has been revised.
 */
export type ManualMark = {
  attemptId: string;
  questionId: string;
  assessmentId: string;
  instituteId: string | null;
  studentId: string | null;
  marksAwarded: number;
  feedback?: string;
  gradedBy: string;
  gradedByRole: string;
  gradedAt: string;
  firstGradedAt: string;
  revision: number;
};

/**
 * Award marks on one answer, or withdraw the award.
 *
 * Pass `marks: null` to withdraw. Withdrawal deletes the record rather than
 * writing a zero, because a grader who awarded nothing and a grader who has
 * not looked yet are different states and must not look alike to the next
 * person: the first is a finished paper, the second is outstanding work.
 *
 * Throws the server's message on refusal. The refusals are meaningful and
 * worth surfacing rather than swallowing — NOT_FINISHED (the sitting is still
 * running), ALREADY_JUDGED (the code runner owns this mark), NOT_ON_PAPER,
 * NOT_MANUAL (a machine-marked question), DELETED_ATTEMPT.
 */
export async function setManualMark(params: {
  attemptId: string;
  questionId: string;
  marks: number | null;
  feedback?: string;
}): Promise<{ ok: true; scores: AttemptScores }> {
  const call = httpsCallable<
    { attemptId: string; questionId: string; marks: number | null; feedback?: string },
    { ok: true; scores: AttemptScores }
  >(functions, 'setManualMark');
  return (await call({
    attemptId: params.attemptId,
    questionId: params.questionId,
    marks: params.marks,
    ...(params.feedback !== undefined ? { feedback: params.feedback } : {}),
  })).data;
}

/**
 * The grading records for one attempt, keyed by question id.
 *
 * Staff only — firestore.rules denies students entirely, which is the reason
 * the grader's identity can live here at all. An empty result means nothing
 * has been marked yet, which is not an error and must not be shown as one.
 *
 * THE QUERY SHAPE IS LOAD-BEARING, for the same reason getCodeTelemetry's is:
 * the read rule scopes institute and faculty callers by
 * `resource.data.instituteId`, and Firestore refuses a query it cannot prove
 * satisfies that for every document it might return. The equality makes it
 * provable and is served by the automatic single-field index, so this needs no
 * composite index and no branch on the caller's role.
 */
export async function getManualMarks(
  attemptId: string,
  instituteId: string | null,
): Promise<Record<string, ManualMark>> {
  const prefix = `${attemptId}__`;
  const snap = await getDocs(query(
    collection(db, 'attemptManualMarks'),
    where('instituteId', '==', instituteId ?? null),
    where(documentId(), '>=', prefix),
    // \uf8ff is the last character Firestore sorts, so this is "every id
    // beginning with the prefix" without knowing the question ids in advance.
    where(documentId(), '<=', `${prefix}\uf8ff`),
  ));
  const out: Record<string, ManualMark> = {};
  snap.docs.forEach((d) => {
    const data = d.data() as ManualMark;
    if (data?.questionId) out[data.questionId] = data;
  });
  return out;
}

/**
 * Is this answer waiting on a human?
 *
 * The single definition of "outstanding", so the roster's queue count, the
 * per-answer badge and the filter cannot disagree about what they are
 * counting. Mirrors the server's branches: a text answer with no mark, or a
 * coding answer with neither verdict nor mark.
 */
export function awaitsManualMark(
  engine: string | undefined,
  graded: { isCorrect: boolean | null; marksAwarded: number } | undefined,
  judgePending: boolean,
): boolean {
  if (engine !== 'text' && engine !== 'code') return false;
  // A judge still working is not a human's queue — it resolves itself.
  if (engine === 'code' && judgePending) return false;
  return !graded || graded.isCorrect === null;
}

/**
 * Bound a typed award the way the server will.
 *
 * Duplicated deliberately rather than shared: the server's copy is the one
 * that decides, and this one exists so the input can refuse an impossible
 * value while the grader is still typing rather than after a round trip.
 * Returns null for input that is not a number at all, so a caller can tell
 * "empty box" from "zero marks".
 */
export function clampAward(raw: string, maxMarks: number): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n * 100) / 100;
  return Math.min(Math.max(rounded, 0), Math.max(0, maxMarks));
}
