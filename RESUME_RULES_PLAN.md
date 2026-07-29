# Resume Rules — Implementation Plan

Assessed against the codebase as deployed on 2026-07-28.

---

## 0. Headline findings

**Three things change the shape of this work:**

1. **Breaks already comply.** The partial-resume behaviour the spec asks for is
   already built and server-enforced. This is the largest single chunk of the
   spec and it needs no work.

2. **The spec conflicts with what shipped yesterday.** The expired-attempt
   auto-finalise added on 2026-07-28 ends the *whole exam* when the section
   clock expires. The spec says section expiry should **advance to the next
   section**. Yesterday's fix is correct for the total timer and too blunt for
   the section timer.

3. **Authority pause exists but does not actually pause anything**, and
   yesterday's answer-lock made that materially worse. Details in §4.

---

## 1. What already complies — no work needed

| Spec requirement | Where it lives | Status |
|---|---|---|
| Timers run while the student is away | All clocks anchor on server-written timestamps (`attempt.startedAt`, `sectionTimings[id].startedAt`, `servedQuestions[].servedAt`) | ✅ |
| Break resumes with **remaining** duration only | `ExamShell:1164-1166` derives `endsAt` from the persisted `curTiming.submittedAt`, not from arrival time | ✅ |
| Expired break → straight to next section | `ExamShell:1190-1200` renders the break screen in its expired state | ✅ |
| Mandatory break cannot be skipped | Server refuses `startSection` while the break is live (`index.ts:5469-5470`) | ✅ |
| Break never re-granted in full | Same persisted-`submittedAt` derivation | ✅ |
| Per-question clock is authoritative | `index.ts:4531` — *"servedAt is the only clock that counts"* | ✅ |
| Availability-window check on resume | `ExamShell:954` | ✅ |

**Implication:** the break section of the spec is essentially a description of
existing behaviour. Scope is smaller than it reads.

---

## 2. The gaps

### GAP 1 — Section expiry must advance, not end the exam ⚠️ *conflicts with shipped code*

**Spec:** section timer expired → student cannot continue in that section →
resume from the **next** section (after break evaluation). Exam ends only if it
was the **last** section.

**Current:** the `answerWindowClosed` effect added yesterday calls
`handleFinalSubmit('time_expired')` — ending the entire attempt — because
`answersLockedAfter` is `min(section, overall)` and the effect cannot tell which
bound tripped.

**Consequence today:** a student who steps away during section 2 of 4 and
returns loses sections 3 and 4 entirely. That is a real regression against the
spec, and arguably against fairness.

**Fix shape:** the effect must distinguish *which* clock expired:

```
overall expired            → finalise the attempt        (spec §3)
section expired, overall live → close section, advance    (spec §2)
last section expired       → finalise the attempt        (spec §2)
```

This requires the client to know both deadlines separately, not just their
minimum. See §5.

---

### GAP 2 — No single precedence evaluator

**Spec:** total > section > question, evaluated in that order on every resume.

**Current:** there is no place that evaluates all three. Resume drops the
student at `currentSectionIdx` / current question and relies on timer callbacks
that may never fire (the transition-vs-state problem fixed yesterday for the
overall case only).

**Fix shape:** one server-side resolver — `resolveResumePosition(attempt,
assessment, now)` — returning a discriminated result:

```
{ kind: 'ended',    reason: 'overall_expired' | 'last_section_expired' }
{ kind: 'break',    sectionId, endsAt, mandatory }
{ kind: 'section',  sectionId }
{ kind: 'question', sectionId, questionId }
{ kind: 'choose' }                      // student_choice with sections remaining
```

**Why server-side:** the client already demonstrated it cannot be trusted to
reach the right verdict — three separate walls yesterday, each a client path
that failed to fire. A resolver the client merely *renders* is far more robust
than one it *decides*.

---

### GAP 3 — Expired section never gets its break evaluated

**Spec:** whenever resume moves the student across a section boundary, the break
after the completed section must be evaluated.

**Current:** the break resume logic (`ExamShell:1161`) only fires when
`curTiming.submittedAt` exists — i.e. when the section was *properly submitted*.
A section that simply expired while the student was away has no `submittedAt`,
so the break is skipped entirely.

**Fix shape — and this one is elegant:** have the resolver **close the expired
section server-side with `submittedAt` clamped to its true deadline**. The
existing break logic then works unchanged, because it computes
`endsAt = submittedAt + duration` — so the break correctly appears to have
started at the section deadline and may already have elapsed. No new break code.

---

### GAP 4 — Per-question expiry does not advance on resume

**Spec (linear/adaptive):** expired question → cannot return → resume from the
**next** question; if it was the section's last question, move to the next
section (with break evaluation).

**Current:** `submitAnswerAndAdvance` enforces the per-question clock *when the
student advances*, but on **resume** the client re-renders the expired question.

**Fix shape:** the resolver walks `servedQuestions` and skips any whose
`servedAt + questionTimeLimit` has passed, returning the first live question —
or escalating to the section/exam-end branch.

---

### GAP 5 — `student_choice` has no "next section"

**Not addressed by the spec at all.** Under `sectionStartOrder: 'student_choice'`
there is no canonical next section. The resolver must return `{ kind: 'choose' }`
with the expired section excluded from the remaining set, and "last section
expired" becomes "no unplayed sections remain".

Worth an explicit decision from you.

---

## 3. Configuration impact

| Setting | Interaction |
|---|---|
| `sectionGraceSeconds` / `overallGraceSeconds` | Define *when* "expired" is. The resolver must use deadline **+ grace**, matching `submitSection`, or the resolver and the grader disagree. |
| `questionTimeLimit` (per section) | Undefined ⇒ the per-question branch never fires. Only applies to linear/adaptive. |
| Section `timeLimit` undefined (untimed section) | Section-expiry branch never fires; only the overall clock can end it. |
| `breakAfter` positional config | Already keyed on **completion count**, not section identity. The clamped-`submittedAt` approach preserves that — no change. |
| `deliveryMode` | `standard` skips GAP 4 entirely. `linear`/`adaptive` need the full question walk. |
| `sectionStartOrder` | `sequential`/`random` have a next section; `student_choice` does not — see GAP 5. |
| `maxAttempts` / `attemptOverrides` | Unaffected. An exam ended by expiry is `auto_submitted`, already in the finished set. |
| `answersLockedAfter` (new, yesterday) | **Needs revisiting.** Currently `min(section, overall)`. Still correct as a *write* gate, but the resolver needs both bounds separately. Recommend storing them as two fields and keeping `answersLockedAfter` as the derived minimum for the rule. |

---

## 4. Authority pause — direct answer

**Yes, the mechanism exists, and students genuinely cannot trigger it.**

- `freezeAttempt` / `unfreezeAttempt` (`submissionService:878/895`)
- Fields: `frozenAt`, `frozenBy`, `frozenReason`, `totalFrozenSeconds`
- `firestore.rules` places these in `staffAttemptUpdateFieldsAllowed` — institute
  and faculty only. The student whitelist contains only `answers`,
  `integrityLog`, `activeSessionId`, `sessionConflictAt`, `updatedAt`.

**But it does not actually pause the clock.**

`totalFrozenSeconds` appears **exactly once** in `functions/src/index.ts` — as
an initialiser (`totalFrozenSeconds: 0`). It is never read by any deadline
computation: not by `submitSection`, not by the overall check, and not by
`computeAnswersLockedAfter`.

Freeze pauses the **client display only**. The student's real deadline keeps
running.

**Yesterday's change made this worse.** Previously the mismatch was survivable
because enforcement happened only at submit, where grace absorbed some slack.
Now `answersLockedAfter` hard-stops answer writes at an **uncredited** deadline —
so a student frozen for ten minutes can be locked out of answering *during the
freeze*, or immediately after unfreezing, with no way to recover.

**Recommendation:** if freeze is meant to be a real pause, `totalFrozenSeconds`
must be credited in every deadline computation, and `answersLockedAfter` must be
**recomputed on unfreeze**. That is a deliberate decision with a trade-off:
crediting it means staff can extend a student's time, so it needs an audit row
(`writeAuditRow` already exists). If freeze is only ever meant as a display
courtesy, the current behaviour is fine — but the UI should stop implying the
clock has stopped.

---

## 5. Proposed phasing

**Phase 1 — Stop the regression** *(small, urgent)*
Split `answersLockedAfter` into `sectionLockedAfter` + `overallLockedAfter`
(keeping the minimum as the rule's gate). Change yesterday's effect to finalise
only on **overall** expiry. Section expiry falls through to Phase 2; until then
it behaves as today.

**Phase 2 — The resolver** *(the bulk)*
Build `resolveResumePosition` server-side with the precedence chain, expired-
section clamping, and the question walk. Client renders its verdict instead of
deciding. Covers GAPs 1–4.

**Phase 3 — `student_choice`** *(design first)*
Needs your decision on GAP 5.

**Phase 4 — Freeze semantics** *(decision first)*
Credit `totalFrozenSeconds` everywhere and recompute on unfreeze, plus an audit
row — or explicitly declare freeze display-only and fix the UI copy.

---

## 6. Open questions for you

1. **`student_choice` + expired section** — pick from remaining, or end?
2. **Freeze** — real pause (with audit) or display-only?
3. **Section expiry while the student is present** — the spec covers resume;
   should a section expiring at the desk also auto-advance rather than sit
   there? (Current behaviour depends on a timer callback firing.)
4. **Grace on resume** — should a student returning inside the grace window get
   the remaining grace, or is grace only for in-flight submissions?
