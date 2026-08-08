// ═══════════════════════════════════════════════════════════════════════════
// JUDGE CORE SUITE — Stage B1, the judge interface  (2026-08-07)
//
// judgeCore.ts holds every decision about a coding mark that can be made
// WITHOUT a sandbox: how output is compared, how tests are weighted, what a
// verdict is worth, and — the part that matters most — the difference between
// a candidate's program failing and the judge failing.
//
// That last one is why this suite exists ahead of any real adapter. A judge
// outage during an exam that silently marked a cohort zero would produce
// perfectly well-formed numbers all the way to the transcript, so the property
// "the platform's failure is never the candidate's mark" has to be asserted
// rather than assumed.
//
//   npm run test:judge
// ═══════════════════════════════════════════════════════════════════════════

const J = require('../lib/judgeCore.js');

const results = [];
const SCENARIOS = [];
let current = null;
// Registered rather than run inline so an async scenario is actually awaited.
// A scenario whose promise is dropped reports PASS with zero checks, which is
// the one way a suite like this can lie about its own coverage.
function scenario(id, title, fn) {
  SCENARIOS.push({ id, title, fn });
}
function check(pass, label, detail) {
  current.checks.push({ pass: !!pass, label, detail: detail === undefined ? null : String(detail) });
}
function eq(actual, expected, label) {
  check(actual === expected, label, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function close(actual, expected, label, eps = 1e-12) {
  check(Math.abs(actual - expected) <= eps, label, `expected ≈${expected}, got ${actual}`);
}

// ── Fixtures ──────────────────────────────────────────────────────

const hidden = (id, expected, weight) => ({
  id, stdin: '', expected, visible: false, ...(weight === undefined ? {} : { weight }),
});
const sample = (id, expected, weight) => ({
  id, stdin: '', expected, visible: true, ...(weight === undefined ? {} : { weight }),
});

const verdict = (status, results_, extra = {}) => ({
  status,
  results: results_,
  adapter: 'test',
  judgedAt: '2026-08-07T00:00:00.000Z',
  ...extra,
});
const passing = (id) => ({ testId: id, status: 'passed' });
const failing = (id, status = 'wrong_answer') => ({ testId: id, status });

// ══════════════════════════════════════════════════════════════════
// §1 — OUTPUT COMPARISON
// ══════════════════════════════════════════════════════════════════

scenario('J-01', 'trimmed comparison forgives the artefacts, not the answer', () => {
  const c = (a, b) => J.compareOutput(a, b, 'trimmed');
  check(c('42\n', '42'), 'trailing newline is not a wrong answer');
  check(c('42', '42\n'), 'missing trailing newline is not a wrong answer');
  check(c('42   \n', '42\n'), 'trailing spaces on a line are ignored');
  check(c('42\r\n', '42\n'), 'CRLF matches LF');
  check(c('a\nb\n\n\n', 'a\nb'), 'trailing blank lines are ignored');
  check(!c('42', '43'), 'a different value still fails');
  check(!c('  42', '42'), 'LEADING whitespace is significant — it is output, not an artefact');
  check(!c('a\nb', 'b\na'), 'line order is significant');
});

scenario('J-02', 'exact comparison normalises line endings and nothing else', () => {
  const c = (a, b) => J.compareOutput(a, b, 'exact');
  check(c('42\r\n', '42\n'), 'CRLF is a transport artefact even in exact mode');
  check(!c('42\n', '42'), 'exact mode does not forgive a trailing newline');
  check(!c('42 ', '42'), 'exact mode does not forgive trailing space');
});

scenario('J-03', 'token comparison ignores layout but not content', () => {
  const c = (a, b) => J.compareOutput(a, b, 'tokens');
  check(c('1 2 3', '1\n2\n3\n'), 'newlines and spaces are interchangeable');
  check(c('  1   2  ', '1 2'), 'runs of whitespace collapse');
  check(!c('1 2', '1 2 3'), 'a missing token fails');
  check(!c('1 2 3', '1 2'), 'an extra token fails');
  check(!c('12', '1 2'), 'token boundaries are significant');
});

scenario('J-04', 'numeric comparison tolerates drift, not wrong answers', () => {
  const c = (a, b, tol) => J.compareOutput(a, b, 'numeric', tol);
  check(c('0.1000000001', '0.1', 1e-6), 'small absolute drift passes');
  check(c('1e12', '1000000000001', 1e-9), 'relative tolerance handles large magnitudes');
  check(!c('0.11', '0.1', 1e-6), 'drift beyond tolerance fails');
  check(c('3.0', '3', 1e-9), 'formatting differences between equal numbers pass');
  check(c('yes 1.0', 'yes 1', 1e-9), 'non-numeric tokens compare as strings alongside numbers');
  check(!c('no 1.0', 'yes 1', 1e-9), 'a wrong word fails even when the numbers match');
  check(!c('0x10', '16', 1e-9), 'hex is not silently parsed into a matching number');
  check(!c('1,000', '1000', 1e-9), 'a thousands separator is not silently accepted');
  check(!c('', '0', 1e-9), 'empty output does not match zero');
});

scenario('J-05', 'testPasses applies the test\'s own settings, defaulting to trimmed', () => {
  eq(J.testPasses({ id: 't', stdin: '', expected: '5\n', visible: false }, '5'), true,
    'a test with no comparison set uses trimmed');
  eq(J.testPasses({ id: 't', stdin: '', expected: '5\n', visible: false, comparison: 'exact' }, '5'), false,
    'a test opting into exact gets exact');
  eq(J.testPasses({ id: 't', stdin: '', expected: '0.5', visible: false, comparison: 'numeric', tolerance: 0.01 }, '0.504'), true,
    'a test carries its own tolerance');
});

// ══════════════════════════════════════════════════════════════════
// §2 — LIMITS
// ══════════════════════════════════════════════════════════════════

scenario('J-06', 'limits are clamped to the ceiling an author cannot exceed', () => {
  const l = J.clampLimits({ cpuMs: 600_000, memoryKb: 99_999_999, processes: 100_000 });
  eq(l.cpuMs, J.MAX_LIMITS.cpuMs, 'a ten-minute CPU budget is clamped to the ceiling');
  eq(l.memoryKb, J.MAX_LIMITS.memoryKb, 'memory is clamped');
  eq(l.processes, J.MAX_LIMITS.processes, 'process count is clamped');
});

scenario('J-07', 'partial and malformed limits resolve to a complete set', () => {
  const l = J.clampLimits({ cpuMs: 3000 });
  eq(l.cpuMs, 3000, 'a stated value survives');
  eq(l.memoryKb, J.DEFAULT_LIMITS.memoryKb, 'an unstated value takes the default');
  const bad = J.clampLimits({ cpuMs: NaN, memoryKb: -5 });
  eq(bad.cpuMs, J.DEFAULT_LIMITS.cpuMs, 'NaN falls back to the default rather than propagating');
  check(bad.memoryKb > 0, 'a negative limit cannot reach the sandbox');
  const none = J.clampLimits();
  eq(none.cpuMs, J.DEFAULT_LIMITS.cpuMs, 'no argument at all yields the defaults');
});

scenario('J-08', 'wall time can never sit below CPU time', () => {
  const l = J.clampLimits({ cpuMs: 5000, wallMs: 1000 });
  check(l.wallMs >= l.cpuMs, 'an impossible combination is repaired, not passed through',
    `cpu ${l.cpuMs}, wall ${l.wallMs}`);
  eq(l.cpuMs, 5000, 'the author\'s CPU intent is preserved while repairing wall');
});

// ══════════════════════════════════════════════════════════════════
// §3 — WEIGHTS
// ══════════════════════════════════════════════════════════════════

scenario('J-09', 'visible tests are worth nothing unless an author says otherwise', () => {
  eq(J.weightOf(sample('s1', '1')), 0, 'a sample test defaults to zero weight');
  eq(J.weightOf(hidden('h1', '1')), 1, 'a hidden test defaults to weight 1');
  eq(J.weightOf(sample('s2', '1', 2)), 2, 'an author can weight a sample explicitly');
  eq(J.weightOf(hidden('h2', '1', 0)), 0, 'an author can zero a hidden test');
});

scenario('J-10', 'a suite with no weight is not gradable', () => {
  eq(J.suiteIsGradable([sample('s1', '1'), sample('s2', '2')]), false,
    'samples only, at default weight, cannot produce a mark');
  eq(J.suiteIsGradable([]), false, 'an empty suite is not gradable');
  eq(J.suiteIsGradable([hidden('h1', '1')]), true, 'one hidden test is enough');
  eq(J.suiteIsGradable([sample('s1', '1', 1)]), true, 'a weighted sample is enough');
});

// ══════════════════════════════════════════════════════════════════
// §4 — AGGREGATION
// ══════════════════════════════════════════════════════════════════

scenario('J-11', 'a missing result is a failure, not a smaller denominator', () => {
  const tests = [hidden('h1', '1'), hidden('h2', '2'), hidden('h3', '3')];
  // The adapter returned results for two of three tests.
  const s = J.summarise(verdict('completed', [passing('h1'), passing('h2')]), tests);
  eq(s.total, 3, 'the denominator is the suite, not the results returned');
  eq(s.weightedTotal, 3, 'weighted denominator likewise');
  eq(s.passed, 2, 'only reported passes count');
  close(s.rate, 2 / 3, 'an incomplete run scores 2/3, never 2/2');
});

scenario('J-12', 'weights, not counts, drive the rate', () => {
  const tests = [sample('s1', '1'), hidden('h1', '1', 3), hidden('h2', '2', 1)];
  const s = J.summarise(verdict('completed', [passing('s1'), passing('h1'), failing('h2')]), tests);
  eq(s.weightedTotal, 4, 'the zero-weight sample adds nothing to the denominator');
  eq(s.weightedPassed, 3, 'the passing sample adds nothing to the numerator either');
  close(s.rate, 0.75, 'the rate reflects weight');
  eq(s.passed, 2, 'the plain count still reports both passes for display');
});

// ══════════════════════════════════════════════════════════════════
// §5 — THE GRADING BRIDGE  (the reason this module exists)
// ══════════════════════════════════════════════════════════════════

scenario('J-13', 'partial credit is proportional and never penalty-eligible', () => {
  const tests = Array.from({ length: 10 }, (_, i) => hidden(`h${i}`, String(i)));
  const res = tests.map((t, i) => (i < 7 ? passing(t.id) : failing(t.id)));
  const o = J.outcomeFor(verdict('completed', res), tests);
  close(o.multiplier, 0.7, '7 of 10 hidden tests is a multiplier of 0.7');
  eq(o.isCorrect, false, '7 of 10 is not a correct answer');
  eq(o.anyCorrect, true, 'anyCorrect is true, so awardFor can never reach the penalty branch');
});

scenario('J-14', 'a full pass is correct; a total failure is a penalty-eligible zero', () => {
  const tests = [hidden('h1', '1'), hidden('h2', '2')];
  const all = J.outcomeFor(verdict('completed', [passing('h1'), passing('h2')]), tests);
  eq(all.multiplier, 1, 'every test passing is a full multiplier');
  eq(all.isCorrect, true, 'and a correct answer');

  const none = J.outcomeFor(verdict('completed', [failing('h1'), failing('h2')]), tests);
  eq(none.multiplier, 0, 'no test passing is a zero');
  eq(none.anyCorrect, false, 'and anyCorrect is false — the only state a penalty may apply to');
});

scenario('J-15', 'a compile error is a real verdict, not an outage', () => {
  const tests = [hidden('h1', '1')];
  const v = verdict('compile_error', [], { compileMessage: "error: expected ';'" });
  check(J.isRealVerdict(v), 'a compile error is a statement about the candidate\'s code');
  const o = J.outcomeFor(v, tests);
  check(o !== null, 'so it produces an outcome rather than deferring to a human');
  eq(o.multiplier, 0, 'a program that never built passes nothing');
  eq(o.anyCorrect, false, 'and is penalty-eligible, exactly as the settled policy specifies');
});

scenario('J-16', 'THE RULE — a judge failure is never a candidate\'s zero', () => {
  const tests = [hidden('h1', '1'), hidden('h2', '2')];

  const down = J.unavailableVerdict('judge0', 'connect ETIMEDOUT');
  eq(down.status, 'judge_unavailable', 'an unreachable judge produces the unavailable status');
  check(!J.isRealVerdict(down), 'which is not a real verdict');
  eq(J.outcomeFor(down, tests), null, 'and yields NO outcome — the paper goes to manual review');

  const broke = verdict('internal_error', [], { failureReason: 'adapter returned malformed JSON' });
  eq(J.outcomeFor(broke, tests), null, 'an adapter malfunction likewise records no mark');

  // The failure mode this guards against: an outage arriving as a well-formed zero.
  const s = J.summarise(down, tests);
  eq(s.rate, 0, 'summarise alone WOULD report 0 — which is why outcomeFor, not summarise, decides');
});

scenario('J-17', 'an ungradable suite defers rather than inventing a mark', () => {
  const samplesOnly = [sample('s1', '1'), sample('s2', '2')];
  const v = verdict('completed', [passing('s1'), passing('s2')]);
  eq(J.outcomeFor(v, samplesOnly), null,
    'a suite carrying no weight produces no outcome instead of 0/0');
  eq(J.outcomeFor(verdict('completed', []), []), null, 'an empty suite likewise');
});

// ══════════════════════════════════════════════════════════════════
// §6 — REDACTION
// ══════════════════════════════════════════════════════════════════

scenario('J-18', 'hidden tests leave no trace in a candidate-facing verdict', () => {
  const tests = [sample('s1', '1'), hidden('h1', 'SECRET'), hidden('h2', 'ALSO SECRET')];
  const v = verdict('completed', [
    { testId: 's1', status: 'passed', stdout: '1' },
    { testId: 'h1', status: 'wrong_answer', stdout: 'SECRET', stderr: 'trace' },
    { testId: 'h2', status: 'passed', stdout: 'ALSO SECRET' },
  ], { failureReason: 'internal detail' });

  const c = J.redactForCandidate(v, tests);
  eq(c.results.length, 1, 'only the visible test survives');
  eq(c.results[0].testId, 's1', 'and it is the right one');
  eq(c.hiddenCount, 2, 'the candidate learns how many hidden tests exist');
  eq(c.failureReason, undefined, 'operator detail is not shipped to a browser');

  const blob = JSON.stringify(c);
  check(!blob.includes('SECRET'), 'no hidden expected output appears anywhere in the payload');
  check(!blob.includes('h1') && !blob.includes('h2'), 'not even the hidden test ids leak');
  check(!blob.includes('internal detail'), 'nor the failure reason');
});

scenario('J-19', 'per-test hidden statuses are withheld, closing the bisection oracle', () => {
  const tests = [hidden('h1', '1'), hidden('h2', '2'), hidden('h3', '3')];
  const c = J.redactForCandidate(
    verdict('completed', [passing('h1'), failing('h2'), passing('h3')]),
    tests,
  );
  eq(c.results.length, 0, 'a candidate is told nothing about WHICH hidden test failed');
  eq(c.hiddenCount, 3, 'only the count');
});

scenario('J-20', 'an adapter cannot smuggle output through an unknown test id', () => {
  const tests = [sample('s1', '1')];
  const c = J.redactForCandidate(
    verdict('completed', [passing('s1'), { testId: 'ghost', status: 'passed', stdout: 'LEAK' }]),
    tests,
  );
  eq(c.results.length, 1, 'a result for a test the suite does not contain is dropped');
  check(!JSON.stringify(c).includes('LEAK'), 'its output does not reach the candidate');
});

scenario('J-21', 'a sample run never sends hidden tests to the judge at all', () => {
  const full = {
    language: 'python3',
    source: 'print(1)',
    tests: [sample('s1', '1'), hidden('h1', 'SECRET'), hidden('h2', 'SECRET2')],
    limits: J.clampLimits(),
  };
  const run = J.sampleRunSubmission(full);
  eq(run.tests.length, 1, 'only visible tests are submitted');
  check(!JSON.stringify(run).includes('SECRET'),
    'the answer key never reaches the provider — not merely the response');
  eq(full.tests.length, 3, 'the original submission is not mutated');
  eq(run.source, full.source, 'everything else is carried through');
});

// ══════════════════════════════════════════════════════════════════
// §7b — DISPATCH POLICY
// ══════════════════════════════════════════════════════════════════

const NOW = Date.parse('2026-08-08T12:00:00.000Z');

scenario('J-23', 'a settled submission is never judged twice', () => {
  eq(J.shouldJudgeNow({ attempts: 1, lastStatus: 'completed' }, NOW), false,
    'a completed verdict is final');
  eq(J.shouldJudgeNow({ attempts: 1, lastStatus: 'compile_error' }, NOW), false,
    'so is a compile error — re-running could overwrite a mark already shown');
  eq(J.shouldJudgeNow(undefined, NOW), true, 'a submission never attempted is judged');
});

scenario('J-24', 'a failed submission retries, then stops', () => {
  eq(J.shouldJudgeNow({ attempts: 1, lastStatus: 'judge_unavailable' }, NOW), true,
    'an outage is retried once the backoff has passed');
  eq(J.shouldJudgeNow({ attempts: J.MAX_JUDGE_ATTEMPTS, lastStatus: 'judge_unavailable' }, NOW), false,
    'the retry budget is finite — "judge is down" and "this program kills the judge" look alike');
  eq(J.isExhausted({ attempts: J.MAX_JUDGE_ATTEMPTS, lastStatus: 'judge_unavailable' }), true,
    'and exhaustion is reportable, so a human sees an unresolved paper');
  eq(J.isExhausted({ attempts: 9, lastStatus: 'completed' }), false,
    'a settled submission is never "exhausted", whatever it cost to get there');
});

scenario('J-25', 'backoff escalates rather than hammering a struggling judge', () => {
  const a = J.nextBackoffMs(1), b = J.nextBackoffMs(2), c = J.nextBackoffMs(3);
  check(a < b && b < c, 'each retry waits longer than the last', `${a}, ${b}, ${c}`);
  check(J.nextBackoffMs(99) === J.nextBackoffMs(4), 'and the wait is capped, not unbounded');
  eq(J.shouldJudgeNow({ attempts: 1, lastStatus: 'judge_unavailable',
    nextAttemptAt: new Date(NOW + 60_000).toISOString() }, NOW), false,
    'a submission still inside its backoff window is skipped');
});

scenario('J-26', 'a claim is a lease, not a lock', () => {
  const fresh = new Date(NOW - 1000).toISOString();
  eq(J.shouldJudgeNow({ attempts: 0, claimedAt: fresh }, NOW), false,
    'a live worker keeps its claim, so overlapping sweeps do not double-judge');
  const dead = new Date(NOW - J.JUDGE_CLAIM_LEASE_MS - 1).toISOString();
  eq(J.shouldJudgeNow({ attempts: 0, claimedAt: dead }, NOW), true,
    'but a worker that died holding one cannot strand the submission forever');
  eq(J.claimIsStale({ attempts: 0, claimedAt: 'not a date' }, NOW), true,
    'an unparseable claim is treated as stale rather than trusted');
});

scenario('J-27', 'advanceState records what happened and what happens next', () => {
  const done = J.advanceState({ attempts: 1 }, verdict('completed', []), NOW);
  eq(done.attempts, 2, 'the attempt is counted');
  eq(done.lastStatus, 'completed', 'and the outcome recorded');
  eq(done.nextAttemptAt, undefined, 'a settled submission carries no backoff');
  eq(done.claimedAt, undefined, 'and no claim — it must not look busy');

  const failed = J.advanceState({ attempts: 0 }, J.unavailableVerdict('judge0', 'down'), NOW);
  check(failed.nextAttemptAt !== undefined, 'a failed one schedules its retry');
  eq(J.shouldJudgeNow(failed, NOW), false, 'and is not eligible again immediately');
  check(J.shouldJudgeNow(failed, NOW + J.nextBackoffMs(1)), 'but is once the wait elapses');

  const last = J.advanceState({ attempts: J.MAX_JUDGE_ATTEMPTS - 1 },
    J.unavailableVerdict('judge0', 'down'), NOW);
  eq(last.nextAttemptAt, undefined, 'the final failure schedules nothing further');
  eq(J.isExhausted(last), true, 'and reports as exhausted');
});

// ══════════════════════════════════════════════════════════════════
// §7c — IN-EXAM SAMPLE RUNS
// ══════════════════════════════════════════════════════════════════

scenario('J-28', 'run settings resolve and clamp', () => {
  const d = J.resolveSampleRunConfig();
  eq(d.enabled, true, 'runs are on by default — writing code blind is a test of nerve');
  eq(d.maxPerQuestion, J.DEFAULT_SAMPLE_RUN_CONFIG.maxPerQuestion, 'with the default quota');

  eq(J.resolveSampleRunConfig({ enabled: false }).enabled, false,
    'an institution can switch them off entirely');
  eq(J.resolveSampleRunConfig({ maxPerQuestion: 99999 }).maxPerQuestion, 200,
    'an absurd quota is clamped');
  eq(J.resolveSampleRunConfig({ cooldownMs: -5 }).cooldownMs, 0, 'a negative cooldown floors at zero');
  eq(J.resolveSampleRunConfig({ maxSourceBytes: 1 }).maxSourceBytes, 1024,
    'and the source cap cannot be set so low that nothing runs');
});

scenario('J-29', 'a run is bounded on two independent axes', () => {
  const cfg = J.resolveSampleRunConfig({ maxPerQuestion: 3, cooldownMs: 5000 });

  const fresh = J.checkSampleRun(undefined, cfg, NOW);
  eq(fresh.allowed, true, 'the first run is allowed');
  eq(fresh.remaining, 3, 'and the budget is reported');

  const spent = J.checkSampleRun({ count: 3 }, cfg, NOW);
  eq(spent.allowed, false, 'the quota bounds the TOTAL');
  eq(spent.reason, 'quota_exhausted', 'and says so');

  const hot = J.checkSampleRun({ count: 1, lastRunAt: new Date(NOW - 1000).toISOString() }, cfg, NOW);
  eq(hot.allowed, false, 'the cooldown bounds the RATE, independently of the total');
  eq(hot.reason, 'cooling_down', 'and says so');
  eq(hot.retryAfterMs, 4000, 'with the wait remaining');
  eq(hot.remaining, 2, 'and the budget is reported even while refusing');

  const cooled = J.checkSampleRun({ count: 1, lastRunAt: new Date(NOW - 6000).toISOString() }, cfg, NOW);
  eq(cooled.allowed, true, 'once cooled, it runs again');

  eq(J.checkSampleRun(undefined, J.resolveSampleRunConfig({ enabled: false }), NOW).reason,
    'disabled', 'and a disabled exam refuses outright');
});

scenario('J-30', 'an outage does not cost a candidate a run', () => {
  const before = { count: 2, lastRunAt: new Date(NOW - 60_000).toISOString() };

  const down = J.advanceRunState(before, J.unavailableVerdict('judge0', 'ETIMEDOUT'), NOW);
  eq(down.count, 2, 'THE POINT — a run that never reached a judge is not charged');
  eq(down.lastRunAt, new Date(NOW).toISOString(),
    'but the cooldown still advances, so an unreachable judge cannot be hammered');

  const okRun = J.advanceRunState(before, verdict('completed', []), NOW);
  eq(okRun.count, 3, 'a real verdict is charged');
  const ce = J.advanceRunState(before, verdict('compile_error', []), NOW);
  eq(ce.count, 3, 'and so is a compile error — the judge did its job');
});

// ══════════════════════════════════════════════════════════════════
// §7 — THE DEFAULT ADAPTER
// ══════════════════════════════════════════════════════════════════

scenario('J-22', 'with no provider configured the pipeline degrades to manual review', async () => {
  const a = new J.NullJudgeAdapter();
  const tests = [hidden('h1', '1')];
  const v = await a.run();
  eq(v.status, 'judge_unavailable', 'the null adapter reports unavailable');
  eq(v.adapter, 'null', 'and identifies itself on the verdict');
  eq(await a.health(), false, 'health is honest about there being no judge');
  eq(J.outcomeFor(v, tests), null, 'so nothing is graded and no zero is recorded');
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
  console.log(`\n${C.b}JUDGE CORE SUITE — Stage B1${C.x}\n`);
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
