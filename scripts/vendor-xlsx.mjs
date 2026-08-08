#!/usr/bin/env node
/**
 * VENDOR XLSX — pin SheetJS by bytes, not by a URL
 *
 * WHY THIS EXISTS
 *
 * SheetJS stopped publishing to the npm registry at 0.19; 0.20.3 is only
 * available from cdn.sheetjs.com. package.json therefore pinned a URL, and a
 * URL dependency has three problems that all showed up at once:
 *
 *   • it cannot be installed anywhere that host is unreachable — a locked-down
 *     CI runner, a corporate proxy, an air-gapped build;
 *   • it is re-fetched on every resolution rather than served from a cache, so
 *     a CDN outage is a build outage;
 *   • nothing verifies the bytes. A URL pin says where to get it, not what it
 *     should be.
 *
 * Vendoring fixes all three: the tarball lives in the repository, the pin
 * becomes `file:`, and pnpm records its integrity hash in the lockfile.
 *
 * WHAT THIS DOES
 *
 *   1. downloads the tarball (needs network access to cdn.sheetjs.com)
 *   2. verifies its SHA-256 against vendor/xlsx-<v>.sha256 if that file exists,
 *      and records it if it does not
 *   3. writes it to vendor/
 *   4. rewrites package.json's xlsx pin to file:vendor/xlsx-<v>.tgz
 *
 * Then run `pnpm install` to regenerate the lockfile, and commit vendor/,
 * package.json and pnpm-lock.yaml together.
 *
 *   node scripts/vendor-xlsx.mjs
 *   node scripts/vendor-xlsx.mjs --sha256=<hash>   # verify against a known hash
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.20.3';
const URL = `https://cdn.sheetjs.com/xlsx-${VERSION}/xlsx-${VERSION}.tgz`;
// fileURLToPath rather than import.meta.dirname: the latter needs Node 20.11+,
// and this script's whole job is to run on whatever machine happens to have
// network access to the CDN. Failing there with a syntax-level error would be
// a poor introduction to it.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_DIR = path.join(ROOT, 'vendor');
const TARBALL = path.join(VENDOR_DIR, `xlsx-${VERSION}.tgz`);
const SHAFILE = path.join(VENDOR_DIR, `xlsx-${VERSION}.sha256`);
const PIN = `file:vendor/xlsx-${VERSION}.tgz`;

const arg = (name) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

const exists = (p) => access(p).then(() => true, () => false);

async function main() {
  console.log(`Fetching ${URL}`);
  const res = await fetch(URL);
  if (!res.ok) {
    // The common case is a network policy denying the host, which is exactly
    // the problem this script exists to remove — so say so rather than just
    // printing a status code.
    throw new Error(
      `Download failed with HTTP ${res.status}.\n`
      + `If this is a 403 from a proxy, cdn.sheetjs.com is not reachable from `
      + `this machine. Run this script somewhere it is, and commit the result — `
      + `that is the whole point of vendoring it.`,
    );
  }

  const bytes = Buffer.from(await res.arrayBuffer());
  const sha = createHash('sha256').update(bytes).digest('hex');
  console.log(`Downloaded ${bytes.length} bytes, sha256 ${sha}`);

  // ── Integrity ────────────────────────────────────────────────────
  const expected = arg('sha256') ?? (await exists(SHAFILE)
    ? (await readFile(SHAFILE, 'utf8')).trim().split(/\s+/)[0]
    : null);

  if (expected) {
    if (expected !== sha) {
      throw new Error(
        `SHA-256 MISMATCH\n  expected ${expected}\n  got      ${sha}\n`
        + `Refusing to vendor. Either the CDN is serving different bytes than `
        + `the ones this repository was built against, or the download was `
        + `tampered with. Do not "fix" this by updating the hash without `
        + `establishing which.`,
      );
    }
    console.log('SHA-256 matches the recorded hash.');
  } else {
    // First run. Trust-on-first-use is the weakest link in this script, so it
    // is stated plainly rather than passed over.
    console.warn(
      `\n!! No recorded hash to verify against — this run establishes it.\n`
      + `!! Check ${sha}\n`
      + `!! against SheetJS's published checksum for ${VERSION} BEFORE committing.\n`
      + `!! Every later run verifies against this value, so an unchecked hash `
      + `here is an unchecked dependency forever.\n`,
    );
  }

  await mkdir(VENDOR_DIR, { recursive: true });
  await writeFile(TARBALL, bytes);
  await writeFile(SHAFILE, `${sha}  xlsx-${VERSION}.tgz\n`);
  console.log(`Wrote ${path.relative(ROOT, TARBALL)}`);

  // ── Flip the pin ─────────────────────────────────────────────────
  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  if (pkg.dependencies?.xlsx === PIN) {
    console.log('package.json already pinned to the vendored tarball.');
  } else {
    pkg.dependencies.xlsx = PIN;
    await writeFile(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`Pinned xlsx to ${PIN}`);
  }

  console.log(
    `\nNext:\n`
    + `  pnpm install          # regenerates pnpm-lock.yaml with the integrity hash\n`
    + `  git add vendor package.json pnpm-lock.yaml\n`
    + `  git commit -m "build: vendor xlsx ${VERSION}"\n`,
  );
}

main().catch((e) => {
  console.error(`\n${e.message}\n`);
  process.exit(1);
});
