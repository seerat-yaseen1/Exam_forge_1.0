# Exam timer & freeze — behavioural audit

**Date:** 2026-08-03 · **Branch:** `claude/exam-timer-behavioral-audit-gxicdo`
**Status:** all 14 findings fixed. Both suites green — see §8.
**Method:** executable. Two suites, both runnable from `functions/`:

```
npm test              # both
npm run test:timing   # examTimingCore property sweep  — 13,446 states, PASS
npm run test:freeze   # freeze behavioural suite        — 15 scenarios, 64 checks, PASS
```

The failing counts quoted throughout §2 are what the suite reported **before**
the fixes, and are kept as the record of what was actually wrong. Every one of
them now passes.

`functions/test/freeze.suite.cjs` calls the **compiled production callables**
(`functions/lib/index.js`) against an in-memory Firestore and a virtual clock.
Nothing in it re-implements a deadline; every number asserted on was written by
the real handler. No comment, doc, plan file or commit message was treated as
evidence — only executable code and the output of running it.

---

## 0. The headline

`examTimingCore.ts` is correct. The sweep exercises it across 13,446 generated
states and 27 named regressions with zero defects.

**Every defect below lives outside it**, in the code that calls it — or in the
code that was written before it existed and never converted. The core computes
one answer; five other places still compute their own. That is the same failure
shape the module's own history records (D-01, D-03, D-14, D-28), and it is
currently live in the freeze path.

The single most damaging one, in one sentence:

> `submitSection` enforces **uncredited** section and overall deadlines, so
> freeze time that the write gate, the resolver and the student's screen all
> agree was granted **cannot be spent** — the section is force-closed at the
> pre-freeze deadline the moment the student tries to submit.

---

## 1. How the timer actually works

Nine clocks. Only one of them is enforced by security rules.

| # | Clock | Anchor | Authoritative source | Materialised? | Pauses on freeze? | Credited? |
|---|---|---|---|---|---|---|
| 1 | **Availability window** | `assessment.endDate` | `resolve()` — evaluated against **real** time | no | **no** (A10, by design) | no (`FREEZE_CREDIT_EXTENDS_WINDOW=false`) |
| 2 | **Overall** | `attempt.startedAt` | `overallDeadlineMs()` | `overallLockedAfter` | yes in `resolve()`, **no in `submitSection`** | yes / **no in `submitSection`** |
| 3 | **Section** | `sectionTimings[id].startedAt` | `sectionDeadlineMs()` | `sectionLockedAfter` | yes in `resolve()`, **no in `submitSection`** | yes / **no in `submitSection`** |
| 4 | **Question** | `servedQuestions[last].servedAt` | `computeDeadlines()` | **not materialised** | yes | yes |
| 5 | **Break** | previous section's `submittedAt` | `pendingBreak()` | not materialised | yes | yes / **no in `startSection`'s gate** |
| 6 | **Freeze** | `freezes[].startedAt` | the ledger | `creditedFreezeMs`, `freezeCredits{}` | n/a | n/a |
| 7 | **`answersLockedAfter`** | `min(section, overall)` | `computeAttemptLocks()` | **this is the only clock `firestore.rules` enforces** | via credit | yes / **no penalty** |
| 8 | **Heartbeat** | `lastHeartbeatAt` | `examHeartbeat` | yes | ignored | n/a |
| 9 | **Stale attempt** | `updatedAt` | `STALE_ATTEMPT_HOURS = 6` | n/a | **no — closes live freezes** | n/a |

**Enforcement chain.** `firestore.rules:730` gates direct answer writes on
`answersLockedAfter` alone. Clocks 1, 4 and 5 are deliberately *not* in it
(`index.ts:7041-7044`), so the window and the question clock are enforced only
by callables and by the hourly sweep. In linear/adaptive delivery answers never
touch the rules at all — they go through `submitAnswerAndAdvance`, which
bypasses rules via the Admin SDK.

**Freeze mechanics, as implemented.** `freezeAttempt` appends a ledger entry
with `startedAt` and no `endedAt`. `openFreezeStartedMs()` finds it and
`effectiveNowMs()` pins the evaluation instant to the freeze moment
(`examTimingCore.ts:495-498`), so every comparison inside `resolve()` holds.
The pause grants nothing: `grantedMs` is decided by a human at `unfreezeAttempt`,
capped at measured elapsed. Credit is **per clock** — `creditForAnchor()` counts
only freezes that began after that clock's own anchor — and is materialised into
`freezeCredits{overallMs, sectionMs, questionMs, breakMs}` so the client does no
credit arithmetic of its own. That design is sound and the client honours it
(`ExamShell.tsx:3503, 3520`; `SectionTimer.tsx:30`).

**What breaks it is that four other code paths never learned about any of this.**

---

## 2. Confirmed defects

Severity: **S1** = student loses time or work · **S2** = control is silently
ineffective · **S3** = divergence with bounded blast radius.

### F1 · `submitSection` enforces uncredited deadlines — **S1**
`functions/src/index.ts:7741-7764` (overall), `7766-7805` (section)

```ts
const overallDeadlineMs = examStartMs + a.overallTimeLimit * 60_000 + overallGraceSec * 1000;
if (serverNow > overallDeadlineMs) { … throw 'OVERALL_DEADLINE_EXCEEDED' }
…
const deadlineMs = startedMs + sec.timeLimit * 60_000 + graceSec * 1000;
if (serverNow > deadlineMs) { … clamp submittedAt … throw 'SECTION_DEADLINE_EXCEEDED' }
```

No freeze credit, no penalty, and `serverNow = Date.now()` rather than
`effectiveNowMs`. The in-code comment at `7737-7740` states the pre-Phase-4.3
posture as if it were current: *"the server ignores freeze here … credited only
in the client display."* That is D-03, and Phase 4.3 fixed it everywhere except
here.

**Failure:** student frozen 10 min in a 30-min section, full grant.
`answersLockedAfter` moves to `S0+40:30`, `getExamVerdict` says `section`,
the screen shows the restored time — and at `S0+35` the submit throws
`SECTION_DEADLINE_EXCEEDED`, `submittedAt` is clamped back to `S0+30:30` and
`timeUsedSeconds` to 30 minutes. The grant evaporates at the moment of use, and
the clamped `submittedAt` also mis-anchors the following break.

**Proof:** `FZ-02`, `FZ-03`.

### F2 · Every A4 penalty is computed and thrown away — **S2**
`functions/src/index.ts:6278-6282`

```ts
const penaltyLedger = [...(att.penalties ?? []), ...penaltyRows];
const penalisedAttempt = { ...creditedAttempt, penalties: penaltyLedger };
```

`penalisedAttempt` is never read. `penaltyLedger` is never written. The `updates`
object built at `6284` has no `penalties` key, and no other line in the file ever
writes `penalties` to an attempt (`grep -n "penalties" index.ts` → only the input
type, the read, and these two dead lines). The clamping, the caps, the
`decidedBy`/`decidedAt` rows, `PENALTY_REACHES`, `penaltyForClock` and the
INV-3a/INV-11 allowances are all real and all unreachable.

An invigilator who says "give back four minutes but take twenty seconds off the
section" gets the four minutes applied and the twenty seconds silently dropped.

**Proof:** `FZ-07`.

### F3 · The first ledger entry destroys legacy credit — **S1**
`examTimingCore.ts:442-455` + `index.ts:6056-6057`

```ts
export function creditForAnchor(a, anchor) {
  if (!Array.isArray(a.freezes) || a.freezes.length === 0) return creditedFreezeMs(a); // flat legacy
  …                                                                                    // per-freeze sum
}
```

An attempt carrying `totalFrozenSeconds` (written by `verifyAndResume`) and no
ledger gets that flat total credited to every clock, because
`CONSUME_LEGACY_FROZEN_SECONDS = true`. The instant `freezeAttempt` does
`arrayUnion`, `freezes` becomes non-empty and the function switches branch — the
open entry has no `grantedMs`, so credit drops to **0**. Pressing *Freeze*
deletes the student's accumulated credit.

**Measured:** 8 minutes of legacy credit → 0 ms at the freeze, → 1 minute after a
1-minute granted unfreeze. Net loss 7 minutes.

**Proof:** `FZ-14`.

### F4 · `verifyAndResume` increments, `unfreezeAttempt` overwrites — **S1**
`index.ts:4830` vs `index.ts:6289`

```ts
// verifyAndResume — measured ELAPSED, accumulated
totalFrozenSeconds: FieldValue.increment(frozenForSeconds)
// unfreezeAttempt — GRANTED, absolute set, derived from the ledger only
totalFrozenSeconds: Math.round(creditedFreezeMs / 1000)
```

Two writers, two meanings, one field. `unfreezeAttempt`'s doctrine comment
(`6115-6121`) claims INV-4a holds "by construction" because the total is derived
from the ledger — true within the ledger, false for the field, because the ledger
is not the only writer.

**Measured:** extension freeze 10 min → `totalFrozenSeconds = 600`, credit
600,000 ms. A later 2-minute invigilator pause, fully granted, leaves credit at
120,000 ms and moves `overallLockedAfter` **8 minutes earlier** with no penalty
row to justify it. INV-4a and INV-3a both violated by production code.

**Proof:** `FZ-04`.

### F5 · A freeze does not stop the student — **S2**
`index.ts:4896` · `3766` · `5137` · `7442` · `7679`

`freezeAttempt` leaves `status` at `'in_progress'` (`5998`, `6056-6064`). Every
guard on the student's transition paths tests `status`, and none consults
`att.freezes`. During a freeze — with clocks pinned by `effectiveNowMs` — the
student can:

* advance questions via `submitAnswerAndAdvance` (`status === 'in_progress'` ✓)
* save answers via `saveAnswerNoAdvance` (frozen explicitly allowed, `5126-5139`)
* start and submit sections
* **finalise their own attempt** via `gradeAttempt`

and none of it is flagged: `gradeAttempt:3825` sets `finalizedWhileFrozen` from
`freezeState.frozen`, which a ledger freeze never writes. The paused sitting is
graded and closed as an ordinary manual submit.

The client is well behaved — `ExamShell` guards all four expiry paths on
`isFrozenRef` and `handleAnswer` rejects input — so this needs a modified client
or direct callable invocation. It is a real bypass with unlimited time (clocks
are stopped), not a theoretical one.

**Proof:** `FZ-05`.

### F6 · The extension freeze pauses nothing — **S1**
`index.ts:4725-4729`

```ts
updates.freezeState = { frozen: true, reason: 'extension_detected', since: nowIso };
updates.status = 'frozen';
```

No ledger entry, no `frozenAt`. Consequences, all of them:

* `openFreezeStartedMs()` returns null → **`effectiveNowMs` does not pin** → every
  server clock keeps running.
* `ExamShell` derives `isFrozen` from `frozenAt` (`1686`) → the client's section,
  overall, question and break clocks **all keep running** behind the extension
  overlay, and every auto-expiry path stays armed. This is D-32 and D-36, alive
  for the other freeze mechanism.
* `firestore.rules:772` requires `status == 'in_progress'` → the student cannot
  save answers while their clock drains.

**Measured:** a student frozen out for 28 minutes of a 30-minute section is
resolved into the *next* section without ever being released.

**Proof:** `FZ-15`.

### F7 · `verifyAndResume` recomputes nothing — **S1**
`index.ts:4825-4833`

The release writes `status`, `freezeState`, `resumeRequiresVerification`,
`totalFrozenSeconds`, `updatedAt` — and no lock, no `freezeCredits`. Doctrine D5
says the materialised lock is a cache and every event that changes an input must
recompute it; granting credit changes an input. The student is released with
`answersLockedAfter` and `freezeCredits` still at pre-freeze values. The credit
appears later, at whatever section boundary happens to run
`computeAttemptLocks` next — as the *flat legacy total*, applied to whichever
clock is running then (F3).

**Proof:** `FZ-15`.

### F8 · Long freezes are auto-submitted after 6 hours — **S2**
`index.ts:1188` (`STALE_ATTEMPT_HOURS = 6`), `1408-1422`

`STALE_FREEZE_HOURS = 6` was commented out for D-30 (*"a freeze no longer expires
on a timer: it ends when a human ends it"*). The generic staleness fallback
re-implements it at the same six hours. A ledger-frozen attempt keeps
`status: 'in_progress'`, so it is caught by query (A) once its stale
`answersLockedAfter` passes; the resolver correctly says "not ended", and the
`!stale` branch then closes it anyway as `abandoned_sweep`.

**Measured:** 7-hour freeze → `status: 'auto_submitted'`, graded, no credit, and
**not** flagged `finalizedWhileFrozen` (that flag is only set on the
`status == 'frozen'` path).

**Proof:** `FZ-08`.

### F9 · The window-closes-during-freeze rule is dead for ledger freezes — **S2**
`index.ts:1234-1237`

The branch D-30 deliberately kept — *"the sole enforcement of a decision already
made"* (A10 row 1) — queries `status == 'frozen'`. `freezeAttempt` never writes
that status, so the branch only ever sees **extension** freezes. An
invigilator-frozen attempt whose availability window shuts is invisible to it,
and is closed only later via query (A), if and when `answersLockedAfter` passes.
On an exam with no section and no overall limit, `answersLockedAfter` is null and
the attempt is **never** closed.

**Proof:** `FZ-13`.

### F10 · `startSection`'s mandatory-break gate ignores break credit — **S3**
`index.ts:7520` vs `examTimingCore.ts:879`

```ts
// index.ts — the gate
const breakEndsAt = new Date(prevTiming.submittedAt).getTime() + brk.durationMinutes * 60_000;
// examTimingCore.ts — the resolver (D-29)
const endsAt = last.at + brk.durationMinutes * 60_000 + creditForAnchor(a, last.at);
```

D-29 credited the break clock in one of the two places that decide when a break
ends. A student frozen during a mandatory break is shown, and told by
`getExamVerdict`, that the break runs to `+16` while `startSection` lets them in
at `+10`.

**Proof:** `FZ-06`.

### F11 · `clocksAtFreeze` and the student's screen differ by the grace — **S3**
`index.ts:6034` vs `SectionTimer.tsx:30-31`

The snapshot is `deadline − now`, and the deadline includes `sectionGraceSeconds`.
`SectionTimer` renders `timeLimit − elapsed`, with no grace. The resume modal's
"time remaining at the pause" and its per-clock penalty caps are therefore 30 s
(default) larger than the number the student was watching.

**Measured:** Δ = exactly 30,000 ms. **Proof:** `FZ-09`.

### F12 · Staff can forge freeze credit by direct write — **S2** *(code-proven, not covered by the suite — rules are not executed here)*
`firestore.rules:651-659`

```
function staffAttemptUpdateFieldsAllowed() {
  return …hasOnly(['frozenAt','frozenBy','frozenReason','totalFrozenSeconds','updatedAt']);
}
```

Any institute or faculty account in the tenant may write these directly. With
`CONSUME_LEGACY_FROZEN_SECONDS = true` and no `freezes` array,
`creditedFreezeMs()` reads `totalFrozenSeconds * 1000`. So a single
`updateDoc({ totalFrozenSeconds: 86400 })` grants a student 24 hours, bypassing
the ledger, the `Math.min(grantedMs, elapsedMs)` cap, the authority ladder and the
audit row. The same write can set it to `0` and destroy credit. Setting
`frozenAt` alone pauses the client display while the server clocks run — D-03,
reachable from a browser console.

This disproves the invariant *"freeze credit cannot create time"* and
*"availability cannot be extended"* is the only outer wall left standing.

### F13 · `lateAnswer` hardcodes the question grace — **S3**
`index.ts:4940`, `5180` — `if (elapsedSec > qLimit + 5)`

D-14's fix was "one number, consumed by BOTH sides"
(`questionGraceSeconds`, default 5). The resolver consumes it; these two sites
still hardcode `5`, and neither adds freeze credit. An assessment configured with
`questionGraceSeconds: 15`, or any credited student, gets answers flagged late
that the resolver considers on time. `lateAnswer` is currently a detective flag
only — nothing in grading reads it — which is the only reason this is S3.

### F14 · Latent: raw assessment doc passed where a `CoreAssessment` is expected — **S3**
`index.ts:6245` — `computeDeadlines(creditedAttempt, lockA as unknown as CoreAssessment)`

`lockA` is `assessmentSnap.data()`, not `toCoreAssessment(...)`. It happens to work
today because the raw section shape carries `id`, `timeLimit` and
`questionTimeLimit`, and `computeDeadlines` never touches `questionIds`. Any
future change to either shape breaks the penalty caps silently. Every other call
site converts first.

---

## 3. Scenario results

Depth is stated honestly per scenario. "Executable" = a suite check proves it;
"traced" = read end-to-end in source; "partial" = surveyed, not exhaustively
traced.

| # | Scenario | Depth | Verdict |
|---|---|---|---|
| 1 | Sincere student, happy path | executable (`FZ-01`, `FZ-12`, timing sweep) | **Correct.** Deadlines materialise at `startExam`, move with each section, `min()` into `answersLockedAfter`. Grading is deterministic. |
| 2 | Refresh | traced | **Correct, and well designed.** `ExamShell:3132-3180` is state-driven, not transition-driven, and defers the *meaning* of expiry to `getExamVerdict` with a soft local fallback. Refresh during loading/question/section/break/submission all recover. |
| 3 | Internet loss (5 s → 15 min) | traced | **Nothing pauses.** All clocks are wall-clock anchored server-side; no reconnection credit exists, by design. Answers survive: `confirmedAnswers`/`localAnswers` reconcile off the snapshot (`ExamShell:1682`). Drift is bounded by `serverSkewRef` captured once at load — *not* re-captured on reconnect, so long outages leave the display on a stale skew. |
| 4 | Close browser, return | traced | **Correct.** Attempt recovered by `getStudentAssessments`/`getExamQuestions`; timer state is entirely server-derived; the expired-on-arrival path finalises or advances correctly. |
| 5 | Device change | partial | Laptop→laptop and →mobile: `registerSession` swaps `activeSessionId`, joining device wins, old device sees the conflict via its own listener. SEB↔browser: `assertSEB` is checked on every hot-path callable *and* on `examHeartbeat`, so leaving SEB fails within the token TTL. **Gap:** `REQUIRE_SESSION_ID = false` (`index.ts:7344`) — a caller that omits `sessionId` skips `assertSession` entirely. |
| 6 | Multiple tabs | traced | **Allowed and only partially detected.** Last writer wins; no callable rejects on conflict, only the superseded *client* self-locks. In standard delivery a superseded tab can keep autosaving answers under the rules — documented at `index.ts:7331-7337` and still true. Duplicate finalise is idempotent (`gradeAttempt:3766`). |
| 7 | Cheating surface | partial | Detection is broad (`IntegrityEngine`, `ExtensionWatchdog`, `FaceMonitor`, `logViolation` server-incremented and append-only). Clock manipulation is handled: `serverSkewRef` for display, server enforcement throughout. **Direct callable invocation is the live hole** — see F5 and F12. Manual Firestore writes are gated for students (`answers` + `updatedAt` only) but not for staff (F12). Replay: `submitAnswerAndAdvance` is idempotent-by-position; `saveAnswerNoAdvance` is explicitly safe to repeat. |
| 8 | Frozen student | **executable** | **Broken in seven distinct ways.** F1–F11 above. Freeze while answering: clocks pin correctly but the grant is unspendable (F1). During a break: F10. During transition/loading/reconnect: covered by pinning. During submission: F1 clamps. While offline: the freeze lands on the next snapshot; nothing recovers the interval. |
| 9 | Invigilator actions | **executable** (`FZ-10`) | Authority chain, idempotent double-freeze, peer rejection, rank escalation and the `min(granted, elapsed)` cap all **work correctly**. Partial grant works. **No grant** works. Multiple freezes accumulate correctly *within the ledger*. Concurrent invigilators are serialised by the transaction. What fails is what happens to the grant afterwards (F1–F4). |
| 10 | Boundary conditions | executable + sweep | Freeze at 00:00 / 00:01: credit is `min(granted, elapsed)`, deadline arithmetic is exact, sweep covers boundary instants. Last question = section end (D-14, sweep-proven). Freeze at availability expiry: A10 holds in `resolve()` but is unenforced for ledger freezes (F9). |
| 11 | System failures | partial | `freezeAttempt`/`unfreezeAttempt`/`registerSession` are transactional and idempotent (re-freeze returns the open entry; `FZ-10`). Cold start / cloud-function retry: safe for these. `writeAuditRow` swallows its own failures by design. **Untested:** partial-batch failure in the 400-doc sweep chunks, and `unfreezeAttempt` racing `scheduledCloseExpiredAttempts` on the same attempt. |
| 12 | Every timer | traced | Table in §1. Authoritative source, owner, update path, pause/resume behaviour, storage and recovery are all enumerated there. |
| 13 | Invariants | **executable** | See §4. |
| 14 | Architecture weaknesses | traced | See §5. |
| 15 | Missing tests | executable | See §6. |

---

## 4. Invariants — proven, disproven, unprovable

| Invariant | Verdict | Evidence |
|---|---|---|
| Deadlines never move backwards | **DISPROVEN** | F4 — `overallLockedAfter` moves 8 min earlier with no penalty row. `FZ-04`. |
| Clocks never increase unexpectedly | **DISPROVEN** | F12 — any staff account can write `totalFrozenSeconds`, which `creditedFreezeMs()` consumes. |
| Section cannot exceed total | **HOLDS** | `minNonNull` in `computeDeadlines`; precedence is outside-in, first match wins. Sweep-proven. |
| Question cannot exceed section | **HOLDS** | Same. Sweep-proven. |
| Freeze credit cannot create time | **DISPROVEN** | F12 (direct write) and F3 (credit *destroyed*, the other direction). The `min(granted, elapsed)` cap itself holds — `FZ-10`. |
| Availability cannot be extended | **HOLDS** | `FREEZE_CREDIT_EXTENDS_WINDOW = false`; `resolve()` uses `nowMs` not `evalNow` for the window. Sweep-proven + `FZ-13`. |
| Stale writes rejected | **PARTIAL** | `assertSession` covers every transition callable, but `REQUIRE_SESSION_ID = false` makes it opt-in, and standard-mode answer writes bypass it entirely. |
| Duplicate submissions impossible | **HOLDS** | `gradeAttempt:3766` idempotent guard; `submittingRef` client-side; `doSectionSubmit` re-entry guard at `ExamShell:2389`. |
| Timer deterministic | **HOLDS for the core, FAILS for the system** | The core is pure and sweep-proven. The system is not: `submitSection` and `resolve()` return different verdicts for the same state (F1). |
| Grading deterministic | **HOLDS** | One `scoreAttemptAnswers`, one `normalizeSections`, `gradingConfig` frozen on the attempt at start, same precedence in `gradeAttempt`, `gradeProvisional` and the sweep. |

**Cannot be proven from code:** whether `CONSUME_LEGACY_FROZEN_SECONDS = true` is
safe depends on `totalFrozenSeconds` meaning *granted* time. The constant's own
justification asserts that (`examTimingCore.ts:342-362`), and F4 shows
`verifyAndResume` writes *elapsed* into it. Whether real production attempts
carry elapsed or granted values in that field is a data question, not a code
question — it needs a read-only production sweep before the constant can be
trusted either way.

---

## 5. Architecture weaknesses

* **Duplicate logic is the root cause of 6 of the 14 findings.** The section
  deadline is expressed in `sectionDeadlineMs`, in `submitSection`, and in
  `SectionTimer`. The break end is in `pendingBreak` and in `startSection`. The
  question grace is in `computeDeadlines` and hardcoded twice. Each pair was
  fixed on one side only.
* **Two freeze mechanisms with different shapes** (`frozenAt` + ledger vs
  `status:'frozen'` + `freezeState`). Every consumer has to know both, and none
  of them does. F6, F8, F9 are all this.
* **One field, two meanings, two writers** — `totalFrozenSeconds` (F4).
* **Single point of failure:** `answersLockedAfter` is the only clock the rules
  enforce, and it is a *cache*. Any path that changes an input without calling
  `applyLockUpdates` desynchronises the write gate silently. `verifyAndResume`
  is exactly that path today.
* **Dead code that looks live:** the entire penalty subsystem (F2). ~120 lines of
  production code, a documented model, an invariant allowance in
  `checkTransition`, and a UI — none of it reachable.
* **`noUnusedLocals` is off.** With it on, `tsc` would have caught F2 at compile
  time.
* **Cache inconsistency:** `freezeCredits` is recomputed at five sites and not at
  `verifyAndResume` or `freezeAttempt`.
* **Performance:** `scheduledCloseExpiredAttempts` grades inline in a 540 s
  window with a 500-attempt page; a large cohort expiring at once will not
  complete in one run. The per-assessment `papers` cache mitigates it but the
  page limit is not resumable — there is no cursor.

---

## 6. Test coverage

**Tested before this audit:** `examTimingCore` only — thoroughly
(`timing.sweep.cjs`, 13,446 states, 27 regressions) — plus `allocation.sweep.cjs`.
No test existed for any callable, any adapter, the rules, or the client.

**Untested, ranked by risk:**

| Rank | Surface | Why it matters |
|---|---|---|
| 1 | `submitSection` deadline gates | F1 — the highest-impact defect in the system, and the hottest path |
| 2 | `unfreezeAttempt` write payload | F2 — a whole feature is dead and nothing noticed |
| 3 | `firestore.rules` | F12 — no rules test exists at all; `@firebase/rules-unit-testing` is not a dependency |
| 4 | `verifyAndResume` / extension freeze | F6, F7 — the second freeze mechanism has never been exercised |
| 5 | `scheduledCloseExpiredAttempts` | F8, F9 — it grades and finalises, and runs unattended |
| 6 | `toCoreAttempt` / `toCoreAssessment` | F14 — the adapters the sweep's fixtures bypass entirely |
| 7 | `ExamShell` timer effects | Four expiry paths, each guarded by hand; D-32/D-36 were both found in production |
| 8 | `registerSession` concurrency | Scenario 6 — no test of the takeover race |

`functions/test/freeze.suite.cjs` now covers ranks 1, 2, 4, 5 and part of 6.
Ranks 3, 7 and 8 remain untested.

---

## 7. Fix order (completed)

1. **F1** — route `submitSection`'s two gates through `resolve()` /
   `computeDeadlines`. Delete the inline arithmetic. Highest impact, smallest diff.
2. **F2** — add `penalties: penaltyLedger` to `updates`, and pass
   `penalisedAttempt` to `computeAttemptLocks` so deductions reach the write gate.
3. **F4 + F3** — stop `verifyAndResume` writing `totalFrozenSeconds`; give the
   extension freeze a real ledger entry instead (which also fixes F6).
4. **F6 + F7** — make `reportExtensionCheck` call the same ledger open that
   `freezeAttempt` uses, and make `verifyAndResume` close it via the same path as
   `unfreezeAttempt`. One freeze mechanism, not two. Fixes F6, F7, F8, F9 together.
5. **F5** — add an open-freeze check to `submitAnswerAndAdvance`, `startSection`,
   `submitSection` and student-initiated `gradeAttempt`.
6. **F12** — remove `frozenAt`/`frozenBy`/`frozenReason`/`totalFrozenSeconds` from
   `staffAttemptUpdateFieldsAllowed()`; both are callable-only now.
7. **F10, F11, F13, F14** — mechanical.
8. Turn on `noUnusedLocals`.


---

## 8. What changed

All fixes are on `claude/exam-timer-behavioral-audit-gxicdo`. Both suites pass:
13,446 states / zero defects, and 64 freeze checks / zero failures.

### `functions/src/index.ts`

| Finding | Change |
|---|---|
| F1 | `submitSection`'s two deadline gates deleted and replaced with `computeDeadlines` + `effectiveNowMs`. The clamp instants come from the same numbers. |
| F2 | `unfreezeAttempt` writes `penalties`, and `computeAttemptLocks` gained `penaltyForClock` terms so a deduction reaches `answersLockedAfter`. |
| F3 | `preLedgerCreditEntry()` migrates a legacy `totalFrozenSeconds` into a synthetic closed ledger row in the same write that opens the first real one. |
| F4 | `verifyAndResume` no longer increments `totalFrozenSeconds`; both release paths go through `closeFreezeUpdates`, which derives it from the ledger. |
| F5 | A pause writes `status: 'frozen'`, so every existing student-transition guard applies. `gradeAttempt` refuses a non-grader finalise while an entry is open, and flags `finalizedWhileFrozen` from the ledger as well as `freezeState`. |
| F6 | `reportExtensionCheck` is transactional and opens a real ledger entry (`reason: 'extension_check'`) with `frozenAt`, so both server and client clocks pause. |
| F7 | `verifyAndResume` recomputes locks and `freezeCredits` via `closeFreezeUpdates`, granting the pause in full (doctrine D8 — an automatic state exits in the student's favour). |
| F8 | The sweep's staleness fallback skips attempts with an open freeze. |
| F9 | The sweep's frozen branch asks `resolve()` for `ended:window_closed` instead of `attemptWindowClosed()`, which despite its name read the *answer lock* — the very clock a freeze holds — and so fired on the state it was meant to protect. |
| F10 | `startSection`'s mandatory-break gate adds `creditForAnchor` on the submit instant. |
| F11 | `snapshotClocks()` excludes grace, so `clocksAtFreeze` describes the clock the student was actually watching. |
| F13 | Both `lateAnswer` sites use `questionGraceSeconds` (imported from the core, not redeclared) and add freeze credit. |
| F14 | `unfreezeAttempt` converts with `toCoreAssessment` instead of casting the raw doc. |
| — | New shared helpers `openFreezeUpdates` / `closeFreezeUpdates`: one way into a pause and one way out, for both mechanisms. |
| — | `closeFreezeUpdates` accepts three "when did this pause start" shapes (ledger entry, `frozenAt`, `freezeState.since`) so an attempt already paused at deploy time is measured, not zeroed. |

### `functions/tsconfig.json`
`noUnusedLocals: true` — the check that would have failed the build on F2.
Enabling it also surfaced that `deleteAuthUser` destructures
`deleteAttemptsOnWebOwnerAssessments` and never forwards it to
`purgeStudentData`, so that option has never done anything. **Left unfixed and
commented in place** — wiring it up changes what gets deleted, which is not a
decision to make in passing.

### `firestore.rules`
`staffAttemptUpdateFieldsAllowed()` reduced to `['updatedAt']`. `frozenAt`,
`frozenBy`, `frozenReason` and `totalFrozenSeconds` are callable-only. Verified
no client path still writes them.

### `src/lib/submissionService.ts`
`getBreakState()` accepts `'frozen'` (a paused student on a break is still on a
break — the roster pill would otherwise vanish the moment an invigilator pauses
them), credits the break from `freezeCredits.breakMs`, and pins its reference
instant on `frozenAt`.

### Not fixed, and why

* **Rules are still untested.** `@firebase/rules-unit-testing` is not a
  dependency and adding an emulator harness is its own change. F12 is fixed by
  inspection, not by a passing test — the weakest evidence in this document.
* **Ranks 7 and 8 of §6** (ExamShell timer effects, `registerSession`
  concurrency) remain untested.
* **`REQUIRE_SESSION_ID = false`** is unchanged. Flipping it locks out any
  cached client that predates the field, which is a rollout decision.
* **`CONSUME_LEGACY_FROZEN_SECONDS`** stays `true`. Its justification is now
  actually true — after F4, `totalFrozenSeconds` only ever holds granted time —
  but whether existing production attempts carry elapsed values written by the
  old `verifyAndResume` is a data question that needs a read-only production
  sweep, not a code change.
