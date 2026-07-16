// ═══════════════════════════════════════════════════════════════════════════
// ALLOCATION CORE — PROPERTY SWEEP (Phase B gate, plans/ALLOCATION_SYSTEM_PLAN.md §6)
// Runs the COMPILED PRODUCTION CORE (functions/src/allocationCore.ts) against
// generated synthetic worlds and randomized allocations, asserting the
// system-plan properties on every case. Zero defects required before deploy.
//
// Re-run any time:  node allocation.sweep.cjs  (after `npx esbuild
// src/allocationCore.ts --bundle --format=cjs --outfile=core.cjs`)
// ═══════════════════════════════════════════════════════════════════════════
const C = require('./core.cjs');
const assert = require('assert');

// Deterministic PRNG — reproducible sweeps.
let seed = 20260713;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const shuffle = (arr) => arr.map((v) => [rnd(), v]).sort((a, b) => a[0] - b[0]).map(([, v]) => v);

// ── Synthetic world generator ──────────────────────────────────────
// Institute → 2 schools → 2 levels → 2 programs → 1-2 sessions → 2 years
// → 0-2 semesters (null branch when 0) → 2-3 courses → 2-3 sections → 0-2 groups.
// ~8% of nodes archived; students multi-mapped; some unmapped.
function makeWorld(widx) {
  const inst = `I${widx}`;
  const nodes = { school: [], academicLevel: [], program: [], academicSession: [],
                  academicYear: [], semester: [], course: [], section: [], group: [] };
  const push = (type, obj) => { nodes[type].push(obj); return obj; };
  let n = 0;
  const id = (p) => `${p}${widx}_${n++}`;
  const st = () => (rnd() < 0.08 ? 'archived' : 'active');

  for (let s = 0; s < 2; s++) {
    const school = push('school', { id: id('SCH'), name: `School${s}`, status: st(), instituteId: inst });
    for (let l = 0; l < 2; l++) {
      const level = push('academicLevel', { id: id('LVL'), name: `Level${l}`, status: st(), instituteId: inst, schoolId: school.id });
      for (let p = 0; p < 2; p++) {
        const prog = push('program', { id: id('PRG'), name: `Prog${p}`, status: st(), instituteId: inst, schoolId: school.id, levelId: level.id });
        const nSess = 1 + Math.floor(rnd() * 2);
        for (let se = 0; se < nSess; se++) {
          const sess = push('academicSession', { id: id('SES'), name: `Batch${se}`, status: st(), instituteId: inst, schoolId: school.id, levelId: level.id, programId: prog.id });
          for (let y = 0; y < 2; y++) {
            const year = push('academicYear', { id: id('YR'), name: `Year${y + 1}`, status: st(), instituteId: inst, schoolId: school.id, levelId: level.id, programId: prog.id, sessionId: sess.id });
            const chain = { instituteId: inst, schoolId: school.id, levelId: level.id, programId: prog.id, sessionId: sess.id, yearId: year.id };
            const nSem = Math.floor(rnd() * 3); // 0 → semester-null branch
            const semIds = [];
            for (let sm = 0; sm < nSem; sm++) {
              semIds.push(push('semester', { id: id('SEM'), name: `Sem${sm + 1}`, status: st(), ...chain }).id);
            }
            const semesterChoices = semIds.length > 0 ? semIds : [null];
            const nCourse = 2 + Math.floor(rnd() * 2);
            for (let c = 0; c < nCourse; c++) {
              const semesterId = pick(semesterChoices);
              const course = push('course', { id: id('C'), name: `Course${c}`, status: st(), ...chain, semesterId });
              const nSec = 2 + Math.floor(rnd() * 2);
              for (let sc = 0; sc < nSec; sc++) {
                const section = push('section', { id: id('SEC'), name: `Sec${sc}`, status: st(), ...chain, semesterId, courseId: course.id });
                const nGrp = Math.floor(rnd() * 3);
                for (let g = 0; g < nGrp; g++) {
                  push('group', { id: id('G'), name: `Grp${g}`, status: st(), ...chain, semesterId, courseId: course.id, sectionId: section.id });
                }
              }
            }
          }
        }
      }
    }
  }

  // Students + mappings (map only at section/group; upward membership must
  // surface them at EVERY ancestor level). ~6% left unmapped on purpose.
  const students = [];
  const mappings = [];
  const leaves = [...nodes.section, ...nodes.group];
  const nStudents = 500;
  for (let i = 0; i < nStudents; i++) {
    const sid = `S${widx}_${i}`;
    students.push({ id: sid, instituteId: inst });
    if (rnd() < 0.06) continue; // unmapped
    const nMaps = 1 + Math.floor(rnd() * 3); // multi-mapping by design
    const used = new Set();
    for (let m = 0; m < nMaps; m++) {
      const node = pick(leaves);
      if (used.has(node.id)) continue;
      used.add(node.id);
      mappings.push({ studentId: sid, nodeId: node.id, instituteId: inst });
    }
  }
  return { inst, nodes, students, mappings };
}

// ── Fetch-layer simulation (mirrors index.ts fetchCoreInput exactly) ──
function coreInputFor(world, nodeType, nodeIds, currentRulesMemberIds = []) {
  if (nodeType === 'institute') {
    return {
      nodeType, requestedIds: nodeIds,
      selected: nodeIds.map((i) => ({ id: i, name: i, status: 'active', instituteId: i })),
      descendants: [], mappings: [],
      instituteStudents: world.students.filter((s) => nodeIds.includes(s.instituteId))
        .map((s) => ({ id: s.id, instituteId: s.instituteId })),
      currentRulesMemberIds,
    };
  }
  const field = C.ANCESTOR_FIELD[nodeType];
  const all = world.nodes[nodeType];
  const selected = all.filter((x) => nodeIds.includes(x.id))
    .map((x) => ({ id: x.id, name: x.name, status: x.status, instituteId: x.instituteId }));
  const descendants = [];
  C.typesBelow(nodeType).forEach((bt) => {
    world.nodes[bt].forEach((d) => {
      if (nodeIds.includes(d[field])) {
        descendants.push({ id: d.id, status: d.status, parentSelectedId: d[field] });
      }
    });
  });
  const validMapNodes = new Set([...nodeIds, ...descendants.filter((d) => d.status === 'active').map((d) => d.id)]);
  const mappings = world.mappings.filter((m) => validMapNodes.has(m.nodeId));
  return { nodeType, requestedIds: nodeIds, selected, descendants, mappings, currentRulesMemberIds };
}

// ── Oracle: brute-force ground truth via full ancestor chains ──────
function oracleMembers(world, nodeType, nodeIds) {
  if (nodeType === 'institute') {
    return new Set(world.students.filter((s) => nodeIds.includes(s.instituteId)).map((s) => s.id));
  }
  const field = C.ANCESTOR_FIELD[nodeType];
  const nodeById = new Map();
  Object.values(world.nodes).forEach((rows) => rows.forEach((r) => nodeById.set(r.id, r)));
  const out = new Set();
  const selectedSet = new Set(nodeIds);
  // Every selected node must itself be active (else the case is an error case).
  world.mappings.forEach((m) => {
    const at = nodeById.get(m.nodeId);
    if (!at || at.status !== 'active') return;
    // membership propagates upward: mapping counts for target T when the
    // mapped node IS T or carries T in its ancestor chain.
    if (selectedSet.has(m.nodeId) || (at[field] && selectedSet.has(at[field]))) out.add(m.studentId);
  });
  return out;
}

let cases = 0, checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const NODE_TYPES = ['school', 'academicLevel', 'program', 'academicSession', 'academicYear', 'semester', 'course', 'section', 'group'];

console.log('ALLOCATION CORE PROPERTY SWEEP');
const worlds = [makeWorld(1), makeWorld(2), makeWorld(3)];
worlds.forEach((w) => {
  const total = Object.values(w.nodes).reduce((a, r) => a + r.length, 0);
  console.log(`  world ${w.inst}: ${total} nodes · ${w.students.length} students · ${w.mappings.length} mappings`);
});

// ── Property 1: core == oracle on randomized active selections (900 cases) ──
for (let i = 0; i < 900; i++) {
  const world = pick(worlds);
  const t = pick(NODE_TYPES);
  const activeNodes = world.nodes[t].filter((n) => n.status === 'active');
  if (activeNodes.length === 0) continue;
  const k = 1 + Math.floor(rnd() * Math.min(6, activeNodes.length));
  const ids = shuffle(activeNodes).slice(0, k).map((n) => n.id);
  const r = C.resolveCore(coreInputFor(world, t, ids));
  ok(r.errors.length === 0, `unexpected errors: ${r.errors}`);
  const got = new Set(r.members.map((m) => m.studentId));
  const want = oracleMembers(world, t, ids);
  ok(got.size === want.size && [...want].every((s) => got.has(s)),
    `core≠oracle for ${t} × ${k} (got ${got.size}, want ${want.size})`);
  // via attribution: every via node is a selected node; member count consistency
  r.members.forEach((m) => ok(m.viaNodeIds.every((v) => ids.includes(v)), 'via outside selection'));
  // per-node counts sum ≥ total (multi-via) and each ≤ total
  const sum = r.byNode.reduce((a, n) => a + n.count, 0);
  ok(sum >= r.members.length, 'byNode undercount');
  cases++;
}
console.log(`  ✓ P1 core == brute-force oracle — ${cases} randomized cases`);

// ── Property 2: order invariance ───────────────────────────────────
for (let i = 0; i < 150; i++) {
  const world = pick(worlds);
  const t = pick(NODE_TYPES);
  const act = world.nodes[t].filter((n) => n.status === 'active');
  if (act.length < 2) continue;
  const ids = shuffle(act).slice(0, Math.min(5, act.length)).map((n) => n.id);
  const a = C.resolveCore(coreInputFor(world, t, ids));
  const b = C.resolveCore(coreInputFor(world, t, shuffle(ids)));
  ok(JSON.stringify(a.members) === JSON.stringify(b.members), 'order changed result');
}
console.log('  ✓ P2 node-order invariance — 150 cases');

// ── Property 3: parent ⊇ child (upward-membership law) ─────────────
let p3 = 0;
for (let i = 0; i < 300; i++) {
  const world = pick(worlds);
  const childType = pick(['section', 'group', 'course']);
  const child = pick(world.nodes[childType].filter((n) => n.status === 'active') || []);
  if (!child) continue;
  const parents = [
    ['school', child.schoolId], ['program', child.programId],
    ['academicYear', child.yearId], ['course', child.courseId],
    ['section', child.sectionId],
  ].filter(([pt, pid]) => pid && pt !== childType &&
    world.nodes[pt].some((n) => n.id === pid && n.status === 'active'));
  if (parents.length === 0) continue;
  const [pt, pid] = pick(parents);
  const childSet = new Set(C.resolveCore(coreInputFor(world, childType, [child.id])).members.map((m) => m.studentId));
  const parentSet = new Set(C.resolveCore(coreInputFor(world, pt, [pid])).members.map((m) => m.studentId));
  ok([...childSet].every((s) => parentSet.has(s)),
    `student in ${childType} missing from ancestor ${pt} — upward membership broken`);
  p3++;
}
console.log(`  ✓ P3 group→…→school upward membership (parent ⊇ child) — ${p3} cases`);

// ── Property 4: archived selected node → hard error, never silent ∅ ─
let p4 = 0;
for (const world of worlds) {
  for (const t of NODE_TYPES) {
    const arch = world.nodes[t].find((n) => n.status === 'archived');
    const act = world.nodes[t].find((n) => n.status === 'active');
    if (!arch || !act) continue;
    const r = C.resolveCore(coreInputFor(world, t, [act.id, arch.id]));
    ok(r.errors.length > 0 && r.errors.some((e) => e.includes('archived')), 'archived node not rejected');
    ok(r.members.length === 0, 'errors must short-circuit resolution');
    p4++;
  }
}
console.log(`  ✓ P4 archived-selection → named hard error — ${p4} cases`);

// ── Property 5: archived DESCENDANTS excluded from expansion ───────
let p5 = 0;
for (let i = 0; i < 200; i++) {
  const world = pick(worlds);
  const course = pick(world.nodes.course.filter((n) => n.status === 'active'));
  if (!course) continue;
  const archived = new Set([...world.nodes.section, ...world.nodes.group]
    .filter((n) => n.courseId === course.id && n.status === 'archived').map((n) => n.id));
  if (archived.size === 0) continue;
  const got = new Set(C.resolveCore(coreInputFor(world, 'course', [course.id])).members.map((m) => m.studentId));
  const onlyArchived = world.mappings.filter((m) => archived.has(m.nodeId)).map((m) => m.studentId)
    .filter((sid) => !got.has(sid) ||
      world.mappings.some((m) => m.studentId === sid && !archived.has(m.nodeId)));
  // students mapped ONLY at archived descendants must be absent
  world.mappings.filter((m) => archived.has(m.nodeId)).forEach((m) => {
    const alsoActive = world.mappings.some((x) => x.studentId === m.studentId && !archived.has(x.nodeId) &&
      (x.nodeId === course.id || [...world.nodes.section, ...world.nodes.group].some((n) => n.id === x.nodeId && n.courseId === course.id && n.status === 'active')));
    if (!alsoActive) ok(!got.has(m.studentId), 'archived-only student leaked in');
  });
  p5++;
}
console.log(`  ✓ P5 archived descendants excluded — ${p5} cases`);

// ── Property 6: delta correctness + manual invariance across syncs ──
let p6 = 0;
for (let i = 0; i < 200; i++) {
  const world = pick(worlds);
  const t = pick(NODE_TYPES);
  const act = world.nodes[t].filter((n) => n.status === 'active');
  if (act.length < 2) continue;
  const ids1 = shuffle(act).slice(0, 2).map((n) => n.id);
  const r1 = C.resolveCore(coreInputFor(world, t, ids1, []));
  ok(r1.delta.added.length === r1.members.length && r1.delta.removed.length === 0, 'first materialization delta wrong');
  // Sync with a changed selection; current = r1 members (rules only — manual ids NEVER passed in)
  const ids2 = shuffle(act).slice(0, 2).map((n) => n.id);
  const current = r1.members.map((m) => m.studentId);
  const r2 = C.resolveCore(coreInputFor(world, t, ids2, current));
  const next = new Set(r2.members.map((m) => m.studentId));
  const cur = new Set(current);
  ok(r2.delta.added.every((s) => next.has(s) && !cur.has(s)), 'added wrong');
  ok(r2.delta.removed.every((s) => cur.has(s) && !next.has(s)), 'removed wrong');
  ok(r2.delta.added.length + [...next].filter((s) => cur.has(s)).length === next.size, 'delta partition broken');
  p6++;
}
console.log(`  ✓ P6 delta correctness across syncs (manual ids structurally invisible) — ${p6} cases`);

// ── Property 7: caps, duplicates, empty, unknown ───────────────────
{
  const world = worlds[0];
  const secs = world.nodes.section.filter((n) => n.status === 'active');
  let r = C.resolveCore(coreInputFor(world, 'section', []));
  ok(r.errors.length > 0, 'empty selection must error');
  r = C.resolveCore(coreInputFor(world, 'section', [secs[0].id, secs[0].id]));
  ok(r.errors.some((e) => e.includes('Duplicate')), 'duplicates must error');
  r = C.resolveCore(coreInputFor(world, 'section', ['NOPE_1']));
  ok(r.errors.some((e) => e.includes('does not exist')), 'missing node must error');
  const tooMany = Array.from({ length: 201 }, (_, i) => `X${i}`);
  r = C.resolveCore(coreInputFor(world, 'section', tooMany));
  ok(r.errors.some((e) => e.includes('cap')), 'cap must error');
  r = C.resolveCore({ nodeType: 'martian', requestedIds: ['x'], selected: [], descendants: [], mappings: [], currentRulesMemberIds: [] });
  ok(r.errors.some((e) => e.includes('Unknown node type')), 'unknown type must error');
  console.log('  ✓ P7 validation: empty / duplicate / missing / cap / unknown type');
}

// ── Property 8: empty resolution = commit blocker, not error ───────
{
  const world = worlds[0];
  // find an active section with no mappings at/below it
  const empty = world.nodes.section.find((sec) => sec.status === 'active' &&
    !world.mappings.some((m) => m.nodeId === sec.id ||
      world.nodes.group.some((g) => g.sectionId === sec.id && g.status === 'active' && g.id === m.nodeId)));
  if (empty) {
    const r = C.resolveCore(coreInputFor(world, 'section', [empty.id]));
    ok(r.errors.length === 0 && r.commitBlockers.length > 0, 'empty result must block commit, not error dry-run');
    ok(r.warnings.some((w) => w.includes('0 students')), 'zero-count warning missing');
    console.log('  ✓ P8 resolves-to-nobody → commit blocker + warning (dry-run stays valid)');
  } else {
    console.log('  ○ P8 skipped (no empty section in generated worlds this seed)');
  }
}

// ── Property 9: institute mode includes unmapped students ──────────
{
  const world = worlds[1];
  const r = C.resolveCore(coreInputFor(world, 'institute', [world.inst]));
  ok(r.members.length === world.students.length, 'institute mode must include every student');
  const mapped = new Set(world.mappings.map((m) => m.studentId));
  const unmappedInResult = r.members.filter((m) => !mapped.has(m.studentId));
  ok(unmappedInResult.length > 0, 'unmapped students missing from institute mode');
  console.log(`  ✓ P9 institute mode = all students incl. ${unmappedInResult.length} unmapped`);
}

// ── Property 10: cross-institute selection rejected ────────────────
{
  const a = worlds[0].nodes.section.find((n) => n.status === 'active');
  const b = worlds[1].nodes.section.find((n) => n.status === 'active');
  const merged = {
    inst: 'X',
    nodes: Object.fromEntries(Object.keys(worlds[0].nodes).map((k) => [k, [...worlds[0].nodes[k], ...worlds[1].nodes[k]]])),
    students: [...worlds[0].students, ...worlds[1].students],
    mappings: [...worlds[0].mappings, ...worlds[1].mappings],
  };
  const r = C.resolveCore(coreInputFor(merged, 'section', [a.id, b.id]));
  ok(r.errors.some((e) => e.includes('same institute')), 'cross-institute must error');
  console.log('  ✓ P10 cross-institute selection rejected');
}

// ── Property 11 (B-2): course resolves SIDEWAYS to its sections ────
// The fetch layer feeds sections-as-descendants attributed to the course, and
// groups attributed to their section. The core must chain group→section→course
// transitively so every student is credited via the COURSE node.
{
  const input = {
    nodeType: 'course', requestedIds: ['C1'],
    selected: [{ id: 'C1', name: 'DS', status: 'active', instituteId: 'I1' }],
    descendants: [
      { id: 'SecA', status: 'active', parentSelectedId: 'C1' },
      { id: 'SecB', status: 'active', parentSelectedId: 'C1' },
      { id: 'G1', status: 'active', parentSelectedId: 'SecA' },
      { id: 'GArch', status: 'archived', parentSelectedId: 'SecA' },
    ],
    mappings: [
      { studentId: 's1', nodeId: 'G1', instituteId: 'I1' },
      { studentId: 's2', nodeId: 'SecA', instituteId: 'I1' },
      { studentId: 's3', nodeId: 'SecB', instituteId: 'I1' },
      { studentId: 'sArch', nodeId: 'GArch', instituteId: 'I1' },
    ],
    currentRulesMemberIds: [],
  };
  const r = C.resolveCore(input);
  ok(r.errors.length === 0, 'course resolution errored');
  ok(r.members.map((m) => m.studentId).sort().join(',') === 's1,s2,s3', 'course must include section+group students, exclude archived');
  r.members.forEach((m) => ok(m.viaNodeIds.includes('C1'), 'course attribution must chain to the course node'));
  // order independence: shuffle descendants
  const shuffled = { ...input, descendants: shuffle([...input.descendants]) };
  const r2 = C.resolveCore(shuffled);
  ok(JSON.stringify(r.members) === JSON.stringify(r2.members), 'course resolution must not depend on descendant order');
  console.log('  \u2713 P11 course resolves sideways (section+group, via-course attribution, order-independent)');
}

console.log(`\nALL PROPERTIES PASSED — ${checks} assertions across ${cases}+ generated cases · zero defects`);
