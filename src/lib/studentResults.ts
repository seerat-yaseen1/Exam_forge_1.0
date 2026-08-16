/**
 * studentResults — the Results tab's whole argument, as pure functions.
 *
 * The student list already answers "what can I sit, what did I miss, what did
 * I hand in". It does not answer the question a candidate actually asks after
 * the exam is over: WHAT AM I ALLOWED TO SEE ABOUT MY PERFORMANCE — and for
 * which sitting.
 *
 * Two things made that hard to answer from the Submitted tab:
 *
 *   1. A submitted assessment whose results are withheld and one whose results
 *      are released look nearly identical there — a card with a status badge,
 *      differing only by whether a small score appears. "No score shown" then
 *      has to carry three different meanings (not released, not marked yet,
 *      not scored at all) with nothing distinguishing them.
 *
 *   2. A card is per ASSESSMENT and a mark is per ATTEMPT. With reattempts
 *      enabled the card showed the score of the most recent sitting and
 *      nothing else, so a student who scored 78% and then 41% on a retake saw
 *      only the 41% — while their examiner's roster, which has had a
 *      Latest/Best toggle for as long as reattempts have existed, showed the
 *      78% as the one that counts.
 *
 * So this module is built around the two facts the Results tab exists to
 * state: WHAT IS RELEASED, and WHICH SITTING IT DESCRIBES.
 *
 * ── ON "BEST" ─────────────────────────────────────────────────────
 *
 * The rule is deliberately the same one the staff roster and the results
 * export already use — highest percentage, ties to the more recent sitting,
 * voided sittings excluded. A student and their examiner disagreeing about
 * which attempt is the best one is not a cosmetic difference; it is the
 * platform telling two people two different things about the same marks.
 * `studentResults.test.ts` asserts this agreement against
 * `selectExportRows(..., 'best')` rather than trusting the comment.
 *
 * PURE. No Firestore, no React — the page passes in what it already fetched.
 */

import type { Assessment } from './assessmentService';
import type { Attempt, AttemptStatus } from './submissionService';
import { resultsAudienceAllows, reviewAudienceAllows } from './visibility';

// ══════════════════════════════════════════════════════════════════
// §1 — WHAT THE EXAM RELEASES TO THE STUDENT
// ══════════════════════════════════════════════════════════════════

/**
 * How much of their own performance this exam lets the student see.
 *
 *   withheld — the marks exist; the student is not shown them.
 *   score    — marks, percentage, pass/fail, per-section breakdown.
 *   review   — the above plus the paper back: their answers, the correct
 *              ones, and any examiner's note.
 */
export type ResultVisibility = 'withheld' | 'score' | 'review';

type VisibilityFields = Pick<Assessment, 'showResults' | 'allowReview'> & {
  showResultsTo?: Assessment['showResultsTo'];
  allowReviewTo?: Assessment['allowReviewTo'];
};

/**
 * REVIEW IS NESTED INSIDE SCORE, NOT PARALLEL TO IT.
 *
 * The two audience lists are independent fields and an exam can legally carry
 * `allowReviewTo: ['students']` with `showResultsTo: []`. ExamResultsPage
 * resolves that combination by showing nothing — its review block is gated on
 * `showResults && allowReview` — so a Results tab that offered a "Review"
 * action there would send the student to a page that refuses to show them
 * anything, with no explanation available at either end. The withheld branch
 * wins first, which is what makes the tab's promise and the page's behaviour
 * the same promise.
 */
export function studentResultVisibility(a: VisibilityFields): ResultVisibility {
  if (!resultsAudienceAllows(a, 'students')) return 'withheld';
  return reviewAudienceAllows(a, 'students') ? 'review' : 'score';
}

// ══════════════════════════════════════════════════════════════════
// §2 — WHICH SITTINGS COUNT
// ══════════════════════════════════════════════════════════════════

/**
 * A sitting that is over. `terminated` belongs here: it is finished, it has a
 * mark, and hiding it would leave a student who was cut off for an integrity
 * violation with no record of it on the one screen that is about their
 * results.
 */
const FINISHED: AttemptStatus[] = ['submitted', 'auto_submitted', 'terminated'];

/** A sitting that ended the ordinary way. See pickBestAttempt for why. */
const CLEAN_FINISHED: AttemptStatus[] = ['submitted', 'auto_submitted'];

/** Sort key for "most recent". Missing/unparseable timestamps sort as epoch. */
export function attemptStartedMs(a: Attempt): number {
  const raw = a.startedAt ?? a.createdAt;
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

function byStartAsc(a: Attempt, b: Attempt): number {
  return attemptStartedMs(a) - attemptStartedMs(b);
}

/**
 * The attempts that exist as far as this student is concerned: not
 * soft-deleted, oldest first.
 *
 * Ordering matters beyond presentation — it is what numbers the attempts, and
 * "Attempt 2 of 3" has to mean the same thing here as it does in the roster
 * drawer the examiner is reading.
 */
export function visibleAttempts(list: Attempt[]): Attempt[] {
  return list.filter((a) => a.isDeleted !== true).sort(byStartAsc);
}

/** Finished sittings only, oldest first. */
export function finishedAttempts(list: Attempt[]): Attempt[] {
  return visibleAttempts(list).filter((a) => FINISHED.includes(a.status));
}

/**
 * Their best sitting: highest percentage, ties to the more recent one.
 *
 * TWO EXCLUSIONS, BOTH DELIBERATE.
 *
 * Terminated attempts are out. A mark obtained in a sitting that was voided
 * for misconduct is not "best demonstrated performance", and putting it
 * forward as the student's best would be the platform arguing on their behalf
 * for a result their institution has already refused. It stays visible as the
 * latest attempt when it is the latest — voided is not hidden, it is just not
 * promoted.
 *
 * In-progress and frozen attempts are out because a sitting that is still
 * running does not have a final mark to compare. (A provisional grade can
 * exist on one; it is a diagnostic for invigilators, not a result.)
 *
 * Returns null when no sitting qualifies — a student whose only attempt was
 * terminated has a latest and no best, and that is a true statement about
 * them rather than a gap to paper over.
 */
export function pickBestAttempt(list: Attempt[]): Attempt | null {
  const eligible = visibleAttempts(list).filter(
    (a) => a.scores != null && CLEAN_FINISHED.includes(a.status),
  );
  if (eligible.length === 0) return null;
  return eligible.reduce((best, cur) => {
    const d = (cur.scores!.percentage ?? 0) - (best.scores!.percentage ?? 0);
    if (d !== 0) return d > 0 ? cur : best;
    return attemptStartedMs(cur) >= attemptStartedMs(best) ? cur : best;
  });
}

/** Their most recent finished sitting, or null if they never finished one. */
export function pickLatestFinishedAttempt(list: Attempt[]): Attempt | null {
  return finishedAttempts(list).at(-1) ?? null;
}

/**
 * Can this mark still move?
 *
 * Both halves matter and they are different situations wearing the same face
 * (see codeVerdictView.ts): `codeJudgePending` means the machine has not
 * finished, `requiresManualReview` means a person has not. Either way the
 * number on screen is a floor rather than a result, and a student comparing
 * two attempts must not be shown a provisional 40% beating a settled 38%
 * without being told which one is still moving.
 *
 * `scores.passed === null` is the same condition as requiresManualReview —
 * the server derives one from the other — so it is not checked separately.
 */
export function isProvisional(a: Attempt): boolean {
  if (a.codeJudgePending === true) return true;
  return a.scores?.requiresManualReview === true;
}

// ══════════════════════════════════════════════════════════════════
// §3 — ONE ROW PER ASSESSMENT
// ══════════════════════════════════════════════════════════════════

export type ResultEntry = {
  attempt: Attempt;
  /** 1-based, by start order across all of this student's visible attempts. */
  attemptNumber: number;
  /** True while the mark can still change — see isProvisional. */
  provisional: boolean;
};

export type StudentResultRow = {
  assessment: Assessment;
  visibility: ResultVisibility;
  /** Most recent finished sitting. Every row has one — that is what puts it here. */
  latest: ResultEntry;
  /** Highest-scoring clean sitting, or null when there is none. */
  best: ResultEntry | null;
  /**
   * The two entries describe the SAME sitting. The tab renders one panel
   * rather than two identical ones — showing a student their 63% twice under
   * two different headings reads as a bug, not as reassurance.
   */
  latestIsBest: boolean;
  /** How many finished sittings — the "of N" in "Attempt 2 of N". */
  finishedCount: number;
  /** Every visible attempt, including one still in progress. */
  attemptCount: number;
};

function entryFor(attempt: Attempt, ordinals: Map<string, number>): ResultEntry {
  return {
    attempt,
    attemptNumber: ordinals.get(attempt.id) ?? 1,
    provisional: isProvisional(attempt),
  };
}

/**
 * Build the row for one assessment, or null when the student has no finished
 * sitting on it — an exam they have not handed in is the Available or Missed
 * tab's business, and duplicating it here would make Results a second copy of
 * the list rather than an answer about marks.
 */
export function buildResultRow(
  assessment: Assessment,
  attempts: Attempt[],
): StudentResultRow | null {
  const visible = visibleAttempts(attempts);
  const latest = pickLatestFinishedAttempt(visible);
  if (!latest) return null;

  const ordinals = new Map(visible.map((a, i) => [a.id, i + 1]));
  const best = pickBestAttempt(visible);

  return {
    assessment,
    visibility: studentResultVisibility(assessment),
    latest: entryFor(latest, ordinals),
    best: best ? entryFor(best, ordinals) : null,
    latestIsBest: best !== null && best.id === latest.id,
    finishedCount: finishedAttempts(visible).length,
    attemptCount: visible.length,
  };
}

/** Most recently finished first — the result a student came here to check. */
function bySubmittedDesc(x: StudentResultRow, y: StudentResultRow): number {
  const at = (r: StudentResultRow) =>
    r.latest.attempt.submittedAt
      ? Date.parse(r.latest.attempt.submittedAt)
      : attemptStartedMs(r.latest.attempt);
  return at(y) - at(x);
}

export function buildResultRows(
  assessments: Assessment[],
  attemptsByAssessment: Record<string, Attempt[]>,
): StudentResultRow[] {
  return assessments
    .map((a) => buildResultRow(a, attemptsByAssessment[a.id] ?? []))
    .filter((r): r is StudentResultRow => r !== null)
    .sort(bySubmittedDesc);
}

// ══════════════════════════════════════════════════════════════════
// §4 — THE SUMMARY STRIP
// ══════════════════════════════════════════════════════════════════

export type ResultsSummary = {
  /** Rows whose marks the student may see. */
  released: number;
  /** Rows where the marks exist and are not shown to them. */
  withheld: number;
  /** Released rows whose shown mark can still move. */
  awaitingMarking: number;
  /**
   * Mean of the best percentage in each released row with a SETTLED mark,
   * to one decimal — or null when there is nothing settled to average.
   *
   * Provisional marks are excluded rather than counted at their current
   * floor. Averaging in a paper that is half-marked produces a number that
   * drops as the marking finishes, which reads as the student's performance
   * getting worse while nothing about it changed.
   */
  averageBestPercentage: number | null;
  /** How many rows the average is over — the number's own denominator. */
  settledCount: number;
};

export function summariseResults(rows: StudentResultRow[]): ResultsSummary {
  let released = 0;
  let withheld = 0;
  let awaitingMarking = 0;
  const settled: number[] = [];

  for (const row of rows) {
    if (row.visibility === 'withheld') {
      withheld += 1;
      continue;
    }
    released += 1;

    const shown = row.best ?? row.latest;
    if (shown.provisional) {
      awaitingMarking += 1;
      continue;
    }
    if (shown.attempt.scores) settled.push(shown.attempt.scores.percentage);
  }

  const averageBestPercentage = settled.length
    ? Math.round((settled.reduce((s, p) => s + p, 0) / settled.length) * 10) / 10
    : null;

  return {
    released,
    withheld,
    awaitingMarking,
    averageBestPercentage,
    settledCount: settled.length,
  };
}
