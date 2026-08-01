// ═══════════════════════════════════════════════════════════════════════════
// EXAM TIMING CORE — PROPERTY SWEEP  (master plan Phase 3a gate)
//
// Runs the COMPILED PRODUCTION CORE (functions/src/examTimingCore.ts) across
// the whole reachable state space and asserts the master plan's properties on
// every case. Zero defects required before Phase 3b points production at it.
//
// Re-run any time:
//   npx esbuild src/examTimingCore.ts --bundle --format=cjs --outfile=timing-core.cjs
//   node timing.sweep.cjs
//
// WHY EXHAUSTIVE RATHER THAN EXAMPLE-BASED
// Every shipped timing bug lived in a combination nobody thought to try by
// hand: a section advance with no break (D-01), the last question of a section
// (D-14), a frozen student past their uncredited deadline (D-03). Enumerating
// the space removes "nobody thought to try that" as a failure mode.
// ═══════════════════════════════════════════════════════════════════════════

const C = require('./timing-core.cjs');
const assert = require('assert');

// Deterministic PRNG — a failing sweep is reproducible.
let seed = 20260801;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

const T0 = Date.parse('2026-08-01T09:00:00.000Z');
const min = (m) => m * 60_000;
const iso = (ms) => new Date(ms).toISOString();

let checks = 0;
const failures = [];
function check(cond, label, ctx) {
  checks++;
  if (!cond) failures.push({ label, ctx });
}

// ── World generator ────────────────────────────────────────────────

function makeAssessment(opts) {
  const sections = [];
  for (let i = 0; i < opts.sectionCount; i++) {
    sections.push({
      id: `S${i}`,
      timeLimit: opts.timed ? opts.sectionMinutes : 0,
      questionTimeLimit: opts.sequential ? opts.questionSeconds : undefined,
      breakAfter: opts.breaks && i < opts.sectionCount - 1
        ? { enabled: true, durationMinutes: opts.breakMinutes, mandatory: opts.mandatoryBreak }
        : undefined,
      questionIds: Array.from({ length: opts.questionsPerSection }, (_, q) => `S${i}q${q}`),
    });
  }
  return {
    startDate: iso(T0 - min(60)),
    endDate: opts.windowMinutes > 0 ? iso(T0 + min(opts.windowMinutes)) : undefined,
    overallTimeLimit: opts.overallMinutes,
    overallGraceSeconds: opts.overallGrace,
    sectionGraceSeconds: opts.sectionGrace,
    questionGraceSeconds: opts.questionGrace,
    sectionStartOrder: opts.order,
    deliveryMode: opts.sequential ? 'linear' : 'standard',
    sections,
  };
}

/** Walk an attempt forward to `upTo` sections completed, then open the next. */
function makeAttempt(asmt, opts, completed, nowOffsetMin) {
  const sectionIds = asmt.sections.map((s) => s.id);
  const timings = {};
  let cursor = T0;
  for (let i = 0; i < completed; i++) {
    const id = sectionIds[i];
    const used = Math.min(opts.sectionMinutes, opts.usedMinutes);
    timings[id] = { startedAt: iso(cursor), submittedAt: iso(cursor + min(used)) };
    cursor += min(used);
    if (opts.breaks && i < sectionIds.length - 1) cursor += min(opts.breakMinutes);
  }
  const openIdx = completed;
  if (openIdx < sectionIds.length && !opts.leaveClosed) {
    timings[sectionIds[openIdx]] = { startedAt: iso(cursor) };
  }

  const served = [];
  if (opts.sequential && openIdx < sectionIds.length && !opts.leaveClosed) {
    const sec = asmt.sections[openIdx];
    for (let q = 0; q < opts.servedCount && q < sec.questionIds.length; q++) {
      served.push({
        questionId: sec.questionIds[q],
        sectionId: sec.id,
        servedAt: iso(cursor + q * 1000),
        locked: q < opts.servedCount - 1,
      });
    }
  }

  return {
    attempt: {
      status: 'in_progress',
      startedAt: iso(T0),
      sectionIds,
      currentSectionIdx: openIdx,
      sectionTimings: timings,
      servedQuestions: served,
      answers: {},
      creditedFreezeMs: opts.freezeMs,
      freezes: opts.freezeMs > 0
        ? [{ id: 'f1', startedAt: iso(T0 + min(1)), endedAt: iso(T0 + min(1) + opts.freezeMs),
             elapsedMs: opts.freezeMs, grantedMs: opts.freezeMs }]
        : [],
    },
    nowMs: T0 + min(nowOffsetMin),
  };
}

// ── Property assertions ────────────────────────────────────────────

function assertVerdictShape(v, ctx) {
  check(v && typeof v.kind === 'string', 'verdict has a kind', ctx);
  check(!!v.deadlines, 'verdict carries deadlines', ctx);
  const d = v.deadlines;
  const parts = [d.windowEndsAt, d.overallEndsAt, d.sectionEndsAt, d.questionEndsAt]
    .filter((x) => x !== null);
  if (parts.length === 0) {
    check(d.effectiveEndsAt === null, 'no bounds -> effective is null', ctx);
  } else {
    check(d.effectiveEndsAt === Math.min(...parts),
      'effectiveEndsAt === min(bounds)', { ...ctx, d });
  }
  if (v.kind === 'break') {
    check(typeof v.endsAt === 'number' && v.endsAt > 0, 'break has endsAt', ctx);
    check(!!v.nextSectionId, 'break names the next section', ctx);
  }
  if (v.kind === 'question') check(!!v.questionId, 'question verdict names a question', ctx);
  if (v.kind === 'section') check(!!v.sectionId, 'section verdict names a section', ctx);
  if (v.kind === 'ended') check(!!v.reason, 'ended verdict carries a reason', ctx);
}

function assertPrecedence(a, asmt, nowMs, v, ctx) {
  if (C.isTerminal(a.status)) return;
  const d = v.deadlines;
  const windowGone  = d.windowEndsAt  !== null && nowMs >= d.windowEndsAt;
  const overallGone = d.overallEndsAt !== null && nowMs >= d.overallEndsAt;
  const sectionGone = d.sectionEndsAt !== null && nowMs >= d.sectionEndsAt;

  // P1 — the window beats everything.
  if (windowGone) {
    check(v.kind === 'ended', 'window closed -> ended', { ...ctx, got: v.kind });
    if (v.kind === 'ended') {
      check(v.reason === 'window_closed', 'window closed -> reason window_closed',
        { ...ctx, got: v.reason });
    }
    return;
  }

  // P2 — the overall clock beats the section and question clocks.
  if (overallGone) {
    check(v.kind === 'ended', 'overall expired -> ended', { ...ctx, got: v.kind });
    if (v.kind === 'ended') {
      check(v.reason === 'overall_expired', 'overall expired -> reason overall_expired',
        { ...ctx, got: v.reason });
    }
    return;
  }

  // P3 — nothing has expired, so a live student is never told they are done.
  if (!sectionGone) {
    if (C.remainingSectionIds(a).length > 0) {
      check(v.kind !== 'ended', 'no clock expired and sections remain -> not ended',
        { ...ctx, got: v.kind, reason: v.reason });
    }
    return;
  }

  // P4 — THE D-01 PROPERTY. The section ran out, but a later section is still
  // in play, so the student must be MOVED ON, never finished. This is the
  // property the shipped bug violated in its observable form: the sitting
  // continued, but the student had been silently written off.
  const openId = C.openSectionId(a);
  const idx = openId ? a.sectionIds.indexOf(openId) : -1;
  const hasLater = idx >= 0 && idx < a.sectionIds.length - 1;
  if (hasLater) {
    check(v.kind !== 'ended', 'section expired with a later section remaining -> advance, not end',
      { ...ctx, got: v.kind, reason: v.reason });
    check(['section', 'break', 'choose', 'question'].includes(v.kind),
      'advance verdict names where to go next', { ...ctx, got: v.kind });
  } else {
    // Last section, and it is over. Ending is the correct outcome.
    check(v.kind === 'ended', 'last section expired -> ended', { ...ctx, got: v.kind });
  }
}

function assertNoInvariantViolations(a, asmt, ctx) {
  const errs = C.checkInvariants(a, asmt).filter((x) => x.severity === 'error');
  check(errs.length === 0, 'generated state satisfies all invariants',
    { ...ctx, errs: errs.map((e) => `${e.id}: ${e.message}`) });
}

// ── Sweep 1 · exhaustive combination walk ──────────────────────────

console.log('Sweep 1 — exhaustive combination walk');
let cases1 = 0;
for (const sectionCount of [1, 2, 4]) {
  for (const timed of [true, false]) {
    for (const sequential of [false, true]) {
      for (const order of ['sequential', 'random', 'student_choice']) {
        for (const breaks of [false, true]) {
          for (const freezeMs of [0, min(10)]) {
            for (const overallMinutes of [0, 25]) {
              for (const windowMinutes of [0, 20]) {
                const opts = {
                  sectionCount, timed, sequential, order, breaks,
                  freezeMs, overallMinutes, windowMinutes,
                  sectionMinutes: 5, breakMinutes: 2, mandatoryBreak: true,
                  questionsPerSection: 3, questionSeconds: 60,
                  sectionGrace: 30, overallGrace: 30, questionGrace: 5,
                  usedMinutes: 3, servedCount: 2, leaveClosed: false,
                };
                const asmt = makeAssessment(opts);
                for (let completed = 0; completed < sectionCount; completed++) {
                  for (const nowOffset of [0, 1, 4, 5, 6, 12, 19, 21, 26, 40]) {
                    const { attempt, nowMs } = makeAttempt(asmt, opts, completed, nowOffset);
                    const ctx = { sectionCount, timed, sequential, order, breaks,
                      freezeMs, overallMinutes, windowMinutes, completed, nowOffset };
                    const v = C.resolve(attempt, asmt, nowMs);
                    assertVerdictShape(v, ctx);
                    assertPrecedence(attempt, asmt, nowMs, v, ctx);
                    assertNoInvariantViolations(attempt, asmt, ctx);
                    cases1++;
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
console.log(`  ${cases1.toLocaleString()} states, ${checks.toLocaleString()} assertions`);

// ── Sweep 2 · boundary instants ────────────────────────────────────
// Off-by-one at a deadline is the classic timing defect: a student expired one
// millisecond early has lost time they were promised.

console.log('Sweep 2 — boundary instants');
let cases2 = 0;
{
  const opts = {
    sectionCount: 3, timed: true, sequential: false, order: 'sequential', breaks: false,
    freezeMs: 0, overallMinutes: 0, windowMinutes: 0,
    sectionMinutes: 5, breakMinutes: 2, mandatoryBreak: true,
    questionsPerSection: 3, questionSeconds: 60,
    sectionGrace: 30, overallGrace: 30, questionGrace: 5,
    usedMinutes: 3, servedCount: 1, leaveClosed: false,
  };
  const asmt = makeAssessment(opts);
  const { attempt } = makeAttempt(asmt, opts, 0, 0);
  const d = C.computeDeadlines(attempt, asmt);
  const edge = d.sectionEndsAt;
  for (const delta of [-2, -1, 0, 1, 2]) {
    const v = C.resolve(attempt, asmt, edge + delta);
    const ctx = { edge, delta, kind: v.kind };
    if (delta < 0) {
      check(v.kind === 'section' || v.kind === 'question',
        'before the deadline the student is still in their section', ctx);
    } else {
      check(v.kind !== 'section' || v.sectionId !== attempt.sectionIds[0],
        'at or after the deadline the student has moved on', ctx);
    }
    cases2++;
  }
  // Grace is INSIDE the deadline (R1): at limit+1ms they must still be in.
  const noGrace = T0 + min(5);
  const v = C.resolve(attempt, asmt, noGrace + 1);
  check(v.kind === 'section' || v.kind === 'question',
    'grace is part of the deadline, not checked separately', { kind: v.kind });
  cases2++;
}
console.log(`  ${cases2} boundary probes`);

// ── Sweep 3 · regressions from the bug history (plan V3) ───────────

console.log('Sweep 3 — regression suite');
const regressions = [];
function regression(name, fn) { regressions.push([name, fn]); }

regression('D-01 · advancing a section moves the section deadline', () => {
  const opts = { sectionCount: 3, timed: true, sequential: false, order: 'sequential',
    breaks: false, freezeMs: 0, overallMinutes: 0, windowMinutes: 0,
    sectionMinutes: 10, breakMinutes: 0, mandatoryBreak: true,
    questionsPerSection: 2, questionSeconds: 0, sectionGrace: 30, overallGrace: 30,
    questionGrace: 5, usedMinutes: 2, servedCount: 0, leaveClosed: false };
  const asmt = makeAssessment(opts);
  const inS0 = makeAttempt(asmt, opts, 0, 0);
  const inS1 = makeAttempt(asmt, opts, 1, 3);
  const d0 = C.computeDeadlines(inS0.attempt, asmt);
  const d1 = C.computeDeadlines(inS1.attempt, asmt);
  assert.notStrictEqual(d0.sectionEndsAt, d1.sectionEndsAt,
    'section deadline must differ once the student advances');
  assert.ok(d1.sectionEndsAt > d0.sectionEndsAt,
    'the new section deadline is later than the one just left');
});

regression('D-14 · the last question of a section is still timed', () => {
  const opts = { sectionCount: 2, timed: true, sequential: true, order: 'sequential',
    breaks: false, freezeMs: 0, overallMinutes: 0, windowMinutes: 0,
    sectionMinutes: 30, breakMinutes: 0, mandatoryBreak: true,
    questionsPerSection: 3, questionSeconds: 60, sectionGrace: 30, overallGrace: 30,
    questionGrace: 5, usedMinutes: 2, servedCount: 3, leaveClosed: false };
  const asmt = makeAssessment(opts);
  const { attempt } = makeAttempt(asmt, opts, 0, 0);
  const d = C.computeDeadlines(attempt, asmt);
  assert.ok(d.questionEndsAt !== null,
    'the LAST question of a section must carry a deadline');
  const v = C.resolve(attempt, asmt, d.questionEndsAt + 1);
  assert.ok(v.kind !== 'question' || v.questionId !== attempt.servedQuestions[2].questionId,
    'expiring on the last question advances rather than sitting there');
});

regression('D-03 · freeze credit extends the student\'s own clocks', () => {
  const base = { sectionCount: 2, timed: true, sequential: false, order: 'sequential',
    breaks: false, freezeMs: 0, overallMinutes: 25, windowMinutes: 0,
    sectionMinutes: 5, breakMinutes: 0, mandatoryBreak: true,
    questionsPerSection: 2, questionSeconds: 0, sectionGrace: 30, overallGrace: 30,
    questionGrace: 5, usedMinutes: 2, servedCount: 0, leaveClosed: false };
  const asmt = makeAssessment(base);
  const cold = makeAttempt(asmt, base, 0, 0);
  const warmOpts = { ...base, freezeMs: min(10) };
  const warm = makeAttempt(asmt, warmOpts, 0, 0);
  const dc = C.computeDeadlines(cold.attempt, asmt);
  const dw = C.computeDeadlines(warm.attempt, asmt);
  assert.strictEqual(dw.sectionEndsAt - dc.sectionEndsAt, min(10),
    'ten credited minutes move the section deadline by exactly ten minutes');
  assert.strictEqual(dw.overallEndsAt - dc.overallEndsAt, min(10),
    'and the overall deadline too');
});

regression('grace survives a resume unchanged (R1)', () => {
  const opts = { sectionCount: 1, timed: true, sequential: false, order: 'sequential',
    breaks: false, freezeMs: 0, overallMinutes: 0, windowMinutes: 0,
    sectionMinutes: 5, breakMinutes: 0, mandatoryBreak: true,
    questionsPerSection: 2, questionSeconds: 0, sectionGrace: 45, overallGrace: 30,
    questionGrace: 5, usedMinutes: 0, servedCount: 0, leaveClosed: false };
  const asmt = makeAssessment(opts);
  const { attempt } = makeAttempt(asmt, opts, 0, 0);
  const a = C.computeDeadlines(attempt, asmt).sectionEndsAt;
  const b = C.computeDeadlines(JSON.parse(JSON.stringify(attempt)), asmt).sectionEndsAt;
  assert.strictEqual(a, b, 'the same state resolves to the same deadline every time');
  assert.strictEqual(a, T0 + min(5) + 45_000, 'grace is inside the deadline');
});

regression('a missing deadline is unbounded, never expired', () => {
  const asmt = { sections: [{ id: 'S0', questionIds: ['q'] }] };
  const attempt = { status: 'in_progress', startedAt: iso(T0), sectionIds: ['S0'],
    sectionTimings: { S0: { startedAt: iso(T0) } } };
  const v = C.resolve(attempt, asmt, T0 + min(10_000));
  assert.notStrictEqual(v.kind, 'ended',
    'an untimed exam never expires, however long the student takes');
});

regression('an unparseable timestamp does not expire a student', () => {
  const asmt = { overallTimeLimit: 10, sections: [{ id: 'S0', timeLimit: 5, questionIds: ['q'] }] };
  const attempt = { status: 'in_progress', startedAt: 'not-a-date', sectionIds: ['S0'],
    sectionTimings: { S0: { startedAt: 'also-not-a-date' } } };
  const d = C.computeDeadlines(attempt, asmt);
  assert.strictEqual(d.overallEndsAt, null, 'garbage in -> no bound, not epoch 0');
  assert.strictEqual(d.sectionEndsAt, null);
});

regression('INV-3 has no monotonicity rule for the combined lock', () => {
  // 60m section submitted at minute 2, next section 10m: the combined lock
  // legitimately moves EARLIER. A naive test would fail on correct code.
  const asmt = { sections: [
    { id: 'A', timeLimit: 60, questionIds: ['a'] },
    { id: 'B', timeLimit: 10, questionIds: ['b'] }] , sectionGraceSeconds: 30 };
  const inA = { status: 'in_progress', startedAt: iso(T0), sectionIds: ['A', 'B'],
    sectionTimings: { A: { startedAt: iso(T0) } } };
  const inB = { status: 'in_progress', startedAt: iso(T0), sectionIds: ['A', 'B'],
    sectionTimings: { A: { startedAt: iso(T0), submittedAt: iso(T0 + min(2)) },
                      B: { startedAt: iso(T0 + min(2)) } } };
  const dA = C.computeDeadlines(inA, asmt);
  const dB = C.computeDeadlines(inB, asmt);
  assert.ok(dB.sectionEndsAt < dA.sectionEndsAt,
    'the combined bound moving earlier here is CORRECT behaviour');
  assert.strictEqual(C.checkTransition(inA, inB).length, 0,
    'checkTransition must not flag it');
});

regression('INV-6 · nothing leaves a terminal state', () => {
  const before = { status: 'submitted', sectionIds: [], sectionTimings: {} };
  const after = { status: 'in_progress', sectionIds: [], sectionTimings: {} };
  const v = C.checkTransition(before, after);
  assert.ok(v.some((x) => x.id === 'INV-6'), 'must be flagged');
});

regression('INV-4a · credit never decreases', () => {
  const before = { status: 'in_progress', sectionIds: [], sectionTimings: {}, creditedFreezeMs: 600_000 };
  const after = { status: 'in_progress', sectionIds: [], sectionTimings: {}, creditedFreezeMs: 0 };
  assert.ok(C.checkTransition(before, after).some((x) => x.id === 'INV-4a'));
});

regression('INV-8 · a vanished answer is caught', () => {
  const before = { status: 'in_progress', sectionIds: [], sectionTimings: {},
    answers: { q1: 'a', q2: 'b' } };
  const after = { status: 'in_progress', sectionIds: [], sectionTimings: {}, answers: { q1: 'a' } };
  assert.ok(C.checkTransition(before, after).some((x) => x.id === 'INV-8'),
    'the observable form of D-01 must be detected');
});

regression('INV-1 · two open sections are caught', () => {
  const asmt = { sections: [{ id: 'A', questionIds: [] }, { id: 'B', questionIds: [] }] };
  const a = { status: 'in_progress', sectionIds: ['A', 'B'],
    sectionTimings: { A: { startedAt: iso(T0) }, B: { startedAt: iso(T0) } } };
  assert.ok(C.checkInvariants(a, asmt).some((x) => x.id === 'INV-1'));
});

regression('INV-2 · two unlocked served questions are caught', () => {
  const asmt = { sections: [{ id: 'A', questionIds: ['q1', 'q2'] }] };
  const a = { status: 'in_progress', sectionIds: ['A'], sectionTimings: { A: { startedAt: iso(T0) } },
    servedQuestions: [
      { questionId: 'q1', sectionId: 'A', servedAt: iso(T0), locked: false },
      { questionId: 'q2', sectionId: 'A', servedAt: iso(T0), locked: false }] };
  assert.ok(C.checkInvariants(a, asmt).some((x) => x.id === 'INV-2'));
});

regression('INV-10 · an ungraded terminal attempt is caught', () => {
  const asmt = { sections: [{ id: 'A', questionIds: [] }] };
  const a = { status: 'auto_submitted', sectionIds: ['A'], sectionTimings: {} };
  assert.ok(C.checkInvariants(a, asmt).some((x) => x.id === 'INV-10'));
});

regression('D-07 · a forged question cannot hide in the answer set', () => {
  const asmt = { sections: [{ id: 'A', questionIds: ['real'] }] };
  const a = { status: 'in_progress', sectionIds: ['A'], sectionTimings: { A: { startedAt: iso(T0) } },
    answers: { real: 1, PWNED: 1 } };
  assert.ok(C.checkInvariants(a, asmt).some((x) => x.id === 'INV-8'));
});

let regPass = 0;
for (const [name, fn] of regressions) {
  try { fn(); regPass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failures.push({ label: name, ctx: { error: e.message } });
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${e.message}`); }
}
console.log(`  ${regPass}/${regressions.length} regressions pass`);

// ── Result ─────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(70));
if (failures.length === 0) {
  console.log(`\x1b[32m\x1b[1m  PASS\x1b[0m — ${(cases1 + cases2).toLocaleString()} states, ` +
    `${checks.toLocaleString()} property assertions, ${regressions.length} regressions. Zero defects.`);
  process.exit(0);
} else {
  console.log(`\x1b[31m\x1b[1m  ${failures.length} FAILURE(S)\x1b[0m`);
  for (const f of failures.slice(0, 25)) {
    console.log(`   • ${f.label}\n     ${JSON.stringify(f.ctx)}`);
  }
  if (failures.length > 25) console.log(`   … and ${failures.length - 25} more`);
  process.exit(1);
}
