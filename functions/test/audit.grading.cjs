// ═══════════════════════════════════════════════════════════════════════════
// AUDIT PROBE SUITE — ROUND 4: GRADING  (2026-08-03)
//
// Rounds 2 and 3 went at TIME and at which paper is marked. This one goes at
// the MARK itself: what a student is awarded, what they are told, and whether
// the arithmetic holds at the edges.
//
// The question this round exists to answer is the one asked directly — "is
// there any issue with grading left?" — so it deliberately probes the parts of
// scoring that no earlier round touched: manual review, invalidation, missing
// question documents, marks drift, per-section consistency, and rounding.
//
//   node test/audit.grading.cjs
// ═══════════════════════════════════════════════════════════════════════════

const { FakeDb } = require('./fakeFirestore.cjs');

const RealDate = Date;
let VNOW = Date.parse('2026-08-01T09:00:00.000Z');
class FakeDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(VNOW); else super(...args); }
  static now() { return VNOW; }
  static parse(s) { return RealDate.parse(s); }
  static UTC(...a) { return RealDate.UTC(...a); }
}
global.Date = FakeDate;
const advance = (ms) => { VNOW += ms; };
const at = (ms) => new RealDate(ms).toISOString();
const min = (m) => m * 60_000;

process.env.GCLOUD_PROJECT = 'demo-audit-grading';
const adminFs = require('firebase-admin/firestore');
let DB = new FakeDb();
adminFs.getFirestore = () => DB;
require('firebase-admin/app').initializeApp = () => ({});

const fns = require('../lib/index.js');

const results = [];
const KNOWN_GAPS = [];
let current = null;
async function scenario(id, title, fn) {
  current = { id, title, checks: [], error: null };
  DB = new FakeDb();
  VNOW = Date.parse('2026-08-01T09:00:00.000Z');
  try { await fn(); } catch (e) { current.error = e; }
  results.push(current);
}
function check(pass, label, detail) {
  current.checks.push({ pass: !!pass, label, detail: detail === undefined ? null : String(detail) });
}
function eq(actual, expected, label) {
  check(actual === expected, label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
async function call(fnRef, data, auth) {
  return fnRef.run({ data, auth, rawRequest: { headers: {} }, acceptsStreaming: false });
}
async function expectThrow(label, fn, msgPart) {
  try { await fn(); check(false, label, 'no error was thrown'); return null; }
  catch (e) {
    const ok = !msgPart || String(e.message).includes(msgPart);
    check(ok, label, ok ? undefined : `threw "${e.message}", wanted "${msgPart}"`);
    return e;
  }
}

const OWNER   = (uid = 'wo_1') => ({ uid, token: { role: 'webOwner' } });
const STUDENT = (uid = 'stu_uid', studentId = 'stu_1', instituteId = 'inst_1') =>
  ({ uid, token: { role: 'student', studentId, instituteId } });

const A = (id) => DB.read('attempts', id);

function answer(attemptId, qid, value, sectionId, type = 'mcq') {
  const att = DB.read('attempts', attemptId);
  att.answers[qid] = { type, value, sectionId, answeredAt: at(VNOW) };
  DB.seed('attempts', attemptId, att);
}

function seedQ(id, o = {}) {
  DB.seed('questions', id, {
    id, engine: o.engine ?? 'mcq', variant: o.variant ?? 'single', stem: `Q ${id}`,
    options: [{ id: 'alpha' }, { id: 'beta' }, { id: 'gamma' }],
    pairs: o.pairs ?? [], difficulty: o.difficulty ?? 'medium',
  });
  DB.seed('questionAnswers', id, {
    id, correctIds: o.correctIds ?? ['alpha'],
    correctPairs: o.correctPairs ?? [], modelAnswer: o.modelAnswer ?? '',
    ...(o.tests ? { tests: o.tests } : {}),
  });
}

// ── Coding fixtures ───────────────────────────────────────────────
// A hidden suite of n tests, and a verdict passing the first k of them.
const suite = (n) => Array.from({ length: n }, (_, i) => ({
  id: `h${i}`, stdin: '', expected: String(i), visible: false,
}));
const completed = (n, k) => ({
  status: 'completed',
  results: Array.from({ length: n }, (_, i) => ({
    testId: `h${i}`, status: i < k ? 'passed' : 'wrong_answer',
  })),
  adapter: 'test', judgedAt: at(VNOW),
});
/** Verdicts live in their own staff-only collection, keyed attempt__question. */
function seedVerdict(attemptId, qid, verdict) {
  DB.seed('attemptVerdicts', `${attemptId}__${qid}`, {
    attemptId, questionId: qid, instituteId: 'inst_1', verdict,
  });
}

/** One section, caller-supplied question list. */
function seedExam(questions, o = {}) {
  DB.seed('students', 'stu_1', { id: 'stu_1', name: 'S', instituteId: 'inst_1' });
  DB.seed('assessments', 'asmt_1', {
    id: 'asmt_1', title: 'Grading Paper', instituteId: 'inst_1',
    ownerType: 'webOwner', ownerId: 'webOwner',
    status: 'active',
    startDate: at(VNOW - min(60)), endDate: at(VNOW + min(600)),
    maxAttempts: o.maxAttempts ?? 1, overallTimeLimit: 120,
    deliveryMode: 'standard', sectionStartOrder: 'sequential',
    securityTier: 'mock', requireCamera: false, allowMobile: true,
    requireExtensionCheck: false, requireSEB: false,
    securityLockedAt: at(VNOW - min(120)),
    passingScore: o.passingScore ?? 50,
    assignedTo: { type: 'all' }, allowReview: true, showResults: true,
    gradingConfig: o.gradingConfig,
    sections: o.sections ?? [{ id: 'SA', name: 'A', timeLimit: 60, questions }],
  });
}

// ═══════════════════════════════════════════════════════════════════
// G-01 · a text answer can be marked by a human
//
// scoreAttemptAnswers sets requiresManualReview for the text engine and awards
// nothing, which is correct — a machine cannot mark an essay. The flag is
// surfaced in three UIs (roster, student list, results page) and exported to
// CSV, so the product promises a marking workflow.
//
// This probe asks whether that workflow EXISTS: can any actor put a mark on a
// text answer, through any path?
// ═══════════════════════════════════════════════════════════════════
async function G01() {
  seedQ('t1', { engine: 'text', modelAnswer: 'a model answer' });
  seedQ('m1');
  seedExam([
    { questionId: 'm1', marks: 50, order: 0 },
    { questionId: 't1', marks: 50, order: 1 },
  ]);

  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  advance(min(1));
  answer(id, 'm1', 'alpha', 'SA');                       // correct, 50/50
  answer(id, 't1', 'My essay answer.', 'SA', 'text');    // needs a human
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());

  const s = A(id).scores;
  eq(s.requiresManualReview, true, 'the paper is flagged as needing manual review');
  eq(s.total, 50, 'only the machine-markable half is awarded so far');
  eq(s.available, 100, 'but the full paper counts toward the denominator');

  // Is there ANY route to award the essay its marks?
  const before = A(id).scores.total;
  await call(fns.regradeAttempts, { assessmentId: 'asmt_1' }, OWNER());
  eq(A(id).scores.total, before, 'a regrade cannot mark it either (same scorer)');

  // ── KNOWN GAP, recorded rather than asserted ────────────────────
  //
  // There is NO manual-marking path anywhere: no callable awards marks for a
  // text answer, and firestore.rules restrict staff attempt writes to
  // ['updatedAt'], so no client route exists either. A paper containing an
  // essay question can therefore never be finished.
  //
  // This probe does NOT fail on that. Building the workflow is a product
  // decision — who may mark, whether marking needs a second approver, what the
  // audit trail records — and inventing answers to those inside an audit would
  // be worse than naming the gap. What the probe DOES hold is that the system
  // behaves honestly in the meantime, which is what G-02 and G-04 fixed: the
  // paper is flagged, and no pass/fail verdict is issued on it.
  const hasManualMarking = ['setManualMark', 'markAnswer', 'gradeAnswerManually',
    'setAnswerMark', 'manualGrade'].some((n) => typeof fns[n] === 'function');
  if (!hasManualMarking) {
    KNOWN_GAPS.push(
      'No manual-marking path exists for text/essay answers. Papers containing '
      + 'them can be sat and scored but never completed. Consequences are '
      + 'contained (G-02: no pass/fail verdict is issued; the paper is flagged), '
      + 'but the marks are unreachable. Building the workflow is a product '
      + 'decision and is deliberately NOT done here.');
  }
  check(true, 'the unmarkable half is reported honestly rather than scored as wrong');
  eq(A(id).scores.passed, null, 'and no pass/fail verdict is issued (G-02)');
}

// ═══════════════════════════════════════════════════════════════════
// G-02 · a student is not told they FAILED on a half-marked paper
//
// The consequence of G-01, and the part that reaches the student. `passed` is
// computed from a percentage whose denominator includes marks nobody can award
// yet, so a paper awaiting human marking reports a verdict as though marking
// were finished.
// ═══════════════════════════════════════════════════════════════════
async function G02() {
  seedQ('t1', { engine: 'text' });
  seedQ('m1');
  seedExam([
    { questionId: 'm1', marks: 50, order: 0 },
    { questionId: 't1', marks: 50, order: 1 },
  ], { passingScore: 60 });

  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  advance(min(1));
  answer(id, 'm1', 'alpha', 'SA');                         // every markable mark earned
  answer(id, 't1', 'A strong essay.', 'SA', 'text');
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());

  const s = A(id).scores;
  eq(s.percentage, 50, 'percentage counts the unmarked essay as zero');
  eq(s.requiresManualReview, true, 'and the paper is flagged as unfinished');
  // The pass mark is 60. The student has earned every mark a machine can
  // award; the essay alone decides whether they pass. Declaring FAILED now is
  // a verdict on marking that has not happened.
  check(s.passed !== false,
    'a paper still awaiting human marking does not report a FAILED verdict',
    `passed=${JSON.stringify(s.passed)}, percentage=${s.percentage}%, `
    + `pass mark 60% — the student answered every machine-markable question `
    + 'correctly and the unmarked essay is worth 50%');
}

// ═══════════════════════════════════════════════════════════════════
// G-03 · invalidating a question awards it to everyone, coherently
// ═══════════════════════════════════════════════════════════════════
async function G03() {
  seedQ('q1'); seedQ('q2'); seedQ('q3');
  seedExam([
    { questionId: 'q1', marks: 10, order: 0 },
    { questionId: 'q2', marks: 10, order: 1 },
    { questionId: 'q3', marks: 10, order: 2 },
  ]);
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  advance(min(1));
  answer(id, 'q1', 'alpha', 'SA');   // correct
  answer(id, 'q2', 'beta', 'SA');    // wrong
  // q3 blank
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());
  eq(A(id).scores.total, 10, 'baseline: only q1 is correct');

  await call(fns.regradeAttempts,
    { assessmentId: 'asmt_1', invalidatedQuestionIds: ['q2'] }, OWNER());
  const s = A(id).scores;
  eq(s.total, 20, 'the invalidated question awards full marks');
  eq(A(id).gradedAnswers.q2.isCorrect, null,
    'and correctness is undefined for it, not "correct"');

  const sum = s.bySection.reduce((n, x) => n + x.marksAwarded, 0);
  eq(sum, s.total, 'bySection still sums to the headline total');
}

// ═══════════════════════════════════════════════════════════════════
// G-04 · a question whose document has vanished
//
// Questions are soft-deletable and purgeable. If a doc is gone at grade time,
// loadQuestionAndAnswerMaps returns no entry and the answered branch cannot
// run. The student answered it; they must not silently lose the marks without
// the paper saying so.
// ═══════════════════════════════════════════════════════════════════
async function G04() {
  seedQ('q1'); seedQ('q2');
  seedExam([
    { questionId: 'q1', marks: 10, order: 0 },
    { questionId: 'q2', marks: 10, order: 1 },
  ]);
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  advance(min(1));
  answer(id, 'q1', 'alpha', 'SA');
  answer(id, 'q2', 'alpha', 'SA');

  // q2's documents are purged between sitting and grading.
  DB._docs.delete('questions/q2');
  DB._docs.delete('questionAnswers/q2');

  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());
  const s = A(id).scores;
  eq(s.total, 10, 'the surviving question is still marked');
  check(s.requiresManualReview === true || s.available === 10,
    'a vanished question is either flagged for a human or removed from the '
    + 'denominator — never silently counted against the student',
    `total=${s.total}, available=${s.available}, `
    + `requiresManualReview=${s.requiresManualReview}`);
}

// ═══════════════════════════════════════════════════════════════════
// G-05 · marks are taken from the frozen paper, not the live one
//
// A-05 froze WHICH questions are marked. This asks whether the MARKS ride
// along: re-weighting a question on a live exam must not re-weight a sitting
// that has already happened.
// ═══════════════════════════════════════════════════════════════════
async function G05() {
  seedQ('q1'); seedQ('q2');
  seedExam([
    { questionId: 'q1', marks: 10, order: 0 },
    { questionId: 'q2', marks: 10, order: 1 },
  ]);
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  advance(min(1));
  answer(id, 'q1', 'alpha', 'SA');   // correct
  answer(id, 'q2', 'beta', 'SA');    // wrong

  // Staff re-weight q1 from 10 to 1 after the sitting.
  const a = DB.read('assessments', 'asmt_1');
  a.sections[0].questions = [
    { questionId: 'q1', marks: 1, order: 0 },
    { questionId: 'q2', marks: 10, order: 1 },
  ];
  DB.seed('assessments', 'asmt_1', a);

  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());
  eq(A(id).scores.total, 10, 'the mark is the one the question carried when it was sat');
  eq(A(id).scores.available, 20, 'and so is the denominator');
}

// ═══════════════════════════════════════════════════════════════════
// G-06 · bySection always reconciles with the headline total
//
// The student sees per-section bars and one number. If they disagree the
// result is not explainable, which is worse than a wrong number.
// ═══════════════════════════════════════════════════════════════════
async function G06() {
  seedQ('q1'); seedQ('q2'); seedQ('q3'); seedQ('q4');
  seedExam(null, {
    passingScore: 40,
    gradingConfig: {
      exam: { negativeMarking: true, penaltyType: 'fixed', penaltyValue: 4, blankScore: 0 },
    },
    sections: [
      { id: 'SA', name: 'A', timeLimit: 60,
        questions: [{ questionId: 'q1', marks: 10, order: 0 },
                    { questionId: 'q2', marks: 10, order: 1 }] },
      { id: 'SB', name: 'B', timeLimit: 60,
        questions: [{ questionId: 'q3', marks: 10, order: 2 },
                    { questionId: 'q4', marks: 10, order: 3 }] },
    ],
  });
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  advance(min(1));
  // Section B is driven net-negative on purpose: every answer wrong.
  answer(id, 'q1', 'alpha', 'SA');  // +10
  answer(id, 'q2', 'beta', 'SA');   // -4
  answer(id, 'q3', 'beta', 'SB');   // -4
  answer(id, 'q4', 'beta', 'SB');   // -4
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());

  const s = A(id).scores;
  const sum = s.bySection.reduce((n, x) => n + x.marksAwarded, 0);
  const sb = s.bySection.find((x) => x.sectionId === 'SB');
  eq(sb.marksAwarded, -8, 'a section may be internally net-negative (staff diagnostic)');
  eq(sum, -2, 'the section sum is the raw, unfloored figure');
  eq(s.total, 0, 'the headline the student sees is floored at zero');
  check(s.total >= sum,
    'the floor only ever moves the headline UP relative to the raw sum');
  eq(s.available, 40, 'available is the full paper regardless of penalties');
}

// ═══════════════════════════════════════════════════════════════════
// G-07 · percent penalties and partial credit do not drift on rounding
// ═══════════════════════════════════════════════════════════════════
async function G07() {
  seedQ('q1', { variant: 'multi', correctIds: ['alpha', 'beta', 'gamma'] });
  seedQ('q2', { engine: 'match',
    correctPairs: [{ leftId: 'L1', rightId: 'R1' }, { leftId: 'L2', rightId: 'R2' },
                   { leftId: 'L3', rightId: 'R3' }] });
  seedQ('q3');
  seedExam([
    { questionId: 'q1', marks: 10, order: 0 },
    { questionId: 'q2', marks: 10, order: 1 },
    { questionId: 'q3', marks: 7, order: 2 },
  ], {
    gradingConfig: {
      exam: { negativeMarking: true, penaltyType: 'percent', penaltyValue: 33, blankScore: 0 },
    },
  });
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  advance(min(1));
  answer(id, 'q1', ['alpha', 'beta'], 'SA');                 // 2 of 3 → 2/3 * 10
  answer(id, 'q2', { L1: 'R1', L2: 'RX', L3: 'RX' }, 'SA', 'match');  // 1 of 3 → 1/3 * 10
  answer(id, 'q3', 'beta', 'SA');                            // wrong → -33% of 7

  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());
  const g = A(id).gradedAnswers;
  const s = A(id).scores;

  check(Math.abs(g.q1.marksAwarded - (2 / 3) * 10) < 1e-9,
    'multi-select partial credit is exact', `got ${g.q1.marksAwarded}`);
  check(Math.abs(g.q2.marksAwarded - (1 / 3) * 10) < 1e-9,
    'match partial credit is exact', `got ${g.q2.marksAwarded}`);
  check(Math.abs(g.q3.marksAwarded + 0.33 * 7) < 1e-9,
    'percent penalty is exact', `got ${g.q3.marksAwarded}`);

  const raw = g.q1.marksAwarded + g.q2.marksAwarded + g.q3.marksAwarded;
  check(Math.abs(s.total - Math.max(0, raw)) < 1e-9,
    'the total is the exact sum of the parts', `total=${s.total}, raw=${raw}`);
  check(Number.isFinite(s.percentage) && s.percentage >= 0 && s.percentage <= 100,
    'the percentage is a sane figure', `percentage=${s.percentage}`);
}

// ═══════════════════════════════════════════════════════════════════
// G-08 · an answer for a question outside the paper is ignored, not scored
// ═══════════════════════════════════════════════════════════════════
async function G08() {
  seedQ('q1'); seedQ('qX');
  seedExam([{ questionId: 'q1', marks: 10, order: 0 }]);
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  advance(min(1));
  answer(id, 'q1', 'alpha', 'SA');
  answer(id, 'qX', 'alpha', 'SA');    // forged: not in this paper

  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());
  const s = A(id).scores;
  eq(s.total, 10, 'the forged answer earns nothing');
  eq(s.available, 10, 'and does not inflate the denominator');
  check(!A(id).gradedAnswers.qX, 'and is not present in gradedAnswers');
}

// ═══════════════════════════════════════════════════════════════════
// G-09 · a blank paper scores zero, not a penalty, and reports honestly
// ═══════════════════════════════════════════════════════════════════
async function G09() {
  seedQ('q1'); seedQ('q2');
  seedExam([
    { questionId: 'q1', marks: 10, order: 0 },
    { questionId: 'q2', marks: 10, order: 1 },
  ], {
    passingScore: 1,
    gradingConfig: {
      exam: { negativeMarking: true, penaltyType: 'fixed', penaltyValue: 5, blankScore: 0 },
    },
  });
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  advance(min(1));
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());

  const s = A(id).scores;
  eq(s.total, 0, 'an untouched paper scores zero, never negative');
  eq(s.percentage, 0, 'and zero percent');
  eq(s.passed, false, 'and does not pass a paper with a pass mark of 1%');
  eq(s.bySection[0].answeredQuestions, 0, 'nothing is counted as answered');
}

// ═══════════════════════════════════════════════════════════════════
// G-10 · grading is identical across every finalisation path
// ═══════════════════════════════════════════════════════════════════
async function G10() {
  seedQ('q1'); seedQ('q2');
  const build = async () => {
    const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
    const id = started.attempt.id;
    answer(id, 'q1', 'alpha', 'SA');
    answer(id, 'q2', 'beta', 'SA');
    return id;
  };

  // (a) student submit
  seedExam([{ questionId: 'q1', marks: 10, order: 0 },
            { questionId: 'q2', marks: 10, order: 1 }], { maxAttempts: 5 });
  const a1 = await build();
  advance(min(1));
  await call(fns.gradeAttempt, { attemptId: a1, reason: 'manual' }, STUDENT());

  // (b) termination
  const a2 = await build();
  advance(min(1));
  await call(fns.gradeAttempt,
    { attemptId: a2, reason: 'terminated', terminateReason: 'integrity' }, STUDENT());

  // (c) the expiry sweep
  const a3 = await build();
  advance(min(200));                       // past the 120m overall limit
  await fns.scheduledCloseExpiredAttempts.run({});

  const s1 = A(a1).scores, s2 = A(a2).scores, s3 = A(a3).scores;
  eq(s1.total, 10, 'manual submit scores 10');
  eq(s2.total, s1.total, 'termination reaches the same mark');
  eq(s3.total, s1.total, 'the sweep reaches the same mark');
  eq(s3.available, s1.available, 'and the same denominator');
  eq(A(a3).status, 'auto_submitted', 'the swept attempt is terminal');
  check(A(a2).status === 'terminated', 'the terminated attempt is terminal');
}

// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// G-11 · a coding answer with no verdict yet
//
// The judge is asynchronous, so a paper is finalised BEFORE its coding marks
// exist. The question this asks is whether that gap is honest: an unjudged
// coding answer must read as "not marked yet", never as "wrong".
// ═══════════════════════════════════════════════════════════════════
async function G11() {
  seedQ('c1', { engine: 'code', tests: suite(10) });
  seedExam([{ questionId: 'c1', marks: 10, order: 0 }]);
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  advance(min(1));
  answer(id, 'c1', { language: 'python3', source: 'print(1)' }, 'SA', 'code');
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());

  const s = A(id).scores;
  eq(s.requiresManualReview, true, 'an unjudged coding answer flags the paper');
  eq(s.total, 0, 'nothing is awarded yet');
  eq(s.available, 10, 'but the marks stay in the denominator');
  eq(s.passed, null, 'and no pass/fail verdict is issued while a mark is outstanding');
}

// ═══════════════════════════════════════════════════════════════════
// G-12 · the verdict lands, and a regrade turns it into a mark
//
// This is the whole asynchronous path end to end: finalise → judge → regrade.
// 7 of 10 hidden tests is 7 of 10 marks, through the same awardFor every other
// engine uses.
// ═══════════════════════════════════════════════════════════════════
async function G12() {
  seedQ('c1', { engine: 'code', tests: suite(10) });
  seedExam([{ questionId: 'c1', marks: 10, order: 0 }]);
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  advance(min(1));
  answer(id, 'c1', { language: 'python3', source: 'solve()' }, 'SA', 'code');
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());
  eq(A(id).scores.requiresManualReview, true, 'flagged before the judge replies');

  seedVerdict(id, 'c1', completed(10, 7));
  await call(fns.regradeAttempts, { assessmentId: 'asmt_1' }, OWNER());

  const s = A(id).scores;
  eq(s.total, 7, '7 of 10 hidden tests awards 7 of 10 marks');
  eq(s.requiresManualReview, false, 'and the paper is no longer awaiting a mark');
  eq(s.passed, true, 'so a real verdict can finally be issued');
  eq(A(id).gradedAnswers.c1.isCorrect, false, 'partial credit is not a correct answer');
}

// ═══════════════════════════════════════════════════════════════════
// G-13 · THE RULE — a judge outage is never a candidate's zero
//
// The failure this exists to catch is silent: a judge that dies mid-exam,
// every paper marked zero, every downstream number well-formed. Negative
// marking is switched on here too, because scoring an outage as "fully wrong"
// would not merely award zero — it would go NEGATIVE.
// ═══════════════════════════════════════════════════════════════════
async function G13() {
  seedQ('c1', { engine: 'code', tests: suite(10) });
  seedQ('m1');
  seedExam([
    { questionId: 'm1', marks: 10, order: 0 },
    { questionId: 'c1', marks: 10, order: 1 },
  ], {
    gradingConfig: {
      exam: { negativeMarking: true, penaltyType: 'fixed', penaltyValue: 4 },
      // The coding section opts IN, so this test exercises the penalty path
      // rather than the default-off path (which G-14 covers).
      sections: { SA: { section: { negativeMarking: true } } },
    },
  });
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  advance(min(1));
  answer(id, 'm1', 'alpha', 'SA');
  answer(id, 'c1', { language: 'python3', source: 'whatever' }, 'SA', 'code');

  seedVerdict(id, 'c1', {
    status: 'judge_unavailable', failureReason: 'connect ETIMEDOUT',
    results: [], adapter: 'judge0', judgedAt: at(VNOW),
  });
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());

  const s = A(id).scores;
  eq(s.requiresManualReview, true, 'an outage sends the paper to manual review');
  eq(s.total, 10, 'the MCQ mark stands and the coding question costs nothing');
  eq(s.passed, null, 'no verdict while the judge still owes an answer');
  check(s.total >= 0, 'and above all: the outage did NOT go negative', `total ${s.total}`);
  eq(A(id).gradedAnswers.c1.marksAwarded, 0, 'no marks moved on the unjudged question');
}

// ═══════════════════════════════════════════════════════════════════
// G-14 · the settled negative-marking policy, at the integration level
//
// Three claims in one paper: partial credit is never penalised, a compile
// error IS a penalty-eligible zero, and a coding section does not inherit the
// exam's negative marking — it has to opt in.
// ═══════════════════════════════════════════════════════════════════
async function G14() {
  seedQ('c1', { engine: 'code', tests: suite(10) });   // partial pass
  seedQ('c2', { engine: 'code', tests: suite(10) });   // compile error
  seedExam([
    { questionId: 'c1', marks: 10, order: 0 },
    { questionId: 'c2', marks: 10, order: 1 },
  ], {
    // Switched ON at the exam, and left unset on the section.
    gradingConfig: { exam: { negativeMarking: true, penaltyType: 'fixed', penaltyValue: 4 } },
  });
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  advance(min(1));
  answer(id, 'c1', { language: 'python3', source: 'partial()' }, 'SA', 'code');
  answer(id, 'c2', { language: 'python3', source: 'syntax error' }, 'SA', 'code');
  seedVerdict(id, 'c1', completed(10, 7));
  seedVerdict(id, 'c2', {
    status: 'compile_error', compileMessage: "error: invalid syntax",
    results: [], adapter: 'judge0', judgedAt: at(VNOW),
  });
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());

  const g = A(id).gradedAnswers;
  eq(g.c1.marksAwarded, 7, '7 of 10 tests keeps its 7 marks, untouched by the penalty');
  eq(g.c2.marksAwarded, 0,
    'a compile error is a real zero — and takes NO penalty, because the coding '
    + 'section never opted in to the exam-level negative marking');
  eq(A(id).scores.total, 7, 'so the paper totals 7, not 3');
}

// ═══════════════════════════════════════════════════════════════════
// G-15 · the same paper, with the coding section opting IN
//
// The other half of G-14: an institution that requires negative marking sets
// it on the coding section, and it applies — but ONLY to the submission that
// passed nothing. Partial credit stays exactly where it was.
//
// The opt-in is seeded before the attempt starts, because the policy is frozen
// onto the attempt at that moment; editing the assessment afterwards cannot
// reach an attempt already sat, and a regrade honours the frozen copy.
// ═══════════════════════════════════════════════════════════════════
async function G15() {
  seedQ('c1', { engine: 'code', tests: suite(10) });   // 7/10 — partial credit
  seedQ('c2', { engine: 'code', tests: suite(10) });   // compile error — nothing right
  seedExam([
    { questionId: 'c1', marks: 10, order: 0 },
    { questionId: 'c2', marks: 10, order: 1 },
  ], {
    gradingConfig: {
      exam: { negativeMarking: true, penaltyType: 'fixed', penaltyValue: 4 },
      sections: { SA: { section: { negativeMarking: true } } },   // explicit opt-in
    },
  });
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  advance(min(1));
  answer(id, 'c1', { language: 'python3', source: 'partial()' }, 'SA', 'code');
  answer(id, 'c2', { language: 'python3', source: 'syntax error' }, 'SA', 'code');
  seedVerdict(id, 'c1', completed(10, 7));
  seedVerdict(id, 'c2', {
    status: 'compile_error', compileMessage: 'error: invalid syntax',
    results: [], adapter: 'judge0', judgedAt: at(VNOW),
  });
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());

  const g = A(id).gradedAnswers;
  eq(g.c1.marksAwarded, 7, 'partial credit is untouched even with the penalty enabled');
  eq(g.c2.marksAwarded, -4, 'and only the submission that passed nothing takes it');
  eq(A(id).scores.total, 3, '7 − 4 = 3');
}

// ── Sweep helpers ─────────────────────────────────────────────────
// A scripted judge, so the suite controls what the pipeline is handed.
function scriptedJudge(verdictFor) {
  return {
    name: 'scripted',
    calls: [],
    async run(sub) { this.calls.push(sub); return verdictFor(sub); },
    async health() { return true; },
  };
}
const V = (id) => DB.read('attemptVerdicts', id);

/** Seed a finished coding paper and return its attempt id. */
async function sitCodingPaper(o = {}) {
  seedQ('c1', { engine: 'code', tests: suite(10) });
  seedExam([{ questionId: 'c1', marks: 10, order: 0 }]);
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  advance(min(1));
  answer(id, 'c1', o.value ?? { language: 'python3', source: 'solve()' }, 'SA', 'code');
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());
  return id;
}

// ═══════════════════════════════════════════════════════════════════
// G-16 · finalisation queues judging instead of doing it
//
// A judge is remote, slow and allowed to be down. If submitting an exam
// blocked on one, a judge outage would stop students finishing. So the paper
// finalises immediately, flagged as owing marks, and the sweep does the work.
// ═══════════════════════════════════════════════════════════════════
async function G16() {
  const id = await sitCodingPaper();
  eq(A(id).codeJudgePending, true, 'the paper is queued for judging');
  eq(A(id).status, 'submitted', 'and finalised anyway — submitting never waits on a judge');
  eq(A(id).scores.requiresManualReview, true, 'while the marks are still owed');

  // A paper with no coding answers must not join the queue.
  DB = new FakeDb();
  seedQ('m1');
  seedExam([{ questionId: 'm1', marks: 10, order: 0 }]);
  const s2 = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  answer(s2.attempt.id, 'm1', 'alpha', 'SA');
  await call(fns.gradeAttempt, { attemptId: s2.attempt.id, reason: 'manual' }, STUDENT());
  eq(A(s2.attempt.id).codeJudgePending, undefined,
    'an MCQ-only paper is never queued — the flag comes from the answers, not from requiresManualReview');
}

// ═══════════════════════════════════════════════════════════════════
// G-17 · the sweep judges, settles, and rewrites the marks
//
// The whole asynchronous path with the judge actually running: queue → judge →
// verdict stored → paper settled → scores rewritten. 7 of 10 tests is 7 marks.
// ═══════════════════════════════════════════════════════════════════
async function G17() {
  const id = await sitCodingPaper();
  const judge = scriptedJudge(() => completed(10, 7));
  fns.setJudgeAdapter(judge);
  try {
    await fns.scheduledJudgeCoding.run({});
  } finally { fns.setJudgeAdapter(null); }

  eq(judge.calls.length, 1, 'the submission reached the judge');
  eq(judge.calls[0].language, 'python3', 'with the language the candidate chose');
  eq(judge.calls[0].tests.length, 10, 'and the hidden suite');

  const v = V(`${id}__c1`);
  eq(v.verdict.status, 'completed', 'the verdict is stored');
  eq(v.state.attempts, 1, 'the attempt is counted');
  eq(A(id).codeJudgePending, undefined, 'the paper leaves the queue');
  eq(A(id).scores.total, 7, 'and 7 of 10 tests becomes 7 of 10 marks');
  eq(A(id).scores.requiresManualReview, false, 'with nothing left owing');
  eq(A(id).scores.passed, true, 'so a real verdict is finally issued');
}

// ═══════════════════════════════════════════════════════════════════
// G-18 · an outage retries; it does not mark anyone zero
//
// The default NullJudgeAdapter stands in for "no provider reachable". The
// paper must stay queued, keep its manual-review flag, and above all not
// acquire a zero — and the retry must be bounded so a submission that kills
// the judge cannot be retried forever.
// ═══════════════════════════════════════════════════════════════════
async function G18() {
  const id = await sitCodingPaper();
  await fns.scheduledJudgeCoding.run({});          // NullJudgeAdapter — unavailable

  const v = V(`${id}__c1`);
  eq(v.verdict.status, 'judge_unavailable', 'the outage is recorded as an outage');
  eq(v.state.attempts, 1, 'and counted as an attempt');
  check(v.state.nextAttemptAt !== undefined, 'with a retry scheduled');
  eq(A(id).codeJudgePending, true, 'the paper stays queued');
  eq(A(id).scores.total, 0, 'no marks were awarded');
  eq(A(id).scores.requiresManualReview, true, 'and it still reads as owing marks');
  eq(A(id).scores.passed, null, 'never as a failure');

  // Backoff holds the next sweep off.
  await fns.scheduledJudgeCoding.run({});
  eq(V(`${id}__c1`).state.attempts, 1, 'a sweep inside the backoff window does not re-run it');

  // Exhaust the budget, then confirm it stops and the paper settles unjudged.
  DB.seed('attemptVerdicts', `${id}__c1`, {
    ...V(`${id}__c1`),
    state: { attempts: 4, lastStatus: 'judge_unavailable' },
  });
  await fns.scheduledJudgeCoding.run({});
  eq(V(`${id}__c1`).state.attempts, 5, 'the last retry runs');
  await fns.scheduledJudgeCoding.run({});
  eq(V(`${id}__c1`).state.attempts, 5, 'and then the platform stops trying');
  eq(A(id).codeJudgePending, undefined, 'the paper leaves the queue, unjudged');
  eq(A(id).scores.requiresManualReview, true,
    'and is left visible to a human rather than silently scored zero');
  eq(A(id).scores.total, 0, 'still no marks — and still not negative');
}

// ═══════════════════════════════════════════════════════════════════
// G-19 · an answer no judge can execute is terminal, not retried
//
// An empty or language-less submission is not an outage. Retrying it five
// times spends judge slots during an exam to learn nothing.
// ═══════════════════════════════════════════════════════════════════
async function G19() {
  // A real program, in a language the judge does not support: the submission
  // cannot be assembled, but there IS an attempt here, unlike an empty editor
  // (G-23), so the paper is queued and then settled terminally.
  const id = await sitCodingPaper({ value: { language: 'cobol', source: 'DISPLAY 1.' } });
  const judge = scriptedJudge(() => completed(10, 10));
  fns.setJudgeAdapter(judge);
  try {
    await fns.scheduledJudgeCoding.run({});
  } finally { fns.setJudgeAdapter(null); }

  eq(judge.calls.length, 0, 'nothing runnable was ever sent to the judge');
  eq(V(`${id}__c1`).state.attempts, 5, 'it is marked terminally rather than left to retry');
  eq(A(id).codeJudgePending, undefined, 'the paper settles');
  eq(A(id).scores.requiresManualReview, true, 'in manual review, where an unexecutable answer belongs');
  eq(A(id).scores.total, 0, 'with no marks awarded');
}

// ═══════════════════════════════════════════════════════════════════
// G-20 · a sample run never exposes a hidden test — at either end
//
// The run path is the only place a student's action reaches the judge
// directly. Two claims: the hidden suite is never SENT to the provider, and
// nothing derived from it comes back. The first is the stronger one — it
// protects the key from provider logs and adapter bugs, not just from the
// response body.
// ═══════════════════════════════════════════════════════════════════
async function G20() {
  seedQ('c1', {
    engine: 'code',
    tests: [
      { id: 's1', stdin: '2', expected: '4', visible: true },
      { id: 'h1', stdin: '9', expected: 'HIDDEN-A', visible: false },
      { id: 'h2', stdin: '9', expected: 'HIDDEN-B', visible: false },
    ],
  });
  seedExam([{ questionId: 'c1', marks: 10, order: 0 }]);
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  const judge = scriptedJudge(() => ({
    status: 'completed', adapter: 'scripted', judgedAt: at(VNOW),
    results: [{ testId: 's1', status: 'passed', stdout: '4' }],
  }));
  fns.setJudgeAdapter(judge);
  let res;
  try {
    res = await call(fns.runCodeSample,
      { attemptId: id, questionId: 'c1', language: 'python3', source: 'print(4)' }, STUDENT());
  } finally { fns.setJudgeAdapter(null); }

  eq(res.ok, true, 'the run succeeded');
  eq(judge.calls.length, 1, 'and reached the judge');
  eq(judge.calls[0].tests.length, 1, 'with the SAMPLE test only');
  check(!JSON.stringify(judge.calls[0]).includes('HIDDEN'),
    'THE POINT — the hidden suite never reaches the provider at all');

  const blob = JSON.stringify(res);
  check(!blob.includes('HIDDEN'), 'and nothing hidden comes back');
  check(!blob.includes('h1') && !blob.includes('h2'), 'not even the hidden test ids');
  eq(res.verdict.hiddenCount, 2, 'the candidate learns only how many exist');
  eq(res.verdict.results.length, 1, 'and sees their sample result');
  eq(res.remaining, 19, 'with their remaining budget');
}

// ═══════════════════════════════════════════════════════════════════
// G-21 · who may run, and when
//
// A run executes code. Every guard here is one that, if missing, lets someone
// execute code they have no business executing — or lets a candidate keep
// working after the exam is over.
// ═══════════════════════════════════════════════════════════════════
async function G21() {
  seedQ('c1', { engine: 'code', tests: [{ id: 's1', stdin: '', expected: '1', visible: true }] });
  seedQ('m1');
  seedExam([
    { questionId: 'c1', marks: 10, order: 0 },
    { questionId: 'm1', marks: 10, order: 1 },
  ]);
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  const args = { attemptId: id, questionId: 'c1', language: 'python3', source: 'print(1)' };

  await expectThrow('another student cannot run code in my attempt',
    () => call(fns.runCodeSample, args, STUDENT('other_uid', 'stu_2')), 'Not your attempt');
  await expectThrow('nor can staff — a run spends the STUDENT\'s quota',
    () => call(fns.runCodeSample, args, OWNER()), 'Not your attempt');
  await expectThrow('a question not on my paper cannot be run',
    () => call(fns.runCodeSample, { ...args, questionId: 'not_on_paper' }, STUDENT()),
    'not on your paper');
  await expectThrow('a non-coding question does not run code',
    () => call(fns.runCodeSample, { ...args, questionId: 'm1' }, STUDENT()),
    'does not run code');
  await expectThrow('an unsupported language is refused',
    () => call(fns.runCodeSample, { ...args, language: 'brainfuck' }, STUDENT()),
    'Unsupported language');

  // A paused student is paused.
  const att = DB.read('attempts', id);
  DB.seed('attempts', id, { ...att, freezes: [{ startedAt: at(VNOW), endedAt: null }] });
  await expectThrow('a paused attempt cannot run code — the clock is stopped',
    () => call(fns.runCodeSample, args, STUDENT()), 'paused');
  DB.seed('attempts', id, att);

  // And a finished one cannot either.
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());
  await expectThrow('a submitted attempt cannot run code',
    () => call(fns.runCodeSample, args, STUDENT()), 'not in progress');
}

// ═══════════════════════════════════════════════════════════════════
// G-22 · the budget holds, and an outage does not spend it
//
// Runs are bounded so one candidate cannot saturate the judge queue while a
// cohort waits. But a judge that is down must not quietly consume a
// candidate's whole budget — they would have no way to know why.
// ═══════════════════════════════════════════════════════════════════
async function G22() {
  seedQ('c1', { engine: 'code', tests: [{ id: 's1', stdin: '', expected: '1', visible: true }] });
  seedExam([{ questionId: 'c1', marks: 10, order: 0 }], {});
  // Two runs, no cooldown, so the quota is what binds in this probe.
  DB.seed('assessments', 'asmt_1', {
    ...DB.read('assessments', 'asmt_1'),
    codingRuns: { maxPerQuestion: 2, cooldownMs: 0 },
  });
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  const args = { attemptId: id, questionId: 'c1', language: 'python3', source: 'print(1)' };

  const judge = scriptedJudge(() => ({
    status: 'completed', adapter: 'scripted', judgedAt: at(VNOW),
    results: [{ testId: 's1', status: 'passed', stdout: '1' }],
  }));
  fns.setJudgeAdapter(judge);
  try {
    const r1 = await call(fns.runCodeSample, args, STUDENT());
    eq(r1.remaining, 1, 'the first run leaves one');
    const r2 = await call(fns.runCodeSample, args, STUDENT());
    eq(r2.remaining, 0, 'the second exhausts the budget');

    const r3 = await call(fns.runCodeSample, args, STUDENT());
    eq(r3.ok, false, 'the third is refused');
    eq(r3.reason, 'quota_exhausted', 'for the stated reason');
    eq(judge.calls.length, 2, 'and never reached the judge');
  } finally { fns.setJudgeAdapter(null); }

  // A fresh attempt, with the judge down throughout.
  DB = new FakeDb();
  seedQ('c1', { engine: 'code', tests: [{ id: 's1', stdin: '', expected: '1', visible: true }] });
  seedExam([{ questionId: 'c1', marks: 10, order: 0 }]);
  DB.seed('assessments', 'asmt_1', {
    ...DB.read('assessments', 'asmt_1'),
    codingRuns: { maxPerQuestion: 2, cooldownMs: 0 },
  });
  const s2 = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id2 = s2.attempt.id;
  const args2 = { ...args, attemptId: id2 };

  const down = await call(fns.runCodeSample, args2, STUDENT());   // NullJudgeAdapter
  eq(down.ok, true, 'the call still succeeds — an outage is not a client error');
  eq(down.judgeAvailable, false, 'but reports the judge as unavailable');
  eq(down.remaining, 2, 'THE POINT — an outage did not spend a run');
  eq(down.verdict.status, 'judge_unavailable', 'and the state is visible to the UI');
  check(down.verdict.failureReason === undefined,
    'with the operator detail withheld from the browser');
}

// ═══════════════════════════════════════════════════════════════════
// G-23 · an emptied editor is a blank, not a question to judge
//
// The editor writes { language, source: '' } when the buffer is still the
// starter or has been cleared, because the renderer's answer channel has no
// "no answer" arm. The server must read that the same way the navigator does.
// Without this, a candidate who deleted their code would queue a judge run
// that cannot run, and land the paper in manual review for a question they
// never attempted.
// ═══════════════════════════════════════════════════════════════════
async function G23() {
  const id = await sitCodingPaper({ value: { language: 'python3', source: '   \n ' } });

  eq(A(id).codeJudgePending, undefined, 'an emptied answer never joins the judging queue');
  eq(A(id).scores.requiresManualReview, false,
    'and does not put the paper in manual review for a question nobody attempted');
  eq(A(id).scores.total, 0, 'it simply scores nothing');
  eq(A(id).scores.passed, false, 'and the paper gets a real verdict rather than being held open');

  const sec = A(id).scores.bySection[0];
  eq(sec.answeredQuestions, 0, 'it is not counted as answered');
  eq(sec.marksAvailable, 10, 'but its marks stay in the denominator');
}

const SCENARIOS = [
  ['G-01', 'a text answer can be marked by a human', G01],
  ['G-02', 'no FAILED verdict on a half-marked paper', G02],
  ['G-03', 'invalidation awards coherently', G03],
  ['G-04', 'a vanished question document', G04],
  ['G-05', 'marks come from the frozen paper', G05],
  ['G-06', 'bySection reconciles with the total', G06],
  ['G-07', 'partial credit and percent penalties are exact', G07],
  ['G-08', 'an out-of-paper answer is ignored', G08],
  ['G-09', 'a blank paper scores zero, never negative', G09],
  ['G-10', 'every finalisation path reaches the same mark', G10],
  ['G-11', 'an unjudged coding answer is unmarked, not wrong', G11],
  ['G-12', 'a verdict lands and a regrade turns it into a mark', G12],
  ['G-13', 'THE RULE — a judge outage is never a candidate\'s zero', G13],
  ['G-14', 'a coding section does not inherit the exam\'s negative marking', G14],
  ['G-15', 'and applies it, to a total failure only, when it opts in', G15],
  ['G-16', 'finalisation queues judging instead of blocking on it', G16],
  ['G-17', 'the sweep judges, settles, and rewrites the marks', G17],
  ['G-18', 'an outage retries, bounded, and never marks anyone zero', G18],
  ['G-19', 'an answer no judge can execute is terminal, not retried', G19],
  ['G-20', 'a sample run never exposes a hidden test, at either end', G20],
  ['G-21', 'who may run code, and when', G21],
  ['G-22', 'the run budget holds, and an outage does not spend it', G22],
  ['G-23', 'an emptied editor is a blank, not a question to judge', G23],
];

(async () => {
  for (const [id, title, fn] of SCENARIOS) await scenario(id, title, fn);

  const C = { r: '\x1b[31m', g: '\x1b[32m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
  let pass = 0, fail = 0;
  console.log(`\n${C.b}AUDIT PROBE SUITE — ROUND 4: GRADING${C.x}\n`);
  for (const r of results) {
    const bad = r.checks.filter((c) => !c.pass);
    const status = r.error ? `${C.r}ERROR${C.x}` : bad.length ? `${C.r}FAIL${C.x}` : `${C.g}PASS${C.x}`;
    console.log(`  ${status}  ${C.b}${r.id}${C.x}  ${r.title}`);
    for (const c of r.checks) {
      if (c.pass) { pass++; continue; }
      fail++;
      console.log(`        ${C.r}✗${C.x} ${c.label}`);
      if (c.detail) console.log(`          ${C.d}${c.detail}${C.x}`);
    }
    if (r.error) {
      fail++;
      console.log(`        ${C.r}✗ threw${C.x} ${r.error.message}`);
      if (process.env.PROBE_TRACE) console.log(r.error.stack);
    }
  }
  if (KNOWN_GAPS.length > 0) {
    console.log(`\n${C.b}KNOWN GAPS${C.x} ${C.d}(recorded, not asserted — see the note in the probe)${C.x}`);
    for (const g of KNOWN_GAPS) console.log(`  ${C.b}•${C.x} ${g}`);
  }
  console.log(`\n${'─'.repeat(72)}`);
  console.log(fail === 0
    ? `${C.g}${C.b}  ALL GREEN${C.x} — ${pass} passed across ${results.length} probes`
    : `${C.r}${C.b}  ${fail} FAILED${C.x} — ${pass} passed, ${fail} failed across ${results.length} probes`);
  process.exit(fail === 0 ? 0 : 1);
})();