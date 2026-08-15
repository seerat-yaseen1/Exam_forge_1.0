#!/usr/bin/env node
/**
 * PREINSTALL GUARD — the only thing that enforces Node 24 for local dev
 *
 * Every other pin in this repo is enforced by a machine that reads it:
 *
 *   firebase.json  runtime: nodejs24     Cloud Run builds the container on it
 *   functions/     engines.node: 24      firebase-tools fails predeploy on a mismatch
 *   package.json   engines.node: 24.x    Vercel picks the build/functions major from it
 *   .github/       node-version-file     setup-node reads .nvmrc
 *
 * A developer's laptop reads none of them. `engines` is advisory to npm — an
 * install on the wrong major prints EBADENGINE and carries on — and `.nvmrc`
 * only does anything if the shell happens to have nvm/fnm/asdf wired up to
 * read it. So the one environment with no enforcement at all was the one where
 * the code is actually written, and "works on my machine, on Node 22" is
 * exactly the class of drift the three deployed pins exist to prevent.
 *
 * This runs as root `preinstall`, so it fires before a single dependency is
 * fetched and can therefore use nothing but Node builtins.
 *
 * WHY NOT engine-strict=true IN .npmrc, which is the usual answer here:
 * that flag does not assert "Node 24". It asserts "every package in the tree
 * tolerates whatever Node you are running", by promoting each dependency's
 * OWN declared range to a hard error. Both lockfiles already carry ranges like
 * `^22.22.2 || ^24.15.0 || >=26.0.0` (node-gyp) and `^22.20 || ^24.12 || >=25`
 * (@napi-rs/lzma), so it would hard-fail installs on Node 24.0-24.14 — and any
 * future transitive dep with a narrower range could break installs for
 * everyone, over a policy that is not ours. This checks our policy instead.
 *
 * ESCAPE HATCH: EXAM_FORGE_SKIP_NODE_CHECK=1. For the rare case of installing
 * under a different major on purpose (bisecting a dependency, reproducing a
 * report). It is deliberately verbose about having been used.
 */

const WANT = 24;

const running = process.versions.node;
const major = Number(running.split('.')[0]);

if (process.env.EXAM_FORGE_SKIP_NODE_CHECK === '1') {
  if (major !== WANT) {
    console.warn(
      `\n  ! EXAM_FORGE_SKIP_NODE_CHECK=1 — installing on Node ${running}, not ${WANT}.` +
        `\n    Nothing built here is evidence about production.\n`,
    );
  }
  process.exit(0);
}

if (major === WANT) process.exit(0);

const red = '\x1b[31m';
const bold = '\x1b[1m';
const dim = '\x1b[2m';
const off = '\x1b[0m';

console.error(`
${red}${bold}  Node ${WANT} is required. This is Node ${running}.${off}

  The deployed functions runtime is ${bold}nodejs24${off} (firebase.json), the frontend
  and api/ build on ${bold}24.x${off} (package.json engines), and CI runs ${bold}24${off}
  (.nvmrc). Installing on ${major} produces a tree, a build and a test result
  that say nothing about what actually ships.

  ${bold}Fix:${off}

    nvm install && nvm use        ${dim}# reads .nvmrc${off}
    fnm use                       ${dim}# or: asdf install${off}

  ${dim}Deliberately installing under another major? EXAM_FORGE_SKIP_NODE_CHECK=1${off}
`);

process.exit(1);
