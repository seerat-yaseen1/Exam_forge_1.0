# Assessment pipeline — end-to-end audit

**Date:** 2026-08-09
**Scope:** every stage a question passes through, from the moment an author
opens the drawer to the moment a mark is final — authoring, the answer split,
the rights-gated write path, blueprint resolution, publication, allocation,
admission, delivery, the clocks, answer capture, integrity, coding, section
close, finalisation, grading, and results.
**Method:** code-derived, then executed. Six findings are reproduced against
the **real compiled callables** (`functions/lib/index.js`) via
`functions/test/audit.pipeline.cjs`; the rest are traced to `file:line`.
**Baseline:** every existing suite is green before and after this pass —
13,446 timing states / 84,062 assertions, 85 e2e, 145 group, 93 probe, 109
round-3, 63 grading, 146 judge. Nothing in this audit changes behaviour.

---

## Executive summary

| | Finding | Where it bites |
|:--:|---|---|
| 🔴 **F-01** | `startSection` accepts a section id that is not on the attempt — and the phantom section **removes the answer-write deadline** | timing |
| 🔴 **F-02** | The same phantom section **walks past a mandatory break** | timing |
| 🔴 **F-03** | Answers to an **already-submitted section stay writable and stay marked** — per-section limits bind the UI, not the data | timing / marks |
| 🔴 **F-04** | An MCQ or Match question with an **empty answer key marks everyone wrong and applies negative marking**, with no manual-review flag | marks |
| 🟡 **F-05** | `scores` and per-question `isCorrect` are written to the **student-readable attempt document** regardless of `showResults` / `allowReview` | disclosure |
| 🟡 **F-06** | `requireSEB` is **absent from the post-publish immutability clause** in `firestore.rules`, while `startExam` re-derives it from the live document | latent |
| 🟡 **F-07** | Integrity **auto-termination is decided by the client**; the server only reports `thresholdReached` | detective only |
| 🟢 **F-08** | `passingScore` is **not in the frozen contract** — the pass mark can move under a sitting student | marks |
| 🟢 **F-09** | `answeredAt` on standard-mode answers is **client-written**, and `timingAnalysis` is computed from it | analytics |
| 🟢 **F-10** | The hourly sweep's range query **matches null-lock attempts**, which sort ahead of genuinely expired ones inside its 500-doc limit | liveness |
| 🟢 **F-11** | The server question-write callables perform **no payload validation at all** | robustness |

**The shape of it.** Three of the four red findings are the same defect wearing
different clothes: *a section boundary is enforced in one place and trusted in
another.* `submitSection` learned to validate its advance target (audit A-02);
`startSection`, which performs the same transition, never did. The answer-write
lock is one materialised instant, so "which section are you in" is a question
the rules cannot ask — and grading never asks it either. The platform's timing
model is genuinely excellent inside a section and genuinely soft at the seams
between them.

F-04 is different in kind and, in an exam that uses negative marking, worse. It
is the codebase's own stated failure mode — `scoreMCQMultiplier` carries a long
comment about why a forgotten variant must not silently mark correct candidates
zero — reappearing one level down, on the key rather than the variant. Coding
and text both send uncertainty to manual review. MCQ and Match send it to a
confident negative mark.

**What is genuinely strong**, and was re-verified rather than taken on trust:
the answer/public document split and the student field whitelist; the frozen
`examSnapshot` paper and timing contract; server-owned clocks with per-clock
freeze credit; the two-path targeting gate (`assignedTo` and
`assessmentMembers`) applied identically in `startExam` and `getExamQuestions`;
the `questions` / `questionGroups` tenant fence and the callable-only write
path; SEB binding to the caller's uid; the linear/adaptive serve-one-at-a-time
discipline; the coding judge's "no verdict is never a zero" posture; and the
transactional attempt create. None of that is decoration — I tried to get round
several of them and could not.

---

## Stage-by-stage coverage

`✅` verified working · `⚠` finding raised · `◻` out of scope this pass

| # | Stage | Verdict |
|:--:|---|---|
| 1 | Authoring — engine/variant registry, drawer validation | ✅ MCQ requires ≥1 key; Match does **not** require `correctPairs` → feeds F-04 |
| 2 | Answer split — `questions` public / `questionAnswers` private | ✅ client and server twins agree, `tests` included |
| 3 | Rights-gated write (`createQuestionAsRole` &c.) | ⚠ F-11 — authorises correctly, validates nothing |
| 4 | Bulk create | ✅ chunked, rights checked once, cap enforced server-side |
| 5 | Groups + stimulus | ✅ rules mirror `/questions` clause for clause |
| 6 | Blueprint resolution (`resolveQuestionsForSections`) | ✅ group blocks kept intact, no double-draw, engine lock honoured |
| 7 | Publish + security freeze (`securityLockedAt`) | ⚠ F-06 — `requireSEB` outside the frozen set |
| 8 | Allocation → `assessmentMembers` | ✅ versioned, transactional, no live removals |
| 9 | Student discovery (`getStudentAssessments`) | ✅ server-filtered, other students' ids stripped |
| 10 | Admission (`startExam`) | ✅ structure server-derived, transactional, gates before create |
| 11 | Paper delivery (`getExamQuestions`) | ✅ live-attempt required, whitelisted, contract-scoped |
| 12 | Section entry (`startSection`) | ⚠ **F-01, F-02** |
| 13 | Answer capture — standard | ⚠ **F-03**, F-09 |
| 14 | Answer capture — linear/adaptive | ✅ callable-only, window gate, question clock credited |
| 15 | Integrity + sessions | ⚠ F-07; `logViolation` itself is append-only and server-incremented |
| 16 | Freeze / unfreeze ledger | ✅ per-clock credit, capped, audited |
| 17 | Coding run + judge | ✅ hidden suite never leaves the server; outage ≠ zero |
| 18 | Section close (`submitSection`) | ✅ advance target validated, deadlines from one source |
| 19 | Finalisation (`gradeAttempt`) | ✅ idempotent, paused-student guard, trapped-frozen exit |
| 20 | Scoring | ⚠ **F-04**, F-08 |
| 21 | Sweep (`scheduledCloseExpiredAttempts`) | ⚠ F-10 |
| 22 | Results + review | ⚠ **F-05** |
| 23 | Manual marking of text answers | ◻ still unbuilt — already recorded as a known gap in `audit.probe.cjs` |

---

## 🔴 F-01 · `startSection` admits a section that is not on the attempt

**Where:** `functions/src/index.ts:9386` (`const idx = sectionIds.indexOf(sectionId)`),
lock recompute at `:9459`.
**Reproduced:** `audit.pipeline.cjs` F-01a / F-01b.

`submitSection` validates its advance target against the attempt's own played
set and refuses anything outside it:

```ts
advanceIdx = playedIds.indexOf(requestedNext);
if (advanceIdx < 0) throw new HttpsError('invalid-argument',
  'SECTION_ADVANCE_INVALID: that section is not part of this attempt.');   // :9668
```

`startSection` performs the same transition and has no such check. It takes
`indexOf`, tolerates `-1`, and proceeds to write a `sectionTimings` row for
whatever string it was handed.

The consequence is not the stray row. It is the line immediately after:

```ts
const locks = computeAttemptLocks(
  attempt.startedAt, nowIso,
  lockA.sections?.find((s) => s.id === sectionId)?.timeLimit,   // :9459 → undefined
  lockA, toCoreAttempt(attempt));
```

No section by that id exists in the contract, so `timeLimit` is `undefined`,
`sectionDeadlineMs` returns `null` (`examTimingCore.ts:388`), and the section
bound vanishes from `answersLockedAfter` — the one field `firestore.rules`
actually enforces. What remains is `min(overall, availability window)`.

**Preconditions:** an ordinary student, mid-sitting, with no section currently
open. The INV-1 guard at `:9346` only refuses a *second* open section, so
closing the current one first is enough — which is what a student does anyway
at every section boundary.

**Measured** on a paper with 30-minute sections, no overall cap, and a
week-long availability window (a completely ordinary configuration):

```
answersLockedAfter  2026-08-01T09:30:30Z  →  2026-08-08T09:00:00Z
                                             + 10,050 minutes of writable time
```

Seven days to finish a thirty-minute section. The student then writes answers
straight through `firestore.rules` (standard delivery permits it) and calls
`gradeAttempt` whenever they are done.

**Why the sweep does not catch it:** `scheduledCloseExpiredAttempts` asks the
resolver, and the resolver reads the same absent section bound, so it correctly
answers "not ended". The staleness fallback only fires after
`STALE_ATTEMPT_HOURS` with no writes — and this student is writing.

**Fix.** Give `startSection` the guard `submitSection` already has, in the same
words. Everything else follows.

```ts
const idx = sectionIds.indexOf(sectionId);
if (idx < 0) {
  throw new HttpsError('invalid-argument',
    'SECTION_START_INVALID: that section is not part of this attempt.');
}
```

Worth adding a belt-and-braces second: `computeAttemptLocks` returning a `null`
section bound for a section the caller *named* is different from an exam that
genuinely has no per-section limit. The callable can tell those apart; the
arithmetic cannot.

---

## 🔴 F-02 · The phantom section skips a mandatory break

**Where:** `functions/src/index.ts:9625`.
**Reproduced:** `audit.pipeline.cjs` F-02a (control) / F-02b.

Breaks are resolved positionally, from the submitted section's index in the
attempt's play order:

```ts
const playIdx = Array.isArray(attempt.sectionIds) ? attempt.sectionIds.indexOf(sectionId) : -1;
const breakDue = playIdx >= 0 ? breakAfterCompletion(a.sections, attempt.sectionIds, playIdx + 1) : null;
```

For a section that is not in `sectionIds`, `playIdx` is `-1`, `breakDue` is
`null`, `mandatoryBreakDue` is `false` — and the advance branch runs, starting
the next real section immediately.

D-22 closed two routes to this exact outcome (starting a section while another
was open; reordering an unplayed section to index 0). This is a third, and it
is the one that needs no reorder and no overlap. The control probe confirms the
honest route is still correctly refused: entering `SB` directly during the
break throws. Inserting `PHANTOM` between them does not.

```
F-02a  CONTROL  startSection('SB')      → refused, mandatory break has not ended
F-02b  OPEN     startSection('PHANTOM')
                submitSection('PHANTOM', next: 'SB')
                                        → SB.startedAt set, break elapsed 0m of 15m
```

Fixing F-01 closes this. It is listed separately because the *reason* it is
serious is different — F-01 buys time, F-02 defeats an invigilation control —
and because the positional break resolution deserves its own regression test
either way.

---

## 🔴 F-03 · Answers to a closed section stay writable, and stay marked

**Where:** `firestore.rules:795` (student whitelist), `:832`
(`answerWriteWindowOpen`), `functions/src/index.ts:4190`
(`scoreAttemptAnswers`).
**Reproduced:** `audit.pipeline.cjs` F-03.

Three facts that are individually reasonable:

1. The student patch whitelist gates the **top-level key** `answers`. It says
   nothing about which question ids may appear beneath it — `hasOnly` cannot.
2. `answerWriteWindowOpen` compares `request.time` against **one materialised
   instant**. After an advance that instant is the *next* section's deadline.
3. `scoreAttemptAnswers` walks the paper and reads `answers[aq.questionId]`. It
   never consults the answer's own `sectionId`, and never compares its
   `answeredAt` to the section's `submittedAt`.

Together: while section B is open, a student may write an answer to any
question in section A — and it will be marked.

```
SA.submittedAt        2026-08-01T09:02:00Z
answers.q1.answeredAt 2026-08-01T09:12:00Z   ← ten minutes after SA closed
awarded               10/20                   ← full marks for q1
```

The client does not offer this (navigation is scoped to `currentSection`), so
it needs a console or a replayed request — but that is precisely the boundary
`firestore.rules` exists to hold. On a paper where section A is the hard
quantitative section and section B is a long essay, this is the whole exam.

**The fix is not a one-liner, and it is worth saying why.** `flushAnswers`
sends the **entire** answer map on every autosave, deliberately
(`ExamShell.tsx:2220` — "a single `updateDoc` either way, and on a submit path
the safest payload is the complete one"). So a naive rule that rejects any
write touching a closed section's question would reject every legitimate
autosave from section B onward. Three workable shapes, in preference order:

1. **Materialise a per-section answer lock.** Alongside `answersLockedAfter`,
   store `closedQuestionIds` (or a `sectionOf` map plus per-section
   `submittedAt` as Timestamps) and have the rule reject a *changed* value for
   a closed question. This is the only option that holds at the trust boundary.
2. **Enforce at grade time.** Ignore — or mark and flag — an answer whose
   `answeredAt` postdates its section's `submittedAt`. Cheap, but leans on a
   client-written timestamp (see F-09), so it is detective, not preventive.
3. **Narrow the client's flush** to the current section, then apply option 1's
   rule. Correct, but a behaviour change to the durability layer that Phase 4.1
   built deliberately; do it second, not first.

---

## 🔴 F-04 · An empty answer key marks everyone wrong — and penalises them

**Where:** `functions/src/index.ts:3761` (`scoreMCQMultiplier`), `:3808`
(`scoreMatchMultiplier`), `:3706` (`awardFor`), `:3961`
(`loadQuestionAndAnswerMaps` fallback).
**Reproduced:** `audit.pipeline.cjs` F-04.

For a single-selection MCQ:

```ts
const isCorrect = ans.correctIds.includes(selected);        // [] → false, always
return { multiplier: isCorrect ? 1 : 0, isCorrect, anyCorrect: isCorrect };
```

and then:

```ts
function awardFor(outcome, policy, questionMarks) {
  if (outcome.multiplier > 0) return outcome.multiplier * questionMarks;
  if (outcome.anyCorrect)     return 0;
  return -penaltyFor(policy, questionMarks);               // ← every candidate
}
```

An empty key is indistinguishable from a wrong answer. With negative marking
on, every candidate who attempted the question is **penalised**, `passed` is
computed confidently, and `requiresManualReview` is never set — so nothing
anywhere says the paper was unmarkable.

```
gradingConfig: negativeMarking, percent, 25
bySection awarded = [-2.5, -2.5]     requiresManualReview = false
```

**This is reachable through a supported path, not only through corruption.**
`createQuestionAsRole` and `createQuestionsBulkAsRole` do no validation
(F-11), and `buildQuestionDocs` writes `correctIds: []` as the default when the
payload omits it (`:10110`). A drawer bug, a malformed bulk row, or a direct
callable invocation all land on exactly this document. The **Match** engine
reaches it through the UI as well: the authoring drawer validates that pairs
have text but never that `correctPairs` is non-empty
(`QuestionTypeEngine.tsx:814-816`).

A **missing** `questionAnswers` document is no safer. The fallback synthesises
one from the public question doc — where `correctIds` is `[]` by construction
— so it produces the same penalty rather than the blank branch.

**Why this reads as a real inconsistency rather than an edge case:** the same
file already argues the opposite direction, twice.

- Coding: *"no verdict yet … → manual review … Falling through to `awardFor`
  with a manufactured zero would mark a candidate wrong for an outage, and
  would do it silently."*
- `scoreMCQMultiplier`'s own header: *"add an mcq variant and forget this
  function, and every candidate who answers it CORRECTLY is silently marked
  zero. Nothing surfaces."*

That is this bug, one level down — on the key instead of the variant.

**Fix.** An unusable key is unknown, not wrong.

```ts
// in scoreAttemptAnswers, before dispatching to the engine
const keyMissing =
  (q.engine === 'mcq'   && (ans.correctIds   ?? []).length === 0) ||
  (q.engine === 'match' && (ans.correctPairs ?? []).length === 0);
if (keyMissing) { requiresManualReview = true; gradedAnswers[aq.questionId] =
  { isCorrect: null, marksAwarded: 0, unavailable: true }; continue; }
```

…mirroring the `!q` branch directly above it, which already gets this right for
a vanished question. Then close the source: require a non-empty key in
`validate()` for Match, and validate the payload server-side (F-11).

---

## 🟡 F-05 · The withheld mark is on the document the student reads

**Where:** `firestore.rules:863`, `functions/src/index.ts:4586` (`updates.scores`,
`updates.gradedAnswers`).
**Reproduced:** `audit.pipeline.cjs` F-05.

`gradeAttempt` writes `scores` and `gradedAnswers` onto the attempt. Students
read their own attempt in full. `showResults` and `allowReview` are consulted
only by `ExamResultsPage.tsx` (`:614`, `:629`, `:830`) and
`StudentAssessmentsPage.tsx` (`:183`), so both are **presentation, not
enforcement**: `showResults: false` renders "results withheld" over a document
that already contains the result.

Answer **keys** are correctly gated — `exposeKeysToStudent` comes from
`reviewAudienceAllows(assessment, 'students')`, and N5 got that right. But
`isCorrect` and `marksAwarded` are written **per question, unconditionally**:

```json
gradedAnswers.q1 = { "isCorrect": false, "marksAwarded": -2.5 }
```

On a single-attempt exam this is an embargo failure — real, since embargoes
exist for moderation, but bounded. On an exam with `maxAttempts > 1` it is an
**oracle**: sit, submit, read per-question correctness from the console, and
return knowing exactly which items were wrong. Repeat.

The platform already knows how to do this properly — `provisionalGrades` is a
separate collection with no student read, chosen for exactly this reason
("keeping the mark out of the attempt document makes that structural instead of
a UI promise"). The same argument applies to a withheld final mark.

**Fix.** Either write `scores` / `gradedAnswers` to a sibling collection that
students cannot read and serve them through a gated callable, or — smaller
change, most of the benefit — omit `isCorrect` from `gradedAnswers` when the
student is not in the review audience, and hold back `scores` when
`showResults` is off.

---

## 🟡 F-06 · `requireSEB` is outside the publish freeze

**Where:** `firestore.rules:649-660`; `functions/src/index.ts:8122`.

The post-`securityLockedAt` immutability clause names exactly seven fields:

```
securityTier · deliveryMode · requireCamera · allowMobile
requireExtensionCheck · autoResume · securityLockedAt
```

`requireSEB` and `sebConfigKeys` are not among them — the strings do not appear
in `firestore.rules` at all. Meanwhile `startExam` re-derives the requirement
from the **live** document before freezing it onto the attempt:

```ts
const requireSEB = isLegacy
  ? false
  : (a.requireSEB ?? (tier === 'high_stake'));            // :8122 — the LIVE doc
```

So an assessment can be published as `high_stake` with SEB required, stamped,
and then have `requireSEB` flipped to `false` — after which every student
admitted from that moment sits without Safe Exam Browser, while `securityTier`
still reads `high_stake` everywhere in the UI. Attempts already in flight are
unaffected (the requirement is frozen onto `securityConfig`), which is exactly
why this is easy to miss.

**Latent today, not exploitable:** no edit surface writes `requireSEB` after
creation (`editableFields()` does not expose it, and `BehaviourPatch` does not
carry it). It is a hole in the wall behind a door nobody has cut yet — which is
the right time to fill it.

**Fix.** Add both fields to the immutability list. One line each, no behaviour
change for any existing document.

---

## 🟡 F-07 · Auto-termination is the client's decision

**Where:** `functions/src/index.ts:7009` (`logViolation` return).

`logViolation` is properly hardened — append-only, server-incremented, session
-checked, bounded — but it *reports* the threshold rather than acting on it:

```ts
return { ok: true, warnings, thresholdReached: warnings >= MAX_INTEGRITY_WARNINGS_S };
```

The termination itself is the shell calling `gradeAttempt('terminated')`. A
client that simply ignores the flag keeps sitting the exam. Since a client that
would ignore the flag would also not report the violations, this is close to
inherent — but it means auto-termination is a **detective** control described
in the product as a preventive one.

**Options, both small:** have `logViolation` set `status: 'terminated'` itself
once the threshold is crossed (it already holds the attempt and the counters),
or leave the client in charge and state plainly in the docs that termination is
best-effort. The current state — enforcement that looks preventive and is not —
is the one option worth leaving behind.

---

## 🟢 F-08 · `passingScore` is not part of the frozen contract

**Where:** `functions/src/index.ts:8860` (`buildExamSnapshot`);
`useEditableFields.ts:65` (`passingScore: true` while `active`).

`examSnapshot` freezes the paper, marks, section limits, grace values,
`overallTimeLimit`, `sectionStartOrder` and `deliveryMode`. It does **not**
freeze `passingScore`, and `examContractFor` merges the snapshot *over* the
live document — so the pass mark is read live at grade time, and the edit panel
allows changing it on an active assessment.

A student who started under a 40% pass mark can be failed against 70% set while
they were still writing. Everything else about their contract is immutable;
this one number is not. Add it to `buildExamSnapshot`, or state deliberately
that the pass mark is a moderation decision and belongs live — but the current
split looks accidental rather than chosen.

---

## 🟢 F-09 · `answeredAt` is client-written, and analytics trusts it

**Where:** `src/lib/submissionService.ts:816` (`saveAnswers`);
`functions/src/index.ts:4708` (`timingAnalysis`).

In standard delivery the whole answer object — `value`, `sectionId`,
`answeredAt` — is composed in the browser and written directly. `gradeAttempt`
then computes `burstLast30s`, `minGapSeconds` and `anomalyScore` from those
timestamps.

The marks are unaffected (scoring reads `value` only), and the field is
labelled detective throughout, so this is correctly scoped. It is worth
recording because it is the reason F-03's option 2 is weaker than it looks:
a grade-time comparison of `answeredAt` against `submittedAt` is trivially
defeated by the same client that made the late write.

Sequential delivery does not have this problem — `submitAnswerAndAdvance` and
`saveAnswerNoAdvance` stamp `answeredAt` server-side.

---

## 🟢 F-10 · The sweep's range query matches null locks

**Where:** `functions/src/index.ts:1417`; `:8452`.

```ts
.where('status', '==', 'in_progress')
.where('answersLockedAfter', '<', now)
.limit(500)
```

The comment above it reasons: *"Firestore range queries skip documents missing
the field entirely, which is exactly right — a legacy or genuinely untimed
attempt has no deadline to be past."* The premise does not hold, for two
independent reasons:

1. `startExam` writes the field **as `null`**, not absent
   (`answersLockedAfter: initialLocks.combined ? Timestamp.fromDate(...) : null`),
   so an untimed attempt carries it.
2. Firestore orders index entries **by type first**, and `null` sorts before
   `timestamp`. A `< <Timestamp>` filter therefore matches every null-valued
   document, and — because an inequality filter implies an ascending order on
   its field — returns them **first**.

The blast radius is bounded by D-24: each candidate is re-checked with the
resolver, which correctly answers "not ended", so nothing is wrongly closed.
What is not bounded is the **500-document limit**. Enough untimed or legacy
attempts carrying a null lock will fill the page ahead of every genuinely
expired attempt, and the sweep stops closing anything. It fails quiet — the log
line reports `expired=500 … left open 500`, which reads like a busy hour.

**Fix,** either of:
- omit the field entirely when there is no bound (`FieldValue.delete()` /
  don't write it), making the original comment true; or
- add a lower bound: `.where('answersLockedAfter', '>', new Timestamp(0, 0))`.

Worth confirming against the emulator first — one query in
`test/rules.suite.cjs`'s harness settles it, and it is the only finding here
that rests on Firestore's semantics rather than on this repository's code.

---

## 🟢 F-11 · The question-write callables validate nothing

**Where:** `functions/src/index.ts:10278` (`createQuestionAsRole`), `:10339`
(bulk), `:10415` (edit).

The rights model is enforced properly — `assertQuestionRight` checks the
institute ceiling, the per-faculty grant, the mode, the tenant stamp, and
ownership on edit. What happens next is:

```ts
const src = request.data?.question;
if (!src || typeof src !== 'object') throw new HttpsError('invalid-argument', 'Missing question payload.');
const { id } = await execCreateQuestion(db, owner, src, { ... });
```

`src` is spread into the document unexamined. There is no check that `engine`
is one of the four known values, that `stem` is non-empty, that an MCQ carries
options and a key, that arrays are arrays, or that the payload is of bounded
size. `firestore.rules` cannot compensate — it deliberately narrowed these
collections to `isWebOwner()` precisely so that *these callables* are the
gate.

Nothing here is a privilege escalation: the writer is authorised, and the
tenant stamp and ownership fields are assigned server-side. It matters because
it is the supported route to F-04's empty key, and because an unknown `engine`
value survives all the way to grading, where it lands in the `else` branch and
becomes a permanent manual-review item on a paper with no manual-marking
workflow (the known gap already recorded in `audit.probe.cjs`).

**Fix.** A ~30-line `validateQuestionPayload()` in `execCreateQuestion`,
mirroring the drawer's `validate()` and returning `invalid-argument`. The
shared executor means one implementation covers the single, bulk and
request-approval paths at once.

---

## Reproducing

```bash
cd functions
npm install && npm run build
node test/audit.pipeline.cjs      # F-01 … F-05, against the compiled callables
npm test                          # the existing gate — green, unchanged
```

`audit.pipeline.cjs` is deliberately **not** wired into `npm test`. It passes by
reproducing bugs, so a green run there means the findings are still open;
adding it to the gate would either make the gate red for the wrong reason or
enshrine the broken behaviour as the spec. As each finding is fixed, invert its
probe into an assertion, move it beside the regression it belongs with in
`audit.round3.cjs` or `exam.e2e.cjs`, and delete it from the punch list. When
the file is empty, delete the file.

## Suggested order

1. **F-01** — one guard, closes F-02 with it, and it is the largest single
   integrity hole in the pipeline.
2. **F-04** — smallest diff of the four reds, and the only one that silently
   changes marks on papers already sat. Worth a one-off scan of
   `questionAnswers` for empty keys on questions that appear in any
   `examSnapshot`.
3. **F-03** — needs a design decision (option 1 vs 3 above) before code.
4. **F-05, F-06** — small, self-contained, no behaviour change for existing
   documents.
5. **F-07 … F-11** — as capacity allows; F-10 first among them, since it fails
   quietly and gets worse with scale.
