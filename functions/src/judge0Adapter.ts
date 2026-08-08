/**
 * JUDGE0 ADAPTER — the first real implementation of JudgeAdapter
 * (Stage B1: Judge Adapter, against a self-hosted Judge0)
 *
 * Everything Judge0-specific is in this file and nothing above it knows the
 * provider exists. That was the point of the interface, and it is what makes
 * the language table below survivable: Judge0's language ids are numeric and
 * CHANGE BETWEEN RELEASES, so a question authored against "Python 3" must not
 * be storing `71`.
 *
 * ── WHAT THIS ADAPTER DELIBERATELY DOES NOT USE ───────────────────
 *
 * Judge0 can compare output for you: send `expected_output` and it returns
 * status 3 (Accepted) or 4 (Wrong Answer). This adapter never does that.
 *
 * Exam Forge decides correctness itself, in `compareOutput`, because the
 * comparison a coding question needs is a property of the QUESTION — trimmed,
 * token-wise, or numeric within a tolerance — and Judge0 has one comparison
 * for everything. Delegating it would silently downgrade every numeric
 * question to exact string matching and fail correct programs over a rounding
 * digit. So submissions are sent WITHOUT expected_output, and Judge0's status
 * is read only for the things it alone knows: did it compile, did it run, did
 * it exceed a limit.
 *
 * ── AND WHAT IT ALWAYS DOES ───────────────────────────────────────
 *
 * Base64, in both directions. Raw JSON round-tripping mangles exactly the
 * bytes that decide a mark — trailing whitespace, a missing final newline, a
 * lone CR — and cannot carry the arbitrary bytes a candidate's program is
 * entitled to print. `base64_encoded=true` is not an optimisation here, it is
 * correctness.
 */

import {
  ComparisonMode,
  JudgeAdapter,
  JudgeLanguage,
  JudgeSubmission,
  JudgeTest,
  JudgeTestResult,
  JudgeVerdict,
  TestStatus,
  testPasses,
  unavailableVerdict,
} from './judgeCore';

// ══════════════════════════════════════════════════════════════════
// §1 — LANGUAGE TABLE
// ══════════════════════════════════════════════════════════════════

/**
 * Judge0 CE language ids, PINNED TO AN IMAGE VERSION.
 *
 * These numbers are not stable across Judge0 releases — an upgrade can
 * renumber them, and a renumbered table silently runs submissions in the wrong
 * language rather than failing. The deployment therefore pins the image
 * (see infra/judge0/docker-compose.yml) and `verifyLanguageTable` exists to be
 * run against a live instance after any upgrade.
 */
export const JUDGE0_IMAGE = 'judge0/judge0:1.13.1';

export const JUDGE0_LANGUAGE_IDS: Record<JudgeLanguage, number> = {
  python3:    71,   // Python (3.8.1)
  javascript: 63,   // JavaScript (Node.js 12.14.0)
  typescript: 74,   // TypeScript (3.7.4)
  java:       62,   // Java (OpenJDK 13.0.1)
  c:          50,   // C (GCC 9.2.0)
  cpp:        54,   // C++ (GCC 9.2.0)
  csharp:     51,   // C# (Mono 6.6.0.161)
  go:         60,   // Go (1.13.5)
  rust:       73,   // Rust (1.40.0)
  kotlin:     78,   // Kotlin (1.3.70)
  php:        68,   // PHP (7.4.1)
  ruby:       72,   // Ruby (2.7.0)
  sql:        82,   // SQL (SQLite 3.27.2)
};

/** Expected `name` prefix per id, for the post-upgrade check. */
export const JUDGE0_LANGUAGE_NAMES: Record<JudgeLanguage, string> = {
  python3: 'Python', javascript: 'JavaScript', typescript: 'TypeScript',
  java: 'Java', c: 'C ', cpp: 'C++', csharp: 'C#', go: 'Go',
  rust: 'Rust', kotlin: 'Kotlin', php: 'PHP', ruby: 'Ruby', sql: 'SQL',
};

/**
 * Compare the pinned table against what a live instance reports.
 *
 * Pure, so the deployment check is testable. Returns the mismatches; an empty
 * array means the table is safe to use against that instance.
 */
export function verifyLanguageTable(
  live: Array<{ id: number; name: string }>,
): Array<{ language: JudgeLanguage; expectedId: number; found: string | null }> {
  const byId = new Map(live.map((l) => [l.id, l.name]));
  const bad: Array<{ language: JudgeLanguage; expectedId: number; found: string | null }> = [];
  (Object.keys(JUDGE0_LANGUAGE_IDS) as JudgeLanguage[]).forEach((lang) => {
    const id = JUDGE0_LANGUAGE_IDS[lang];
    const name = byId.get(id) ?? null;
    if (name === null || !name.startsWith(JUDGE0_LANGUAGE_NAMES[lang])) {
      bad.push({ language: lang, expectedId: id, found: name });
    }
  });
  return bad;
}

// ══════════════════════════════════════════════════════════════════
// §2 — STATUS MAPPING
// ══════════════════════════════════════════════════════════════════

/** Judge0 status ids. Only the ones whose meaning we depend on are named. */
export const J0 = {
  IN_QUEUE: 1,
  PROCESSING: 2,
  ACCEPTED: 3,
  WRONG_ANSWER: 4,
  TIME_LIMIT_EXCEEDED: 5,
  COMPILATION_ERROR: 6,
  RUNTIME_ERROR_SIGSEGV: 7,
  RUNTIME_ERROR_NZEC: 11,
  RUNTIME_ERROR_OTHER: 12,
  INTERNAL_ERROR: 13,
  EXEC_FORMAT_ERROR: 14,
} as const;

export function isTerminal(statusId: number): boolean {
  return statusId > J0.PROCESSING;
}

/**
 * Judge0 status → our per-test status, for the statuses that are NOT about
 * correctness.
 *
 * Returns null when Judge0 is telling us the program ran to completion — 3 and
 * 4 both mean "it produced output" — because at that point correctness is ours
 * to decide from the bytes, not Judge0's to report. (4 can only appear if an
 * expected_output leaked into a submission, which this adapter never sends;
 * treating it as "ran" rather than trusting it is the safe direction.)
 *
 * 13 and 14 are Judge0 itself failing — a worker died, isolate misbehaved, the
 * binary would not exec. Those are NOT the candidate's fault and are handled by
 * the caller as an infrastructure failure, never as a wrong answer.
 */
export function mapTestStatus(statusId: number): TestStatus | null {
  switch (statusId) {
    case J0.ACCEPTED:
    case J0.WRONG_ANSWER:
      return null;                    // ran; we compare the output ourselves
    case J0.TIME_LIMIT_EXCEEDED:
      return 'timeout';
    case J0.COMPILATION_ERROR:
      return 'skipped';               // handled at the submission level
    case J0.INTERNAL_ERROR:
    case J0.EXEC_FORMAT_ERROR:
      return 'skipped';               // infrastructure, not the program
    default:
      // 7..12 are the runtime-error family (SIGSEGV, SIGFPE, SIGABRT, NZEC…).
      // They differ by signal, and none of that difference changes the mark.
      return 'runtime_error';
  }
}

/** Judge0 reports memory in KB and times in seconds-as-string. */
function num(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : undefined;
}

const b64decode = (v: unknown): string =>
  typeof v === 'string' && v.length > 0 ? Buffer.from(v, 'base64').toString('utf8') : '';
const b64encode = (v: string): string => Buffer.from(v, 'utf8').toString('base64');

// ══════════════════════════════════════════════════════════════════
// §3 — REQUEST AND RESPONSE SHAPES
// ══════════════════════════════════════════════════════════════════

export interface Judge0Submission {
  language_id: number;
  source_code: string;
  stdin: string;
  cpu_time_limit: number;
  cpu_extra_time: number;
  wall_time_limit: number;
  memory_limit: number;
  stack_limit: number;
  max_processes_and_or_threads: number;
  max_file_size: number;
  enable_network: boolean;
  redirect_stderr_to_stdout: boolean;
}

export interface Judge0Result {
  token?: string;
  status?: { id?: number; description?: string };
  stdout?: string | null;
  stderr?: string | null;
  compile_output?: string | null;
  message?: string | null;
  time?: string | null;
  memory?: number | null;
}

/**
 * Build the Judge0 payload for one test.
 *
 * `enable_network: false` is set per submission as well as at the daemon, and
 * the redundancy is deliberate: one is a deployment property that a future
 * operator can change without reading this file, the other travels with every
 * request. A candidate's program has no business reaching the network, and a
 * program that could would be able to exfiltrate the paper.
 */
export function buildJudge0Submission(sub: JudgeSubmission, test: JudgeTest): Judge0Submission {
  const cpuSec = sub.limits.cpuMs / 1000;
  return {
    language_id: JUDGE0_LANGUAGE_IDS[sub.language],
    source_code: b64encode(sub.source),
    stdin: b64encode(test.stdin ?? ''),
    cpu_time_limit: cpuSec,
    // Judge0 kills at cpu_time_limit + cpu_extra_time. Kept small: it exists to
    // absorb interpreter startup, not to quietly widen the author's limit.
    cpu_extra_time: 0.5,
    wall_time_limit: sub.limits.wallMs / 1000,
    memory_limit: sub.limits.memoryKb,
    stack_limit: Math.min(sub.limits.memoryKb, 64 * 1024),
    max_processes_and_or_threads: sub.limits.processes,
    max_file_size: sub.limits.outputKb,
    enable_network: false,
    // Kept separate so a program's diagnostics never contaminate the output
    // being compared — merging them fails correct programs that log to stderr.
    redirect_stderr_to_stdout: false,
  };
}

// ══════════════════════════════════════════════════════════════════
// §4 — VERDICT ASSEMBLY  (pure)
// ══════════════════════════════════════════════════════════════════

/** Was this an infrastructure failure rather than a program failure? */
function isInfraStatus(id: number): boolean {
  return id === J0.INTERNAL_ERROR || id === J0.EXEC_FORMAT_ERROR;
}

/**
 * Turn Judge0's per-test results into one verdict. PURE — no network, no clock
 * beyond the one passed in — which is what lets the suite prove the mapping
 * without a Judge0 to point at.
 *
 * Ordering matters here and is deliberate:
 *
 *   1. A COMPILATION ERROR anywhere is a submission-level fact. The same source
 *      is compiled for every test, so one compile failure means all of them
 *      failed for the same reason, and reporting ten runtime errors would
 *      describe a program that ran. It becomes a single compile_error verdict:
 *      real, scored zero, penalty-eligible.
 *
 *   2. An INTERNAL ERROR from Judge0 is the platform failing, and the whole
 *      verdict is discarded as unavailable rather than scoring the tests that
 *      happened to succeed. Grading a partial run would hand a candidate a mark
 *      out of however many tests survived the outage.
 *
 *   3. Everything else is per-test, and correctness is decided HERE by
 *      comparing bytes under the test's own comparison mode.
 */
export function verdictFromResults(
  sub: JudgeSubmission,
  results: Judge0Result[],
  adapterName: string,
  now: Date = new Date(),
): JudgeVerdict {
  const judgedAt = now.toISOString();
  const tests = sub.tests;

  // (1) compile error — submission-level
  const compiled = results.findIndex((r) => r.status?.id === J0.COMPILATION_ERROR);
  if (compiled >= 0) {
    return {
      status: 'compile_error',
      compileMessage: b64decode(results[compiled].compile_output) || 'Compilation failed.',
      results: [],
      adapter: adapterName,
      judgedAt,
    };
  }

  // (2) Judge0 itself failed
  const infra = results.find((r) => isInfraStatus(r.status?.id ?? 0));
  if (infra) {
    return unavailableVerdict(
      adapterName,
      `Judge0 reported ${infra.status?.description ?? 'an internal error'}`
        + `${infra.message ? `: ${b64decode(infra.message)}` : ''}`,
      now,
    );
  }

  // (3) per-test
  const out: JudgeTestResult[] = [];
  for (let i = 0; i < tests.length; i++) {
    const test = tests[i];
    const r = results[i];
    if (!r) {
      // Fewer results than tests. Not scored as passing, and not silently
      // dropped — summarise() counts a missing result against the suite.
      continue;
    }
    const statusId = r.status?.id ?? J0.INTERNAL_ERROR;
    const mapped = mapTestStatus(statusId);
    const stdout = b64decode(r.stdout);
    const stderr = b64decode(r.stderr);

    const status: TestStatus = mapped !== null
      ? mapped
      : (testPasses(test, stdout) ? 'passed' : 'wrong_answer');

    out.push({
      testId: test.id,
      status,
      ...(num(r.time) !== undefined ? { timeMs: Math.round(num(r.time)! * 1000) } : {}),
      ...(num(r.memory) !== undefined ? { memoryKb: num(r.memory)! } : {}),
      stdout,
      ...(stderr ? { stderr } : {}),
    });
  }

  return { status: 'completed', results: out, adapter: adapterName, judgedAt };
}

// ══════════════════════════════════════════════════════════════════
// §5 — TRANSPORT
// ══════════════════════════════════════════════════════════════════

export interface Judge0Response { status: number; json: unknown; }

/**
 * The HTTP surface, injectable so the adapter's behaviour — batching, polling,
 * deadlines, the circuit breaker — is testable without a Judge0 or a network.
 */
export interface Judge0Transport {
  post(path: string, body: unknown, timeoutMs: number): Promise<Judge0Response>;
  get(path: string, timeoutMs: number): Promise<Judge0Response>;
}

export interface Judge0Config {
  baseUrl: string;
  /** Sent as X-Auth-Token. The instance must not be reachable without it. */
  authToken?: string;
  /** Ceiling on one run() call, independent of the per-test limits. */
  maxRunMs?: number;
  /** Consecutive failures before the breaker opens. */
  breakerThreshold?: number;
  /** How long the breaker stays open. */
  breakerResetMs?: number;
}

export function httpTransport(cfg: Judge0Config): Judge0Transport {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.authToken) headers['X-Auth-Token'] = cfg.authToken;

  const call = async (path: string, init: RequestInit, timeoutMs: number): Promise<Judge0Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}${path}`, {
        ...init, headers, signal: ctrl.signal,
      });
      let json: unknown = null;
      try { json = await res.json(); } catch { json = null; }
      return { status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    post: (path, body, timeoutMs) =>
      call(path, { method: 'POST', body: JSON.stringify(body) }, timeoutMs),
    get: (path, timeoutMs) => call(path, { method: 'GET' }, timeoutMs),
  };
}

// ══════════════════════════════════════════════════════════════════
// §6 — THE ADAPTER
// ══════════════════════════════════════════════════════════════════

const POLL_INTERVALS_MS = [250, 500, 1000, 1500, 2000, 3000];

/**
 * Judge0, batched and polled.
 *
 * Submissions are created with `wait=false`. Synchronous mode (`wait=true`)
 * holds a Judge0 web worker for the entire duration of the run, so a cohort
 * submitting together exhausts the web pool long before the sandbox pool —
 * the server stops accepting work while the machines that do the work sit
 * idle. Judge0's own documentation advises against it in production, and an
 * exam is the load it is worst at.
 *
 * `run` NEVER THROWS, per the JudgeAdapter contract. Every failure — network,
 * auth, malformed response, deadline, open breaker — becomes a
 * `judge_unavailable` verdict, because the caller's correct response to all of
 * them is to record it and retry later, and an exception invites a `catch`
 * that scores zero.
 */
export class Judge0Adapter implements JudgeAdapter {
  readonly name = 'judge0';
  private readonly cfg: Required<Pick<Judge0Config, 'maxRunMs' | 'breakerThreshold' | 'breakerResetMs'>> & Judge0Config;
  private readonly transport: Judge0Transport;
  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;

  constructor(cfg: Judge0Config, transport?: Judge0Transport) {
    this.cfg = {
      maxRunMs: 120_000,
      breakerThreshold: 5,
      breakerResetMs: 60_000,
      ...cfg,
    };
    this.transport = transport ?? httpTransport(cfg);
  }

  private breakerIsOpen(nowMs: number): boolean {
    return nowMs < this.breakerOpenUntil;
  }

  private recordFailure(nowMs: number): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.cfg.breakerThreshold) {
      this.breakerOpenUntil = nowMs + this.cfg.breakerResetMs;
      this.consecutiveFailures = 0;
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.breakerOpenUntil = 0;
  }

  async health(): Promise<boolean> {
    try {
      const res = await this.transport.get('/system_info', 5_000);
      return res.status >= 200 && res.status < 300;
    } catch {
      return false;
    }
  }

  async run(sub: JudgeSubmission): Promise<JudgeVerdict> {
    const startMs = Date.now();

    // An open breaker fails fast rather than adding this submission to the
    // pile already timing out against a judge known to be down. The sweep's
    // backoff is what brings it back, so failing fast here costs nothing.
    if (this.breakerIsOpen(startMs)) {
      return unavailableVerdict(this.name, 'Judge0 circuit breaker is open.');
    }
    if (sub.tests.length === 0) {
      return unavailableVerdict(this.name, 'Submission carries no tests.');
    }

    try {
      const payload = {
        submissions: sub.tests.map((t) => buildJudge0Submission(sub, t)),
      };
      const created = await this.transport.post(
        '/submissions/batch?base64_encoded=true', payload, 20_000,
      );
      if (created.status < 200 || created.status >= 300) {
        this.recordFailure(Date.now());
        return unavailableVerdict(this.name, `Judge0 create returned HTTP ${created.status}`);
      }

      const tokens = Array.isArray(created.json)
        ? (created.json as Array<{ token?: string }>).map((s) => s?.token).filter(
            (t): t is string => typeof t === 'string' && t.length > 0)
        : [];
      if (tokens.length !== sub.tests.length) {
        this.recordFailure(Date.now());
        return unavailableVerdict(
          this.name,
          `Judge0 accepted ${tokens.length} of ${sub.tests.length} submissions`,
        );
      }

      const results = await this.poll(tokens, startMs);
      if (!results) {
        this.recordFailure(Date.now());
        return unavailableVerdict(this.name, 'Judge0 did not finish within the run deadline.');
      }

      this.recordSuccess();
      return verdictFromResults(sub, results, this.name);
    } catch (e) {
      this.recordFailure(Date.now());
      return unavailableVerdict(this.name, `Judge0 request failed: ${(e as Error).message}`);
    }
  }

  /** Poll until every submission is terminal, or the deadline passes. */
  private async poll(tokens: string[], startMs: number): Promise<Judge0Result[] | null> {
    const deadline = startMs + this.cfg.maxRunMs;
    const path = `/submissions/batch?base64_encoded=true&tokens=${tokens.join(',')}`
      + '&fields=token,status,stdout,stderr,compile_output,message,time,memory';

    for (let i = 0; Date.now() < deadline; i++) {
      const wait = POLL_INTERVALS_MS[Math.min(i, POLL_INTERVALS_MS.length - 1)];
      await new Promise((r) => setTimeout(r, wait));

      const res = await this.transport.get(path, 15_000);
      if (res.status < 200 || res.status >= 300) continue;

      const body = res.json as { submissions?: Judge0Result[] } | null;
      const subs = body?.submissions;
      if (!Array.isArray(subs) || subs.length !== tokens.length) continue;

      if (subs.every((s) => isTerminal(s.status?.id ?? 0))) {
        // Judge0 returns results in token order, which is submission order.
        return subs;
      }
    }
    return null;
  }
}

/** Re-exported so callers can type a comparison mode without reaching into core. */
export type { ComparisonMode };
