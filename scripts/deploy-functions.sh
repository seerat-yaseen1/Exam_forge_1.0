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
  npx firebase deploy --only "$targets" --project "$PROJECT" --force

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
LIVE=$(npx firebase functions:list --project "$PROJECT" 2>/dev/null | grep -cP '^\W*\w+\W+v\d' || true)
echo "source: $MATCHED functions"
echo "live:   $LIVE functions"
if [[ "$LIVE" -lt "$MATCHED" ]]; then
  echo
  echo "MISMATCH — fewer functions are live than exist in source." >&2
  echo "Some batch did not land. Re-run this script; it is idempotent." >&2
  exit 1
fi

echo
echo "All $MATCHED functions deployed."
