// ═══════════════════════════════════════════════════════════════════════════
// MANUAL MARKING SUITE  (2026-08-13)
//
// Round 4 (audit.grading.cjs, probe G-01) recorded a gap rather than asserting
// one: there was no path anywhere by which a human could put a mark on an essay
// answer, so a paper carrying one could be sat and scored but never finished.
// setManualMark is that path. This suite is the pressure on it.
//
// The probes are grouped by what they defend:
//
//   M-01..M-04  the mark itself — award, arithmetic, clamping, withdrawal
//   M-05..M-08  who may mark, what may be marked, and when
//   M-09..M-12  SURVIVAL — the property everything else rests on: a human's
//               mark is an INPUT to scoring, so every path that re-derives a
//               paper must carry it through rather than score over it
//   M-13..M-14  what reaches the student, and what does not
//
// M-09 is the one to read first. Marking is stored in its own collection and
// re-applied by the shared scorer precisely so that a regrade, a late judge
// verdict, or the expiry sweep cannot silently delete a person's work. Each of
// those three has its own probe here because each is a separate call site, and
// a call site that forgets the parameter is exactly how the property breaks.
//
//   node test/manual.grading.cjs
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

process.env.GCLOUD_PROJECT = 'demo-manual-grading';
const adminFs = require('firebase-admin/firestore');
let DB = new FakeDb();
adminFs.getFirestore = () => DB;
require('firebase-admin/app').initializeApp = () => ({});

const fns = require('../lib/index.js');

const results = [];
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

const OWNER    = (uid = 'wo_1') => ({ uid, token: { role: 'webOwner' } });
const FACULTY  = (uid = 'fac_1', instituteId = 'inst_1') =>
  ({ uid, token: { role: 'faculty', facultyId: 'fac_1', instituteId } });
const INSTITUTE = (uid = 'ia_1', instituteId = 'inst_1') =>
  ({ uid, token: { role: 'institute', instituteId } });
const STUDENT  = (uid = 'stu_uid', studentId = 'stu_1', instituteId = 'inst_1') =>
  ({ uid, token: { role: 'student', studentId, instituteId } });

const A    = (id) => DB.read('attempts', id);
const MARK = (attemptId, qid) => DB.read('attemptManualMarks', `${attemptId}__${qid}`);

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
function seedVerdict(attemptId, qid, verdict) {
  DB.seed('attemptVerdicts', `${attemptId}__${qid}`, {
    attemptId, questionId: qid, instituteId: 'inst_1', verdict,
  });
}

function seedExam(questions, o = {}) {
  DB.seed('students', 'stu_1', { id: 'stu_1', name: 'S', instituteId: 'inst_1' });
  DB.seed('assessments', 'asmt_1', {
    id: 'asmt_1', title: 'Marking Paper', instituteId: 'inst_1',
    ownerType: 'webOwner', ownerId: 'webOwner',
    status: 'active',
    startDate: at(VNOW - min(60)), endDate: at(VNOW + min(600)),
    maxAttempts: o.maxAttempts ?? 1, overallTimeLimit: 120,
    deliveryMode: 'standard', sectionStartOrder: 'sequential',
    securityTier: 'mock', requireCamera: false, allowMobile: true,
    requireExtensionCheck: false, requireSEB: false,
    securityLockedAt: at(VNOW - min(120)),
    passingScore: o.passingScore ?? 50,
    assignedTo: { type: 'all' },
    allowReview: o.allowReview ?? true,
    showResults: o.showResults ?? true,
    ...(o.showResultsTo ? { showResultsTo: o.showResultsTo } : {}),
    ...(o.allowReviewTo  ? { allowReviewTo:  o.allowReviewTo  } : {}),
    gradingConfig: o.gradingConfig,
    sections: o.sections ?? [{ id: 'SA', name: 'A', timeLimit: 60, questions }],
  });
}

/** One MCQ (50) + one essay (50), sat and finalised. Returns the attempt id. */
async function sitEssayPaper(o = {}) {
  seedQ('t1', { engine: 'text', modelAnswer: 'a model answer' });
  seedQ('m1');
  seedExam([
    { questionId: 'm1', marks: 50, order: 0 },
    { questionId: 't1', marks: 50, order: 1 },
  ], o);
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  advance(min(1));
  answer(id, 'm1', 'alpha', 'SA');
  answer(id, 't1', 'My essay answer.', 'SA', 'text');
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());
  return id;
}

// ═══════════════════════════════════════════════════════════════════
// M-01 · the award lands, and the paper finishes
// ═══════════════════════════════════════════════════════════════════
async function M01() {
  const id = await sitEssayPaper();

  eq(A(id).scores.requiresManualReview, true, 'before marking: the paper is flagged');
  eq(A(id).scores.passed, null, 'before marking: no verdict is issued');
  eq(A(id).scores.total, 50, 'before marking: only the machine half is awarded');

  const res = await call(fns.setManualMark,
    { attemptId: id, questionId: 't1', marks: 35 }, OWNER());

  eq(res.ok, true, 'the callable reports success');
  eq(res.scores.total, 85, 'and returns the fresh total');
  eq(A(id).scores.total, 85, 'the attempt carries the new total');
  eq(A(id).scores.requiresManualReview, false, 'the flag clears');
  eq(A(id).scores.passed, true, 'and a real pass/fail verdict is issued');
  eq(A(id).scores.percentage, 85, 'the percentage follows the total');
  eq(A(id).gradedAnswers.t1.marksAwarded, 35, 'the answer records its award');
  eq(A(id).gradedAnswers.t1.isCorrect, false, 'a partial award is not "correct"');
  eq(A(id).gradedAnswers.t1.manuallyMarked, true, 'and is flagged as hand-marked');

  // bySection must stay reconciled — the invariant G-06 holds for the scorer.
  const sec = A(id).scores.bySection.find((s) => s.sectionId === 'SA');
  eq(sec.marksAwarded, 85, 'the section total reconciles with the paper total');
}

// ═══════════════════════════════════════════════════════════════════
// M-02 · full marks reads as correct, zero reads as wrong
//
// The scorer sets a BOOLEAN isCorrect on a hand mark rather than leaving it
// null, because null is what every reader uses to mean "not marked yet". This
// is what lets a marked essay render as an ordinary question everywhere
// without a single reader learning about manual marking.
// ═══════════════════════════════════════════════════════════════════
async function M02() {
  const id = await sitEssayPaper();

  await call(fns.setManualMark, { attemptId: id, questionId: 't1', marks: 50 }, OWNER());
  eq(A(id).gradedAnswers.t1.isCorrect, true, 'full marks reads as correct');
  eq(A(id).scores.total, 100, 'and the total is the whole paper');

  await call(fns.setManualMark, { attemptId: id, questionId: 't1', marks: 0 }, OWNER());
  eq(A(id).gradedAnswers.t1.isCorrect, false, 'zero reads as wrong');
  eq(A(id).gradedAnswers.t1.marksAwarded, 0, 'with nothing awarded');
  eq(A(id).scores.requiresManualReview, false,
    'and a deliberate zero still counts as marked — it is not "unmarked"');
  eq(A(id).scores.passed, true, 'the verdict comes from the machine half (50% = pass mark)');
}

// ═══════════════════════════════════════════════════════════════════
// M-03 · the award is bounded, and cannot corrupt the arithmetic
// ═══════════════════════════════════════════════════════════════════
async function M03() {
  const id = await sitEssayPaper();

  await call(fns.setManualMark, { attemptId: id, questionId: 't1', marks: 9999 }, OWNER());
  eq(MARK(id, 't1').marksAwarded, 50, 'an over-ceiling award is clamped to the question marks');
  eq(A(id).scores.total, 100, 'so the total can never exceed the paper');

  await call(fns.setManualMark, { attemptId: id, questionId: 't1', marks: -25 }, OWNER());
  eq(MARK(id, 't1').marksAwarded, 0, 'a negative award is floored at zero');
  eq(A(id).scores.total, 50, 'a grader cannot invent a penalty the policy did not set');

  await call(fns.setManualMark, { attemptId: id, questionId: 't1', marks: 7.3333333 }, OWNER());
  eq(MARK(id, 't1').marksAwarded, 7.33, 'awards are rounded to two decimals');

  await expectThrow('a non-numeric award is refused',
    () => call(fns.setManualMark, { attemptId: id, questionId: 't1', marks: 'lots' }, OWNER()),
    'marks must be a number');
  await expectThrow('NaN is refused',
    () => call(fns.setManualMark, { attemptId: id, questionId: 't1', marks: NaN }, OWNER()),
    'marks must be a number');
  await expectThrow('an oversized note is refused',
    () => call(fns.setManualMark,
      { attemptId: id, questionId: 't1', marks: 10, feedback: 'x'.repeat(4001) }, OWNER()),
    '4000 characters');
}

// ═══════════════════════════════════════════════════════════════════
// M-04 · a mark can be withdrawn, and withdrawal is not a zero
// ═══════════════════════════════════════════════════════════════════
async function M04() {
  const id = await sitEssayPaper();

  await call(fns.setManualMark, { attemptId: id, questionId: 't1', marks: 40 }, OWNER());
  eq(A(id).scores.requiresManualReview, false, 'marked: the paper is finished');

  await call(fns.setManualMark, { attemptId: id, questionId: 't1', marks: null }, OWNER());
  check(MARK(id, 't1') === undefined, 'the mark record is deleted, not zeroed');
  eq(A(id).scores.requiresManualReview, true, 'the answer returns to the marking queue');
  eq(A(id).scores.total, 50, 'and its marks leave the total');
  eq(A(id).scores.passed, null, 'so the verdict is withdrawn with it');
  eq(A(id).gradedAnswers.t1.isCorrect, null, 'the answer reads as unmarked again');
  check(A(id).gradedAnswers.t1.manuallyMarked === undefined,
    'and carries no trace of the withdrawn mark');
}

// ═══════════════════════════════════════════════════════════════════
// M-05 · who may mark
// ═══════════════════════════════════════════════════════════════════
async function M05() {
  const id = await sitEssayPaper();

  await expectThrow('a student may not mark their own paper',
    () => call(fns.setManualMark, { attemptId: id, questionId: 't1', marks: 50 }, STUDENT()),
    'Only graders');
  await expectThrow('staff of another institute may not mark it',
    () => call(fns.setManualMark, { attemptId: id, questionId: 't1', marks: 50 },
      FACULTY('fac_x', 'inst_OTHER')),
    'Only graders');
  await expectThrow('an unauthenticated caller may not mark it',
    () => call(fns.setManualMark, { attemptId: id, questionId: 't1', marks: 50 }, null),
    'Sign-in required');

  await call(fns.setManualMark, { attemptId: id, questionId: 't1', marks: 10 }, FACULTY());
  eq(A(id).scores.total, 60, 'faculty of the owning institute may mark');

  await call(fns.setManualMark, { attemptId: id, questionId: 't1', marks: 20 }, INSTITUTE());
  eq(A(id).scores.total, 70, 'so may the institute admin');

  await call(fns.setManualMark, { attemptId: id, questionId: 't1', marks: 30 }, OWNER());
  eq(A(id).scores.total, 80, 'and so may the web owner');
}

// ═══════════════════════════════════════════════════════════════════
// M-06 · when a paper may be marked
// ═══════════════════════════════════════════════════════════════════
async function M06() {
  seedQ('t1', { engine: 'text' });
  seedQ('m1');
  seedExam([
    { questionId: 'm1', marks: 50, order: 0 },
    { questionId: 't1', marks: 50, order: 1 },
  ]);
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  advance(min(1));
  answer(id, 't1', 'Half-written…', 'SA', 'text');

  await expectThrow('a live sitting cannot be marked',
    () => call(fns.setManualMark, { attemptId: id, questionId: 't1', marks: 50 }, OWNER()),
    'NOT_FINISHED');

  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());
  await call(fns.setManualMark, { attemptId: id, questionId: 't1', marks: 50 }, OWNER());
  eq(A(id).scores.total, 50, 'once finished, it can');

  // Withdrawn attempts are evidence, not work in progress.
  await call(fns.softDeleteAttempt, { attemptId: id }, OWNER());
  await expectThrow('a withdrawn attempt cannot be marked',
    () => call(fns.setManualMark, { attemptId: id, questionId: 't1', marks: 10 }, OWNER()),
    'DELETED_ATTEMPT');

  await expectThrow('an attempt that does not exist is a not-found',
    () => call(fns.setManualMark, { attemptId: 'nope', questionId: 't1', marks: 10 }, OWNER()),
    'Attempt not found');
}

// ═══════════════════════════════════════════════════════════════════
// M-07 · what may be marked
// ═══════════════════════════════════════════════════════════════════
async function M07() {
  const id = await sitEssayPaper();

  await expectThrow('a machine-marked question is not hand-markable',
    () => call(fns.setManualMark, { attemptId: id, questionId: 'm1', marks: 50 }, OWNER()),
    'NOT_MANUAL');

  await expectThrow('a question that is not on the paper is refused',
    () => call(fns.setManualMark, { attemptId: id, questionId: 'ghost', marks: 50 }, OWNER()),
    'NOT_ON_PAPER');

  await expectThrow('a missing questionId is refused',
    () => call(fns.setManualMark, { attemptId: id, marks: 50 }, OWNER()),
    'questionId is required');
}

// ═══════════════════════════════════════════════════════════════════
// M-08 · a judged coding answer belongs to the judge
//
// Code is hand-markable ONLY while no usable verdict exists — the judge down,
// or out of retries. The moment a verdict lands, that number has one author.
// Two authorities over one mark is how they silently diverge.
// ═══════════════════════════════════════════════════════════════════
async function M08() {
  seedQ('c1', { engine: 'code', tests: suite(4) });
  seedExam([{ questionId: 'c1', marks: 100, order: 0 }]);
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  advance(min(1));
  answer(id, 'c1', { language: 'python', source: 'print(1)' }, 'SA', 'code');
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());

  eq(A(id).scores.requiresManualReview, true, 'an unjudged coding answer awaits a decision');

  // No verdict: the grader is the fallback, and may award.
  await call(fns.setManualMark, { attemptId: id, questionId: 'c1', marks: 60 }, OWNER());
  eq(A(id).scores.total, 60, 'with the judge silent, a human may mark the code');
  eq(A(id).scores.requiresManualReview, false, 'and that finishes the paper');

  // A verdict lands. The judge now owns the number.
  seedVerdict(id, 'c1', completed(4, 2));
  await expectThrow('once judged, the answer refuses a hand mark',
    () => call(fns.setManualMark, { attemptId: id, questionId: 'c1', marks: 95 }, OWNER()),
    'ALREADY_JUDGED');
}

// ═══════════════════════════════════════════════════════════════════
// M-09 · THE RULE — a regrade must not erase a human's marking
//
// The property the whole design rests on. A regrade re-derives every finished
// attempt from scratch; if it re-runs the scorer without the human's marks, it
// deletes a cohort's worth of marking in one call, silently, and pushes every
// essay paper back into review.
// ═══════════════════════════════════════════════════════════════════
async function M09() {
  const id = await sitEssayPaper();
  await call(fns.setManualMark,
    { attemptId: id, questionId: 't1', marks: 42, feedback: 'Solid argument.' }, OWNER());
  eq(A(id).scores.total, 92, 'marked: 50 machine + 42 human');

  await call(fns.regradeAttempts, { assessmentId: 'asmt_1' }, OWNER());

  eq(A(id).scores.total, 92, 'THE RULE — a regrade preserves the human mark');
  eq(A(id).scores.requiresManualReview, false, 'and does not requeue the answer');
  eq(A(id).scores.passed, true, 'so the verdict survives too');
  eq(A(id).gradedAnswers.t1.marksAwarded, 42, 'the per-answer award is re-derived intact');
  eq(A(id).gradedAnswers.t1.feedback, 'Solid argument.', 'and the feedback with it');

  // A regrade that invalidates the essay overrides it with full marks — that
  // is invalidation's whole job, and it must still win over a hand mark.
  await call(fns.regradeAttempts,
    { assessmentId: 'asmt_1', invalidatedQuestionIds: ['t1'] }, OWNER());
  eq(A(id).scores.total, 100, 'an invalidated question still overrides the hand mark');
}

// ═══════════════════════════════════════════════════════════════════
// M-10 · a late judge verdict must not erase it either
//
// A paper can carry both a coding answer and an essay. The judging sweep
// re-scores the paper when the verdict lands; it must carry the essay's mark
// past on its way.
// ═══════════════════════════════════════════════════════════════════
async function M10() {
  seedQ('t1', { engine: 'text' });
  seedQ('c1', { engine: 'code', tests: suite(4) });
  seedExam([
    { questionId: 'c1', marks: 50, order: 0 },
    { questionId: 't1', marks: 50, order: 1 },
  ]);
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  advance(min(1));
  answer(id, 'c1', { language: 'python', source: 'print(1)' }, 'SA', 'code');
  answer(id, 't1', 'An essay.', 'SA', 'text');
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());

  await call(fns.setManualMark, { attemptId: id, questionId: 't1', marks: 45 }, OWNER());
  eq(A(id).scores.total, 45, 'the essay is marked while the code waits on the judge');
  eq(A(id).scores.requiresManualReview, true, 'the paper still awaits the coding verdict');

  // The verdict lands and the rejudge path re-scores the paper.
  seedVerdict(id, 'c1', completed(4, 4));
  await call(fns.rejudgeAttemptCoding, { attemptId: id, questionId: 'c1' }, OWNER());

  eq(A(id).gradedAnswers.t1.marksAwarded, 45, 'THE RULE — the judge does not erase the essay mark');
  eq(A(id).scores.total, 95, 'both marks are present in the total');
  eq(A(id).scores.requiresManualReview, false, 'and the paper is finally complete');
}

// ═══════════════════════════════════════════════════════════════════
// M-11 · marking is against the paper the student sat (B-02)
//
// A grader marking against a paper the student never saw is the same defect
// the regrade path was fixed for, wearing a different hat.
// ═══════════════════════════════════════════════════════════════════
async function M11() {
  const id = await sitEssayPaper();

  // The live paper is edited after the sitting: the essay is now worth 10.
  const live = DB.read('assessments', 'asmt_1');
  live.sections[0].questions = [
    { questionId: 'm1', marks: 50, order: 0 },
    { questionId: 't1', marks: 10, order: 1 },
  ];
  DB.seed('assessments', 'asmt_1', live);

  // The attempt's frozen paper still says 50, and that is the ceiling that
  // must apply — the student sat a 50-mark essay.
  await call(fns.setManualMark, { attemptId: id, questionId: 't1', marks: 50 }, OWNER());
  eq(MARK(id, 't1').marksAwarded, 50,
    'the ceiling comes from the frozen paper, not the edited live one');
  eq(A(id).scores.available, 100, 'and the denominator is the paper they sat');
  eq(A(id).scores.total, 100, 'so full marks is full marks');
}

// ═══════════════════════════════════════════════════════════════════
// M-12 · a paper is finished only when EVERY outstanding answer is marked
// ═══════════════════════════════════════════════════════════════════
async function M12() {
  seedQ('t1', { engine: 'text' });
  seedQ('t2', { engine: 'text' });
  seedExam([
    { questionId: 't1', marks: 50, order: 0 },
    { questionId: 't2', marks: 50, order: 1 },
  ]);
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  advance(min(1));
  answer(id, 't1', 'Essay one.', 'SA', 'text');
  answer(id, 't2', 'Essay two.', 'SA', 'text');
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());

  await call(fns.setManualMark, { attemptId: id, questionId: 't1', marks: 40 }, OWNER());
  eq(A(id).scores.requiresManualReview, true, 'one of two marked: still outstanding');
  eq(A(id).scores.passed, null, 'and still no verdict');
  eq(A(id).scores.total, 40, 'though the mark that was given counts');

  await call(fns.setManualMark, { attemptId: id, questionId: 't2', marks: 30 }, OWNER());
  eq(A(id).scores.requiresManualReview, false, 'both marked: the paper is complete');
  eq(A(id).scores.total, 70, 'with both awards');
  eq(A(id).scores.passed, true, 'and a verdict at last');
}

// ═══════════════════════════════════════════════════════════════════
// M-13 · feedback follows the review gate; the grading record never leaves
// ═══════════════════════════════════════════════════════════════════
async function M13() {
  // Review CLOSED to students: they get the mark, not the prose.
  const closed = await sitEssayPaper({ allowReview: false, allowReviewTo: [] });
  await call(fns.setManualMark,
    { attemptId: closed, questionId: 't1', marks: 30, feedback: 'See me.' }, OWNER());
  eq(A(closed).scores.total, 80, 'the mark reaches the student regardless');
  check(A(closed).gradedAnswers.t1.feedback === undefined,
    'but the note does not, when review is closed to them');
  eq(MARK(closed, 't1').feedback, 'See me.', 'it is still stored for staff');

  // Review OPEN: the note crosses.
  DB = new FakeDb();
  VNOW = Date.parse('2026-08-01T09:00:00.000Z');
  const open = await sitEssayPaper({ allowReview: true, allowReviewTo: ['students'] });
  await call(fns.setManualMark,
    { attemptId: open, questionId: 't1', marks: 30, feedback: 'Well argued.' }, OWNER());
  eq(A(open).gradedAnswers.t1.feedback, 'Well argued.',
    'with review open, the note reaches the student');

  // The grading record itself is never copied onto the attempt.
  const ga = JSON.stringify(A(open).gradedAnswers.t1);
  check(!ga.includes('wo_1'), 'the grader identity never lands on the student-readable doc');
  check(!ga.includes('gradedBy'), 'nor any of the grading record fields');
}

// ═══════════════════════════════════════════════════════════════════
// M-14 · the grading record is an audit trail
// ═══════════════════════════════════════════════════════════════════
async function M14() {
  const id = await sitEssayPaper();

  await call(fns.setManualMark,
    { attemptId: id, questionId: 't1', marks: 20, feedback: '  padded  ' }, FACULTY());
  const first = MARK(id, 't1');
  eq(first.gradedBy, 'fac_1', 'the marker is recorded');
  eq(first.gradedByRole, 'faculty', 'with the role they marked under');
  eq(first.revision, 1, 'the first award is revision 1');
  eq(first.feedback, 'padded', 'and the note is trimmed');
  eq(first.attemptId, id, 'the record names its attempt');
  eq(first.questionId, 't1', 'and its question');
  eq(first.instituteId, 'inst_1', 'and carries the institute for the read rule');

  const firstAt = first.firstGradedAt;
  advance(min(30));

  await call(fns.setManualMark, { attemptId: id, questionId: 't1', marks: 45 }, OWNER());
  const second = MARK(id, 't1');
  eq(second.revision, 2, 're-marking increments the revision');
  eq(second.gradedBy, 'wo_1', 'and records who changed it');
  eq(second.firstGradedAt, firstAt, 'while the original marking time is preserved');
  check(second.gradedAt !== firstAt, 'and the latest marking time moves');
  check(second.feedback === undefined, 'an omitted note clears the previous one');
  eq(A(id).scores.total, 95, 'the re-mark replaces the award rather than adding to it');
}

// ═══════════════════════════════════════════════════════════════════

const SCENARIOS = [
  ['M-01', 'the award lands, and the paper finishes', M01],
  ['M-02', 'full marks reads as correct, zero reads as wrong', M02],
  ['M-03', 'the award is bounded, and cannot corrupt the arithmetic', M03],
  ['M-04', 'a mark can be withdrawn, and withdrawal is not a zero', M04],
  ['M-05', 'who may mark', M05],
  ['M-06', 'when a paper may be marked', M06],
  ['M-07', 'what may be marked', M07],
  ['M-08', 'a judged coding answer belongs to the judge', M08],
  ['M-09', 'THE RULE — a regrade must not erase a human\'s marking', M09],
  ['M-10', 'a late judge verdict must not erase it either', M10],
  ['M-11', 'marking is against the paper the student sat', M11],
  ['M-12', 'a paper is finished only when every answer is marked', M12],
  ['M-13', 'feedback follows the review gate; the record never leaves', M13],
  ['M-14', 'the grading record is an audit trail', M14],
];

(async () => {
  for (const [id, title, fn] of SCENARIOS) await scenario(id, title, fn);

  const C = { r: '\x1b[31m', g: '\x1b[32m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
  let pass = 0, fail = 0;
  console.log(`\n${C.b}MANUAL MARKING SUITE${C.x}\n`);
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
  console.log(`\n${'─'.repeat(72)}`);
  console.log(fail === 0
    ? `${C.g}${C.b}  ALL GREEN${C.x} — ${pass} passed across ${results.length} probes`
    : `${C.r}${C.b}  ${fail} FAILED${C.x} — ${pass} passed, ${fail} failed across ${results.length} probes`);
  process.exit(fail === 0 ? 0 : 1);
})();
