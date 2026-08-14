// ═══════════════════════════════════════════════════════════════════════════
// AUDIT PROBE SUITE  —  end-to-end integrity audit, 2026-08-03
//
// Same evidentiary standard as exam.e2e.cjs and freeze.suite.cjs: every check
// drives the COMPILED PRODUCTION CALLABLES (functions/lib/index.js) against an
// in-memory Firestore and a virtual clock. Nothing here re-implements a
// deadline, a lock or a mark — every number asserted on was written by a real
// handler.
//
//   node test/audit.probe.cjs
//
// These probes were written to FAIL if the defect they describe is present.
// A green run means the property holds; a red one names the property that does
// not.
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

process.env.GCLOUD_PROJECT = 'demo-audit-probe';
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

const A = (id) => DB.read('attempts', id);
const lockMs = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : (v ? Date.parse(v) : null));

// Standard-mode client answer write: the rules-shaped patch (answers+updatedAt).
// The fake db has no rules engine, so `rulesWouldAllowAnswer` below is the
// explicit model of firestore.rules' answerWriteWindowOpen().
function clientAnswer(attemptId, qid, value, sectionId) {
  const att = DB.read('attempts', attemptId);
  att.answers[qid] = { type: 'mcq', value, sectionId, answeredAt: at(VNOW) };
  att.updatedAt = at(VNOW);
  DB.seed('attempts', attemptId, att);
}
// firestore.rules:754 answerWriteWindowOpen(), transcribed.
function rulesWouldAllowAnswer(attemptId, nowMs = VNOW) {
  const att = A(attemptId);
  if (att.status !== 'in_progress' && att.status !== 'frozen') return false;
  const lock = lockMs(att.answersLockedAfter);
  return lock === null || nowMs < lock;
}

function seedWorld(opts = {}) {
  DB.seed('students', 'stu_1', { id: 'stu_1', name: 'Test Student', instituteId: 'inst_1' });
  const asmt = {
    id: 'asmt_1',
    title: 'Probe Paper',
    instituteId: 'inst_1',
    status: opts.status ?? 'active',
    startDate: opts.startDate ?? at(VNOW - min(60)),
    endDate: 'endDate' in opts ? opts.endDate : at(VNOW + min(600)),
    maxAttempts: opts.maxAttempts ?? 1,
    overallTimeLimit: 'overallTimeLimit' in opts ? opts.overallTimeLimit : 60,
    overallGraceSeconds: opts.overallGraceSeconds,
    sectionGraceSeconds: opts.sectionGraceSeconds,
    deliveryMode: opts.deliveryMode ?? 'standard',
    sectionStartOrder: opts.sectionStartOrder ?? 'sequential',
    securityTier: 'mock',
    requireCamera: false, allowMobile: true, requireExtensionCheck: false, requireSEB: false,
    securityLockedAt: at(VNOW - min(120)),
    passingScore: 40,
    assignedTo: { type: 'all' },
    gradingConfig: opts.gradingConfig,
    sections: [
      {
        id: 'SA', name: 'A',
        timeLimit: 'sectionATimeLimit' in opts ? opts.sectionATimeLimit : 30,
        questionTimeLimit: opts.questionTimeLimit,
        breakAfter: opts.breakAfter,
        questions: [
          { questionId: 'q1', marks: 10, order: 0 },
          { questionId: 'q2', marks: 10, order: 1 },
        ],
      },
      {
        id: 'SB', name: 'B',
        timeLimit: 'sectionBTimeLimit' in opts ? opts.sectionBTimeLimit : 20,
        questionTimeLimit: opts.questionTimeLimit,
        questions: [{ questionId: 'q3', marks: 20, order: 0 }],
      },
    ],
  };
  DB.seed('assessments', 'asmt_1', asmt);
  for (const q of ['q1', 'q2', 'q3']) {
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

// ═══════════════════════════════════════════════════════════════════
// P-01 · a recorded penalty survives the next section advance
//
// unfreezeAttempt writes penalty rows and re-materialises the locks with them
// applied. Every LATER recompute of those locks goes through toCoreAttempt.
// If that mapper drops `penalties`, the deduction is silently refunded at the
// next boundary — an invigilator's decision undone by ordinary progress.
// ═══════════════════════════════════════════════════════════════════
async function P01() {
  seedWorld({ overallTimeLimit: 120, sectionATimeLimit: 60, sectionBTimeLimit: 40 });
  const t0 = VNOW;
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  near(lockMs(A(id).overallLockedAfter), t0 + min(120) + sec(30), 1000,
    'overall lock at birth = 120m + 30s grace');

  // Freeze at +10m, release at +12m granting nothing, but deducting 5 minutes
  // from the OVERALL clock.
  advance(min(10));
  await call(fns.freezeAttempt, { attemptId: id, reason: 'probe' }, STAFF());
  advance(min(2));
  await call(fns.unfreezeAttempt,
    { attemptId: id, grantedMs: 0, penalties: { overallMs: min(5) } }, STAFF());

  const penalised = A(id);
  eq(Array.isArray(penalised.penalties) && penalised.penalties.length, 1,
    'unfreeze recorded exactly one penalty row');
  near(lockMs(penalised.overallLockedAfter), t0 + min(120) + sec(30) - min(5), 1500,
    'overall lock moved 5m earlier at unfreeze (the deduction lands)');

  // getExamVerdict is what the student's screen renders. It must show the
  // penalised deadline, not the original one.
  const v = await call(fns.getExamVerdict, { attemptId: id }, STUDENT());
  near(v.verdict.deadlines.overallEndsAt, t0 + min(120) + sec(30) - min(5), 1500,
    'getExamVerdict reports the PENALISED overall deadline');

  // Ordinary progress: finish SA, advance to SB. This recomputes the locks.
  advance(min(3));
  await call(fns.submitSection,
    { attemptId: id, sectionId: 'SA', nextSectionId: 'SB', nextSectionIdx: 1 }, STUDENT());

  near(lockMs(A(id).overallLockedAfter), t0 + min(120) + sec(30) - min(5), 1500,
    'the deduction SURVIVES the section advance (not refunded)');
}

// ═══════════════════════════════════════════════════════════════════
// P-02 · submitSection cannot be used to re-arm the answer-write lock
//
// `nextSectionId` is caller-supplied and is written straight to
// sectionTimings.<id>.startedAt, then used to re-anchor answersLockedAfter.
// Naming the section being submitted (or any other) would hand the student a
// fresh full-length write window on demand.
// ═══════════════════════════════════════════════════════════════════
async function P02() {
  // No overall limit: the section clock is the only bound, so a reset is
  // unbounded rather than merely generous.
  seedWorld({ overallTimeLimit: undefined, sectionATimeLimit: 30, sectionBTimeLimit: 30 });
  const t0 = VNOW;
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  near(lockMs(A(id).answersLockedAfter), t0 + min(30) + sec(30), 1000,
    'answer window closes 30m + grace after start');

  advance(min(25));
  // The forged call: submit SA but name SA itself as the next section.
  let threw = false;
  try {
    await call(fns.submitSection,
      { attemptId: id, sectionId: 'SA', nextSectionId: 'SA', nextSectionIdx: 0 }, STUDENT());
  } catch (e) { threw = true; }

  const after = A(id);
  const lock = lockMs(after.answersLockedAfter);
  check(threw || lock === null || lock <= t0 + min(30) + sec(30) + 1000,
    'naming the CURRENT section as `nextSectionId` does not re-arm the write lock',
    threw ? 'rejected' : `lock moved to +${Math.round((lock - t0) / 60000)}m`);

  // And the section's own start instant must never be rewritten (INV-9).
  eq(after.sectionTimings.SA.startedAt, at(t0),
    "SA's startedAt is not rewritten by the forged advance (INV-9)");
}

// ═══════════════════════════════════════════════════════════════════
// P-03 · every section id is validated against the attempt's played set
//
// Nothing checks membership, so a caller may name a section that does not
// exist, or jump past one, or re-open one already submitted.
//
// WIDENED (F-01, audit 2026-08-09). A-02 gave submitSection this check for
// `nextSectionId` only. startSection performs the SAME transition and never
// acquired it, and the damage was not the stray timing row: the lock
// recompute resolves a section's time limit BY ID against the frozen
// contract, so a section the contract has never heard of has no limit,
// sectionDeadlineMs returns null, and the section bound drops out of
// answersLockedAfter entirely. Measured before the fix, on a paper with
// 30-minute sections, no overall cap and a week-long window: the
// answer-write deadline moved from +30:30 to +7 days on one call.
//
// Three ids, one rule — the target of an advance, the section being entered,
// and the section being closed.
// ═══════════════════════════════════════════════════════════════════
async function P03() {
  seedWorld();
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  advance(min(2));
  await expectThrow('a `nextSectionId` outside the attempt is rejected',
    () => call(fns.submitSection,
      { attemptId: id, sectionId: 'SA', nextSectionId: 'GHOST', nextSectionIdx: 9 }, STUDENT()),
    '');

  const after = A(id);
  check(!after.sectionTimings.GHOST,
    'no timing row is created for a section that is not in the attempt',
    JSON.stringify(after.sectionTimings.GHOST ?? null));
  check(after.currentSectionIdx !== 9,
    'currentSectionIdx is not set from the caller-supplied index',
    `currentSectionIdx=${after.currentSectionIdx}`);

  // ── F-01 · the section being ENTERED ──────────────────────────────
  await expectThrow('submitSection rejects a `sectionId` outside the attempt',
    () => call(fns.submitSection, { attemptId: id, sectionId: 'GHOST' }, STUDENT()),
    'SECTION_SUBMIT_INVALID');

  // Close SA honestly so no section is open — the state F-01 needed.
  await call(fns.submitSection, { attemptId: id, sectionId: 'SA' }, STUDENT());
  const lockAfterClose = lockMs(A(id).answersLockedAfter);

  await expectThrow('startSection rejects a `sectionId` outside the attempt',
    () => call(fns.startSection, { attemptId: id, sectionId: 'PHANTOM' }, STUDENT()),
    'SECTION_START_INVALID');

  const post = A(id);
  check(!post.sectionTimings.PHANTOM,
    'the refused start leaves no timing row behind',
    JSON.stringify(post.sectionTimings.PHANTOM ?? null));
  eq(lockMs(post.answersLockedAfter), lockAfterClose,
    'and the answer-write lock is exactly where it was — no unbounded window');
  check(post.currentSectionIdx >= 0,
    'currentSectionIdx never becomes -1 from an indexOf miss',
    `currentSectionIdx=${post.currentSectionIdx}`);
}

// ═══════════════════════════════════════════════════════════════════
// P-04 · sequential delivery enforces the section/overall clocks
//
// In standard delivery firestore.rules refuse an answer past
// answersLockedAfter. In linear/adaptive the client cannot write answers at
// all — they go through submitAnswerAndAdvance, which runs as Admin and so
// bypasses rules. If that callable checks only the QUESTION clock, sequential
// delivery is the weaker mode: the section and overall deadlines stop applying
// to answers entirely.
// ═══════════════════════════════════════════════════════════════════
async function P04() {
  seedWorld({
    deliveryMode: 'linear', questionTimeLimit: 120,
    sectionATimeLimit: 10, sectionBTimeLimit: 10, overallTimeLimit: 20,
  });
  const t0 = VNOW;
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  // Walk away well past BOTH the section (10m) and overall (20m) deadlines.
  advance(min(45));
  eq(rulesWouldAllowAnswer(id), false,
    'the materialised write lock has expired (standard mode would refuse)');

  const verdict = await call(fns.getExamVerdict, { attemptId: id }, STUDENT());
  eq(verdict.verdict.kind, 'ended', 'the resolver agrees the sitting is over');

  // saveAnswerNoAdvance first — it does not move the served pointer, so both
  // probes are asked about the same live question.
  let savedToo = true;
  try {
    await call(fns.saveAnswerNoAdvance,
      { attemptId: id, questionId: 'q1', answer: { type: 'mcq', value: 'beta' } }, STUDENT());
  } catch (e) { savedToo = false; }
  check(!savedToo,
    'saveAnswerNoAdvance refuses an answer 25 minutes past the OVERALL deadline',
    savedToo ? `answer was stored: ${JSON.stringify(A(id).answers.q1)}` : undefined);

  let accepted = true;
  try {
    await call(fns.submitAnswerAndAdvance,
      { attemptId: id, questionId: 'q1', answer: { type: 'mcq', value: 'alpha' } }, STUDENT());
  } catch (e) { accepted = false; }
  check(!accepted,
    'submitAnswerAndAdvance refuses the same late answer',
    accepted ? `answer was stored: ${JSON.stringify(A(id).answers.q1)}` : undefined);
}

// ═══════════════════════════════════════════════════════════════════
// P-05 · the availability window bounds ANSWER WRITES, not just the sweep
//
// resolve() treats endDate as a hard outer wall (R2/A10). computeAttemptLocks
// deliberately excludes it, so between endDate and the overall deadline the
// only thing standing between a student and further answers is the hourly
// sweep.
// ═══════════════════════════════════════════════════════════════════
async function P05() {
  // Window shuts at +20m; the student's own overall clock runs to +180m.
  seedWorld({ overallTimeLimit: 180, sectionATimeLimit: 180, sectionBTimeLimit: 180,
    endDate: at(VNOW + min(20)) });
  const t0 = VNOW;
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  advance(min(30));   // 10 minutes past the window
  const verdict = await call(fns.getExamVerdict, { attemptId: id }, STUDENT());
  eq(verdict.verdict.kind, 'ended', 'the resolver says the window has closed');
  eq(verdict.verdict.reason, 'window_closed', 'and names the window as the reason');

  check(!rulesWouldAllowAnswer(id),
    'the materialised lock refuses answers once the availability window has shut',
    `answersLockedAfter=+${Math.round((lockMs(A(id).answersLockedAfter) - t0) / 60000)}m, ` +
    `window closed at +20m`);
}

// ═══════════════════════════════════════════════════════════════════
// P-06 · negative marking never fires on a partially-correct answer
//
// scoreAttemptAnswers documents the rule in as many words: "negative marking
// applies ONLY to a FULLY wrong answer (multiplier 0). Any correct/partial
// content keeps its positive award untouched." For multi-select,
// scoreMCQMultiplier computes (hits - wrongs)/|correct| and floors at 0, so a
// student with one right and one wrong lands on multiplier 0 — indistinguishable
// from having picked nothing right at all.
// ═══════════════════════════════════════════════════════════════════
async function P06() {
  seedWorld({
    gradingConfig: {
      exam: { negativeMarking: true, penaltyType: 'fixed', penaltyValue: 5, blankScore: 0 },
    },
  });
  // q1 becomes a multi-select worth 10, correct = {alpha, beta}.
  DB.seed('questions', 'q1', {
    id: 'q1', engine: 'mcq', variant: 'multi', question: 'Multi',
    options: [{ id: 'alpha' }, { id: 'beta' }, { id: 'gamma' }],
    difficulty: 'medium',
  });
  DB.seed('questionAnswers', 'q1', {
    id: 'q1', correctIds: ['alpha', 'beta'], correctPairs: [], modelAnswer: '',
  });

  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  // One right (alpha), one wrong (gamma). Partial content, by any reading.
  const att = A(id);
  att.answers.q1 = { type: 'mcq', value: ['alpha', 'gamma'], sectionId: 'SA', answeredAt: at(VNOW) };
  DB.seed('attempts', id, att);

  advance(min(1));
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());
  const awarded = A(id).gradedAnswers.q1.marksAwarded;

  check(awarded >= 0,
    'a partially-correct multi-select is not scored as a fully wrong answer',
    `marksAwarded=${awarded} (one of two correct options selected, one wrong)`);

  // The blank case is the control: it must never take the wrong-answer penalty.
  eq(A(id).gradedAnswers.q2.marksAwarded, 0,
    'an unattempted question takes blankScore, never the penalty');
}

// ═══════════════════════════════════════════════════════════════════
// P-07 · gradeAttempt does not write caller-named section timing keys
//
// `lastSectionId` / `lastSectionTimeUsed` come from request.data and are
// written as a dot-path onto sectionTimings without being checked against the
// attempt's own section set.
// ═══════════════════════════════════════════════════════════════════
async function P07() {
  seedWorld();
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  advance(min(1));
  await call(fns.gradeAttempt, {
    attemptId: id, reason: 'manual',
    lastSectionId: 'NOT_A_SECTION', lastSectionTimeUsed: 999999,
  }, STUDENT());

  const done = A(id);
  check(!done.sectionTimings.NOT_A_SECTION,
    'a caller-named section id does not create a timing row',
    JSON.stringify(done.sectionTimings.NOT_A_SECTION ?? null));
}

// ═══════════════════════════════════════════════════════════════════
// P-08 · a terminated attempt cannot be re-terminated with new reason text
//   and the attempt limit counts terminations
// ═══════════════════════════════════════════════════════════════════
async function P08() {
  seedWorld({ maxAttempts: 2 });
  const s1 = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id1 = s1.attempt.id;

  advance(min(1));
  await call(fns.gradeAttempt,
    { attemptId: id1, reason: 'terminated', terminateReason: 'integrity_limit' }, STUDENT());
  eq(A(id1).status, 'terminated', 'first attempt terminates');

  const again = await call(fns.gradeAttempt,
    { attemptId: id1, reason: 'terminated', terminateReason: 'ATTACKER_TEXT' }, STUDENT());
  eq(again.alreadyFinalized, true, 're-terminating is an idempotent no-op');
  eq(A(id1).integrityLog.terminatedReason, 'integrity_limit',
    'the original terminate reason is not overwritten');

  // Second sitting is allowed (2 of 2), a third is not.
  const s2 = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  check(s2.attempt.id !== id1, 'a second attempt is granted under maxAttempts=2');
  advance(min(1));
  await call(fns.gradeAttempt, { attemptId: s2.attempt.id, reason: 'manual' }, STUDENT());
  await expectThrow('a third sitting is refused',
    () => call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT()),
    'ATTEMPT_LIMIT_EXCEEDED');
}

// ═══════════════════════════════════════════════════════════════════
// P-09 · escape mid-exam: leave, come back after the section clock ran out
//
// The student closes the tab in SA and returns after SA's deadline but well
// inside the overall clock. Section expiry must ADVANCE, never end the sitting,
// and the write lock must follow the section they are moved into.
// ═══════════════════════════════════════════════════════════════════
async function P09() {
  seedWorld({ overallTimeLimit: 180, sectionATimeLimit: 10, sectionBTimeLimit: 30 });
  const t0 = VNOW;
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  advance(min(3)); clientAnswer(id, 'q1', 'alpha', 'SA');
  advance(min(20));  // gone for 20 minutes; SA (10m) is long over, overall is not

  const v = await call(fns.getExamVerdict, { attemptId: id }, STUDENT());
  eq(v.verdict.kind, 'section', 'section expiry advances rather than ending the sitting');
  eq(v.verdict.sectionId, 'SB', 'and the student is moved to SB');
  eq(v.verdict.started, false, 'SB has not started yet');

  // The answer written before the walk-away survives.
  eq(A(id).answers.q1.value, 'alpha', 'work done before the escape is intact');

  // SA is still OPEN (expired, never submitted), so the resolver's advance is
  // not reachable through startSection — INV-1 refuses it. The route back in
  // is the late-submit branch of submitSection, which closes SA at its own
  // deadline and starts SB before signalling the lateness.
  await expectThrow('startSection alone cannot act on the advance verdict',
    () => call(fns.startSection, { attemptId: id, sectionId: 'SB' }, STUDENT()),
    'SECTION_STILL_OPEN');

  let late = null;
  try {
    await call(fns.submitSection,
      { attemptId: id, sectionId: 'SA', nextSectionId: 'SB', nextSectionIdx: 1 }, STUDENT());
  } catch (e) { late = e; }
  check(!!late && String(late.message).includes('SECTION_DEADLINE_EXCEEDED'),
    'the late submit reports the section deadline was exceeded',
    late ? late.message : 'no error');

  const after = A(id);
  eq(after.sectionTimings.SA.submittedAt, at(t0 + min(10) + sec(30)),
    'SA is closed AT ITS OWN DEADLINE, not at the late arrival instant');
  check(!!after.sectionTimings.SB.startedAt,
    'SB is started in the same write, so the student is not stranded');
  near(lockMs(after.sectionLockedAfter), VNOW + min(30) + sec(30), 1500,
    'the write lock re-anchors to SB (D-01)');
  check(rulesWouldAllowAnswer(id), 'answers are writable again inside SB');
}

// ═══════════════════════════════════════════════════════════════════
// P-10 · escape DURING submission
//
// The client calls submitSection, the tab dies before gradeAttempt lands. The
// attempt is left with every section submitted and no terminal status. The
// sweep must finish it, and the student must not be able to keep answering in
// the meantime.
// ═══════════════════════════════════════════════════════════════════
async function P10() {
  seedWorld({ overallTimeLimit: 60, sectionATimeLimit: 20, sectionBTimeLimit: 20 });
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  advance(min(5)); clientAnswer(id, 'q1', 'alpha', 'SA');
  await call(fns.submitSection,
    { attemptId: id, sectionId: 'SA', nextSectionId: 'SB', nextSectionIdx: 1 }, STUDENT());
  advance(min(5)); clientAnswer(id, 'q3', 'alpha', 'SB');
  // Last section submitted; the tab dies here, before gradeAttempt.
  await call(fns.submitSection, { attemptId: id, sectionId: 'SB' }, STUDENT());

  const stranded = A(id);
  eq(stranded.status, 'in_progress', 'the attempt is left live with no sections remaining');

  const v = await call(fns.getExamVerdict, { attemptId: id }, STUDENT());
  eq(v.verdict.kind, 'ended', 'the resolver calls a sitting with no sections left over');

  // The student comes back an hour later and tries to answer.
  advance(min(60));
  check(!rulesWouldAllowAnswer(id),
    'no further answers are writable once every section is submitted');

  await fns.scheduledCloseExpiredAttempts.run({});
  const swept = A(id);
  check(['auto_submitted', 'submitted', 'terminated'].includes(swept.status),
    'the sweep finalises the stranded attempt', `status=${swept.status}`);
  check(swept.scores !== undefined, 'and it is graded (INV-10)');
}

// ═══════════════════════════════════════════════════════════════════
// P-11 · a frozen student is passive but not lost
//
// The "student passive but not frozen" case and its mirror. examHeartbeat is
// what tells the roster a student is alive; a frozen attempt must not be
// reported as merely idle, and an idle attempt must not be reported as frozen.
// ═══════════════════════════════════════════════════════════════════
async function P11() {
  seedWorld({ overallTimeLimit: 180, sectionATimeLimit: 120 });
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  // Passive-not-frozen: no heartbeat for 20 minutes, nothing else changes.
  advance(min(20));
  const idle = A(id);
  eq(idle.status, 'in_progress', 'an idle student stays in_progress');
  check(!idle.frozenAt, 'an idle student is not marked frozen');
  const v1 = await call(fns.getExamVerdict, { attemptId: id }, STUDENT());
  eq(v1.verdict.kind, 'section', 'and their clocks have kept running');

  // Heartbeat resumes; the attempt is untouched apart from the beat.
  const beat = await call(fns.examHeartbeat, { attemptId: id }, STUDENT());
  eq(beat.ok, true, 'a late heartbeat is accepted');
  check(!!A(id).lastHeartbeatAt, 'lastHeartbeatAt is recorded');
  eq(A(id).status, 'in_progress', 'a heartbeat does not change status');

  // Now freeze: the student is passive AND frozen, and the two are
  // distinguishable in the stored state.
  await call(fns.freezeAttempt, { attemptId: id, reason: 'probe' }, STAFF());
  const frozen = A(id);
  eq(frozen.status, 'frozen', 'a paused sitting is status frozen');
  check(!!frozen.frozenAt, 'and carries frozenAt for the roster');
  const openEntries = (frozen.freezes ?? []).filter((f) => !f.endedAt);
  eq(openEntries.length, 1, 'exactly one open ledger entry');

  // A frozen student cannot keep working.
  await expectThrow('a frozen student cannot submit a section',
    () => call(fns.submitSection, { attemptId: id, sectionId: 'SA' }, STUDENT()),
    'not in progress');
  await expectThrow('a frozen student cannot finalise their own sitting',
    () => call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT()),
    'ATTEMPT_PAUSED');
}

// ═══════════════════════════════════════════════════════════════════
// P-12 · freeze penalties are capped, recorded and never silently reversible
// ═══════════════════════════════════════════════════════════════════
async function P12() {
  seedWorld({ overallTimeLimit: 60, sectionATimeLimit: 30 });
  const t0 = VNOW;
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  advance(min(5));
  await call(fns.freezeAttempt, { attemptId: id }, STAFF());
  advance(min(3));

  // Ask for a deduction far larger than the clock has left.
  const out = await call(fns.unfreezeAttempt, {
    attemptId: id, grantedMs: min(3),
    penalties: { sectionMs: min(600), overallMs: min(600) },
  }, STAFF());
  eq(out.grantedMs, min(3), 'the full pause was granted');

  const after = A(id);
  const secPen = (after.penalties ?? []).find((p) => p.clock === 'section');
  const ovrPen = (after.penalties ?? []).find((p) => p.clock === 'overall');
  check(!!secPen && secPen.amountMs <= min(30) + sec(60),
    'the section deduction is capped at what the section clock had left',
    `amountMs=${secPen?.amountMs}`);
  check(!!ovrPen && ovrPen.amountMs <= min(60) + sec(60),
    'the overall deduction is capped at what the overall clock had left',
    `amountMs=${ovrPen?.amountMs}`);
  check((after.penalties ?? []).every((p) => p.decidedBy && p.decidedAt),
    'every penalty row names an actor and an instant');

  // A deduction can never push a deadline before now — A4's "no arithmetic
  // that can go negative".
  const dlOverall = lockMs(after.overallLockedAfter);
  check(dlOverall === null || dlOverall >= VNOW,
    'the penalised overall deadline is not already in the past',
    `overallLockedAfter=${dlOverall}, now=${VNOW}`);
}

// ═══════════════════════════════════════════════════════════════════
// P-13 · grace is honoured, and configured grace beats the default
// ═══════════════════════════════════════════════════════════════════
async function P13() {
  seedWorld({
    sectionATimeLimit: 10, overallTimeLimit: 600,
    sectionGraceSeconds: 90, overallGraceSeconds: 120,
  });
  const t0 = VNOW;
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  near(lockMs(A(id).sectionLockedAfter), t0 + min(10) + sec(90), 1000,
    'the configured 90s section grace is used, not the 30s default');
  near(lockMs(A(id).overallLockedAfter), t0 + min(600) + sec(120), 1000,
    'the configured 120s overall grace is used');

  // Inside grace: a submit at +10m30s is on time.
  advance(min(10) + sec(30));
  const ok = await call(fns.submitSection,
    { attemptId: id, sectionId: 'SA', nextSectionId: 'SB', nextSectionIdx: 1 }, STUDENT());
  eq(ok.ok, true, 'a submit 30s past the limit lands inside the 90s grace');

  // Outside grace on the next section: SB is 20m + 90s.
  advance(min(22));
  await expectThrow('a submit past limit + grace is refused',
    () => call(fns.submitSection, { attemptId: id, sectionId: 'SB' }, STUDENT()),
    'SECTION_DEADLINE_EXCEEDED');
  eq(A(id).sectionTimings.SB.submittedAt !== undefined, true,
    'and the late section is still closed so the student cannot get stuck');
}

// ═══════════════════════════════════════════════════════════════════
// P-14 · mandatory break cannot be skipped, by any route
//
// "By any route" has been wrong twice. D-22 closed two (starting a section
// while another was open; reordering an unplayed section to index 0). F-02
// (audit 2026-08-09) was the third and needed neither: breaks are resolved
// POSITIONALLY, from sectionIds.indexOf(sectionId), and a section that is not
// in the attempt indexes to -1 — which reads as "no break is due" rather than
// as "that section does not exist". Inserting a phantom section between SA and
// SB therefore walked straight through the gate.
//
// It is fixed at the source (P-03: no phantom section can be created), and
// asserted here as well, because the thing that made it dangerous is local to
// this gate: a -1 index means NOTHING IS DUE, which is the most permissive
// answer the break schedule can give and the one it gives on bad input.
// ═══════════════════════════════════════════════════════════════════
async function P14() {
  seedWorld({ breakAfter: { durationMinutes: 10, mandatory: true } });
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  advance(min(5));
  const sub = await call(fns.submitSection,
    { attemptId: id, sectionId: 'SA', nextSectionId: 'SB', nextSectionIdx: 1 }, STUDENT());
  check(!!sub.breakDue, 'the server reports a break is due');
  eq(A(id).sectionTimings.SB.startedAt || '', '',
    'the server refused to auto-start SB despite the client not asking to pause');

  await expectThrow('entering the next section during a mandatory break is refused',
    () => call(fns.startSection, { attemptId: id, sectionId: 'SB' }, STUDENT()),
    'Mandatory break');

  // ── F-02 · the phantom-section route ──────────────────────────────
  // Step one is refused, so step two is unreachable. Both are asserted: if a
  // later change ever lets the start through, this says which half broke.
  await expectThrow('a phantom section cannot be opened to sidestep the break',
    () => call(fns.startSection, { attemptId: id, sectionId: 'PHANTOM' }, STUDENT()),
    'SECTION_START_INVALID');
  await expectThrow('nor submitted as a way of advancing past it',
    () => call(fns.submitSection,
      { attemptId: id, sectionId: 'PHANTOM', nextSectionId: 'SB' }, STUDENT()),
    'SECTION_SUBMIT_INVALID');
  eq(A(id).sectionTimings.SB.startedAt || '', '',
    'SB is still unstarted — the break was not skipped');

  advance(min(10) + sec(5));
  const st = await call(fns.startSection, { attemptId: id, sectionId: 'SB' }, STUDENT());
  eq(st.ok, true, 'SB opens once the break has elapsed');
}

// ═══════════════════════════════════════════════════════════════════
// P-15 · a superseded device cannot drive the sitting
// ═══════════════════════════════════════════════════════════════════
async function P15() {
  seedWorld();
  const started = await call(fns.startExam,
    { assessmentId: 'asmt_1', sessionId: 'sess_A' }, STUDENT());
  const id = started.attempt.id;
  eq(A(id).activeSessionId, 'sess_A', 'the opening session owns the attempt from birth');

  const reg = await call(fns.registerSession,
    { attemptId: id, sessionId: 'sess_B' }, STUDENT());
  eq(reg.conflict, true, 'a second device is recorded as a conflict');
  check(!!A(id).sessionConflictAt, 'and the conflict instant is stored server-side');

  advance(min(1));
  await expectThrow('the superseded device cannot submit a section',
    () => call(fns.submitSection,
      { attemptId: id, sectionId: 'SA', sessionId: 'sess_A' }, STUDENT()),
    'SESSION_SUPERSEDED');
  const okB = await call(fns.submitSection,
    { attemptId: id, sectionId: 'SA', nextSectionId: 'SB', nextSectionIdx: 1, sessionId: 'sess_B' },
    STUDENT());
  eq(okB.ok, true, 'the current device can');
}

// ═══════════════════════════════════════════════════════════════════
// P-16 · question secrecy holds on every serve path
// ═══════════════════════════════════════════════════════════════════
async function P16() {
  seedWorld({ deliveryMode: 'linear', questionTimeLimit: 300 });
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  // sanitizeQuestionForStudent emits the key FIELDS, zeroed. A leak is content
  // in them, not their presence.
  const leaked = (q) => !!q && (
    (Array.isArray(q.correctIds) && q.correctIds.length > 0)
    || (Array.isArray(q.correctPairs) && q.correctPairs.length > 0)
    || (typeof q.modelAnswer === 'string' && q.modelAnswer.length > 0));

  const qs = await call(fns.getExamQuestions,
    { assessmentId: 'asmt_1', attemptId: id }, STUDENT());
  const list = qs.questions ?? qs.items ?? [];
  check(list.length > 0, 'getExamQuestions returns the served question');
  check(!list.some(leaked), 'no answer key is present in the served payload');

  advance(sec(30));
  const adv = await call(fns.submitAnswerAndAdvance,
    { attemptId: id, questionId: 'q1', answer: { type: 'mcq', value: 'alpha' } }, STUDENT());
  check(!leaked(adv.question), 'no answer key on the advance-served question');

  // And the attempt document the student can read carries no key while live.
  const live = A(id);
  check(!live.gradedAnswers, 'a live attempt carries no gradedAnswers');
}

// ═══════════════════════════════════════════════════════════════════
// P-17 · the sweep does not end a sitting that should merely advance
// ═══════════════════════════════════════════════════════════════════
async function P17() {
  seedWorld({ overallTimeLimit: 300, sectionATimeLimit: 10, sectionBTimeLimit: 60 });
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  advance(min(15));   // SA is over; SB has not started; overall is fine
  await fns.scheduledCloseExpiredAttempts.run({});
  eq(A(id).status, 'in_progress',
    'the sweep leaves a student who still has a section to sit');

  advance(min(300));
  await fns.scheduledCloseExpiredAttempts.run({});
  eq(A(id).status, 'auto_submitted', 'and closes them once the overall clock is gone');
  check(A(id).scores !== undefined, 'grading a swept attempt (INV-10)');
}

// ═══════════════════════════════════════════════════════════════════
// P-18 · security config is frozen onto the attempt, not read live
// ═══════════════════════════════════════════════════════════════════
async function P18() {
  seedWorld();
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  eq(A(id).securityConfig.tier, 'mock', 'the tier is frozen onto the attempt');
  eq(A(id).securityConfig.requireSEB, false, 'as is the SEB requirement');

  // Staff flip the exam to high-stake mid-sitting.
  const asmt = DB.read('assessments', 'asmt_1');
  asmt.securityTier = 'high_stake';
  asmt.requireSEB = true;
  DB.seed('assessments', 'asmt_1', asmt);

  advance(min(1));
  const ok = await call(fns.submitSection,
    { attemptId: id, sectionId: 'SA', nextSectionId: 'SB', nextSectionIdx: 1 }, STUDENT());
  eq(ok.ok, true,
    'the in-flight student is judged by the contract they started under, not the new one');
  eq(A(id).securityConfig.requireSEB, false, 'and the frozen snapshot is unchanged');
}

// ═══════════════════════════════════════════════════════════════════
// P-19 · student_choice: order is the student's, the rules are not
// ═══════════════════════════════════════════════════════════════════
async function P19() {
  seedWorld({ sectionStartOrder: 'student_choice' });
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  const born = A(id);
  eq(born.sectionTimings.SA.startedAt || '', '', 'no section auto-starts under student_choice');
  eq(born.sectionTimings.SB.startedAt || '', '', 'neither of them');

  const order = born.sectionIds;
  const pick = order[1];
  await call(fns.startSection,
    { attemptId: id, sectionId: pick, reorderedSectionIds: [pick, order[0]] }, STUDENT());
  check(!!A(id).sectionTimings[pick].startedAt, 'the chosen section starts');

  // A second section cannot be opened while the first is live (INV-1).
  await expectThrow('a second section cannot be opened alongside the first',
    () => call(fns.startSection, { attemptId: id, sectionId: order[0] }, STUDENT()),
    'SECTION_STILL_OPEN');

  // A reorder that moves an already-played section is refused.
  advance(min(1));
  await call(fns.submitSection, { attemptId: id, sectionId: pick, pauseBeforeNext: true }, STUDENT());
  await expectThrow('a reorder that moves a played section is refused',
    () => call(fns.startSection, {
      attemptId: id, sectionId: order[0],
      reorderedSectionIds: [order[0], pick],
    }, STUDENT()),
    'completed sections cannot be moved');
}

// ═══════════════════════════════════════════════════════════════════
// P-20 · blocked mid-sitting stops every transition
// ═══════════════════════════════════════════════════════════════════
async function P20() {
  // A break after SA, so there is a moment with NO section open — which is the
  // only state in which startSection's own block gate is reachable.
  seedWorld({ breakAfter: { durationMinutes: 5, mandatory: false } });
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  advance(min(1));
  await call(fns.submitSection,
    { attemptId: id, sectionId: 'SA', pauseBeforeNext: true }, STUDENT());

  const asmt = DB.read('assessments', 'asmt_1');
  asmt.blockedStudents = ['stu_1'];
  DB.seed('assessments', 'asmt_1', asmt);

  advance(min(6));
  await expectThrow('a blocked student cannot start the next section',
    () => call(fns.startSection, { attemptId: id, sectionId: 'SB' }, STUDENT()),
    'BLOCKED_FROM_EXAM');

  // And the same block stops an advance-style submit on a fresh sitting.
  DB.seed('attempts', id, { ...A(id), status: 'submitted', scores: { total: 0 } });
  const asmt2 = DB.read('assessments', 'asmt_1');
  asmt2.maxAttempts = 2;
  DB.seed('assessments', 'asmt_1', asmt2);
  await expectThrow('and a blocked student cannot open a new sitting at all',
    () => call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT()),
    'blocked');
}

// ═══════════════════════════════════════════════════════════════════
// P-21 · the paper a student sat is the paper they are marked against
//
// securityLockedAt freezes tier / deliveryMode / camera / mobile / extension /
// autoResume, and nothing else. `sections` stays editable on a live exam, while
// gradeAttempt marks against normalizeSections(THE LIVE DOC). The builder
// re-draws rule-based sections at random on every save, so an ordinary edit to
// a running exam can replace the paper underneath a sitting.
// ═══════════════════════════════════════════════════════════════════
async function P21() {
  seedWorld();
  DB.seed('questions', 'q9', {
    id: 'q9', engine: 'mcq', variant: 'single', question: 'Replacement',
    options: [{ id: 'alpha' }, { id: 'beta' }], difficulty: 'medium',
  });
  DB.seed('questionAnswers', 'q9', { id: 'q9', correctIds: ['alpha'], correctPairs: [], modelAnswer: '' });

  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  advance(min(2));
  clientAnswer(id, 'q1', 'alpha', 'SA');   // correct, worth 10
  clientAnswer(id, 'q2', 'alpha', 'SA');   // correct, worth 10
  clientAnswer(id, 'q3', 'alpha', 'SB');   // correct, worth 20 → 40/40

  // Staff re-save the LIVE exam; the rule re-draw swaps q1 for q9.
  const asmt = DB.read('assessments', 'asmt_1');
  asmt.sections[0].questions = [
    { questionId: 'q9', marks: 10, order: 0 },
    { questionId: 'q2', marks: 10, order: 1 },
  ];
  DB.seed('assessments', 'asmt_1', asmt);

  advance(min(1));
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());
  const scores = A(id).scores;
  eq(scores.total, 40,
    'a student who answered every question they were shown still scores full marks');
}

// ═══════════════════════════════════════════════════════════════════
// P-22 · a live exam's timing cannot be shortened under a sitting student
//
// computeAttemptLocks reads sections[].timeLimit, overallTimeLimit and the
// grace knobs from the LIVE assessment on every recompute. None of them are in
// the securityLockedAt immutability list.
// ═══════════════════════════════════════════════════════════════════
async function P22() {
  seedWorld({ overallTimeLimit: 120, sectionATimeLimit: 60, sectionBTimeLimit: 60 });
  const t0 = VNOW;
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;
  near(lockMs(A(id).overallLockedAfter), t0 + min(120) + sec(30), 1000,
    'the sitting begins on a 120m overall clock');

  // Staff cut the exam to 20 minutes while the student is working.
  const asmt = DB.read('assessments', 'asmt_1');
  asmt.overallTimeLimit = 20;
  asmt.sections[1].timeLimit = 5;
  DB.seed('assessments', 'asmt_1', asmt);

  advance(min(30));
  const v = await call(fns.getExamVerdict, { attemptId: id }, STUDENT());
  eq(v.verdict.kind, 'section',
    'the in-flight student keeps the clock they started under');
  near(v.verdict.deadlines.overallEndsAt, t0 + min(120) + sec(30), 1500,
    'and the overall deadline is not retroactively shortened');
}

// ═══════════════════════════════════════════════════════════════════
// P-23 · the integrity threshold is enforced where it is DECIDED
//
// Termination was a client decision. The shell counted warnings in React
// state and called gradeAttempt with reason:'terminated' on the third; this
// function believed that, and believed reason:'manual' exactly as readily.
//
// So the whole deterrent rested on the browser choosing to report itself. The
// true count was in integrityLog the entire time — written by logViolation
// under the Admin SDK, unreachable from any client — and nothing read it at
// the one moment it decided whether the sitting was clean.
//
// Three properties, and the third is the one that keeps this honest: the
// student's WORK must survive. A gate that refuses the submission would throw
// away a real paper to punish a signal.
async function P23() {
  seedWorld({ maxAttempts: 5 });
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  // Three warning-type violations, logged the only way they can be: through
  // the real callable, which owns the counters.
  for (const type of ['tab_switch', 'focus_loss', 'fullscreen_exit']) {
    await call(fns.logViolation, { attemptId: id, type }, STUDENT());
  }
  const log = A(id).integrityLog;
  eq((log.tabSwitches ?? 0) + (log.focusLosses ?? 0) + (log.fullscreenExits ?? 0), 3,
    'the server holds three warning-type violations');

  // Answer something, so the probe can prove the paper is still marked.
  const att = A(id);
  att.answers.q1 = { type: 'mcq', value: ['alpha', 'beta'], sectionId: 'SA', answeredAt: at(VNOW) };
  DB.seed('attempts', id, att);

  advance(min(1));

  // The patched client: it never sends 'terminated'. It submits normally, as
  // though nothing had happened.
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());

  const done = A(id);
  eq(done.status, 'terminated',
    'a clean submit from a client over the threshold is finalised as terminated');
  eq(done.integrityLog.autoTerminated, true,
    'and carries the same terminal bookkeeping as a shell-driven termination');
  eq(done.integrityLog.thresholdEnforcedServerSide, true,
    'flagged as enforced here, so a reviewer can tell the client never asked');
  check(typeof done.integrityLog.terminatedReason === 'string'
        && done.integrityLog.terminatedReason.length > 0,
    'a stated reason is recorded even though the caller supplied none',
    `terminatedReason=${JSON.stringify(done.integrityLog.terminatedReason)}`);

  // THE PROPERTY THAT MATTERS MOST. Refusing the call would have been the
  // easy implementation and would have destroyed a real paper.
  check(done.scores && typeof done.scores.total === 'number',
    'the paper is still scored — enforcement changes the verdict, not the marks',
    `scores=${JSON.stringify(done.scores)}`);
  check(done.gradedAnswers && done.gradedAnswers.q1,
    'and the answer written before the threshold was reached is marked');

  // ── The control: a student UNDER the threshold submits cleanly ──
  seedWorld({ maxAttempts: 5 });
  const clean = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const cid = clean.attempt.id;
  for (const type of ['tab_switch', 'focus_loss']) {
    await call(fns.logViolation, { attemptId: cid, type }, STUDENT());
  }
  advance(min(1));
  await call(fns.gradeAttempt, { attemptId: cid, reason: 'manual' }, STUDENT());
  eq(A(cid).status, 'submitted',
    'two violations is under the limit and still submits normally');
  check(A(cid).integrityLog.thresholdEnforcedServerSide === undefined,
    'and is not flagged');

  // ── The other control: a GRADER is not overridden ──────────────
  //
  // A human finalising an attempt can see the integrity log and is deciding in
  // spite of it. Overriding them would flip a deliberately-accepted paper back
  // to terminated on every regrade.
  seedWorld({ maxAttempts: 5 });
  const staffCase = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const sid = staffCase.attempt.id;
  for (const type of ['tab_switch', 'focus_loss', 'fullscreen_exit']) {
    await call(fns.logViolation, { attemptId: sid, type }, STUDENT());
  }
  advance(min(1));
  await call(fns.gradeAttempt, { attemptId: sid, reason: 'manual' }, STAFF());
  eq(A(sid).status, 'submitted',
    'a grader finalising over the threshold keeps their own verdict');
}

// ═══════════════════════════════════════════════════════════════════
const SCENARIOS = [
  ['P-01', 'a recorded penalty survives the next section advance', P01],
  ['P-02', 'submitSection cannot re-arm the answer-write lock', P02],
  ['P-03', 'every section id is validated against the played set', P03],
  ['P-04', 'sequential delivery enforces section/overall clocks', P04],
  ['P-05', 'the availability window bounds answer writes', P05],
  ['P-06', 'negative marking spares a partially-correct answer', P06],
  ['P-07', 'gradeAttempt rejects caller-named section keys', P07],
  ['P-08', 'terminate idempotency + attempt limit', P08],
  ['P-09', 'escape mid-exam: section expiry advances', P09],
  ['P-10', 'escape during submission: stranded attempt is swept', P10],
  ['P-11', 'passive-but-not-frozen vs frozen are distinguishable', P11],
  ['P-12', 'freeze penalties are capped and attributed', P12],
  ['P-13', 'configured grace beats the default, both ways', P13],
  ['P-14', 'a mandatory break cannot be skipped', P14],
  ['P-15', 'a superseded device cannot drive the sitting', P15],
  ['P-16', 'question secrecy on every serve path', P16],
  ['P-17', 'the sweep advances rather than ends', P17],
  ['P-18', 'security config is frozen onto the attempt', P18],
  ['P-19', 'student_choice ordering rules', P19],
  ['P-20', 'blocked mid-sitting stops every transition', P20],
  ['P-21', 'the paper sat is the paper marked', P21],
  ['P-22', 'live timing edits do not reach a sitting student', P22],
  ['P-23', 'the integrity threshold is enforced server-side', P23],
];

(async () => {
  for (const [id, title, fn] of SCENARIOS) await scenario(id, title, fn);

  const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
  let pass = 0, fail = 0;
  console.log(`\n${C.b}AUDIT PROBE SUITE${C.x}  —  real callables, in-memory Firestore, virtual clock\n`);
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