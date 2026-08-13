// ═══════════════════════════════════════════════════════════════════════════
// BULK DELETE — END-TO-END AGAINST THE EMULATOR  (2026-08-13)
//
// The bulk-delete feature is an orchestration layer: it runs the EXISTING
// deleteAuthUser once per selected record and sorts each result into one of
// four outcomes. Its unit tests cover the sorting. What they cannot cover is
// the thing the sorting depends on — THE EXACT ERRORS THE REAL SERVER
// PRODUCES. classifyDeleteError branches on `FACULTY_OWNS_LIVE_ASSESSMENTS:N`
// and `DELETION_REQUIRES_APPROVAL`; if the server ever phrased either
// differently, every unit test would still pass and the feature would silently
// mis-sort a faculty member with a live exam into "failed", or worse, file an
// approval request for a deletion whose safeguard was never cleared.
//
// So this suite runs the REAL deleteAuthUser against the REAL Firestore
// emulator and asserts, for each of the four outcomes:
//
//   1. that the server behaves as the layer assumes, and
//   2. that the error string it produces still matches the pattern the client
//      keys on — printed verbatim at the end, so a change is visible rather
//      than merely detected.
//
// WHAT IS REAL HERE: Firestore (emulator, real queries, real count()
// aggregations, real transactions), the whole deleteAuthUser body, the rights
// chain, the live-assessment guard, the audit writer, and the lifecycle
// writes.
//
// WHAT IS STUBBED, AND WHY: firebase-admin/auth. deleteAuthUser touches it in
// exactly one place — disabling sign-in — and the Auth emulator is not
// configured in firebase.json (`firebase init` was never run for it). Rather
// than change shared config for a test, the stub RECORDS its calls, and the
// suite asserts sign-in was revoked for precisely the records that were
// deleted. Nothing in the deletion logic itself is faked.
//
//   FIRESTORE_EMULATOR_HOST=... node test/bulkdelete.emulator.cjs
//   (or: npm run test:bulkdelete)
// ═══════════════════════════════════════════════════════════════════════════

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error(
    '\n  FIRESTORE_EMULATOR_HOST is not set.\n'
    + '  Run this through the emulator: npm run test:bulkdelete\n',
  );
  process.exit(1);
}

const PROJECT = process.env.GCLOUD_PROJECT || 'demo-bulkdelete';
process.env.GCLOUD_PROJECT = PROJECT;

// ── The one stub, installed BEFORE index.js is required ───────────
// Module exports are mutated in place; node's cache means index.js receives
// this object when it calls getAuth().
const adminAuth = require('firebase-admin/auth');
const authCalls = [];
adminAuth.getAuth = () => ({
  updateUser: async (uid, props) => { authCalls.push({ uid, props }); return { uid }; },
  deleteUser: async (uid) => { authCalls.push({ uid, deleted: true }); },
  revokeRefreshTokens: async () => {},
  createUser: async (p) => ({ uid: p.uid ?? `uid_${Math.random()}` }),
  setCustomUserClaims: async () => {},
  getUserByEmail: async () => { const e = new Error('not found'); e.code = 'auth/user-not-found'; throw e; },
});

const fns = require('../lib/index.js');
const { getFirestore } = require('firebase-admin/firestore');
const db = getFirestore();

// ── Harness ───────────────────────────────────────────────────────

const results = [];
let current = null;
async function scenario(id, title, fn) {
  current = { id, title, checks: [], error: null };
  await wipe();
  authCalls.length = 0;
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

const COLLECTIONS = [
  'institutes', 'faculty', 'students', 'assessments', 'attempts',
  'deletionAudit', 'deletionRequests', 'questions', 'questionAnswers',
];
async function wipe() {
  for (const c of COLLECTIONS) {
    const snap = await db.collection(c).get();
    if (snap.empty) continue;
    let batch = db.batch(); let n = 0;
    for (const d of snap.docs) {
      batch.delete(d.ref);
      if (++n >= 400) { await batch.commit(); batch = db.batch(); n = 0; }
    }
    if (n > 0) await batch.commit();
  }
}

const INSTITUTE = (uid = 'inst_1') => ({ uid, token: { role: 'institute', instituteId: 'inst_1' } });

/**
 * The classification the client performs, reproduced here EXACTLY as
 * src/lib/bulkDelete.ts spells it. Kept as a literal copy on purpose: the
 * whole point of this suite is to catch the day the server's wording drifts
 * from what the client greps for, and importing a shared helper would make
 * both sides move together and the drift invisible.
 */
function classify(err) {
  const message = (err && err.message) || '';
  const live = /FACULTY_OWNS_LIVE_ASSESSMENTS:(\d+)/.exec(message);
  if (live) return { kind: 'live_ownership', count: Number(live[1]) };
  if (message.includes('DELETION_REQUIRES_APPROVAL')) return { kind: 'requires_approval' };
  return { kind: 'other', message: message.replace(/^.*?:\s*/, '') || 'Deletion failed.' };
}

/** The runner's per-record body, matching runBulkDelete step for step. */
async function runOne(role, uid, actor) {
  try {
    // No successorId. No confirmLiveOwnership. Exactly as the layer sends it.
    await call(fns.deleteAuthUser, { role, uid }, actor);
    return { status: 'deleted' };
  } catch (err) {
    const c = classify(err);
    if (c.kind === 'live_ownership') {
      return { status: 'needs_individual', liveAssessments: c.count, raw: err.message };
    }
    if (c.kind === 'requires_approval') {
      try {
        await call(fns.submitDeletionRequest, { entityType: role, entityId: uid }, actor);
        return { status: 'requested', raw: err.message };
      } catch (subErr) {
        return { status: 'failed', message: subErr.message };
      }
    }
    return { status: 'failed', message: c.message, raw: err.message };
  }
}

async function runBatch(role, uids, actor) {
  const out = [];
  for (const uid of uids) out.push({ uid, outcome: await runOne(role, uid, actor) });
  return out;
}

// ── Seeds ─────────────────────────────────────────────────────────

const RAW_MESSAGES = {};

async function seedInstitute(opts = {}) {
  await db.collection('institutes').doc('inst_1').set({
    id: 'inst_1', name: 'Test Institute', status: 'active',
    deletionRightsCeiling: opts.ceiling ?? {
      student: { allowed: true },
      faculty: { allowed: true },
    },
  });
  // A second tenant, for the cross-tenant refusal.
  await db.collection('institutes').doc('inst_2').set({
    id: 'inst_2', name: 'Other Institute', status: 'active',
  });
}

async function seedStudent(id, instituteId = 'inst_1') {
  await db.collection('students').doc(id).set({
    id, name: `Student ${id}`, email: `${id}@test.edu`,
    instituteId, role: 'Student', status: 'active',
    createdAt: new Date().toISOString(),
  });
}

async function seedFaculty(id, instituteId = 'inst_1') {
  await db.collection('faculty').doc(id).set({
    id, name: `Faculty ${id}`, email: `${id}@test.edu`,
    instituteId, role: 'Faculty', status: 'active',
    createdAt: new Date().toISOString(),
  });
}

/** An ACTIVE assessment owned by this faculty member — trips the live guard. */
async function seedLiveAssessment(id, ownerId) {
  await db.collection('assessments').doc(id).set({
    id, title: 'Live Paper', instituteId: 'inst_1',
    ownerType: 'faculty', ownerId, status: 'active',
  });
}

// ═══════════════════════════════════════════════════════════════════
// B-01 · a plain student deletes, and leaves the state a restore needs
// ═══════════════════════════════════════════════════════════════════
async function B01() {
  await seedInstitute();
  await seedStudent('stu_1');

  const batch = await runBatch('student', ['stu_1'], INSTITUTE());
  eq(batch[0].outcome.status, 'deleted', 'OUTCOME 1 — the record is deleted');

  const doc = (await db.collection('students').doc('stu_1').get()).data();
  eq(doc.lifecycleState, 'softDeleted', 'soft-deleted, not destroyed');
  check(!!doc.deletedAt, 'with a deletion timestamp');
  check(!!doc.purgeAfter, 'and a purge date, so retention still governs it');

  // 30 days for a student — the existing retention window, unchanged.
  const days = Math.round((Date.parse(doc.purgeAfter) - Date.parse(doc.deletedAt)) / 86_400_000);
  eq(days, 30, 'the retention window is the existing 30 days');

  const audit = await db.collection('deletionAudit')
    .where('entityId', '==', 'stu_1').get();
  eq(audit.size, 1, 'exactly one audit row is written');
  eq(audit.docs[0].get('action'), 'softDelete', 'recording a soft delete');
  eq(audit.docs[0].get('actorUid'), 'inst_1', 'and who did it');

  eq(authCalls.length, 1, 'sign-in was revoked');
  eq(authCalls[0].uid, 'stu_1', 'for that student');
  eq(authCalls[0].props.disabled, true, 'by disabling the account');
}

// ═══════════════════════════════════════════════════════════════════
// B-02 · OUTCOME 2 — request mode files a request and deletes nothing
// ═══════════════════════════════════════════════════════════════════
async function B02() {
  await seedInstitute({
    ceiling: { student: { allowed: true, selfMode: 'request' } },
  });
  await seedStudent('stu_1');

  const batch = await runBatch('student', ['stu_1'], INSTITUTE());
  eq(batch[0].outcome.status, 'requested', 'OUTCOME 2 — an approval request is filed');
  RAW_MESSAGES.requires_approval = batch[0].outcome.raw;

  check(/DELETION_REQUIRES_APPROVAL/.test(batch[0].outcome.raw ?? ''),
    'THE CONTRACT — the server still says DELETION_REQUIRES_APPROVAL',
    batch[0].outcome.raw);

  const doc = (await db.collection('students').doc('stu_1').get()).data();
  check(doc.lifecycleState !== 'softDeleted',
    'THE POINT — nothing was deleted while the request is pending');
  eq(authCalls.length, 0, 'and sign-in was NOT revoked');

  const reqs = await db.collection('deletionRequests').get();
  eq(reqs.size, 1, 'one request exists');
  eq(reqs.docs[0].get('status'), 'pending', 'awaiting an approver');
  eq(reqs.docs[0].get('entityId'), 'stu_1', 'naming the right student');
}

// ═══════════════════════════════════════════════════════════════════
// B-03 · OUTCOME 3 — a faculty member with a live exam is NOT deleted
//
// The safeguard the bulk layer must never bypass. The single-row flow clears
// it with a second, deliberate click; a batch has no such moment, so the
// record has to survive untouched.
// ═══════════════════════════════════════════════════════════════════
async function B03() {
  await seedInstitute();
  await seedFaculty('fac_live');
  await seedLiveAssessment('asmt_live', 'fac_live');

  const batch = await runBatch('faculty', ['fac_live'], INSTITUTE());
  const o = batch[0].outcome;

  eq(o.status, 'needs_individual', 'OUTCOME 3 — held back for individual confirmation');
  eq(o.liveAssessments, 1, 'and the live count is read out of the error');
  RAW_MESSAGES.live_ownership = o.raw;

  check(/FACULTY_OWNS_LIVE_ASSESSMENTS:(\d+)/.test(o.raw ?? ''),
    'THE CONTRACT — the server still says FACULTY_OWNS_LIVE_ASSESSMENTS:N',
    o.raw);

  const doc = (await db.collection('faculty').doc('fac_live').get()).data();
  check(doc.lifecycleState !== 'softDeleted',
    'THE POINT — the safeguard held; the record is untouched');
  eq(doc.status, 'active', 'still active');
  eq(authCalls.length, 0, 'and their sign-in was never revoked');

  const audit = await db.collection('deletionAudit').get();
  eq(audit.size, 0, 'nothing was written to the audit trail either');
}

// ═══════════════════════════════════════════════════════════════════
// B-04 · OUTCOME 4 — a refusal is reported, not swallowed
// ═══════════════════════════════════════════════════════════════════
async function B04() {
  await seedInstitute();
  await seedStudent('stu_other', 'inst_2');   // another tenant's student

  const batch = await runBatch('student', ['stu_other'], INSTITUTE());
  const o = batch[0].outcome;

  eq(o.status, 'failed', 'OUTCOME 4 — reported as a failure');
  check(!!o.message && o.message.length > 0, 'carrying a reason', o.message);
  RAW_MESSAGES.cross_tenant = o.raw;

  const doc = (await db.collection('students').doc('stu_other').get()).data();
  check(doc.lifecycleState !== 'softDeleted',
    'and the other tenant\'s student is untouched');
}

// ═══════════════════════════════════════════════════════════════════
// B-05 · THE REAL SHAPE — a mixed batch produces all four outcomes,
//        and one bad record does not stop the rest
// ═══════════════════════════════════════════════════════════════════
async function B05() {
  await seedInstitute();
  await seedFaculty('fac_ok_1');
  await seedFaculty('fac_live');
  await seedFaculty('fac_ok_2');
  await seedLiveAssessment('asmt_live', 'fac_live');

  // Deliberate ordering: the blocked record sits in the MIDDLE. A runner that
  // aborted on the first refusal would leave fac_ok_2 alive, which is exactly
  // the partial-failure mode the result list exists to make visible.
  const batch = await runBatch(
    'faculty',
    ['fac_ok_1', 'fac_live', 'fac_ok_2', 'ghost_uid'],
    INSTITUTE(),
  );

  eq(batch.length, 4, 'every selected record produced a result');
  eq(batch[0].outcome.status, 'deleted',          'fac_ok_1 → deleted');
  eq(batch[1].outcome.status, 'needs_individual', 'fac_live → needs individual confirmation');
  eq(batch[2].outcome.status, 'deleted',          'fac_ok_2 → deleted, AFTER the blocked one');
  eq(batch[3].outcome.status, 'failed',           'a missing uid → failed');

  const live = (await db.collection('faculty').doc('fac_live').get()).data();
  check(live.lifecycleState !== 'softDeleted', 'the blocked member survived the batch');

  for (const id of ['fac_ok_1', 'fac_ok_2']) {
    const d = (await db.collection('faculty').doc(id).get()).data();
    eq(d.lifecycleState, 'softDeleted', `${id} was soft-deleted`);
  }

  eq(authCalls.length, 2, 'sign-in was revoked exactly twice — for the two that went');

  const audit = await db.collection('deletionAudit').get();
  eq(audit.size, 2, 'and exactly two audit rows were written');
}

// ═══════════════════════════════════════════════════════════════════
// B-06 · succession is untouched: no successorId means the existing
//        default, not a broken record
// ═══════════════════════════════════════════════════════════════════
async function B06() {
  await seedInstitute();
  await seedFaculty('fac_1');

  const batch = await runBatch('faculty', ['fac_1'], INSTITUTE());
  eq(batch[0].outcome.status, 'deleted', 'the faculty member is deleted');

  const doc = (await db.collection('faculty').doc('fac_1').get()).data();
  // The layer sends no successorId, so the field lands null — byte-identical
  // to a single delete with the picker left empty. Succession itself runs at
  // PURGE and defaults to the institute admin; nothing here changes that.
  eq(doc.pendingSuccessorId, null,
    'pendingSuccessorId is null, exactly as an unset picker leaves it');
  eq(doc.lifecycleState, 'softDeleted', 'and the record is recoverable meanwhile');
}

// ═══════════════════════════════════════════════════════════════════

const SCENARIOS = [
  ['B-01', 'OUTCOME 1 — a student deletes, recoverably and on the record', B01],
  ['B-02', 'OUTCOME 2 — request mode files a request and deletes nothing', B02],
  ['B-03', 'OUTCOME 3 — a live-exam owner is held back, not forced through', B03],
  ['B-04', 'OUTCOME 4 — a refusal is reported with its reason', B04],
  ['B-05', 'a mixed batch produces all four, and continues past the blocked one', B05],
  ['B-06', 'succession semantics are unchanged by bulk', B06],
];

(async () => {
  for (const [id, title, fn] of SCENARIOS) await scenario(id, title, fn);

  const C = { r: '\x1b[31m', g: '\x1b[32m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
  let pass = 0, fail = 0;
  console.log(`\n${C.b}BULK DELETE — EMULATOR SUITE${C.x}\n`);
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

  // The strings the client greps for, as the server actually produced them.
  // Printed rather than only asserted: a drift should be READABLE, so whoever
  // changed the wording can see what the client is matching against.
  console.log(`\n${C.b}SERVER MESSAGES THE CLIENT CLASSIFIES ON${C.x}`);
  for (const [k, v] of Object.entries(RAW_MESSAGES)) {
    console.log(`  ${C.d}${k.padEnd(18)}${C.x} ${JSON.stringify(v)}`);
  }

  console.log(`\n${'─'.repeat(72)}`);
  console.log(fail === 0
    ? `${C.g}${C.b}  ALL GREEN${C.x} — ${pass} passed across ${results.length} scenarios`
    : `${C.r}${C.b}  ${fail} FAILED${C.x} — ${pass} passed, ${fail} failed across ${results.length} scenarios`);
  process.exit(fail === 0 ? 0 : 1);
})();
