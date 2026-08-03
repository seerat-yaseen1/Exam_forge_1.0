// ═══════════════════════════════════════════════════════════════════════════
// FREEZE BEHAVIOURAL SUITE
//
// Runs the COMPILED PRODUCTION CALLABLES (functions/lib/index.js, built from
// functions/src/index.ts) against an in-memory Firestore and a virtual clock.
// Nothing here re-implements a deadline: every number asserted on was written
// by the real handler.
//
//   node test/freeze.suite.cjs
//
// timing.sweep.cjs already proves examTimingCore across 13,446 states. Every
// assertion below is about a SEAM the sweep cannot reach — the inline
// arithmetic in submitSection, what unfreezeAttempt recomputes, what
// verifyAndResume writes, and what the scheduled sweep does to a paused
// student.
// ═══════════════════════════════════════════════════════════════════════════

const assert = require('assert');
const { FakeDb } = require('./fakeFirestore.cjs');

// ── Virtual clock ──────────────────────────────────────────────────
// Production reads Date.now() and `new Date()` directly. Both are pinned so a
// freeze of "ten minutes" is exactly ten minutes and the suite is
// deterministic.
const RealDate = Date;
let VNOW = Date.parse('2026-08-01T09:00:00.000Z');
function installClock() {
  class FakeDate extends RealDate {
    constructor(...args) { if (args.length === 0) super(VNOW); else super(...args); }
    static now() { return VNOW; }
    static parse(s) { return RealDate.parse(s); }
    static UTC(...a) { return RealDate.UTC(...a); }
  }
  global.Date = FakeDate;
}
installClock();
const advance = (ms) => { VNOW += ms; };
const at = (ms) => new RealDate(ms).toISOString();
const min = (m) => m * 60_000;
const sec = (s) => s * 1000;

// ── Wire the fake db into the compiled module ──────────────────────
process.env.GCLOUD_PROJECT = 'demo-freeze-suite';
const adminFs = require('firebase-admin/firestore');
let DB = new FakeDb();
adminFs.getFirestore = () => DB;
// initializeApp() is called at module load in index.ts; make it inert.
const adminApp = require('firebase-admin/app');
adminApp.initializeApp = () => ({});

const fns = require('../lib/index.js');
const core = require('../lib/examTimingCore.js');

// ── Harness ────────────────────────────────────────────────────────
const results = [];
let current = null;
function scenario(id, title, fn) {
  current = { id, title, checks: [], error: null };
  DB = new FakeDb();
  VNOW = Date.parse('2026-08-01T09:00:00.000Z');
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(() => { results.push(current); }, (e) => { current.error = e; results.push(current); });
    }
  } catch (e) { current.error = e; }
  results.push(current);
  return Promise.resolve();
}
function check(pass, label, detail) {
  current.checks.push({ pass: !!pass, label, detail: detail === undefined ? null : String(detail) });
}
function eq(actual, expected, label) {
  check(actual === expected, label, `expected ${expected}, got ${actual}`);
}
function near(actual, expected, tolMs, label) {
  const ok = Math.abs(actual - expected) <= tolMs;
  check(ok, label, `expected ~${expected} (±${tolMs}), got ${actual} (Δ${actual - expected})`);
}

// Run a v2 callable with a staff/student auth context.
async function call(fnRef, data, auth) {
  return fnRef.run({ data, auth, rawRequest: { headers: {} }, acceptsStreaming: false });
}
const STAFF = (uid = 'fac_1', role = 'faculty', instituteId = 'inst_1') =>
  ({ uid, token: { role, instituteId } });
const STUDENT = (uid = 'stu_uid', studentId = 'stu_1', instituteId = 'inst_1') =>
  ({ uid, token: { role: 'student', studentId, instituteId } });

// ── Fixtures ───────────────────────────────────────────────────────
// One two-section paper. Section A 30m, Section B 20m, overall 60m, default
// grace (30s section / 30s overall). Question limits only where a scenario
// needs the question clock.
function seedPaper(opts = {}) {
  const asmt = {
    id: 'asmt_1',
    title: 'Freeze Suite Paper',
    instituteId: 'inst_1',
    status: 'published',
    startDate: at(VNOW - min(60)),
    endDate: opts.endDate ?? at(VNOW + min(600)),
    overallTimeLimit: opts.overallTimeLimit ?? 60,
    deliveryMode: opts.deliveryMode ?? 'standard',
    sectionStartOrder: 'sequential',
    passingScore: 40,
    sections: [
      {
        id: 'SA', name: 'A', timeLimit: opts.sectionATimeLimit ?? 30,
        questionTimeLimit: opts.questionTimeLimit,
        breakAfter: opts.breakAfter,
        questions: [{ questionId: 'q1', marks: 10 }, { questionId: 'q2', marks: 10 }],
      },
      {
        id: 'SB', name: 'B', timeLimit: 20,
        questionTimeLimit: opts.questionTimeLimit,
        questions: [{ questionId: 'q3', marks: 10 }],
      },
    ],
  };
  DB.seed('assessments', 'asmt_1', asmt);
  for (const q of ['q1', 'q2', 'q3']) {
    DB.seed('questions', q, { id: q, type: 'mcq', text: q, options: ['a', 'b'], difficulty: 'medium' });
    DB.seed('questionAnswers', q, { questionId: q, correctAnswer: 'a' });
  }
  return asmt;
}

function seedAttempt(overrides = {}) {
  const startedAt = overrides.startedAt ?? at(VNOW);
  const att = {
    id: 'att_1',
    assessmentId: 'asmt_1',
    studentId: 'stu_1',
    instituteId: 'inst_1',
    status: 'in_progress',
    startedAt,
    currentSectionIdx: 0,
    sectionIds: ['SA', 'SB'],
    sectionTimings: { SA: { startedAt, timeUsedSeconds: 0 }, SB: { startedAt: '', timeUsedSeconds: 0 } },
    freezeCredits: { overallMs: 0, sectionMs: 0, questionMs: 0, breakMs: 0 },
    questionOrder: { SA: ['q1', 'q2'], SB: ['q3'] },
    servedQuestions: [],
    answers: {},
    totalFrozenSeconds: 0,
    securityConfig: { deliveryMode: 'standard', requireSEB: false },
    integrityLog: { totalViolations: 0, violations: [] },
    updatedAt: startedAt,
    ...overrides,
  };
  // Materialise the birth locks exactly as startExam does.
  const secEnd = Date.parse(startedAt) + min(overrides._sectionLimit ?? 30) + sec(30);
  const ovrEnd = Date.parse(startedAt) + min(overrides._overallLimit ?? 60) + sec(30);
  const { Timestamp } = require('firebase-admin/firestore');
  att.sectionLockedAfter = Timestamp.fromMillis(secEnd);
  att.overallLockedAfter = Timestamp.fromMillis(ovrEnd);
  att.answersLockedAfter = Timestamp.fromMillis(Math.min(secEnd, ovrEnd));
  DB.seed('attempts', 'att_1', att);
  return att;
}

const lockMs = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : (v ? Date.parse(v) : null));
const A = () => DB.read('attempts', 'att_1');

// ═══════════════════════════════════════════════════════════════════
// FZ-01 · baseline — one freeze, full grant, inside one section
// The property everything else is measured against: a fully-granted pause
// must leave every deadline exactly where it stood when the pause began.
// ═══════════════════════════════════════════════════════════════════
async function FZ01() {
  seedPaper();
  seedAttempt();
  const t0 = VNOW;
  const beforeSection = lockMs(A().sectionLockedAfter);
  const beforeOverall = lockMs(A().overallLockedAfter);

  advance(min(5));                                   // 5 minutes of work
  await call(fns.freezeAttempt, { attemptId: 'att_1', reason: 'phone rang' }, STAFF());
  const frozen = A();
  check(Array.isArray(frozen.freezes) && frozen.freezes.length === 1, 'freeze opens one ledger entry');
  eq(frozen.status, 'in_progress', 'freezeAttempt leaves status at in_progress');
  check(!!frozen.frozenAt, 'legacy frozenAt is stamped (client pauses on it)');

  advance(min(10));                                  // paused ten minutes
  const r = await call(fns.unfreezeAttempt,
    { attemptId: 'att_1', grantedMs: min(10) }, STAFF());
  eq(r.grantedMs, min(10), 'full grant accepted');
  eq(r.creditedFreezeMs, min(10), 'creditedFreezeMs = the grant');

  const after = A();
  near(lockMs(after.sectionLockedAfter), beforeSection + min(10), 1500,
    'sectionLockedAfter moved out by exactly the grant');
  near(lockMs(after.overallLockedAfter), beforeOverall + min(10), 1500,
    'overallLockedAfter moved out by exactly the grant');
  near(after.freezeCredits.sectionMs, min(10), 1500, 'freezeCredits.sectionMs materialised');
  near(after.freezeCredits.overallMs, min(10), 1500, 'freezeCredits.overallMs materialised');

  // The invariant, stated as the student experiences it: remaining time is
  // what it was at the instant of the pause.
  const remainingBefore = beforeSection - (t0 + min(5));
  const remainingAfter = lockMs(after.sectionLockedAfter) - VNOW;
  near(remainingAfter, remainingBefore, 1500, 'section remaining is restored exactly');
}

// ═══════════════════════════════════════════════════════════════════
// FZ-02 · the granted time must be SPENDABLE
// A grant the student cannot use is not a grant. Work into the credited
// window, then submit the section the ordinary way.
// ═══════════════════════════════════════════════════════════════════
async function FZ02() {
  seedPaper();
  seedAttempt();
  advance(min(5));
  await call(fns.freezeAttempt, { attemptId: 'att_1' }, STAFF());
  advance(min(10));
  await call(fns.unfreezeAttempt, { attemptId: 'att_1', grantedMs: min(10) }, STAFF());

  // Now at t0+15. Section A: 30m limit, 5m used before the pause, 10m credited.
  // Its deadline is t0+40:30. Work to t0+35 — five minutes INSIDE the credit —
  // and submit. The write gate says yes; ask the submit path.
  advance(min(20));                                  // t0 + 35
  const lockNow = lockMs(A().answersLockedAfter);
  check(VNOW < lockNow, 'the write gate (answersLockedAfter) still permits writes',
    `now=${at(VNOW)} lock=${at(lockNow)}`);

  const verdict = await call(fns.getExamVerdict, { attemptId: 'att_1' }, STAFF());
  eq(verdict.verdict.kind, 'section', 'the resolver still places the student in a section');

  let thrown = null;
  try {
    await call(fns.submitSection,
      { attemptId: 'att_1', sectionId: 'SA', nextSectionId: 'SB', nextSectionIdx: 1 },
      STUDENT());
  } catch (e) { thrown = e; }
  check(thrown === null,
    'submitSection accepts a submit inside the credited window',
    thrown ? `${thrown.code}: ${thrown.message}` : '');

  if (thrown === null) {
    const after = A();
    near(Date.parse(after.sectionTimings.SA.submittedAt), VNOW, 1500,
      'SA submittedAt is the real submit instant, not a clamp');
    check(!!after.sectionTimings.SB.startedAt, 'SB started');
  }
}

// ═══════════════════════════════════════════════════════════════════
// FZ-03 · the OVERALL clock's grant must be spendable too
// Same shape, one level out: credit the overall clock, then reach past the
// uncredited overall deadline and submit a section.
// ═══════════════════════════════════════════════════════════════════
async function FZ03() {
  seedPaper({ overallTimeLimit: 20, sectionATimeLimit: 0 });   // untimed section
  seedAttempt({ _sectionLimit: 0, _overallLimit: 20 });
  advance(min(2));
  await call(fns.freezeAttempt, { attemptId: 'att_1' }, STAFF());
  advance(min(10));
  await call(fns.unfreezeAttempt, { attemptId: 'att_1', grantedMs: min(10) }, STAFF());

  // Overall now ends at t0 + 20 + 0:30 + 10 = t0+30:30. Work to t0+25.
  advance(min(13));                                  // t0 + 25
  const lockNow = lockMs(A().overallLockedAfter);
  check(VNOW < lockNow, 'overall write gate still open', `now=${at(VNOW)} lock=${at(lockNow)}`);

  let thrown = null;
  try {
    await call(fns.submitSection,
      { attemptId: 'att_1', sectionId: 'SA', nextSectionId: 'SB', nextSectionIdx: 1 },
      STUDENT());
  } catch (e) { thrown = e; }
  check(thrown === null,
    'submitSection does not raise OVERALL_DEADLINE_EXCEEDED inside credited overall time',
    thrown ? `${thrown.code}: ${thrown.message}` : '');
}

// ═══════════════════════════════════════════════════════════════════
// FZ-04 · an extension freeze then an invigilator freeze
// verifyAndResume increments totalFrozenSeconds; unfreezeAttempt SETS it from
// the ledger. INV-4a says credit never decreases; INV-3a says the overall
// bound never moves earlier without a recorded penalty.
// ═══════════════════════════════════════════════════════════════════
async function FZ04() {
  seedPaper();
  seedAttempt();
  advance(min(2));

  // 1. Extension freeze, cleared by an invigilator after ten minutes.
  DB.seed('attempts', 'att_1', {
    ...A(), status: 'frozen',
    freezeState: { frozen: true, reason: 'extension_detected', since: at(VNOW) },
    securityConfig: { ...A().securityConfig, requireExtensionCheck: true },
  });
  advance(min(10));
  const vr = await call(fns.verifyAndResume, { attemptId: 'att_1' }, STAFF());
  eq(vr.frozenForSeconds, 600, 'verifyAndResume measured the extension freeze');
  eq(A().totalFrozenSeconds, 600, 'totalFrozenSeconds carries the measured pause');

  const coreBefore = core.toMs ? null : null;
  const creditBefore = core.creditedFreezeMs(toCore(A()));
  near(creditBefore, min(10), 1000,
    'the core credits the legacy field (CONSUME_LEGACY_FROZEN_SECONDS=true)');

  // Force the legacy credit into the materialised lock the way production
  // does: the next section boundary recomputes it.
  await call(fns.submitSection,
    { attemptId: 'att_1', sectionId: 'SA', nextSectionId: 'SB', nextSectionIdx: 1 },
    STUDENT()).catch(() => {});
  const overallAfterLegacy = lockMs(A().overallLockedAfter);

  // 2. Now an invigilator pauses for two minutes and grants all of it.
  advance(min(1));
  await call(fns.freezeAttempt, { attemptId: 'att_1' }, STAFF());
  advance(min(2));
  await call(fns.unfreezeAttempt, { attemptId: 'att_1', grantedMs: min(2) }, STAFF());

  const creditAfter = core.creditedFreezeMs(toCore(A()));
  check(creditAfter >= creditBefore - 1,
    'INV-4a · credited freeze never decreases across the invigilator pause',
    `before=${creditBefore}ms after=${creditAfter}ms (lost ${creditBefore - creditAfter}ms)`);

  const overallAfter = lockMs(A().overallLockedAfter);
  check(overallAfter >= overallAfterLegacy - 1000,
    'INV-3a · overallLockedAfter never moves earlier without a recorded penalty',
    `before=${at(overallAfterLegacy)} after=${at(overallAfter)} ` +
    `(moved back ${(overallAfterLegacy - overallAfter) / 1000}s), penalties=` +
    JSON.stringify(A().penalties ?? []));
}

function toCore(raw) {
  return {
    status: raw.status, startedAt: raw.startedAt, sectionIds: raw.sectionIds ?? [],
    sectionTimings: raw.sectionTimings ?? {}, servedQuestions: raw.servedQuestions ?? [],
    answers: raw.answers ?? {}, creditedFreezeMs: raw.creditedFreezeMs,
    totalFrozenSeconds: raw.totalFrozenSeconds, freezes: raw.freezes,
    penalties: raw.penalties,
  };
}

// ═══════════════════════════════════════════════════════════════════
// FZ-05 · a paused student must not be able to keep working
// A2: freeze is a pause. The clocks stop (4.3), so anything still writable is
// writable with the clock stopped — unbounded time.
// ═══════════════════════════════════════════════════════════════════
async function FZ05() {
  seedPaper({ deliveryMode: 'linear', questionTimeLimit: 60 });
  seedAttempt({
    securityConfig: { deliveryMode: 'linear', requireSEB: false },
    servedQuestions: [{ questionId: 'q1', sectionId: 'SA', difficulty: 'medium', servedAt: at(VNOW), locked: false }],
  });
  advance(min(1));
  await call(fns.freezeAttempt, { attemptId: 'att_1' }, STAFF());
  advance(min(30));                                   // half an hour paused

  let advanceThrew = null;
  try {
    await call(fns.submitAnswerAndAdvance,
      { attemptId: 'att_1', questionId: 'q1', answer: { type: 'mcq', value: 'a' } }, STUDENT());
  } catch (e) { advanceThrew = e; }
  check(advanceThrew !== null,
    'submitAnswerAndAdvance refuses to advance a PAUSED sitting',
    advanceThrew ? 'refused' : 'ACCEPTED — the student advanced a question while frozen');

  let gradeThrew = null;
  try {
    await call(fns.gradeAttempt, { attemptId: 'att_1', reason: 'manual' }, STUDENT());
  } catch (e) { gradeThrew = e; }
  check(gradeThrew !== null,
    'gradeAttempt refuses a student finalising their own PAUSED sitting',
    gradeThrew ? 'refused' : 'ACCEPTED — the student ended the exam during the freeze');

  if (!gradeThrew) {
    check(A().integrityLog?.finalizedWhileFrozen === true,
      'an attempt finalised while paused is at least flagged',
      `finalizedWhileFrozen=${A().integrityLog?.finalizedWhileFrozen}`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// FZ-06 · a freeze during a BREAK
// D-29 credited the break clock in the resolver. startSection has its own
// mandatory-break gate. Both must agree about when the break ends.
// ═══════════════════════════════════════════════════════════════════
async function FZ06() {
  seedPaper({ breakAfter: { durationMinutes: 10, mandatory: true } });
  seedAttempt();
  advance(min(5));
  // Submit SA; a mandatory break is due, so no auto-advance.
  await call(fns.submitSection,
    { attemptId: 'att_1', sectionId: 'SA', nextSectionId: 'SB', nextSectionIdx: 1, pauseBeforeNext: true },
    STUDENT());
  const breakStart = VNOW;

  advance(min(2));                                   // 2 minutes into the break
  await call(fns.freezeAttempt, { attemptId: 'att_1' }, STAFF());
  advance(min(6));                                   // paused 6 minutes
  await call(fns.unfreezeAttempt, { attemptId: 'att_1', grantedMs: min(6) }, STAFF());

  near(A().freezeCredits.breakMs, min(6), 1500, 'the break clock was credited (D-29)');

  // Credited, the break runs to breakStart + 10 + 6 = +16. Uncredited it ended
  // at +10. Stand between the two, at +13, and ask both authorities.
  advance(min(5));                                   // now breakStart + 13
  const v = await call(fns.getExamVerdict, { attemptId: 'att_1' }, STAFF());
  eq(v.verdict.kind, 'break', 'the resolver still holds the student on the credited break');

  // startSection's own gate must reach the same conclusion.
  let started = null;
  try {
    await call(fns.startSection, { attemptId: 'att_1', sectionId: 'SB' }, STUDENT());
    started = 'ALLOWED';
  } catch (e) { started = e.message; }
  check(started !== 'ALLOWED',
    'startSection refuses entry while the resolver still reports a mandatory break',
    started === 'ALLOWED'
      ? 'ALLOWED — the gate ignores break freeze credit, so the two disagree'
      : started);
}

// ═══════════════════════════════════════════════════════════════════
// FZ-07 · penalties must reach the WRITE GATE
// A penalty is the one thing that legitimately moves a deadline backwards.
// If answersLockedAfter does not carry it, the student is shown less time
// than the rules actually enforce.
// ═══════════════════════════════════════════════════════════════════
async function FZ07() {
  seedPaper();
  seedAttempt();
  advance(min(5));
  await call(fns.freezeAttempt, { attemptId: 'att_1' }, STAFF());
  advance(min(4));
  await call(fns.unfreezeAttempt,
    { attemptId: 'att_1', grantedMs: min(4), penalties: { sectionMs: min(5), overallMs: min(5) } },
    STAFF());

  const after = A();
  const rows = after.penalties ?? [];
  check(rows.length === 2, 'the deduction is PERSISTED on the attempt',
    `penalties=${JSON.stringify(rows.map((r) => [r.clock, r.amountMs]))} — ` +
    'unfreezeAttempt computes penaltyLedger/penalisedAttempt (index.ts:6278-6282) ' +
    'and never writes either');

  const resolved = core.computeDeadlines(toCore(after), {
    startDate: undefined, endDate: undefined, overallTimeLimit: 60,
    sections: [{ id: 'SA', timeLimit: 30, questionIds: ['q1', 'q2'] },
               { id: 'SB', timeLimit: 20, questionIds: ['q3'] }],
  });

  near(lockMs(after.sectionLockedAfter), resolved.sectionEndsAt, 1500,
    'sectionLockedAfter agrees with the resolver after a penalty',
    );
  near(lockMs(after.overallLockedAfter), resolved.overallEndsAt, 1500,
    'overallLockedAfter agrees with the resolver after a penalty');
}

// ═══════════════════════════════════════════════════════════════════
// FZ-08 · a long freeze must not be ended by a timer
// D-30: "a freeze no longer expires on a timer: it ends when a human ends
// it." The scheduled sweep is the only thing that could contradict that.
// ═══════════════════════════════════════════════════════════════════
async function FZ08() {
  seedPaper();
  seedAttempt();
  advance(min(5));
  await call(fns.freezeAttempt, { attemptId: 'att_1' }, STAFF());

  advance(60 * 60_000 * 7);                          // paused seven hours
  await fns.scheduledCloseExpiredAttempts.run({});

  const after = A();
  eq(after.status, 'in_progress',
    'a seven-hour freeze is still a freeze — the sweep leaves it for a human');
  check(!after.autoSubmitReason,
    'no automatic close reason was stamped', `autoSubmitReason=${after.autoSubmitReason}`);
  check(!Array.isArray(after.freezes) || !after.freezes[0].endedAt,
    'the ledger entry is still open');
}

// ═══════════════════════════════════════════════════════════════════
// FZ-09 · what the invigilator is shown must be what the student saw
// clocksAtFreeze feeds the resume modal's caps and the student's "where you
// stood" screen. It must describe the same clock the student was watching.
// ═══════════════════════════════════════════════════════════════════
async function FZ09() {
  seedPaper({ deliveryMode: 'linear', questionTimeLimit: 90 });
  seedAttempt({
    securityConfig: { deliveryMode: 'linear', requireSEB: false },
    servedQuestions: [{ questionId: 'q1', sectionId: 'SA', difficulty: 'medium', servedAt: at(VNOW), locked: false }],
  });
  const t0 = VNOW;
  advance(min(5));
  await call(fns.freezeAttempt, { attemptId: 'att_1' }, STAFF());

  const snap = A().freezes[0].clocksAtFreeze;
  check(snap !== null && snap !== undefined, 'clocksAtFreeze was captured', JSON.stringify(snap));
  if (!snap) return;

  // The question was served at t0 and has a 90s limit. Five minutes later it
  // is long gone, so the snapshot should read 0 — not null, and not a live
  // number. Section A: 30m limit, 5m used.
  near(snap.sectionMs, min(25) + sec(30), 1500,
    'sectionMs snapshot = section remaining, grace included');
  eq(snap.questionMs, 0, 'questionMs snapshot = 0 for a question already past its limit');

  // What the student's own SectionTimer renders, transcribed from
  // src/app/components/exam/SectionTimer.tsx:30 —
  //   elapsed = (refNow - started)/1000 - frozenOffsetSeconds
  //   left    = timeLimitMinutes*60 - elapsed
  const displayedSectionMs =
    (30 * 60 - ((Date.parse(A().frozenAt) - t0) / 1000 - 0)) * 1000;
  near(snap.sectionMs, displayedSectionMs, 1500,
    'the snapshot matches the number on the student\'s screen',
    `snapshot=${snap.sectionMs}ms display=${displayedSectionMs}ms ` +
    `(Δ=${(snap.sectionMs - displayedSectionMs) / 1000}s — grace is in one and not the other)`);
}

// ═══════════════════════════════════════════════════════════════════
// FZ-10 · authority chain (§3/§8) and idempotency
// ═══════════════════════════════════════════════════════════════════
async function FZ10() {
  seedPaper();
  seedAttempt();
  advance(min(1));
  await call(fns.freezeAttempt, { attemptId: 'att_1' }, STAFF('fac_1', 'faculty'));

  // A second freeze is a no-op, not a second entry.
  const r2 = await call(fns.freezeAttempt, { attemptId: 'att_1' }, STAFF('fac_2', 'faculty'));
  eq(r2.alreadyFrozen, true, 'a second freeze returns the open entry');
  eq(A().freezes.length, 1, 'still exactly one ledger entry (INV-4c)');

  // A peer must not clear it.
  let peer = null;
  try {
    await call(fns.unfreezeAttempt, { attemptId: 'att_1', grantedMs: 0 }, STAFF('fac_2', 'faculty'));
  } catch (e) { peer = e; }
  check(peer !== null, 'a peer faculty cannot clear another faculty\'s freeze',
    peer ? peer.message.slice(0, 60) : 'ALLOWED');

  // Their institute admin may.
  advance(min(3));
  const ok = await call(fns.unfreezeAttempt,
    { attemptId: 'att_1', grantedMs: min(3) }, STAFF('inst_admin', 'institute'));
  eq(ok.ok, true, 'the institute admin above them may clear it');

  // Over-granting is capped at what elapsed (INV-4c).
  advance(min(1));
  await call(fns.freezeAttempt, { attemptId: 'att_1' }, STAFF('inst_admin', 'institute'));
  advance(min(1));
  const greedy = await call(fns.unfreezeAttempt,
    { attemptId: 'att_1', grantedMs: min(600) }, STAFF('inst_admin', 'institute'));
  eq(greedy.grantedMs, min(1), 'grant is capped at elapsed — freeze cannot create time');

  const v = core.checkInvariants(toCore(A()), {
    sections: [{ id: 'SA', timeLimit: 30, questionIds: ['q1', 'q2'] },
               { id: 'SB', timeLimit: 20, questionIds: ['q3'] }],
  }).filter((x) => x.severity === 'error');
  check(v.length === 0, 'no invariant errors after two freeze cycles',
    v.map((x) => `${x.id}: ${x.message}`).join('; '));
}

// ═══════════════════════════════════════════════════════════════════
// FZ-11 · unfreeze must invalidate the provisional grade (A9)
// ═══════════════════════════════════════════════════════════════════
async function FZ11() {
  seedPaper();
  seedAttempt({ answers: { q1: { type: 'mcq', value: 'a', sectionId: 'SA', answeredAt: at(VNOW) } } });
  advance(min(3));
  await call(fns.freezeAttempt, { attemptId: 'att_1' }, STAFF());

  const g = await call(fns.gradeProvisional, { attemptId: 'att_1' }, STAFF());
  check(g.provisional === true, 'a paused sitting can be graded provisionally');
  check(DB.has('provisionalGrades', 'att_1'), 'the provisional row exists');
  check(A().scores === undefined, 'the attempt itself stays unscored');

  advance(min(1));
  await call(fns.unfreezeAttempt, { attemptId: 'att_1', grantedMs: min(1) }, STAFF());
  check(!DB.has('provisionalGrades', 'att_1'),
    'unfreeze deletes the provisional grade in the same transaction');
}

// ═══════════════════════════════════════════════════════════════════
// FZ-12 · a freeze straddling a section advance
// D-28: credit belongs to the clock that was running. The section ENTERED
// after a pause must not inherit the pause.
// ═══════════════════════════════════════════════════════════════════
async function FZ12() {
  seedPaper();
  seedAttempt();
  advance(min(5));
  await call(fns.freezeAttempt, { attemptId: 'att_1' }, STAFF());
  advance(min(10));
  await call(fns.unfreezeAttempt, { attemptId: 'att_1', grantedMs: min(10) }, STAFF());

  advance(min(1));
  await call(fns.submitSection,
    { attemptId: 'att_1', sectionId: 'SA', nextSectionId: 'SB', nextSectionIdx: 1 },
    STUDENT()).catch((e) => { check(false, 'advance to SB succeeded', e.message); });

  const after = A();
  if (!after.sectionTimings.SB.startedAt) return;    // FZ-02 already reported it
  eq(after.freezeCredits.sectionMs, 0, 'the NEW section carries no credit from the old pause');
  const sbStart = Date.parse(after.sectionTimings.SB.startedAt);
  near(lockMs(after.sectionLockedAfter), sbStart + min(20) + sec(30), 1500,
    'SB\'s bound is its own limit + grace, with no inherited credit');
  near(after.freezeCredits.overallMs, min(10), 1500,
    'the overall clock keeps its credit across the boundary');
}

// ═══════════════════════════════════════════════════════════════════
// FZ-13 · the availability window is a hard wall (A10 / R2)
// A freeze must not extend it, and a window closing during a freeze must
// still finalise the attempt.
// ═══════════════════════════════════════════════════════════════════
async function FZ13() {
  seedPaper({ endDate: at(VNOW + min(20)) });
  seedAttempt();
  advance(min(5));
  await call(fns.freezeAttempt, { attemptId: 'att_1' }, STAFF());
  advance(min(20));                                  // the window has now closed

  const v = await call(fns.getExamVerdict, { attemptId: 'att_1' }, STAFF());
  eq(v.verdict.kind, 'ended', 'the resolver ends the attempt at the window');
  eq(v.verdict.reason, 'window_closed', 'and names the window as the reason');

  await fns.scheduledCloseExpiredAttempts.run({});
  const after = A();
  check(['auto_submitted', 'terminated', 'submitted'].includes(after.status),
    'the sweep finalises an attempt whose window closed during a freeze',
    `status=${after.status}`);
}

// ═══════════════════════════════════════════════════════════════════
// FZ-14 · a freeze on a legacy attempt (no ledger, legacy credit present)
// The moment a ledger entry appears, creditForAnchor switches from the flat
// legacy total to the per-freeze sum. Nothing must be lost in that switch.
// ═══════════════════════════════════════════════════════════════════
async function FZ14() {
  seedPaper();
  seedAttempt({ totalFrozenSeconds: 480 });          // 8 minutes, pre-ledger
  const before = core.creditForAnchor(toCore(A()), A().startedAt);
  near(before, min(8), 1000, 'a legacy attempt carries 8 minutes of credit');

  advance(min(2));
  await call(fns.freezeAttempt, { attemptId: 'att_1' }, STAFF());
  const during = core.creditForAnchor(toCore(A()), A().startedAt);
  check(during >= before - 1,
    'opening a ledger entry does not discard the legacy credit',
    `before=${before}ms during=${during}ms (lost ${(before - during) / 1000}s the instant freeze was pressed)`);

  advance(min(1));
  await call(fns.unfreezeAttempt, { attemptId: 'att_1', grantedMs: min(1) }, STAFF());
  const after = core.creditForAnchor(toCore(A()), A().startedAt);
  check(after >= before - 1,
    'INV-4a · credit after the cycle is at least what it was before',
    `before=${before}ms after=${after}ms (lost ${(before - after) / 1000}s)`);
}

// ═══════════════════════════════════════════════════════════════════
// FZ-15 · the OTHER freeze — reportExtensionCheck
// Two mechanisms claim the word "freeze". An extension freeze writes
// status:'frozen' + freezeState; an invigilator freeze writes frozenAt + a
// ledger entry. A pause is a pause: both must stop the same clocks.
// ═══════════════════════════════════════════════════════════════════
async function FZ15() {
  seedPaper();
  seedAttempt({
    securityConfig: { deliveryMode: 'standard', requireSEB: false, requireExtensionCheck: true, tier: 'high' },
  });
  const t0 = VNOW;
  const lockBefore = lockMs(A().sectionLockedAfter);

  advance(min(5));
  const r = await call(fns.reportExtensionCheck,
    { attemptId: 'att_1', passed: false, found: ['some-extension'] }, STUDENT());
  eq(r.frozen, true, 'the extension check froze the sitting');
  const frozen = A();
  eq(frozen.status, 'frozen', 'status went to frozen');
  check(!frozen.frozenAt,
    'no frozenAt is written — the client pauses its clocks on frozenAt only',
    `frozenAt=${frozen.frozenAt}`);
  check(Array.isArray(frozen.freezes) && frozen.freezes.length === 1,
    'an extension freeze opens a ledger entry like every other pause',
    `freezes=${JSON.stringify(frozen.freezes ?? null)}`);

  // The resolver's pause depends on an OPEN LEDGER ENTRY (effectiveNowMs).
  advance(min(28));                                  // 33m into a 30m section
  const v = await call(fns.getExamVerdict, { attemptId: 'att_1' }, STAFF());
  check(v.verdict.kind === 'section' && v.verdict.sectionId === 'SA',
    'the section clock is HELD while the student is frozen out of their exam',
    `verdict places them at ${v.verdict.sectionId ?? v.verdict.reason} — ` +
    `28 minutes of a 30-minute section were consumed by the freeze, ` +
    `and the student is moved on without ever being released`);

  // Release. A pause the student did not cause must give the time back.
  await call(fns.verifyAndResume, { attemptId: 'att_1' }, STAFF());
  const after = A();
  near(lockMs(after.sectionLockedAfter), lockBefore + min(28), 2000,
    'verifyAndResume recomputes the section bound with the pause credited',
    `before=${at(lockBefore)} after=${at(lockMs(after.sectionLockedAfter))}`);
  near(after.freezeCredits?.sectionMs ?? 0, min(28), 2000,
    'verifyAndResume re-materialises freezeCredits for the client');
}

// ── Run ────────────────────────────────────────────────────────────
(async () => {
  const suite = [
    ['FZ-01', 'baseline — one freeze, full grant, one section', FZ01],
    ['FZ-02', 'the granted section time is spendable', FZ02],
    ['FZ-03', 'the granted overall time is spendable', FZ03],
    ['FZ-04', 'extension freeze then invigilator freeze (INV-4a / INV-3a)', FZ04],
    ['FZ-05', 'a paused student cannot keep working', FZ05],
    ['FZ-06', 'a freeze during a mandatory break', FZ06],
    ['FZ-07', 'penalties reach the write gate', FZ07],
    ['FZ-08', 'a long freeze is not ended by a timer (D-30)', FZ08],
    ['FZ-09', 'clocksAtFreeze matches the student\'s screen', FZ09],
    ['FZ-10', 'authority chain, idempotency, grant cap', FZ10],
    ['FZ-11', 'unfreeze invalidates the provisional grade (A9)', FZ11],
    ['FZ-12', 'credit does not leak into the next section (D-28)', FZ12],
    ['FZ-13', 'the availability window is a hard wall (A10)', FZ13],
    ['FZ-14', 'legacy credit survives the first ledger entry', FZ14],
    ['FZ-15', 'an extension freeze is a pause too', FZ15],
  ];

  for (const [id, title, fn] of suite) await scenario(id, title, fn);

  const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', B = '\x1b[1m', X = '\x1b[0m';
  let pass = 0, fail = 0;
  console.log(`\n${B}FREEZE BEHAVIOURAL SUITE${X}  —  real callables, in-memory Firestore, virtual clock\n`);
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
  const verdict = fail === 0 ? `${G}${B}  ALL GREEN${X}` : `${R}${B}  ${fail} FAILED CHECK(S)${X}`;
  console.log(`${verdict} — ${pass} passed, ${fail} failed across ${results.length} scenarios\n`);
  process.exitCode = fail === 0 ? 0 : 1;
})();
