// ═══════════════════════════════════════════════════════════════════════════
// JUDGE0 ADAPTER SUITE — Stage B1  (2026-08-08)
//
// The adapter is the one place that knows Judge0 exists, and almost everything
// that can go wrong with it is a mapping or a failure-handling decision rather
// than anything needing a sandbox. So the mapping is pure and the transport is
// injected, and this suite proves both without a Judge0 to point at.
//
// The properties that matter most here:
//   • Exam Forge decides correctness, not Judge0 — a submission whose bytes
//     satisfy the question's comparison mode passes even when Judge0 called it
//     a wrong answer.
//   • Judge0 failing is never the candidate's zero, at every layer: HTTP,
//     malformed response, deadline, internal error, open breaker.
//   • run() never throws.
//
//   npm run test:judge0
// ═══════════════════════════════════════════════════════════════════════════

const A = require('../lib/judge0Adapter.js');
const J = require('../lib/judgeCore.js');

const results = [];
const SCENARIOS = [];
let current = null;
function scenario(id, title, fn) { SCENARIOS.push({ id, title, fn }); }
function check(pass, label, detail) {
  current.checks.push({ pass: !!pass, label, detail: detail === undefined ? null : String(detail) });
}
function eq(actual, expected, label) {
  check(actual === expected, label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── Fixtures ──────────────────────────────────────────────────────

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

const test = (id, expected, o = {}) => ({ id, stdin: '', expected, visible: false, ...o });
// `limits` is resolved LAST so a scenario's raw (unclamped) input cannot
// spread back over the clamped value — clamping is what K-04 is asserting.
const submission = (tests, o = {}) => ({
  language: 'python3', source: 'print(1)', ...o, tests, limits: J.clampLimits(o.limits),
});
const ok = (stdout, o = {}) => ({
  status: { id: A.J0.ACCEPTED, description: 'Accepted' },
  stdout: b64(stdout), time: '0.05', memory: 3200, ...o,
});

/** A transport whose every response the scenario controls. */
function fakeTransport(script) {
  return {
    calls: [],
    async post(path, body, t) { this.calls.push(['POST', path]); return script.post(body, this.calls.length); },
    async get(path, t) { this.calls.push(['GET', path]); return script.get(this.calls.length); },
  };
}
const created = (n) => ({ status: 201, json: Array.from({ length: n }, (_, i) => ({ token: `tok${i}` })) });
const batch = (subs) => ({ status: 200, json: { submissions: subs } });

// ══════════════════════════════════════════════════════════════════
// §1 — LANGUAGE TABLE
// ══════════════════════════════════════════════════════════════════

scenario('K-01', 'every platform language maps to a pinned Judge0 id', () => {
  J.JUDGE_LANGUAGES.forEach((lang) => {
    check(typeof A.JUDGE0_LANGUAGE_IDS[lang] === 'number',
      `${lang} has an id`, A.JUDGE0_LANGUAGE_IDS[lang]);
  });
  check(A.JUDGE0_IMAGE.includes(':'), 'the image is version-pinned, not :latest', A.JUDGE0_IMAGE);
  check(!A.JUDGE0_IMAGE.endsWith(':latest'), 'and explicitly not :latest — ids move between releases');
});

scenario('K-02', 'a renumbered language table is detected, not silently used', () => {
  const live = J.JUDGE_LANGUAGES.map((l) => ({
    id: A.JUDGE0_LANGUAGE_IDS[l], name: A.JUDGE0_LANGUAGE_NAMES[l] + ' (x)',
  }));
  eq(A.verifyLanguageTable(live).length, 0, 'a matching instance reports no mismatches');

  // The upgrade that renumbers Python onto Ruby's id is the whole risk: every
  // Python submission would run as Ruby and fail as though the candidate erred.
  const renumbered = live.map((l) =>
    l.id === A.JUDGE0_LANGUAGE_IDS.python3 ? { id: l.id, name: 'Ruby (3.0)' } : l);
  const bad = A.verifyLanguageTable(renumbered);
  eq(bad.length, 1, 'a renumbered id is caught');
  eq(bad[0].language, 'python3', 'and named');

  eq(A.verifyLanguageTable([]).length, J.JUDGE_LANGUAGES.length,
    'an instance missing every language reports every language');
});

// ══════════════════════════════════════════════════════════════════
// §2 — REQUEST BUILDING
// ══════════════════════════════════════════════════════════════════

scenario('K-03', 'a submission is base64 and cannot reach the network', () => {
  const sub = submission([test('t1', '5')], { source: 'print(5)  # trailing  ' });
  const p = A.buildJudge0Submission(sub, { id: 't1', stdin: 'in\n', expected: '5', visible: false });

  eq(Buffer.from(p.source_code, 'base64').toString('utf8'), 'print(5)  # trailing  ',
    'source round-trips exactly, trailing spaces intact');
  eq(Buffer.from(p.stdin, 'base64').toString('utf8'), 'in\n', 'stdin likewise keeps its newline');
  eq(p.enable_network, false, 'THE POINT — a candidate program has no network');
  eq(p.redirect_stderr_to_stdout, false,
    'and diagnostics never contaminate the output being compared');
  eq(p.language_id, A.JUDGE0_LANGUAGE_IDS.python3, 'the pinned id is sent');
});

scenario('K-04', 'limits reach Judge0 in its units, already clamped', () => {
  const sub = submission([test('t1', '1')], { limits: { cpuMs: 600_000, memoryKb: 99_999_999 } });
  const p = A.buildJudge0Submission(sub, sub.tests[0]);
  eq(p.cpu_time_limit, J.MAX_LIMITS.cpuMs / 1000, 'CPU is seconds, and clamped to the ceiling');
  eq(p.memory_limit, J.MAX_LIMITS.memoryKb, 'memory is KB, and clamped');
  check(p.wall_time_limit >= p.cpu_time_limit, 'wall still exceeds CPU');
  check(p.cpu_extra_time <= 1, 'the grace window is small — it absorbs startup, not the limit');
});

// ══════════════════════════════════════════════════════════════════
// §3 — VERDICT ASSEMBLY
// ══════════════════════════════════════════════════════════════════

scenario('K-05', 'EXAM FORGE decides correctness, not Judge0', () => {
  // Judge0 says WRONG ANSWER; the bytes satisfy the question's trimmed
  // comparison. If we deferred to Judge0's status, this correct program fails
  // over a trailing newline.
  const sub = submission([test('t1', '42')]);
  const v = A.verdictFromResults(sub, [{
    status: { id: A.J0.WRONG_ANSWER, description: 'Wrong Answer' },
    stdout: b64('42\n'),
  }], 'judge0');
  eq(v.results[0].status, 'passed', 'a trailing newline does not fail a correct program');

  // And a numeric question keeps its tolerance, which Judge0 cannot express.
  const numeric = submission([test('t1', '0.1', { comparison: 'numeric', tolerance: 1e-6 })]);
  const nv = A.verdictFromResults(numeric, [{
    status: { id: A.J0.WRONG_ANSWER }, stdout: b64('0.1000000001'),
  }], 'judge0');
  eq(nv.results[0].status, 'passed', 'floating-point drift within tolerance passes');

  // Genuinely wrong output still fails.
  const wrong = A.verdictFromResults(sub, [{
    status: { id: A.J0.ACCEPTED }, stdout: b64('43'),
  }], 'judge0');
  eq(wrong.results[0].status, 'wrong_answer', 'and a wrong value still fails');
});

scenario('K-06', 'a compile error is one submission-level fact', () => {
  const sub = submission([test('t1', '1'), test('t2', '2'), test('t3', '3')]);
  const v = A.verdictFromResults(sub, [
    { status: { id: A.J0.COMPILATION_ERROR }, compile_output: b64('line 1: syntax error') },
    { status: { id: A.J0.COMPILATION_ERROR } },
    { status: { id: A.J0.COMPILATION_ERROR } },
  ], 'judge0');

  eq(v.status, 'compile_error', 'the verdict is compile_error, not three runtime errors');
  eq(v.results.length, 0, 'with no per-test results — nothing ran');
  check(v.compileMessage.includes('syntax error'), 'and the diagnostics are kept', v.compileMessage);
  check(J.isRealVerdict(v), 'it IS a real verdict — scored zero, penalty-eligible');
  const o = J.outcomeFor(v, sub.tests);
  eq(o.multiplier, 0, 'a program that never built passes nothing');
  eq(o.anyCorrect, false, 'and got nothing right');
});

scenario('K-07', 'Judge0 failing internally discards the whole verdict', () => {
  const sub = submission([test('t1', '1'), test('t2', '2')]);
  const v = A.verdictFromResults(sub, [
    { status: { id: A.J0.ACCEPTED }, stdout: b64('1') },        // this one worked
    { status: { id: A.J0.INTERNAL_ERROR, description: 'Internal Error' } },
  ], 'judge0');

  eq(v.status, 'judge_unavailable',
    'a partial run is NOT scored — 1 of 2 would be a mark out of an outage');
  check(!J.isRealVerdict(v), 'so it is not a real verdict');
  eq(J.outcomeFor(v, sub.tests), null, 'and yields no outcome at all');
});

scenario('K-08', 'runtime failures are the candidate\'s, and are per-test', () => {
  const sub = submission([test('t1', '1'), test('t2', '2'), test('t3', '3')]);
  const v = A.verdictFromResults(sub, [
    ok('1'),
    { status: { id: A.J0.TIME_LIMIT_EXCEEDED } },
    { status: { id: A.J0.RUNTIME_ERROR_SIGSEGV }, stderr: b64('Segmentation fault') },
  ], 'judge0');

  eq(v.status, 'completed', 'the run completed — these are program failures');
  eq(v.results[0].status, 'passed', 'the good test passes');
  eq(v.results[1].status, 'timeout', 'the slow one times out');
  eq(v.results[2].status, 'runtime_error', 'the crashing one is a runtime error');
  eq(v.results[2].stderr, 'Segmentation fault', 'with its diagnostics decoded');
  eq(v.results[0].timeMs, 50, 'timings are converted from seconds to ms');
  eq(v.results[0].memoryKb, 3200, 'and memory carried through');

  const o = J.outcomeFor(v, sub.tests);
  check(Math.abs(o.multiplier - 1 / 3) < 1e-9, 'one of three tests is a third of the marks');
  eq(o.anyCorrect, true, 'and partial credit is never penalty-eligible');
});

scenario('K-09', 'fewer results than tests scores against the suite', () => {
  const sub = submission([test('t1', '1'), test('t2', '2'), test('t3', '3')]);
  const v = A.verdictFromResults(sub, [ok('1'), ok('2')], 'judge0');
  eq(v.results.length, 2, 'only the reported tests appear');
  const o = J.outcomeFor(v, sub.tests);
  check(Math.abs(o.multiplier - 2 / 3) < 1e-9,
    'but the mark is 2 of 3, never 2 of 2 — a short run is not a smaller exam');
});

// ══════════════════════════════════════════════════════════════════
// §4 — THE ADAPTER
// ══════════════════════════════════════════════════════════════════

scenario('K-10', 'the happy path — batch create, poll, verdict', async () => {
  let polls = 0;
  const t = fakeTransport({
    post: () => created(2),
    get: () => {
      polls++;
      // Still running on the first poll; terminal on the second.
      return polls === 1
        ? batch([{ status: { id: A.J0.PROCESSING } }, { status: { id: A.J0.IN_QUEUE } }])
        : batch([ok('1'), ok('2')]);
    },
  });
  const adapter = new A.Judge0Adapter({ baseUrl: 'http://judge0.internal' }, t);
  const sub = submission([test('t1', '1'), test('t2', '2')]);
  const v = await adapter.run(sub);

  eq(v.status, 'completed', 'a completed verdict');
  eq(v.adapter, 'judge0', 'attributed to the adapter that produced it');
  eq(v.results.length, 2, 'with a result per test');
  check(polls >= 2, 'and it polled until the submissions were terminal', `${polls} polls`);
  check(t.calls[0][1].includes('base64_encoded=true'), 'created in base64 mode');
  check(!t.calls[0][1].includes('wait=true'),
    'and asynchronously — wait=true holds a web worker for the whole run');
});

scenario('K-11', 'every provider failure becomes a verdict, never an exception', async () => {
  const cases = [
    ['HTTP 500 on create', { post: () => ({ status: 500, json: null }), get: () => batch([]) }],
    ['a thrown network error', { post: () => { throw new Error('ECONNREFUSED'); }, get: () => batch([]) }],
    ['a malformed create response', { post: () => ({ status: 201, json: { nope: true } }), get: () => batch([]) }],
    ['fewer tokens than tests', { post: () => created(1), get: () => batch([]) }],
  ];
  for (const [label, script] of cases) {
    const adapter = new A.Judge0Adapter({ baseUrl: 'http://x' }, fakeTransport(script));
    let threw = null;
    let v = null;
    try { v = await adapter.run(submission([test('t1', '1'), test('t2', '2')])); }
    catch (e) { threw = e; }
    eq(threw, null, `${label}: run() did not throw`);
    eq(v.status, 'judge_unavailable', `${label}: it became an unavailable verdict`);
    eq(J.outcomeFor(v, [test('t1', '1')]), null, `${label}: and awards nothing`);
  }
});

scenario('K-12', 'a run that never finishes gives up rather than hanging', async () => {
  const t = fakeTransport({
    post: () => created(1),
    get: () => batch([{ status: { id: A.J0.PROCESSING } }]),   // never terminal
  });
  const adapter = new A.Judge0Adapter({ baseUrl: 'http://x', maxRunMs: 900 }, t);
  const started = Date.now();
  const v = await adapter.run(submission([test('t1', '1')]));
  const took = Date.now() - started;

  eq(v.status, 'judge_unavailable', 'the deadline produces an unavailable verdict');
  check(took < 8000, 'and it returns promptly rather than hanging the sweep', `${took}ms`);
});

scenario('K-13', 'the breaker opens, fails fast, and stops hammering a dead judge', async () => {
  const t = fakeTransport({ post: () => ({ status: 503, json: null }), get: () => batch([]) });
  const adapter = new A.Judge0Adapter(
    { baseUrl: 'http://x', breakerThreshold: 3, breakerResetMs: 60_000 }, t);
  const sub = submission([test('t1', '1')]);

  for (let i = 0; i < 3; i++) await adapter.run(sub);
  const callsBefore = t.calls.length;

  const v = await adapter.run(sub);
  eq(v.status, 'judge_unavailable', 'the next call still returns a verdict');
  check(v.failureReason.includes('breaker'), 'attributed to the breaker', v.failureReason);
  eq(t.calls.length, callsBefore, 'and made NO request — a judge known to be down is not retried');
});

scenario('K-14', 'a submission with no tests is refused before any request', async () => {
  const t = fakeTransport({ post: () => created(0), get: () => batch([]) });
  const adapter = new A.Judge0Adapter({ baseUrl: 'http://x' }, t);
  const v = await adapter.run(submission([]));
  eq(v.status, 'judge_unavailable', 'it is unavailable rather than a vacuous pass');
  eq(t.calls.length, 0, 'and no judge slot was spent on it');
});

scenario('K-15', 'health reflects the instance, and never throws', async () => {
  const up = new A.Judge0Adapter({ baseUrl: 'http://x' },
    fakeTransport({ post: () => created(1), get: () => ({ status: 200, json: {} }) }));
  eq(await up.health(), true, 'a reachable instance is healthy');

  const down = new A.Judge0Adapter({ baseUrl: 'http://x' },
    fakeTransport({ post: () => created(1), get: () => { throw new Error('ECONNREFUSED'); } }));
  eq(await down.health(), false, 'an unreachable one is not, and does not throw');
});

// ── Report ────────────────────────────────────────────────────────

(async () => {
  for (const s of SCENARIOS) {
    current = { id: s.id, title: s.title, checks: [], error: null };
    try { await s.fn(); } catch (e) { current.error = e; }
    results.push(current);
  }

  const C = { r: '\x1b[31m', g: '\x1b[32m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
  let pass = 0, fail = 0;
  console.log(`\n${C.b}JUDGE0 ADAPTER SUITE — Stage B1${C.x}\n`);
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
