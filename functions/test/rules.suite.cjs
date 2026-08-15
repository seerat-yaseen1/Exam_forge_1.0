// ═══════════════════════════════════════════════════════════════════════════
// FIRESTORE RULES SUITE  (2026-08-06)
//
// The gap this closes was named in audit.round3.cjs's own KNOWN GAPS block:
//
//   "C1's PRIMARY fix is the firestore.rules change ... This harness has no
//    rules engine, so B-16 proves only the server-side half ... That no rules
//    test exists anywhere in this repo is itself the gap."
//
// firestore.rules is 70 KB of security boundary that, until this file, nothing
// executed. Every other suite in this directory runs against fakeFirestore,
// which has no concept of rules at all — so a rule could be deleted outright
// and all six suites would stay green.
//
// This one runs the REAL rules file against the REAL rules engine in the
// Firestore emulator. `initializeTestEnvironment` loads firestore.rules from
// disk, so there is no second copy to drift.
//
// WHAT IT COVERS, and why these and not everything. The rules file is large
// and this is not an attempt to cover all of it. It covers the boundary the
// 2026-08-06 audit found broken (C1/H1), the tenancy boundary either side of
// it, and the attempts whitelists — the collection holding actual exam
// answers. Those are the rules where a regression is a security incident
// rather than a bug.
//
//   node test/rules.suite.cjs        (expects FIRESTORE_EMULATOR_HOST set)
//   npm run test:rules               (starts the emulator for you)
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} = require('@firebase/rules-unit-testing');
const { collection, doc, documentId, getDoc, getDocs, query, setDoc, updateDoc, where } = require('firebase/firestore');
const { ref: storageRef, getBytes, listAll, uploadBytes } = require('firebase/storage');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error(
    '\n  FIRESTORE_EMULATOR_HOST is not set.\n'
    + '  Run this through the emulator: npm run test:rules\n',
  );
  process.exit(1);
}

const RULES_PATH = path.resolve(__dirname, '..', '..', 'firestore.rules');
const STORAGE_RULES_PATH = path.resolve(__dirname, '..', '..', 'storage.rules');

// ── Reporting, matching the other suites in this directory ───────
const results = [];
let current = null;
async function scenario(id, title, fn) {
  current = { id, title, checks: [], error: null };
  try { await fn(); } catch (e) { current.error = e; }
  results.push(current);
}
function check(pass, label, detail) {
  current.checks.push({ pass: !!pass, label, detail: detail === undefined ? null : String(detail) });
}
// NOTE: assertFails/assertSucceeds take the PROMISE, not the thunk. Passing
// the function itself makes both of them vacuously pass, which shows up as
// every single denial assertion reporting "the rules ALLOWED this" — a whole
// suite that cannot fail. `op()` is the entire difference.

/** The write must be REFUSED by the rules. */
async function denied(label, op) {
  try { await assertFails(op()); check(true, label); }
  catch (e) { check(false, label, 'the rules ALLOWED this'); }
}
/** The write must be PERMITTED by the rules. */
async function allowed(label, op) {
  try { await assertSucceeds(op()); check(true, label); }
  catch (e) { check(false, label, `the rules refused it: ${e.message}`); }
}

// ── Actors ───────────────────────────────────────────────────────
// Claim shapes copied from the auth contexts: role plus the one id the
// matching helper in firestore.rules reads.
let env;
const asWebOwner = () => env.authenticatedContext('wo_1', { role: 'webOwner' }).firestore();
const asInstitute = (id = 'inst_1') =>
  env.authenticatedContext(id, { role: 'institute', instituteId: id }).firestore();
const asFaculty = (fid = 'fac_1', inst = 'inst_1') =>
  env.authenticatedContext(fid, { role: 'faculty', facultyId: fid, instituteId: inst }).firestore();
const asStudent = (sid = 'stu_1', inst = 'inst_1') =>
  env.authenticatedContext(`uid_${sid}`, { role: 'student', studentId: sid, instituteId: inst }).firestore();

// Storage counterparts of the actors above.
const stAsWebOwner = () => env.authenticatedContext('wo_1', { role: 'webOwner' }).storage();
const stAsFaculty = (fid = 'fac_1', inst = 'inst_1') =>
  env.authenticatedContext(fid, { role: 'faculty', facultyId: fid, instituteId: inst }).storage();
const stAsStudent = (sid = 'stu_1', inst = 'inst_1') =>
  env.authenticatedContext(`uid_${sid}`, { role: 'student', studentId: sid, instituteId: inst }).storage();
const stUnauth = () => env.unauthenticatedContext().storage();

/** Seed with rules DISABLED — fixtures are not the thing under test. */
async function seed(fn) {
  await env.withSecurityRulesDisabled(async (ctx) => { await fn(ctx.firestore()); });
}

// ═══════════════════════════════════════════════════════════════════
// R-01 · C1 — an institute cannot rewrite its own governance document
//
// firestore.rules:161 read `isWebOwner() || isInstituteSelf(instituteId)`
// with no field whitelist, which made this document self-governing. The
// escalations that followed are enumerated in the rule's own comment; this
// asserts the door is shut on every one of them, field by field, because
// "the clause is gone" is a claim about the file and these are claims about
// behaviour.
// ═══════════════════════════════════════════════════════════════════
async function R01() {
  await seed(async (db) => {
    await setDoc(doc(db, 'institutes/inst_1'), {
      id: 'inst_1', name: 'Test Institute', status: 'active', activeUntil: '',
    });
  });
  const me = asInstitute('inst_1');

  await denied('cannot flip its own status back to active',
    () => updateDoc(doc(me, 'institutes/inst_1'), { status: 'active' }));
  await denied('cannot extend its own activeUntil',
    () => updateDoc(doc(me, 'institutes/inst_1'), { activeUntil: '2099-01-01T00:00:00.000Z' }));
  await denied('cannot grant itself a question-rights ceiling',
    () => updateDoc(doc(me, 'institutes/inst_1'), {
      questionRightsCeiling: { create: { allowed: true, modes: ['direct'] } },
    }));
  await denied('cannot grant itself a deletion-rights ceiling',
    () => updateDoc(doc(me, 'institutes/inst_1'), {
      deletionRightsCeiling: { faculty: { allowed: true, modes: ['direct'] } },
    }));
  await denied('cannot flip a web-owner delegation toggle',
    () => updateDoc(doc(me, 'institutes/inst_1'), { canAdminCreateFaculty: true }));
  await denied('cannot even touch a harmless field — the doc is closed, not filtered',
    () => updateDoc(doc(me, 'institutes/inst_1'), { name: 'Renamed' }));
  await denied('cannot delete itself',
    () => require('firebase/firestore').deleteDoc(doc(me, 'institutes/inst_1')));

  // The other half: the Web Owner must still be able to govern.
  await allowed('the Web Owner can still disable an institute',
    () => updateDoc(doc(asWebOwner(), 'institutes/inst_1'), { status: 'disabled' }));
  await allowed('and can still set the ceiling',
    () => updateDoc(doc(asWebOwner(), 'institutes/inst_1'), {
      questionRightsCeiling: { create: { allowed: true, modes: ['direct'] } },
    }));
}

// ═══════════════════════════════════════════════════════════════════
// R-02 · H1 — instituteCredentials is whitelisted, not locked
//
// Unlike institutes, this collection HAS one legitimate institute-role write:
// InstituteAuthContext clears firstLoginRequired after a forced password
// change. So the fix was a whitelist, and a whitelist has two failure modes —
// too narrow breaks the product, too wide is the hole again. Both directions
// are asserted.
// ═══════════════════════════════════════════════════════════════════
async function R02() {
  await seed(async (db) => {
    await setDoc(doc(db, 'instituteCredentials/inst_1'), {
      instituteId: 'inst_1', email: 'admin@example.edu', firstLoginRequired: true,
    });
  });
  const me = asInstitute('inst_1');

  await allowed('CAN clear its own firstLoginRequired — the one legitimate write',
    () => updateDoc(doc(me, 'instituteCredentials/inst_1'), { firstLoginRequired: false }));

  await denied('cannot rewrite the email on its credentials doc',
    () => updateDoc(doc(me, 'instituteCredentials/inst_1'), { email: 'attacker@example.com' }));
  await denied('cannot write a password field',
    () => updateDoc(doc(me, 'instituteCredentials/inst_1'), { password: 'hunter2' }));
  await denied('cannot smuggle a second field alongside the allowed one',
    () => updateDoc(doc(me, 'instituteCredentials/inst_1'), {
      firstLoginRequired: false, email: 'attacker@example.com',
    }));
  await denied('cannot add a field that was never on the document',
    () => updateDoc(doc(me, 'instituteCredentials/inst_1'), { isSuperAdmin: true }));
}

// ═══════════════════════════════════════════════════════════════════
// R-03 · the tenancy boundary around both collections
//
// C1 was about an institute and its OWN document. This is the neighbouring
// question: institute B's admin against institute A. A fix that closed the
// first and left the second would be worse than the bug.
// ═══════════════════════════════════════════════════════════════════
async function R03() {
  await seed(async (db) => {
    await setDoc(doc(db, 'institutes/inst_1'), { id: 'inst_1', name: 'A', status: 'active' });
    await setDoc(doc(db, 'institutes/inst_2'), { id: 'inst_2', name: 'B', status: 'active' });
    await setDoc(doc(db, 'instituteCredentials/inst_1'), { firstLoginRequired: true });
  });
  const other = asInstitute('inst_2');

  await denied('another institute cannot read my institute doc',
    () => getDoc(doc(other, 'institutes/inst_1')));
  await denied('another institute cannot write my institute doc',
    () => updateDoc(doc(other, 'institutes/inst_1'), { status: 'disabled' }));
  await denied('another institute cannot read my credentials',
    () => getDoc(doc(other, 'instituteCredentials/inst_1')));
  await denied('another institute cannot clear MY firstLoginRequired',
    () => updateDoc(doc(other, 'instituteCredentials/inst_1'), { firstLoginRequired: false }));

  await denied('a student cannot read an institute they do not belong to',
    () => getDoc(doc(asStudent('stu_1', 'inst_2'), 'institutes/inst_1')));
  await allowed('but a member CAN read their own institute doc (auth contexts depend on it)',
    () => getDoc(doc(asStudent('stu_1', 'inst_1'), 'institutes/inst_1')));
}

// ═══════════════════════════════════════════════════════════════════
// R-04 · attempts — the collection holding actual exam answers
//
// The audit called these rules the carefully-written ones. That is exactly
// why they are worth pinning: they are load-bearing and they are the rules
// most likely to be "just slightly" relaxed by someone fixing an unrelated
// bug. Each assertion here corresponds to a field that was deliberately
// REMOVED from a whitelist and documented at length in the rules file.
// ═══════════════════════════════════════════════════════════════════
async function R04() {
  await seed(async (db) => {
    await setDoc(doc(db, 'attempts/att_1'), {
      id: 'att_1', studentId: 'stu_1', instituteId: 'inst_1',
      status: 'in_progress', answers: {}, updatedAt: '2026-08-01T09:00:00.000Z',
      // Seeded NON-zero on purpose. diff().affectedKeys() reports only keys
      // whose value actually CHANGED, so writing 0 over a stored 0 leaves
      // integrityLog out of the diff entirely and sails through hasOnly() —
      // the rule is not consulted because, as far as Firestore is concerned,
      // nothing was written. A student erasing their record is going from
      // some warnings to none, so the fixture has to start with some.
      integrityLog: { warnings: 2 }, totalFrozenSeconds: 0,
    });
  });
  const me = asStudent('stu_1', 'inst_1');

  await allowed('a student CAN write their own answers (standard-mode autosave)',
    () => updateDoc(doc(me, 'attempts/att_1'), {
      answers: { q1: { value: 'alpha' } }, updatedAt: '2026-08-01T09:05:00.000Z',
    }));

  await denied('cannot rewrite their own status — grading is server-only',
    () => updateDoc(doc(me, 'attempts/att_1'), { status: 'submitted' }));
  await denied('cannot erase their own integrity log',
    () => updateDoc(doc(me, 'attempts/att_1'), { integrityLog: { warnings: 0 } }));
  await denied('cannot grant themselves freeze credit',
    () => updateDoc(doc(me, 'attempts/att_1'), { totalFrozenSeconds: 86400 }));
  await denied('cannot re-claim a superseded session',
    () => updateDoc(doc(me, 'attempts/att_1'), { activeSessionId: 'other-device' }));
  await denied('another student cannot write my attempt',
    () => updateDoc(doc(asStudent('stu_2', 'inst_1'), 'attempts/att_1'), {
      answers: { q1: { value: 'beta' } },
    }));
  await denied('faculty cannot grant freeze credit either (F-12)',
    () => updateDoc(doc(asFaculty('fac_1', 'inst_1'), 'attempts/att_1'), { totalFrozenSeconds: 86400 }));
  await denied('nobody deletes an attempt from a client — it is the audit trail',
    () => require('firebase/firestore').deleteDoc(doc(asWebOwner(), 'attempts/att_1')));
}

// ═══════════════════════════════════════════════════════════════════
// R-08 · attemptVerdicts — the candidate must not read their own judging
//
// This collection exists ONLY because a student may read their own attempt
// document. A judge verdict carries hidden-test output, and even the per-test
// pass/fail list is an oracle: run, see which hidden test flipped, and the
// suite is reconstructable by bisection without its text ever being shown.
//
// So the claim under test is not "verdicts are tidy" — it is that the student
// whose verdict this is cannot read it. If that ever passes, storing verdicts
// on the attempt would have been just as safe and this collection is pointless.
// ═══════════════════════════════════════════════════════════════════
async function R08() {
  await seed(async (db) => {
    await setDoc(doc(db, 'attemptVerdicts/att_1__q_code'), {
      attemptId: 'att_1', questionId: 'q_code', instituteId: 'inst_1',
      verdict: {
        status: 'completed', adapter: 'judge0', judgedAt: '2026-08-01T09:00:00.000Z',
        results: [{ testId: 'h1', status: 'wrong_answer', stdout: 'HIDDEN OUTPUT' }],
      },
    });
  });

  await denied('THE POINT — the student who sat the attempt cannot read its verdict',
    () => getDoc(doc(asStudent('stu_1', 'inst_1'), 'attemptVerdicts/att_1__q_code')));
  await denied('nor can any other student',
    () => getDoc(doc(asStudent('stu_2', 'inst_1'), 'attemptVerdicts/att_1__q_code')));

  await allowed('faculty of the owning institute CAN review it',
    () => getDoc(doc(asFaculty('fac_1', 'inst_1'), 'attemptVerdicts/att_1__q_code')));
  await denied('faculty of another institute cannot — tenancy still applies',
    () => getDoc(doc(asFaculty('fac_2', 'inst_2'), 'attemptVerdicts/att_1__q_code')));

  // Writes are server-only. The Admin SDK bypasses rules, so denying every
  // client write costs the judge nothing and closes the path where a candidate
  // posts their own passing verdict.
  await denied('a student cannot forge a passing verdict',
    () => setDoc(doc(asStudent('stu_1', 'inst_1'), 'attemptVerdicts/att_1__q_code'), {
      instituteId: 'inst_1',
      verdict: { status: 'completed', adapter: 'x', judgedAt: 'now', results: [] },
    }));
  await denied('not even the webOwner writes one from a client',
    () => updateDoc(doc(asWebOwner(), 'attemptVerdicts/att_1__q_code'), {
      verdict: { status: 'completed', adapter: 'x', judgedAt: 'now', results: [] },
    }));
}

// ═══════════════════════════════════════════════════════════════════
// R-09 · attemptTelemetry — a candidate cannot read their own recording
//
// Withheld for a different reason than a verdict. A verdict is hidden because
// it leaks the answer key; this is hidden because it is a recording of a
// person working — hesitation, deletion, false starts, things they chose not
// to submit — and handing someone back a keystroke transcript of themselves
// under exam conditions serves no purpose the platform has.
//
// It is also append-only by construction: written server-side through the
// Admin SDK, with every client write denied, so a record of what someone did
// cannot be edited afterwards by the person it describes.
// ═══════════════════════════════════════════════════════════════════
async function R09() {
  await seed(async (db) => {
    await setDoc(doc(db, 'attemptTelemetry/att_1__q_code__0000'), {
      attemptId: 'att_1', questionId: 'q_code', instituteId: 'inst_1', seq: 0,
      events: [{ k: 'edit', t: 0, from: 0, to: 0, text: 'HESITATION' }],
    });
  });

  await denied('the student who was recorded cannot read it back',
    () => getDoc(doc(asStudent('stu_1', 'inst_1'), 'attemptTelemetry/att_1__q_code__0000')));
  await denied('nor can another student',
    () => getDoc(doc(asStudent('stu_2', 'inst_1'), 'attemptTelemetry/att_1__q_code__0000')));

  await allowed('faculty of the owning institute can review it',
    () => getDoc(doc(asFaculty('fac_1', 'inst_1'), 'attemptTelemetry/att_1__q_code__0000')));
  await denied('faculty elsewhere cannot — tenancy still applies',
    () => getDoc(doc(asFaculty('fac_2', 'inst_2'), 'attemptTelemetry/att_1__q_code__0000')));

  await denied('a student cannot fabricate a recording',
    () => setDoc(doc(asStudent('stu_1', 'inst_1'), 'attemptTelemetry/att_1__q_new__0000'), {
      instituteId: 'inst_1', events: [],
    }));
  await denied('nor edit one that exists — append-only means append-only',
    () => updateDoc(doc(asStudent('stu_1', 'inst_1'), 'attemptTelemetry/att_1__q_code__0000'), {
      events: [],
    }));
  await denied('not even the webOwner writes one from a client',
    () => updateDoc(doc(asWebOwner(), 'attemptTelemetry/att_1__q_code__0000'), { events: [] }));

  // ── The QUERY the replay panel actually runs ──────────────────
  //
  // A get and a query are judged differently. For a get the rule sees the
  // document; for a query Firestore must be able to PROVE from the query
  // itself that every possible result passes, and this rule tests
  // resource.data.instituteId. A chunk range on its own is therefore refused
  // for faculty however innocent the documents are — the reader adds the
  // instituteId equality to make it provable, and that constraint is load
  // bearing rather than cosmetic. Asserted here because it is invisible in
  // the reader and a "tidy-up" would delete it.
  const chunkRange = (as) => getDocs(query(
    collection(as, 'attemptTelemetry'),
    where('instituteId', '==', 'inst_1'),
    where(documentId(), '>=', 'att_1__q_code__'),
    where(documentId(), '<=', 'att_1__q_code__'),
  ));

  await allowed('faculty may query the chunk range for their own institute',
    () => chunkRange(asFaculty('fac_1', 'inst_1')));
  await allowed('so may the webOwner',
    () => chunkRange(asWebOwner()));
  await denied('a student may not, even for their own recording',
    () => chunkRange(asStudent('stu_1', 'inst_1')));

  await denied('an unconstrained chunk range is refused — this is why the reader names the institute',
    () => getDocs(query(
      collection(asFaculty('fac_1', 'inst_1'), 'attemptTelemetry'),
      where(documentId(), '>=', 'att_1__q_code__'),
      where(documentId(), '<=', 'att_1__q_code__'),
    )));

  await denied('nor may faculty elsewhere name someone else\'s institute',
    () => getDocs(query(
      collection(asFaculty('fac_2', 'inst_2'), 'attemptTelemetry'),
      where('instituteId', '==', 'inst_1'),
      where(documentId(), '>=', 'att_1__q_code__'),
      where(documentId(), '<=', 'att_1__q_code__'),
    )));
}

// ═══════════════════════════════════════════════════════════════════
// R-09b · attemptManualMarks — the grading record stays with the graders
//
// A third staff-only collection hanging off an attempt, and its reason is
// narrower than the other two. The MARK itself is meant to reach the student,
// and does: setManualMark re-scores the attempt, so the award arrives through
// gradedAnswers and the totals on the document they already read. What must
// not follow it is the record ABOUT the marking — which member of staff
// awarded it, under which role, and how many times they have revised it.
//
// So the claim under test is not that marks are secret. It is that a student
// cannot enumerate who marked them and how the mark moved, and — the part that
// would actually cost something — cannot write their own.
// ═══════════════════════════════════════════════════════════════════
async function R09b() {
  await seed(async (db) => {
    await setDoc(doc(db, 'attemptManualMarks/att_1__q_text'), {
      attemptId: 'att_1', questionId: 'q_text', assessmentId: 'asmt_1',
      instituteId: 'inst_1', studentId: 'stu_1',
      marksAwarded: 30, feedback: 'Reasonable, but thin on evidence.',
      gradedBy: 'fac_1', gradedByRole: 'faculty',
      gradedAt: '2026-08-01T09:00:00.000Z',
      firstGradedAt: '2026-08-01T09:00:00.000Z',
      revision: 1,
    });
  });

  await denied('THE POINT — the student who was marked cannot read the grading record',
    () => getDoc(doc(asStudent('stu_1', 'inst_1'), 'attemptManualMarks/att_1__q_text')));
  await denied('nor can any other student',
    () => getDoc(doc(asStudent('stu_2', 'inst_1'), 'attemptManualMarks/att_1__q_text')));

  await allowed('faculty of the owning institute CAN read it',
    () => getDoc(doc(asFaculty('fac_1', 'inst_1'), 'attemptManualMarks/att_1__q_text')));
  await allowed('so can the webOwner',
    () => getDoc(doc(asWebOwner(), 'attemptManualMarks/att_1__q_text')));
  await denied('faculty of another institute cannot — tenancy still applies',
    () => getDoc(doc(asFaculty('fac_2', 'inst_2'), 'attemptManualMarks/att_1__q_text')));

  // Writes are server-only, and this is the arm that matters most: the whole
  // value of setManualMark is that it bounds the award to the marks the
  // question carried ON THE PAPER THE STUDENT SAT, refuses to overwrite a
  // judge's verdict, and re-scores the attempt. A client write would be a mark
  // with none of that attached to it.
  await denied('a student cannot award themselves marks',
    () => setDoc(doc(asStudent('stu_1', 'inst_1'), 'attemptManualMarks/att_1__q_text'), {
      attemptId: 'att_1', questionId: 'q_text', instituteId: 'inst_1',
      marksAwarded: 100, gradedBy: 'stu_1', gradedByRole: 'student', revision: 1,
    }));
  await denied('nor raise a mark a grader already gave',
    () => updateDoc(doc(asStudent('stu_1', 'inst_1'), 'attemptManualMarks/att_1__q_text'),
      { marksAwarded: 50 }));
  await denied('nor delete one they dislike',
    () => require('firebase/firestore').deleteDoc(
      doc(asStudent('stu_1', 'inst_1'), 'attemptManualMarks/att_1__q_text')));
  await denied('faculty do not write them from a client either — the callable does',
    () => updateDoc(doc(asFaculty('fac_1', 'inst_1'), 'attemptManualMarks/att_1__q_text'),
      { marksAwarded: 50 }));
  await denied('not even the webOwner',
    () => updateDoc(doc(asWebOwner(), 'attemptManualMarks/att_1__q_text'),
      { marksAwarded: 50 }));

  // The QUERY the marking panel runs — same shape and same reasoning as the
  // replay panel's above: the instituteId equality is what makes the id range
  // provable against a rule that tests resource.data.instituteId.
  const markRange = (as) => getDocs(query(
    collection(as, 'attemptManualMarks'),
    where('instituteId', '==', 'inst_1'),
    where(documentId(), '>=', 'att_1__'),
    where(documentId(), '<=', 'att_1__'),
  ));

  await allowed('faculty may query the marks for one attempt in their institute',
    () => markRange(asFaculty('fac_1', 'inst_1')));
  await allowed('so may the webOwner',
    () => markRange(asWebOwner()));
  await denied('a student may not, even for their own paper',
    () => markRange(asStudent('stu_1', 'inst_1')));
  await denied('an unconstrained range is refused — this is why the reader names the institute',
    () => getDocs(query(
      collection(asFaculty('fac_1', 'inst_1'), 'attemptManualMarks'),
      where(documentId(), '>=', 'att_1__'),
      where(documentId(), '<=', 'att_1__'),
    )));
}

// ═══════════════════════════════════════════════════════════════════
// R-05 · storage.rules — the question bank's second door
//
// N3 (audit 2026-08-06). question-images read was `request.auth != null`, so
// any signed-in student could read AND — rules_version 2 governs list under
// read — ENUMERATE the whole prefix. That contradicted firestore.rules, which
// denies students direct `questions` reads for exactly this reason.
//
// storage.rules had no test at all until now, which is how a rule that
// contradicted its Firestore counterpart survived. Students losing SDK read
// costs them nothing: images reach them as download URLs carrying their own
// token, which never consult these rules.
// ═══════════════════════════════════════════════════════════════════
async function R05() {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const b = ctx.storage().ref('question-images/1700000000-abc123.png');
    await uploadBytes(b, new Uint8Array([1, 2, 3]), { contentType: 'image/png' });
  });

  const IMG = 'question-images/1700000000-abc123.png';

  await denied('a student cannot read a question image through the SDK',
    () => getBytes(storageRef(stAsStudent(), IMG)));
  await denied('and cannot ENUMERATE the bank — list is governed by read',
    () => listAll(storageRef(stAsStudent(), 'question-images')));
  await denied('an unauthenticated caller gets nothing',
    () => getBytes(storageRef(stUnauth(), IMG)));

  await allowed('faculty CAN read one — they author the questions',
    () => getBytes(storageRef(stAsFaculty(), IMG)));
  await allowed('and the Web Owner can',
    () => getBytes(storageRef(stAsWebOwner(), IMG)));

  await denied('a student cannot upload into the bank',
    () => uploadBytes(storageRef(stAsStudent(), 'question-images/evil.png'),
      new Uint8Array([1]), { contentType: 'image/png' }));
  await denied('staff cannot upload a scriptable content type',
    () => uploadBytes(storageRef(stAsFaculty(), 'question-images/x.svg'),
      new Uint8Array([1]), { contentType: 'image/svg+xml' }));
  await denied('nothing outside the two known prefixes is writable at all',
    () => uploadBytes(storageRef(stAsWebOwner(), 'anything-else/x.png'),
      new Uint8Array([1]), { contentType: 'image/png' }));
}

// ═══════════════════════════════════════════════════════════════════
// R-06 · questionGroups — the stimulus is bank content, not public
//
// Phase 1 added a collection holding the SHARED STIMULUS of a grouped set: a
// DI table, a reading passage, a caselet, a seating scenario. Its rules mirror
// /questions clause for clause, and this asserts the mirror actually holds —
// because the failure mode is quiet. A group readable where its children are
// not renders a passage with no questions under it; the reverse renders
// questions with no passage, which is an unanswerable paper.
//
// The student clause matters most. Published assessments expose question ids
// and a group id is one hop away, so a signedIn() read here would let any
// student pull every passage and chart in the bank from the console. A leaked
// passage burns the whole set exactly as a leaked answer key does — the set
// cannot be reused once candidates have seen it. Students get stimulus only
// through getExamQuestions, which whitelists fields and scopes to their paper.
// ═══════════════════════════════════════════════════════════════════
async function R06() {
  await seed(async (db) => {
    await setDoc(doc(db, 'questionGroups/grp_platform'), {
      id: 'grp_platform', kind: 'rc',
      stimulus: { format: 'richtext', body: 'Platform passage.' },
      ownerType: 'webOwner', ownerId: 'webOwner', isDeleted: false,
    });
    await setDoc(doc(db, 'questionGroups/grp_inst1'), {
      id: 'grp_inst1', kind: 'di',
      stimulus: { format: 'table', table: { headers: ['A'], rows: [{ cells: ['1'] }] } },
      ownerType: 'institute', ownerId: 'inst_1', instituteId: 'inst_1', isDeleted: false,
    });
    await setDoc(doc(db, 'questionGroups/grp_inst2'), {
      id: 'grp_inst2', kind: 'di',
      stimulus: { format: 'table', table: { headers: ['B'], rows: [{ cells: ['2'] }] } },
      ownerType: 'institute', ownerId: 'inst_2', instituteId: 'inst_2', isDeleted: false,
    });
  });

  // ── Students: denied outright, exactly as for /questions ──
  await denied('a student cannot read a platform group',
    () => getDoc(doc(asStudent(), 'questionGroups/grp_platform')));
  await denied('a student cannot read their own institute\'s group either',
    () => getDoc(doc(asStudent('stu_1', 'inst_1'), 'questionGroups/grp_inst1')));

  // ── The tenant fence ──
  await allowed('an institute can read platform content',
    () => getDoc(doc(asInstitute('inst_1'), 'questionGroups/grp_platform')));
  await allowed('an institute can read its own group',
    () => getDoc(doc(asInstitute('inst_1'), 'questionGroups/grp_inst1')));
  await denied('an institute cannot read another tenant\'s group',
    () => getDoc(doc(asInstitute('inst_1'), 'questionGroups/grp_inst2')));
  await allowed('faculty can read content authored inside their institute',
    () => getDoc(doc(asFaculty('fac_1', 'inst_1'), 'questionGroups/grp_inst1')));
  await denied('faculty cannot read across the tenant fence',
    () => getDoc(doc(asFaculty('fac_1', 'inst_1'), 'questionGroups/grp_inst2')));

  // ── Writes: webOwner only. Everyone else goes through the callables,
  // because that is where assertQuestionRight enforces the rights ceiling.
  await denied('an institute cannot write a group directly',
    () => setDoc(doc(asInstitute('inst_1'), 'questionGroups/grp_new'), {
      id: 'grp_new', kind: 'rc', ownerType: 'institute', ownerId: 'inst_1', instituteId: 'inst_1',
    }));
  await denied('faculty cannot write a group directly',
    () => setDoc(doc(asFaculty(), 'questionGroups/grp_new2'), {
      id: 'grp_new2', kind: 'rc', ownerType: 'faculty', ownerId: 'fac_1', instituteId: 'inst_1',
    }));
  await denied('an institute cannot edit its own group directly',
    () => updateDoc(doc(asInstitute('inst_1'), 'questionGroups/grp_inst1'), { kind: 'rc' }));
  await denied('a student cannot write at all',
    () => setDoc(doc(asStudent(), 'questionGroups/grp_evil'), { id: 'grp_evil' }));

  await allowed('the Web Owner can create platform content',
    () => setDoc(doc(asWebOwner(), 'questionGroups/grp_wo'), {
      id: 'grp_wo', kind: 'rc', ownerType: 'webOwner', ownerId: 'webOwner', isDeleted: false,
    }));
  await allowed('and can edit it',
    () => updateDoc(doc(asWebOwner(), 'questionGroups/grp_wo'), { kind: 'caselet' }));
  // Preserved exactly from /questions: the webOwner branch is scoped to
  // webOwner-OWNED docs, so this stays a restriction rather than becoming a
  // privilege expansion smuggled in alongside one.
  await denied('the Web Owner cannot directly write tenant-authored content',
    () => updateDoc(doc(asWebOwner(), 'questionGroups/grp_inst1'), { kind: 'rc' }));
  await denied('nor forge a group stamped as another tenant\'s',
    () => setDoc(doc(asWebOwner(), 'questionGroups/grp_forged'), {
      id: 'grp_forged', ownerType: 'institute', ownerId: 'inst_1', instituteId: 'inst_1',
    }));
}

// ═══════════════════════════════════════════════════════════════════
// R-07 · webowners — self-read by uid, without leaking the directory
//
// The bootstrap circularity this closes: gating the profile read on
// isWebOwner() alone means you may read your own webOwner document only if you
// already carry the webOwner claim. Claims are set at account creation or by a
// migration script, never on sign-in, so an account missing the claim
// authenticates fine — password and TOTP both pass — and then cannot read its
// own profile. AuthContext.loadProfile returns null, setUser(null) runs, and
// the route guard bounces back to the login page. A permanent lockout that
// looks exactly like a login loop, recoverable only with Admin SDK access.
//
// The fix has to be proven not to open the directory, which is what the second
// half of this scenario is for.
// ═══════════════════════════════════════════════════════════════════
async function R07() {
  await seed(async (db) => {
    await setDoc(doc(db, 'webowners/wo_1'), { email: 'owner@example.com', name: 'Owner One' });
    await setDoc(doc(db, 'webowners/wo_2'), { email: 'other@example.com', name: 'Owner Two' });
  });

  // The claim-carrying owner keeps full access, exactly as before.
  await allowed('a claimed webOwner reads its own profile',
    () => getDoc(doc(asWebOwner(), 'webowners/wo_1')));

  // The bootstrap case: signed in, NO role claim at all. This is the account
  // state that produced the loop; it must now be able to read its own doc.
  const unclaimed = env.authenticatedContext('wo_1', {}).firestore();
  await allowed('an account with no role claim can still read its OWN profile',
    () => getDoc(doc(unclaimed, 'webowners/wo_1')));

  // ── The half that keeps this from being a leak ──
  await denied('...but not another owner\'s profile',
    () => getDoc(doc(unclaimed, 'webowners/wo_2')));

  const student = asStudent('stu_1', 'inst_1');
  await denied('a student cannot read an owner profile by guessing the id',
    () => getDoc(doc(student, 'webowners/wo_1')));
  await denied('nor can an institute admin',
    () => getDoc(doc(asInstitute('inst_1'), 'webowners/wo_1')));
  await denied('nor an unauthenticated caller reading its way in',
    () => getDoc(doc(env.unauthenticatedContext().firestore(), 'webowners/wo_1')));

  // Writes are untouched by the read fix — assert it, because a loosened read
  // sitting next to an unchanged write is exactly where a mistake would hide.
  await denied('the self-read does not imply a self-write',
    () => setDoc(doc(unclaimed, 'webowners/wo_1'), { name: 'Renamed' }));
  await denied('a student cannot write an owner profile',
    () => setDoc(doc(student, 'webowners/wo_1'), { name: 'Hostile' }));
}

// ═══════════════════════════════════════════════════════════════════
// R-10 · academic hierarchy — the lifecycle axis is callable-only
//
// Audit F-4. Two separate holes met in this collection group:
//
//   1. NO AUDIT TRAIL. SchoolsTab archived a node by patching
//      `status: 'archived'` straight onto it. Clients cannot write
//      deletionAudit, so every archive performed in the product left no record
//      of who did it — while setHierarchyNodeLifecycle, which writes exactly
//      that row, sat deployed and uncalled.
//
//   2. THE PERMISSION WAS DECORATIVE. canWriteAcademic gates on role and
//      tenant. It has never known about schoolsManagementEnabled, the flag the
//      UI gates the whole Schools surface on. Revoking it hid the buttons and
//      stopped nothing — the same shape as the question-rights gap S-02
//      closed, and the same fix: the real check lives in the callable, so the
//      callable has to be the only door.
//
// The fence is deliberately narrow. Renames must keep working on the direct
// path — a rule that broke them would be discovered by users, not tests — so
// both halves are asserted here: the edit that must still pass, and the
// transition that must not.
// ═══════════════════════════════════════════════════════════════════
async function R10() {
  await seed(async (db) => {
    await setDoc(doc(db, 'schools/sch_1'), {
      id: 'sch_1', instituteId: 'inst_1', name: 'School of Engineering',
      status: 'active', createdAt: '2026-08-01T09:00:00.000Z',
      updatedAt: '2026-08-01T09:00:00.000Z',
    });
    await setDoc(doc(db, 'groups/grp_1'), {
      id: 'grp_1', instituteId: 'inst_1', name: 'Group A', status: 'active',
      updatedAt: '2026-08-01T09:00:00.000Z',
    });
  });

  const inst = asInstitute('inst_1');
  const fac = asFaculty('fac_1', 'inst_1');

  // ── still allowed: everything that is not a lifecycle transition ──
  await allowed('an institute admin CAN still rename a school (NodeDrawer)',
    () => updateDoc(doc(inst, 'schools/sch_1'), {
      name: 'School of Engineering & Design', updatedAt: '2026-08-01T10:00:00.000Z',
    }));
  await allowed('faculty CAN still rename — the direct edit path is untouched',
    () => updateDoc(doc(fac, 'groups/grp_1'), {
      name: 'Group A1', updatedAt: '2026-08-01T10:00:00.000Z',
    }));

  // ── the fence ────────────────────────────────────────────────────
  await denied('an institute admin cannot archive by patching status directly',
    () => updateDoc(doc(inst, 'schools/sch_1'), { status: 'archived' }));
  await denied('faculty cannot either — this is the path SchoolsTab used to take',
    () => updateDoc(doc(fac, 'groups/grp_1'), { status: 'archived' }));
  await denied('nor restore, which the direct path never even offered',
    () => updateDoc(doc(inst, 'schools/sch_1'), { status: 'active', lifecycleState: 'active' }));

  // Every field the callable writes, not just `status`. A fence around one key
  // of a six-key envelope is a fence with a gate in it: forging
  // lifecycleState alone would leave the node reading as archived to every
  // Feature #15 consumer while `status` still said active.
  await denied('cannot forge lifecycleState',
    () => updateDoc(doc(inst, 'schools/sch_1'), { lifecycleState: 'archived' }));
  await denied('cannot forge archivedBy — attributing the act to someone else',
    () => updateDoc(doc(inst, 'schools/sch_1'), { archivedBy: 'wo_1' }));
  await denied('cannot forge archivedAt',
    () => updateDoc(doc(inst, 'schools/sch_1'), { archivedAt: '2020-01-01T00:00:00.000Z' }));
  await denied('cannot forge archivedByRole',
    () => updateDoc(doc(inst, 'schools/sch_1'), { archivedByRole: 'webOwner' }));
  await denied('cannot forge lifecycleReason',
    () => updateDoc(doc(inst, 'schools/sch_1'), { lifecycleReason: 'approved by nobody' }));

  // Smuggling: a rename is legitimate, so the interesting attack is a rename
  // that carries a transition with it. affectedKeys() sees both.
  await denied('cannot smuggle a transition inside an otherwise-legal rename',
    () => updateDoc(doc(inst, 'schools/sch_1'), {
      name: 'Renamed', status: 'archived', updatedAt: '2026-08-01T11:00:00.000Z',
    }));

  // Tenancy still applies underneath the new guard — the fence must not have
  // replaced the wall it sits on.
  await denied('another institute cannot touch this school at all',
    () => updateDoc(doc(asInstitute('inst_2'), 'schools/sch_1'), { name: 'Hostile' }));
}

// ═══════════════════════════════════════════════════════════════════
const SCENARIOS = [
  ['R-01', 'C1 — an institute cannot rewrite its own governance document', R01],
  ['R-02', 'H1 — instituteCredentials is whitelisted, both directions', R02],
  ['R-03', 'the tenancy boundary around both collections', R03],
  ['R-04', 'attempts — answers writable, authority fields not', R04],
  ['R-08', 'attemptVerdicts — the candidate cannot read their own judging', R08],
  ['R-09', 'attemptTelemetry — a candidate cannot read their own recording', R09],
  ['R-09b', 'attemptManualMarks — the grading record stays with the graders', R09b],
  ['R-05', 'storage.rules — the question bank\'s second door', R05],
  ['R-06', 'questionGroups — the stimulus is bank content, not public', R06],
  ['R-07', 'webowners — self-read by uid, without leaking the directory', R07],
  ['R-10', 'academic hierarchy — the lifecycle axis is callable-only', R10],
];

(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-rules-suite',
    firestore: {
      rules: fs.readFileSync(RULES_PATH, 'utf8'),
      host: process.env.FIRESTORE_EMULATOR_HOST.split(':')[0],
      port: Number(process.env.FIRESTORE_EMULATOR_HOST.split(':')[1]),
    },
    storage: {
      rules: fs.readFileSync(STORAGE_RULES_PATH, 'utf8'),
      host: (process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199').split(':')[0],
      port: Number((process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199').split(':')[1]),
    },
  });

  for (const [id, title, fn] of SCENARIOS) {
    await env.clearFirestore();
    await env.clearStorage();
    await scenario(id, title, fn);
  }
  await env.cleanup();

  const C = { r: '\x1b[31m', g: '\x1b[32m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
  let pass = 0, fail = 0;
  console.log(`\n${C.b}FIRESTORE RULES SUITE${C.x}  —  real firestore.rules + storage.rules, real rules engine, emulator\n`);
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
