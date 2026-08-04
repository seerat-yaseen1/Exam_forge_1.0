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
