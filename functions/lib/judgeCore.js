"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.JUDGE_CLAIM_LEASE_MS = exports.MAX_JUDGE_ATTEMPTS = exports.NullJudgeAdapter = exports.DEFAULT_TOLERANCE = exports.MAX_LIMITS = exports.DEFAULT_LIMITS = exports.JUDGE_LANGUAGE_LABEL = exports.JUDGE_LANGUAGES = void 0;
exports.isJudgeLanguage = isJudgeLanguage;
exports.clampLimits = clampLimits;
exports.weightOf = weightOf;
exports.visibleTests = visibleTests;
exports.suiteIsGradable = suiteIsGradable;
exports.isRealVerdict = isRealVerdict;
exports.unavailableVerdict = unavailableVerdict;
exports.compareOutput = compareOutput;
exports.testPasses = testPasses;
exports.summarise = summarise;
exports.outcomeFor = outcomeFor;
exports.redactForCandidate = redactForCandidate;
exports.nextBackoffMs = nextBackoffMs;
exports.claimIsStale = claimIsStale;
exports.shouldJudgeNow = shouldJudgeNow;
exports.advanceState = advanceState;
exports.isExhausted = isExhausted;
exports.sampleRunSubmission = sampleRunSubmission;
exports.JUDGE_LANGUAGES = [
    'python3', 'javascript', 'typescript', 'java', 'c', 'cpp',
    'csharp', 'go', 'rust', 'kotlin', 'php', 'ruby', 'sql',
];
exports.JUDGE_LANGUAGE_LABEL = {
    python3: 'Python 3',
    javascript: 'JavaScript',
    typescript: 'TypeScript',
    java: 'Java',
    c: 'C',
    cpp: 'C++',
    csharp: 'C#',
    go: 'Go',
    rust: 'Rust',
    kotlin: 'Kotlin',
    php: 'PHP',
    ruby: 'Ruby',
    sql: 'SQL',
};
function isJudgeLanguage(v) {
    return typeof v === 'string' && exports.JUDGE_LANGUAGES.includes(v);
}
/** What a question gets when its author sets nothing. Tuned for interview-scale work. */
exports.DEFAULT_LIMITS = Object.freeze({
    cpuMs: 2000,
    wallMs: 5000,
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
exports.MAX_LIMITS = Object.freeze({
    cpuMs: 15000,
    wallMs: 30000,
    memoryKb: 1024 * 1024,
    outputKb: 4 * 1024,
    processes: 128,
});
const MIN_LIMITS = Object.freeze({
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
function clampLimits(partial) {
    const pick = (k) => {
        const raw = partial?.[k];
        const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : exports.DEFAULT_LIMITS[k];
        return Math.min(exports.MAX_LIMITS[k], Math.max(MIN_LIMITS[k], Math.floor(v)));
    };
    const cpuMs = pick('cpuMs');
    const wallMs = Math.max(pick('wallMs'), cpuMs);
    return {
        cpuMs,
        wallMs: Math.min(exports.MAX_LIMITS.wallMs, wallMs),
        memoryKb: pick('memoryKb'),
        outputKb: pick('outputKb'),
        processes: pick('processes'),
    };
}
exports.DEFAULT_TOLERANCE = 1e-9;
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
function weightOf(t) {
    if (typeof t.weight === 'number' && Number.isFinite(t.weight) && t.weight >= 0) {
        return t.weight;
    }
    return t.visible ? 0 : 1;
}
/** The tests a candidate may run during the exam. */
function visibleTests(tests) {
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
function suiteIsGradable(tests) {
    return tests.length > 0 && tests.reduce((s, t) => s + weightOf(t), 0) > 0;
}
/** True when the verdict is a statement about the candidate's code. */
function isRealVerdict(v) {
    return v.status === 'completed' || v.status === 'compile_error';
}
/**
 * The verdict to record when the judge could not be reached.
 *
 * Exported because every adapter needs to produce exactly this shape on
 * failure, and because the run-during-exam path needs to hand one to the UI
 * without inventing its own error contract.
 */
function unavailableVerdict(adapter, reason, now = new Date()) {
    return {
        status: 'judge_unavailable',
        failureReason: reason,
        results: [],
        adapter,
        judgedAt: now.toISOString(),
    };
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
class NullJudgeAdapter {
    constructor() {
        this.name = 'null';
    }
    async run() {
        return unavailableVerdict(this.name, 'No judge provider is configured.');
    }
    async health() {
        return false;
    }
}
exports.NullJudgeAdapter = NullJudgeAdapter;
// ══════════════════════════════════════════════════════════════════
// §6 — OUTPUT COMPARISON
// ══════════════════════════════════════════════════════════════════
/** CRLF and lone CR are transport artefacts, never a candidate's answer. */
function normaliseNewlines(s) {
    return s.replace(/\r\n?/g, '\n');
}
function stripTrailingBlankLines(s) {
    return s.replace(/\n+$/, '');
}
function trimTrailingSpacePerLine(s) {
    return s.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n');
}
function tokenise(s) {
    return s.split(/\s+/).filter((t) => t.length > 0);
}
/**
 * Absolute-OR-relative tolerance.
 *
 * Absolute alone fails legitimately large answers (1e12 vs 1e12+1e-3 is a
 * relative error of 1e-15 and an absolute error of 1e-3); relative alone is
 * useless near zero. Accepting either is what every numeric judge does.
 */
function numbersMatch(a, b, tol) {
    if (Number.isNaN(a) && Number.isNaN(b))
        return true;
    if (!Number.isFinite(a) || !Number.isFinite(b))
        return a === b;
    const diff = Math.abs(a - b);
    return diff <= tol || diff <= tol * Math.abs(b);
}
/** Strict numeric parse: rejects '', '0x10', '1,000', 'Infinity ' and other near-numbers. */
function parseStrictNumber(t) {
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t))
        return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
}
/**
 * Does the produced output satisfy the expected output under `mode`?
 *
 * The whole of a coding mark rests on this predicate, so each mode is defined
 * by what it deliberately ignores rather than by what it happens to do.
 */
function compareOutput(actual, expected, mode = 'trimmed', tolerance = exports.DEFAULT_TOLERANCE) {
    const a = normaliseNewlines(actual);
    const e = normaliseNewlines(expected);
    if (mode === 'exact')
        return a === e;
    if (mode === 'trimmed') {
        return stripTrailingBlankLines(trimTrailingSpacePerLine(a))
            === stripTrailingBlankLines(trimTrailingSpacePerLine(e));
    }
    const at = tokenise(a);
    const et = tokenise(e);
    if (at.length !== et.length)
        return false;
    if (mode === 'tokens') {
        return at.every((t, i) => t === et[i]);
    }
    // numeric
    const tol = Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : exports.DEFAULT_TOLERANCE;
    return at.every((t, i) => {
        const ev = et[i];
        if (t === ev)
            return true;
        const an = parseStrictNumber(t);
        const en = parseStrictNumber(ev);
        // A non-numeric token compares as a string; only two numbers get tolerance.
        if (an === null || en === null)
            return false;
        return numbersMatch(an, en, tol);
    });
}
/** Apply a test's own comparison settings to a captured stdout. */
function testPasses(test, stdout) {
    return compareOutput(stdout, test.expected, test.comparison ?? 'trimmed', test.tolerance ?? exports.DEFAULT_TOLERANCE);
}
/**
 * Fold a verdict into a pass summary.
 *
 * Tests with no result are counted as not passed rather than skipped over: a
 * suite of ten tests where the adapter returned six results is a six-test
 * answer to a ten-test question, and quietly grading it out of six would award
 * a candidate full marks for a run that never finished.
 */
function summarise(verdict, tests) {
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
function outcomeFor(verdict, tests) {
    if (!isRealVerdict(verdict))
        return null;
    if (!suiteIsGradable(tests))
        return null;
    const s = summarise(verdict, tests);
    return {
        multiplier: s.rate,
        isCorrect: s.weightedPassed === s.weightedTotal,
        anyCorrect: s.weightedPassed > 0,
    };
}
function redactForCandidate(verdict, tests) {
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
 * How many times a submission is judged before the platform stops trying.
 *
 * Not unlimited, and the reason is that "the judge is down" and "this
 * submission kills the judge" look identical from here. A retry budget bounds
 * the damage a single pathological program can do to a shared judge during an
 * exam. On exhaustion the paper stays in manual review — visible, unresolved,
 * and never a zero.
 */
exports.MAX_JUDGE_ATTEMPTS = 5;
/** A claim older than this is presumed dead and may be taken over. */
exports.JUDGE_CLAIM_LEASE_MS = 10 * 60000;
const BACKOFF_MS = [60000, 5 * 60000, 15 * 60000, 60 * 60000];
/**
 * How long to wait before the next attempt.
 *
 * Escalating rather than fixed: the failure this retries against is usually an
 * outage, and an outage is not resolved by asking again immediately. Hammering
 * a judge that is already struggling is how a degraded judge becomes a dead
 * one.
 */
function nextBackoffMs(attempts) {
    if (attempts <= 0)
        return BACKOFF_MS[0];
    return BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
}
function claimIsStale(state, nowMs) {
    if (!state?.claimedAt)
        return true;
    const t = Date.parse(state.claimedAt);
    return !Number.isFinite(t) || nowMs - t >= exports.JUDGE_CLAIM_LEASE_MS;
}
/**
 * Should this submission be judged now?
 *
 * Four reasons not to, and they are deliberately all one decision rather than
 * scattered `if`s at the call site: already settled, out of retries, still
 * backing off, or claimed by a worker that is probably still alive.
 */
function shouldJudgeNow(state, nowMs) {
    const s = state ?? { attempts: 0 };
    // A real verdict is final. Re-judging a completed submission would let a
    // second run silently overwrite a mark a student has already been shown.
    if (s.lastStatus === 'completed' || s.lastStatus === 'compile_error')
        return false;
    if (s.attempts >= exports.MAX_JUDGE_ATTEMPTS)
        return false;
    if (s.nextAttemptAt) {
        const t = Date.parse(s.nextAttemptAt);
        if (Number.isFinite(t) && nowMs < t)
            return false;
    }
    return claimIsStale(s, nowMs);
}
/** The state to store after an attempt to judge produced `verdict`. */
function advanceState(state, verdict, nowMs) {
    const attempts = (state?.attempts ?? 0) + 1;
    const next = { attempts, lastStatus: verdict.status };
    // A real verdict needs no further attempts, so it carries no backoff and no
    // claim — leaving either behind would make a settled submission look busy.
    if (isRealVerdict(verdict))
        return next;
    if (attempts < exports.MAX_JUDGE_ATTEMPTS) {
        next.nextAttemptAt = new Date(nowMs + nextBackoffMs(attempts)).toISOString();
    }
    return next;
}
/** True when the platform has given up and a human needs to see this. */
function isExhausted(state) {
    const s = state ?? { attempts: 0 };
    if (s.lastStatus === 'completed' || s.lastStatus === 'compile_error')
        return false;
    return s.attempts >= exports.MAX_JUDGE_ATTEMPTS;
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
function sampleRunSubmission(full) {
    return { ...full, tests: visibleTests(full.tests) };
}
//# sourceMappingURL=judgeCore.js.map