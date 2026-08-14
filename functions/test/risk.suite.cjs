// ═══════════════════════════════════════════════════════════════════════════
// RISK SUITE  —  device fingerprint drift + the grade-time risk score
//
// Same evidentiary standard as the other headless suites: every check drives
// the COMPILED PRODUCTION CALLABLES (functions/lib/index.js) against an
// in-memory Firestore and a virtual clock. Nothing here re-implements a
// comparison or a weight — every number asserted on was written by a real
// handler.
//
//   node test/risk.suite.cjs
//
// Two properties are load-bearing and neither is visible in a diff:
//
//   1. The fingerprint BASELINE is server-held and written once. A client
//      that could re-establish it could erase the drift it caused, which is
//      the whole reason the comparison does not live on the client.
//   2. Drift must stay SILENT when a value merely goes unreadable. It is the
//      heaviest factor in the score, so scoring a withheld value as a changed
//      machine would put 50 points on a student for a privacy setting.
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

process.env.GCLOUD_PROJECT = 'demo-risk-suite';
const adminFs = require('firebase-admin/firestore');
let DB = new FakeDb();
adminFs.getFirestore = () => DB;
require('firebase-admin/app').initializeApp = () => ({});

const fns = require('../lib/index.js');

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
async function call(fnRef, data, auth) {
  return fnRef.run({ data, auth, rawRequest: { headers: {} }, acceptsStreaming: false });
}

const STUDENT = (uid = 'stu_uid', studentId = 'stu_1', instituteId = 'inst_1') =>
  ({ uid, token: { role: 'student', studentId, instituteId } });

const A = (id) => DB.read('attempts', id);

const MACHINE = {
  gpu: 'ANGLE (Intel, Intel(R) UHD Graphics 620, OpenGL 4.1)',
  cores: 8, memory: 8, platform: 'Win32',
};
const OTHER_MACHINE = {
  gpu: 'llvmpipe (LLVM 15.0.7, 256 bits)',
  cores: 2, memory: 4, platform: 'Linux x86_64',
};

function seedWorld() {
  DB.seed('students', 'stu_1', { id: 'stu_1', name: 'Test Student', instituteId: 'inst_1' });
  DB.seed('assessments', 'asmt_1', {
    id: 'asmt_1', title: 'Risk Paper', instituteId: 'inst_1', status: 'active',
    startDate: at(VNOW - min(60)), endDate: at(VNOW + min(600)),
    maxAttempts: 1, overallTimeLimit: 120,
    deliveryMode: 'standard', sectionStartOrder: 'sequential',
    // 'normal' rather than 'mock': the heartbeat, and therefore the
    // fingerprint, only runs on the proctored tiers.
    securityTier: 'normal',
    requireCamera: false, allowMobile: true, requireExtensionCheck: false, requireSEB: false,
    securityLockedAt: at(VNOW - min(120)),
    passingScore: 40, assignedTo: { type: 'all' },
    sections: [{
      id: 'SA', name: 'A', timeLimit: 60,
      questions: [{ questionId: 'q1', marks: 10, order: 0 }, { questionId: 'q2', marks: 10, order: 1 }],
    }],
  });
  for (const q of ['q1', 'q2']) {
    DB.seed('questions', q, {
      id: q, engine: 'mcq', variant: 'single', question: `Question ${q}`,
      options: [{ id: 'alpha', text: 'Alpha' }, { id: 'beta', text: 'Beta' }],
      difficulty: 'medium',
    });
    DB.seed('questionAnswers', q, { id: q, correctIds: ['alpha'], correctPairs: [], modelAnswer: '' });
  }
}

async function startWith(fingerprint) {
  seedWorld();
  const res = await call(fns.startExam, {
    assessmentId: 'asmt_1', sections: [], shuffleQuestions: false,
    ...(fingerprint ? { fingerprint } : {}),
  }, STUDENT());
  return res.attempt.id;
}

const beat = (id, fingerprint) =>
  call(fns.examHeartbeat, { attemptId: id, ...(fingerprint ? { fingerprint } : {}) }, STUDENT());

// ═══════════════════════════════════════════════════════════════════
// R-01 · the baseline is captured, and captured once
// ═══════════════════════════════════════════════════════════════════
async function R01() {
  const id = await startWith(MACHINE);
  eq(A(id).deviceFingerprint.gpu, MACHINE.gpu, 'startExam stores the baseline GPU');
  eq(A(id).deviceFingerprint.cores, 8, 'and the core count');

  // The heartbeat may describe the machine it is on; it may not redefine what
  // the machine was. If a later call could rewrite the baseline, a client that
  // moved could simply re-establish it and erase its own drift.
  advance(sec(20));
  await beat(id, OTHER_MACHINE);
  eq(A(id).deviceFingerprint.gpu, MACHINE.gpu, 'a heartbeat does NOT rewrite the baseline');
  check(A(id).fingerprintDrift?.count >= 1, 'it records drift instead');
}

// ═══════════════════════════════════════════════════════════════════
// R-02 · the same machine is silent
// ═══════════════════════════════════════════════════════════════════
async function R02() {
  const id = await startWith(MACHINE);
  for (let i = 0; i < 5; i++) { advance(sec(15)); await beat(id, MACHINE); }
  eq(A(id).fingerprintDrift, undefined, 'no drift is recorded for an unchanged machine');
}

// ═══════════════════════════════════════════════════════════════════
// R-03 · a value going unreadable is not a machine changing
// ═══════════════════════════════════════════════════════════════════
async function R03() {
  const id = await startWith(MACHINE);

  // A privacy setting toggled mid-sitting, or a WebGL context that failed to
  // create on this poll. "Could not read it" is an absence of evidence.
  advance(sec(15));
  await beat(id, { ...MACHINE, gpu: '' });
  eq(A(id).fingerprintDrift, undefined, 'an empty GPU is not drift');

  advance(sec(15));
  await beat(id, { ...MACHINE, cores: 0, memory: 0 });
  eq(A(id).fingerprintDrift, undefined, 'a withheld core/memory count is not drift');

  // …but a POPULATED disagreement still is.
  advance(sec(15));
  await beat(id, { ...MACHINE, cores: 2 });
  eq(A(id).fingerprintDrift?.count, 1, 'a real change is still caught');
  check(String(A(id).fingerprintDrift.changes[0]).includes('cores'), 'and names the field');
}

// ═══════════════════════════════════════════════════════════════════
// R-04 · no baseline means no adoption, ever
// ═══════════════════════════════════════════════════════════════════
async function R04() {
  // An attempt created before fingerprinting shipped, or by a browser that
  // reported nothing readable.
  const id = await startWith(null);
  eq(A(id).deviceFingerprint, undefined, 'no baseline was invented at start');

  advance(sec(15));
  await beat(id, MACHINE);
  eq(A(id).deviceFingerprint, undefined, 'and the heartbeat does not adopt one');
  eq(A(id).fingerprintDrift, undefined, 'so there is nothing to drift from');

  // Adopting late would fingerprint whoever holds the sitting NOW — which is
  // the very thing being checked for — and would make the record claim the
  // machine was verified when it never was.
}

// ═══════════════════════════════════════════════════════════════════
// R-05 · repeated drift is one fact, not one per beat
// ═══════════════════════════════════════════════════════════════════
async function R05() {
  const id = await startWith(MACHINE);
  advance(sec(15));
  await beat(id, OTHER_MACHINE);
  const firstAt = A(id).fingerprintDrift.firstAt;

  for (let i = 0; i < 10; i++) { advance(sec(15)); await beat(id, OTHER_MACHINE); }
  const d = A(id).fingerprintDrift;
  eq(d.firstAt, firstAt, 'firstAt dates the moment it started, not the latest beat');
  check(d.changes.length <= 8, 'the change list stays bounded', `got ${d.changes.length}`);
  // All four fields moved, and each is listed once however many beats report it.
  eq(d.changes.length, 4, 'each changed field appears exactly once');
}

// ═══════════════════════════════════════════════════════════════════
// R-06 · a hostile payload cannot bloat the attempt document
// ═══════════════════════════════════════════════════════════════════
async function R06() {
  const id = await startWith({
    gpu: 'G'.repeat(50_000),
    cores: 8,
    platform: 'P'.repeat(50_000),
    // Unknown keys are client-supplied and must not be stored at all.
    evil: 'X'.repeat(50_000),
  });
  const fp = A(id).deviceFingerprint;
  check(fp.gpu.length <= 120, 'the GPU string is clipped', `got ${fp.gpu.length}`);
  check(fp.platform.length <= 120, 'the platform string is clipped');
  eq(fp.evil, undefined, 'unknown keys are dropped entirely');
}

// ═══════════════════════════════════════════════════════════════════
// R-07 · drift is the heaviest factor at grade time
// ═══════════════════════════════════════════════════════════════════
async function R07() {
  const id = await startWith(MACHINE);
  advance(sec(15));
  await beat(id, OTHER_MACHINE);

  advance(min(5));
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());

  const ta = A(id).timingAnalysis;
  const drift = (ta.riskFactors ?? []).find((f) => f.code === 'device_drift');
  check(!!drift, 'device_drift is among the recorded factors');
  eq(drift?.points, 50, 'and carries the heaviest weight');
  check(String(drift?.detail ?? '').includes('gpu'), 'its detail names what changed');
  check(ta.anomalyScore >= 50, 'the score reflects it', `score ${ta.anomalyScore}`);
}

// ═══════════════════════════════════════════════════════════════════
// R-08 · clustered violations are distinguishable from spread ones
// ═══════════════════════════════════════════════════════════════════
async function R08() {
  const id = await startWith(MACHINE);

  // Six events inside one minute. A total alone cannot tell this apart from
  // six spread across a two-hour paper, which is the gap this closes.
  for (let i = 0; i < 6; i++) {
    advance(sec(5));
    await call(fns.logViolation, { attemptId: id, type: 'tab_switch' }, STUDENT());
  }

  advance(min(5));
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());

  const ta = A(id).timingAnalysis;
  check(ta.maxViolationsInMinute >= 5, 'the cluster is measured',
    `got ${ta.maxViolationsInMinute}`);
  const cluster = (ta.riskFactors ?? []).find((f) => f.code === 'violation_cluster');
  check(!!cluster, 'violation_cluster is recorded');
  eq(cluster?.points, 25, 'with its weight');
}

async function R09() {
  const id = await startWith(MACHINE);

  // The same six events, spread far apart. Same counters, different meaning:
  // a student with a notification problem, not a student doing something.
  for (let i = 0; i < 6; i++) {
    advance(min(10));
    await call(fns.logViolation, { attemptId: id, type: 'tab_switch' }, STUDENT());
    // Keep the heartbeat alive so the silences do not themselves score.
    await beat(id, MACHINE);
  }

  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());
  const ta = A(id).timingAnalysis;
  eq(ta.maxViolationsInMinute, 1, 'spread events do not read as a cluster');
  const cluster = (ta.riskFactors ?? []).find((f) => f.code === 'violation_cluster');
  eq(cluster, undefined, 'and no cluster factor is recorded');
}

// ═══════════════════════════════════════════════════════════════════
// R-10 · a clean sitting scores zero, explicitly
// ═══════════════════════════════════════════════════════════════════
async function R10() {
  const id = await startWith(MACHINE);
  // Answer at a human pace, beating at the client's real 15s cadence
  // throughout — two minutes of thinking is not a silence, and the suite
  // must not manufacture one by skipping the beats a real client sends.
  for (const q of ['q1', 'q2']) {
    for (let i = 0; i < 8; i++) { advance(sec(15)); await beat(id, MACHINE); }
    const att = A(id);
    att.answers[q] = { type: 'mcq', value: 'alpha', sectionId: 'SA', answeredAt: at(VNOW) };
    DB.seed('attempts', id, att);
  }
  advance(sec(15));
  await beat(id, MACHINE);
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());

  const ta = A(id).timingAnalysis;
  eq(ta.anomalyScore, 0, 'a clean sitting scores zero');
  eq((ta.riskFactors ?? []).length, 0, 'with no factors recorded');
  // An empty list is a positive finding — "nothing flagged" — which is what
  // lets the reviewer UI say so rather than render a blank panel.
}

// ═══════════════════════════════════════════════════════════════════
// R-11 · the score is bounded and equals its parts
// ═══════════════════════════════════════════════════════════════════
async function R11() {
  const id = await startWith(MACHINE);

  // Drift, a heartbeat silence, and a violation cluster together.
  advance(sec(15));
  await beat(id, OTHER_MACHINE);
  advance(min(20));                       // a silence well past the 60s threshold
  await beat(id, OTHER_MACHINE);
  for (let i = 0; i < 6; i++) {
    advance(sec(5));
    await call(fns.logViolation, { attemptId: id, type: 'focus_loss' }, STUDENT());
  }
  // Answers all at the end, at speed.
  const att = A(id);
  for (const q of ['q1', 'q2']) {
    att.answers[q] = { type: 'mcq', value: 'alpha', sectionId: 'SA', answeredAt: at(VNOW) };
  }
  DB.seed('attempts', id, att);

  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());
  const ta = A(id).timingAnalysis;

  const sum = (ta.riskFactors ?? []).reduce((s, f) => s + f.points, 0);
  check(sum > 100, 'the raw factors exceed the ceiling here', `sum ${sum}`);
  eq(ta.anomalyScore, 100, 'and the score is clamped to 100');
  check((ta.riskFactors ?? []).length >= 3, 'every contributing factor is still listed',
    `got ${(ta.riskFactors ?? []).length}`);
  // Clamping the score but keeping the full factor list is deliberate: the
  // number ranks papers, the list justifies the ranking.
}

// ═══════════════════════════════════════════════════════════════════
// R-12 · heartbeat gaps reach the score
// ═══════════════════════════════════════════════════════════════════
async function R12() {
  const id = await startWith(MACHINE);
  await beat(id, MACHINE);

  advance(min(12));                       // silence in the MIDDLE of the sitting
  await beat(id, MACHINE);
  eq(A(id).heartbeatGaps.count, 1, 'the mid-session silence was recorded when it happened');

  // …and the student carries on normally, so nothing at submit time would
  // reveal it. Before gaps were recorded live, this sitting scored zero here.
  for (let i = 0; i < 4; i++) { advance(sec(15)); await beat(id, MACHINE); }
  advance(sec(10));
  await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());

  const ta = A(id).timingAnalysis;
  check(ta.heartbeatGaps >= 1, 'and survives to grade time', `got ${ta.heartbeatGaps}`);
  const gap = (ta.riskFactors ?? []).find((f) => f.code === 'heartbeat_gap');
  check(!!gap, 'heartbeat_gap is recorded as a factor');
  check(String(gap?.detail ?? '').includes('longest'), 'its detail carries the longest silence');
}

// ═══════════════════════════════════════════════════════════════════
// R-13 · violation context is recorded, and checked against the paper
// ═══════════════════════════════════════════════════════════════════
async function R13() {
  const id = await startWith(MACHINE);
  const served = A(id).questionOrder.SA;

  await call(fns.logViolation, {
    attemptId: id, type: 'tab_switch',
    context: { questionId: served[1], sectionId: 'SA', questionNumber: 2, sectionNumber: 1 },
  }, STUDENT());

  const ev = A(id).integrityLog.violations[0];
  eq(ev.questionId, served[1], 'the question is recorded on the event');
  eq(ev.sectionId, 'SA', 'and the section');
  eq(ev.questionNumber, 2, 'and the reading position');
}

async function R14() {
  const id = await startWith(MACHINE);

  // A position from a paper this student was never served. Stored as given it
  // would attribute the violation to a question that is not on their script —
  // the timeline would disagree with the answers printed beside it.
  await call(fns.logViolation, {
    attemptId: id, type: 'tab_switch',
    context: {
      questionId: 'q_from_another_exam',
      sectionId: 'SECTION_THAT_DOES_NOT_EXIST',
      questionNumber: 4,
    },
  }, STUDENT());

  const ev = A(id).integrityLog.violations[0];
  eq(ev.questionId, undefined, 'an unserved question id is dropped');
  eq(ev.sectionId, undefined, 'an unknown section id is dropped');
  // The violation itself still lands. Refusing the whole call over a garbled
  // position would turn a bad context into a MISSING detection, which is the
  // wrong way to fail.
  eq(ev.type, 'tab_switch', 'but the violation is still recorded');
  eq(A(id).integrityLog.tabSwitches, 1, 'and still counted');
}

async function R15() {
  const id = await startWith(MACHINE);

  // Junk of every shape the field accepts, plus an attempt to overwrite the
  // event's own type and timestamp through the context spread.
  await call(fns.logViolation, {
    attemptId: id, type: 'right_click',
    context: {
      questionId: 'X'.repeat(10_000),
      questionNumber: -5,
      sectionNumber: 999_999_999,
      type: 'multi_person',
      timestamp: '1999-01-01T00:00:00.000Z',
      evil: 'Y'.repeat(10_000),
    },
  }, STUDENT());

  const ev = A(id).integrityLog.violations[0];
  eq(ev.type, 'right_click', 'context cannot overwrite the event type');
  check(ev.timestamp.startsWith('2026'), 'nor the server timestamp', ev.timestamp);
  eq(ev.questionId, undefined, 'an oversized id is dropped, not clipped and kept');
  eq(ev.questionNumber, undefined, 'a negative position is dropped');
  eq(ev.sectionNumber, undefined, 'an absurd position is dropped');
  eq(ev.evil, undefined, 'unknown keys never reach the record');
}

async function R16() {
  const id = await startWith(MACHINE);
  // No context at all — every detector predating this, and any caller that
  // simply does not know where the student was.
  await call(fns.logViolation, { attemptId: id, type: 'paste_attempt', detail: 'Paste blocked' },
    STUDENT());
  const ev = A(id).integrityLog.violations[0];
  eq(ev.detail, 'Paste blocked', 'the detail is still stored');
  eq(ev.questionId, undefined, 'and no position is invented');
}

const SCENARIOS = [
  ['R-01', 'the baseline is server-held and written once', R01],
  ['R-02', 'an unchanged machine is silent', R02],
  ['R-03', 'an unreadable value is not a changed machine', R03],
  ['R-04', 'no baseline is ever adopted late', R04],
  ['R-05', 'repeated drift is one fact, bounded', R05],
  ['R-06', 'a hostile fingerprint payload is clipped and filtered', R06],
  ['R-07', 'drift is the heaviest factor at grade time', R07],
  ['R-08', 'clustered violations are measured', R08],
  ['R-09', 'spread violations are not a cluster', R09],
  ['R-10', 'a clean sitting scores zero explicitly', R10],
  ['R-11', 'the score is clamped but the factors are kept', R11],
  ['R-12', 'mid-session heartbeat gaps reach the score', R12],
  ['R-13', 'violation context is recorded', R13],
  ['R-14', 'a position off this attempt\'s paper is dropped', R14],
  ['R-15', 'a hostile context cannot rewrite the event', R15],
  ['R-16', 'no context is not an invented context', R16],
];

(async () => {
  for (const [id, title, fn] of SCENARIOS) await scenario(id, title, fn);

  const C = { r: '\x1b[31m', g: '\x1b[32m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
  let pass = 0, fail = 0;
  console.log(`\n${C.b}RISK SUITE${C.x}  —  real callables, in-memory Firestore, virtual clock\n`);
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
    ? `${C.g}${C.b}  ALL GREEN${C.x} — ${pass} passed across ${results.length} scenarios`
    : `${C.r}${C.b}  ${fail} FAILED${C.x} — ${pass} passed, ${fail} failed across ${results.length} scenarios`);
  process.exit(fail === 0 ? 0 : 1);
})();
