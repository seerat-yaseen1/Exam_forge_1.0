# 🚀 Deploying

> **Work out what to deploy from the diff — never from memory, and never from this file's
> examples.** §1 is the procedure. §3 onwards is the reasoning from the rounds 2/3 deploy,
> kept because the arguments are still instructive, but it describes THAT deploy, not yours.

---

## 0 · Read this before trusting any list below

This document used to open with "**functions only.** Not rules, not indexes, not storage" and
carried a table asserting `firestore.rules` → **no**, evidenced by a `git diff` against a
hardcoded base commit.

That was true for rounds 2 and 3. It stopped being true the moment a later change touched
`firestore.rules` — and the next one did: the 2026-08-06 audit's C1/H1 fix, which lives
**entirely** in that file. Anyone who followed the old table would have deployed functions,
skipped rules, and left a privilege-escalation path open while believing they had closed it.

The defect was not the answer. It was writing a **point-in-time answer where a procedure
belonged**. Deploy targets are a property of your diff, so compute them from your diff.

---

## 1 · The procedure

**Step 1 — find your base.** The last commit actually deployed to the project you are
deploying to. Not `main`'s parent, not the last release tag — what is *live*.

```bash
BASE=<last-deployed-commit-sha>
```

**Step 2 — ask git what changed.**

```bash
git diff --stat $BASE..HEAD -- \
  firestore.rules firestore.indexes.json storage.rules functions/ src/ infra/
```

**Step 3 — deploy exactly what that names.** Each path maps to one target:

| If this changed | Deploy | Notes |
|---|---|---|
| `firestore.rules` | `firebase deploy --only firestore:rules` | Instant, no rollout window. **Never skip** — rules are usually the security-relevant target |
| `firestore.indexes.json` | `firebase deploy --only firestore:indexes` | Index builds take minutes; deploy before the code that queries them |
| `storage.rules` | `firebase deploy --only storage` | |
| `functions/` | `firebase deploy --only functions` | See §5 — deploy all functions together, never cherry-pick |
| `src/` | separate — see §6 | Frontend rides its own pipeline |
| `infra/judge0/` | **not a Firebase target** — see §2 | A VM you `docker compose up` on. `firebase deploy` does not touch it, and nothing in CI tells you it drifted |

**Step 4 — gate on the tests first.**

```bash
npx tsc --noEmit                    # frontend: expect 0 errors
cd functions && npm install && npm test   # expect eight green suites
```

CI runs both on every pull request (`.github/workflows/ci.yml`), so a green PR has already
cleared this. Run it locally anyway when deploying from a machine rather than a merge.

**Step 5 — record what you deployed.** Tag it, so the next person's `$BASE` is a fact rather
than a guess:

```bash
git tag -f deployed/$(date +%Y-%m-%d) && git push -f origin deployed/$(date +%Y-%m-%d)
```

That last step is what stops this section rotting again.

---

## 2 · The judge is a second deployment

Coding items are the one feature that does not live entirely behind
`firebase deploy`. Three things have to be true at once, none of them deployed
by the same command, and **all three fail the same silent way** — coding answers
queue into manual review and nothing else looks wrong.

| | What it is | How it is deployed |
|---|---|---|
| **The cluster** | `infra/judge0/` on a dedicated VM with no external IP | `docker compose up -d` on the host. See `infra/judge0/README.md` |
| **The route** | Serverless VPC connector `exam-forge-connector` | In code: `JUDGE_ACCESS` in `functions/src/index.ts`, carried by **both** judge functions. Ships with a functions deploy |
| **The config** | `JUDGE0_BASE_URL` (env) + `JUDGE0_AUTH_TOKEN` (secret) | `functions/.env.<project>` and `firebase functions:secrets:set` |

Missing config is a **safe** state, deliberately: `getJudgeAdapter()` installs
`NullJudgeAdapter` and every coding answer becomes a paper awaiting review
rather than a zero. It is not a *visible* state. One warning line in the log is
the entire evidence:

```
[judge] adapter=null reason=JUDGE0_BASE_URL is not set; submissions will go to manual review.
[judge] adapter=null reason=JUDGE0_BASE_URL is set but JUDGE0_AUTH_TOKEN is empty; …
[judge] adapter=judge0 baseUrl=http://10.128.0.2:2358          ← the healthy one
```

**Deploy all functions, not just the callable.** `runCodeSample` (the in-exam
Run button) and `scheduledJudgeCoding` (the sweep that actually marks) are
separate deployed functions that need the same connector and the same secret.
Deploying one and not the other gives you the worst possible signal: a student's
sample run works, so the judge is obviously fine, while every submitted paper
sits unmarked. `scheduledJudgeCoding` is a **scheduler** function — Cloud
Scheduler must be enabled in the project or it never fires at all.

**The loopback trap, recorded so nobody pays for it twice.** The cluster binds
`10.128.0.2:2358`, its internal address — *not* `127.0.0.1`. A VPC connector
does not arrive on loopback; it arrives from its own range on the host's
internal interface. Bind loopback and Cloud Functions get `judge_unavailable`
while `curl` from inside the VM answers perfectly, with the connector, firewall,
token and base URL all reading as correct. That address is written in two files
that never meet — the `ports:` entry in `docker-compose.yml` and
`JUDGE0_BASE_URL` — and **`verify.mjs` check V-00 is what compares them.**

**Gate the deploy on the cluster, the way §1 Step 4 gates it on the tests.**

```bash
JUDGE0_URL=http://10.128.0.2:2358 AUTHN_TOKEN='<token>' npm run verify:judge0
```

Non-zero exit means do not point an exam at it. Run it from the machine you
deploy from when you can: `JUDGE0_BASE_URL` lives in a `.env.<project>` file, so
V-00's second half can only run where that file is, and reports itself skipped
(`○`) everywhere else.

**Post-deploy, the coding path needs its own check** — §8's log greps will not
catch any of the above. Sit one coding question, submit, then within ~5 minutes:

```bash
firebase functions:log --project YOUR_PROJECT_ID --only scheduledJudgeCoding
#   → "[judgeCoding] papers=1 judged=1 settled=1"
#     settled=0 with judged>0 means the judge ran and did not finish the paper;
#     papers=0 means nothing was queued, so look at gradeAttempt instead.
```

- `attempts/{id}.codeJudgePending` — set at submit, **gone** once the sweep settles the paper.
- `attemptVerdicts/{attemptId}__{questionId}` — exists, with `state.lastStatus: 'completed'`.
- The mark on the question changes from 0 to the hidden suite's pass rate. Until it does, `scores.requiresManualReview` is true and that is correct, not a fault.

A paper still pending after three sweeps is not waiting — check
`state.attempts`. At 5 it is exhausted, and there is currently no in-product way
to re-arm it; `regradeAttempts` re-reads verdicts that already exist, it does not
re-judge.

---

## 3 · Why no new Firestore index was needed *for rounds 2/3*

> **History, not instruction.** Sections 3–7 document the rounds 2/3 deploy against base
> `62bf880`. The reasoning is worth keeping — it shows the standard of evidence a deploy
> decision should meet — but do not read any of it as a statement about the change in front
> of you. Run §1 for that.

The B-03 fix added exactly one new query, in `getAnswerKeysForReview`:

```ts
db.collection('attempts').where('assessmentId', '==', assessmentId).limit(500)
```

A **single-field equality** filter. Firestore creates single-field indexes automatically, so no composite index is required and `firestore.indexes.json` is untouched. Every other query in the changed code already existed — `regradeAttempts` has run `assessmentId ==` (and `assessmentId == && instituteId ==`) since before this work.

Confirm there are no other new query shapes:

```bash
git diff 62bf880..HEAD -- functions/src/index.ts | grep '^+' | grep -o "\.where('[^']*', '[^']*'" | sort -u
# → .where('assessmentId', '==      ← the only one
```

If a deploy ever *does* surface a missing-index error, Firebase prints a link that creates it. Don't pre-create indexes speculatively.

---

## 4 · Why there is no data migration

The one new field is `examSnapshot` on `attempts`, written by `startExam` at attempt creation.

**Existing attempts do not have it, and must not.** `examContractFor()` falls through to the live assessment document whenever the snapshot is absent — which is byte-for-byte the behaviour before this work. That path is held by probe **B-05** ("a legacy attempt with no snapshot still works"), which strips the field from a real attempt and checks that it still resolves and still grades correctly.

So:

- ❌ **Do not** backfill `examSnapshot` onto existing attempts. A reconstructed snapshot would be a guess about what a student was shown, and a wrong guess is worse than the honest fallback.
- ✅ Attempts started **after** the deploy get the snapshot and the stronger guarantees.
- ✅ Attempts **in flight** during the deploy keep working exactly as they do today.

There is no ordering constraint and no downtime window. Deploy whenever.

---

## 5 · Deploy all functions together — do not cherry-pick

```bash
# ✅ correct
firebase deploy --only functions --project YOUR_PROJECT_ID

# ❌ do NOT do this
firebase deploy --only functions:gradeAttempt --project YOUR_PROJECT_ID
```

Every export lives in one `index.ts` and they share the helpers the fixes changed — `toCoreAttempt`, `examContractFor`, `computeAttemptLocks`, `assertSequentialAnswerWindowOpen`, `awardFor`. Deploying a subset leaves the rest running an older copy of those helpers, and the failure mode is precisely the class of bug this audit spent two rounds removing: **two paths computing the same fact and disagreeing.**

> This paragraph used to open "All 48 exports". There were 56 by the time
> anyone checked, which is §0's warning landing on §5's own text: a
> point-in-time count where a description belonged. `scripts/deploy-functions.sh`
> derives the number from source rather than repeating it.

### The deploy quota, and why a full deploy fails intermittently

`firebase-tools` fires function deploys at a **hardcoded concurrency of 40**
(`lib/deploy/functions/release/index.js` — there is no flag or environment
variable to lower it). Past roughly forty functions that exceeds Google's
per-region write quota and the deploy takes 429s. The CLI retries, but only
what it classifies as transient — `429`, `409`, `503` — so a Cloud Build that
gives up under load fails the whole run instead.

That is why re-running "just the failed ones" succeeds: the retry is a small
deploy that never approaches the quota.

```bash
# ✅ paced, still deploys EVERY function
scripts/deploy-functions.sh YOUR_PROJECT_ID
```

The batches are **pacing, not selection** — the end state is identical to a
single `--only functions`, so this is not the cherry-picking §5 forbids. The
one real difference is that the skew window widens from a few minutes to
around ten, so do not run it during a live sitting. A single deploy already
lands functions over several minutes; batching stretches that, it does not
introduce it.

Do **not** reach for export nesting (`export const exam = { startExam, … }`)
to solve this. It deploys them as `exam-startExam` and every
`httpsCallable('startExam')` in the client breaks.

`firebase.json` already runs `npm run build` as a `predeploy` step, so the TypeScript is compiled fresh on every deploy. You do not need to build by hand.

---

## 6 · The frontend is a separate deploy

Two client files changed and they are **not** covered by `firebase deploy --only functions`:

| File | Change |
|---|---|
| `src/app/pages/student/ExamShell.tsx` | recognises the new `ANSWER_WINDOW_CLOSED` signal |
| `src/app/components/assignments/builder/DetailsStep.tsx` | question-grace field, corrected delivery-mode copy, adaptive warning |

**Order matters, and it is safe in the natural direction.** Deploy **functions first**, then the frontend:

- Functions-new + frontend-old → a late sequential answer is refused with `ANSWER_WINDOW_CLOSED`; the old shell reports it as a generic save failure. Ugly message, correct behaviour, nothing lost.
- Functions-old + frontend-new → the builder offers a question-grace field the server would honour only after the functions deploy. Harmless but confusing.

This repo deploys its frontend through Vercel (`vercel.json`), not Firebase Hosting, so that half follows your usual Vercel flow — no `firebase deploy --only hosting`.

### The Vercel Node version now comes from the repo — check it once

Until 2026-08-15 the root `package.json` had no `engines` field, so Vercel took
its Node major from **Project Settings → Build and Deployment**, a value no file
here recorded. That covered more than the build: `api/csp-report.js` and
`api/seb-verify.js` are Vercel serverless functions, and **`/api/seb-verify` is
the SEB proof minter** (§9) — so the runtime for a security-critical endpoint was
set in a dashboard, invisible to review, while the functions half was pinned to
`nodejs24` in three places.

`engines.node` is now `24.x`, and Vercel prefers it over the dashboard setting.
**On the next deploy the frontend and both `api/` functions move to Node 24** —
from whatever the dashboard said, which may not have been 24.

One thing to do on your side: look at the current dashboard value **before** the
next Vercel deploy, so you know whether this is a no-op or a major bump. If it
is a bump, deploy it outside a live sitting like any other runtime change, and
re-run the `/api/seb-verify` check in §9's procedure afterwards.

To change the major later, edit `.nvmrc` — it is the single source of truth, and
`scripts/check-node-pins.mjs` (CI job **Node version pins**) fails the build if
`package.json`, `functions/package.json`, `firebase.json`, the workflow or any
documented `node:<major>` container disagrees with it.

---

## 7 · One repo-hygiene change to be aware of

> **Correction (2026-08-06):** this section describes a state the repo is not in.
> `functions/lib/` is **tracked**, not gitignored — `git ls-files functions/lib/`
> lists it and `git check-ignore` does not match it. Either the change was
> reverted by a later Figma Make push or it was never applied. The reasoning
> below is still sound and the decision is still worth making; treat it as a
> proposal rather than a description. Until it is applied, `functions/lib/`
> must be rebuilt and committed alongside `functions/src/` or the two drift.

It is generated output. Because the project's source of truth is the Figma Make file, every *"Update files from Figma Make"* push deleted it and every local build recreated it — an ~8,000-line add/delete churn on alternate commits that also buried real source diffs inside it.

Nothing depends on it being committed: `firebase.json`'s `predeploy` builds it before every deploy, and the test suites build it locally. (This was also the first audit's **M2** recommendation.)

**One thing to do on your side:** add a `.gitignore` to the Figma Make file with at least these lines, or the next Make push will delete it again and `node_modules/` can get committed by accident:

```gitignore
node_modules/
package-lock.json
pnpm-lock.yaml
functions/lib/
functions/timing-core.cjs
functions/.tmp-core/
.env
.env.local
.DS_Store
```

---

## 8 · Post-deploy verification

```bash
# 1. the functions are live and healthy
firebase functions:log --project YOUR_PROJECT_ID --only startExam,submitSection,gradeAttempt

# 2. nothing is reporting an invariant violation
firebase functions:log --project YOUR_PROJECT_ID | grep "INVARIANT VIOLATION"
#    → expect NO output. This is the Phase 3b shadow; it logs when the
#      resolver and a callable disagree, which is the earliest warning
#      that a timing rule has drifted.

# 3. the expiry sweep is running and is leaving live students alone
firebase functions:log --project YOUR_PROJECT_ID --only scheduledCloseExpiredAttempts
#    → "left open N (student still has somewhere to go)" is HEALTHY, not a fault.
```

If the diff touched anything coding-related, none of the three greps above says
whether the judge is reachable — **§2 has the checks that do.**

Then run one real sitting end to end on a **mock-tier** exam and check that:

- the attempt document has an `examSnapshot` with your sections and marks;
- `answersLockedAfter` is the earliest of section / overall / `endDate`;
- submitting past the section clock closes the section **at its deadline**, not at the late arrival instant.

---

## 9 · Rotating `SEB_SIGNING_SECRET`

> Audit S-6 / R-14. **This is now a zero-downtime procedure.** An earlier
> version of this section said rotation required a window with no SEB exams
> running; that was true when each side held a single secret, and is no longer
> the constraint.

### The shape

The secret exists in **two deployment systems that know nothing about each
other**:

| Where | Role | How it is set |
|---|---|---|
| Vercel env `SEB_SIGNING_SECRET` | `/api/seb-verify` **mints** the proof — uses the **first** entry | Vercel settings → redeploy |
| Firebase secret `SEB_SIGNING_SECRET` | `assertSEB` **verifies** it — accepts **any** entry | `firebase functions:secrets:set` → deploy functions |

Both accept a **comma-separated list**. That asymmetry — mint with one, accept
several — is what removes the window: a new secret is taught to the verifier
first, and only promoted to the minter once every function is deploying it.

A single secret with no comma is the ordinary case and behaves exactly as it
always has.

### The procedure

**Step 1 — generate.**

```bash
openssl rand -hex 32
```

**Step 2 — teach the VERIFIER the new secret, keeping the old.** Order matters:
the verifier must accept both *before* anything mints the new one.

```bash
# value: "<OLD>,<NEW>"   — old first, both valid
firebase functions:secrets:set SEB_SIGNING_SECRET --project YOUR_PROJECT_ID
scripts/deploy-functions.sh YOUR_PROJECT_ID        # §5 — all functions together
```

Exams keep running throughout: proofs in flight were minted with `<OLD>`, which
still verifies.

**Step 3 — confirm the deploy actually landed before going further.** This is
the step that makes the rest safe; skipping it re-introduces the window.

```bash
firebase functions:log --project YOUR_PROJECT_ID --only startExam | grep -i seb
#   → no "proof signature invalid"
```

**Step 4 — promote the new secret in the MINTER.** Vercel → Environment
Variables → set `SEB_SIGNING_SECRET` to `<NEW>` → **redeploy**. An env change
alone does nothing; the running deployment keeps the old value.

New proofs are now minted with `<NEW>`, which the verifier already accepts.
Proofs minted seconds earlier with `<OLD>` also still verify, so nothing in
flight is rejected.

**Step 5 — retire the old secret.** Once the longest possible proof lifetime
has passed (the TTL is 90s — an hour is ample):

```bash
# value: "<NEW>"   — old dropped
firebase functions:secrets:set SEB_SIGNING_SECRET --project YOUR_PROJECT_ID
scripts/deploy-functions.sh YOUR_PROJECT_ID
```

**Step 6 — record the date.** A secret nobody can date is a secret nobody dares
rotate.

### Verifying it

Only a real SEB client proves it end to end — Chrome never sends the
config-key header, so a browser check cannot tell a working secret from a
broken one.

```bash
firebase functions:log --project YOUR_PROJECT_ID --only startExam | grep -i seb
#   "SEB_REQUIRED: proof signature invalid"  → the lists disagree; go back a step
#   "SEB_EXPIRED"                            → benign, and self-healing: a proof
#                                              inside its 90s TTL. The client
#                                              re-verifies automatically.
```

`R-17` in `functions/test/risk.suite.cjs` holds this behaviour: both secrets
valid mid-rotation, the old one refused after it is dropped, and every binding
(candidate, exam, expiry) still enforced with several secrets configured.

### If it goes wrong

Put the previous value back on the side you changed last and redeploy. Because
the verifier accepts a list, **widening it is always safe** — if you are unsure
which secret a client holds, configure both and work it out from the logs
rather than guessing.

---

## 9a · Enabling the pre-exam warm-up

> Audit R-8. `scheduledWarmup` ships **disabled** and does nothing until two
> things are true. Both are deliberate: one is a permission, the other is a
> spending decision.

**Step 1 — grant the permission.** The functions service account cannot change
a Cloud Run service by default, and without this every call 403s:

```bash
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member=serviceAccount:YOUR_PROJECT_ID@appspot.gserviceaccount.com \
  --role=roles/run.developer
```

**Step 2 — turn it on.** `WARMUP_ENABLED=true` in `functions/.env.<project>`,
then deploy functions.

**Step 3 — watch one window.** It logs every five minutes whether or not it
acts:

```bash
firebase functions:log --project YOUR_PROJECT_ID --only scheduledWarmup
#   [warmup] window=none candidates=0 minInstances=0 applied=2/2   ← idle, healthy
#   [warmup] window=open candidates=3 minInstances=3 applied=2/2   ← a sitting is near
#   [warmup] DENIED on startexam: … lacks run.services.update      ← step 1 was skipped
```

### What it costs, and the knobs

Warm instances bill continuously while held. Defaults: 3 instances on
`startExam` and `getExamQuestions` only, from 20 minutes before a sitting until
30 after. All tunable in `functions/.env.<project>`:

| | Default | |
|---|---|---|
| `WARMUP_MIN_INSTANCES` | 3 | Instances held per function |
| `WARMUP_LOOKAHEAD_MIN` | 20 | How early to warm |
| `WARMUP_TRAILING_MIN` | 30 | How long to stay warm after the start |

Only two of the ten hot-path functions are warmed: the rest are reached
*during* a sitting, by which point instances are warm from the opening burst.

### Turning it off

`WARMUP_ENABLED=false` and redeploy. The next run returns immediately without
touching anything — but note it will **not** reset a `minInstances` it already
set, because it exits before the API call. Set it to 0 by hand, or leave the
flag on for one window so its own trailing pass clears it.

---

## 10 · Rollback

```bash
git revert <commit-sha>        # the fixes are one commit per defect
cd functions && npm test       # confirm green at the reverted state
cd .. && firebase deploy --only functions --project YOUR_PROJECT_ID
```

Rolling back is clean. `examSnapshot` becomes an ignored extra field on attempts written while the new code was live — nothing reads it under the old code, and nothing breaks. No data cleanup needed.