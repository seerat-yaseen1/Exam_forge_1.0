# Plan — Server-Authoritative Exam Time Transitions

## Context

The exam flow currently trusts the student's local system clock for every time-related decision: whether the exam is open (`startDate`), when a section starts, when a section ends, when a break ends, and how much time is left in the running countdown. A student who runs `Date.now = () => …` in DevTools or changes their OS clock can:

- Enter an exam before `startDate` (bypasses M4 gating).
- Keep answering past `endDate` (bypasses the current 30 s auto-submit interval).
- Get unlimited per-section time (spoofs `SectionTimer`'s `now − startedAt` math).

The user proposed the correct architectural fix: **the server owns time transitions, the client owns display**. The server stamps every critical timestamp (start of exam, start of section, submit of section, start/end of break). The client's countdown is a display anchored to those server-set timestamps — a spoofed local clock only makes the countdown *display* wrong, and any attempt to submit past the server-side deadline is rejected. No per-second polling; server is contacted only at the ~4–6 real transitions per exam.

**Cloud Functions with admin SDK are already the trusted pattern here** — `gradeAttempt` (functions/src/index.ts:350) does exactly this for grading. This plan extends the same pattern to section start/submit/break.

---

## Design

### Server-authoritative transitions

| Transition | Today (client) | New (server) |
|---|---|---|
| Create attempt | `startAttempt` in submissionService writes `startedAt: now()` and section 0's `startedAt: now()` | `startExam` Cloud Function; checks `startDate ≤ request.time`, writes `serverTimestamp()` |
| Start next section | `submitSection` / `pickSection` / `endBreak` write next section's `startedAt: now()` | `startSection` Cloud Function; writes `serverTimestamp()` |
| Submit section | `submitSection` writes `submittedAt: now()` | `submitSection` Cloud Function; checks `request.time ≤ sectionStartedAt + timeLimit + grace`; writes `serverTimestamp()` |
| End break → start next | `endBreak` writes next section's `startedAt: now()` | Folded into `startSection` Cloud Function; verifies `request.time ≥ breakEndsAt` |
| End of exam | `gradeAttempt` (already Cloud Function) | Unchanged |

Answer autosave (`saveAnswer`), violation logging (`logViolation`), and session registration (`registerSession`) stay client-side — their timestamps are metadata, not enforcement. The tight C1 rule already scopes what a student can write.

### Client-side display: clock-skew correction

On exam load, the client computes `skew = serverNow − clientNow` (one Cloud Function ping returning `serverTimestamp()`). The `SectionTimer` displays `startedAt + timeLimit − (Date.now() + skew)`. If the student later spoofs their clock, the display keeps counting correctly because the skew was captured before tampering — and even if the display is fooled, the server rejects the submit past the real deadline.

### Grace window — configurable per assessment

Deadline enforcement is **strict** (server rejects late submits and auto-finalizes with what's on record), but the grace duration is set per assessment by the Web Owner.

- Effective grace = `assessment.sectionGraceSeconds ?? DEFAULT_GRACE_SECONDS` (default `30` — enough to absorb network latency).
- Web Owner can raise it (e.g. `300` = 5 minutes) for exams where a soft-close is acceptable.
- Rejection fires only when `request.time > sectionStartedAt + timeLimit + effectiveGrace`.

**Schema addition**: `Assessment.sectionGraceSeconds?: number` (optional). Applies uniformly to every section; a per-section grace could be a later refinement.

**Builder UI**: add one field to the assessment Setup panel — a small numeric input labeled "Section grace period (seconds)" with help text *"Extra time allowed past each section's timer for late submissions. Leave blank to use the default (30 seconds)."*. Follows the same pattern as `maxAttempts` in the existing builder. Mobile-friendly per standing rule.

### Migration for in-progress attempts

Existing `in_progress` attempts have client-set `startedAt` timestamps. On resume:
- **Grandfather** them: the resume path continues to trust the existing timestamps. No re-anchoring, no forced termination.
- **New attempts** (`startExam` call) use server timestamps from that point forward.

Rationale: re-anchoring mid-exam is unfair; deprecation of client timestamps happens naturally as in-flight attempts finish.

---

## Files to modify

### `functions/src/index.ts` (add 4 new callables)
- `getServerTime` — trivial; returns `{ serverTime: Date.now() }`. Used by client for skew calibration.
- `startExam` — replaces `startAttempt`'s create path. Validates `startDate ≤ now`, `blockedStudents`, attempt-limit gate. Uses admin SDK to write attempt doc with `serverTimestamp()` for `startedAt` and section 0's `startedAt`. Returns the created attempt.
- `startSection` — the unified "next section is now beginning" call. Used by (a) `submitSection` internal flow when advancing sequentially, (b) `pickSection` in student_choice mode, (c) `endBreak` after a configured break. Verifies section is next in order, break has elapsed if applicable, writes `sectionTimings[sectionId].startedAt = serverTimestamp()`.
- `submitSectionCF` — replaces client `submitSection`. Reads assessment + attempt, verifies section is current, computes `effectiveGrace = assessment.sectionGraceSeconds ?? 30`, verifies `request.time ≤ sectionStartedAt + timeLimit + effectiveGrace`, writes `submittedAt = serverTimestamp()`. Advances `currentSectionIdx`. Does NOT auto-start next section — that's a separate `startSection` call so break UX is preserved. On rejection returns `HttpsError('deadline-exceeded', …)`.

Follow the exact AuthN/AuthZ pattern already used in `gradeAttempt` (functions/src/index.ts:350–398).

### `src/lib/submissionService.ts` (thin wrappers)
Replace the internals of `startAttempt`, `submitSection`, `pickSection`, `endBreak` with `httpsCallable` calls to the new Cloud Functions. The public function signatures stay identical so `ExamShell` doesn't need per-call rewrites — this keeps blast radius small. Add a new `getServerSkew()` helper that calls `getServerTime` once and returns the delta.

`saveAnswer`, `logViolation`, `registerSession` — unchanged.

### `src/app/components/exam/SectionTimer.tsx`
Add optional prop `nowFn?: () => number` (default `Date.now`). ExamShell passes a nowFn that returns `Date.now() + skew`. This isolates the timer from wall-clock spoofing without other changes.

### `src/app/pages/student/ExamShell.tsx`
- On load (after `startExam` returns), call `getServerSkew()` once, stash in state, pass to `SectionTimer` via new `nowFn` prop.
- On `submitSectionCF` rejection (deadline-exceeded response), transition to `error` shell status with clear message. This is the safety net if the client's own timer somehow missed the mark.
- No other logic changes — the callables return the same shape as the existing client writes.

### `firestore.rules`
Tighten the existing student `attempts` update whitelist to disallow direct client writes to `sectionTimings.*.startedAt` and `sectionTimings.*.submittedAt`. Force them through Cloud Functions. Rule structure:
- Keep the current whitelist for top-level `sectionTimings`.
- Add a further check: `request.resource.data.sectionTimings` map values only differ in `timeUsedSeconds` field vs `resource.data.sectionTimings`.

If field-level diff proves too complex for Firestore rules language, fall back to removing `sectionTimings` from the whitelist entirely — since all writes to it now flow through Cloud Functions (admin SDK bypasses rules), the client never legitimately writes it anymore.

### `src/app/pages/student/ExamBriefingPage.tsx`
No changes needed. The client-side `new Date() < startDate` check stays as a UX gate (shows the "not yet open" panel). `startExam` server-side check is the enforcement.

### `src/lib/assessmentService.ts` + Assessment builder
- Add `sectionGraceSeconds?: number` to the `Assessment` type.
- Include it in `createAssessment` / `updateAssessment` write payloads (via `removeUndefined`).
- Add one numeric input to the builder Setup panel (in `AssignmentsPage.tsx` — the Basics row, alongside where `maxAttempts` is edited). Optional field, defaults to blank (server falls back to 30 s). Follow the existing input styling.

---

## Verification

1. **Unit-level (Cloud Function tests via emulator):**
   - `startExam` before `startDate` → rejected with `failed-precondition`.
   - `startExam` after `endDate` → rejected.
   - `submitSectionCF` within window → accepted, `submittedAt` set to `serverTimestamp()`.
   - `submitSectionCF` past deadline + grace → rejected.
   - `startSection` while break not yet ended → rejected.

2. **End-to-end manual test:**
   - Take a full exam start-to-finish; verify no user-visible change. Timer should count down correctly.
   - Open DevTools console, run `Date.now = () => Date.now.__proto__.call(this) - 3600000` (spoof 1 hour back). Timer display should stay accurate (skew was captured pre-tamper). Attempting to submit past real deadline → rejected with clear error.
   - Attempt to hit `/student/exam/<id>/shell` directly before `startDate` → briefing/shell shows "not yet open" panel.
   - Resume an in-progress attempt created *before* this change → works normally (grandfathered).

3. **Cost sanity check:**
   - Count Cloud Function invocations per exam: 1× `startExam` + 1× `getServerTime` + N× `startSection` + N× `submitSectionCF` = 2 + 2N where N = section count. For a typical 3-section exam that's 8 calls/student/attempt. At $0.40/M invocations, negligible.

---

## Rollout order

1. Deploy `getServerTime` + `startExam` first; wire client. Old students in flight are unaffected.
2. Deploy `startSection` + `submitSectionCF`; wire client. Old in-flight attempts continue via legacy path (client keeps calling old `submitSection` for grandfathered attempts — detect via a flag on the attempt doc or by absence of `serverAnchored: true`).
3. After all in-flight attempts drain (or one grace period), tighten `firestore.rules` to disallow direct client `sectionTimings` writes.
4. Delete legacy client code paths in `submissionService` (`submitSection`, `pickSection`, `endBreak`) once the rule tightening is live.

---

## Decisions locked in

- **Deadline enforcement**: **strict** — server rejects late `submitSectionCF` and auto-finalizes server-side with whatever answers are on record.
- **Grace period**: **per-assessment**, configurable by the Web Owner (`sectionGraceSeconds`), defaulting to 30 s if not set.
- **Migration**: **grandfather** existing in-progress attempts on the legacy client-timestamp path; new attempts use server timestamps from the moment `startExam` ships.
