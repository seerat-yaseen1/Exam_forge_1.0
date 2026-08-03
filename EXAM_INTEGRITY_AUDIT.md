# 🔬 STRATUM — End-to-End Exam Integrity Audit

> **Date:** 2026-08-03
> **Scope:** the whole assessment lifecycle — creation with each setting on and off, admission, delivery, timers, freeze, penalties, escape, submission, grading, attempts.
> **Method:** every finding below is **executable**. A new suite, `functions/test/audit.probe.cjs`, drives the **compiled production callables** (`functions/lib/index.js`) against an in-memory Firestore and a virtual clock. Nothing in it re-implements a deadline, a lock or a mark — every number asserted on was written by a real handler.
> **Result:** 22 probes, **77 checks green, 16 red across 10 distinct defects.** The three pre-existing suites are all green and stayed green.
>
> ## ✅ STATUS: ALL TEN DEFECTS FIXED (2026-08-03)
>
> Every finding below has been resolved, each in its own commit, with the probe that proved it now passing. **93/93 probe checks green**, and the three pre-existing suites unchanged and green throughout (13,446 states / 84,062 assertions; 64 freeze checks; 85 e2e checks).
>
> | Finding | Commit | Probe |
> |---|---|---|
> | A-01 penalties dropped by `toCoreAttempt` | `89c75ed` | P-01 ✅ |
> | A-02 `submitSection` re-arms the write lock | `b162c66` | P-02, P-03 ✅ |
> | A-03 sequential delivery has no section/overall clock | `af5c7e8` | P-04 ✅ |
> | A-05 / A-06 live edits reach a sitting student | `8c6b6b4` | P-21, P-22 ✅ |
> | A-04 penalty caps overshoot in aggregate | `50143da` | P-12 ✅ |
> | A-08 partial multi-select penalised as fully wrong | `b2ddd62` | P-06 ✅ |
> | A-07 window does not bound answer writes | `d18f0c7` | P-05 ✅ |
> | A-09 / A-10 + contradictions C-1…C-6 | see below | P-07 ✅ |
>
> The sections below are left as written, in the past tense of the investigation, because the evidence is the point — each says what was wrong, how it was measured, and what the fix was. A "Fixed" note closes each one.
>
> ## 🔁 ROUND 3 (2026-08-03) — four more, all in round 2's own blind spot
>
> A third pass went at the code round 2 **added**, on the principle that a fix which is right where it was tested and wrong where it was not is the exact shape of the defects it replaced. It was.
>
> Round 2 froze the paper and timing onto the attempt and routed the **graders** through that contract. Four other readers of the same paper were left reading the live document:
>
> | # | Defect | Measured |
> |---|---|---|
> | **B-01** | `getExamQuestions` served the live paper in standard delivery | served `q9,q2,q3` to a student graded on `q1,q2,q3` |
> | **B-02** | `regradeAttempts` regraded every attempt against the live paper | a finished 40/40 sitting re-scored to **30/40** |
> | **B-03** | `getAnswerKeysForReview` intersected against the live paper | a question removed from a live exam became **unmarkable** |
> | **B-04** | the per-question clock was read live | an answer at 60s flagged late after the limit was cut 300s→10s under the student |
>
> B-02 is the sharpest: round 2's own commit message named `regradeAttempts` as part of the problem and then did not fix it.
>
> **Two probes were corrected rather than reported** — the system was right and the probe was wrong. B-12 (de-allocating a student mid-sitting does not eject them) is documented design; `blockedStudents` is the live lever. B-13 (three parallel starts → three attempts) was the **fake Firestore's** transaction having no isolation — the harness, not the product.
>
> New suite `functions/test/audit.round3.cjs`, 15 probes / 52 checks. `npm test` now runs all five suites and is green: **13,446 timing states · 84,062 assertions · 64 freeze · 85 e2e · 93 round-2 · 52 round-3.**
>
> Deployment: see **[DEPLOY.md](./DEPLOY.md)** — functions only, no rules, no indexes, no migration.

---

## 1 · What we did, and how

### 1.1 Baseline first

Before looking for anything new, the existing suites were built and run, so that every later red mark is attributable to this audit rather than to a broken tree.

| Suite | Command | Result |
|---|---|---|
| Timing core sweep | `npm run test:timing` | ✅ 13,446 states · 84,062 property assertions · 27 regressions |
| Freeze behavioural | `node test/freeze.suite.cjs` | ✅ 64 passed / 0 failed · 15 scenarios |
| Exam end-to-end | `node test/exam.e2e.cjs` | ✅ 85 passed / 0 failed · 10 scenarios |
| TypeScript build | `npm run build` | ✅ clean (`noUnusedLocals` on) |

The tree is healthy. **Everything red below is new ground, not a pre-existing failure.**

### 1.2 Then: read, hypothesise, prove

The audit was deliberately **not** a documentation review. The order was:

1. **Read the seams.** `examTimingCore.ts` (the resolver and its invariants), then every exam callable in `functions/src/index.ts` — `startExam`, `startSection`, `submitSection`, `submitAnswerAndAdvance`, `saveAnswerNoAdvance`, `gradeAttempt`, `freezeAttempt`, `unfreezeAttempt`, `registerSession`, `logViolation`, `reportExtensionCheck`, `scheduledCloseExpiredAttempts` — then `firestore.rules`, then the builder (`DetailsStep.tsx`, `assessmentService.ts`) and the runtime shell (`ExamShell.tsx`).
2. **Form a falsifiable hypothesis** wherever two paths appeared to be able to disagree about the same fact.
3. **Write a probe that fails if the defect is present**, and run it against the real handler.
4. **Discard probe artifacts.** The first run showed 18 red; four were bugs in the probes (a wrong scheduler invocation, a mis-modelled question pointer, a leak test that flagged a *zeroed* key field, and a scenario that hit `INV-1` before the gate it meant to test). Those were fixed and re-run. What remains is code, not test error.

This mattered: the same discipline the codebase's own comments describe — *"a test fixture that agrees with the bug proves nothing"* — applies to an audit. Every claim below is reproducible with one command.

```bash
cd functions && npm install && npm run build && node test/audit.probe.cjs
```

---

## 2 · Executive summary

| Severity | Count | Theme |
|:---:|:---:|---|
| 🔴 **HIGH** | 6 | Time enforcement and mark integrity can be bypassed or silently undone |
| 🟡 **MEDIUM** | 2 | A stated policy and the code that implements it disagree |
| 🟢 **LOW** | 2 | Unvalidated input surface; a dead configuration knob |
| ⚠️ **Contradictions** | 6 | Documentation / UI that describes a system other than the one that ships |

**Bottom line.** The clock architecture is genuinely good — one resolver, one deadline function, credit anchored per clock, invariants checked by a property sweep. The defects are not in that core. They are in **the edges around it**: three places that recompute a lock while losing a field, one delivery mode that never learned the outer clocks exist, one penalty cap that is right per-clock and wrong in aggregate, and an assessment document that stays editable underneath a student who is already sitting it.

Five of the six HIGH findings share one shape, and it is the shape this codebase has written the most words about:

> **Two paths compute the same fact, and one of them has lost a term.**

---

## 3 · 🔴 HIGH severity

### A-01 · A freeze penalty is invisible to the resolver, and is refunded at the next section boundary

**Probe:** `P-01` · **Evidence:** `functions/src/index.ts:7620`

`toCoreAttempt()` maps a stored attempt onto the resolver's `CoreAttempt` shape. It maps sixteen fields. It does **not** map `penalties`.

```ts
// functions/src/index.ts:7620 — every field EXCEPT penalties
return { status, startedAt, sectionIds, currentSectionIdx, sectionTimings,
         servedQuestions, answers, creditedFreezeMs, totalFrozenSeconds,
         freezes, scores, gradedAnswers,
         answersLockedAfter, sectionLockedAfter, overallLockedAfter,
         activeSessionId };
```

`closeFreezeUpdates` (`:6435`) is the *only* site that reattaches them, by hand, when it builds `penalisedAttempt`. That is why the freeze suite's `FZ-07` ("penalties reach the write gate") passes — at the instant of unfreeze, they do.

Everywhere else they are gone. `penaltyForClock()` reads `a.penalties`, finds `undefined`, and returns `0` — in `getExamVerdict`, in `submitSection`'s deadline gate, in the expiry sweep, and in every later `computeAttemptLocks`.

**Measured.** 120-minute exam, invigilator deducts 5 minutes at unfreeze:

| Moment | Overall deadline | |
|---|---|---|
| Birth | `t0 + 120:30` | |
| After unfreeze with a 5-minute deduction | `t0 + 115:30` | ✅ the deduction lands |
| `getExamVerdict` — what the student's screen renders | `t0 + 120:30` | ❌ **penalty invisible** |
| After an ordinary `submitSection` advance | `t0 + 120:30` | ❌ **penalty refunded** |

An invigilator's recorded decision, with an actor and a timestamp, is undone by the student pressing "next section". No invariant catches it: `INV-3a` forbids the bound moving *earlier* without a ledger row, and this moves it *later*.

**FIXED** (`89c75ed`). `penalties` is mapped in `toCoreAttempt`, kept adjacent to `freezes` because credit and deduction are two halves of one ledger and must travel together. P-01 green.

---

### A-02 · `submitSection` re-arms the answer-write lock on demand

**Probe:** `P-02`, `P-03` · **Evidence:** `functions/src/index.ts:8366–8368`, `8311–8314`

`nextSectionId` and `nextSectionIdx` arrive from `request.data` and are **never validated** — not against `attempt.sectionIds`, not against the assessment's sections, not against whether that section has already been played.

```ts
// functions/src/index.ts:8366
if (nextSectionId && !pauseBeforeNext && !mandatoryBreakDue) {
  updates.currentSectionIdx = nextSectionIdx;                       // caller-supplied
  updates[`sectionTimings.${nextSectionId}.startedAt`] = nowIso;    // caller-supplied key
  ...
  applyLockUpdates(updates, computeAttemptLocks(
    attempt.startedAt, nowIso,
    a.sections?.find((s) => s.id === nextSectionId)?.timeLimit, a, advCore));
}
```

Three consequences, all measured:

**(a) The write window is renewable.** Call `submitSection({ sectionId: 'SA', nextSectionId: 'SA' })`. The same update both closes SA and re-opens it, and `answersLockedAfter` is re-anchored on *now* plus SA's full time limit.

> Probe P-02: lock at birth `+30:30`. After one forged call at `+25:00` → **`+56:00`**.

On an exam with **no overall limit** — per-section timing only, a perfectly ordinary configuration — this is repeatable without bound. `firestore.rules:754` (`answerWriteWindowOpen`) gates answer writes on exactly this field, so the student keeps writing answers indefinitely.

**(b) A section's start instant is rewritable.** The same call moved `sectionTimings.SA.startedAt` from `09:00:00` to `09:25:00` — a direct violation of `INV-9` ("a section's `startedAt` never moves"), which `checkTransition` exists to catch but which nothing calls on this path.

**(c) Arbitrary keys and indices.** `nextSectionId: 'GHOST'` creates `sectionTimings.GHOST`; `nextSectionIdx: 9` is written to `currentSectionIdx` verbatim. Neither is refused.

**FIXED** (`b162c66`). A next section equal to the one being submitted, absent from `sectionIds`, or already submitted is now rejected; `currentSectionIdx` is derived server-side. `nextSectionIdx` is still accepted and ignored so a cached client keeps working. A retry whose advance already landed is an idempotent no-op rather than an error — a dropped response must not strand a student. P-02 and P-03 green.

---

### A-03 · Sequential delivery does not enforce the section or overall clock at all

**Probe:** `P-04` · **Evidence:** `functions/src/index.ts:5108` (`submitAnswerAndAdvance`), `:5348` (`saveAnswerNoAdvance`)

In **standard** delivery, answers are a direct client write and `firestore.rules` refuse them past `answersLockedAfter`. In **linear/adaptive**, rules *forbid* direct answer writes (`studentAnswerWriteAllowed`, `firestore.rules:629`) — answers may only travel through the two callables above, which run under the Admin SDK and therefore bypass rules entirely.

Those two callables check: authentication, ownership, session, SEB, `status === 'in_progress'`, delivery mode, and whether the question is the current unlocked served one. They then compute `lateAnswer` — **against the per-question clock only** — and store the answer regardless.

They never read `answersLockedAfter`, `sectionEndsAt` or `overallEndsAt`.

**Measured.** 10-minute sections, 20-minute overall limit. Student returns **45 minutes** after starting:

- `getExamVerdict` → `kind: 'ended'` — the resolver knows the sitting is over.
- The materialised lock has long expired — standard mode would refuse.
- `saveAnswerNoAdvance` → **stored.** `submitAnswerAndAdvance` → **stored.**

```json
{"type":"mcq","value":"alpha","sectionId":"SA",
 "answeredAt":"2026-08-01T09:45:00.000Z","lateAnswer":true}
```

Both flag `lateAnswer: true` and both persist the answer, and `scoreAttemptAnswers` marks it exactly like any other. The only thing that eventually stops the student is the hourly sweep.

This inverts the security model. Linear/adaptive is the **more** controlled mode — one question at a time, no going back, the client never holds the paper — and on time enforcement it is strictly the **weaker** one.

**FIXED** (`af5c7e8`). Both callables now call one shared gate, `assertSequentialAnswerWindowOpen`, enforcing `min(section, overall)` — byte-for-byte the bound the rules enforce for standard mode. Freeze credit and penalties apply as everywhere else, and a missing bound still means unbounded. The client's `isAnswerWindowClosed` learned the new signal so a late flush reads as "your time was up", not as an unexplained failure. P-04 green.

---

### A-04 · Per-clock penalty caps overshoot in aggregate, pushing a deadline into the past

**Probe:** `P-12` · **Evidence:** `functions/src/index.ts:6429–6431`

`unfreezeAttempt` accepts deductions on all three clocks in one decision, and caps each against what that clock has left after credit:

```ts
// functions/src/index.ts:6429
addPenalty('question', clamp(wanted.questionMs, remaining(dl.questionEndsAt)));
addPenalty('section',  clamp(wanted.sectionMs,  remaining(dl.sectionEndsAt)));
addPenalty('overall',  clamp(wanted.overallMs,  remaining(dl.overallEndsAt)));
```

Each cap is correct **in isolation**. But `PENALTY_REACHES` (`examTimingCore.ts:204`) routes deductions **outward**: a section penalty is also felt by the overall clock. So the overall clock absorbs `sectionPenalty + overallPenalty`, while only the second was ever capped against it.

**Measured.** 60-minute exam, 30-minute section, frozen at `+5:00`, released at `+8:00` with 3 minutes granted and a large deduction asked on both section and overall:

- section penalty capped at 25.5 min ✅
- overall penalty capped at 55.5 min ✅
- overall clock absorbs **81 min** against 63.5 min of runway
- → `overallLockedAfter = t0 − 17:30` — **17½ minutes before the exam began.**

The student is instantly and irrecoverably out of time. `A4`'s stated promise is *"no arithmetic that can go negative"*; this is that arithmetic going negative through the door left open by `A5`.

**FIXED** (`50143da`). Caps are cumulative, innermost clock first, so the total any clock absorbs is at most what it had left. No floor was added, deliberately: with the caps right the worst case is a deadline at exactly `now`, and flooring on top would mask a deadline gone into the past for some *other* reason. P-12 green.

---

### A-05 · A live assessment's paper is editable, and grading marks against the live document

**Probe:** `P-21` · **Evidence:** `firestore.rules:571–582`, `functions/src/index.ts:3924`

The publish freeze protects exactly seven fields:

```txt
firestore.rules:571
!('securityLockedAt' in resource.data) || (
  securityTier == … && deliveryMode == … && requireCamera == … &&
  allowMobile == … && requireExtensionCheck == … && autoResume == … &&
  securityLockedAt == … )
```

`sections`, `questions`, `passingScore`, `gradingConfig`, `maxAttempts`, `endDate` and every timing field are **not** on that list. Meanwhile `gradeAttempt:3924` marks against `normalizeSections(assessment)` — the **current** document, read at grade time.

And the builder re-draws rule-based sections **at random on every save with `status: 'active'`** (`DetailsStep.tsx:493` → `resolveQuestionsForSections`, `assessmentService.ts:278`). So an ordinary edit to a running exam — fixing a typo in the title, adjusting the schedule — silently replaces the question set.

**Measured.** A student answers all three questions correctly (40/40 available). Staff re-save the live exam; the re-draw swaps `q1` for `q9`. The student then submits:

> **scores.total = 30, not 40.**

Their correct answer to `q1` is discarded — `q1` is no longer in the paper — and `q9`, which they were never shown, is counted as an unattempted blank. This applies to already-**submitted** attempts too, via `regradeAttempts` (`:4110`).

**FIXED** (`8c6b6b4`). `examSnapshot` freezes the played paper — sections, marks, order, per-section limits, breaks — onto the attempt at `startExam`, and `examContractFor` merges it over the live document everywhere grading and timing read. Legacy attempts fall through to the live doc, so nothing in flight changes on deploy. P-21 green.

---

### A-06 · A live assessment's timing is editable, and reaches students already sitting it

**Probe:** `P-22` · **Evidence:** `functions/src/index.ts:8066`, `:7475`, `firestore.rules:571`

Same root as A-05, different blast radius. `computeAttemptLocks` reads `sections[].timeLimit`, `overallTimeLimit`, `sectionGraceSeconds` and `overallGraceSeconds` from the **live** assessment on every recompute, and `toCoreAssessment` does the same for the resolver.

**Measured.** A student starts a 120-minute exam. Staff edit `overallTimeLimit` to 20. Thirty minutes in:

- `getExamVerdict` → **`kind: 'ended'`** (expected `'section'`)
- overall deadline moved from `t0 + 120:30` to **`t0 + 20:30`** — 100 minutes earlier, retroactively.

Every student mid-sitting is finalised by the next sweep, on a clock they never agreed to. The reverse is equally available: lengthening the exam hands live time to students already in it.

This directly contradicts the design note at `assessmentService.ts:755`, which explains the publish freeze as *"Once live, the security posture is what was advertised, and nobody can quietly soften it."* Timing is advertised to the student on the briefing page in exactly the same way, and is not protected.

**FIXED** (`8c6b6b4`, same change as A-05). The snapshot carries `overallTimeLimit` and all three grace knobs as well as the paper. Deliberately *not* frozen: `startDate`/`endDate` (the window is the institution's wall, and closing or extending an exam must keep working), `passingScore` and the review audiences (grading knobs `regradeAttempts` re-applies), and `blockedStudents` (an invigilation decision taken now). P-22 green.

---

## 4 · 🟡 MEDIUM severity

### A-07 · The availability window does not bound answer writes

**Probe:** `P-05` · **Evidence:** `functions/src/index.ts:7523`, `firestore.rules:754`

`resolve()` treats `endDate` as a hard outer wall (R2/A10) and `startExam` refuses entry past it. But `computeAttemptLocks` deliberately excludes it — the docstring says so: *"The WINDOW and QUESTION bounds are deliberately NOT folded in… that belongs to Phase 5."*

So between `endDate` and the student's own overall deadline, `answersLockedAfter` still reads open and the rules still allow answer writes.

**Measured.** Window shuts at `+20m`; overall clock runs to `+180m`. At `+30m`:

- `getExamVerdict` → `ended` / `window_closed` ✅
- `answersLockedAfter` = `+181m` → **answers still writable** ❌

Exposure is bounded by the sweep's 60-minute cadence, and requires a client that ignores the verdict. It is a real hole in a wall documented as hard, not a theoretical one.

**FIXED** (`d18f0c7`). The window is folded into `combined` only — the split `section`/`overall` pair keeps its meaning of *which of the student's own clocks* ran out, and a window closure is neither. `INV-3` moved with it and now expects `min(section, overall, window)`; the 13,446-state sweep still passes. P-05 green.

---

### A-08 · Negative marking penalises a partially-correct multi-select

**Probe:** `P-06` · **Evidence:** `functions/src/index.ts:3435`, `3704–3708`

The rule is stated in the code, unambiguously:

```ts
// functions/src/index.ts:3704
// Option A: negative marking applies ONLY to a FULLY wrong answer
// (multiplier 0). Any correct/partial content keeps its positive award
// untouched — negative marking and partial credit stay cleanly separated.
const award = multiplier > 0 ? multiplier * aq.marks : -penaltyFor(policy, aq.marks);
```

For multi-select, `multiplier` is `max(0, (hits − wrongs) / |correct|)` (`:3435`). **`multiplier === 0` is not the same as "fully wrong"** — it is also every answer where right and wrong selections cancel.

**Measured.** Correct = `{alpha, beta}`, 10 marks, fixed penalty 5. Student selects `alpha` (right) and `gamma` (wrong):

> `marksAwarded = −5` — the identical penalty a student who selected only wrong options receives.

A student who knew half the answer is scored the same as one who knew none, and worse than one who left it blank (`blankScore`, 0). The `match` engine (`:3455`) does *not* have this problem — `correct/total` is only 0 when nothing matched — so the two engines apply different rules under one policy.

**FIXED** (`b2ddd62`). The scorers return `anyCorrect` alongside the multiplier, and the rule is expressed once in `awardFor()` rather than duplicated per engine — the defect was two copies of one rule drifting from the sentence above them. A cancelling answer now scores 0; only an answer with nothing right takes the penalty. P-06 green.

---

## 5 · 🟢 LOW severity

### A-09 · `gradeAttempt` writes caller-named section-timing keys

**Probe:** `P-07` · **Evidence:** `functions/src/index.ts:3964–3966`

`lastSectionId` and `lastSectionTimeUsed` come from `request.data` and are written as dot-paths with no membership check. `lastSectionId: 'NOT_A_SECTION', lastSectionTimeUsed: 999999` produces a `sectionTimings.NOT_A_SECTION` row on the finalised attempt. Cosmetic — the attempt is terminal and nothing reads unknown keys — but it is unvalidated caller input shaping stored state, and it pollutes any later analytics over `sectionTimings`.

**FIXED.** The id is checked against the attempt's own `sectionIds`, and the duration is floored at 0. A bad id is dropped and logged rather than throwing: this is the tail of a finalise that has already graded the paper, and failing a submission over a bookkeeping field would cost the student far more than the defect does. P-07 green.

### A-10 · `questionGraceSeconds` is a dead knob

**Evidence:** `assessmentService.ts:509`; consumed at `index.ts:5197`, `5454`, `6244`, `7606`, `examTimingCore.ts:635`, `ExamShell.tsx:2272`

D-14's fix was *"one number, consumed by BOTH sides… and it is configurable per assessment."* Six sites read it. **No authoring UI writes it** — `DetailsStep.tsx`'s save payload carries `sectionGraceSeconds` and `overallGraceSeconds` and not this one. Every exam therefore runs on the hardcoded 5-second default, and the configurability is notional.

**FIXED.** A "Question grace period" field now sits beside the other two grace knobs in the builder, shown only for sequential delivery — standard mode has no per-question clock for it to extend, so a standard exam does not store a number nothing will read.

---

## 6 · ⚠️ Contradictions — where the description and the system disagree

These are not bugs in the running code. They are places where somebody reading the repo would form a false belief, and act on it.

| # | Where | What it says | What ships |
|---|---|---|---|
| **C-1** | `DetailsStep.tsx:1181` | Linear: *"One question at a time, no going back. **(Enforcement lands in a later phase.)**"* | Fully enforced today. `startExam:7198` serves one question; `submitAnswerAndAdvance:5158` refuses any locked or non-current question; `firestore.rules:629` blocks direct answer writes. An author choosing Linear believing it inert ships a genuinely one-way exam. **FIXED** — the copy now says it is enforced by the server. |
| **C-2** | `DetailsStep.tsx:1183` | Adaptive: *"difficulty adapts to performance"* | No adaptation exists. `submitAnswerAndAdvance:5229` picks `orderForSection.find(qid => !served.has(qid))` — plain order. Adaptive is linear with a different label. `index.ts:7186` admits it: *"adaptive: same as linear (ladder picks the next) — Phase 2.5 Stage 4."* **FIXED** — the copy now states it is identical to Linear and that adaptation is not implemented. |
| **C-3** | `DetailsStep.tsx:33` | — | `sanitizeGradingConfig` **silently discards the entire negative-marking policy** when delivery mode is `adaptive`. An author who configures penalties and then switches mode loses the configuration with no warning. **FIXED** — selecting Adaptive now shows a warning saying the policy will be discarded and pointing at Linear. |
| **C-4** | `index.ts:7446` | *"FREEZE IS DELIBERATELY NOT CREDITED… the server ignores freeze"* | Superseded 80 lines later by the Phase 4.3 block at `:7527` which credits **and** penalises. Both texts remain, the first argues against what the function now does. **FIXED** — the superseded paragraph is removed rather than left standing beside the code that contradicts it. |
| **C-5** | `index.ts:5319` | *"including the same `qLimit + 5` latency grace"* | The code uses configurable `questionGraceSeconds` (`:5453`). Stale by one refactor. **FIXED** — and the note now also distinguishes the question clock (flag, never reject) from the section/overall clocks (refuse, per A-03). |
| **C-6** | `AUDIT_REPORT.md` M1 | Treats `CLAUDE.md` as *"the primary AI navigation aid"* and prescribes rewriting §3/§8 | **There is no `CLAUDE.md` anywhere in the repository.** The prior audit's highest-leverage recommendation targets a file that does not exist. **FIXED** — M1 is annotated as not actionable and struck from that report's action list, with its claims kept as a checklist should a navigation aid be reintroduced. |

Also noted: `new-file.tsx` (0 bytes) is committed at the repository root. Left in place — deleting a file nobody asked about is not this audit's call to make.

---

## 7 · ✅ Verified working — 12 probes green

These were attacked and held. They are as much a part of the audit as the failures.

| Probe | Property |
|---|---|
| **P-08** | Terminate is idempotent — a student cannot re-terminate their own finished attempt to inject attacker-chosen reason text; the original reason survives. Attempt limits count terminations, and `maxAttempts` is enforced across sittings. |
| **P-09** | **Escape mid-exam.** A student who vanishes past their section deadline is *advanced*, never ended. Their earlier answers are intact; the late submit closes the section **at its own deadline** (not the late arrival instant, so no free time), starts the next section in the same write, and re-anchors the lock. D-01 stays fixed. |
| **P-10** | **Escape while submitting.** A tab that dies between `submitSection` and `gradeAttempt` leaves a live attempt with no sections remaining. No further answers are writable, the resolver calls it `ended`, and the sweep finalises **and grades** it (INV-10). |
| **P-11** | **Passive vs frozen are distinguishable.** An idle student stays `in_progress` with no `frozenAt` and their clocks keep running; a paused one is `status: 'frozen'` with exactly one open ledger entry, cannot submit a section, and cannot finalise their own sitting (`ATTEMPT_PAUSED`). A late heartbeat is accepted and changes no state. |
| **P-12**¹ | Every penalty row carries an actor and an instant, and each is capped against its own clock. (¹ the aggregate cap is A-04.) |
| **P-13** | **Grace.** Configured `sectionGraceSeconds: 90` / `overallGraceSeconds: 120` beat the 30s defaults in the materialised lock. A submit 30s past the limit lands inside grace; one past limit+grace is refused **and the section is still closed**, so a late student cannot get stuck. |
| **P-14** | **Mandatory breaks cannot be skipped.** The server refuses to auto-start the next section even when the client claims no pause is needed, and `startSection` refuses entry until the break has elapsed. |
| **P-15** | **Dual device.** The opening session owns the attempt from birth; a second device is recorded as a conflict server-side; the superseded device cannot submit a section (`SESSION_SUPERSEDED`) while the current one can. |
| **P-16** | **Question secrecy.** No answer key on `getExamQuestions`, none on the advance-served question, none on a live attempt document. `sanitizeQuestionForStudent` zeroes `correctIds` / `correctPairs` / `modelAnswer`. |
| **P-17** | **The sweep advances rather than ends.** A student whose section expired but who still has a section to sit is left open (`verdict=section — student still has somewhere to go`); once the overall clock is gone they are closed **and graded**. D-24 stays fixed. |
| **P-18** | **Security config is frozen onto the attempt.** Flipping a live exam to `high_stake` + `requireSEB` mid-sitting does not affect the student already in it; the frozen snapshot is unchanged and their next transition succeeds. |
| **P-19** | **student_choice.** Nothing auto-starts; a chosen section opens; a second section cannot be opened alongside the first (`SECTION_STILL_OPEN`, INV-1); a reorder that moves an already-played section is refused. |
| **P-20** | **Block mid-sitting.** A blocked student cannot start the next section, and cannot open a new sitting at all. |

Beyond the probes, these were read and confirmed sound: the SEB gate fails **closed** on a missing secret and binds the proof to `uid` + `assessmentId` (`:5664`); `logViolation` is append-only and server-incremented, so a student cannot erase their own record; `registerSession` is transactional; `startExam` creates attempts inside a transaction scoped to one student's attempts, so a double-click cannot mint two live sittings; the extension-check freeze now opens the *same* ledger entry as an invigilator freeze, so both pause the server clocks; and rule-based question selection is gated on `validateSelectionRules` before publish.

---

## 8 · Order of action taken

All ten defects were fixed in the order below — highest leverage first, each in its own commit, each verified by re-running all four suites before moving on.

1. **A-01** `89c75ed` — one line. A recorded human decision had been evaporating on the next section advance.
2. **A-02** `b162c66` — an open time-limit bypass reachable from the console.
3. **A-03** `af5c7e8` — until this, linear/adaptive was untimed at the answer layer.
4. **A-05 / A-06** `8c6b6b4` — staff-triggered, silent, and cohort-wide.
5. **A-04** `50143da` — cumulative caps, innermost clock first.
6. **A-08** `b2ddd62` — the code now agrees with its own comment.
7. **A-07** `d18f0c7` — the Phase 5 step the source had already named.
8. **A-09 / A-10 / C-1…C-6** — validation, the missing grace knob, and the copy that described a different system.

---

## 9 · Reproducing this audit

```bash
cd functions
npm install
npm run build

npm run test:timing          # 13,446 states — green
node test/freeze.suite.cjs   # 15 scenarios — green
node test/exam.e2e.cjs       # 10 scenarios — green

node test/audit.probe.cjs    # 22 probes — 16 red across the 10 defects above
PROBE_TRACE=1 node test/audit.probe.cjs   # with stack traces
```

`audit.probe.cjs` is written so that **each red mark disappears when, and only when, the defect it names is fixed.** It is intended to be kept and run alongside the other three suites, not deleted once read.

---

<sub>Audit performed against commit `62bf880`. Every finding traced to a `file:line` reference and reproduced by an executable probe driving the compiled production handlers.</sub>