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
>
> ## 🔁 ROUND 4 (2026-08-15) — the pause, and the second door into it
>
> Rounds 2 and 3 unified the freeze. **F6** gave both entrances one shape — one ledger entry, one `status: 'frozen'`, one set of legacy mirrors. **F4/F7** then made `unfreezeAttempt`'s release the single implementation of *"the pause is over"*, and routed `verifyAndResume` through it so that *"the invigilator path and the system path cannot reach different state"*.
>
> They share the **write**. Round 4 asked whether they share the **decision** and the **consequences**. They did not.
>
> | # | Defect | Measured |
> |---|---|---|
> | **C-01** | `verifyAndResume` never asks `assertCanUnfreeze` | a **student cleared a faculty member's deliberate pause**; a peer invigilator cleared a colleague's; no audit row either way |
> | **C-02** | the automatic release grants the whole pause, every time, with no ceiling | a student-driven `freeze → wait → resume` loop moved a 60-minute exam's deadline **+80 minutes** in two cycles |
> | **C-03** | only one of the two releases deletes the provisional grade | a **stale mark survived on a live attempt** the student went on answering |
> | **C-04** | `saveAnswerNoAdvance` accepts a frozen attempt without bound | a student **frozen at 9:01 of a 30-minute section was still writing answers into it at 9:41** |
>
> **The shape of this round.** Round 3's was *"one fix, four readers it did not reach."* This one is narrower and sharper: **one rule, expressed once, and a second caller that never asked it.** `assertCanUnfreeze` is the §3/§8 authority ladder — written down, commented at length, and called from exactly one of the two functions that end a pause. The same is true of the provisional-grade deletion, of the audit row, and of the transaction.
>
> What makes all three reachable is that `lastExtensionCheck.passed` is **not a fact about the machine**. It is written by the student's own `reportExtensionCheck` call, with the value their client chose.
>
> Round 3's B-09 is named *"verifyAndResume honours the auto-resume policy"* and reaches none of this: it seeds the `mock` tier, where `requireExtensionCheck` is false, so nothing ever freezes and the probe asserts a constant. That is where C-01, C-02 and C-03 were sitting.
>
> New suite `functions/test/audit.round4.cjs` (5 probes / 65 checks) plus `X-05` in the emulator-backed concurrency suite, both wired into `npm test`. Every suite green: **13,446 timing states · 84,062 assertions · 64 freeze · 85 e2e · 111 round-2 · 63 round-3 · 65 round-4 · 157 grading · 91 manual · 51 risk**.
>
> Written up in full at **[§10](#10--round-4-2026-08-15--the-pause-and-the-second-door-into-it)**.
>
> ## 🔁 ROUND 5 (2026-08-15) — the surface that never inherited the rules
>
> Rounds 2–4 went at the exam itself. Along the way every student-facing exam callable acquired the same gates, and by now the list reads like a contract: **`assertSession`** (one sitting, one browser — INV-5a), **`assertNotBlocked`** (a block stops the sitting, not just a reload — D-21), **`assertSEB`** (the exam-taker is inside Safe Exam Browser).
>
> `startExam`, `startSection`, `submitSection`, `submitAnswerAndAdvance`, `saveAnswerNoAdvance`, `getExamVerdict`, `gradeAttempt`, `getExamQuestions`, `logViolation`, `examHeartbeat`, `reportExtensionCheck` and `verifyAndResume` all carry the ones that apply to them. **The coding surface carried none of them.**
>
> | # | Defect | Measured |
> |---|---|---|
> | **D-01** | `runCodeSample` / `recordCodeTelemetry` never called `assertSession` | a **superseded device kept running code on the candidate's quota, and kept appending to their evidence log** |
> | **D-02** | neither called `assertNotBlocked` | a **blocked student could still spend judge capacity and still write telemetry** |
> | **D-03** | `recordCodeTelemetry` never checked `questionId` against the paper | `NOT_A_QUESTION` created a real `attemptTelemetry` row no attempt can explain |
>
> `runCodeSample` and `recordCodeTelemetry` were written later, for the judge pipeline, and inherited the gates that were obvious at the time — ownership, status, freeze, the answer window, the paper. The three above were never added. That is round 3's shape again: **a rule that is right everywhere it was written, and absent where it was not.**
>
> **SEB is deliberately still open**, and was before this round: `submissionService.ts` says so in writing — *"Deliberately NOT wrapped in withSeb, matching the server… Worth revisiting… but the exposure is small, since a run returns only sample results the candidate can already see inside SEB."* That reasoning holds for `runCodeSample` and is weaker for telemetry. Left as the documented deferral it already is, rather than changed under cover of this round — see [§11.5](#115--what-this-round-deliberately-did-not-close).
>
> New suite `functions/test/audit.round5.cjs`, 4 probes / 30 checks, wired into `npm test`.
>
> Written up in full at **[§11](#11--round-5-2026-08-15--the-surface-that-never-inherited-the-rules)**.

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

---

# 10 · ROUND 4 (2026-08-15) — the pause, and the second door into it

> **Scope:** the freeze — who may end one, what ending one hands back, what has to be true afterwards, and what a student may do while one is open.
> **Method:** unchanged. `functions/test/audit.round4.cjs` drives the compiled production callables (`functions/lib/index.js`) against an in-memory Firestore and a virtual clock. Every number below was written by a real handler.
> **Result:** 5 probes, **13 red across 4 distinct defects**, all four now fixed and green. The eleven pre-existing suites were green before and after.

## 10.1 · Why here

Round 2 froze the paper and the clocks onto the attempt. Round 3 went at the readers round 2 had not reached. Round 4 went at the thing rounds 2 and 3 **built**: the unified freeze.

The unification was real and it was good. **F6** collapsed two freeze mechanisms with different shapes into one — one ledger entry, one `status: 'frozen'`, one set of legacy mirrors — and put the difference between them where it belongs, in `reason`. **F4/F7** made `closeFreezeUpdates` the single implementation of *"the pause is over"*, and its own comment states the goal:

> `verifyAndResume` performs the same release through the same function, so the invigilator path and the system path **cannot reach different state** (F4 / F7).

That is true of the **write**. It is not true of the **decision that authorises the write**, nor of the **things that must also happen** when a pause ends. Sharing an implementation makes two callers agree about *what is written*; it says nothing about what each of them checked first, or cleaned up after. Four separate defects lived in that gap, and they compose: the same student, on the same ordinary configuration, could end a pause they were never entitled to end, be paid for it, leave a stale mark behind, and keep writing answers throughout.

**One configuration reaches all four**, and it is not exotic: `securityTier: 'normal'` with **auto-resume** enabled. On that tier `requireExtensionCheck` defaults **on**, so the automatic freeze is armed; auto-resume is the author's choice in the builder. (`mock` cannot freeze — `requireExtensionCheck` is false — and `startExam:9256` forces auto-resume **off** for `high_stake` regardless of what the document says. Normal is the tier where both are live at once.)

## 10.2 · The enabler, stated once

Three of the four defects rest on one fact:

> **`lastExtensionCheck.passed` is not a measurement. It is a value the student's own client chose.**

`reportExtensionCheck` (`index.ts:6473`) takes `passed` from `request.data` and stores it. That is unavoidable — the check runs in the student's browser, and a browser can lie. The design already accepts the lie in one direction: a student who hides an extension reports `passed: true` and the server cannot know. What was not noticed is that the **other** direction is also available, and is worth more:

- `reportExtensionCheck({ passed: false })` → **the student pauses their own sitting**, stopping every server clock.
- `reportExtensionCheck({ passed: true })` → **the student satisfies the only condition `verifyAndResume` checked before releasing it.**

A field the subject of a measurement can write is not a measurement — the comment above `registerSession` (`:7783`) says exactly this about `activeSessionId`. The same sentence applies here and had not been applied.

---

## 10.3 · 🔴 C-01 · The authority ladder has a second door, and it is unlocked

**Probe:** `C-01` · **Evidence:** `index.ts:6617` (`verifyAndResume`), `:8277` (`assertCanUnfreeze`), `:8996` (`unfreezeAttempt`'s call to it)

§3/§8 attach authority to the individual pause, and `assertCanUnfreeze` is that rule written down:

```txt
Frozen by          Cleared by
faculty            that faculty · their institute admin · web owner
institute admin    that institute admin · web owner
web owner          that web owner only
system / extension any invigilator
```

> **NEVER A PEER.** Two faculty at the same institute cannot undo each other's decisions — the whole reason authority is recorded is that a pause is a judgement about a student, and one colleague overruling another silently is the thing this prevents.

`unfreezeAttempt` reads it from the open ledger entry, inside its transaction, before anything is written. `verifyAndResume` ends the same pause, through the same `closeFreezeUpdates`, and **never called it**. It asked two other questions:

```ts
// the whole of the old admission test, as it stood before this round
const autoResume   = a.securityConfig?.autoResume === true;
const latestPassed = a.lastExtensionCheck?.passed === true;
const mayResume = isInvigilator || (isStudentOwner && autoResume && latestPassed);
```

Neither says anything about **who paused this sitting, or why**. So both halves of the ladder were reachable from the wrong side.

**Measured.** Faculty `fac_1` pauses a sitting with `reason: 'suspected phone use'`. The ledger entry records `reason: 'invigilator'`, `frozenByRole: 'faculty'`.

| Caller | `unfreezeAttempt` | `verifyAndResume` |
|---|---|---|
| the student, having posted `passed: true` | *not reachable — students cannot call it* | ✅ **resumed** |
| `fac_2`, a peer | ❌ `FREEZE_AUTHORITY` | ✅ **resumed** |
| `fac_1`, the freezer | ✅ resumed | ✅ resumed |

An invigilator's deliberate pause — an act with a named human, a timestamp, a reason string and an `attemptFrozen` audit row — was undone by its own subject, in one call, with no refusal.

**And no record of the undoing.** `freezeAttempt` writes `attemptFrozen`; `unfreezeAttempt` writes `attemptUnfrozen`. `verifyAndResume` wrote **neither**, so a pause could begin with an audit row and end without one — including when an invigilator ended it here, which is the same act `unfreezeAttempt` records.

**FIXED** (`d0b2e46`). The only question a student is now asked is the one that is theirs to answer: was this pause one nobody chose (`reason` of `extension_check` or `system` — the same ownerless set `assertCanUnfreeze` already recognises)? Staff go through `assertCanUnfreeze` itself. Legacy pre-ledger pauses are classified by which path wrote which field, and a pause that cannot be classified is treated as a human's, because that is the direction that cannot invent authority.

Two things came with it, both of which `unfreezeAttempt` already had:

- **The release is transactional.** `closeFreezeUpdates` rebuilds the whole `freezes` array from the document it was handed and writes it back wholesale, so a plain read-then-`update()` drops any entry appended in between — the exact hazard `reportExtensionCheck` was made transactional to avoid ("*an append read-modify-written outside a transaction can lose a concurrent entry*").
- **The release leaves a record**, automatic clearances included, and names them as such. *"Nobody decided this"* is itself the fact a reviewer needs.

---

## 10.4 · 🔴 C-02 · Self-service resume mints time without bound

**Probe:** `C-02` · **Evidence:** `index.ts:6756` (the grant, now budgeted), `:6473` (`reportExtensionCheck` — who opens the pause)

`verifyAndResume` granted the **whole pause, every time, with no ceiling**, and the reasoning was sound as far as it went — doctrine D8, an automatic state needs an automatic exit in the student's favour:

> Nobody decided this one: an automated check paused the student. […] An invigilator who judges the pause the student's own fault can still deduct it with `unfreezeAttempt`'s penalties.

The premise is that the pause is something that *happened to* the student. §10.2 is why it is not. The student opens the pause and the student satisfies the release condition, so the loop

```
report failed → think for as long as you like → report passed → verifyAndResume
```

returns exactly the time it consumed, and can be run again.

**Measured.** 60-minute exam, born with `overallLockedAfter = t0 + 60:30`.

| Moment | Overall deadline | |
|---|---|---|
| Birth | `t0 + 60:30` | |
| After one self-declared 40-minute pause | `t0 + 100:30` | ❌ **+40 min** |
| After a second | `t0 + 140:30` | ❌ **+80 min, and repeatable** |

That is not a grace period. It is an exam with no overall time limit, reachable from the console by the person being examined — and the deduction remedy the comment points at requires an invigilator to notice a pause that has already ended.

**FIXED** (`63968c9`). **Ten minutes, cumulative, per sitting.** Generous against the case the grant exists for — an antivirus false positive, cleared in seconds once the student closes the offending extension — and finite against the loop. The budget is per **sitting** rather than per pause deliberately: a per-pause cap does not make the loop terminate.

**What is not capped:** an invigilator's grant, here or in `unfreezeAttempt`. A human deciding a pause was genuine can still return all of it, and that decision carries an actor, an instant and an audit row — the three things the automatic path cannot produce. A student who really did lose half an hour is not refused the time; they are asked to get it from someone who can be accountable for giving it.

**The pause is still measured in full.** `elapsedMs` on the ledger row is the wall-clock truth, `grantedMs` is what was given, and a capped row says so in its note. Capping a grant must never falsify the record an invigilator reviews afterwards. `autoGranted` is recorded on the row rather than inferred from a null decider, because `preLedgerCreditEntry`'s synthetic migration row also has no decider and is not an automatic release of anything.

---

## 10.5 · 🟡 C-03 · A provisional grade outlives the pause that justified it

**Probe:** `C-03` · **Evidence:** `index.ts:8718` (the design note), `:9036` (the deletion that was the only one), `:6801` (the one that was missing)

A9 rules out storing a provisional score on the attempt — *"a stale score sitting on a live attempt is exactly the quiet wrongness this whole project has been about"* — and `gradeProvisional` solves it with a sibling document. Its design note says why that is safe:

> `unfreezeAttempt` deletes the row, so the grade cannot outlive the pause that justified it. **Invalidation is not a cleanup step someone must remember** — the score has nowhere to go stale.

It is a cleanup step someone must remember, and only one of the two releases remembered.

**Measured.** Student answers `q1`, is paused by the extension check, an invigilator takes a provisional grade (`10 / 40`, stamped with the open `freezeId`). The student clears their own pause and carries on:

- attempt → `in_progress`, answering again ✅
- `provisionalGrades/{attemptId}` → **still there**, still `10 / 40`, still stamped with a `freezeId` that is no longer open ❌

Staff surfaces read that row. The guarantee A9 bought by choosing a storage shape instead of a discipline only holds if **every** writer of the state shares it.

**FIXED** (`a3cbbb1`). Deleted in the same transaction as the release, for the same reason `unfreezeAttempt` does it there: a failure between the two leaves a stale grade on a running attempt. The design note is corrected too, rather than left describing a guarantee one function short of being true.

---

## 10.6 · 🔴 C-04 · A paused student can keep writing answers, with the clock stopped

**Probe:** `C-04` · **Evidence:** `index.ts:7260` (`saveAnswerNoAdvance`'s status gate), `:8467` (F5)

F5 named the rule when it moved a frozen sitting to `status: 'frozen'`:

> A pause is a state the student cannot write from. […] A pause that stops the clock but not the student is an **unbounded time grant** to anyone willing to call the callable directly.

Every write path obeys it except one:

| Path | A paused attempt |
|---|---|
| standard-mode direct write | ❌ refused — `firestore.rules` require `in_progress` on both sides |
| `submitAnswerAndAdvance` | ❌ refused — `status !== 'in_progress'` |
| `runCodeSample` | ❌ refused — *"Running code during a freeze would be doing the exam while the clock is stopped"* |
| `recordCodeTelemetry` | ❌ refused — `status !== 'in_progress'` |
| **`saveAnswerNoAdvance`** | ✅ **accepted, without limit** |

The allowance is deliberate and the reason is good: the client learns of a freeze through its Firestore subscription, so a flush already in flight lands *just after* the pause, and refusing it would fail the one call that exists to save the answer in front of a student being paused.

**What was never bounded is how long "just after" lasts.** And the window was not merely open, it was **untimed**: `effectiveNowMs` pins the resolver's clock at the freeze, so `assertSequentialAnswerWindowOpen` — the A-03 gate, right below — cannot refuse a paused student either.

**Measured.** Linear delivery, 30-minute section. Invigilator freezes at `+1:00`. At `+41:00`, still paused, still frozen:

- `saveAnswerNoAdvance({ value: 'beta' })` → **stored**, and `scoreAttemptAnswers` marks it like any other answer.

This is **A-03's shape in the same place**: sequential delivery, the *more* controlled mode, is the weaker one. It also leaves an asymmetry that is worst exactly where it matters most — on a coding paper, the answer kept changing while `recordCodeTelemetry` refused every event, so the record of how the answer was produced had a hole precisely where the answer changed.

**FIXED** (`e32e070`). **One minute**, measured from the start of the open pause: long enough for a debounced flush, a 6s client timeout and a slow subscription; far short of working through a pause. A student whose subscription is broken for longer loses edits made after it broke, and that is the right side to fail on — the alternative is the exam continuing for whoever can keep a tab open. A legacy pause with no ledger entry falls back to `frozenAt`, and an unreadable start instant still allows the write: *a missing bound is not an expired bound*. The shell learned the new refusal exactly as it learned `ANSWER_WINDOW_CLOSED` for A-03, so an expected refusal is not reported as a broken save.

---

## 10.7 · ✅ Verified working — and one probe corrected

`C-05` is the other half of every fix above: the ordinary case must still work.

| Probe | Property |
|---|---|
| **C-05** | A genuine 90-second extension freeze is still self-cleared by the student, **granted in full**, with the deadline moving by exactly what the pause cost them, `freezeState`/`resumeRequiresVerification` cleared and the legacy `frozenAt` mirror deleted. With auto-resume **off**, the student still cannot self-resume (`RESUME_BLOCKED`) and stays paused until staff act. An in-flight flush arriving 2 seconds after a pause is still saved. An invigilator can still grant a full 20-minute pause through `unfreezeAttempt` — the C-02 ceiling binds the automatic path only. |

**One probe was corrected rather than reported.** Round 3's `B-09`, *"verifyAndResume honours the auto-resume policy"*, seeds `securityTier: 'mock'` — on which `requireExtensionCheck` is false, so `reportExtensionCheck` never froze anything and the probe fell through to its own `'extension check did not freeze'` branch and asserted a constant. It has never exercised the auto-resume path it is named for. That is where C-01, C-02 and C-03 were. It is annotated in place rather than deleted — it still proves the mock tier does not freeze, and a probe whose blind spot is written down is worth more than one quietly removed. `C-05` covers its stated intent on a tier where the freeze actually happens.

**The transactional half, proved where it can be.** `fakeFirestore` commits transactions with no read set, so `audit.round4.cjs` passes whether or not the release is transactional — the same honest limitation round 3 recorded for B-13/B-14. It is covered instead by a new scenario in the emulator-backed suite:

| Probe | Property |
|---|---|
| **X-05** (`concurrency.suite.cjs`) | An invigilator granting **zero** races the student's auto-resume granting **everything**. Exactly one release must survive, the ledger must hold one closed entry, `creditedFreezeMs` must equal what that release decided, and one release must produce one audit row. |

Against the pre-fix handler X-05 measures **both taking effect** — `expected 1, got 2` — with the non-transactional automatic full grant landing on top of the human's zero-grant decision. That is F4's shape one more time: two writers, one field, and credit moving for a reason nobody authorised.

## 10.8 · ⚠️ Contradiction found and closed

| # | Where | What it said | What shipped |
|---|---|---|---|
| **C-7** | `index.ts:7260` (`saveAnswerNoAdvance`) | *"freezeAttempt opens a ledger entry and leaves `status` at `'in_progress'`, while reportExtensionCheck writes `status:'frozen'`"* | Superseded by **F5** in round 3, which moved *both* paths to `status: 'frozen'` — the comment justified the frozen allowance with a distinction that no longer exists. **FIXED** as part of C-04; the note now explains the allowance in terms of the in-flight flush, which is the reason that is still true. |

## 10.9 · Order of action taken

Each defect in its own commit, all suites re-run before moving on.

1. **C-01** `d0b2e46` — the authority ladder, the transaction and the audit row.
2. **C-02** `63968c9` — a budget for the automatic grant.
3. **C-03** `a3cbbb1` — the provisional grade dies with its pause, on both releases.
4. **C-04** `e32e070` — a pause a student can write into is not a pause.

## 10.10 · Reproducing round 4

```bash
cd functions
npm install
npm run build

node test/audit.round4.cjs              # 5 probes — green
PROBE_TRACE=1 node test/audit.round4.cjs

npm run test:concurrency                # X-05, the emulator half of C-01
npm test                                # every suite, round 4 included
```

Reverting any one of the four commits turns exactly the probe that names it red, and nothing else. Building the pre-round-4 `index.ts` and running the concurrency suite reproduces X-05's failure directly.

Deployment: functions only — no rules, no indexes, no migration. `autoGranted` is a new optional field on freeze ledger rows written from this deploy onward; attempts frozen before it read as `undefined`, which sums to zero spent budget, so a sitting in flight is unaffected.

---

<sub>Round 4 performed against commit `309ecb0`. Every finding traced to a `file:line` reference and reproduced by an executable probe driving the compiled production handlers.</sub>

---

# 11 · ROUND 5 (2026-08-15) — the surface that never inherited the rules

> **Scope:** the coding callables — `runCodeSample` and `recordCodeTelemetry` — measured against the gate contract every other student-facing exam callable satisfies.
> **Method:** unchanged. `functions/test/audit.round5.cjs`, real compiled callables, in-memory Firestore, virtual clock. The judge is the `NullJudgeAdapter` (`JUDGE0_BASE_URL` unset), which is exactly right: these probes ask whether a call is **refused**, not what the judge said about the code.
> **Result:** 4 probes, **10 red across 3 defects**, all fixed and green. Every other suite green before and after.

## 11.1 · Why here

Round 4 ended on a note it did not follow up. C-04's evidence included this:

> `recordCodeTelemetry` refuses a paused attempt too. That last one is the sharpest: on a coding paper the answer went on changing while the record of how it was produced had a hole exactly there.

That observation was about the **freeze**. It is also a hint about the **surface** — the coding callables were being compared against the exam's rules for the first time, and one comparison had already come out uneven. So this round did the comparison properly, by listing the gates every exam callable applies and checking the two newest ones against the list.

| Gate | What it enforces | Coding surface, before this round |
|---|---|---|
| `assertSession` | INV-5a — one sitting, one browser session | ❌ absent from both |
| `assertNotBlocked` | D-21 — a block stops the sitting, not just a reload | ❌ absent from both |
| `assertSEB` | Phase 3 — the exam-taker is inside SEB | ❌ absent from both, **deliberately** (§11.5) |
| ownership / status / freeze / window / paper | rounds 2–4 | ✅ present |

The last row is why this was not obvious. Both callables look careful, because they are: `runCodeSample` checks ownership, refuses a terminal attempt, refuses an open freeze, reads `answersLockedAfter`, resolves the paper through `examContractFor`, enforces the author's language list and meters the run. It reads as a function somebody thought hard about. It was simply written against a different, older list.

## 11.2 · 🔴 D-01 · The judge and the keystroke log did not know about sessions

**Probe:** `D-01` · **Evidence:** `index.ts:13104` (`runCodeSample`), `:12965` (`recordCodeTelemetry`), `:10355` (`assertSession`)

INV-5a: `registerSession` makes the **joining** device the owner — "first device wins" would strand a student whose browser crashed — and records the conflict server-side where a student cannot suppress it. Every exam callable then refuses the loser. `P-15` proves that for `submitSection`.

**Measured.** Device A opens the sitting; device B joins and takes it. Device A then:

| Call | Before | After |
|---|---|---|
| `submitSection` | ❌ `SESSION_SUPERSEDED` | ❌ `SESSION_SUPERSEDED` |
| `runCodeSample` | ✅ **ran the code** | ❌ `SESSION_SUPERSEDED` |
| `recordCodeTelemetry` | ✅ **wrote a row** | ❌ `SESSION_SUPERSEDED` |

Two consequences, and the second is worse.

**The superseded device keeps the judge.** `runCodeSample`'s own comment refuses staff because *"there is no reason for staff to execute a student's code through the student's quota"* — and a quota is exactly what a second browser spends. Sample runs are metered: `maxPerQuestion`, a cooldown, real compute on a shared cluster. A device that lost the session reaching this is a second person working the paper on the candidate's allowance.

**The superseded device keeps writing the evidence.** `recordCodeTelemetry` refuses a *finished* attempt with this reasoning:

> A finished attempt cannot acquire new telemetry — that would let a record be extended after the fact, which is exactly what an append-only log is supposed to prevent.

A device that lost the session extends it in precisely that way, and its rows are **indistinguishable from the real candidate's**. That is worse than a missing record, because it still looks authoritative.

**FIXED** (`e2f7d59`). Both callables call `assertSession`, and both clients send the `sessionId` they already hold — the module-level value `registerSession` owns, spread exactly as every other exam call spreads it. A client that sends none is still served while `REQUIRE_SESSION_ID` is false, so a stale bundle is not stranded; `D-04` asserts that explicitly.

## 11.3 · 🟡 D-02 · A block stops the exam, but not the compiler

**Probe:** `D-02` · **Evidence:** `index.ts:10398` (`assertNotBlocked`)

D-21 settled that a block must stop the sitting **advancing**, not merely a reload, which is why `assertNotBlocked` sits on both answer paths and both section transitions. Round 3's `B-12` then established that `blockedStudents` is *the* live lever: de-allocating a student mid-sitting deliberately does **not** eject them, so this list is the whole of the mechanism an invigilator has.

**Measured.** Invigilator blocks a student mid-sitting. They cannot answer, cannot advance, cannot submit — and:

- `runCodeSample` → **ran** ❌
- `recordCodeTelemetry` → **stored** ❌

**FIXED** (`71f3f65`). Both call `assertNotBlocked`, from the assessment document each already loads, so neither costs an extra read. On telemetry it runs **before** the `enabled` early-return, so a blocked student is refused whether or not that exam records anything. Both read `blockedStudents` from the **live** document rather than the snapshot — which is precisely why `examContractFor` leaves it out of the frozen contract.

## 11.4 · 🟢 D-03 · Telemetry accepted a question that was not on the paper

**Probe:** `D-03` · **Evidence:** `index.ts:13089` (the chunk write)

A-09's shape, in the collection built after it. The chunk id is

```
attemptTelemetry/{attemptId}__{questionId}__{seq}
```

and `questionId` arrived straight from `request.data` with nothing checked.

**Measured.** `recordCodeTelemetry({ questionId: 'NOT_A_QUESTION' })` created

```
attempt_…__NOT_A_QUESTION__0000
```

— a real document, in the collection reviewers read, that no attempt can explain. Meanwhile `runCodeSample`, its sibling, on the same paper, in the same file, already refused the same input: *"That question is not on your paper."*

Nothing is stolen by this. It is unvalidated caller input shaping stored state, which is exactly what A-09 was fixed for.

**FIXED** (`71f3f65`). Checked against the attempt's own contract via `examContractFor`, not the live paper — so a question added to a live exam is not writable by a student who never received it. The two siblings now agree, and the client swallows telemetry failures by design, so no candidate ever sees the refusal.

## 11.5 · What this round deliberately did **not** close

`assertSEB` is the third gate, and it is still absent from both coding callables. That is **not** an oversight — the codebase says so, at `submissionService.ts:1044`:

> Deliberately NOT wrapped in `withSeb`, matching the server: `runCodeSample` does not verify a SEB token today. **Worth revisiting** — the platform's posture is that SEB binds the exam-taker — but the exposure is small, since a run returns only sample results the candidate can already see inside SEB.

The exposure argument holds for `runCodeSample` and is **weaker for telemetry**, which is evidence rather than feedback. It is left as the documented deferral it already is rather than changed under cover of this round, for a reason worth stating plainly: closing it means adding `SEB_SIGNING_SECRET` to both callables and a `withSeb` wrapper to both clients, and `assertSEB` **fails closed on a missing secret** by design. An exam whose candidates cannot run their code because a secret did not reach a deploy is a worse day than the exposure it removes. It belongs in its own change, with its own deploy note.

Also unchanged, and also not a defect: **adaptive delivery is still linear** (round 2's C-2). The builder copy already says so, so nobody is misled; implementing a difficulty ladder is a product decision, not an audit finding.

## 11.6 · ✅ Verified working

| Probe | Property |
|---|---|
| **D-04** | The candidate on the owning device runs their code and is told how many runs remain; an unconfigured judge reports `judgeAvailable: false` rather than reading as a wrong answer; keystrokes are recorded as exactly one chunk keyed by attempt and question; a **legacy client that sends no `sessionId` is still served**, as everywhere else; and staff still cannot run a student's code through their quota or write into their record. |

## 11.7 · Order of action taken

1. **D-01** `e2f7d59` — the session gate, server and both clients.
2. **D-02 / D-03** `71f3f65` — the block and the paper, where the assessment was already loaded.

## 11.8 · Reproducing round 5

```bash
cd functions
npm install
npm run build

node test/audit.round5.cjs              # 4 probes — green
PROBE_TRACE=1 node test/audit.round5.cjs
npm test                                # every suite, round 5 included
```

Deployment: functions only — no rules, no indexes, no migration. Two callables gain an optional `sessionId` in their payload; an older client that omits it is served exactly as before.

---

<sub>Round 5 performed against commit `8ab207d`. Every finding traced to a `file:line` reference and reproduced by an executable probe driving the compiled production handlers.</sub>
