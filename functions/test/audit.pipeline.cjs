// ═══════════════════════════════════════════════════════════════════════════
// ASSESSMENT PIPELINE AUDIT — OPEN FINDINGS  (2026-08-09)
//
// Evidence for AUDIT_ASSESSMENT_E2E.md. Every probe below drives the REAL
// compiled callables (functions/lib/index.js) against the in-memory Firestore
// and virtual clock the other suites use, and each one reproduces a defect
// that is still open in the source.
//
//   node test/audit.pipeline.cjs
//
// ── WHY THIS IS NOT IN `npm test` ──────────────────────────────────────────
//
// It is deliberately NOT wired into the `test` script, because it currently
// PASSES BY REPRODUCING BUGS. A green run here means the defects are still
// there. Adding it to the gate today would make the gate red for the wrong
// reason, and adding it green would mean asserting the broken behaviour is
// correct — which is how a bug becomes a spec.
//
// WHEN A FINDING IS FIXED: invert that probe into an assertion (the fixed
// behaviour is written next to each one), move it into audit.round3.cjs or
// exam.e2e.cjs beside the regression it belongs with, and delete it here.
// When the file is empty, delete the file. It is a punch list, not a suite.
// ═══════════════════════════════════════════════════════════════════════════

const { FakeDb } = require('./fakeFirestore.cjs');

// ── Virtual clock (same construction as exam.e2e.cjs) ──────────────────────
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

process.env.GCLOUD_PROJECT = 'demo-audit-pipeline';
const adminFs = require('firebase-admin/firestore');
let DB = new FakeDb();
adminFs.getFirestore = () => DB;
require('firebase-admin/app').initializeApp = () => ({});
const fns = require('../lib/index.js');

const call = (f, data, auth) =>
  f.run({ data, auth, rawRequest: { headers: {} }, acceptsStreaming: false });
const STUDENT = () =>
  ({ uid: 'stu_uid', token: { role: 'student', studentId: 'stu_1', instituteId: 'inst_1' } });
const A = (id) => DB.read('attempts', id);
const lockMs = (v) =>
  (v && typeof v.toMillis === 'function' ? v.toMillis() : (v ? Date.parse(v) : null));

// ── Fixture ────────────────────────────────────────────────────────────────
// Two timed sections, one question each. Options are deliberately minimal:
// nothing here is testing the paper, only the transitions around it.
function seed(opts = {}) {
  DB.seed('students', 'stu_1', { id: 'stu_1', name: 'S', instituteId: 'inst_1' });
  DB.seed('assessments', 'asmt_1', {
    id: 'asmt_1', title: 'Audit Paper', instituteId: 'inst_1', status: 'active',
    startDate: at(VNOW - min(60)),
    endDate: opts.endDate ?? at(VNOW + min(6000)),
    maxAttempts: 1,
    overallTimeLimit: opts.overallTimeLimit,   // undefined => no overall cap
    deliveryMode: 'standard', sectionStartOrder: 'sequential',
    securityTier: 'mock', requireCamera: false, allowMobile: true,
    requireExtensionCheck: false, requireSEB: false,
    securityLockedAt: at(VNOW - min(120)), passingScore: 40,
    assignedTo: { type: 'all' },
    gradingConfig: opts.gradingConfig,
    sections: [
      { id: 'SA', name: 'A', timeLimit: 30, breakAfter: opts.breakAfter,
        questions: [{ questionId: 'q1', marks: 10, order: 0 }] },
      { id: 'SB', name: 'B', timeLimit: 20,
        questions: [{ questionId: 'q2', marks: 10, order: 0 }] },
    ],
  });
  for (const q of ['q1', 'q2']) {
    DB.seed('questions', q, {
      id: q, engine: 'mcq', variant: 'single', difficulty: 'medium',
      options: [{ id: 'alpha', text: 'A' }, { id: 'beta', text: 'B' }],
    });
    DB.seed('questionAnswers', q, {
      id: q,
      // opts.emptyKey models a question whose answer key never landed —
      // see F-03 for the supported paths that produce exactly this document.
      correctIds: opts.emptyKey ? [] : ['alpha'],
      correctPairs: [], modelAnswer: '',
    });
  }
}

// The write firestore.rules provably allow a standard-mode student to make:
// a dot-path patch of answers.{qid} plus updatedAt, nothing else. The fake db
// has no rules engine, so this stands in for the rule-legal client write.
function clientAnswer(id, qid, value, sectionId) {
  const att = DB.read('attempts', id);
  att.answers[qid] = { type: 'mcq', value, sectionId, answeredAt: at(VNOW) };
  DB.seed('attempts', id, att);
}

// ── Reporting ──────────────────────────────────────────────────────────────
const G = '\x1b[32m', R = '\x1b[31m', B = '\x1b[1m', D = '\x1b[2m', X = '\x1b[0m';
let reproduced = 0, stale = 0;
function probe(open, id, label, detail) {
  if (open) { reproduced++; console.log(`  ${R}${B}OPEN${X}      ${B}${id}${X}  ${label}`); }
  else      { stale++;      console.log(`  ${G}${B}FIXED?${X}    ${B}${id}${X}  ${label}`); }
  if (detail) console.log(`  ${D}          ${detail}${X}`);
}
// A control is not a finding: it establishes that the guard being bypassed
// elsewhere really does work on the honest route, so the bypass is a bypass
// and not simply an unimplemented feature. It never counts either way.
function control(holds, id, label, detail) {
  console.log(`  ${holds ? G : R}${B}CONTROL${X}   ${B}${id}${X}  ${label}`);
  if (detail) console.log(`  ${D}          ${detail}${X}`);
  if (!holds) reproduced++;   // a broken control invalidates the probe beside it
}
function reset() { DB = new FakeDb(); VNOW = Date.parse('2026-08-01T09:00:00.000Z'); }

(async () => {
  console.log(`\n${B}ASSESSMENT PIPELINE AUDIT — OPEN FINDINGS${X}  ${D}real callables, virtual clock${X}\n`);

  // ══════════════════════════════════════════════════════════════════════
  // F-01 · startSection admits a section id that is not on the attempt
  //
  // submitSection validates its advance target against attempt.sectionIds
  // (index.ts:9668, audit A-02). startSection never acquired the same check:
  // index.ts:9386 takes indexOf() and tolerates -1. A section id nobody
  // authored therefore gets a timing row, and because the assessment has no
  // section by that name the lock recompute at index.ts:9459 finds no
  // timeLimit — so sectionDeadlineMs returns null and the section bound
  // disappears from answersLockedAfter.
  //
  // FIXED LOOKS LIKE: startSection throws invalid-argument, exactly as
  // submitSection does for an unknown nextSectionId.
  // ══════════════════════════════════════════════════════════════════════
  reset();
  seed({ overallTimeLimit: undefined, endDate: at(VNOW + min(10080)) }); // week-long window
  {
    const st = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
    const id = st.attempt.id;
    const before = lockMs(A(id).answersLockedAfter);
    await call(fns.submitSection, { attemptId: id, sectionId: 'SA', nextSectionId: null }, STUDENT());
    const r = await call(fns.startSection, { attemptId: id, sectionId: 'PHANTOM' }, STUDENT());
    const after = A(id);
    probe(r.ok === true && !!after.sectionTimings.PHANTOM,
      'F-01a', 'startSection accepts a sectionId absent from attempt.sectionIds',
      `currentSectionIdx=${after.currentSectionIdx} (derived from indexOf → -1), `
      + `sectionIds=${JSON.stringify(after.sectionIds)}`);
    probe(lockMs(after.answersLockedAfter) > before,
      'F-01b', 'the answer-write lock jumps out to the availability window',
      `answersLockedAfter ${at(before)} → ${at(lockMs(after.answersLockedAfter))} `
      + `(+${Math.round((lockMs(after.answersLockedAfter) - before) / 60000)} min of writable time)`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // F-02 · the same phantom section walks past a MANDATORY break
  //
  // submitSection resolves the break positionally from
  // sectionIds.indexOf(sectionId) (index.ts:9625). For a section that is not
  // in the list that is -1, so breakDue is null and mandatoryBreakDue is
  // false — the advance proceeds with the break unserved.
  //
  // FIXED LOOKS LIKE: F-01's guard makes this unreachable.
  // ══════════════════════════════════════════════════════════════════════
  reset();
  seed({ overallTimeLimit: 120, breakAfter: { durationMinutes: 15, mandatory: true } });
  {
    const st = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
    const id = st.attempt.id;
    advance(min(1));
    await call(fns.submitSection, { attemptId: id, sectionId: 'SA', nextSectionId: 'SB' }, STUDENT());

    let refused = false;
    try { await call(fns.startSection, { attemptId: id, sectionId: 'SB' }, STUDENT()); }
    catch (e) { refused = /break/i.test(e.message); }
    control(refused, 'F-02a', 'the honest route into SB is refused while the break runs',
      refused ? 'startSection threw on the mandatory-break gate, as designed'
              : 'the break gate did not fire — F-02b below proves nothing');

    await call(fns.startSection, { attemptId: id, sectionId: 'PHANTOM' }, STUDENT());
    const sub = await call(fns.submitSection,
      { attemptId: id, sectionId: 'PHANTOM', nextSectionId: 'SB' }, STUDENT());
    probe(sub.ok === true && !!A(id).sectionTimings.SB.startedAt,
      'F-02b', 'inserting a phantom section skips the mandatory break entirely',
      `server reported breakDue=${JSON.stringify(sub.breakDue)}; `
      + `SB.startedAt=${A(id).sectionTimings.SB.startedAt} (break was 15m, elapsed 0m)`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // F-03 · answers to a CLOSED section stay writable, and stay marked
  //
  // The student attempt-update whitelist (firestore.rules:795) gates the
  // TOP-LEVEL key `answers` and says nothing about which question ids may
  // appear under it; answerWriteWindowOpen (firestore.rules:832) compares
  // request.time against one materialised instant, which after an advance is
  // the NEXT section's deadline. scoreAttemptAnswers reads answers[qid] by
  // paper position and never looks at the answer's own sectionId or
  // answeredAt. So per-section time limits bind the UI, not the data.
  //
  // FIXED LOOKS LIKE: a write to a question whose section carries a
  // submittedAt is refused (or recorded and excluded at grade time).
  // ══════════════════════════════════════════════════════════════════════
  reset();
  seed({ overallTimeLimit: 120 });
  {
    const st = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
    const id = st.attempt.id;
    advance(min(2));
    clientAnswer(id, 'q1', 'beta', 'SA');                       // wrong, inside SA's window
    await call(fns.submitSection, { attemptId: id, sectionId: 'SA', nextSectionId: 'SB' }, STUDENT());
    advance(min(10));
    const lock = lockMs(A(id).answersLockedAfter);
    const rulesAllow = lock === null || VNOW < lock;             // answerWriteWindowOpen()
    clientAnswer(id, 'q1', 'alpha', 'SA');                       // corrected AFTER SA closed
    const g = await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());
    probe(rulesAllow && g.scores.total === 10,
      'F-03', 'a question revised after its own section closed still scores full marks',
      `SA.submittedAt=${A(id).sectionTimings.SA.submittedAt}, `
      + `answers.q1.answeredAt=${A(id).answers.q1.answeredAt}, `
      + `awarded ${g.scores.total}/${g.scores.available}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // F-04 · an empty answer key marks — and PENALISES — every candidate
  //
  // scoreMCQMultiplier returns multiplier 0 / anyCorrect false for a key of
  // [], and awardFor turns that into -penaltyFor(...). Nothing sets
  // requiresManualReview, so the paper reports a confident pass/fail. Coding
  // takes the opposite direction on the same uncertainty (no verdict →
  // manual review), and text does too; mcq and match do not.
  //
  // Reachable through a supported path: createQuestionAsRole /
  // createQuestionsBulkAsRole validate nothing, and buildQuestionDocs writes
  // correctIds:[] as the default when the payload omits it.
  //
  // FIXED LOOKS LIKE: an empty key sets requiresManualReview and awards 0
  // rather than a negative, and the write callables reject the document.
  // ══════════════════════════════════════════════════════════════════════
  reset();
  seed({
    overallTimeLimit: 120, emptyKey: true,
    gradingConfig: { exam: { negativeMarking: true, penaltyType: 'percent', penaltyValue: 25 } },
  });
  {
    const st = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
    const id = st.attempt.id;
    advance(min(1));
    clientAnswer(id, 'q1', 'alpha', 'SA');
    clientAnswer(id, 'q2', 'alpha', 'SB');
    const g = await call(fns.gradeAttempt, { attemptId: id, reason: 'manual' }, STUDENT());
    probe(g.scores.requiresManualReview !== true,
      'F-04', 'empty answer key → every candidate wrong + penalised, no manual-review flag',
      `bySection awarded=${JSON.stringify(g.scores.bySection.map((s) => s.marksAwarded))}, `
      + `total=${g.scores.total} (floored), requiresManualReview=${g.scores.requiresManualReview}`);

    // ══════════════════════════════════════════════════════════════════
    // F-05 · the mark is on the document the student reads
    //
    // scores + gradedAnswers land on the attempt, and firestore.rules:863
    // lets a student read their own attempt in full. showResults and
    // allowReview are enforced only by ExamResultsPage. Per-question
    // isCorrect is written regardless of the review audience, so on an
    // exam with maxAttempts > 1 it is an oracle across sittings.
    //
    // FIXED LOOKS LIKE: withheld results live off the attempt document
    // (as provisionalGrades already does) or are served by a gated callable.
    // ══════════════════════════════════════════════════════════════════
    const att = A(id);
    probe(!!att.scores && !!att.gradedAnswers && 'isCorrect' in att.gradedAnswers.q1,
      'F-05', 'scores + per-question isCorrect sit on the student-readable attempt doc',
      `gradedAnswers.q1=${JSON.stringify(att.gradedAnswers.q1)} `
      + `(written whatever showResults / allowReview say)`);
  }

  const bar = '─'.repeat(72);
  console.log(`\n${bar}`);
  console.log(`  ${reproduced > 0 ? `${R}${B}${reproduced} FINDING(S) STILL OPEN${X}` : `${G}${B}ALL CLEAR${X}`}`
    + (stale > 0 ? `  ${D}· ${stale} probe(s) no longer reproduce — retire them${X}` : ''));
  console.log(`${bar}\n`);
})();
