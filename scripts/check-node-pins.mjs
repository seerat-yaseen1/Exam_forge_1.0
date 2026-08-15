#!/usr/bin/env node
/**
 * NODE PIN DRIFT — every place that names a Node major, checked against .nvmrc
 *
 * The Node 24 upgrade (2cdee02) moved three pins in one commit and said why:
 * "a mismatch between any two of them is worse than either value alone."
 * That was true, and the commit was careful — but nothing kept it true
 * afterwards. Two of the three are checked by a machine (firebase-tools fails
 * predeploy when engines.node disagrees with firebase.json's runtime); the
 * rest were held in place by whoever remembered to grep. They did not hold:
 * the root package.json never got an `engines` field at all, so Vercel — which
 * builds the frontend AND runs api/seb-verify.js, the SEB proof minter — took
 * its major from a dashboard setting no file in this repo records. And
 * infra/judge0/README.md documented running the pre-exam acceptance gate in a
 * `node:22-alpine` container, which builds functions/ and imports the compiled
 * adapter: production code, exercised on the wrong major, by the one procedure
 * whose entire purpose is to be trustworthy before an exam.
 *
 * Neither was a wrong value. Both were a MISSING one, which is why reading the
 * files that do carry a version never surfaced them.
 *
 * So this checks a closed set rather than a diff. .nvmrc is the source of
 * truth — CI consumes it directly via setup-node's node-version-file, so the
 * workflow cannot drift from it by construction — and everything else is
 * asserted equal to it:
 *
 *   .nvmrc                     the source of truth
 *   package.json               engines.node          -> Vercel build + api/*
 *   functions/package.json     engines.node          -> firebase predeploy
 *   firebase.json              functions[].runtime   -> deployed container
 *   .github/workflows/*.yml    no hardcoded node-version (must read .nvmrc)
 *   *.md, *.yml, *.sh          docker `node:<major>` image tags
 *
 * The last one is what would have caught the judge0 README. A documented
 * command is a place the code runs, and a version in prose drifts more quietly
 * than one in a config file.
 *
 * Runs on any Node major on purpose — it reads files and compares strings, so
 * a developer on the wrong version still gets a useful answer instead of a
 * second error about their Node version.
 *
 *   node scripts/check-node-pins.mjs
 *
 * Exits non-zero on any mismatch. Wired into CI as its own job.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[2m', b: '\x1b[1m', x: '\x1b[0m' };

const findings = [];
const rows = [];

const read = (p) => readFileSync(join(REPO, p), 'utf8');
const readJson = (p) => JSON.parse(read(p));

/** Leading integer of a version-ish string: "24", "24.x", "nodejs24", "v24.19.0". */
function major(value) {
  const m = String(value).match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

function record(where, what, raw, got) {
  rows.push({ where, what, raw, got });
  return got;
}

function expect(where, what, raw, got, want) {
  record(where, what, raw, got);
  if (got !== want) {
    findings.push(`${where} — ${what} is ${raw === null ? 'MISSING' : `\`${raw}\``}, expected Node ${want}`);
  }
}

// ── The source of truth ────────────────────────────────────────────
let nvmrc;
try {
  nvmrc = read('.nvmrc').trim();
} catch {
  console.error(`${C.r}${C.b}.nvmrc is missing.${C.x} It is the source of truth every other pin is compared against.`);
  process.exit(1);
}

const WANT = major(nvmrc);
if (WANT === null) {
  console.error(`${C.r}${C.b}.nvmrc does not name a version:${C.x} ${JSON.stringify(nvmrc)}`);
  process.exit(1);
}
record('.nvmrc', 'source of truth', nvmrc, WANT);

// ── package.json engines — Vercel's build AND api/*.js ─────────────
{
  const pkg = readJson('package.json');
  const raw = pkg.engines?.node ?? null;
  expect('package.json', 'engines.node', raw, raw === null ? null : major(raw), WANT);
}

// ── functions/package.json engines — firebase predeploy ────────────
{
  const pkg = readJson('functions/package.json');
  const raw = pkg.engines?.node ?? null;
  expect('functions/package.json', 'engines.node', raw, raw === null ? null : major(raw), WANT);
}

// ── firebase.json runtime — the deployed container ─────────────────
{
  const fb = readJson('firebase.json');
  const codebases = Array.isArray(fb.functions) ? fb.functions : fb.functions ? [fb.functions] : [];
  if (codebases.length === 0) {
    findings.push('firebase.json — no functions codebase found; the runtime pin cannot be checked');
  }
  for (const cb of codebases) {
    const label = `firebase.json (codebase ${cb.codebase ?? cb.source ?? '?'})`;
    const raw = cb.runtime ?? null;
    expect(label, 'runtime', raw, raw === null ? null : major(raw), WANT);
  }
}

// ── Workflows must READ .nvmrc, not restate it ─────────────────────
//
// A hardcoded `node-version: 24` is not wrong today and that is the problem:
// it is a second copy that goes stale silently on the next bump. setup-node's
// node-version-file removes the copy.
{
  const dir = join(REPO, '.github/workflows');
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  } catch {
    /* no workflows */
  }

  for (const f of files) {
    const text = readFileSync(join(dir, f), 'utf8');
    const where = `.github/workflows/${f}`;

    const hardcoded = [...text.matchAll(/^\s*node-version:\s*(['"]?)([^'"\s#]+)\1/gm)];
    for (const m of hardcoded) {
      const line = text.slice(0, m.index).split('\n').length;
      findings.push(
        `${where}:${line} — hardcoded \`node-version: ${m[2]}\`. Use \`node-version-file: .nvmrc\` so the workflow cannot drift.`,
      );
    }

    const viaFile = [...text.matchAll(/^\s*node-version-file:\s*(['"]?)([^'"\s#]+)\1/gm)];
    for (const m of viaFile) {
      const line = text.slice(0, m.index).split('\n').length;
      const target = m[2];
      if (target !== '.nvmrc') {
        findings.push(`${where}:${line} — node-version-file reads \`${target}\`, not \`.nvmrc\``);
      } else {
        record(where, `node-version-file (line ${line})`, target, WANT);
      }
    }

    const setupNodeUses = (text.match(/uses:\s*actions\/setup-node@/g) ?? []).length;
    if (setupNodeUses > hardcoded.length + viaFile.length) {
      findings.push(
        `${where} — ${setupNodeUses} setup-node step(s) but only ${hardcoded.length + viaFile.length} version pin(s); ` +
          'an unpinned setup-node silently uses the runner default.',
      );
    }
  }
}

// ── Docker `node:<major>` tags in docs, compose files and scripts ──
//
// The judge0 README's `node:22-alpine` lived here. Prose is where a version
// goes to rot: nothing parses it, so nothing complains.
{
  const SKIP_DIRS = new Set(['node_modules', '.git', 'lib', 'dist', 'build', '.tmp-core', 'graphify-out']);
  const SCAN = /\.(md|ya?ml|sh)$/;

  const walk = (abs) => {
    for (const entry of readdirSync(abs)) {
      if (SKIP_DIRS.has(entry)) continue;
      const child = join(abs, entry);
      if (statSync(child).isDirectory()) {
        walk(child);
        continue;
      }
      if (!SCAN.test(entry) || /package-lock|pnpm-lock/.test(entry)) continue;

      const text = readFileSync(child, 'utf8');
      const where = relative(REPO, child);

      // `node:24-alpine`, `node:24`, `docker.io/library/node:24.19-slim`.
      // The \d guard keeps `node:fs` and friends out.
      for (const m of text.matchAll(/\bnode:(\d+)(?:\.\d+)*(?:-[a-z0-9.]+)?\b/g)) {
        const line = text.slice(0, m.index).split('\n').length;
        const got = Number(m[1]);
        record(`${where}:${line}`, 'docker image tag', m[0], got);
        if (got !== WANT) {
          findings.push(`${where}:${line} — docker image \`${m[0]}\` runs Node ${got}, expected ${WANT}`);
        }
      }
    }
  };

  walk(REPO);
}

// ── Report ─────────────────────────────────────────────────────────
const w = Math.max(...rows.map((r) => r.where.length));
const w2 = Math.max(...rows.map((r) => r.what.length));

console.log(`\n${C.b}Node pins${C.x} ${C.d}(source of truth: .nvmrc = ${nvmrc})${C.x}\n`);
for (const r of rows) {
  const ok = r.got === WANT;
  const mark = ok ? `${C.g}ok${C.x}` : `${C.r}NO${C.x}`;
  console.log(`  ${mark}  ${r.where.padEnd(w)}  ${C.d}${r.what.padEnd(w2)}${C.x}  ${r.raw}`);
}

if (findings.length === 0) {
  console.log(`\n${C.g}${C.b}All ${rows.length} pins agree on Node ${WANT}.${C.x}\n`);
  process.exit(0);
}

console.error(`\n${C.r}${C.b}${findings.length} pin(s) out of line:${C.x}\n`);
for (const f of findings) console.error(`  ${C.r}-${C.x} ${f}`);
console.error(
  `\n${C.d}Change .nvmrc and every line above together — a mismatch between any two\n` +
    `is worse than either value alone.${C.x}\n`,
);
process.exit(1);
