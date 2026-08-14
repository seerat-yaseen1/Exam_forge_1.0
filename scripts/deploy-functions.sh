#!/usr/bin/env bash
#
# Deploy every Cloud Function, in batches, without tripping the deploy quota.
#
# ── Why this exists ────────────────────────────────────────────────
#
# There are 56 functions. firebase-tools fires them at the Cloud Functions API
# with a HARDCODED concurrency of 40 (lib/deploy/functions/release/index.js —
# `concurrency: 40`, and there is no flag or environment variable to lower it).
# Google's per-region write quota is well under that, so a full deploy runs
# straight into HTTP 429.
#
# The CLI does retry — `retries: 30, backoff: 20s, maxBackoff: 100s` — but only
# for errors it classifies as transient: 429, 409 and 503. Anything else,
# including a Cloud Build that gives up under load, fails the deploy outright.
# That is why a re-run of "just the failed ones" succeeds: the second attempt is
# a small deploy that never approaches the quota.
#
# Batching gets the same effect deliberately instead of by accident.
#
# ── This does NOT cherry-pick (DEPLOY.md §5) ───────────────────────
#
# §5 forbids deploying a SUBSET, because all 56 exports share helpers
# (toCoreAttempt, examContractFor, computeAttemptLocks…) and leaving some on an
# older copy is how two paths end up computing the same fact and disagreeing.
#
# This deploys ALL of them — the batches are pacing, not selection, and the end
# state is identical to a single `--only functions`. Worth being clear-eyed
# about the one real difference: the skew window is longer. A single deploy
# already lands 56 functions over several minutes, so skew is not new, but
# batching widens it. Do not run this during a live sitting.
#
# The list is DERIVED from source on every run, never hardcoded. A stale list
# would silently stop deploying a function that someone added later, which is
# exactly the permanent-subset state §5 is about — and it would look like a
# clean deploy while doing it. The count check at the end is the backstop.
#
# ── Usage ──────────────────────────────────────────────────────────
#
#   scripts/deploy-functions.sh <project-id> [batch-size]
#   scripts/deploy-functions.sh exam-forge-1-40ba7
#
set -euo pipefail

PROJECT="${1:-}"
BATCH="${2:-15}"

if [[ -z "$PROJECT" ]]; then
  echo "usage: $0 <project-id> [batch-size]" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/functions/src/index.ts"

[[ -f "$SRC" ]] || { echo "cannot find $SRC" >&2; exit 1; }

# The repo's OWN firebase-tools, by explicit path. Not `npx firebase`.
#
# firebase-tools is a devDependency of functions/, not of the root, and this
# script runs from wherever the caller happens to be. `npx firebase` from the
# root therefore resolves nothing locally and falls through to the registry,
# where it fetches the package literally named `firebase` — the CLIENT SDK,
# which ships no executable — and dies with:
#
#     npm error could not determine executable to run
#
# That failure is silent about its cause and looks like a broken deploy rather
# than a missing CLI. It only ever worked for someone with firebase-tools
# installed GLOBALLY, which is per-Node-version under nvm: `nvm use 24` is
# enough to make a deploy that worked yesterday stop working, with no change
# to this repo at all.
#
# The explicit path removes the ambient dependency entirely. It also pins the
# deploy to the SAME CLI the test suites run against (functions/package.json,
# firebase-tools ^15.26.0) rather than whatever major is installed globally.
FIREBASE="$ROOT/functions/node_modules/.bin/firebase"

if [[ ! -x "$FIREBASE" ]]; then
  echo "cannot find firebase-tools at $FIREBASE" >&2
  echo "Run: npm --prefix \"$ROOT/functions\" ci" >&2
  exit 1
fi

# Every export in index.ts is `export const NAME = onSomething(`. The negative
# check below fails the run if that ever stops being true, rather than quietly
# deploying whatever the pattern happened to match.
UNMATCHED=$(grep -c '^export const' "$SRC")
mapfile -t FNS < <(grep -oP '^export const \K\w+(?= = on)' "$SRC")
MATCHED=${#FNS[@]}

if [[ "$UNMATCHED" -ne "$MATCHED" ]]; then
  echo "REFUSING TO DEPLOY: $UNMATCHED exports in index.ts but only $MATCHED matched." >&2
  echo "An export uses a form this script does not recognise. Deploying now would" >&2
  echo "silently leave it on the old build. Fix the pattern above first." >&2
  exit 1
fi

echo "Deploying $MATCHED functions to $PROJECT in batches of $BATCH."
echo

# Build once, up front. firebase.json has a `predeploy` npm run build, which
# would otherwise recompile identically on every single batch.
( cd "$ROOT/functions" && npm run build )

i=0
batch_no=0
while [[ $i -lt $MATCHED ]]; do
  batch_no=$((batch_no + 1))
  slice=("${FNS[@]:i:BATCH}")
  targets=$(printf ",functions:%s" "${slice[@]}")
  targets=${targets:1}

  echo
  echo "── batch $batch_no: ${#slice[@]} functions ──────────────────────────"
  # --force skips the "delete these functions?" prompt. Safe here BECAUSE the
  # list is derived from source: this batch names only functions that exist in
  # the code, so there is nothing for the CLI to propose deleting.
  "$FIREBASE" deploy --only "$targets" --project "$PROJECT" --force

  i=$((i + BATCH))
  # Let the per-minute write quota drain before the next batch. This is the
  # whole point of the script; without it the batches simply re-create the
  # burst that fails.
  if [[ $i -lt $MATCHED ]]; then
    echo "waiting 30s for the deploy quota to recover…"
    sleep 30
  fi
done

echo
echo "── verifying ────────────────────────────────────────────────"
# The backstop. A batch that failed silently, or a function that never got
# deployed because it was missing from the derived list, shows up here as a
# count that does not match the source.
#
# This is the LAST WORD on a deploy that has already taken twenty minutes and
# cold-started every function in the project, so it has to get two things
# right that the first version got wrong.
#
# ── 1. Strip ANSI before counting ──
# `functions:list` renders a cli-table3 table, and cli-table3 colours the
# border on EVERY row whether or not stdout is a TTY. So each line really
# begins:
#
#     \e[90m│\e[39m createAuthUser \e[90m│\e[39m v2 …
#
# against which `^\W*\w+\W+v\d` cannot match: \W* eats the ESC and the two
# brackets, then \w+ swallows `90m`, and the match is already past the point
# where `v2` could satisfy `v\d`. It counted 0 on a table full of functions —
# so this check reported `live: 0` against `source: 56` on a deploy where all
# 56 had in fact updated successfully.
#
# ── 2. A verification that could not RUN is not a deploy that failed ──
# The old line sent stderr to /dev/null and let `|| true` turn every possible
# failure — no credentials, a revoked token, a missing run.services.list
# permission, a network blip — into the number 0, which then read as "fewer
# functions are live than exist in source" and told the operator to redeploy
# production. That is the most expensive wrong answer this script can give,
# and it gave it silently. The two cases are now separated, and the error
# that caused a failed check is printed instead of discarded.
ERRFILE="$(mktemp)"
trap 'rm -f "$ERRFILE"' EXIT

if LIST=$("$FIREBASE" functions:list --project "$PROJECT" 2>"$ERRFILE"); then
  LIVE=$(printf '%s\n' "$LIST" | sed -r 's/\x1b\[[0-9;]*m//g' | grep -cP '^\W*\w+\W+v\d' || true)
  echo "source: $MATCHED functions"
  echo "live:   $LIVE functions"
  if [[ "$LIVE" -lt "$MATCHED" ]]; then
    echo
    echo "MISMATCH — fewer functions are live than exist in source." >&2
    echo "Some batch did not land. Re-run this script; it is idempotent." >&2
    exit 1
  fi
else
  echo
  echo "COULD NOT VERIFY — 'firebase functions:list' failed:" >&2
  sed 's/^/  /' "$ERRFILE" >&2
  echo >&2
  echo "This says NOTHING about the deploy itself, which reported success" >&2
  echo "above. Do NOT redeploy on the strength of this message. Confirm in" >&2
  echo "the console instead:" >&2
  echo "  https://console.firebase.google.com/project/$PROJECT/functions" >&2
  exit 1
fi

echo
echo "All $MATCHED functions deployed."
