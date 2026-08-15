#!/usr/bin/env node
/**
 * VENDOR THE FACE-API WEIGHTS — pin them by bytes, not by a branch URL
 *
 * WHY THIS EXISTS (audit S-8 / R-5)
 *
 * package.json's `postinstall` used to be:
 *
 *   curl -fsSL https://raw.githubusercontent.com/justadudewhohacks/face-api.js/
 *        master/weights/... -o public/models/...
 *
 * and `public/models/` is gitignored, so that fetch was MANDATORY on every
 * install. Three problems, the same three vendoring already solved for `xlsx`
 * one directory over:
 *
 *   • `npm i` fails wherever raw.githubusercontent.com is unreachable — and
 *     since Vercel runs the install, that is a BUILD OUTAGE, not a degraded
 *     feature. The whole app stops deploying because a webcam model could not
 *     be downloaded.
 *   • It points at `master` of a third-party repository. Not a tag, not a
 *     commit — a moving branch belonging to someone else, who is free to
 *     rename the file, restructure the directory, or archive the project.
 *   • Nothing verified the bytes. These weights drive the in-exam face
 *     detector; "whatever that URL served today" is not a dependency
 *     specification.
 *
 * After this, the weights are committed (204 KB) and postinstall copies them
 * from vendor/ into public/models/. No network, no third-party branch, and the
 * bytes are the ones this repository was tested against.
 *
 * USAGE — only needed to re-vendor after a deliberate upgrade:
 *
 *   node scripts/vendor-face-models.mjs
 *   node scripts/vendor-face-models.mjs --check   # verify vendored copies only
 *
 * Must run somewhere raw.githubusercontent.com is reachable. That is the point:
 * network access ONCE, here, and never again on any other machine.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath rather than import.meta.dirname, matching vendor-xlsx.mjs —
// the latter needs Node 20.11+, and a script whose job is to run on whatever
// machine has network access should not fail there with a syntax-level error.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_DIR = path.join(ROOT, 'vendor', 'face-api');
const SHAFILE = path.join(VENDOR_DIR, 'face-api-weights.sha256');

const BASE =
  'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights';

/**
 * The TinyFaceDetector pair, and only that pair.
 *
 * FaceMonitor loads `nets.tinyFaceDetector` and nothing else, so vendoring the
 * full weights directory would commit several megabytes of models the product
 * never loads. Adding a net here means adding its files here too.
 */
const FILES = [
  'tiny_face_detector_model-weights_manifest.json',
  'tiny_face_detector_model-shard1',
];

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Parse the `<hash>  <name>` lines sha256sum writes, so the file stays standard. */
function parseShaFile(text) {
  const out = new Map();
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/);
    if (m) out.set(m[2], m[1]);
  }
  return out;
}

async function readRecorded() {
  try {
    return parseShaFile(await readFile(SHAFILE, 'utf8'));
  } catch {
    return new Map();
  }
}

async function check() {
  const recorded = await readRecorded();
  if (recorded.size === 0) {
    console.error('No recorded hashes. Run without --check to vendor them first.');
    process.exitCode = 1;
    return;
  }
  const present = new Set(await readdir(VENDOR_DIR));
  let bad = 0;
  for (const name of FILES) {
    if (!present.has(name)) {
      console.error(`  MISSING  ${name}`);
      bad++;
      continue;
    }
    const actual = sha256(await readFile(path.join(VENDOR_DIR, name)));
    const want = recorded.get(name);
    if (actual !== want) {
      console.error(`  MISMATCH ${name}\n    recorded ${want}\n    actual   ${actual}`);
      bad++;
    } else {
      console.log(`  ok       ${name}`);
    }
  }
  if (bad > 0) process.exitCode = 1;
}

async function vendor() {
  await mkdir(VENDOR_DIR, { recursive: true });
  const recorded = await readRecorded();
  const lines = [];
  let changed = false;

  for (const name of FILES) {
    const url = `${BASE}/${name}`;
    console.log(`Fetching ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const hash = sha256(buf);

    const was = recorded.get(name);
    if (was && was !== hash) {
      // Loud, and NOT auto-accepted. A changed hash here means the upstream
      // branch is serving different bytes than this repository was built
      // against — which is exactly the situation the pin exists to detect.
      console.error(
        `\n  HASH CHANGED for ${name}\n`
        + `    recorded ${was}\n    fetched  ${hash}\n`
        + '    Establish WHY before committing this. Upstream is a moving\n'
        + '    branch, so a change is expected eventually — but it should be\n'
        + '    a decision, and the models should be re-tested against the\n'
        + '    face detector before it is taken.\n',
      );
      process.exitCode = 1;
      return;
    }
    if (!was) changed = true;

    await writeFile(path.join(VENDOR_DIR, name), buf);
    lines.push(`${hash}  ${name}`);
    console.log(`  ${name} — ${buf.length} bytes, ${hash.slice(0, 16)}…`);
  }

  await writeFile(SHAFILE, lines.join('\n') + '\n');
  if (changed) {
    console.log(
      '\nFirst vendoring: there was nothing to verify against, so these hashes\n'
      + 'are recorded rather than checked. Every later run verifies against them.',
    );
  }
  console.log('\nCommit vendor/face-api/ together with package.json.');
}

const mode = process.argv.includes('--check') ? check : vendor;
mode().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
