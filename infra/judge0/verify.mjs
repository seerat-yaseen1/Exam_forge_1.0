#!/usr/bin/env node
/**
 * JUDGE0 ACCEPTANCE — run this against a live cluster before any exam
 *
 * Everything in the coding engine is proven by suites EXCEPT the sandbox
 * itself. judgeCore's limits are unit-tested against a fake transport, the
 * adapter is tested against an injected one, and neither of those can tell you
 * whether isolate actually kills an infinite loop or whether a candidate's
 * program can open a socket. That is what this checks, against the real thing.
 *
 * Two of these are SECURITY assertions and are written as such: the test
 * PASSES when the submission FAILS. A judge where a candidate's program can
 * reach the network is a judge where a candidate can exfiltrate the paper, and
 * that must be a loud, obvious failure rather than a line in a README nobody
 * ran.
 *
 *   JUDGE0_URL=http://127.0.0.1:2358 AUTHN_TOKEN=… node infra/judge0/verify.mjs
 *
 * Exits non-zero if anything fails. Suitable as a deployment gate.
 */

import { JUDGE0_LANGUAGE_IDS, verifyLanguageTable } from '../../functions/lib/judge0Adapter.js';

const URL_BASE = (process.env.JUDGE0_URL ?? 'http://127.0.0.1:2358').replace(/\/$/, '');
const TOKEN = process.env.AUTHN_TOKEN ?? '';

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };
const results = [];
let current = null;

function scenario(id, title, fn) { results.push({ id, title, fn }); }
function check(pass, label, detail) {
  current.checks.push({ pass: !!pass, label, detail: detail === undefined ? null : String(detail) });
}
const eq = (a, e, label) => check(a === e, label, `expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => (typeof s === 'string' && s ? Buffer.from(s, 'base64').toString('utf8') : '');

const headers = () => ({
  'Content-Type': 'application/json',
  ...(TOKEN ? { 'X-Auth-Token': TOKEN } : {}),
});

async function api(path, init = {}, useToken = true) {
  const res = await fetch(`${URL_BASE}${path}`, {
    ...init,
    headers: useToken ? headers() : { 'Content-Type': 'application/json' },
  });
  let json = null;
  try { json = await res.json(); } catch { /* some errors return no body */ }
  return { status: res.status, json };
}

/** Submit one program and poll until it is terminal. */
async function run(source, opts = {}) {
  const body = {
    language_id: opts.languageId ?? JUDGE0_LANGUAGE_IDS.python3,
    source_code: b64(source),
    stdin: b64(opts.stdin ?? ''),
    cpu_time_limit: opts.cpuSeconds ?? 2,
    cpu_extra_time: 0.5,
    wall_time_limit: opts.wallSeconds ?? 6,
    memory_limit: opts.memoryKb ?? 262144,
    max_processes_and_or_threads: opts.processes ?? 32,
    max_file_size: opts.outputKb ?? 256,
    enable_network: false,
    redirect_stderr_to_stdout: false,
  };
  const created = await api('/submissions?base64_encoded=true&wait=false', {
    method: 'POST', body: JSON.stringify(body),
  });
  if (created.status < 200 || created.status >= 300) {
    return { error: `create returned HTTP ${created.status}` };
  }
  const token = created.json?.token;
  if (!token) return { error: 'no token returned' };

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const got = await api(
      `/submissions/${token}?base64_encoded=true&fields=status,stdout,stderr,compile_output,message,time,memory`,
    );
    const id = got.json?.status?.id ?? 0;
    if (id > 2) {
      return {
        statusId: id,
        description: got.json?.status?.description,
        stdout: unb64(got.json?.stdout),
        stderr: unb64(got.json?.stderr),
        compile: unb64(got.json?.compile_output),
        time: got.json?.time,
        memory: got.json?.memory,
      };
    }
  }
  return { error: 'never became terminal within 60s' };
}

// ══════════════════════════════════════════════════════════════════
// §1 — REACHABILITY AND AUTH
// ══════════════════════════════════════════════════════════════════

scenario('V-01', 'the cluster is up and answers with the token', async () => {
  const res = await api('/system_info');
  check(res.status >= 200 && res.status < 300, 'GET /system_info succeeds', `HTTP ${res.status}`);
});

scenario('V-02', 'SECURITY — an unauthenticated request is refused', async () => {
  if (!TOKEN) {
    check(false, 'AUTHN_TOKEN is set',
      'No token supplied to this script. An unauthenticated Judge0 is a public code-execution service; set AUTHN_TOKEN in judge0.conf and re-run.');
    return;
  }
  const res = await api('/system_info', {}, false);
  check(res.status === 401 || res.status === 403,
    'a request without X-Auth-Token is rejected',
    `HTTP ${res.status} — anyone who can reach this host can run code on it`);
});

// ══════════════════════════════════════════════════════════════════
// §2 — THE LANGUAGE TABLE
// ══════════════════════════════════════════════════════════════════

scenario('V-03', 'the pinned language ids match this instance', async () => {
  const res = await api('/languages');
  if (res.status < 200 || res.status >= 300 || !Array.isArray(res.json)) {
    check(false, 'GET /languages succeeds', `HTTP ${res.status}`);
    return;
  }
  const bad = verifyLanguageTable(res.json);
  check(bad.length === 0,
    'every pinned id resolves to the language it claims',
    bad.length ? JSON.stringify(bad) : undefined);
  // A mismatch is not cosmetic: it runs Python submissions as whatever now
  // holds id 71, and every candidate looks like they wrote broken code.
});

// ══════════════════════════════════════════════════════════════════
// §3 — IT ACTUALLY RUNS CODE
// ══════════════════════════════════════════════════════════════════

scenario('V-04', 'a correct program runs and returns its output', async () => {
  const r = await run('import sys\nprint(sum(int(x) for x in sys.stdin.read().split()))',
    { stdin: '2 3 4' });
  check(!r.error, 'the submission completed', r.error);
  eq(r.statusId, 3, 'status is Accepted');
  eq(r.stdout.trim(), '9', 'stdout is correct');
});

scenario('V-05', 'a compile error is reported as one', async () => {
  const r = await run('int main( {', { languageId: JUDGE0_LANGUAGE_IDS.c });
  check(!r.error, 'the submission completed', r.error);
  eq(r.statusId, 6, 'status is Compilation Error');
  check(r.compile.length > 0, 'diagnostics are returned', r.compile.slice(0, 120));
});

scenario('V-06', 'stderr is kept separate from stdout', async () => {
  // If these are merged, a program that logs to stderr fails every comparison
  // despite printing the right answer.
  const r = await run('import sys\nprint("answer")\nsys.stderr.write("noise\\n")');
  eq(r.stdout.trim(), 'answer', 'stdout carries only the answer');
  check(r.stderr.includes('noise'), 'stderr is reported separately', r.stderr);
});

// ══════════════════════════════════════════════════════════════════
// §4 — THE SANDBOX HOLDS
// ══════════════════════════════════════════════════════════════════
//
// These are the assertions no unit test can make. Every one of them is a
// promise judgeCore makes to the grading path, and until this script runs
// against a real cluster none of them has been checked.

scenario('V-07', 'an infinite loop is killed by the CPU limit', async () => {
  const r = await run('while True:\n    pass', { cpuSeconds: 1, wallSeconds: 5 });
  check(!r.error, 'the submission terminated at all', r.error);
  eq(r.statusId, 5, 'status is Time Limit Exceeded');
});

scenario('V-08', 'a program that blocks forever is killed by the WALL limit', async () => {
  // Blocking on stdin burns no CPU, so the CPU limit alone never fires. This is
  // why wallMs exists and is always greater than cpuMs.
  const r = await run('import sys\nsys.stdin.read()\nimport time\ntime.sleep(600)',
    { cpuSeconds: 2, wallSeconds: 4 });
  check(!r.error, 'the submission terminated at all', r.error);
  check(r.statusId === 5, 'status is Time Limit Exceeded', `got ${r.statusId} (${r.description})`);
});

scenario('V-09', 'a memory hog is stopped by the memory limit', async () => {
  const r = await run('x = bytearray(1024 * 1024 * 1024)\nprint(len(x))',
    { memoryKb: 65536, cpuSeconds: 5, wallSeconds: 10 });
  check(!r.error, 'the submission terminated at all', r.error);
  check(r.statusId !== 3, 'it did NOT succeed in allocating 1 GB', `status ${r.statusId}`);
});

scenario('V-10', 'a fork bomb is contained by the process limit', async () => {
  const r = await run(
    'import os\nwhile True:\n    os.fork()',
    { processes: 8, cpuSeconds: 2, wallSeconds: 8 },
  );
  check(!r.error, 'the host survived and the submission terminated', r.error);
  check(r.statusId !== 3, 'it did not run unbounded', `status ${r.statusId}`);
});

scenario('V-11', 'SECURITY — a submission cannot reach the network', async () => {
  // THE ONE THAT MATTERS MOST. A program that can open a socket can exfiltrate
  // the paper, and can fetch an answer. Both docker-compose (internal network,
  // no gateway) and every submission (enable_network:false) are supposed to
  // prevent it; this checks the property rather than either mechanism.
  const r = await run([
    'import socket',
    'try:',
    '    s = socket.create_connection(("1.1.1.1", 53), timeout=5)',
    '    print("NETWORK-REACHABLE")',
    'except Exception as e:',
    '    print("blocked:", type(e).__name__)',
  ].join('\n'), { cpuSeconds: 5, wallSeconds: 12 });

  check(!r.error, 'the submission completed', r.error);
  check(!r.stdout.includes('NETWORK-REACHABLE'),
    'a candidate program CANNOT open an outbound socket',
    r.stdout.trim() || r.stderr.trim());
});

scenario('V-12', 'SECURITY — DNS does not resolve inside the sandbox', async () => {
  // A separate hole from raw sockets, and one an "internal: true" network still
  // closes — but only if no resolver is reachable. Worth its own check because
  // a misconfigured DNS forwarder is an easy thing to add later.
  const r = await run([
    'import socket',
    'try:',
    '    print("RESOLVED", socket.gethostbyname("example.com"))',
    'except Exception as e:',
    '    print("blocked:", type(e).__name__)',
  ].join('\n'), { cpuSeconds: 5, wallSeconds: 12 });

  check(!r.stdout.includes('RESOLVED'),
    'a candidate program cannot resolve a hostname',
    r.stdout.trim());
});

scenario('V-13', 'the server accepts the platform ceiling', async () => {
  // judge0.conf's MAX_* must not sit below MAX_LIMITS in judgeCore: Judge0
  // REJECTS a submission over a server ceiling rather than clamping it, so a
  // mismatch becomes a rejected submission the sweep retries forever.
  const r = await run('print("ok")', {
    cpuSeconds: 15, wallSeconds: 30, memoryKb: 1024 * 1024, processes: 128, outputKb: 4096,
  });
  check(!r.error, 'a submission at the platform ceiling is accepted', r.error);
  eq(r.stdout.trim(), 'ok', 'and runs normally');
});

// ── Report ────────────────────────────────────────────────────────

(async () => {
  console.log(`\n${C.b}JUDGE0 ACCEPTANCE${C.x}  ${C.d}${URL_BASE}${C.x}\n`);
  let pass = 0, fail = 0;

  for (const s of results) {
    current = { checks: [], error: null };
    try { await s.fn(); } catch (e) { current.error = e; }

    const bad = current.checks.filter((c) => !c.pass);
    const status = current.error ? `${C.r}ERROR${C.x}` : bad.length ? `${C.r}FAIL${C.x}` : `${C.g}PASS${C.x}`;
    console.log(`  ${status}  ${C.b}${s.id}${C.x}  ${s.title}`);
    for (const c of current.checks) {
      if (c.pass) { pass++; continue; }
      fail++;
      console.log(`        ${C.r}✗${C.x} ${c.label}`);
      if (c.detail) console.log(`          ${C.d}${c.detail}${C.x}`);
    }
    if (current.error) {
      fail++;
      console.log(`        ${C.r}✗ threw${C.x} ${current.error.message}`);
    }
  }

  console.log(`\n${'─'.repeat(72)}`);
  if (fail === 0) {
    console.log(`${C.g}${C.b}  ALL GREEN${C.x} — ${pass} checks. This cluster is fit to mark an exam.`);
  } else {
    console.log(`${C.r}${C.b}  ${fail} FAILED${C.x} — ${pass} passed.`);
    console.log(`${C.y}  Do not point an exam at this cluster until these are green.${C.x}`);
  }
  process.exit(fail === 0 ? 0 : 1);
})();
