/**
 * HOW A CODING ANSWER READS AFTER THE EXAM — one decision, two surfaces
 *
 * Staff open an attempt in the roster; the student opens their results page.
 * Both are looking at the same coding answer and both were, until this module,
 * guessing at it from fields that mean something else.
 *
 * ── WHAT WENT WRONG WITHOUT IT ────────────────────────────────────
 *
 * Neither surface had a `code` branch at all, so each fell through to a
 * default written for another engine:
 *
 *   • the roster classified an unjudged coding answer as UNATTEMPTED —
 *     indistinguishable from a blank paper, on a question the candidate may
 *     have spent forty minutes on;
 *   • the student's results page ran out of branches and returned `false` for
 *     "is this correct", painting a red ✗ and a red border on an answer no
 *     judge had looked at yet — directly contradicting the "awaiting marking"
 *     banner a few lines below it.
 *
 * Both are the same mistake: treating ABSENCE OF A MARK as a statement about
 * the candidate. The judge is asynchronous by design (see judgeCore.ts), so
 * "no mark yet" is the NORMAL state of a coding answer for the first few
 * minutes after submission, and a fair one to be in.
 *
 * ── THE ONE RULE ──────────────────────────────────────────────────
 *
 * A CODING ANSWER HAS THREE OUTCOMES AND THIS MODULE NEVER COLLAPSES THEM:
 * marked, waiting to be marked, and could not be marked automatically. Only
 * the first is a statement about the code.
 *
 * That is the same distinction `judgeCore.outcomeFor` enforces server-side by
 * returning null rather than a zero. This is its display half — and it is
 * derived from fields a STUDENT is allowed to read, so the student's own page
 * can tell them the truth without ever seeing a verdict document.
 */

import type { AttemptAnswer, GradedAnswer } from './submissionService';

// ══════════════════════════════════════════════════════════════════
// §1 — THE SUBMISSION
// ══════════════════════════════════════════════════════════════════

export interface CodeSubmission {
  language: string;
  source: string;
}

/**
 * The program a candidate submitted, or null if there isn't one.
 *
 * SHAPE, NOT LABEL — the same rule `answerHasContent` uses, and for the same
 * reason. Coding answers written before `answerTypeForEngine` carry
 * `type: 'match'` over a code value, and they are on finished papers that
 * staff review today. Reading by shape means an old answer and a new one
 * display identically, with no migration.
 *
 * An empty or whitespace-only source is NOT a submission. The editor writes
 * `{ language, source: '' }` for an untouched starter or an emptied buffer,
 * and the server reads that as a blank (`isEmptyCodeAnswer`); a reviewer must
 * see the same thing, or the two disagree about whether the question was
 * attempted.
 */
export function codeSubmissionOf(answer: AttemptAnswer | undefined): CodeSubmission | null {
  if (!answer) return null;
  const v = answer.value;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const rec = v as Record<string, unknown>;
  const language = rec.language;
  const source = rec.source;
  if (typeof source !== 'string' || source.trim().length === 0) return null;
  if (answer.type !== 'code' && typeof language !== 'string') return null;
  return { language: typeof language === 'string' ? language : 'unknown', source };
}

// ══════════════════════════════════════════════════════════════════
// §2 — THE STATE
// ══════════════════════════════════════════════════════════════════

export type CodeAnswerState =
  /** No program was submitted. The only state that is genuinely "unattempted". */
  | 'not_attempted'
  /** A program was submitted and the judge has not returned yet. NOT a zero. */
  | 'awaiting_judge'
  /** Judging finished without producing a mark. A human owes this paper one. */
  | 'needs_review'
  /** A real verdict was scored. `graded` carries the mark. */
  | 'judged'
  /** The question was invalidated for everyone; full marks, no verdict involved. */
  | 'invalidated';

export interface CodeStateInput {
  answer: AttemptAnswer | undefined;
  graded: GradedAnswer | undefined;
  /**
   * `attempts/{id}.codeJudgePending` — set at submit, deleted by the sweep once
   * every coding answer on the paper has settled.
   *
   * This is what separates "still being marked" from "could not be marked".
   * Both look identical in `gradedAnswers` (isCorrect null, 0 awarded), and
   * telling a student their answer failed to mark when the sweep simply has
   * not run yet would be alarming and wrong. Absent on attempts that predate
   * the field, which resolve to `needs_review` — the honest answer for a paper
   * nobody can prove is still queued.
   */
  judgePending: boolean | undefined;
}

/**
 * Which of the three outcomes is this answer in?
 *
 * Deliberately derived from the attempt document alone. Verdicts live in
 * `attemptVerdicts`, which students cannot read — so a state machine that
 * needed one could not run on the student's page, which is precisely where
 * the red ✗ was being painted.
 */
export function codeAnswerState(input: CodeStateInput): CodeAnswerState {
  const { answer, graded, judgePending } = input;

  if (!codeSubmissionOf(answer)) return 'not_attempted';

  // A real verdict was scored: the server wrote a boolean either way, and a
  // false one is a genuine "this code did not pass", not an absence.
  if (graded && typeof graded.isCorrect === 'boolean') return 'judged';

  // isCorrect null WITH marks is the invalidation path — the whole cohort was
  // awarded the question and no judge was consulted. Checked before the
  // pending branches because it is terminal.
  if (graded && graded.isCorrect === null && graded.marksAwarded > 0) return 'invalidated';

  // Nothing scored. The paper's pending flag is the only thing that can say
  // whether that is temporary.
  return judgePending === true ? 'awaiting_judge' : 'needs_review';
}

/** Is the mark on screen provisional — i.e. might it still change by itself? */
export function codeStateIsPending(state: CodeAnswerState): boolean {
  return state === 'awaiting_judge';
}

export const CODE_STATE_LABEL: Record<CodeAnswerState, string> = {
  not_attempted:  'Not attempted',
  awaiting_judge: 'Awaiting marking',
  needs_review:   'Needs review',
  judged:         'Marked',
  invalidated:    'Invalidated',
};

/** What a CANDIDATE is told. Never mentions a judge, a sandbox or an outage. */
export const CODE_STATE_STUDENT_NOTE: Record<CodeAnswerState, string> = {
  not_attempted:  'You did not submit any code for this question.',
  awaiting_judge: 'Your code is still being marked. This page will show the result once marking finishes.',
  needs_review:   'Your code could not be marked automatically. Your examiner will mark it.',
  judged:         '',
  invalidated:    'This question was withdrawn. Everyone received full marks for it.',
};

/** What STAFF are told — the operational reading of the same state. */
export const CODE_STATE_STAFF_NOTE: Record<CodeAnswerState, string> = {
  not_attempted:  'No program was submitted.',
  awaiting_judge: 'Queued for the code runner. The sweep runs every five minutes and re-scores the paper when every coding answer has settled.',
  needs_review:   'Judging did not produce a verdict — the runner was unreachable, gave up after five attempts, or the test suite carries no weight. This answer needs a mark from a person.',
  judged:         '',
  invalidated:    'Withdrawn question — full marks awarded to everyone.',
};

// ══════════════════════════════════════════════════════════════════
// §3 — THE VERDICT (STAFF ONLY)
// ══════════════════════════════════════════════════════════════════
//
// Everything below reads `attemptVerdicts`, which firestore.rules denies to
// students for the reason the collection exists: a verdict carries hidden-test
// output, and even the bare pass/fail list is an oracle that reconstructs the
// suite by bisection. None of this may be rendered on a student surface.

export type RunStatus = 'completed' | 'compile_error' | 'judge_unavailable' | 'internal_error';

export type TestStatus =
  | 'passed' | 'wrong_answer' | 'timeout' | 'runtime_error'
  | 'memory_exceeded' | 'output_exceeded' | 'skipped';

export interface JudgeTestResult {
  testId: string;
  status: TestStatus;
  timeMs?: number;
  memoryKb?: number;
  stdout?: string;
  stderr?: string;
}

export interface JudgeVerdict {
  status: RunStatus;
  compileMessage?: string;
  failureReason?: string;
  results: JudgeTestResult[];
  adapter: string;
  judgedAt: string;
}

/** The dispatch bookkeeping stored beside a verdict. Mirrors JudgeAttemptState. */
export interface JudgeAttemptState {
  attempts: number;
  lastStatus?: RunStatus;
  nextAttemptAt?: string;
  claimedAt?: string;
}

export interface CodeVerdictDoc {
  verdict?: JudgeVerdict;
  state?: JudgeAttemptState;
}

/** Mirrors MAX_JUDGE_ATTEMPTS in judgeCore.ts — keep in EXACT sync. */
export const MAX_JUDGE_ATTEMPTS = 5;

/** Has the platform given up on this submission? */
export function judgeExhausted(state: JudgeAttemptState | undefined): boolean {
  if (!state) return false;
  if (state.lastStatus === 'completed' || state.lastStatus === 'compile_error') return false;
  return state.attempts >= MAX_JUDGE_ATTEMPTS;
}

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  completed:         'Ran',
  compile_error:     'Did not compile',
  judge_unavailable: 'Code runner unavailable',
  internal_error:    'Runner error',
};

export const TEST_STATUS_LABEL: Record<TestStatus, string> = {
  passed:          'Passed',
  wrong_answer:    'Wrong output',
  timeout:         'Timed out',
  runtime_error:   'Crashed',
  memory_exceeded: 'Out of memory',
  output_exceeded: 'Too much output',
  skipped:         'Not run',
};

export interface VerdictSummary {
  passed: number;
  total: number;
}

/**
 * Plain pass count over whatever the verdict reports.
 *
 * NOT the mark. The mark is weighted (visible tests default to zero weight)
 * and was computed server-side by `outcomeFor`; recomputing it here from an
 * unweighted count would put a second, disagreeing number on the same screen.
 * This is "how many tests passed", for a reviewer reading the run.
 */
export function summariseVerdict(verdict: JudgeVerdict | undefined): VerdictSummary {
  if (!verdict) return { passed: 0, total: 0 };
  return {
    passed: verdict.results.filter((r) => r.status === 'passed').length,
    total: verdict.results.length,
  };
}
