// ═══════════════════════════════════════════════════════════════════════════
// AUDIT PROBE SUITE — ROUND 4  (2026-08-15)
//
// Rounds 2 and 3 unified the freeze. F6 gave both entrances — the invigilator
// pause and the automatic extension pause — one shape: one ledger entry, one
// `status: 'frozen'`, one set of legacy mirrors. F4/F7 then made
// unfreezeAttempt's release the single implementation of "the pause is over",
// and routed verifyAndResume through it so "the invigilator path and the system
// path cannot reach different state".
//
// This round asks the question that unification invites: the two paths now
// share the WRITE, but do they share the DECISION and the CONSEQUENCES?
//
//   • who may end this pause (assertCanUnfreeze),
//   • how much time ending it hands back,
//   • what else has to be true afterwards (the provisional grade, the record),
//   • and what a student may do while the pause is open.
//
// Same standard as every suite here: real compiled callables, in-memory
// Firestore, virtual clock. Nothing re-implements a deadline or a mark.
//
//   node test/audit.round4.cjs
//   PROBE_TRACE=1 node test/audit.round4.cjs
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

process.env.GCLOUD_PROJECT = 'demo-audit-round4';
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
const openFreeze = (id) => (A(id).freezes ?? []).find((f) => !f.endedAt);
const closedFreezes = (id) => (A(id).freezes ?? []).filter((f) => f.endedAt);
const auditRows = (action) =>
  DB.all('deletionAudit').map((r) => r.data).filter((r) => r.action === action);

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

/**
 * A NORMAL-tier exam, because that is where the auto-resume policy lives.
 *
 * Round 3's B-09 is the reason this differs from the other suites' seedWorld:
 * it seeds `securityTier: 'mock'`, on which requireExtensionCheck is false, so
 * reportExtensionCheck never froze anything and the probe took its own
 * "extension check did not freeze" branch. The auto-resume path it was named
 * for has therefore never been exercised by any suite. Here it is the subject.
 *
 * normal tier: requireExtensionCheck defaults ON, autoResume is the author's
 * choice (startExam forces it off for high_stake, and mock cannot freeze), so
 * `normal + autoResume` is the one shipping configuration in which a student
 * can end their own pause.
 */
function seedWorld(opts = {}) {
  DB.seed('students', 'stu_1', { id: 'stu_1', name: 'Test Student', instituteId: 'inst_1' });
  DB.seed('students', 'stu_2', { id: 'stu_2', name: 'Other Student', instituteId: 'inst_1' });
  const asmt = {
    id: 'asmt_1', title: 'Round 4 Paper', instituteId: 'inst_1',
    ownerType: 'webOwner', ownerId: 'webOwner',
    status: 'active',
    startDate: at(VNOW - min(60)),
    endDate: 'endDate' in opts ? opts.endDate : at(VNOW + min(600)),
    maxAttempts: 1,
    overallTimeLimit: 'overallTimeLimit' in opts ? opts.overallTimeLimit : 60,
    deliveryMode: opts.deliveryMode ?? 'standard',
    sectionStartOrder: 'sequential',
    shuffleQuestions: false,
    // The tier that can both freeze automatically and auto-resume.
    securityTier: 'normal',
    requireCamera: false,
    allowMobile: true,
    requireExtensionCheck: opts.requireExtensionCheck ?? true,
    requireSEB: false,
    autoResume: opts.autoResume ?? true,
    securityLockedAt: at(VNOW - min(120)),
    passingScore: 40,
    assignedTo: { type: 'all' },
    allowReview: true,
    showResults: true,
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
  for (const q of ['q1', 'q2', 'q3']) seedQuestion(q);
  return asmt;
}

async function startAndVerify(opts = {}) {
  seedWorld(opts);
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  eq(A(id).securityConfig.autoResume, opts.autoResume ?? true,
    'the attempt was born under the auto-resume policy this probe is about');
  eq(A(id).securityConfig.requireExtensionCheck, opts.requireExtensionCheck ?? true,
    'and under a tier whose extension check can actually pause it');
  return id;
}

// ═══════════════════════════════════════════════════════════════════
// C-01 · the authority ladder has a second door, and it is unlocked
//
// §3/§8 attach authority to the individual pause: the freezer, or someone
// strictly above them, and NEVER a peer. assertCanUnfreeze is that rule, and
// unfreezeAttempt reads it from the open ledger entry inside its transaction.
//
// verifyAndResume ends the same pause, through the same closeFreezeUpdates, and
// never calls assertCanUnfreeze. It asks two other questions instead — is the
// tier auto-resume, and did the last extension check pass — neither of which
// says anything about WHO paused this sitting or why.
//
// Both halves of the ladder are therefore reachable from the wrong side:
//   (a) the STUDENT clears an invigilator's deliberate pause, and
//   (b) a PEER invigilator clears a colleague's, which the ladder exists to
//       prevent and which unfreezeAttempt refuses one function away.
//
// `lastExtensionCheck.passed` is not an obstacle: it is written by the
// student's own reportExtensionCheck call, with the value the client chose.
// ═══════════════════════════════════════════════════════════════════
async function C01() {
  const id = await startAndVerify();

  // The student's client reports a clean machine. This is an ordinary call on
  // an ordinary sitting; nothing about it is a pause.
  advance(min(1));
  await call(fns.reportExtensionCheck, { attemptId: id, passed: true, found: [] }, STUDENT());
  eq(A(id).lastExtensionCheck.passed, true, 'the student\'s own client reported a passing check');

  // A faculty member now pauses the sitting deliberately.
  advance(min(2));
  await call(fns.freezeAttempt, { attemptId: id, reason: 'suspected phone use' }, STAFF());
  eq(A(id).status, 'frozen', 'the invigilator\'s pause landed');
  eq(openFreeze(id).reason, 'invigilator', 'and it is recorded as an invigilator pause');
  eq(openFreeze(id).frozenByRole, 'faculty', 'with the authority that took it');

  advance(min(3));

  // (a) The subject of the decision must not be able to undo it.
  await expectThrow('a student cannot clear an INVIGILATOR pause through verifyAndResume',
    () => call(fns.verifyAndResume, { attemptId: id }, STUDENT()),
    'FREEZE_AUTHORITY');
  eq(A(id).status, 'frozen', 'and the sitting is still paused after they tried');

  // (b) A peer must not be able to undo it either — the rule unfreezeAttempt
  //     enforces one function away.
  await expectThrow('a PEER invigilator cannot clear a colleague\'s pause through verifyAndResume',
    () => call(fns.verifyAndResume, { attemptId: id }, STAFF('fac_2')),
    'FREEZE_AUTHORITY');
  eq(A(id).status, 'frozen', 'and it is still paused after that too');

  // The control. The freezer themselves still clears it, or this probe would
  // pass against a callable that had simply been broken for everyone.
  const cleared = await call(fns.verifyAndResume, { attemptId: id }, STAFF('fac_1'));
  eq(cleared.resumed, true, 'the invigilator who paused it can still clear it');
  eq(A(id).status, 'in_progress', 'and the sitting resumes');

  // A release is a decision about a student's time, and every other release
  // writes one. unfreezeAttempt writes `attemptUnfrozen`; this path wrote
  // nothing at all, so a pause could be started with an audit row and ended
  // without one.
  const rows = auditRows('attemptUnfrozen');
  check(rows.length === 1, 'the release is recorded in the audit log',
    `found ${rows.length} attemptUnfrozen rows`);
  if (rows.length > 0) {
    eq(rows[0].actorUid, 'fac_1', 'and the row names who ended it');
    eq(rows[0].entityId, id, 'against the right attempt');
  }
}

// ═══════════════════════════════════════════════════════════════════
// C-02 · self-service resume mints time without bound
//
// D8 says an automatic state needs an automatic exit in the student's favour,
// and verifyAndResume implements that literally: the whole pause is granted,
// every time, with no ceiling.
//
// The pause it grants is one the STUDENT'S OWN CLIENT declares. reportExtension
// Check({passed:false}) opens it and reportExtensionCheck({passed:true}) makes
// it clearable, so on a normal-tier exam with auto-resume the loop
//
//     report failed -> think for as long as you like -> report passed -> resume
//
// hands back exactly the time it consumed, and can be run again. That is not a
// generous grace period, it is an exam with no overall time limit, reachable
// from the console by the person being examined.
//
// The measurement below is the deadline itself, read off the attempt, because
// `answersLockedAfter` is the field firestore.rules gates answer writes on.
// ═══════════════════════════════════════════════════════════════════
async function C02() {
  const id = await startAndVerify();
  const born = lockMs(A(id).overallLockedAfter);
  near(born, VNOW + min(60) + sec(30), sec(1),
    'the overall deadline is born at start + 60m + grace');

  // ── Cycle 1 — a forty-minute "extension check" pause ──────────────
  advance(min(5));
  await call(fns.reportExtensionCheck, { attemptId: id, passed: false, found: ['ext_x'] }, STUDENT());
  eq(A(id).status, 'frozen', 'the student\'s own report paused the sitting');
  eq(openFreeze(id).reason, 'extension_check', 'as an automatic pause');

  advance(min(40));
  await call(fns.reportExtensionCheck, { attemptId: id, passed: true, found: [] }, STUDENT());
  const r1 = await call(fns.verifyAndResume, { attemptId: id }, STUDENT());
  eq(A(id).status, 'in_progress', 'and the student cleared it themselves');
  eq(r1.resumed, true, 'the auto-resume policy allows that, which is by design');

  const after1 = lockMs(A(id).overallLockedAfter);
  check(after1 - born <= min(10) + sec(1),
    'a self-cleared pause cannot hand back more than the automatic ceiling',
    `deadline moved ${(after1 - born) / 60000} min for a 40 min pause`);
  check((r1.grantedMs ?? 0) <= min(10),
    'and the grant itself is capped',
    `granted ${(r1.grantedMs ?? 0) / 60000} min`);

  // The pause is still MEASURED in full — capping the grant must not falsify
  // the record an invigilator reviews afterwards.
  const entry1 = closedFreezes(id)[0];
  near(entry1.elapsedMs, min(40), sec(1),
    'the ledger still records the full elapsed pause, capped grant or not');

  // ── Cycle 2 — the loop is what makes it unbounded ─────────────────
  advance(min(1));
  await call(fns.reportExtensionCheck, { attemptId: id, passed: false, found: ['ext_x'] }, STUDENT());
  advance(min(40));
  await call(fns.reportExtensionCheck, { attemptId: id, passed: true, found: [] }, STUDENT());
  await call(fns.verifyAndResume, { attemptId: id }, STUDENT());

  const after2 = lockMs(A(id).overallLockedAfter);
  check(after2 - born <= min(10) + sec(1),
    'and running the loop again buys nothing more — the ceiling is per SITTING',
    `total drift ${(after2 - born) / 60000} min after two 40 min pauses`);

  // ── The control ───────────────────────────────────────────────────
  // The ceiling binds the AUTOMATIC path only. A human deciding that a pause
  // was genuine can still give back all of it — that decision has an actor, a
  // timestamp and an audit row, which is exactly what the automatic path
  // lacks.
  advance(min(1));
  await call(fns.freezeAttempt, { attemptId: id, reason: 'fire alarm' }, STAFF());
  advance(min(20));
  await call(fns.unfreezeAttempt,
    { attemptId: id, grantedMs: min(20), note: 'building evacuation' }, STAFF());
  const after3 = lockMs(A(id).overallLockedAfter);
  near(after3 - after2, min(20), sec(1),
    'an invigilator can still grant a full pause — the cap is not a global limit');
}

// ═══════════════════════════════════════════════════════════════════
// C-03 · a provisional grade outlives the pause that justified it
//
// A9 rules out storing a provisional score on the attempt, and the design note
// says why the sibling document is safe: "unfreezeAttempt deletes the row, so
// the grade cannot outlive the pause that justified it. Invalidation is not a
// cleanup step someone must remember — the score has nowhere to go stale."
//
// It is a cleanup step someone must remember. unfreezeAttempt remembers.
// verifyAndResume — the other release, added for the other freeze — does not,
// so a student who clears their own pause walks away from a stored mark that
// staff keep reading while they carry on answering.
// ═══════════════════════════════════════════════════════════════════
async function C03() {
  const id = await startAndVerify();

  advance(min(2));
  const att0 = A(id);
  att0.answers = { q1: { type: 'mcq', value: 'alpha', sectionId: 'SA', answeredAt: at(VNOW) } };
  DB.seed('attempts', id, att0);

  await call(fns.reportExtensionCheck, { attemptId: id, passed: false, found: ['ext_x'] }, STUDENT());
  eq(A(id).status, 'frozen', 'the sitting is paused');

  const prov = await call(fns.gradeProvisional, { attemptId: id }, STAFF());
  eq(prov.provisional, true, 'an invigilator takes a provisional grade of the paused paper');
  check(DB.has('provisionalGrades', id), 'and it is stored beside the attempt');
  eq(DB.read('provisionalGrades', id).freezeId, openFreeze(id).id,
    'stamped with the pause it describes');

  // The student clears their own pause and keeps working.
  advance(min(1));
  await call(fns.reportExtensionCheck, { attemptId: id, passed: true, found: [] }, STUDENT());
  await call(fns.verifyAndResume, { attemptId: id }, STUDENT());
  eq(A(id).status, 'in_progress', 'the sitting resumes');

  check(!DB.has('provisionalGrades', id),
    'the provisional grade does not outlive the pause it describes',
    DB.has('provisionalGrades', id)
      ? `a score of ${JSON.stringify(DB.read('provisionalGrades', id).scores)} survives on a live attempt`
      : undefined);

  // The control: the invigilator release already does this, and must keep
  // doing it — this probe must fail for the right function.
  advance(min(1));
  await call(fns.freezeAttempt, { attemptId: id }, STAFF());
  await call(fns.gradeProvisional, { attemptId: id }, STAFF());
  check(DB.has('provisionalGrades', id), 'a second pause takes a fresh provisional grade');
  advance(min(1));
  await call(fns.unfreezeAttempt, { attemptId: id, grantedMs: min(1) }, STAFF());
  check(!DB.has('provisionalGrades', id), 'and the invigilator release still clears it');
}

// ═══════════════════════════════════════════════════════════════════
// C-04 · a paused student can still write answers, with the clock stopped
//
// F5 named the rule: "A pause is a state the student cannot write from." It is
// why openFreezeUpdates moved `status` to 'frozen' — because a pause that stops
// the clock but not the student "is an unbounded time grant to anyone willing
// to call the callable directly."
//
// Three of the four student write paths obey it. firestore.rules require
// in_progress on both sides of a standard-mode answer write; submitAnswerAnd
// Advance refuses anything but in_progress; runCodeSample refuses an open
// freeze in as many words. saveAnswerNoAdvance accepts 'frozen' — deliberately,
// and for a good reason that has a shape: the client learns of the freeze
// through its subscription, so a flush already in flight lands just after the
// pause and must not be lost.
//
// What was never bounded is HOW LONG "just after" lasts. And the window is not
// merely open, it is untimed: effectiveNowMs pins the resolver's clock at the
// freeze, so assertSequentialAnswerWindowOpen — the A-03 gate — cannot refuse a
// paused student either. A student frozen at 9:01 of a 30-minute section is
// still writing new answers into it at 9:41.
//
// This is A-03's shape again: sequential delivery, the MORE controlled mode, is
// the weaker one. And it has a second edge — recordCodeTelemetry refuses a
// paused attempt, so on a coding paper the answer keeps changing while the
// record of how it was produced has a hole exactly there.
// ═══════════════════════════════════════════════════════════════════
async function C04() {
  const id = await startAndVerify({ deliveryMode: 'linear', questionTimeLimit: 300 });
  const served = A(id).servedQuestions ?? [];
  const qid = served[served.length - 1]?.questionId;
  check(!!qid, 'linear delivery served the first question', `served: ${JSON.stringify(served)}`);

  advance(min(1));
  await call(fns.freezeAttempt, { attemptId: id, reason: 'suspected phone use' }, STAFF());
  eq(A(id).status, 'frozen', 'an invigilator paused the sitting');

  // THE DOCUMENTED CASE, and it must keep working: a flush already in flight
  // when the pause landed. Refusing this is what the 'frozen' allowance exists
  // to prevent, so the fix must not close it.
  advance(sec(2));
  const inFlight = await call(fns.saveAnswerNoAdvance,
    { attemptId: id, questionId: qid, answer: { type: 'mcq', value: 'alpha' } }, STUDENT());
  eq(inFlight.saved, true, 'a flush already in flight when the pause landed is still saved');
  eq(A(id).answers[qid].value, 'alpha', 'and it lands on the attempt');

  // FORTY MINUTES LATER, past the section limit, still paused. Nothing about
  // this is a flush in flight.
  advance(min(40));
  await expectThrow('a paused student cannot keep writing answers into the pause',
    () => call(fns.saveAnswerNoAdvance,
      { attemptId: id, questionId: qid, answer: { type: 'mcq', value: 'beta' } }, STUDENT()),
    'ATTEMPT_PAUSED');
  eq(A(id).answers[qid].value, 'alpha',
    'and the answer they had when the pause landed is the answer that stands');

  // The telemetry asymmetry this closes, measured rather than asserted from
  // the source: the record refuses what the answer accepted.
  await expectThrow('telemetry was already refused for the same paused attempt',
    () => call(fns.recordCodeTelemetry,
      { attemptId: id, questionId: qid, seq: 0, events: [{ t: 1, k: 'x' }] }, STUDENT()),
    'not in progress');

  // The control: released, the same call works again. The gate is the pause,
  // not the student.
  await call(fns.unfreezeAttempt, { attemptId: id, grantedMs: min(41) }, STAFF());
  eq(A(id).status, 'in_progress', 'the invigilator releases the sitting');
  const after = await call(fns.saveAnswerNoAdvance,
    { attemptId: id, questionId: qid, answer: { type: 'mcq', value: 'beta' } }, STUDENT());
  eq(after.saved, true, 'and the student can write again');
  eq(A(id).answers[qid].value, 'beta', 'with the new answer stored');
}

// ═══════════════════════════════════════════════════════════════════
// C-05 · what must NOT change — the auto-resume path still works
//
// Every fix in this round narrows verifyAndResume. This probe is the other
// half: the ordinary case it exists for — an antivirus false positive, cleared
// in ninety seconds by the student themselves — must still resume, still be
// credited, and still cost nobody a sitting.
// ═══════════════════════════════════════════════════════════════════
async function C05() {
  const id = await startAndVerify();
  const born = lockMs(A(id).overallLockedAfter);

  advance(min(3));
  await call(fns.reportExtensionCheck, { attemptId: id, passed: false, found: ['ext_x'] }, STUDENT());
  eq(A(id).status, 'frozen', 'the automatic check paused the sitting');

  advance(sec(90));
  await call(fns.reportExtensionCheck, { attemptId: id, passed: true, found: [] }, STUDENT());
  const out = await call(fns.verifyAndResume, { attemptId: id }, STUDENT());

  eq(out.resumed, true, 'the student clears a genuine short pause themselves');
  eq(A(id).status, 'in_progress', 'the sitting resumes');
  near(out.grantedMs ?? 0, sec(90), sec(1), 'and the pause is granted in full');
  near(lockMs(A(id).overallLockedAfter) - born, sec(90), sec(1),
    'the deadline moves by exactly what the pause cost them');
  eq(A(id).freezeState.frozen, false, 'the legacy freeze flag is cleared');
  eq(A(id).resumeRequiresVerification, false, 'and so is the verification flag');
  check(A(id).frozenAt === undefined, 'the legacy frozenAt mirror is deleted');
  check(auditRows('attemptUnfrozen').length === 1,
    'the release is recorded even when nobody but the student was involved');

  // Auto-resume OFF is still a hard stop, and a failing check is still a
  // refusal — B-09's intent, on a tier where the freeze actually happens.
  const id2 = await (async () => {
    DB = new FakeDb(); VNOW = Date.parse('2026-08-01T09:00:00.000Z');
    return startAndVerify({ autoResume: false });
  })();
  advance(min(1));
  await call(fns.reportExtensionCheck, { attemptId: id2, passed: false, found: ['ext_x'] }, STUDENT());
  eq(A(id2).status, 'frozen', 'a normal-tier check freezes when auto-resume is off too');
  await call(fns.reportExtensionCheck, { attemptId: id2, passed: true, found: [] }, STUDENT());
  await expectThrow('with auto-resume off the student still cannot self-resume',
    () => call(fns.verifyAndResume, { attemptId: id2 }, STUDENT()),
    'RESUME_BLOCKED');
  eq(A(id2).status, 'frozen', 'and they stay paused until staff act');

  KNOWN_GAPS.push(
    'C-01\'s transactional half is not asserted. verifyAndResume read the attempt, '
    + 'computed the whole closed ledger from it and wrote the array back with a plain '
    + 'update() — the read-modify-write that reportExtensionCheck was made transactional '
    + 'to avoid ("an append read-modify-written outside a transaction can lose a '
    + 'concurrent entry"). The release is transactional now, but fakeFirestore commits '
    + 'transactions with no read set, so this suite would pass either way. '
    + 'test/concurrency.suite.cjs against the emulator is what can prove it, exactly as '
    + 'round 3 recorded for B-13/B-14.',
  );
}

// ═══════════════════════════════════════════════════════════════════
const SCENARIOS = [
  ['C-01', 'the freeze authority ladder has no back door', C01],
  ['C-02', 'a self-cleared pause cannot mint unbounded time', C02],
  ['C-03', 'a provisional grade dies with its pause', C03],
  ['C-04', 'a paused student cannot write into the pause', C04],
  ['C-05', 'the ordinary auto-resume still works', C05],
];

(async () => {
  for (const [id, title, fn] of SCENARIOS) await scenario(id, title, fn);

  const C = { r: '\x1b[31m', g: '\x1b[32m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
  let pass = 0, fail = 0;
  console.log(`\n${C.b}AUDIT PROBE SUITE — ROUND 4${C.x}  —  real callables, in-memory Firestore, virtual clock\n`);
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
