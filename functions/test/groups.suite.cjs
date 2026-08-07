// ═══════════════════════════════════════════════════════════════════════════
// QUESTION GROUPS SUITE  (Phase 1)
//
// Grouped question sets — DI charts, RC passages, caselets, puzzles, seating
// arrangements — through the COMPILED PRODUCTION CALLABLES
// (functions/lib/index.js) against an in-memory Firestore.
//
//   node test/groups.suite.cjs
//
// Same evidentiary standard as the other suites: nothing here re-implements
// the shuffle or the whitelist. Every ordering asserted on was produced by a
// real handler.
//
// The load-bearing case is G-01. A group is one unit of work — its questions
// are written to be read together, ramp in difficulty and refer to each other
// ("in the year identified in Q2..."). The pre-Phase-1 shuffle was a flat
// Fisher-Yates over the section, which would scatter a set between unrelated
// questions and reorder it internally. That is not a harder paper, it is a
// broken one, and it is invisible in any test that only counts questions.
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
const at = (ms) => new RealDate(ms).toISOString();
const min = (m) => m * 60_000;

// ── Wire the fake db into the compiled module ──────────────────────
process.env.GCLOUD_PROJECT = 'demo-groups-suite';
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
function deepEq(actual, expected, label) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  check(a === b, label, `expected ${b}, got ${a}`);
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

const STUDENT = (uid = 'stu_uid', studentId = 'stu_1', instituteId = 'inst_1') =>
  ({ uid, token: { role: 'student', studentId, instituteId } });
const INSTITUTE = (instituteId = 'inst_1') =>
  ({ uid: 'inst_uid', token: { role: 'institute', instituteId } });

// ── Fixtures ───────────────────────────────────────────────────────

/**
 * A paper whose single section holds, in authored order:
 *
 *   s1            standalone
 *   g1a g1b g1c   group ONE   (an RC passage)
 *   s2            standalone
 *   g2a g2b       group TWO   (a DI table)
 *
 * Deliberately interleaved: a shuffle that merely preserved the ORDER of
 * group members while letting other questions fall between them would pass a
 * contiguity-blind test. This layout catches both failures.
 */
function seedGroupedWorld(opts = {}) {
  DB.seed('students', 'stu_1', { id: 'stu_1', name: 'Test Student', instituteId: 'inst_1' });

  const paper = [
    { questionId: 's1',  marks: 5, order: 0 },
    { questionId: 'g1a', marks: 5, order: 1, groupId: 'grp_1', groupOrder: 0 },
    { questionId: 'g1b', marks: 5, order: 2, groupId: 'grp_1', groupOrder: 1 },
    { questionId: 'g1c', marks: 5, order: 3, groupId: 'grp_1', groupOrder: 2 },
    { questionId: 's2',  marks: 5, order: 4 },
    { questionId: 'g2a', marks: 5, order: 5, groupId: 'grp_2', groupOrder: 0 },
    { questionId: 'g2b', marks: 5, order: 6, groupId: 'grp_2', groupOrder: 1 },
  ];

  DB.seed('assessments', 'asmt_1', {
    id: 'asmt_1',
    title: 'Grouped Paper',
    instituteId: 'inst_1',
    status: 'active',
    startDate: at(VNOW - min(60)),
    endDate: at(VNOW + min(600)),
    maxAttempts: 1,
    overallTimeLimit: 60,
    deliveryMode: 'standard',
    sectionStartOrder: 'sequential',
    shuffleQuestions: opts.shuffleQuestions ?? true,
    securityTier: 'mock',
    requireCamera: false, allowMobile: true, requireExtensionCheck: false, requireSEB: false,
    securityLockedAt: at(VNOW - min(120)),
    assignedTo: { type: 'all' },
    sections: [{ id: 'SA', name: 'A', timeLimit: 30, questions: paper }],
  });

  for (const q of paper) {
    DB.seed('questions', q.questionId, {
      id: q.questionId, engine: 'mcq', variant: 'single', stem: `Stem ${q.questionId}`,
      options: [{ id: 'alpha', text: 'Alpha' }, { id: 'beta', text: 'Beta' }],
      difficulty: 'medium',
      ...(q.groupId ? { groupId: q.groupId, groupOrder: q.groupOrder } : {}),
    });
    DB.seed('questionAnswers', q.questionId, {
      id: q.questionId, correctIds: ['alpha'], correctPairs: [], modelAnswer: '',
    });
  }

  DB.seed('questionGroups', 'grp_1', {
    id: 'grp_1', kind: 'rc',
    title: 'INTERNAL — reuse after Nov sitting',
    stimulus: { format: 'richtext', body: 'The passage text.', images: [] },
    subject: 'English', topic: 'Comprehension', difficulty: 'medium', tags: [],
    childIds: ['g1a', 'g1b', 'g1c'],
    ownerType: 'webOwner', ownerId: 'webOwner',
    isDeleted: false, createdAt: at(VNOW), updatedAt: at(VNOW),
  });
  DB.seed('questionGroups', 'grp_2', {
    id: 'grp_2', kind: 'di',
    title: 'INTERNAL — sales table',
    stimulus: {
      format: 'table',
      table: { caption: 'Sales', headers: ['Region', '2024'], rows: [{ cells: ['North', '120'] }] },
      images: [],
    },
    subject: 'Quant', topic: 'DI', difficulty: 'medium', tags: [],
    childIds: ['g2a', 'g2b'],
    ownerType: 'webOwner', ownerId: 'webOwner',
    isDeleted: false, createdAt: at(VNOW), updatedAt: at(VNOW),
  });

  return paper;
}

/** An institute that holds every question right, in direct mode. */
function seedRightsWorld() {
  DB.seed('institutes', 'inst_1', {
    id: 'inst_1',
    isActive: true,
    status: 'active',
    questionRightsCeiling: {
      create: { allowed: true, modes: ['direct', 'request'] },
      edit:   { allowed: true, modes: ['direct', 'request'] },
      delete: { allowed: true, modes: ['direct', 'request'] },
      share:  { allowed: true, modes: ['direct', 'request'] },
    },
  });
}

const A = (id) => DB.read('attempts', id);

/** Positions of a group's members inside an ordered id list. */
const positionsOf = (order, ids) => ids.map((id) => order.indexOf(id));
const isContiguousAscending = (pos) =>
  pos.every((p, i) => p >= 0 && (i === 0 || p === pos[i - 1] + 1));

// ═══════════════════════════════════════════════════════════════════
// G-01 · the shuffle keeps grouped sets whole and internally ordered
// ═══════════════════════════════════════════════════════════════════
async function G01() {
  // Run many independent sittings. One pass proves nothing about a shuffle —
  // the failing arrangement is reachable but not certain — so this asserts the
  // invariant across enough draws that a flat Fisher-Yates could not survive.
  // With 7 questions, a broken shuffle leaves grp_1 intact by luck about 1 in
  // 35 draws; 60 sittings makes a false pass vanishingly unlikely.
  const SITTINGS = 60;
  let everMoved = false;
  const seenFirsts = new Set();

  for (let i = 0; i < SITTINGS; i++) {
    DB = new FakeDb();
    seedGroupedWorld({ shuffleQuestions: true });
    const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
    const order = A(started.attempt.id).questionOrder.SA;

    if (order.length !== 7) {
      check(false, 'every sitting serves all 7 questions', `got ${order.length}`);
      return;
    }

    const p1 = positionsOf(order, ['g1a', 'g1b', 'g1c']);
    const p2 = positionsOf(order, ['g2a', 'g2b']);

    if (!isContiguousAscending(p1)) {
      check(false, 'grp_1 stays contiguous and in authored order', `positions ${JSON.stringify(p1)} in ${JSON.stringify(order)}`);
      return;
    }
    if (!isContiguousAscending(p2)) {
      check(false, 'grp_2 stays contiguous and in authored order', `positions ${JSON.stringify(p2)} in ${JSON.stringify(order)}`);
      return;
    }

    seenFirsts.add(order[0]);
    if (order[0] !== 's1') everMoved = true;
  }

  check(true, `grp_1 contiguous + ordered across ${SITTINGS} sittings`);
  check(true, `grp_2 contiguous + ordered across ${SITTINGS} sittings`);

  // The other half of the claim: blocks really are being shuffled. A shuffle
  // that "protected" groups by not shuffling at all would pass every
  // contiguity check above, so prove the order actually moves.
  check(everMoved, 'blocks are genuinely shuffled (paper order varies)');
  check(seenFirsts.size >= 3,
    'several different blocks reach position 0',
    `saw firsts: ${JSON.stringify([...seenFirsts])}`);

  // A group must be able to START the paper — i.e. blocks move as units, not
  // merely swap among the standalone slots.
  check([...seenFirsts].some((f) => f === 'g1a' || f === 'g2a'),
    'a grouped set can lead the paper',
    `saw firsts: ${JSON.stringify([...seenFirsts])}`);
}

// ═══════════════════════════════════════════════════════════════════
// G-02 · shuffle off — the paper keeps its authored order exactly
// ═══════════════════════════════════════════════════════════════════
async function G02() {
  seedGroupedWorld({ shuffleQuestions: false });
  const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const order = A(started.attempt.id).questionOrder.SA;
  deepEq(order, ['s1', 'g1a', 'g1b', 'g1c', 's2', 'g2a', 'g2b'],
    'authored order preserved verbatim when shuffle is off');
}

// ═══════════════════════════════════════════════════════════════════
// G-03 · an ungrouped paper shuffles exactly as it always did
// ═══════════════════════════════════════════════════════════════════
async function G03() {
  // The back-compat claim: with no groupId anywhere, every block has length 1
  // and the block shuffle degenerates to the original per-question shuffle.
  // Assert it produces varied orders over many draws, and never drops or
  // duplicates a question.
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    DB = new FakeDb();
    DB.seed('students', 'stu_1', { id: 'stu_1', name: 'S', instituteId: 'inst_1' });
    const paper = ['a', 'b', 'c', 'd'].map((q, idx) => ({ questionId: q, marks: 5, order: idx }));
    DB.seed('assessments', 'asmt_1', {
      id: 'asmt_1', title: 'Flat', instituteId: 'inst_1', status: 'active',
      startDate: at(VNOW - min(60)), endDate: at(VNOW + min(600)),
      maxAttempts: 1, overallTimeLimit: 60, deliveryMode: 'standard',
      sectionStartOrder: 'sequential', shuffleQuestions: true,
      securityTier: 'mock', requireCamera: false, allowMobile: true,
      requireExtensionCheck: false, requireSEB: false,
      securityLockedAt: at(VNOW - min(120)), assignedTo: { type: 'all' },
      sections: [{ id: 'SA', name: 'A', timeLimit: 30, questions: paper }],
    });
    for (const q of ['a', 'b', 'c', 'd']) {
      DB.seed('questions', q, { id: q, engine: 'mcq', variant: 'single', stem: q, options: [], difficulty: 'medium' });
      DB.seed('questionAnswers', q, { id: q, correctIds: [], correctPairs: [], modelAnswer: '' });
    }
    const started = await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
    const order = A(started.attempt.id).questionOrder.SA;
    eq([...order].sort().join(','), 'a,b,c,d', 'no question dropped or duplicated');
    seen.add(order.join(','));
  }
  check(seen.size > 1, 'an ungrouped paper still shuffles', `distinct orders: ${seen.size}`);
}

// ═══════════════════════════════════════════════════════════════════
// G-04 · getExamQuestions returns the stimulus, whitelisted
// ═══════════════════════════════════════════════════════════════════
async function G04() {
  seedGroupedWorld({ shuffleQuestions: false });
  await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const res = await call(fns.getExamQuestions, { assessmentId: 'asmt_1' }, STUDENT());

  eq(res.questions.length, 7, 'all 7 questions returned');
  eq(Array.isArray(res.groups), true, 'groups array present');
  eq(res.groups.length, 2, 'both referenced groups returned');

  const q = res.questions.find((x) => x.id === 'g1b');
  eq(q.groupId, 'grp_1', 'child carries its groupId to the client');
  eq(q.groupOrder, 1, 'child carries its groupOrder to the client');
  const solo = res.questions.find((x) => x.id === 's1');
  eq(solo.groupId, null, 'a standalone question reports groupId null');

  const rc = res.groups.find((g) => g.id === 'grp_1');
  eq(rc.kind, 'rc', 'group kind survives');
  eq(rc.stimulus.body, 'The passage text.', 'passage body reaches the student');

  const di = res.groups.find((g) => g.id === 'grp_2');
  eq(di.stimulus.format, 'table', 'DI stimulus keeps its structural format');
  deepEq(di.stimulus.table.headers, ['Region', '2024'], 'table headers survive');
  deepEq(di.stimulus.table.rows, [{ cells: ['North', '120'] }], 'table rows survive (Firestore forbids nested arrays, so rows are {cells})');

  // ── The whitelist half ──
  // childIds would tell a candidate how much of the set they were NOT asked,
  // and hands anyone scraping the payload a map of the bank's structure.
  check(!('childIds' in rc), 'childIds never reaches a student');
  // The title is the author's internal label ("reuse after Nov sitting").
  check(!('title' in rc), 'the internal group title never reaches a student');
  check(!('ownerType' in rc), 'ownerType never reaches a student');
  check(!('ownerId' in rc), 'ownerId never reaches a student');
  check(!('instituteId' in rc), 'instituteId never reaches a student');
  check(!('isDeleted' in rc), 'isDeleted never reaches a student');

  // The question whitelist must still hold for group children.
  deepEq(q.correctIds, [], 'answer key still withheld on a grouped child');
  eq(q.modelAnswer, '', 'model answer still withheld on a grouped child');
}

// ═══════════════════════════════════════════════════════════════════
// G-05 · an ungrouped paper returns no groups and reads none
// ═══════════════════════════════════════════════════════════════════
async function G05() {
  DB.seed('students', 'stu_1', { id: 'stu_1', name: 'S', instituteId: 'inst_1' });
  DB.seed('assessments', 'asmt_1', {
    id: 'asmt_1', title: 'Flat', instituteId: 'inst_1', status: 'active',
    startDate: at(VNOW - min(60)), endDate: at(VNOW + min(600)),
    maxAttempts: 1, overallTimeLimit: 60, deliveryMode: 'standard',
    sectionStartOrder: 'sequential', shuffleQuestions: false,
    securityTier: 'mock', requireCamera: false, allowMobile: true,
    requireExtensionCheck: false, requireSEB: false,
    securityLockedAt: at(VNOW - min(120)), assignedTo: { type: 'all' },
    sections: [{ id: 'SA', name: 'A', timeLimit: 30, questions: [{ questionId: 'a', marks: 5, order: 0 }] }],
  });
  DB.seed('questions', 'a', { id: 'a', engine: 'mcq', variant: 'single', stem: 'a', options: [], difficulty: 'medium' });
  DB.seed('questionAnswers', 'a', { id: 'a', correctIds: [], correctPairs: [], modelAnswer: '' });

  await call(fns.startExam, { assessmentId: 'asmt_1' }, STUDENT());
  const res = await call(fns.getExamQuestions, { assessmentId: 'asmt_1' }, STUDENT());
  deepEq(res.groups, [], 'a paper with no grouped questions returns an empty group list');
  eq(res.questions[0].groupId, null, 'ungrouped question reports groupId null');
}

// ═══════════════════════════════════════════════════════════════════
// G-06 · createQuestionGroupAsRole writes group + children atomically
// ═══════════════════════════════════════════════════════════════════
async function G06() {
  seedRightsWorld();
  const res = await call(fns.createQuestionGroupAsRole, {
    group: {
      kind: 'di', title: 'Sales DI',
      stimulus: { format: 'table', table: { headers: ['R'], rows: [{ cells: ['N'] }] } },
      subject: 'Quant', topic: 'DI', difficulty: 'medium', tags: [],
    },
    children: [
      { engine: 'mcq', variant: 'single', stem: 'Q1', options: [], correctIds: ['x'], difficulty: 'easy' },
      { engine: 'mcq', variant: 'single', stem: 'Q2', options: [], correctIds: ['y'], difficulty: 'hard' },
    ],
    subjectId: 'quant-1', topicId: 'di-1',
  }, INSTITUTE());

  eq(res.ok, true, 'create succeeds for an institute holding the create right');
  eq(res.childIds.length, 2, 'both children created');

  const group = DB.read('questionGroups', res.id);
  check(!!group, 'group document written');
  deepEq(group.childIds, res.childIds, 'group records its children in order');
  eq(group.ownerType, 'institute', 'group carries the resolved owner type');
  eq(group.ownerId, 'inst_1', 'group carries the resolved owner id');
  eq(group.instituteId, 'inst_1', 'group carries the tenant stamp');
  eq(group.isDeleted, false, 'group born live');

  res.childIds.forEach((cid, idx) => {
    const child = DB.read('questions', cid);
    eq(child.groupId, res.id, `child ${idx} points back at its group`);
    eq(child.groupOrder, idx, `child ${idx} carries its position`);
    // Stamps must match the group's exactly, or the two land on opposite
    // sides of the tenant fence in firestore.rules.
    eq(child.ownerType, group.ownerType, `child ${idx} shares the group's ownerType`);
    eq(child.ownerId, group.ownerId, `child ${idx} shares the group's ownerId`);
    eq(child.instituteId, group.instituteId, `child ${idx} shares the group's tenant stamp`);
    // Answer keys are split off exactly as for a standalone question.
    deepEq(child.correctIds, [], `child ${idx} public doc carries no answer key`);
    const ans = DB.read('questionAnswers', cid);
    check(!!ans, `child ${idx} has a sibling answer document`);
  });

  deepEq(DB.read('questionAnswers', res.childIds[0]).correctIds, ['x'], 'first child key stored');
  deepEq(DB.read('questionAnswers', res.childIds[1]).correctIds, ['y'], 'second child key stored');

  // Children count toward taxonomy totals like any other question.
  eq(DB.read('subjects', 'quant-1'), undefined, 'absent counter doc is tolerated, not fatal');

  await expectThrow('a group with no children is refused',
    () => call(fns.createQuestionGroupAsRole, {
      group: { kind: 'rc', stimulus: { format: 'richtext', body: 'x' } }, children: [],
    }, INSTITUTE()),
    'at least one child');
}

// ═══════════════════════════════════════════════════════════════════
// G-07 · deleting a group cascades to its children
// ═══════════════════════════════════════════════════════════════════
async function G07() {
  seedRightsWorld();
  const created = await call(fns.createQuestionGroupAsRole, {
    group: { kind: 'rc', title: 'P', stimulus: { format: 'richtext', body: 'passage' }, subject: 'Eng', topic: 'RC', difficulty: 'medium', tags: [] },
    children: [
      { engine: 'mcq', variant: 'single', stem: 'Q1', options: [], difficulty: 'medium' },
      { engine: 'mcq', variant: 'single', stem: 'Q2', options: [], difficulty: 'medium' },
      { engine: 'mcq', variant: 'single', stem: 'Q3', options: [], difficulty: 'medium' },
    ],
  }, INSTITUTE());

  // Move one child OUT of the group before deleting, to prove the cascade is
  // scoped by the child's own groupId rather than trusting the stale array.
  const escapee = created.childIds[2];
  const moved = DB.read('questions', escapee);
  moved.groupId = 'some_other_group';
  DB.seed('questions', escapee, moved);

  const del = await call(fns.deleteQuestionGroupAsRole, { id: created.id }, INSTITUTE());
  eq(del.ok, true, 'delete succeeds');
  eq(del.deletedChildren, 2, 'only children still pointing at this group are deleted');

  eq(DB.read('questionGroups', created.id).isDeleted, true, 'group soft-deleted');
  eq(DB.read('questions', created.childIds[0]).isDeleted, true, 'first child soft-deleted');
  eq(DB.read('questions', created.childIds[1]).isDeleted, true, 'second child soft-deleted');
  // The escapee must survive: it now belongs to another set, and deleting it
  // would silently remove a question from a group nobody asked to delete.
  // Born isDeleted:false and must still be false — the cascade skipped it.
  eq(DB.read('questions', escapee).isDeleted, false, 'a child that left the group is untouched');

  // Idempotent.
  const again = await call(fns.deleteQuestionGroupAsRole, { id: created.id }, INSTITUTE());
  eq(again.deletedChildren, 0, 're-deleting a deleted group is a no-op');
}

// ═══════════════════════════════════════════════════════════════════
// G-08 · group edits cannot rewrite membership or ownership
// ═══════════════════════════════════════════════════════════════════
async function G08() {
  seedRightsWorld();
  const created = await call(fns.createQuestionGroupAsRole, {
    group: { kind: 'rc', title: 'P', stimulus: { format: 'richtext', body: 'before' }, subject: 'Eng', topic: 'RC', difficulty: 'medium', tags: [] },
    children: [{ engine: 'mcq', variant: 'single', stem: 'Q1', options: [], difficulty: 'medium' }],
  }, INSTITUTE());

  await call(fns.editQuestionGroupAsRole, {
    id: created.id,
    group: {
      stimulus: { format: 'richtext', body: 'after' },
      // Every one of these must be ignored.
      childIds: ['someone_elses_question'],
      ownerType: 'webOwner',
      ownerId: 'webOwner',
      instituteId: 'inst_evil',
      id: 'grp_forged',
    },
  }, INSTITUTE());

  const g = DB.read('questionGroups', created.id);
  eq(g.stimulus.body, 'after', 'the stimulus edit lands');
  deepEq(g.childIds, created.childIds, 'childIds cannot be rewritten by the client');
  eq(g.ownerType, 'institute', 'ownerType cannot be escalated to webOwner');
  eq(g.ownerId, 'inst_1', 'ownerId is server-owned');
  eq(g.instituteId, 'inst_1', 'the tenant stamp cannot be moved');
  eq(g.id, created.id, 'the id cannot be forged');

  // Cross-tenant edit is refused.
  await expectThrow('another institute cannot edit this group',
    () => call(fns.editQuestionGroupAsRole,
      { id: created.id, group: { stimulus: { format: 'richtext', body: 'hostile' } } },
      INSTITUTE('inst_2')),
    '');
  eq(DB.read('questionGroups', created.id).stimulus.body, 'after', 'the hostile edit did not land');
}

// ═══════════════════════════════════════════════════════════════════
// Runner
// ═══════════════════════════════════════════════════════════════════
(async () => {
  await scenario('G-01', 'shuffle keeps grouped sets whole and internally ordered', G01);
  await scenario('G-02', 'shuffle off — authored order preserved', G02);
  await scenario('G-03', 'ungrouped paper shuffles exactly as before', G03);
  await scenario('G-04', 'getExamQuestions serves the stimulus, whitelisted', G04);
  await scenario('G-05', 'ungrouped paper returns no groups', G05);
  await scenario('G-06', 'create writes group + children atomically', G06);
  await scenario('G-07', 'delete cascades to children', G07);
  await scenario('G-08', 'edits cannot rewrite membership or ownership', G08);

  const B = (s) => `\x1b[1m${s}\x1b[0m`;
  const G = (s) => `\x1b[32m${s}\x1b[0m`;
  const R = (s) => `\x1b[31m${s}\x1b[0m`;

  console.log(`\n${B('QUESTION GROUPS SUITE')}  —  real callables, in-memory Firestore\n`);
  let passed = 0, failed = 0;
  for (const r of results) {
    const bad = r.checks.filter((c) => !c.pass);
    passed += r.checks.length - bad.length;
    failed += bad.length;
    const verdict = r.error || bad.length ? R('FAIL') : G('PASS');
    console.log(`  ${verdict}  ${B(r.id)}  ${r.title}`);
    if (r.error) console.log(`         ${R('threw')} ${r.error.message}`);
    for (const c of bad) console.log(`         ${R('×')} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  console.log('\n' + '─'.repeat(72));
  if (failed === 0) {
    console.log(`${G(B('  ALL GREEN'))} — ${passed} passed, 0 failed across ${results.length} scenarios\n`);
    process.exit(0);
  } else {
    console.log(`${R(B('  FAILURES'))} — ${passed} passed, ${failed} failed across ${results.length} scenarios\n`);
    process.exit(1);
  }
})();
