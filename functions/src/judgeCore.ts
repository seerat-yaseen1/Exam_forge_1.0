/**
 * JUDGE CORE — the boundary between Exam Forge and whatever runs the code
 * (Stage B1 of the coding roadmap: Judge Interface)
 *
 * ZERO Firestore imports and zero network calls by design, exactly like
 * allocationCore and examTimingCore: everything decidable without a sandbox
 * lives here as pure functions, so the code that decides a candidate's mark is
 * the same code the headless suite proves correct (functions/test/judge.suite.cjs).
 * The adapters that actually talk to a judge live behind `JudgeAdapter` and are
 * the only part that needs a network.
 *
 * ── WHY AN INTERFACE BEFORE A JUDGE ───────────────────────────────
 *
 * The provider decision (Judge0 hosted → Judge0 self-hosted, with Piston as a
 * live alternative) is not settled, and it does not need to be. Every coding
 * submission enters through `JudgeAdapter`, so the provider is one object
 * swapped at the composition root. Nothing above this file — grading, storage,
 * reporting, the run-during-exam path — learns which judge ran the code.
 *
 * That is not architecture for its own sake. A judge is the one dependency in
 * this platform that is simultaneously untrusted, slow, and able to be down
 * during an exam. Pinning the rest of the system to one vendor's response shape
 * would make replacing it a rewrite of the grading path.
 *
 * ── THE ONE RULE ──────────────────────────────────────────────────
 *
 * A CANDIDATE'S CODE FAILING AND THE JUDGE FAILING ARE NOT THE SAME EVENT, AND
 * THIS MODULE NEVER LETS THEM COLLAPSE INTO THE SAME NUMBER.
 *
 * A program that does not compile, crashes, or times out has been judged: the
 * verdict is real, the score is zero, and (if the institution enabled it) the
 * zero is penalty-eligible under the settled negative-marking policy. A judge
 * that is unreachable, rate-limited, or broken has judged nothing: there is no
 * score, and `outcomeFor` returns null so the paper goes to manual review
 * rather than recording a zero the candidate did not earn.
 *
 * Getting this backwards is the single worst bug this subsystem can have,
 * because it is silent — an outage during an exam would mark a whole cohort
 * zero and every downstream number would look perfectly well-formed. The
 * distinction is therefore structural (`RunStatus`, and a nullable outcome),
 * not a flag anyone has to remember to check.
 */

// ══════════════════════════════════════════════════════════════════
// §1 — LANGUAGES
// ══════════════════════════════════════════════════════════════════

/**
 * Platform-neutral language identifiers.
 *
 * Deliberately NOT a judge's own ids (Judge0 uses numeric ids that differ
 * between releases; Piston uses name+version strings). Adapters own the
 * mapping. A question authored today keeps meaning the same thing after a
 * judge upgrade renumbers everything underneath it.
 */
export type JudgeLanguage =
  | 'python3'
  | 'javascript'
  | 'typescript'
  | 'java'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'go'
  | 'rust'
  | 'kotlin'
  | 'php'
  | 'ruby'
  | 'sql';

export const JUDGE_LANGUAGES: JudgeLanguage[] = [
  'python3', 'javascript', 'typescript', 'java', 'c', 'cpp',
  'csharp', 'go', 'rust', 'kotlin', 'php', 'ruby', 'sql',
];

export const JUDGE_LANGUAGE_LABEL: Record<JudgeLanguage, string> = {
  python3:    'Python 3',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  java:       'Java',
  c:          'C',
  cpp:        'C++',
  csharp:     'C#',
  go:         'Go',
  rust:       'Rust',
  kotlin:     'Kotlin',
  php:        'PHP',
  ruby:       'Ruby',
  sql:        'SQL',
};

export function isJudgeLanguage(v: unknown): v is JudgeLanguage {
  return typeof v === 'string' && (JUDGE_LANGUAGES as string[]).includes(v);
}

// ══════════════════════════════════════════════════════════════════
// §2 — LIMITS
// ══════════════════════════════════════════════════════════════════

/**
 * Per-submission resource ceilings, applied to EVERY test in the suite.
 *
 * These are the sandbox's contract, not a suggestion: a candidate's program is
 * hostile input by definition, and an exam runs many of them at once.
 */
export interface JudgeLimits {
  /** CPU time per test. The one that actually stops an infinite loop. */
  cpuMs: number;
  /**
   * Wall-clock time per test. Always > cpuMs: a program that blocks on stdin
   * burns no CPU and would otherwise hang forever inside its CPU budget.
   */
  wallMs: number;
  /** Address space per test. */
  memoryKb: number;
  /** stdout+stderr captured per test. Beyond this the test fails as output_exceeded. */
  outputKb: number;
  /** Process/thread cap. Blunts fork bombs the memory cap alone would not. */
  processes: number;
}

/** What a question gets when its author sets nothing. Tuned for interview-scale work. */
export const DEFAULT_LIMITS: Readonly<JudgeLimits> = Object.freeze({
  cpuMs: 2_000,
  wallMs: 5_000,
  memoryKb: 256 * 1024,
  outputKb: 256,
  processes: 32,
});

/**
 * Hard ceilings. An AUTHOR MAY NOT EXCEED THESE, whatever they type in the
 * builder.
 *
 * Author-supplied limits are not a trust boundary — a teacher who types
 * 600000ms is not attacking anyone, they are guessing. But an exam is many
 * candidates running many submissions against a finite pool of judge workers,
 * so one question with a ten-minute budget is a platform-wide outage waiting
 * for the day it is used. Clamping is silent and deliberate: the builder should
 * surface the effective value (see `clampLimits`), and the judge is never asked
 * to enforce a number it was never given.
 */
export const MAX_LIMITS: Readonly<JudgeLimits> = Object.freeze({
  cpuMs: 15_000,
  wallMs: 30_000,
  memoryKb: 1024 * 1024,
  outputKb: 4 * 1024,
  processes: 128,
});

const MIN_LIMITS: Readonly<JudgeLimits> = Object.freeze({
  cpuMs: 100,
  wallMs: 500,
  memoryKb: 16 * 1024,
  outputKb: 1,
  processes: 1,
});

/**
 * Resolve an author's partial limits into a complete, in-range set.
 *
 * Also guarantees the wallMs > cpuMs invariant that a well-meaning author can
 * easily break (cpu 5s / wall 1s would kill every program that used its CPU
 * budget). Rather than reject it, wall is lifted to cpu's value — the author's
 * intent for CPU is preserved and the impossible combination cannot reach the
 * sandbox.
 */
export function clampLimits(partial?: Partial<JudgeLimits>): JudgeLimits {
  const pick = (k: keyof JudgeLimits): number => {
    const raw = partial?.[k];
    const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_LIMITS[k];
    return Math.min(MAX_LIMITS[k], Math.max(MIN_LIMITS[k], Math.floor(v)));
  };
  const cpuMs = pick('cpuMs');
  const wallMs = Math.max(pick('wallMs'), cpuMs);
  return {
    cpuMs,
    wallMs: Math.min(MAX_LIMITS.wallMs, wallMs),
    memoryKb: pick('memoryKb'),
    outputKb: pick('outputKb'),
    processes: pick('processes'),
  };
}

// ══════════════════════════════════════════════════════════════════
// §3 — TESTS
// ══════════════════════════════════════════════════════════════════

/**
 * How a produced output is compared to the expected one.
 *
 * `trimmed` is the default because it matches what every candidate assumes and
 * what every competitive judge does. Exact-byte comparison fails a correct
 * program over a trailing newline, which teaches candidates to distrust the
 * judge rather than to fix their logic.
 */
export type ComparisonMode =
  | 'exact'    // byte-for-byte, after CRLF normalisation only
  | 'trimmed'  // ignore trailing whitespace per line and trailing blank lines
  | 'tokens'   // whitespace-insensitive token sequence
  | 'numeric'; // token sequence, numeric tokens compared within a tolerance

export interface JudgeTest {
  id: string;
  /** Fed to the program on stdin. */
  stdin: string;
  /** What a correct program prints. */
  expected: string;
  /**
   * Visible to the candidate.
   *
   * Visible tests are the ones a candidate may run during the exam and the only
   * ones whose input, expected output and actual output ever reach a browser
   * (see `redactForCandidate`). Hidden tests exist solely to be run at grading.
   */
  visible: boolean;
  /**
   * Share of the question's marks. Default 1 for hidden, 0 for visible —
   * see `weightOf` for why visible tests are worth nothing by default.
   */
  weight?: number;
  /** Default 'trimmed'. */
  comparison?: ComparisonMode;
  /**
   * For 'numeric': absolute-or-relative tolerance. Default 1e-9, which accepts
   * ordinary floating-point drift and rejects a wrong answer.
   */
  tolerance?: number;
  /** Author-facing note shown beside a failing visible test. Never sent for hidden tests. */
  label?: string;
}

export const DEFAULT_TOLERANCE = 1e-9;

/**
 * A test's contribution to the mark.
 *
 * VISIBLE TESTS DEFAULT TO ZERO WEIGHT. A candidate can read a visible test's
 * input and expected output, so any marks attached to it are available to a
 * program that hardcodes the answer without solving anything. Samples exist to
 * let a candidate check they understood the problem — that is worth a lot, and
 * it is not worth marks.
 *
 * An author who wants samples to count can say so explicitly per test. The
 * default is the safe direction, and the unsafe direction requires a decision.
 */
export function weightOf(t: JudgeTest): number {
  if (typeof t.weight === 'number' && Number.isFinite(t.weight) && t.weight >= 0) {
    return t.weight;
  }
  return t.visible ? 0 : 1;
}

/** The tests a candidate may run during the exam. */
export function visibleTests(tests: JudgeTest[]): JudgeTest[] {
  return tests.filter((t) => t.visible);
}

/**
 * Is this suite gradable at all?
 *
 * A suite whose total weight is zero (every test visible and left at the
 * default, say) cannot produce a mark — the pass rate would be 0/0. Catching it
 * at authoring is the point; `outcomeFor` also refuses to guess at grading time
 * rather than dividing by zero and awarding a confident 0 or NaN.
 */
export function suiteIsGradable(tests: JudgeTest[]): boolean {
  return tests.length > 0 && tests.reduce((s, t) => s + weightOf(t), 0) > 0;
}

// ══════════════════════════════════════════════════════════════════
// §4 — SUBMISSION AND VERDICT
// ══════════════════════════════════════════════════════════════════

export interface JudgeSubmission {
  language: JudgeLanguage;
  source: string;
  tests: JudgeTest[];
  limits: JudgeLimits;
  /**
   * Opaque correlation id for logs and idempotency. The core never interprets
   * it; adapters may pass it to a provider that supports deduplication.
   */
  ref?: string;
}

/**
 * Why one test ended.
 *
 * Every value here except 'skipped' is a statement about the CANDIDATE'S
 * PROGRAM, and all of them are legitimate zeros for that test.
 */
export type TestStatus =
  | 'passed'
  | 'wrong_answer'
  | 'timeout'
  | 'runtime_error'
  | 'memory_exceeded'
  | 'output_exceeded'
  | 'skipped';      // not run — only ever set when the run itself did not complete

/**
 * Whether the JUDGE did its job. Orthogonal to whether the code was correct.
 *
 * 'completed' and 'compile_error' are real verdicts: the submission was judged
 * and the score stands. Everything below them is the platform failing, and
 * `outcomeFor` returns null for those so no mark is recorded at all.
 */
export type RunStatus =
  | 'completed'         // every test ran; per-test statuses are authoritative
  | 'compile_error'     // the program never built — a real, penalty-eligible zero
  | 'judge_unavailable' // unreachable, rate-limited, circuit open — NOT a zero
  | 'internal_error';   // adapter or provider malfunction — NOT a zero

export interface JudgeTestResult {
  testId: string;
  status: TestStatus;
  /** Wall time observed for this test, when the provider reports it. */
  timeMs?: number;
  memoryKb?: number;
  /**
   * Captured output, TRUNCATED to the submission's outputKb by the adapter.
   *
   * Populated for hidden tests too — staff reviewing a paper need to see why a
   * hidden test failed. `redactForCandidate` is what strips it before anything
   * reaches a browser; storage keeps the full picture.
   */
  stdout?: string;
  stderr?: string;
}

export interface JudgeVerdict {
  status: RunStatus;
  /** Compiler diagnostics. Present when status is 'compile_error'. */
  compileMessage?: string;
  /** Human-readable cause for the two non-verdict statuses. Never shown to candidates. */
  failureReason?: string;
  results: JudgeTestResult[];
  /** Which adapter produced this, for tracing after a provider swap. */
  adapter: string;
  /** ISO timestamp. */
  judgedAt: string;
}

/** True when the verdict is a statement about the candidate's code. */
export function isRealVerdict(v: JudgeVerdict): boolean {
  return v.status === 'completed' || v.status === 'compile_error';
}

/**
 * The verdict to record when the judge could not be reached.
 *
 * Exported because every adapter needs to produce exactly this shape on
 * failure, and because the run-during-exam path needs to hand one to the UI
 * without inventing its own error contract.
 */
export function unavailableVerdict(
  adapter: string,
  reason: string,
  now: Date = new Date(),
): JudgeVerdict {
  return {
    status: 'judge_unavailable',
    failureReason: reason,
    results: [],
    adapter,
    judgedAt: now.toISOString(),
  };
}

// ══════════════════════════════════════════════════════════════════
// §5 — THE ADAPTER
// ══════════════════════════════════════════════════════════════════

/**
 * The whole surface a judge provider must implement.
 *
 * Takes an entire submission rather than one test at a time so each adapter can
 * batch the way its provider prefers — Judge0 has a batch endpoint, Piston does
 * not — without the caller knowing or caring.
 *
 * `run` MUST NOT throw. A provider failure is data (`judge_unavailable`), not
 * an exception, because the caller's correct response to it is to record a
 * verdict and move on, and an exception invites a `catch` that scores zero.
 */
export interface JudgeAdapter {
  /** Stable identifier recorded on every verdict, e.g. 'judge0', 'piston'. */
  readonly name: string;
  run(submission: JudgeSubmission): Promise<JudgeVerdict>;
  /** Cheap liveness probe for the circuit breaker and for admin diagnostics. */
  health(): Promise<boolean>;
}

/**
 * The adapter configured before any real judge exists.
 *
 * Not a test double — this ships. It lets the entire pipeline (storage,
 * grading, review queue, run-during-exam degraded state) be wired and deployed
 * while the provider decision is still open, and it fails in the one direction
 * that is safe: every submission becomes a paper awaiting manual review, never
 * a zero.
 */
export class NullJudgeAdapter implements JudgeAdapter {
  readonly name = 'null';
  async run(): Promise<JudgeVerdict> {
    return unavailableVerdict(this.name, 'No judge provider is configured.');
  }
  async health(): Promise<boolean> {
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════
// §6 — OUTPUT COMPARISON
// ══════════════════════════════════════════════════════════════════

/** CRLF and lone CR are transport artefacts, never a candidate's answer. */
function normaliseNewlines(s: string): string {
  return s.replace(/\r\n?/g, '\n');
}

function stripTrailingBlankLines(s: string): string {
  return s.replace(/\n+$/, '');
}

function trimTrailingSpacePerLine(s: string): string {
  return s.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n');
}

function tokenise(s: string): string[] {
  return s.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Absolute-OR-relative tolerance.
 *
 * Absolute alone fails legitimately large answers (1e12 vs 1e12+1e-3 is a
 * relative error of 1e-15 and an absolute error of 1e-3); relative alone is
 * useless near zero. Accepting either is what every numeric judge does.
 */
function numbersMatch(a: number, b: number, tol: number): boolean {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a === b;
  const diff = Math.abs(a - b);
  return diff <= tol || diff <= tol * Math.abs(b);
}

/** Strict numeric parse: rejects '', '0x10', '1,000', 'Infinity ' and other near-numbers. */
function parseStrictNumber(t: string): number | null {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Does the produced output satisfy the expected output under `mode`?
 *
 * The whole of a coding mark rests on this predicate, so each mode is defined
 * by what it deliberately ignores rather than by what it happens to do.
 */
export function compareOutput(
  actual: string,
  expected: string,
  mode: ComparisonMode = 'trimmed',
  tolerance: number = DEFAULT_TOLERANCE,
): boolean {
  const a = normaliseNewlines(actual);
  const e = normaliseNewlines(expected);

  if (mode === 'exact') return a === e;

  if (mode === 'trimmed') {
    return stripTrailingBlankLines(trimTrailingSpacePerLine(a))
        === stripTrailingBlankLines(trimTrailingSpacePerLine(e));
  }

  const at = tokenise(a);
  const et = tokenise(e);
  if (at.length !== et.length) return false;

  if (mode === 'tokens') {
    return at.every((t, i) => t === et[i]);
  }

  // numeric
  const tol = Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : DEFAULT_TOLERANCE;
  return at.every((t, i) => {
    const ev = et[i];
    if (t === ev) return true;
    const an = parseStrictNumber(t);
    const en = parseStrictNumber(ev);
    // A non-numeric token compares as a string; only two numbers get tolerance.
    if (an === null || en === null) return false;
    return numbersMatch(an, en, tol);
  });
}

/** Apply a test's own comparison settings to a captured stdout. */
export function testPasses(test: JudgeTest, stdout: string): boolean {
  return compareOutput(stdout, test.expected, test.comparison ?? 'trimmed', test.tolerance ?? DEFAULT_TOLERANCE);
}

// ══════════════════════════════════════════════════════════════════
// §7 — AGGREGATION AND THE GRADING BRIDGE
// ══════════════════════════════════════════════════════════════════

export interface PassSummary {
  /** Tests whose status is 'passed', counted plainly. For display. */
  passed: number;
  /** Tests in the suite. For display. */
  total: number;
  /** Weighted equivalents — these are what the mark is computed from. */
  weightedPassed: number;
  weightedTotal: number;
  /** weightedPassed / weightedTotal, or 0 when the suite carries no weight. */
  rate: number;
}

/**
 * Fold a verdict into a pass summary.
 *
 * Tests with no result are counted as not passed rather than skipped over: a
 * suite of ten tests where the adapter returned six results is a six-test
 * answer to a ten-test question, and quietly grading it out of six would award
 * a candidate full marks for a run that never finished.
 */
export function summarise(verdict: JudgeVerdict, tests: JudgeTest[]): PassSummary {
  const byId = new Map(verdict.results.map((r) => [r.testId, r]));
  let passed = 0;
  let weightedPassed = 0;
  let weightedTotal = 0;

  for (const t of tests) {
    const w = weightOf(t);
    weightedTotal += w;
    if (byId.get(t.id)?.status === 'passed') {
      passed += 1;
      weightedPassed += w;
    }
  }

  return {
    passed,
    total: tests.length,
    weightedPassed,
    weightedTotal,
    rate: weightedTotal > 0 ? weightedPassed / weightedTotal : 0,
  };
}

/**
 * Structurally identical to `ScoreOutcome` in index.ts, and deliberately not
 * imported from it — `functions/src/index.ts` pulls in firebase-admin, and this
 * module's whole value is that it does not. `awardFor` accepts the shape
 * structurally, so this type plugs straight into the existing grading path.
 */
export interface CodeOutcome {
  multiplier: number;
  isCorrect: boolean;
  anyCorrect: boolean;
}

/**
 * Turn a verdict into the outcome the existing grading path already knows how
 * to award — or null, meaning "not gradable, send it to manual review".
 *
 * NULL IS RETURNED ONLY WHEN NOBODY CAN BE BLAMED FOR THE ZERO:
 *   • the judge was unreachable or malfunctioned — the platform failed, and a
 *     candidate must never absorb that as a mark;
 *   • the suite carries no weight at all — an authoring mistake, and grading a
 *     0/0 would either divide by zero or award a silent, confident zero.
 *
 * A COMPILE ERROR IS NOT ONE OF THOSE. It is a complete, correct verdict with
 * zero tests passed, which under the settled policy is exactly the case where
 * an institution's opt-in negative marking may apply. `anyCorrect` is false and
 * that is deliberate, not an oversight.
 *
 * `anyCorrect: weightedPassed > 0` is the whole of the negative-marking policy
 * for coding. `awardFor` already reserves the penalty for an answer that got
 * nothing right (A-08), so a candidate passing 7 of 10 tests takes the
 * `multiplier > 0` branch and the penalty is never consulted. Partial credit
 * cannot be penalised, because there is no code path that could do it.
 */
export function outcomeFor(verdict: JudgeVerdict, tests: JudgeTest[]): CodeOutcome | null {
  if (!isRealVerdict(verdict)) return null;
  if (!suiteIsGradable(tests)) return null;

  const s = summarise(verdict, tests);
  return {
    multiplier: s.rate,
    isCorrect: s.weightedPassed === s.weightedTotal,
    anyCorrect: s.weightedPassed > 0,
  };
}

// ══════════════════════════════════════════════════════════════════
// §8 — REDACTION
// ══════════════════════════════════════════════════════════════════

/**
 * What a candidate's browser is allowed to see.
 *
 * Hidden test cases are the answer key for a coding question. They live in
 * `questionAnswers` for the same reason `correctIds` does — the one collection
 * a student cannot read — and this function is the second half of that
 * guarantee: even once a verdict exists, the parts of it derived from hidden
 * tests never travel to a client.
 *
 * Hidden results are removed ENTIRELY rather than stripped down to a status.
 * A per-test pass/fail list for hidden tests is itself an oracle: run, observe
 * which hidden test flipped, and the suite can be reconstructed by
 * bisection without ever seeing its text. The candidate learns only how many
 * hidden tests exist, which is useful for calibration and reveals nothing.
 *
 * `failureReason` is dropped too — it carries adapter and infrastructure
 * detail written for operators, not candidates.
 */
export interface CandidateVerdict {
  status: RunStatus;
  compileMessage?: string;
  /** Visible tests only, with their output intact. */
  results: JudgeTestResult[];
  /** Aggregate over hidden tests, with no per-test detail. */
  hiddenCount: number;
  judgedAt: string;
}

export function redactForCandidate(verdict: JudgeVerdict, tests: JudgeTest[]): CandidateVerdict {
  const visibleIds = new Set(tests.filter((t) => t.visible).map((t) => t.id));
  const known = new Set(tests.map((t) => t.id));

  return {
    status: verdict.status,
    ...(verdict.compileMessage !== undefined ? { compileMessage: verdict.compileMessage } : {}),
    // A result for a test id the suite does not contain is dropped rather than
    // passed through: an adapter that invents ids must not be able to smuggle
    // output past the visibility check.
    results: verdict.results.filter((r) => visibleIds.has(r.testId) && known.has(r.testId)),
    hiddenCount: tests.filter((t) => !t.visible).length,
    judgedAt: verdict.judgedAt,
  };
}

/**
 * The submission a candidate's in-exam "Run" produces.
 *
 * Hidden tests are not merely redacted from the response — they are never sent
 * to the judge at all. Redaction protects the answer key from a candidate
 * reading a response; this protects it from timing, from provider logs, and
 * from an adapter bug. It also happens to make sample runs cheap, which is what
 * makes them affordable to offer during an exam.
 */
export function sampleRunSubmission(full: JudgeSubmission): JudgeSubmission {
  return { ...full, tests: visibleTests(full.tests) };
}
