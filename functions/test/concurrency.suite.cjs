// ═══════════════════════════════════════════════════════════════════════════
// CONCURRENCY SUITE  (2026-08-06)
//
// M1. Every other scenario suite runs on fakeFirestore, whose runTransaction
// invokes the body ONCE, queues the writes, and commits them in order:
//
//     async runTransaction(fn) { const t = new Txn(this); const out = await
//     fn(t); await t._commit(); return out; }
//
// No read set, no conflict detection, no retry. Under that model two "racing"
// calls simply run one after the other and both succeed, so B-13, B-14 and
// P-08 are sequential simulations of races rather than tests of them. They are
// worth having — they pin the single-caller logic — but they cannot fail for
// the reason a race fails.
//
// This suite uses the REAL admin SDK against the Firestore emulator, so
// transactions have genuine read sets, genuine contention and genuine retries.
// The claim under test is the one startExam's own comment makes:
//
//     "Retrying was justified on the grounds that startExam is idempotent —
//      true only for SEQUENTIAL calls. This transaction is what makes that
//      claim true under concurrency, and therefore what makes the retry safe."
//
// Nothing verified that until now.
//
// WHY REAL PARALLELISM MATTERS HERE. Promise.all on a single Node thread does
// not make the JavaScript run simultaneously, but it does overlap the awaited
// Firestore round-trips: every call issues its transactional read before any
// of them commits, which is precisely the interleaving that produces a
// conflict. That is the race, and the emulator resolves it the way production
// does.
//
//   npm run test:concurrency        (starts the emulator for you)
// ═══════════════════════════════════════════════════════════════════════════

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error(
    '\n  FIRESTORE_EMULATOR_HOST is not set.\n'
    + '  Run this through the emulator: npm run test:concurrency\n',
  );
  process.exit(1);
}

const PROJECT = process.env.GCLOUD_PROJECT || 'demo-concurrency';
process.env.GCLOUD_PROJECT = PROJECT;

// NOTE: no fakeFirestore, and no monkeypatching of getFirestore or
// initializeApp. index.js calls initializeApp() at module load and the admin
// SDK routes to the emulator via FIRESTORE_EMULATOR_HOST, so the callables
// talk to a real Firestore implementation. That is the entire point of this
// file — stubbing either one would put us back on the fake.
const fns = require('../lib/index.js');
const { getFirestore } = require('firebase-admin/firestore');
const db = getFirestore();

// ── Reporting, matching the other suites ─────────────────────────
const results = [];
let current = null;
async function scenario(id, title, fn) {
  current = { id, title, checks: [], error: null };
  await clearFirestore();
  try { await fn(); } catch (e) { current.error = e; }
  results.push(current);
}
function check(pass, label, detail) {
  current.checks.push({ pass: !!pass, label, detail: detail === undefined ? null : String(detail) });
}
function eq(actual, expected, label) {
  check(actual === expected, label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/** Wipe between scenarios via the emulator's own endpoint — faster and more
 *  complete than deleting collections by hand. */
async function clearFirestore() {
  const url = `http://${process.env.FIRESTORE_EMULATOR_HOST}`
    + `/emulator/v1/projects/${PROJECT}/databases/(default)/documents`;
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) throw new Error(`clearFirestore failed: ${res.status}`);
}

async function call(fnRef, data, auth) {
  return fnRef.run({ data, auth, rawRequest: { headers: {} }, acceptsStreaming: false });
}
const STUDENT = (studentId = 'stu_1', instituteId = 'inst_1') =>
  ({ uid: `uid_${studentId}`, token: { role: 'student', studentId, instituteId } });

/** Settle N promises without letting one rejection hide the others. */
const settle = (ps) => Promise.allSettled(ps);
const fulfilled = (rs) => rs.filter((r) => r.status === 'fulfilled');
const rejected  = (rs) => rs.filter((r) => r.status === 'rejected');

const iso = (ms) => new Date(ms).toISOString();

async function seedWorld(opts = {}) {
  const now = Date.now();
  await db.collection('students').doc('stu_1').set({
    id: 'stu_1', name: 'Race Student', instituteId: 'inst_1', status: 'active',
  });
  await db.collection('assessments').doc('asmt_1').set({
    id: 'asmt_1', title: 'Concurrency Paper', instituteId: 'inst_1',
    ownerType: 'webOwner', ownerId: 'webOwner',
    status: 'active',
    startDate: iso(now - 60 * 60_000),
    endDate: iso(now + 600 * 60_000),
    maxAttempts: opts.maxAttempts ?? 1,
    overallTimeLimit: 60,
    deliveryMode: 'standard',
    sectionStartOrder: 'sequential',
    shuffleQuestions: false,
    securityTier: 'mock',
    requireCamera: false, allowMobile: true, requireExtensionCheck: false, requireSEB: false,
    securityLockedAt: iso(now - 120 * 60_000),
    passingScore: 40,
    assignedTo: { type: 'all' },
    allowReview: true, showResults: true,
    sections: [{
      id: 'SA', name: 'A', timeLimit: 30,
      questions: [{ questionId: 'q1', marks: 10, order: 0 }, { questionId: 'q2', marks: 10, order: 1 }],
    }],
  });
  for (const q of ['q1', 'q2']) {
    await db.collection('questions').doc(q).set({
      id: q, engine: 'mcq', variant: 'single', stem: `Question ${q}`,
      options: [{ id: 'alpha', text: 'Alpha' }, { id: 'beta', text: 'Beta' }],
      difficulty: 'medium',
    });
    await db.collection('questionAnswers').doc(q).set({
      id: q, correctIds: ['alpha'], correctPairs: [], modelAnswer: '',
    });
  }
}

const attemptsFor = async (studentId = 'stu_1') =>
  (await db.collection('attempts').where('studentId', '==', studentId).get()).docs;

// ═══════════════════════════════════════════════════════════════════
// X-01 · eight simultaneous starts produce exactly one attempt
//
// The double-start race. Every call reads the student's attempts before any
// of them commits, so each one sees "no live attempt" and believes it should
// create one. Only the transaction's read set stops eight sittings existing.
//
// B-13 asserts startExam is idempotent, but it calls it twice in sequence —
// by which time the first attempt is committed and visible, so the second
// takes the fast-path return and the transaction is never contended.
// ═══════════════════════════════════════════════════════════════════
async function X01() {
  await seedWorld();

  const N = 8;
  const rs = await settle(
    Array.from({ length: N }, () => call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT())),
  );

  const ok = fulfilled(rs);
  eq(ok.length, N, 'every concurrent caller got an answer rather than an error');

  const docs = await attemptsFor();
  eq(docs.length, 1, `exactly ONE attempt document exists after ${N} simultaneous starts`);

  const ids = new Set(ok.map((r) => r.value.attempt.id));
  eq(ids.size, 1, 'and every caller was handed the same attempt id');

  // The losers must receive the winner's attempt, not a hollow success.
  const winner = docs[0].id;
  check([...ids][0] === winner,
    'the id returned to callers is the one that was actually stored',
    `returned ${[...ids][0]}, stored ${winner}`);
  check(ok.every((r) => Array.isArray(r.value.attempt.sectionIds)
    && r.value.attempt.sectionIds.length > 0),
  'losers get the full attempt payload, not a stub');
}

// ═══════════════════════════════════════════════════════════════════
// X-02 · the attempt limit holds when the limit is already spent
//
// maxAttempts=1 with one FINISHED attempt on record. Every racing call reads
// the same finished attempt and must reach the same verdict. A limit enforced
// only by the pre-transaction fast path would let all of them through.
// ═══════════════════════════════════════════════════════════════════
async function X02() {
  await seedWorld({ maxAttempts: 1 });
  const now = Date.now();
  await db.collection('attempts').doc('att_done').set({
    id: 'att_done', assessmentId: 'asmt_1', studentId: 'stu_1', instituteId: 'inst_1',
    status: 'submitted', startedAt: iso(now - 30 * 60_000), submittedAt: iso(now - 10 * 60_000),
    answers: {}, sectionIds: ['SA'], currentSectionIdx: 0,
    sectionTimings: { SA: { startedAt: iso(now - 30 * 60_000), timeUsedSeconds: 0 } },
    questionOrder: { SA: ['q1', 'q2'] }, servedQuestions: [],
  });

  const N = 8;
  const rs = await settle(
    Array.from({ length: N }, () => call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT())),
  );

  eq(fulfilled(rs).length, 0, 'no concurrent caller slips past a spent attempt limit');
  eq(rejected(rs).length, N, 'every one of them is refused');
  check(rejected(rs).every((r) => String(r.reason.message).includes('ATTEMPT_LIMIT_EXCEEDED')),
    'and refused for the RIGHT reason, not an incidental error',
    rejected(rs)[0] && rejected(rs)[0].reason.message);

  const docs = await attemptsFor();
  eq(docs.length, 1, 'no second attempt document was created');
}

// ═══════════════════════════════════════════════════════════════════
// X-03 · a second sitting IS allowed when the limit permits one
//
// The control for X-02. A test that only ever proves "everything is refused"
// would pass just as happily against a startExam that refused everybody, so
// this pins the other side: with maxAttempts=2 and one finished attempt, the
// racing callers must produce exactly one NEW attempt — not zero, not eight.
// ═══════════════════════════════════════════════════════════════════
async function X03() {
  await seedWorld({ maxAttempts: 2 });
  const now = Date.now();
  await db.collection('attempts').doc('att_done').set({
    id: 'att_done', assessmentId: 'asmt_1', studentId: 'stu_1', instituteId: 'inst_1',
    status: 'submitted', startedAt: iso(now - 30 * 60_000), submittedAt: iso(now - 10 * 60_000),
    answers: {}, sectionIds: ['SA'], currentSectionIdx: 0,
    sectionTimings: { SA: { startedAt: iso(now - 30 * 60_000), timeUsedSeconds: 0 } },
    questionOrder: { SA: ['q1', 'q2'] }, servedQuestions: [],
  });

  const N = 6;
  const rs = await settle(
    Array.from({ length: N }, () => call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT())),
  );

  eq(fulfilled(rs).length, N, 'the second sitting is granted, to every caller');
  const docs = await attemptsFor();
  eq(docs.length, 2, 'exactly one NEW attempt exists alongside the finished one');

  const live = docs.filter((d) => d.get('status') === 'in_progress');
  eq(live.length, 1, 'and exactly one of them is live');
}

// ═══════════════════════════════════════════════════════════════════
// X-04 · racing finalisations grade the paper once
//
// P-08 and B-14 cover terminate idempotency and double-grading, sequentially.
// Under real contention the question is different: two calls both read an
// in_progress attempt before either writes, and both believe they are the one
// finalising it. The stored result must be a single coherent grade.
// ═══════════════════════════════════════════════════════════════════
async function X04() {
  await seedWorld();
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  const ref = db.collection('attempts').doc(id);
  await ref.update({
    [`answers.q1`]: { type: 'mcq', value: 'alpha', sectionId: 'SA', answeredAt: iso(Date.now()) },
  });

  const N = 6;
  const rs = await settle(
    Array.from({ length: N }, () => call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT())),
  );
  check(fulfilled(rs).length >= 1, 'at least one finalisation succeeds');

  const after = (await ref.get()).data();
  check(after.status === 'submitted' || after.status === 'graded',
    'the attempt ends in a finalised state', after.status);

  // The real property: one grade, not six accumulated ones.
  const docs = await attemptsFor();
  eq(docs.length, 1, 'no duplicate attempt was produced by the racing graders');
  check(typeof after.score === 'number' || after.score === undefined,
    'score is a single scalar, not an accumulation', JSON.stringify(after.score));
  if (typeof after.score === 'number') {
    check(after.score <= 20, 'and it cannot exceed the paper total however many graders ran',
      `score=${after.score} of 20`);
  }
}

// ═══════════════════════════════════════════════════════════════════
// X-05 · two releases race, and only one decision survives  (C-04 round 4)
//
// A pause has two exits: unfreezeAttempt, where a human decides how much of it
// to give back, and verifyAndResume, where the automatic policy gives back the
// lot. Both end the SAME pause through the same closeFreezeUpdates, which
// rebuilds the whole `freezes` array from the document it was handed and writes
// it back wholesale.
//
// unfreezeAttempt has always done that inside a transaction. verifyAndResume
// did it with a plain read-then-update, which is a read-modify-write on an
// array — the hazard reportExtensionCheck was made transactional to avoid, in
// its own words: "an append read-modify-written outside a transaction can lose
// a concurrent entry."
//
// The interleaving that costs something real: an invigilator decides this pause
// was the student's own fault and grants ZERO, while the student's auto-resume
// call is already in flight holding a pre-decision copy of the ledger. The
// non-transactional writer lands last and overwrites the human's decision with
// a full grant. That is F4 again — two writers, one field, and credit moving
// for a reason nobody authorised.
//
// This asserts the property rather than an ordering, because either caller may
// legitimately win: EXACTLY ONE release happens, and the stored credit is the
// one that release decided. The round-4 probe suite cannot test this at all —
// fakeFirestore commits transactions with no read set, so both callers succeed
// there whatever the code does.
// ═══════════════════════════════════════════════════════════════════
const STAFF = (uid = 'fac_1', role = 'faculty', instituteId = 'inst_1') =>
  ({ uid, token: { role, instituteId } });

async function X05() {
  // The one shipping configuration where a student can end their own pause:
  // normal tier (extension check armed) with auto-resume on.
  await seedWorld();
  await db.collection('assessments').doc('asmt_1').set({
    securityTier: 'normal', requireExtensionCheck: true, autoResume: true,
    requireCamera: false, allowMobile: true,
  }, { merge: true });

  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const id = started.attempt.id;

  // The student's own client opens the pause, then reports the machine clean —
  // which is the whole of what the auto-resume path used to ask of them.
  await call(fns.reportExtensionCheck,
    { attemptId: id, passed: false, found: ['ext_x'] }, STUDENT());
  const frozen = (await db.collection('attempts').doc(id).get()).data();
  eq(frozen.status, 'frozen', 'the sitting is paused');
  await call(fns.reportExtensionCheck, { attemptId: id, passed: true, found: [] }, STUDENT());

  // The race: a human granting nothing, against the policy granting everything.
  const rs = await settle([
    call(fns.unfreezeAttempt, { attemptId: id, grantedMs: 0, note: 'not credited' }, STAFF()),
    call(fns.verifyAndResume, { attemptId: id }, STUDENT()),
  ]);

  const released = fulfilled(rs).filter((r) => r.value?.resumed !== false);
  eq(released.length, 1, 'exactly ONE of the two releases took effect');

  const after = (await db.collection('attempts').doc(id).get()).data();
  eq(after.status, 'in_progress', 'and the sitting is running again');

  const ledger = after.freezes ?? [];
  eq(ledger.length, 1, 'the ledger holds one entry, not two copies of one pause');
  const entry = ledger[0];
  check(!!entry.endedAt, 'and it is closed');
  eq(after.creditedFreezeMs, entry.grantedMs ?? 0,
    'stored credit is exactly what the surviving release decided');

  // The sharp one. If the invigilator's transaction committed first, a
  // non-transactional auto-resume holding a pre-decision copy would write the
  // full grant back over the top of it.
  if (entry.decidedBy === 'fac_1') {
    eq(entry.grantedMs, 0, 'an invigilator\'s zero-grant decision is not overwritten');
    eq(after.creditedFreezeMs, 0, 'and no credit reached the deadlines');
  } else {
    check(entry.decidedBy === null || entry.decidedBy === undefined,
      'the automatic release won the race, and is recorded as having no decider',
      JSON.stringify(entry.decidedBy));
    check(entry.autoGranted === true, 'stamped as automatic, so C-02\'s budget counts it');
  }

  const rows = (await db.collection('deletionAudit')
    .where('action', '==', 'attemptUnfrozen').get()).docs;
  eq(rows.length, 1, 'one release, one audit row — not one row per caller');
}

// ═══════════════════════════════════════════════════════════════════
const SCENARIOS = [
  ['X-01', 'eight simultaneous starts produce exactly one attempt', X01],
  ['X-02', 'the attempt limit holds under contention', X02],
  ['X-03', 'a permitted second sitting is granted exactly once', X03],
  ['X-04', 'racing finalisations grade the paper once', X04],
  ['X-05', 'two releases race, one decision survives', X05],
];

(async () => {
  for (const [id, title, fn] of SCENARIOS) await scenario(id, title, fn);

  const C = { r: '\x1b[31m', g: '\x1b[32m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
  let pass = 0, fail = 0;
  console.log(`\n${C.b}CONCURRENCY SUITE${C.x}  —  real admin SDK, real transactions, emulator\n`);
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
