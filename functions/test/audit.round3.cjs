// ═══════════════════════════════════════════════════════════════════════════
// AUDIT PROBE SUITE — ROUND 3  (2026-08-03)
//
// Round 2 (audit.probe.cjs) found and fixed ten defects. This round goes at
// what round 2 did NOT reach:
//
//   • the READERS of the exam paper, not just the graders. Round 2 froze the
//     paper onto the attempt for grading; this asks whether every other path
//     agrees — question serving, regrade, review keys, the question clock.
//   • the code round 2 ADDED. My own fixes get the harshest probes here,
//     because a fix that is right in the one place it was tested and wrong in
//     the four it was not is the exact shape of the defects it replaced.
//   • surfaces round 2 never touched: admission, resume, heartbeat, deletion,
//     review-key export, cross-tenant reach.
//
// Same standard as every suite in this directory: real compiled callables,
// in-memory Firestore, virtual clock. Nothing re-implements a deadline or a
// mark.
//
//   node test/audit.round3.cjs
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
const sec = (s) => s * 1000;

process.env.GCLOUD_PROJECT = 'demo-audit-round3';
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

const OWNER   = (uid = 'wo_1') => ({ uid, token: { role: 'webOwner' } });
const STAFF   = (uid = 'fac_1', role = 'faculty', instituteId = 'inst_1') =>
  ({ uid, token: { role, instituteId } });
const STUDENT = (uid = 'stu_uid', studentId = 'stu_1', instituteId = 'inst_1') =>
  ({ uid, token: { role: 'student', studentId, instituteId } });

const A = (id) => DB.read('attempts', id);
const lockMs = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : (v ? Date.parse(v) : null));

function clientAnswer(attemptId, qid, value, sectionId) {
  const att = DB.read('attempts', attemptId);
  att.answers[qid] = { type: 'mcq', value, sectionId, answeredAt: at(VNOW) };
  att.updatedAt = at(VNOW);
  DB.seed('attempts', attemptId, att);
}

function seedQuestion(id, opts = {}) {
  DB.seed('questions', id, {
    id, engine: opts.engine ?? 'mcq', variant: opts.variant ?? 'single',
    stem: `Question ${id}`,
    options: [{ id: 'alpha', text: 'Alpha' }, { id: 'beta', text: 'Beta' }, { id: 'gamma', text: 'Gamma' }],
    difficulty: opts.difficulty ?? 'medium',
  });
  DB.seed('questionAnswers', id, {
    id, correctIds: opts.correctIds ?? ['alpha'],
    correctPairs: opts.correctPairs ?? [], modelAnswer: opts.modelAnswer ?? '',
  });
}

function seedWorld(opts = {}) {
  DB.seed('students', 'stu_1', { id: 'stu_1', name: 'Test Student', instituteId: 'inst_1' });
  DB.seed('students', 'stu_2', { id: 'stu_2', name: 'Other Student', instituteId: 'inst_1' });
  const asmt = {
    id: 'asmt_1', title: 'Round 3 Paper', instituteId: 'inst_1',
    ownerType: 'webOwner', ownerId: 'webOwner',
    status: opts.status ?? 'active',
    startDate: opts.startDate ?? at(VNOW - min(60)),
    endDate: 'endDate' in opts ? opts.endDate : at(VNOW + min(600)),
    maxAttempts: opts.maxAttempts ?? 1,
    overallTimeLimit: 'overallTimeLimit' in opts ? opts.overallTimeLimit : 60,
    deliveryMode: opts.deliveryMode ?? 'standard',
    sectionStartOrder: opts.sectionStartOrder ?? 'sequential',
    shuffleQuestions: opts.shuffleQuestions ?? false,
    securityTier: 'mock',
    requireCamera: false, allowMobile: true, requireExtensionCheck: false, requireSEB: false,
    securityLockedAt: at(VNOW - min(120)),
    passingScore: 40,
    assignedTo: { type: 'all' },
    allowReview: opts.allowReview ?? true,
    showResults: true,
    gradingConfig: opts.gradingConfig,
    sections: [
      {
        id: 'SA', name: 'A', timeLimit: opts.sectionATimeLimit ?? 30,
        questionTimeLimit: opts.questionTimeLimit,
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
  for (const q of ['q1', 'q2', 'q3', 'q9']) seedQuestion(q);
  return asmt;
}

/** Swap q1 out of the live paper for q9 — the "staff re-saved a live exam" event. */
function swapLivePaper() {
  const a = DB.read('assessments', 'asmt_1');
  a.sections[0].questions = [
    { questionId: 'q9', marks: 10, order: 0 },
    { questionId: 'q2', marks: 10, order: 1 },
  ];
  DB.seed('assessments', 'asmt_1', a);
}

// ═══════════════════════════════════════════════════════════════════
// B-01 · the questions a student is SERVED are the ones they are graded on
//
// Round 2 froze the paper onto the attempt so grading marks what the student
// sat. getExamQuestions was not part of that change: in standard delivery it
// still lists the LIVE document. If the two disagree the fix has not removed
// the inconsistency, only moved it — and moved it somewhere worse, because the
// student now SEES a question that will never be marked and never sees one
// that will be marked blank.
// ═══════════════════════════════════════════════════════════════════
async function B01() {
  seedWorld();
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  const frozen = new Set(Object.values(A(id).questionOrder).flat());
  check(frozen.has('q1'), 'the attempt froze q1 into its play order');

  swapLivePaper();          // staff re-save; the rule re-draw swaps q1 -> q9

  const served = await call(fns.getExamQuestions,
    { assessmentId: 'asmt_1' }, STUDENT());
  const servedIds = new Set((served.questions ?? []).map((q) => q.id));

  check(servedIds.has('q1'),
    'the student is still served the question they will be graded on (q1)',
    `served: ${[...servedIds].join(', ')}`);
  check(!servedIds.has('q9'),
    'the student is NOT served a question that is not in their paper (q9)',
    `served: ${[...servedIds].join(', ')}`);
}

// ═══════════════════════════════════════════════════════════════════
// B-02 · regradeAttempts marks each attempt against the paper IT sat
//
// The A-05 commit named regradeAttempts as part of the problem — "this reaches
// already-submitted attempts too" — but the fix only reached gradeAttempt,
// gradeProvisional and the sweep. regradeAttempts loads sections ONCE from the
// live document and applies them to every attempt.
// ═══════════════════════════════════════════════════════════════════
async function B02() {
  seedWorld();
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  advance(min(2));
  clientAnswer(id, 'q1', 'alpha', 'SA');
  clientAnswer(id, 'q2', 'alpha', 'SA');
  clientAnswer(id, 'q3', 'alpha', 'SB');
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());
  eq(A(id).scores.total, 40, 'the sitting grades 40/40 on submit');

  swapLivePaper();

  advance(min(1));
  await call(fns.regradeAttempts, { assessmentId: 'asmt_1' }, OWNER());
  eq(A(id).scores.total, 40,
    'a regrade after a live paper edit still marks the paper the student sat');
}

// ═══════════════════════════════════════════════════════════════════
// B-03 · a grader can read the key for a question a student actually sat
//
// getAnswerKeysForReview is GRADER-ONLY ("students are always denied"), and it
// intersects the requested ids with the LIVE paper so keys can never leak
// beyond it. That intersection is right in intent and uses the wrong set once
// the live paper has moved: a text answer sitting in a student's frozen paper
// but no longer in the live document becomes unmarkable, because the human
// marking it cannot obtain its key.
// ═══════════════════════════════════════════════════════════════════
async function B03() {
  seedWorld();
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  advance(min(2));
  clientAnswer(id, 'q1', 'alpha', 'SA');
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());

  swapLivePaper();

  await expectThrow('a student is always denied the key endpoint',
    () => call(fns.getAnswerKeysForReview, { assessmentId: 'asmt_1' }, STUDENT()),
    'Only graders');

  const out = await call(fns.getAnswerKeysForReview,
    { assessmentId: 'asmt_1' }, OWNER());
  const keys = out.keys ?? {};
  check(Object.prototype.hasOwnProperty.call(keys, 'q1'),
    'a grader can still obtain the key for a question students actually sat',
    `keys: ${Object.keys(keys).join(', ')}`);
}

// ═══════════════════════════════════════════════════════════════════
// B-04 · the per-question clock is frozen with the rest of the contract
//
// questionTimeLimit lives on the section. submitAnswerAndAdvance and
// saveAnswerNoAdvance both read it via normalizeSections(THE LIVE DOC), so
// editing it mid-sitting changes the clock of a student already answering.
// ═══════════════════════════════════════════════════════════════════
async function B04() {
  seedWorld({ deliveryMode: 'linear', questionTimeLimit: 300, overallTimeLimit: 600,
    sectionATimeLimit: 600, sectionBTimeLimit: 600 });
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  // Staff cut the per-question clock from 300s to 10s mid-sitting.
  const a = DB.read('assessments', 'asmt_1');
  a.sections[0].questionTimeLimit = 10;
  DB.seed('assessments', 'asmt_1', a);

  advance(sec(60));         // inside the 300s the student started under
  const out = await call(fns.submitAnswerAndAdvance,
    { attemptId: id, questionId: 'q1', answer: { type: 'mcq', value: 'alpha' } }, STUDENT());
  eq(out.lateAnswer, false,
    'an answer inside the ORIGINAL question limit is not retroactively late');
}

// ═══════════════════════════════════════════════════════════════════
// B-05 · a legacy attempt with no examSnapshot still grades
//
// The regression that matters most for the round-2 fix: attempts created
// before examSnapshot existed must fall through to the live document exactly
// as before, or the deploy breaks every in-flight sitting.
// ═══════════════════════════════════════════════════════════════════
async function B05() {
  seedWorld();
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  // Strip the snapshot: this is exactly the shape of a pre-deploy attempt.
  const att = A(id);
  delete att.examSnapshot;
  DB.seed('attempts', id, att);
  check(!A(id).examSnapshot, 'attempt now looks pre-deploy (no examSnapshot)');

  advance(min(2));
  clientAnswer(id, 'q1', 'alpha', 'SA');
  clientAnswer(id, 'q2', 'alpha', 'SA');
  clientAnswer(id, 'q3', 'alpha', 'SB');

  const v = await call(fns.getExamVerdict, { attemptId: id }, STUDENT());
  check(v.verdict.kind !== 'ended', 'a legacy attempt still resolves normally',
    `verdict=${v.verdict.kind}`);

  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());
  eq(A(id).scores.total, 40, 'and grades against the live paper, as before');
}

// ═══════════════════════════════════════════════════════════════════
// B-06 · the snapshot records the order the student was actually given
// ═══════════════════════════════════════════════════════════════════
async function B06() {
  seedWorld({ sectionStartOrder: 'random', shuffleQuestions: true });
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  const att = A(id);

  const snapIds = (att.examSnapshot?.sections ?? []).map((s) => s.id);
  eq(JSON.stringify(snapIds), JSON.stringify(att.sectionIds),
    'the snapshot section order IS the played order, not the builder order');

  const snapQ = new Set((att.examSnapshot?.sections ?? [])
    .flatMap((s) => (s.questions ?? []).map((q) => q.questionId)));
  const playedQ = new Set(Object.values(att.questionOrder).flat());
  eq(snapQ.size, playedQ.size, 'the snapshot holds exactly the played question set');
  check([...playedQ].every((q) => snapQ.has(q)),
    'every played question is in the snapshot');

  // Marks must ride along, or grading a snapshot-backed attempt scores zero.
  const marks = (att.examSnapshot?.sections ?? [])
    .flatMap((s) => (s.questions ?? []).map((q) => q.marks));
  check(marks.length > 0 && marks.every((m) => typeof m === 'number' && m > 0),
    'the snapshot carries per-question marks', `marks: ${marks.join(',')}`);
}

// ═══════════════════════════════════════════════════════════════════
// B-07 · a QUESTION penalty travels outward and is capped in aggregate
//
// Round 2's A-04 fix was verified on the section+overall pair only. The
// question clock is the innermost of the three and reaches BOTH of the others,
// so it is the case most able to overshoot.
// ═══════════════════════════════════════════════════════════════════
async function B07() {
  seedWorld({ deliveryMode: 'linear', questionTimeLimit: 600,
    sectionATimeLimit: 30, overallTimeLimit: 60 });
  const t0 = VNOW;
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  advance(min(5));
  await call(fns.freezeAttempt, { attemptId: id }, STAFF());
  advance(min(2));
  await call(fns.unfreezeAttempt, {
    attemptId: id, grantedMs: min(2),
    penalties: { questionMs: min(600), sectionMs: min(600), overallMs: min(600) },
  }, STAFF());

  const after = A(id);
  const sec_ = lockMs(after.sectionLockedAfter);
  const ovr = lockMs(after.overallLockedAfter);
  check(sec_ === null || sec_ >= VNOW,
    'the penalised SECTION deadline is not in the past',
    `sectionLockedAfter=${sec_}, now=${VNOW}`);
  check(ovr === null || ovr >= VNOW,
    'the penalised OVERALL deadline is not in the past',
    `overallLockedAfter=${ovr}, now=${VNOW}`);
  check(ovr === null || ovr >= t0,
    'and certainly not before the exam began');

  const v = await call(fns.getExamVerdict, { attemptId: id }, STUDENT());
  check(['question', 'section', 'ended'].includes(v.verdict.kind),
    'the resolver still returns a coherent verdict', `kind=${v.verdict.kind}`);
}

// ═══════════════════════════════════════════════════════════════════
// B-08 · negative marking: percent type, overrides, and blanks
// ═══════════════════════════════════════════════════════════════════
async function B08() {
  seedWorld({
    gradingConfig: {
      exam: { negativeMarking: true, penaltyType: 'percent', penaltyValue: 25, blankScore: 0 },
      sections: { SB: { section: { penaltyType: 'fixed', penaltyValue: 3 } } },
    },
  });
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  advance(min(1));
  clientAnswer(id, 'q1', 'beta', 'SA');    // wrong, 10 marks, 25% -> -2.5
  clientAnswer(id, 'q3', 'beta', 'SB');    // wrong, 20 marks, section override -> -3
  // q2 left blank -> 0, never a penalty

  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());
  const g = A(id).gradedAnswers;
  eq(g.q1.marksAwarded, -2.5, 'percent penalty = 25% of the question marks');
  eq(g.q3.marksAwarded, -3, 'a section override beats the exam-level policy');
  eq(g.q2.marksAwarded, 0, 'a blank takes blankScore, never the penalty');
  eq(A(id).scores.total, 0, 'the headline total is floored at zero');
}

// ═══════════════════════════════════════════════════════════════════
// B-09 · verifyAndResume honours the auto-resume policy
// ═══════════════════════════════════════════════════════════════════
async function B09() {
  seedWorld();
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  // Freeze via the extension path, which is what verifyAndResume clears.
  advance(min(1));
  await call(fns.reportExtensionCheck,
    { attemptId: id, passed: false, found: ['ext_x'] }, STUDENT());
  const frozen = A(id);
  // autoResume is false on this tier, so the student may not clear it alone.
  eq(frozen.securityConfig.autoResume, false, 'this tier does not auto-resume');

  if (frozen.status === 'frozen') {
    await expectThrow('a student cannot self-resume when auto-resume is off',
      () => call(fns.verifyAndResume, { attemptId: id }, STUDENT()),
      'RESUME_BLOCKED');
    const cleared = await call(fns.verifyAndResume, { attemptId: id }, STAFF());
    eq(cleared.resumed ?? true, true, 'an invigilator can clear it');
    eq(A(id).status, 'in_progress', 'and the sitting resumes');
  } else {
    check(true, 'extension check did not freeze (requireExtensionCheck off on this tier)');
  }
}

// ═══════════════════════════════════════════════════════════════════
// B-10 · getExamQuestions refuses what it should
// ═══════════════════════════════════════════════════════════════════
async function B10() {
  seedWorld({ deliveryMode: 'linear', questionTimeLimit: 300 });

  await expectThrow('no paper before the exam is started',
    () => call(fns.getExamQuestions, { assessmentId: 'asmt_1' }, STUDENT()),
    'Start the exam');

  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  const served = await call(fns.getExamQuestions, { assessmentId: 'asmt_1' }, STUDENT());
  eq((served.questions ?? []).length, 1,
    'linear delivery serves ONLY what the server has served');

  // A blocked student cannot re-fetch on reload.
  const a = DB.read('assessments', 'asmt_1');
  a.blockedStudents = ['stu_1'];
  DB.seed('assessments', 'asmt_1', a);
  await expectThrow('a blocked student cannot re-fetch the paper',
    () => call(fns.getExamQuestions, { assessmentId: 'asmt_1' }, STUDENT()),
    'not available');

  // Another student, with no attempt, gets nothing.
  await expectThrow('a student with no attempt cannot fetch the paper',
    () => call(fns.getExamQuestions, { assessmentId: 'asmt_1' },
      STUDENT('stu2_uid', 'stu_2')),
    '');
  check(!!A(id), 'the original attempt is untouched by any of the above');
}

// ═══════════════════════════════════════════════════════════════════
// B-11 · cross-student and cross-tenant reach
// ═══════════════════════════════════════════════════════════════════
async function B11() {
  seedWorld();
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  await expectThrow('another student cannot heartbeat my attempt',
    () => call(fns.examHeartbeat, { attemptId: id }, STUDENT('s2', 'stu_2')), '');
  await expectThrow('another student cannot read my verdict',
    () => call(fns.getExamVerdict, { attemptId: id }, STUDENT('s2', 'stu_2')), '');
  await expectThrow('another student cannot grade my attempt',
    () => call(fns.gradeAttempt, { attemptId: id, reason: 'manual' },
      STUDENT('s2', 'stu_2')), '');
  await expectThrow('another student cannot claim my session',
    () => call(fns.registerSession, { attemptId: id, sessionId: 'x' },
      STUDENT('s2', 'stu_2')), '');
  await expectThrow('staff from another institute cannot freeze my attempt',
    () => call(fns.freezeAttempt, { attemptId: id },
      STAFF('fac_9', 'faculty', 'inst_OTHER')), '');
  await expectThrow('staff from another institute cannot regrade this exam',
    () => call(fns.gradeProvisional, { attemptId: id },
      STAFF('fac_9', 'faculty', 'inst_OTHER')), '');
  await expectThrow('only the platform owner may delete an attempt',
    () => call(fns.softDeleteAttempt, { attemptId: id }, STAFF()), 'platform owner');
}

// ═══════════════════════════════════════════════════════════════════
// B-12 · rules-based admission is enforced, and revocation bites
// ═══════════════════════════════════════════════════════════════════
async function B12() {
  seedWorld();
  const a = DB.read('assessments', 'asmt_1');
  a.allocationMode = 'rules';
  DB.seed('assessments', 'asmt_1', a);

  await expectThrow('a student with no membership row cannot start',
    () => call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT()),
    'not assigned');

  DB.seed('assessmentMembers', 'asmt_1_stu_1',
    { active: true, admittedByVersion: 7, source: 'rules' });
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  eq(A(id).allocationVersion, 7, 'admission provenance is recorded on the attempt');
  eq(A(id).allocationSource, 'rules', 'as is the source');

  // ── Revoking membership mid-sitting does NOT eject: by design ────
  //
  // getExamQuestions admits on `published && assigned` OR `hasAttempt`, and
  // the second is deliberate — an existing attempt is "proof they legitimately
  // sat the paper", which is what keeps review working after an exam closes or
  // a student is unassigned. So de-allocation is an ADMISSIONS control: it
  // stops the next sitting, not this one.
  //
  // Asserting the opposite here would have manufactured a defect out of a
  // documented decision. What it is worth pinning is that the intended live
  // lever still bites, so staff have a way to stop a sitting in progress.
  DB.seed('assessmentMembers', 'asmt_1_stu_1', { active: false });
  const stillIn = await call(fns.getExamQuestions, { assessmentId: 'asmt_1' }, STUDENT());
  check((stillIn.questions ?? []).length > 0,
    'de-allocation does not eject a student already sitting (admissions control)');

  const a2 = DB.read('assessments', 'asmt_1');
  a2.blockedStudents = ['stu_1'];
  DB.seed('assessments', 'asmt_1', a2);
  await expectThrow('blockedStudents IS the live lever, and it stops the re-fetch',
    () => call(fns.getExamQuestions, { assessmentId: 'asmt_1' }, STUDENT()),
    'not available');
  await expectThrow('and it stops the sitting advancing',
    () => call(fns.submitSection,
      { attemptId: id, sectionId: 'SA', nextSectionId: 'SB' }, STUDENT()),
    'BLOCKED_FROM_EXAM');
}

// ═══════════════════════════════════════════════════════════════════
// B-13 · SEQUENTIAL idempotency of startExam
//
// NOT a concurrency test, and the distinction is the point. startExam's
// protection against two live attempts is a Firestore TRANSACTION; the fake
// db's runTransaction has no isolation and no retry — it simply runs the body
// and commits — so three parallel calls here all read "no live attempt" and
// all write. That is the HARNESS, not the product, and asserting on it would
// manufacture a defect that does not exist.
//
// What this harness CAN prove is the property the transaction exists to make
// true under concurrency: that repeated calls are idempotent. The retry added
// for staggered starts is justified on exactly that basis, so it is worth
// holding.
// ═══════════════════════════════════════════════════════════════════
async function B13() {
  seedWorld({ maxAttempts: 1 });
  const r1 = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const r2 = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const r3 = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  eq(new Set([r1.attempt.id, r2.attempt.id, r3.attempt.id]).size, 1,
    'repeated starts return the SAME attempt');
  eq(DB.all('attempts').length, 1, 'and create only one document');

  // Once finished, the limit bites rather than handing out another sitting.
  advance(min(1));
  await call(fns.gradeAttempt, { attemptId: r1.attempt.id, reason: 'manual' }, STUDENT());
  await expectThrow('and a fresh start is refused once the limit is spent',
    () => call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT()),
    'ATTEMPT_LIMIT_EXCEEDED');
}

// ═══════════════════════════════════════════════════════════════════
// B-14 · concurrency: racing finalisations do not double-grade
// ═══════════════════════════════════════════════════════════════════
async function B14() {
  seedWorld();
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  advance(min(2));
  clientAnswer(id, 'q1', 'alpha', 'SA');

  const outs = await Promise.allSettled([
    call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT()),
    call(fns.gradeAttempt, { attemptId: id, reason: 'time_expired' }, STUDENT()),
  ]);
  const ok = outs.filter((o) => o.status === 'fulfilled').length;
  check(ok >= 1, 'at least one finalisation succeeds', `fulfilled=${ok}`);

  const done = A(id);
  check(['submitted', 'auto_submitted'].includes(done.status),
    'the attempt lands in exactly one terminal status', `status=${done.status}`);
  eq(done.scores.total, 10, 'and is scored once, correctly');
}

// ═══════════════════════════════════════════════════════════════════
// B-15 · a student cannot review keys before finishing
// ═══════════════════════════════════════════════════════════════════
async function B15() {
  seedWorld({ allowReview: false });
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  advance(min(1));

  await expectThrow('keys are refused while the sitting is live',
    () => call(fns.getAnswerKeysForReview,
      { assessmentId: 'asmt_1', attemptId: id }, STUDENT()), '');

  clientAnswer(id, 'q1', 'alpha', 'SA');
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());

  const g = A(id).gradedAnswers ?? {};
  const leaked = Object.values(g).some((x) =>
    (Array.isArray(x.correctIds) && x.correctIds.length > 0)
    || (typeof x.modelAnswer === 'string' && x.modelAnswer.length > 0));
  check(!leaked,
    'allowReview:false keeps answer keys out of the student-readable attempt');

  await expectThrow('and out of the key endpoint',
    () => call(fns.getAnswerKeysForReview,
      { assessmentId: 'asmt_1', attemptId: id }, STUDENT()), '');
}

// ═══════════════════════════════════════════════════════════════════
// B-16 · a tampered institute document cannot widen its own rights
//
// C1 (audit 2026-08-06). firestore.rules:161 read
//
//     allow update: if isWebOwner() || isInstituteSelf(instituteId);
//
// with no field whitelist, so institutes/{id} was self-governing: the admin
// it governs could write every field on it, including the eight the Web Owner
// owns. Two server-side gates read that document and believed it —
// assertQuestionRight for questionRightsCeiling, and three deletion sites for
// deletionRightsCeiling. Structurally correct checks validating
// attacker-controlled input.
//
// WHAT THIS PROBE CAN AND CANNOT REACH. The rules clause is the primary fix
// and it is NOT exercised here: this harness is an in-memory Firestore with no
// rules engine, so it cannot prove a write is refused. That half needs the
// rules emulator and is recorded as a gap below. What it CAN prove is the
// half that lives in code — that when a ceiling document IS hostile, the
// server does not simply do as it is told. So every seed here writes the
// tampered document DIRECTLY, modelling an attacker who has already won the
// rules layer, and asks what the callables do next.
//
// Three claims, in the order the audit ranked them:
//   1. the lifecycle gate now bites server-side (it existed only in three
//      React contexts, and `activeUntil` appeared nowhere in index.ts)
//   2. WEBOWNER_ONLY_S still forces attempt/institute off whatever the
//      document says — the bound that kept exam evidence out of reach
//   3. an absent ceiling still fails closed, which is what the tamper was
//      trying to escape
// ═══════════════════════════════════════════════════════════════════
function seedInstitute(patch = {}) {
  DB.seed('institutes', 'inst_1', {
    id: 'inst_1', name: 'Test Institute', code: 'TI',
    status: 'active', activeUntil: '', ...patch,
  });
}

async function B16() {
  seedWorld();
  DB.seed('faculty', 'fac_1', { id: 'fac_1', name: 'Test Faculty', instituteId: 'inst_1' });

  const newQuestion = { engine: 'mcq', variant: 'single', stem: 'S', options: [], difficulty: 'easy' };
  const ADMIN = () => ({ uid: 'inst_1', token: { role: 'institute', instituteId: 'inst_1' } });

  // ── 1 · fails closed with no ceiling ──────────────────────────────
  seedInstitute();
  await expectThrow('no ceiling on the document means no right',
    () => call(fns.createQuestionAsRole, { question: newQuestion }, ADMIN()),
    'does not have the "create" right');

  // ── 2 · the tampered ceiling, tenant live ─────────────────────────
  // This is the escalation itself, and it SUCCEEDS: a live tenant holding a
  // self-granted ceiling creates the question. Pinning that here is
  // deliberate — it is the evidence that the rules clause was load-bearing,
  // and it is what will fail loudly if anyone puts isInstituteSelf back on
  // institutes:161 while believing the server would catch it. The server
  // never could; only the rule can.
  seedInstitute({ questionRightsCeiling: { create: { allowed: true, modes: ['direct'] } } });
  const made = await call(fns.createQuestionAsRole, { question: newQuestion }, ADMIN());
  check(made?.ok === true,
    'a self-granted ceiling IS honoured while the tenant is live — the rule is the only guard');

  // ── 3 · the lifecycle gate, which is new ──────────────────────────
  // Same hostile ceiling, tenant switched off three different ways. Before
  // C1 all three of these created the question: nothing on the server had
  // ever read status, lifecycleState or activeUntil.
  const hostile = { questionRightsCeiling: { create: { allowed: true, modes: ['direct'] } } };

  seedInstitute({ ...hostile, status: 'disabled' });
  await expectThrow('a DISABLED tenant creates nothing, ceiling or no ceiling',
    () => call(fns.createQuestionAsRole, { question: newQuestion }, ADMIN()),
    'disabled');

  seedInstitute({ ...hostile, lifecycleState: 'softDeleted' });
  await expectThrow('nor does a soft-deleted one',
    () => call(fns.createQuestionAsRole, { question: newQuestion }, ADMIN()),
    'deleted');

  seedInstitute({ ...hostile, activeUntil: at(VNOW - min(1)) });
  await expectThrow('nor one whose access period elapsed a minute ago',
    () => call(fns.createQuestionAsRole, { question: newQuestion }, ADMIN()),
    'expired');

  // The boundary, from the safe side: still valid means still working.
  seedInstitute({ ...hostile, activeUntil: at(VNOW + min(1)) });
  const stillOk = await call(fns.createQuestionAsRole, { question: newQuestion }, ADMIN());
  check(stillOk?.ok === true, 'a minute before expiry it still works (the gate is not off-by-one)');

  // Absent/empty activeUntil is NO bound, not an expired one — institutes
  // provisioned before the field existed must keep working.
  seedInstitute({ ...hostile });
  const noBound = await call(fns.createQuestionAsRole, { question: newQuestion }, ADMIN());
  check(noBound?.ok === true, 'an absent activeUntil is unbounded, not expired');

  // ── 4 · the WEBOWNER_ONLY_S clamp ─────────────────────────────────
  // The most permissive ceiling that can be written, granting every resource
  // in direct mode. attempt and institute must STILL be refused: they are
  // forced off in code (index.ts:371), not by the document. This is the bound
  // that kept the exam audit trail out of reach even while C1 was open.
  seedInstitute({
    deletionRightsCeiling: {
      attempt:   { allowed: true, modes: ['direct'], selfMode: 'direct' },
      institute: { allowed: true, modes: ['direct'], selfMode: 'direct' },
      faculty:   { allowed: true, modes: ['direct'], selfMode: 'direct' },
    },
  });
  DB.seed('institutes', 'inst_victim', { id: 'inst_victim', name: 'Victim', status: 'active' });

  await expectThrow('a maximal self-granted ceiling still cannot delete an institute',
    () => call(fns.deleteAuthUser, { role: 'institute', uid: 'inst_victim' }, ADMIN()),
    'may only delete faculty or students');

  // And with the tenant switched off, even the resources it legitimately
  // holds go away.
  seedInstitute({
    status: 'disabled',
    deletionRightsCeiling: { faculty: { allowed: true, modes: ['direct'], selfMode: 'direct' } },
  });
  await expectThrow('a disabled tenant deletes nobody, however wide its ceiling',
    () => call(fns.deleteAuthUser, { role: 'faculty', uid: 'fac_1' }, ADMIN()),
    'disabled');

  KNOWN_GAPS.push(
    'C1\'s PRIMARY fix is the firestore.rules change (institutes:161 is now webOwner-only, '
    + 'instituteCredentials:178 whitelisted to firstLoginRequired). This harness has no rules '
    + 'engine, so B-16 proves only the server-side half — it seeds hostile documents directly '
    + 'and checks the callables refuse to act on them. That no rules test exists anywhere in '
    + 'this repo is itself the gap: firestore.rules has zero coverage and needs the emulator.',
  );
}

// ═══════════════════════════════════════════════════════════════════
const SCENARIOS = [
  ['B-01', 'served questions == graded questions', B01],
  ['B-02', 'regrade marks the paper each attempt sat', B02],
  ['B-03', 'a grader can key a question students sat', B03],
  ['B-04', 'the per-question clock is frozen', B04],
  ['B-05', 'a legacy attempt with no snapshot still works', B05],
  ['B-06', 'the snapshot records the played order and marks', B06],
  ['B-07', 'a question penalty is capped in aggregate', B07],
  ['B-08', 'negative marking: percent, overrides, blanks', B08],
  ['B-09', 'verifyAndResume honours the auto-resume policy', B09],
  ['B-10', 'getExamQuestions refuses what it should', B10],
  ['B-11', 'cross-student and cross-tenant reach', B11],
  ['B-12', 'rules admission; de-allocation vs blocking', B12],
  ['B-13', 'startExam is idempotent; the limit bites', B13],
  ['B-14', 'racing finalisations do not double-grade', B14],
  ['B-15', 'no keys before finishing, none when review is off', B15],
  ['B-16', 'a tampered institute cannot widen its own rights', B16],
];

(async () => {
  for (const [id, title, fn] of SCENARIOS) await scenario(id, title, fn);

  const C = { r: '\x1b[31m', g: '\x1b[32m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
  let pass = 0, fail = 0;
  console.log(`\n${C.b}AUDIT PROBE SUITE — ROUND 3${C.x}  —  real callables, in-memory Firestore, virtual clock\n`);
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