# Web Owner ↔ Student — feature gap analysis

What the Web Owner can and cannot do *about students*, verified against the
code (not the plans). Every claim below carries a file:line so it can be
re-checked or disproved.

---

## 0 · What already works

Worth stating first, because the gaps are narrower than they look. The Web
Owner today can:

| Capability | Where |
|---|---|
| Create a student, one at a time | `src/app/components/student/AddStudentDrawer.tsx` |
| Bulk-import students | `src/app/components/student/BulkStudentModal.tsx` |
| Enable / disable / remove a student | `StudentTab.tsx:491`, `:505` |
| Resend the password-setup mail | `StudentTab.tsx:218` |
| Map students onto school → course → semester | `components/schools/StudentMappingDrawer.tsx`, `NodeStudentRoster.tsx` |
| Allocate students to an assessment (incl. manual add) | `components/assignments/allocation/*`, `addManualMember` (functions:11467) |
| Watch a live roster, freeze / unfreeze with a time grant | `AssessmentRosterCore.tsx:214`–`:710` |
| Block / unblock a student from an exam | `AssessmentRosterCore.tsx:727`–`:850` |
| Read every answer, with per-question classification | `ResponseViewer`, `AssessmentRosterCore.tsx:980` |
| See the integrity + anomaly panel for an attempt | `AssessmentRosterCore.tsx:2366`–`:2416` |
| Grant extra attempts to one student | `setAttemptOverride`, `assessmentService.ts:1815` |
| Soft-delete an attempt (web-owner only) | `AssessmentRosterCore.tsx:1550`, audit S-03 |
| Re-judge coding / regrade a whole assessment | `rejudgeAttemptCoding`, `regradeAssessmentAttempts` |
| **Hand-mark a subjective answer, with feedback** | `setManualMark`, `MarkingPanel` — see §1 |
| Triage student-flagged questions | `ReportsInboxCore.tsx`, `questionReportService.ts` |
| Export results | `ResultsExportModal.tsx`, `resultsExport.ts` |
| Run GDPR erasure / deletion approvals / purge | `ErasurePolicyPanel`, `DeletionApprovalsInbox`, `InstitutePurgePanel` |

The shape of the gap: **the Web Owner is well equipped to run an *exam*, and
poorly equipped to deal with a *student*.** Almost every student-facing power
is reachable only through an assessment.

---

## 1 · ✅ There was no way to grade a subjective answer — *fixed*

> **Closed.** `setManualMark` is the path, the roster carries the marking
> control and a per-exam queue, and the student sees the mark and the
> examiner's note. Covered by `functions/test/manual.grading.cjs` (14 probes),
> rules probe R-09b, and `src/lib/manualGrading.test.ts`. The original finding
> is kept below, followed by what was built.

The single largest hole. It was not a missing screen — it was a missing half of
the grading pipeline.

- `functions/src/index.ts:4333-4335` — every text-engine answer sets
  `requiresManualReview = true`.
- `functions/src/index.ts:4331` — a coding answer whose verdict never arrived
  does the same.
- `functions/src/index.ts:4371-4373` — while that flag is set, `passed` is
  forced away from a true verdict.

Nothing in the platform ever clears it. Searching all 55 callables in
`functions/src/index.ts` turns up no manual-award endpoint; `src/lib` has no
service function for it; and all three UI references to the flag only *read*
it:

- `AssessmentRosterCore.tsx:2284` (staff badge)
- `StudentAssessmentsPage.tsx:217` (student badge)
- `ExamResultsPage.tsx:687` (student badge)

Meanwhile `src/lib/itemTypes.ts` treats manual scoring as first class —
`ItemScoring = 'auto' | 'manual' | 'hybrid'` (`:121`) — and ships three
subjective item types with `scoring: 'manual'` (`:378-399`), one of whose
`today` notes already admits "no word counter or rubric grid yet" (`:401`).

**Consequence:** any assessment containing one subjective item can never be
finalised. The attempt is permanently stuck displaying "needs manual review",
to staff and student alike. The `attemptOverrides` control is an *attempt-count*
override (`assessmentService.ts:967`), not a score override — there is no score
override anywhere.

**What was missing:** a grading queue, a per-answer award-marks UI with the
model answer alongside, a callable that writes the award with grader identity
and timestamp, recomputation of section + total + pass/fail, and clearing of
the flag.

### What was built

**`setManualMark`** (`functions/src/index.ts`) — graders only (webOwner, or
institute/faculty of the attempt's institute); finished, non-withdrawn attempts
only. It bounds the award to `[0, the marks the question carried on the paper
that student sat]`, writes the grading record, then **re-scores the whole
attempt through `scoreAttemptAnswers`** — the same function every other grading
path uses. Nothing computes a total by hand, so a hand-marked paper cannot
drift from a machine-marked one.

**The mark is an input to scoring, not a patch applied after it.** This is the
property everything rests on. Marks live in `attemptManualMarks` and are loaded
by all five `scoreAttemptAnswers` call sites — `gradeAttempt`,
`regradeAttempts`, `gradeProvisional`, the expiry sweep, and the judging sweep.
A call site that forgot the parameter would silently erase a cohort's marking
on the next regrade; probes M-09 and M-10 exist for exactly those two paths and
were verified to fail when the parameter is removed.

**Coding answers are covered too, with a boundary.** Text is always
hand-markable — nothing else can mark it. Code is hand-markable only while no
usable verdict exists (judge down, or out of retries); once a verdict lands the
judge owns that number and `setManualMark` refuses with `ALREADY_JUDGED`. This
closes the second path into permanent limbo: a judge outage that outlasted its
backoff previously left the marks unreachable.

**What the student sees:** the award and the recomputed total, and the
examiner's feedback when the exam's review audience includes students. What
they never see is the grading record — who marked, under which role, how many
revisions — which is why it lives in its own staff-only collection rather than
on the student-readable attempt document (rules probe R-09b).

**Where the work appears:** a *Needs marking* filter on the roster, counting
papers waiting on a **person** — `requiresManualReview` minus those still
waiting on the judge, which resolve themselves. The marking control sits in the
answer drawer where the answer and model answer already are.

**Still open:** the queue is per-assessment. A cross-assessment "everything
waiting on me" view depends on the student-level/cross-assessment reads
described in §2, and is deliberately not built here.

---

## 2 · 🔴 Everything is assessment-scoped — there is no student-level view

`getAttemptsByStudent` exists (`submissionService.ts:1653`) and is called from
exactly one place: `StudentAssessmentsPage.tsx:638` — the *student's own*
dashboard. `getAttemptsByInstitute` (`:1684`) has **zero callers**.

So the Web Owner can answer "how did this exam go?" but not "how is this
student doing?" There is no per-student record: no history across assessments,
no score trend, no attendance/no-show pattern, and — most seriously for an
integrity product — no way to see that the same student has triggered
violations in five different sittings. Integrity is only ever read one attempt
at a time (`AttemptsPanel` is scoped to `(studentId, assessmentId)`,
`AssessmentRosterCore.tsx:1622`).

**What's missing:** a student profile page — identity, institute, hierarchy
placement, activation state, every attempt, every violation, every report they
filed, every action staff took on them.

---

## 3 · 🔴 No cross-institute student directory or search

The only path to a student is
User Management → institute → detail → Users → Students
(`InstituteDetailPage.tsx:395`). Consequences:

- The Web Owner cannot look a student up by email or name platform-wide. A
  support mail from a student is unactionable without first knowing their
  institute.
- `StudentTab` has no search box, no filter, and no pagination — it loads
  *every* student in the institute and re-polls all of them every 5 seconds
  (`StudentTab.tsx:107-110`). That is fine at 50 students and unusable at 5,000.
- There is no platform-wide "invited but never signed in" queue, despite
  `firstLoginRequired` being tracked on every record
  (`firebaseService.ts:198`).

---

## 4 · 🟡 Student records are write-once — no edit path

`AddStudentDrawer` is create-only: it rejects an existing email outright
(`:152-153`) and has no edit mode. `StudentTab`'s row actions are limited to
resend / enable-disable / delete (`:479`, `:491`, `:505`).

So a misspelled name, a changed email address, or a wrong
program / section / specialisation (`Student`, `firebaseService.ts:178-207`)
can only be corrected by deleting and recreating the student — which severs
the identity their attempts are keyed to, and on this platform routes through
a deletion-approval flow.

Two related model gaps:

- No roll number / enrolment number, no phone, no photo. At exam time there is
  no field to verify a candidate's identity against, which sits oddly beside a
  webcam face monitor (`components/exam/FaceMonitor.tsx`).
- `role` is genuinely inconsistent in stored data — `'Student'` from the bulk
  path, `'student'` from the drawer (documented at `firebaseService.ts:183-196`).
  Inert today, but a backfill nobody can run from the UI.

---

## 5 · 🟡 Accommodations can only be granted reactively, mid-exam

The only per-student pre-exam override is the attempt count
(`attemptOverrides`, `assessmentService.ts:967`). Searching the whole repo for
`extraTime`, `accommodat*`, `timeOverride` returns nothing.

Extra time exists only *inside the unfreeze modal*
(`AssessmentRosterCore.tsx:320-710`) — it is compensation for a freeze, not an
accommodation. To give a student with a documented need 25% extra time, a
Web Owner must freeze them mid-exam and then unfreeze them with a grant.

**What's missing:** a per-student accommodation attached to the allocation —
extra time (absolute or %), SEB exemption, break allowance — applied at
`startExam` rather than improvised during the sitting.

---

## 6 · 🟡 There is no channel to a student

No notification, announcement, message, or ticket model exists anywhere in
`src/lib`. The only mail the platform sends a student is Firebase Auth's
invite/reset (`StudentTab.tsx:218`).

The student UI, meanwhile, tells them to seek help through a channel that does
not exist — four times:

- `ExamShell.tsx:736` — "Contact your invigilator to continue."
- `ExamShell.tsx:1441` — "Contact your invigilator if you believe you should be granted another attempt."
- `ExamBriefingPage.tsx:469` — "Please contact your invigilator or faculty member…"
- `ExamBriefingPage.tsx:526` — "Contact your faculty if you believe additional attempts should be granted."

The one real student→staff channel is a question report filed during an
attempt (`questionReportService.ts:111`). Anything else — a blocked login, a
crashed exam, a disputed termination — has no in-app route in, and no inbox on
the Web Owner side to receive it.

**What's missing (in order of value):** an in-exam "raise a problem" that
reaches the roster live; a support inbox for the Web Owner; outbound
notices (exam scheduled, results published, account suspended).

---

## 7 · 🟡 No audit-log viewer

`src/lib/deletionAudit.ts` exposes `getAuditForEntity` (`:273`),
`getAuditForInstitute` (`:289`) and `getRecentAudit` (`:303`).

**No `.tsx` file imports any of them.** The read side was built; nothing
renders it.

Every staff action against a student — freeze, unfreeze with a grant, block,
attempt deletion, extra attempts, account disable, erasure — is recorded and
invisible. For a platform whose pitch is exam integrity, the Web Owner cannot
produce a chain of custody for a contested result.

---

## 8 · 🟡 The Web Owner's dashboard home is deliberately empty

`src/app/pages/LandingPage.tsx:12` — *"Intentionally empty — a system at rest
is a system in control"* — renders `COMMAND CENTER / Modules will appear here`.

There is no platform-level student signal at all: no headcount, no exams live
right now, no attempts stuck in manual review, no accounts invited but never
activated, no open question reports, no anomaly outliers. Every question the
Web Owner has about students begins with a manual drill-down through
institutes.

---

## 9 · 🟢 No student-eye preview / dry run

`PreviewModal` (`AssessmentModals.tsx:171`) shows metadata only — title,
marks, sections, schedule, order mode. The Web Owner cannot sit their own
paper: no way to see shuffling, section gating, the SEB gate, the timer, or
how a given item type actually renders, before students meet it.

This is structural, not just a missing button — the exam shell lives at
`/student/exam/:assessmentId/shell` behind `StudentRoot`'s student session
(`routes.tsx`), so there is no staff-authenticated way in.

---

## 10 · 🟢 Individual-student recovery tools

- **No forced sign-out.** `revokeSessions` (`functions/src/index.ts:11627`)
  reads `request.auth.uid` and takes no target parameter — it is strictly
  self-scoped, and its only caller is the user's own password-change flow
  (`sessionSecurity.ts:42`). A student with a stuck or duplicated session
  cannot be signed out by staff.
- **No session/device inspection.** `registerSession` records device data
  (`functions:6814`), but nothing surfaces "where is this student signed in".
- **Blunt unblocking.** The only lever for a student stranded at the gate is
  block/unblock for the entire exam.

---

## Suggested order

Judged by *harm if left undone*, not by build cost:

1. ~~**Manual grading** (§1)~~ — **done.** See §1.
2. **Student profile view** (§2) — unlocks integrity-pattern detection and
   makes every support interaction possible.
3. **Directory + search, with pagination** (§3) — also fixes the 5-second
   full-collection poll before it becomes a cost problem.
4. **Edit student + identity fields** (§4) — small, and removes a
   delete-and-recreate practice that destroys attempt lineage.
5. **Audit-log viewer** (§7) — the data is already written and the read
   functions already exist; this is a UI-only task.
6. **Accommodations** (§5), **communication** (§6), **dashboard** (§8),
   **preview** (§9), **session control** (§10).

Items 5 and 9 are the cheapest real wins: both are pure UI over machinery that
already exists.
