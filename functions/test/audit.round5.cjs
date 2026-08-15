// ═══════════════════════════════════════════════════════════════════════════
// AUDIT PROBE SUITE — ROUND 5  (2026-08-15)
//
// Rounds 2–4 went at the exam: the clocks, the paper, the marks, the pause.
// Every student-facing exam callable acquired the same three gates along the
// way, and they are now so consistent that the list reads like a contract:
//
//   assertSession      the sitting belongs to ONE browser session (INV-5a)
//   assertNotBlocked   an invigilator's block stops the sitting, not just a
//                      reload (D-21)
//   assertSEB          the exam-taker is inside Safe Exam Browser (Phase 3)
//
// startExam, startSection, submitSection, submitAnswerAndAdvance,
// saveAnswerNoAdvance, getExamVerdict, gradeAttempt, getExamQuestions,
// logViolation, examHeartbeat, reportExtensionCheck and verifyAndResume all
// carry the ones that apply to them.
//
// THE CODING SURFACE CARRIES NONE OF THEM. runCodeSample and
// recordCodeTelemetry were written later, for the judge pipeline, and inherited
// the gates that were obvious at the time — ownership, status, freeze, the
// answer window, the paper — while the three above were never added.
//
// That is this round's hypothesis, and it is the shape round 3 named: a rule
// that is right everywhere it was written and absent where it was not.
//
// Same standard as every suite here: real compiled callables, in-memory
// Firestore, virtual clock. The judge is the NullJudgeAdapter (JUDGE0_BASE_URL
// unset), which is exactly right — these probes ask whether the call is
// REFUSED, not what the judge said about the code.
//
//   node test/audit.round5.cjs
//   PROBE_TRACE=1 node test/audit.round5.cjs
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

process.env.GCLOUD_PROJECT = 'demo-audit-round5';
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

const STAFF   = (uid = 'fac_1', role = 'faculty', instituteId = 'inst_1') =>
  ({ uid, token: { role, instituteId } });
const STUDENT = (uid = 'stu_uid', studentId = 'stu_1', instituteId = 'inst_1') =>
  ({ uid, token: { role: 'student', studentId, instituteId } });

const A = (id) => DB.read('attempts', id);
const telemetryRows = () => DB.all('attemptTelemetry');

/** A hidden suite plus one visible sample, so a sample run has something to run. */
const codeTests = () => ([
  { id: 'vis0', stdin: '1', expected: '1', visible: true },
  { id: 'h0', stdin: '2', expected: '2', visible: false },
  { id: 'h1', stdin: '3', expected: '3', visible: false },
]);

function seedCodeQuestion(id) {
  DB.seed('questions', id, {
    id, engine: 'code', variant: 'single', stem: `Coding question ${id}`,
    difficulty: 'medium',
    codeSpec: { languages: ['python3'], timeLimitMs: 2000, memoryLimitKb: 65536 },
  });
  DB.seed('questionAnswers', id, {
    id, correctIds: [], correctPairs: [], modelAnswer: '', tests: codeTests(),
  });
}

/**
 * A coding paper on a tier that actually enforces things.
 *
 * `codeTelemetry` is on and the tier is not 'mock', because
 * recordCodeTelemetry returns `recording: false` and stores nothing on the
 * practice tier — a probe that seeded 'mock' would be asserting against a
 * callable that had already decided to do nothing, which is the trap round 3's
 * B-09 fell into.
 */
function seedWorld(opts = {}) {
  DB.seed('students', 'stu_1', { id: 'stu_1', name: 'Test Student', instituteId: 'inst_1' });
  DB.seed('assessments', 'asmt_1', {
    id: 'asmt_1', title: 'Round 5 Coding Paper', instituteId: 'inst_1',
    ownerType: 'webOwner', ownerId: 'webOwner',
    status: 'active',
    startDate: at(VNOW - min(60)),
    endDate: at(VNOW + min(600)),
    maxAttempts: 1,
    overallTimeLimit: 60,
    deliveryMode: 'standard',
    sectionStartOrder: 'sequential',
    shuffleQuestions: false,
    securityTier: 'normal',
    requireCamera: false,
    allowMobile: true,
    requireExtensionCheck: false,
    requireSEB: opts.requireSEB ?? false,
    autoResume: false,
    codeTelemetry: true,
    securityLockedAt: at(VNOW - min(120)),
    passingScore: 40,
    assignedTo: { type: 'all' },
    allowReview: true,
    showResults: true,
    blockedStudents: opts.blockedStudents,
    sections: [{
      id: 'SA', name: 'A', timeLimit: 30,
      questions: [{ questionId: 'c1', marks: 10, order: 0 }],
    }],
  });
  seedCodeQuestion('c1');
  seedCodeQuestion('c_elsewhere');   // a real question, on somebody else's paper
}

/** Start a sitting whose session is claimed by device A, as the shell does. */
async function startClaimed(sessionId = 'sess_A', opts = {}) {
  seedWorld(opts);
  const started = await call(fns.startExam,
    { assessmentId: 'asmt_1', sessionId }, STUDENT());
  const id = started.attempt.id;
  eq(A(id).activeSessionId, sessionId, 'the opening device owns the sitting from birth');
  return id;
}

const RUN = (id, extra = {}) => ({
  attemptId: id, questionId: 'c1', language: 'python3',
  source: 'print(input())', ...extra,
});
const TEL = (id, extra = {}) => ({
  attemptId: id, questionId: 'c1', seq: 0,
  events: [{ t: 1, k: 'insert', v: 'x' }], ...extra,
});

// ═══════════════════════════════════════════════════════════════════
// D-01 · a superseded device cannot run code or write telemetry
//
// INV-5a: one sitting, one session. registerSession makes the JOINING device
// the owner and records the conflict server-side, and every exam callable then
// refuses the loser — P-15 proves that for submitSection, and assertSession is
// the single expression of it.
//
// Neither coding callable calls it. Two consequences, and the second is worse
// than the first:
//
//   (a) The superseded device keeps the judge. Sample runs are a metered exam
//       resource — maxPerQuestion, a cooldown, real compute — and a second
//       browser spending them is a second person working the paper.
//
//   (b) The superseded device keeps WRITING THE EVIDENCE. attemptTelemetry is
//       the record of how an answer was produced, and the callable's own
//       comment says a finished attempt must not acquire new telemetry because
//       "that would let a record be extended after the fact, which is exactly
//       what an append-only log is supposed to prevent." A device that lost
//       the session can extend it in exactly that way — and the rows it writes
//       are indistinguishable from the real candidate's.
// ═══════════════════════════════════════════════════════════════════
async function D01() {
  const id = await startClaimed('sess_A');

  // Device B joins and takes the sitting, exactly as a reconnect would.
  await call(fns.registerSession, { attemptId: id, sessionId: 'sess_B' }, STUDENT());
  eq(A(id).activeSessionId, 'sess_B', 'the joining device now owns the sitting');

  // The control first: the CURRENT device works. If this failed, the refusals
  // below would prove nothing about sessions.
  const okRun = await call(fns.runCodeSample, RUN(id, { sessionId: 'sess_B' }), STUDENT());
  check(okRun?.ok === true || okRun?.reason === 'no_samples',
    'the current device can still run code', JSON.stringify(okRun?.reason ?? okRun?.ok));
  const okTel = await call(fns.recordCodeTelemetry, TEL(id, { sessionId: 'sess_B' }), STUDENT());
  eq(okTel.stored, 1, 'and can still write telemetry');

  const rowsBefore = telemetryRows().length;

  // (a) and (b): the superseded device.
  await expectThrow('a superseded device cannot run code',
    () => call(fns.runCodeSample, RUN(id, { sessionId: 'sess_A' }), STUDENT()),
    'SESSION_SUPERSEDED');
  await expectThrow('a superseded device cannot write telemetry',
    () => call(fns.recordCodeTelemetry, TEL(id, { sessionId: 'sess_A', seq: 1 }), STUDENT()),
    'SESSION_SUPERSEDED');
  eq(telemetryRows().length, rowsBefore,
    'and no row it tried to write reached the record');
}

// ═══════════════════════════════════════════════════════════════════
// D-02 · a blocked student cannot run code or write telemetry
//
// D-21 settled that a block must stop the sitting advancing, not merely a
// reload, which is why assertNotBlocked sits on both answer paths and both
// section transitions. Round 3's B-12 then established that blockedStudents is
// THE live lever an invigilator pulls mid-sitting — de-allocation deliberately
// does not eject anyone, so this list is the whole of the mechanism.
//
// Pulling it leaves the coding surface running: the student cannot answer,
// cannot advance and cannot submit, but can still spend judge capacity and
// still append to their own evidence log.
// ═══════════════════════════════════════════════════════════════════
async function D02() {
  const id = await startClaimed('sess_A');

  // Blocked mid-sitting, the way P-20 blocks.
  const a = DB.read('assessments', 'asmt_1');
  a.blockedStudents = ['stu_1'];
  DB.seed('assessments', 'asmt_1', a);

  // The block bites on the paths that already had the gate — the baseline this
  // probe is measured against. submitSection rather than startSection: section
  // SA is auto-started at startExam, so a start call is refused as
  // already-started before it ever reaches assertNotBlocked, and a probe whose
  // baseline throws for the wrong reason is measuring nothing. submitSection
  // runs the gate before any write, so a refusal here changes no state.
  await expectThrow('a blocked student cannot submit their section',
    () => call(fns.submitSection,
      { attemptId: id, sectionId: 'SA', sessionId: 'sess_A' }, STUDENT()),
    'BLOCKED_FROM_EXAM');
  eq(A(id).status, 'in_progress', 'and the refusal left the sitting untouched');

  const rowsBefore = telemetryRows().length;
  await expectThrow('a blocked student cannot run code either',
    () => call(fns.runCodeSample, RUN(id, { sessionId: 'sess_A' }), STUDENT()),
    'BLOCKED_FROM_EXAM');
  await expectThrow('nor write telemetry',
    () => call(fns.recordCodeTelemetry, TEL(id, { sessionId: 'sess_A' }), STUDENT()),
    'BLOCKED_FROM_EXAM');
  eq(telemetryRows().length, rowsBefore, 'and nothing was recorded while blocked');
}

// ═══════════════════════════════════════════════════════════════════
// D-03 · telemetry cannot be written against a question off the paper
//
// A-09's shape, in the collection built after it: caller-supplied input naming
// a stored document. recordCodeTelemetry writes
//
//     attemptTelemetry/{attemptId}__{questionId}__{seq}
//
// with questionId straight from request.data and no membership check, while
// runCodeSample — its sibling, on the same paper, in the same file — refuses a
// question that is not on the attempt's own contract in as many words: "that
// question is not on your paper."
//
// Nothing is stolen by this. It shapes stored state from unvalidated input and
// puts rows that no attempt can explain into the collection reviewers read,
// which is what A-09 was fixed for.
// ═══════════════════════════════════════════════════════════════════
async function D03() {
  const id = await startClaimed('sess_A');

  // The sibling's behaviour, as the standard this is measured against.
  await expectThrow('runCodeSample refuses a question that is not on the paper',
    () => call(fns.runCodeSample,
      RUN(id, { questionId: 'c_elsewhere', sessionId: 'sess_A' }), STUDENT()),
    'not on your paper');

  const rowsBefore = telemetryRows().length;
  await expectThrow('and telemetry refuses it too',
    () => call(fns.recordCodeTelemetry,
      TEL(id, { questionId: 'c_elsewhere', sessionId: 'sess_A' }), STUDENT()),
    'not on your paper');
  eq(telemetryRows().length, rowsBefore, 'no row is created for a question off the paper');

  // A question id that is not a question at all is refused by the same check,
  // rather than creating a document keyed on arbitrary caller text.
  await expectThrow('nor for an id that names nothing',
    () => call(fns.recordCodeTelemetry,
      TEL(id, { questionId: 'NOT_A_QUESTION', sessionId: 'sess_A' }), STUDENT()),
    'not on your paper');
  check(!telemetryRows().some((r) => r.id.includes('NOT_A_QUESTION')),
    'and no attemptTelemetry document is keyed on it',
    telemetryRows().map((r) => r.id).join(', '));
}

// ═══════════════════════════════════════════════════════════════════
// D-04 · what must NOT change — the ordinary coding path still works
//
// Every fix in this round adds a refusal to a hot, student-facing callable on
// a paper the candidate is actively working. The failure mode of getting it
// wrong is a candidate who cannot run their code, which is worse than the
// defects being fixed. So: the normal case, end to end, on the same tier.
// ═══════════════════════════════════════════════════════════════════
async function D04() {
  const id = await startClaimed('sess_A');

  const run = await call(fns.runCodeSample, RUN(id, { sessionId: 'sess_A' }), STUDENT());
  check(run?.ok === true, 'a candidate on the owning device can run their code',
    JSON.stringify(run));
  if (run?.ok) {
    check(typeof run.remaining === 'number', 'and is told how many runs remain', run.remaining);
    // The judge is the null adapter here, so this is 'judge_unavailable' — the
    // point is that the CALL succeeded and reported the judge honestly rather
    // than reading as "your code failed".
    eq(run.judgeAvailable, false, 'an unconfigured judge is reported as unavailable, not as a wrong answer');
  }

  const tel = await call(fns.recordCodeTelemetry, TEL(id, { sessionId: 'sess_A' }), STUDENT());
  eq(tel.stored, 1, 'and their keystrokes are recorded');
  eq(telemetryRows().length, 1, 'as exactly one chunk document');
  check(telemetryRows()[0].id.startsWith(`${id}__c1__`),
    'keyed by attempt and question', telemetryRows()[0].id);

  // A LEGACY CLIENT sends no sessionId at all. assertSession tolerates that
  // while REQUIRE_SESSION_ID is false, and it must keep tolerating it here or
  // the fix strands every candidate whose bundle predates the change.
  const legacyRun = await call(fns.runCodeSample, RUN(id), STUDENT());
  check(legacyRun?.ok === true || legacyRun?.reason === 'cooling_down',
    'a client that sends no sessionId is still served, as everywhere else',
    JSON.stringify(legacyRun?.reason ?? legacyRun?.ok));
  const legacyTel = await call(fns.recordCodeTelemetry, TEL(id, { seq: 1 }), STUDENT());
  eq(legacyTel.stored, 1, 'and can still record telemetry');

  // Staff have no business on these paths, and did not before this round.
  await expectThrow('staff still cannot run a student\'s code through their quota',
    () => call(fns.runCodeSample, RUN(id), STAFF()), 'Not your attempt');
  await expectThrow('nor write telemetry into their record',
    () => call(fns.recordCodeTelemetry, TEL(id, { seq: 2 }), STAFF()), 'Not your attempt');

  KNOWN_GAPS.push(
    'SEB is the third gate and is NOT closed by this round. runCodeSample and '
    + 'recordCodeTelemetry do not call assertSEB, and submissionService.ts says so on '
    + 'purpose: "Deliberately NOT wrapped in withSeb, matching the server… Worth '
    + 'revisiting — the platform\'s posture is that SEB binds the exam-taker — but the '
    + 'exposure is small, since a run returns only sample results the candidate can '
    + 'already see inside SEB." That reasoning holds for runCodeSample and is weaker for '
    + 'telemetry, which is evidence rather than feedback. Left as the documented '
    + 'deferral it already is rather than changed under cover of this round: closing it '
    + 'means adding SEB_SIGNING_SECRET to both callables and a withSeb wrapper on both '
    + 'clients, and an exam whose candidates cannot run code because a secret is missing '
    + 'is a worse day than the exposure it removes.',
  );
}

// ═══════════════════════════════════════════════════════════════════
const SCENARIOS = [
  ['D-01', 'a superseded device cannot reach the judge or the record', D01],
  ['D-02', 'a blocked student cannot reach them either', D02],
  ['D-03', 'telemetry is bound to the paper the student sat', D03],
  ['D-04', 'the ordinary coding path is untouched', D04],
];

(async () => {
  for (const [id, title, fn] of SCENARIOS) await scenario(id, title, fn);

  const C = { r: '\x1b[31m', g: '\x1b[32m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
  let pass = 0, fail = 0;
  console.log(`\n${C.b}AUDIT PROBE SUITE — ROUND 5${C.x}  —  real callables, in-memory Firestore, virtual clock\n`);
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
