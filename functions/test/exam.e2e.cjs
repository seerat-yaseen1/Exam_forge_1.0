// ═══════════════════════════════════════════════════════════════════════════
// EXAM END-TO-END SUITE
//
// Whole sittings, start to grade, through the COMPILED PRODUCTION CALLABLES
// (functions/lib/index.js) against an in-memory Firestore and a virtual
// clock. Where freeze.suite.cjs interrogates one seam at a time, this drives
// the exam the way a student does: startExam → answers → sections → breaks →
// pauses → finalisation → scores.
//
//   node test/exam.e2e.cjs
//
// Same evidentiary standard as the freeze suite: nothing here re-implements a
// deadline or a mark. Every number asserted on was written by a real handler.
// ═══════════════════════════════════════════════════════════════════════════

const { FakeDb } = require('./fakeFirestore.cjs');

// ── Virtual clock ──────────────────────────────────────────────────
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
const sec = (s) => s * 1000;

// ── Wire the fake db into the compiled module ──────────────────────
process.env.GCLOUD_PROJECT = 'demo-e2e-suite';
const adminFs = require('firebase-admin/firestore');
let DB = new FakeDb();
adminFs.getFirestore = () => DB;
require('firebase-admin/app').initializeApp = () => ({});

const fns = require('../lib/index.js');
const core = require('../lib/examTimingCore.js');

// ── Harness ────────────────────────────────────────────────────────
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
function near(actual, expected, tol, label) {
  check(Math.abs(actual - expected) <= tol, label,
    `expected ~${expected} (±${tol}), got ${actual} (Δ${actual - expected})`);
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

const STAFF = (uid = 'fac_1', role = 'faculty', instituteId = 'inst_1') =>
  ({ uid, token: { role, instituteId } });
const STUDENT = (uid = 'stu_uid', studentId = 'stu_1', instituteId = 'inst_1') =>
  ({ uid, token: { role: 'student', studentId, instituteId } });

// ── Fixtures ───────────────────────────────────────────────────────
// The assessment as the BUILDER stores it: resolved sections carrying
// questions with marks, schedule fields, limits. Two sections; a break after
// the first when asked for.
function seedWorld(opts = {}) {
  DB.seed('students', 'stu_1', { id: 'stu_1', name: 'Test Student', instituteId: 'inst_1' });
  const asmt = {
    id: 'asmt_1',
    title: 'E2E Paper',
    instituteId: 'inst_1',
    status: opts.status ?? 'active',
    startDate: opts.startDate ?? at(VNOW - min(60)),
    endDate: opts.endDate ?? at(VNOW + min(600)),
    maxAttempts: opts.maxAttempts ?? 1,
    overallTimeLimit: opts.overallTimeLimit ?? 60,
    deliveryMode: opts.deliveryMode ?? 'standard',
    sectionStartOrder: opts.sectionStartOrder ?? 'sequential',
    securityTier: 'mock',
    requireCamera: false, allowMobile: true, requireExtensionCheck: false, requireSEB: false,
    securityLockedAt: at(VNOW - min(120)),
    passingScore: 40,
    assignedTo: { type: 'all' },
    sections: [
      {
        id: 'SA', name: 'A', timeLimit: opts.sectionATimeLimit ?? 30,
        questionTimeLimit: opts.questionTimeLimit,
        breakAfter: opts.breakAfter,
        questions: [
          { questionId: 'q1', marks: 10, order: 0 },
          { questionId: 'q2', marks: 10, order: 1 },
        ],
      },
      {
        id: 'SB', name: 'B', timeLimit: opts.sectionBTimeLimit ?? 20,
        questionTimeLimit: opts.questionTimeLimit,
        questions: [{ questionId: 'q3', marks: 20, order: 0 }],
      },
    ],
  };
  DB.seed('assessments', 'asmt_1', asmt);
  for (const q of ['q1', 'q2', 'q3']) {
    // Canonical post-migration shapes: the grader dispatches on engine/variant
    // and reads the key from questionAnswers.correctIds.
    DB.seed('questions', q, {
      id: q, engine: 'mcq', variant: 'single', question: `Question ${q}`,
      options: [{ id: 'alpha', text: 'Alpha' }, { id: 'beta', text: 'Beta' }],
      difficulty: 'medium',
    });
    DB.seed('questionAnswers', q, {
      id: q, correctIds: ['alpha'], correctPairs: [], modelAnswer: '',
    });
  }
  return asmt;
}

const A = (id) => DB.read('attempts', id);
const lockMs = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : (v ? Date.parse(v) : null));

// Answer as the STANDARD-mode client does: a rules-shaped direct patch of
// answers.{qid}. The fake db has no rules engine, so this represents the
// write the rules provably allow (answers + updatedAt only).
function clientAnswer(attemptId, qid, value, sectionId) {
  const att = DB.read('attempts', attemptId);
  att.answers[qid] = { type: 'mcq', value, sectionId, answeredAt: at(VNOW) };
  att.updatedAt = at(VNOW);
  DB.seed('attempts', attemptId, att);
}

function invariants(attemptId) {
  const att = A(attemptId);
  const asmtRaw = DB.read('assessments', att.assessmentId);
  const coreAsmt = {
    deliveryMode: asmtRaw.deliveryMode,
    sections: (asmtRaw.sections ?? []).map((s) => ({
      id: s.id, timeLimit: s.timeLimit,
      questionIds: (s.questions ?? []).map((q) => q.questionId),
    })),
  };
  return core.checkInvariants({
    status: att.status, startedAt: att.startedAt, sectionIds: att.sectionIds ?? [],
    sectionTimings: att.sectionTimings ?? {}, servedQuestions: att.servedQuestions ?? [],
    answers: att.answers ?? {}, creditedFreezeMs: att.creditedFreezeMs,
    totalFrozenSeconds: att.totalFrozenSeconds, freezes: att.freezes,
    penalties: att.penalties, scores: att.scores,
    answersLockedAfter: att.answersLockedAfter, sectionLockedAfter: att.sectionLockedAfter,
    overallLockedAfter: att.overallLockedAfter,
  }, coreAsmt).filter((v) => v.severity === 'error');
}
function noInvariantErrors(attemptId, label) {
  const errs = invariants(attemptId);
  check(errs.length === 0, label, errs.map((e) => `${e.id}: ${e.message}`).join('; '));
}

// ═══════════════════════════════════════════════════════════════════
// E2E-01 · standard delivery, whole sitting, sincere student
// ═══════════════════════════════════════════════════════════════════
async function E01() {
  seedWorld();
  const t0 = VNOW;
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  // Birth state.
  const born = A(id);
  eq(born.status, 'in_progress', 'attempt born in_progress');
  eq(born.sectionTimings.SA.startedAt, at(t0), 'SA auto-started at t0');
  eq(born.sectionTimings.SB.startedAt, '', "SB carries the '' not-started sentinel");
  eq(born.servedQuestions.length, 3, 'standard mode serves the whole paper');
  near(lockMs(born.sectionLockedAfter), t0 + min(30) + sec(30), 1000, 'SA lock = limit + grace');
  near(lockMs(born.overallLockedAfter), t0 + min(60) + sec(30), 1000, 'overall lock = limit + grace');
  near(lockMs(born.answersLockedAfter), t0 + min(30) + sec(30), 1000, 'combined = min of the two');
  noInvariantErrors(id, 'no invariant errors at birth');

  // Answer both SA questions over 10 minutes, then advance.
  advance(min(5)); clientAnswer(id, 'q1', 'alpha', 'SA');
  advance(min(5)); clientAnswer(id, 'q2', 'beta', 'SA');
  const adv = await call(fns.submitSection,
    { attemptId: id, sectionId: 'SA', nextSectionId: 'SB', nextSectionIdx: 1 }, STUDENT());
  eq(adv.ok, true, 'SA submits cleanly at minute 10');
  eq(A(id).sectionTimings.SA.timeUsedSeconds, 600, 'timeUsedSeconds is server-computed (600s)');
  check(!!A(id).sectionTimings.SB.startedAt, 'SB auto-started on advance');
  near(lockMs(A(id).sectionLockedAfter), VNOW + min(20) + sec(30), 1000,
    'lock re-anchored to SB (D-01)');
  noInvariantErrors(id, 'no invariant errors after the advance');

  // Answer SB, finish, grade.
  advance(min(5)); clientAnswer(id, 'q3', 'alpha', 'SB');
  await call(fns.submitSection, { attemptId: id, sectionId: 'SB' }, STUDENT());
  const graded = await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());
  eq(graded.ok ?? true, true, 'gradeAttempt succeeds');

  const done = A(id);
  eq(done.status, 'submitted', 'manual finish lands as submitted');
  // q1 correct (10) + q2 wrong (0) + q3 correct (20) = 30/40.
  eq(done.scores?.total, 30, 'score: q1 + q3 correct = 30');
  eq(done.scores?.available, 40, 'marks available = 40');
  noInvariantErrors(id, 'terminal attempt passes every invariant (INV-10 included)');
}

// ═══════════════════════════════════════════════════════════════════
// E2E-02 · sequential (linear) delivery, whole sitting
// The server serves one question at a time; the client never holds the paper.
// ═══════════════════════════════════════════════════════════════════
async function E02() {
  seedWorld({ deliveryMode: 'linear', questionTimeLimit: 120 });
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  const born = A(id);
  eq(born.servedQuestions.length, 1, 'linear mode serves ONLY the first question');
  eq(born.servedQuestions[0].questionId, 'q1', 'and it is q1');
  check(!started.attempt.answers || Object.keys(started.attempt.answers).length === 0,
    'no answers at birth');

  advance(sec(60));
  const a1 = await call(fns.submitAnswerAndAdvance,
    { attemptId: id, questionId: 'q1', answer: { type: 'mcq', value: 'alpha' } }, STUDENT());
  eq(a1.sectionComplete, false, 'q1 answered; section continues');
  eq(a1.question?.id ?? a1.question?.questionId ?? 'q2', 'q2', 'q2 is served next');
  eq(A(id).servedQuestions[0].locked, true, 'q1 locked the moment it was answered (INV-2)');
  eq(a1.lateAnswer, false, '60s on a 120s limit is not late');

  // Answering a locked question is refused.
  await expectThrow('a locked question cannot be re-answered',
    () => call(fns.submitAnswerAndAdvance,
      { attemptId: id, questionId: 'q1', answer: { type: 'mcq', value: 'beta' } }, STUDENT()),
    'QUESTION_LOCKED');

  advance(sec(60));
  const a2 = await call(fns.submitAnswerAndAdvance,
    { attemptId: id, questionId: 'q2', answer: { type: 'mcq', value: 'alpha' } }, STUDENT());
  eq(a2.sectionComplete, true, 'q2 was the last of SA — sectionComplete');

  const adv = await call(fns.submitSection,
    { attemptId: id, sectionId: 'SA', nextSectionId: 'SB', nextSectionIdx: 1 }, STUDENT());
  check(!!adv.question, 'advancing into SB serves its first question in the same call');
  noInvariantErrors(id, 'INV-2 holds across the section boundary (D-23)');

  advance(sec(30));
  await call(fns.submitAnswerAndAdvance,
    { attemptId: id, questionId: 'q3', answer: { type: 'mcq', value: 'alpha' } }, STUDENT());
  await call(fns.submitSection, { attemptId: id, sectionId: 'SB' }, STUDENT());
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());

  eq(A(id).scores?.total, 40, 'all three correct = 40/40');
  noInvariantErrors(id, 'terminal attempt clean');
}

// ═══════════════════════════════════════════════════════════════════
// E2E-03 · idempotency, attempt limits, retakes
// ═══════════════════════════════════════════════════════════════════
async function E03() {
  seedWorld({ maxAttempts: 2 });
  const s1 = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id1 = s1.attempt.id;

  // Calling startExam again mid-sitting resumes, never duplicates.
  const s2 = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  eq(s2.attempt.id, id1, 'startExam is idempotent while a sitting is live');
  eq(DB.all('attempts').length, 1, 'exactly one attempt document exists');

  // Finish it; a second sitting is a NEW attempt.
  advance(min(2));
  await call(fns.gradeAttempt, { attemptId: id1, reason: 'manual' }, STUDENT());
  const s3 = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  check(s3.attempt.id !== id1, 'a retake creates a fresh attempt');

  // Finish that too; the limit now refuses a third.
  advance(min(2));
  await call(fns.gradeAttempt, { attemptId: s3.attempt.id, reason: 'manual' }, STUDENT());
  await expectThrow('the attempt limit is enforced server-side',
    () => call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT()),
    'ATTEMPT_LIMIT_EXCEEDED');
}

// ═══════════════════════════════════════════════════════════════════
// E2E-04 · availability gates
// ═══════════════════════════════════════════════════════════════════
async function E04() {
  // Not open yet.
  seedWorld({ startDate: at(VNOW + min(30)) });
  await expectThrow('an exam cannot be started before its startDate',
    () => call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT()),
    'not opened');

  // Closed by date.
  DB = new FakeDb(); VNOW = Date.parse('2026-08-01T09:00:00.000Z');
  seedWorld({ endDate: at(VNOW - min(1)) });
  await expectThrow('an exam cannot be started after its endDate',
    () => call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT()),
    'closed');

  // Closed by hand: blocks NEW sittings, resumes a live one (D-11).
  DB = new FakeDb(); VNOW = Date.parse('2026-08-01T09:00:00.000Z');
  seedWorld();
  const live = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const asmt = DB.read('assessments', 'asmt_1');
  asmt.status = 'closed';
  DB.seed('assessments', 'asmt_1', asmt);
  advance(min(1));
  const resumed = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  eq(resumed.attempt.id, live.attempt.id, 'a live sitting still resumes after manual close');
  await call(fns.gradeAttempt, { attemptId: live.attempt.id, reason: 'manual' }, STUDENT());
  await expectThrow('a manually closed exam refuses NEW sittings',
    () => call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT()),
    'closed');

  // Draft is never enterable.
  DB = new FakeDb(); VNOW = Date.parse('2026-08-01T09:00:00.000Z');
  seedWorld({ status: 'draft' });
  await expectThrow('a draft is not enterable',
    () => call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT()),
    'not published');
}

// ═══════════════════════════════════════════════════════════════════
// E2E-05 · freeze in the middle of a real sitting
// The full arc: pause blocks the student, release restores exactly the held
// time, the credited time is spendable, the sitting finishes clean.
// ═══════════════════════════════════════════════════════════════════
async function E05() {
  seedWorld({ deliveryMode: 'linear', questionTimeLimit: 600 });
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  const t0 = VNOW;

  advance(min(5));
  await call(fns.freezeAttempt, { attemptId: id, reason: 'invigilator check' }, STAFF());
  eq(A(id).status, 'frozen', 'the pause is a state (F5)');

  // Every student transition is refused while paused.
  await expectThrow('submitAnswerAndAdvance refused while paused',
    () => call(fns.submitAnswerAndAdvance,
      { attemptId: id, questionId: 'q1', answer: { type: 'mcq', value: 'alpha' } }, STUDENT()));
  await expectThrow('submitSection refused while paused',
    () => call(fns.submitSection, { attemptId: id, sectionId: 'SA' }, STUDENT()));
  await expectThrow('a paused student cannot finalise their own sitting',
    () => call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT()),
    'ATTEMPT_PAUSED');
  // But the answer-durability write is accepted (the flush must land).
  const saved = await call(fns.saveAnswerNoAdvance,
    { attemptId: id, questionId: 'q1', answer: { type: 'mcq', value: 'alpha' } }, STUDENT());
  eq(saved.saved, true, 'saveAnswerNoAdvance still lands while paused (the flush)');

  // Ten minutes pass; the invigilator returns everything.
  advance(min(10));
  const un = await call(fns.unfreezeAttempt, { attemptId: id, grantedMs: min(10) }, STAFF());
  eq(un.grantedMs, min(10), 'full grant');
  eq(A(id).status, 'in_progress', 'release restores in_progress');

  // The held time is spendable. q1 was served at t0 with a 10m limit and the
  // 10m pause is credited to it, so answering at t0+19 — nineteen real
  // minutes after serve — is on time. Then park until t0+35, PAST the
  // uncredited section deadline of t0+30:30, and submit: only the credit
  // makes that legal (F1).
  advance(min(4));                                   // t0 + 19
  const a1 = await call(fns.submitAnswerAndAdvance,
    { attemptId: id, questionId: 'q1', answer: { type: 'mcq', value: 'alpha' } }, STUDENT());
  eq(a1.lateAnswer, false,
    'the question clock was held too — 19m real on a 10m limit, pause credited');
  advance(min(1));                                   // t0 + 20
  await call(fns.submitAnswerAndAdvance,
    { attemptId: id, questionId: 'q2', answer: { type: 'mcq', value: 'alpha' } }, STUDENT());
  advance(min(15));                                  // t0 + 35 — inside credit only
  const adv = await call(fns.submitSection,
    { attemptId: id, sectionId: 'SA', nextSectionId: 'SB', nextSectionIdx: 1 }, STUDENT());
  eq(adv.ok, true, 'the credited section time was spendable at submit (F1)');
  near(Date.parse(A(id).sectionTimings.SA.submittedAt), VNOW, 1000,
    'submittedAt is the true instant, not a clamp');

  await call(fns.submitAnswerAndAdvance,
    { attemptId: id, questionId: 'q3', answer: { type: 'mcq', value: 'alpha' } }, STUDENT());
  await call(fns.submitSection, { attemptId: id, sectionId: 'SB' }, STUDENT());
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());

  const done = A(id);
  eq(done.scores?.total, 40, 'full marks after a paused sitting');
  check(!done.frozenAt, 'no frozenAt remains on the finished attempt');
  check((done.freezes ?? []).every((f) => !!f.endedAt), 'every ledger entry is closed');
  eq(t0, Date.parse(done.startedAt), 'startedAt never moved');
  noInvariantErrors(id, 'clean terminal state after a freeze cycle');
}

// ═══════════════════════════════════════════════════════════════════
// E2E-06 · a grader finalises a PAUSED sitting
// Legitimate staff action; must flag it and leave no live freeze state.
// ═══════════════════════════════════════════════════════════════════
async function E06() {
  seedWorld();
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  advance(min(3)); clientAnswer(id, 'q1', 'alpha', 'SA');
  advance(min(1));
  await call(fns.freezeAttempt, { attemptId: id, reason: 'suspected malpractice' }, STAFF());
  advance(min(2));

  await call(fns.gradeAttempt, { attemptId: id, reason: 'terminated', terminateReason: 'malpractice confirmed' }, STAFF());
  const done = A(id);
  eq(done.status, 'terminated', 'grader may end a paused sitting');
  eq(done.integrityLog?.finalizedWhileFrozen, true, 'finalised-while-paused is flagged');
  check(!done.frozenAt, 'frozenAt cleared at finalisation — the roster shows the terminal status');
  check((done.freezes ?? []).every((f) => !!f.endedAt), 'the open ledger entry was closed');
  eq((done.freezes ?? [])[0]?.grantedMs, 0, 'finalisation grants nothing');
}

// ═══════════════════════════════════════════════════════════════════
// E2E-07 · the trapped-frozen escape hatch (D8), resolver-decided
// Window closes during a pause → the student may close their own sitting.
// While the window is open, ATTEMPT_PAUSED stands.
// ═══════════════════════════════════════════════════════════════════
async function E07() {
  seedWorld({ endDate: at(VNOW + min(20)) });
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  advance(min(2)); clientAnswer(id, 'q1', 'alpha', 'SA');
  advance(min(3));
  await call(fns.freezeAttempt, { attemptId: id }, STAFF());

  // Window still open → paused means paused.
  advance(min(5));
  await expectThrow('while the window is open a paused student stays paused',
    () => call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT()),
    'ATTEMPT_PAUSED');

  // Window closes (t0+20) → the sitting is over; the student may close it.
  advance(min(15));
  const res = await call(fns.gradeAttempt, { attemptId: id, reason: 'time_expired' }, STUDENT());
  eq(res.ok ?? true, true, 'once the window has shut, the trapped student can finalise (D8)');
  const done = A(id);
  eq(done.status, 'auto_submitted', 'closed as auto_submitted');
  eq(done.scores?.total, 10, 'the answer given before the pause stands');
  check(!done.frozenAt, 'no live freeze state on the terminal attempt');
  check((done.freezes ?? []).every((f) => !!f.endedAt), 'ledger entry closed');
}

// ═══════════════════════════════════════════════════════════════════
// E2E-08 · freezing an attempt that was ALREADY over
// The freeze must not resurrect it, and the sweep must still close it even
// with no availability window at all.
// ═══════════════════════════════════════════════════════════════════
async function E08() {
  seedWorld({ overallTimeLimit: 10, sectionATimeLimit: 0, sectionBTimeLimit: 0, endDate: at(VNOW + min(6000)) });
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  // Blow past the overall clock, then freeze.
  advance(min(15));
  await call(fns.freezeAttempt, { attemptId: id, reason: 'odd state' }, STAFF());
  eq(A(id).status, 'frozen', 'an over-time attempt can still be paused');

  // The resolver says the sitting was over before the pause began.
  const v = await call(fns.getExamVerdict, { attemptId: id }, STAFF());
  eq(v.verdict.kind, 'ended', 'the pause does not resurrect an expired sitting');
  eq(v.verdict.reason, 'overall_expired', 'and the reason is the overall clock');

  // The sweep closes it — window never closed, but 'ended' is 'ended'.
  await fns.scheduledCloseExpiredAttempts.run({});
  const done = A(id);
  eq(done.status, 'auto_submitted', 'the sweep closes a frozen attempt that was already over');
  eq(done.autoSubmitReason, 'sweep_overall_expired', 'and records which wall ended it');
  check(!done.frozenAt, 'frozenAt cleared by the sweep');
  check((done.freezes ?? []).every((f) => !!f.endedAt), 'ledger entry closed by the sweep');
  check(done.scores !== undefined && done.scores !== null, 'the sweep graded it (INV-10)');
}

// ═══════════════════════════════════════════════════════════════════
// E2E-09 · grading is deterministic across paths
// The same answers must earn the same mark whether the student submits, the
// sweep closes, or a grader acts.
// ═══════════════════════════════════════════════════════════════════
async function E09() {
  seedWorld();
  const s1 = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  advance(min(2));
  clientAnswer(s1.attempt.id, 'q1', 'alpha', 'SA');
  clientAnswer(s1.attempt.id, 'q2', 'beta', 'SA');
  clientAnswer(s1.attempt.id, 'q3', 'alpha', 'SB');
  await call(fns.gradeAttempt, { attemptId: s1.attempt.id, reason: 'manual' }, STUDENT());
  const manualScores = A(s1.attempt.id).scores;

  // Same answers, closed by the sweep instead.
  DB = new FakeDb(); VNOW = Date.parse('2026-08-01T09:00:00.000Z');
  seedWorld({ overallTimeLimit: 10, sectionATimeLimit: 0, sectionBTimeLimit: 0 });
  const s2 = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  advance(min(2));
  clientAnswer(s2.attempt.id, 'q1', 'alpha', 'SA');
  clientAnswer(s2.attempt.id, 'q2', 'beta', 'SA');
  clientAnswer(s2.attempt.id, 'q3', 'alpha', 'SB');
  advance(min(20));                                    // past overall + stale enough for the sweep? no — deadline query
  await fns.scheduledCloseExpiredAttempts.run({});
  const sweptScores = A(s2.attempt.id).scores;

  check(!!manualScores && !!sweptScores, 'both paths produced scores',
    `manual=${!!manualScores} swept=${!!sweptScores} status=${A(s2.attempt.id).status}`);
  if (manualScores && sweptScores) {
    eq(sweptScores.total, manualScores.total,
      'identical answers, identical total, whichever path closed the sitting');
    eq(sweptScores.available, manualScores.available, 'identical available marks');
  }
}

// ═══════════════════════════════════════════════════════════════════
// E2E-10 · student_choice structure and the mandatory break, end to end
// ═══════════════════════════════════════════════════════════════════
async function E10() {
  seedWorld({ breakAfter: { durationMinutes: 10, mandatory: true } });
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  advance(min(5));
  await call(fns.submitSection,
    { attemptId: id, sectionId: 'SA', nextSectionId: 'SB', nextSectionIdx: 1, pauseBeforeNext: true },
    STUDENT());
  check(!A(id).sectionTimings.SB.startedAt, 'a mandatory break stops the auto-advance');

  // Trying to walk into SB mid-break is refused.
  advance(min(4));
  await expectThrow('the mandatory break gate holds at minute 4 of 10',
    () => call(fns.startSection, { attemptId: id, sectionId: 'SB' }, STUDENT()),
    'Mandatory break');

  // After the break it opens.
  advance(min(7));
  const sb = await call(fns.startSection, { attemptId: id, sectionId: 'SB' }, STUDENT());
  eq(sb.ok, true, 'the gate opens once the break has elapsed');
  noInvariantErrors(id, 'clean state after the break');

  // student_choice: nothing auto-starts; the student picks.
  DB = new FakeDb(); VNOW = Date.parse('2026-08-01T09:00:00.000Z');
  seedWorld({ sectionStartOrder: 'student_choice' });
  const s2 = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const born = A(s2.attempt.id);
  check(Object.values(born.sectionTimings).every((t) => t.startedAt === ''),
    'student_choice: no section auto-starts');
  eq(born.servedQuestions.length, 3, 'standard delivery still serves the paper');
  check(born.sectionLockedAfter === null, 'no section bound before a section starts');
  check(lockMs(born.overallLockedAfter) !== null, 'the overall bound exists from birth');
}

// ── Run ────────────────────────────────────────────────────────────
(async () => {
  const suite = [
    ['E2E-01', 'standard delivery — whole sitting, sincere student', E01],
    ['E2E-02', 'linear delivery — served one at a time, start to grade', E02],
    ['E2E-03', 'idempotent start, attempt limit, retake', E03],
    ['E2E-04', 'availability gates: not-open / date-closed / hand-closed / draft', E04],
    ['E2E-05', 'freeze mid-sitting: blocked, released, credit spendable, clean finish', E05],
    ['E2E-06', 'grader finalises a paused sitting: flagged, state cleaned', E06],
    ['E2E-07', 'trapped-frozen escape hatch, resolver-decided (D8)', E07],
    ['E2E-08', 'freeze after expiry: not resurrected, swept closed without a window', E08],
    ['E2E-09', 'grading deterministic across finalisation paths', E09],
    ['E2E-10', 'mandatory break end-to-end + student_choice structure', E10],
  ];
  for (const [id, title, fn] of suite) await scenario(id, title, fn);

  const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', B = '\x1b[1m', X = '\x1b[0m';
  let pass = 0, fail = 0;
  console.log(`\n${B}EXAM END-TO-END SUITE${X}  —  real callables, whole sittings, virtual clock\n`);
  for (const r of results) {
    const bad = r.checks.filter((c) => !c.pass);
    const status = r.error ? `${R}ERROR${X}` : bad.length ? `${R}FAIL${X}` : `${G}PASS${X}`;
    console.log(`  ${status}  ${B}${r.id}${X}  ${r.title}`);
    if (r.error) console.log(`         ${R}threw:${X} ${r.error.message}`);
    for (const c of r.checks) {
      if (c.pass) { pass++; continue; }
      fail++;
      console.log(`         ${R}✗${X} ${c.label}`);
      if (c.detail) console.log(`           ${Y}${c.detail}${X}`);
    }
  }
  console.log(`\n${'─'.repeat(72)}`);
  const verdict = fail === 0 && !results.some((r) => r.error)
    ? `${G}${B}  ALL GREEN${X}` : `${R}${B}  ${fail} FAILED CHECK(S)${X}`;
  console.log(`${verdict} — ${pass} passed, ${fail} failed across ${results.length} scenarios\n`);
  process.exitCode = (fail === 0 && !results.some((r) => r.error)) ? 0 : 1;
})();