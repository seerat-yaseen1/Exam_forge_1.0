# Exam Forge — Architecture & System Boundaries

**What this is.** A reference description of the system as it stands, written for someone who has
to change it. Not a changelog: where a decision looks odd, the reasoning is here so it doesn't get
"fixed" by someone who doesn't know what it prevents.

**Status.** Originally an audit (2026-08-15) whose findings have since been worked through. The
findings, their outcomes, and the three places the audit was *wrong* are in
[Appendix A](#appendix-a--audit-history). Open work is in [§9](#9--open-work).

**Standing caveat.** Everything here is derived from the repository. Deployed state that source
cannot establish — App Check console enforcement, Cloud Scheduler enablement, Judge0 cluster
health, Vercel environment variables, IAM grants — is marked ⚠️ where it appears.

---

## 0 · At a glance

| | |
|---|---|
| Product | STRATUM / Exam Forge — multi-tenant online examination platform |
| Tenancy | Web Owner (platform) → Institute → Faculty → Student |
| Frontend | React 18 + Vite 6 SPA, React Router 7, on **Vercel** |
| API | **53 callable + 4 scheduled** Firebase Functions (Gen 2, Node 24), all `us-central1` |
| Data | Firestore, **49 rule-governed collections**; Storage, 2 prefixes |
| Identity | Firebase Auth, single tenant, role in **custom claims** |
| Edge | Two Vercel routes: `/api/seb-verify`, `/api/csp-report` |
| Sandbox | Self-hosted Judge0, 4 workers, private VPC, no external IP |
| Locale | **`en-GB`** — `15 Aug 2026`, 24-hour clock |

**Size.** ~82,200 LOC frontend (239 files, 28 test files) · 16,914 LOC functions (5 files, one of
them 13,959) · 1,457 lines of Firestore rules · 63 of Storage rules.

**Tests.** 487 frontend · ~1,071 server assertions across 13 headless suites · 169 more across 3
emulator suites · plus a 13,446-state timing sweep (84,062 property assertions).

---

## 1 · Trust zones

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ZONE 0 — UNTRUSTED · the candidate's machine                                 │
│   Browser / Safe Exam Browser                                                │
│     React SPA          Root ─ PlatformSettings ─ AuthProvider                │
│                          ├── /dashboard  (Web Owner)                         │
│                          ├── /institute · /faculty · /student                │
│                          └── exam/:id/{briefing,shell}   ← CRITICAL PATH     │
│                                ExamShell · IntegrityEngine · FaceMonitor     │
│     src/lib/*          41 service modules — the only Firebase callers        │
└───┬────────────┬────────────────┬──────────────────────┬─────────────────────┘
    │            │                │                      │
    │ static     │ callable       │ Firestore/Storage    │ POST + SEB header
    │            │ ID + AppCheck  │ SDK · ID token       │ + ID token
    ▼            ▼                ▼                      ▼
┌────────┐  ┌──────────────────┐  ┌────────────────┐  ┌─────────────────────────┐
│ ZONE 1 │  │ ZONE 2 — TRUSTED │  │ ZONE 3         │  │ ZONE 1 — SEMI-TRUSTED   │
│ Vercel │  │ Cloud Functions  │  │ Firestore +    │  │ Vercel serverless       │
│ CDN    │  │ us-central1      │  │ Storage        │  │ /api/seb-verify         │
│        │  │ 53 callable      │  │                │  │ /api/csp-report         │
│ SPA    │  │  4 scheduled     │  │ RULES ARE THE  │  │                         │
│ assets │  │                  │  │ ONLY GUARD on  │  │ · reads SEB hash header │
│ /models│  │ ADMIN SDK        │  │ this path      │  │ · verifies ID token     │
│        │  │ ─ bypasses ───►  │  │ 49 collections │  │ · mints HMAC proof, 90s │
└────────┘  └───┬──────────────┘  └────────────────┘  └────────────┬────────────┘
                │                                                   │
                │ VPC · PRIVATE_RANGES_ONLY          shares SEB_SIGNING_SECRET
                ▼                                                   │
     ┌──────────────────────────┐                                   │
     │ ZONE 4 — PRIVATE         │◄──────────────────────────────────┘
     │ Judge0  10.128.0.2:2358  │
     │ 4 workers · no public IP │
     └──────────────────────────┘

  EXTERNAL: fonts.googleapis.com · reCAPTCHA v3 (App Check)
            face-api weights and xlsx are VENDORED — no install-time fetch
```

### The decision that shapes everything

**The browser talks to Firestore directly.** There is no API gateway in front of the data.
Security rules are the only guard on that path, and the Cloud Functions sit *beside* it — not in
front of it — to own the writes a candidate must never be able to forge.

That is why the attempt-update whitelist is the single most important control in the system, and
why so much of §2 is about which fields a client can and cannot move.

---

## 2 · The five crossings

Authorization rests entirely on Firebase Auth custom claims, minted only by `createAuthUser`
through the Admin SDK. A client cannot self-assign a role.

```
{ role: 'webOwner' }
{ role: 'institute', instituteId }
{ role: 'faculty',   instituteId, facultyId }
{ role: 'student',   instituteId, studentId }
```

| # | Crossing | Guard | On failure |
|---|---|---|---|
| **TB-1** | Browser → Firestore/Storage | Security rules + claims | closed (default deny) |
| **TB-2** | Browser → callable | Per-handler claim re-derivation; App Check ⚠️ | closed |
| **TB-3** | SEB → Vercel → functions | Config-key hash, then HMAC proof bound to uid **and** exam | closed on missing secret; **env-key fallback** on Firestore outage |
| **TB-4** | Functions → Firestore | **none** — Admin SDK bypasses rules; per-handler authz *is* the guard | n/a |
| **TB-5** | Functions → Judge0 | VPC private range + bearer token | **degrades silently** to manual review |

### TB-1 — what a student can write

One field. The rules narrow a student's attempt patch to `answers` + `updatedAt`, inside a
server-materialised time window.

Everything a candidate must not forge lives outside that whitelist, and each was removed for a
reason worth keeping:

| Field | Why it is server-only |
|---|---|
| `integrityLog` | `increment()` client-side was never protection — a plain `updateDoc` could reset the object to zeros. Now append-only via `logViolation`; a reported violation cannot be un-reported |
| `activeSessionId` | Was writable but compared by nothing, so the dual-device overlay was decoration. `registerSession` now holds a transaction |
| `sectionTimings`, `currentSectionIdx` | The per-section clock; forgeable from the console otherwise |

Also on this path: **hierarchy lifecycle fields** (`status`, `lifecycleState`, `archivedAt`,
`archivedBy`, `archivedByRole`, `lifecycleReason`) are fenced across all nine academic
collections, so archive/restore must go through `setHierarchyNodeLifecycle` — where the
`schoolsManagementEnabled` permission is actually checked and the audit row written. Renames and
metadata edits keep the direct path.

> **Why that fence exists.** `canWriteAcademic` gates on role and tenant only — it has never known
> about `schoolsManagementEnabled`. So the schools permission was decorative for anyone willing to
> open DevTools: revoking it hid the buttons and stopped nothing. An emulator probe against the
> unfenced rules confirmed an institute admin could set `status: 'archived'` and forge every field
> of the lifecycle envelope. Pinned by `R-10` in the rules suite.

### TB-2 — callables

Every handler re-derives identity from `request.auth.token`; none trusts payload identity.
Client-reported device data (`cameraDeclined`, `deviceClass`, `fingerprint`) is explicitly
advisory and documented as such. `startExam` still *accepts* client-supplied `sections` /
`shuffleQuestions` / `sectionStartOrder` for cached-client compatibility and **reads none of
them** — exam shape is derived server-side.

⚠️ **App Check is wired on all 53 callables but defaults to off.** See [§4](#4--staged-controls).

### TB-3 — why the edge function exists

Safe Exam Browser injects its config-key header **only on same-origin requests**, so it is
unreadable from `cloudfunctions.net`. Verification therefore happens on the app's own domain, and
the result crosses to the functions as a short-lived HMAC proof bound to both `uid` (stops one
student minting proofs for classmates in Chrome) and `aid` (stops a platform-config session being
replayed against an exam demanding its own key).

Both sides accept a **comma-separated secret list**: the edge mints with the first, the functions
accept any. That asymmetry is what makes rotation seamless — see `DEPLOY.md §9`.

### TB-4 — the Admin SDK bypasses everything

This is the intended privileged path, and it is what makes TB-1's whitelist workable: everything a
student must not forge is written here instead. The correctness of the whole model therefore rests
on each of the 57 handlers doing its own authorization. The consistent guards are `assertSEB`,
`assertSession`, `assertNotBlocked`, `assertInvigilator`, `assertQuestionRight`,
`assertInstituteActiveS`, `requireWebOwner`.

---

## 3 · The exam critical path

```
STUDENT              CLIENT                    SERVER                      STORE
   │ briefing
   ├──────────► ExamBriefingPage ─ getAssessment ──────────────────────► assessments (get)
   │                              ─ getSEBPublicInfo ──────────────────► publicSettings
   │            (extension scan — client-only, advisory)
   │
   │ if requireSEB:  POST /api/seb-verify ──► SHA256(url+configKey) vs header
   │                                          verify ID token (RS256)
   │                                          mint v1.<b64>.<hmac>, 90s TTL
   │
   ├──────────► startExam ─────────────────► assertSEB · assertNotBlocked
   │                                          membership: allocationMode 'rules'
   │                                            → assessmentMembers/{aid_sid}
   │                                            else legacy assignedTo
   │                                          freeze examSnapshot ──────► attempts (create)
   │                                          compute deadlines (examTimingCore)
   │
   ├──────────► getExamQuestions ──────────► sanitizeQuestionForStudent
   │                                          (whitelist; answer keys never sent)
   │ answering:
   │   debounce 1.5s ─────────────────────────────────────────────────► attempts
   │                                          RULES: answers + updatedAt only
   │   sequential   ─► submitAnswerAndAdvance / saveAnswerNoAdvance
   │   heartbeat 15s ─► examHeartbeat ──────► gaps · fingerprint drift · SEB re-proof
   │                                          · examMachine shadow warnings
   │   violations   ─► logViolation ────────► server-incremented, append-only
   │   code "Run"   ─► runCodeSample ───────► Judge0 (VPC)
   │
   └──────────► submitSection → gradeAttempt ─► scores + codeJudgePending ─► attempts
                                                          │
                scheduledJudgeCoding (5 min) ◄────────────┘
                  4 papers in flight, 240s budget ──► Judge0 ──► attemptVerdicts
```

**Answers take the unmediated path; everything that decides a mark does not.** Timing, section
transitions, session claims and the violation log all move through Zone 2, where the server can
refuse them.

---

## 4 · Staged controls

Four controls are **built, tested, and deliberately not switched on.** Each waits on evidence or a
grant that source cannot supply. This is the codebase's established pattern — `examTimingCore`
shipped inert with its sweep before anything depended on it.

| Control | Flag / state | What it waits on |
|---|---|---|
| **App Check enforcement** | `APP_CHECK_ENFORCED` (default off) — all 53 callables | ⚠️ Console shows Firestore 100% verified. Flip is a config change + redeploy, reversible the same way |
| **Exam state machine** | Shadow mode — classifies every transition, blocks none | One exam cycle with no `[examMachine] SHADOW` lines in `examHeartbeat` logs |
| **CSP** | Report-only for the meaningful directives; `/api/csp-report` collects | A quiet soak. Two entries look already-dead: `raw.githubusercontent.com` (now vendored) and `cdn.jsdelivr.net` |
| **Pre-exam warm-up** | `WARMUP_ENABLED` (default off) | ⚠️ `roles/run.developer` on the functions service account, **and** a spending decision — warm instances bill continuously |

Each fails safe: off means today's behaviour, exactly.

---

## 5 · Components

### Frontend

| | LOC | Owns |
|---|---|---|
| `App.tsx` | 41 | Error boundary **above** Suspense — a 404'd lazy chunk after redeploy rejects rather than suspends, so it needs the error boundary, not the Suspense one |
| `routes.tsx` | 223 | Whole route tree. Every page lazy; layouts and roots eager, to avoid a request waterfall |
| `ExamShell.tsx` | ~4,300 | **The sitting.** Sections, answers, timers, integrity, overlays, submit. 44 `useState`, 29 `useRef`, 32 `useEffect` |
| `AuthContext` | 378 | Web Owner + **TOTP MFA** — the only role with a second factor |
| `{Institute,Faculty,Student}AuthContext` | ~300 ea. | Per-role session shape and `login`. Admission and password ops are shared (below) |

### Service layer — `src/lib`, 41 modules

| | Owns |
|---|---|
| `submissionService` | The whole exam runtime API, and the only two realtime listeners |
| `assessmentService` · `questionBankService` | Assessment and question surfaces |
| `firebaseService` | Generic Firestore helpers, identity CRUD, the 9-level academic hierarchy |
| `firebase.ts` | **The single Firebase entry point** — env-configurable, 19 importers in `lib`, 33 across `src` |
| **`examMachine`** | 10 states, 26 edges — the exam's legal transitions, as data. Inert; see §4 |
| **`accessGate`** | May this person sign in? Institute + member lifecycle, expiry. One tested implementation |
| **`roleAuth`** | Password change / reset, shared across the three role contexts |
| **`dateFormat`** | Five `en-GB` formats, guarded against unparseable input |
| `instituteValidity` | `activeUntil` semantics — the display *and* enforcement halves |
| `twinSync.test.ts` | Guards client↔server↔rules list drift by reading source as text |

### Cloud Functions — `functions/src`

| | LOC | Owns |
|---|---|---|
| `index.ts` | **13,959** | All 57 exports + ~90 helpers |
| `examTimingCore.ts` | 1,228 | **The single implementation of every deadline** |
| `judgeCore.ts` | 948 | Provider-agnostic judge state machine |
| `judge0Adapter.ts` | 523 | Judge0 specifics — pinned language ids, base64 both ways |
| `allocationCore.ts` | 256 | Hierarchy rule → student set |

**Scheduled:** `scheduledJudgeCoding` (5 min) · `scheduledWarmup` (5 min, off) ·
`scheduledCloseExpiredAttempts` (60 min) · `scheduledPurge` (daily 03:00).

---

## 6 · Single points of failure

| | | Status |
|---|---|---|
| **S-1** | `index.ts` — one 13,959-line module holds all 57 exports. A helper regression touches every capability at once, and `DEPLOY.md §5` forbids cherry-picking *because* they share mutated helpers | **open** — F-1 |
| **S-2** | Single region `us-central1`. A regional outage stops every exam in flight | **open** — R-15 |
| **S-3** | `ExamShell.tsx` is the whole candidate experience. Its error boundary offers only *reload* — correctly, since the alternative is a way out of a supervised sitting | partly mitigated by `examMachine` |
| **S-4** | Judge0: one VM, `docker compose`, no HA. Degrades *safely* to manual review but **silently** | mitigated — sweep now logs `BACKLOG` |
| **S-5** | `/api/seb-verify` is the only place a SEB header can be read. Vercel outage ⇒ SEB exams cannot start | inherent to the design |
| **S-6** | ~~SEB secret in two deploy systems~~ | **fixed** — comma-separated list, rotation without a window |
| **S-7** | ~~Hardcoded Firebase config~~ | **fixed** — `VITE_*` with current project as fallback |
| **S-8** | ~~Build fetched face-api weights from a third-party branch~~ | **fixed** — vendored + checksummed |
| **S-9** | ⚠️ **Cloud Scheduler** drives four functions. Disabled ⇒ coding papers never mark, expired attempts never close, purges never run, warm-up never fires — all silently | operational |
| **S-10** | One shared VPC connector serves both judge functions | inherent |
| **S-11** | Firebase Auth is the single IdP for all four roles; no break-glass path | inherent |

---

## 7 · Capacity & availability

Stated target: **10,000 concurrent students.**

| Assumption | Reading |
|---|---|
| `maxInstances: 200`, `concurrency: 80` on 10 hot-path functions ⇒ ~16,000 in flight | Sound. In-flight = arrival × duration; 10k starts over 10s at ~300ms ≈ 300 in flight. The 200 is a **project CPU quota limit**, not a choice |
| `minInstances: 0` — cold-start cliff at exam open | `scheduledWarmup` automates the fix; ⚠️ off by default |
| Heartbeat every 15s per student | ~667 rps sustained at 10k. Inside the ceiling; watch as a Firestore cost line |
| Answer saves debounced 1.5s, one attempt doc per student | Under the ~1 write/s/doc soft limit under normal answering |
| SEB proof TTL 90s, refreshed by the 15s heartbeat | 6× margin |
| **Judge sweep: 4 concurrent papers, 240s budget, every 5 min** | Budget is deliberately **below the 300s interval** — Cloud Scheduler does not wait for the previous run, and two overlapping sweeps would judge one paper twice, spending two of its five attempts |
| A paper exhausts at 5 judge attempts | **No in-product re-arm.** `regradeAttempts` re-reads existing verdicts; it does not re-judge |
| Deploy skew | A full functions deploy lands over minutes; the paced script widens it to ~10. Not to be run during a live sitting |

---

## 8 · Do not regress this

An audit that only lists faults invites someone to "fix" something deliberate.

1. **`examTimingCore` as the single deadline implementation**, with `checkTimingInvariants` logging
   when a callable and the resolver disagree. The right answer to the failure class this codebase
   kept hitting — two expressions of one rule drifting apart.
2. **The attempt-update whitelist.** See §2. This is what makes the exam trustworthy at all.
3. **`get` vs `list` splitting on `assessments`.** Rule statements are additive; granting students
   single-document reads without reopening `list` is a precise use of that.
4. **Server-derived exam shape.** `startExam` accepting and ignoring client-supplied sections is
   correct, not dead code.
5. **Whitelist sanitisers, not blacklists** — including reducing `blockedStudents` and
   `attemptOverrides` to the caller's own entry.
6. **Judge0 never decides correctness.** Delegating comparison to the sandbox would silently
   downgrade every numeric question to exact string matching.
7. **The staged-control pattern.** Ship inert, prove, then enable. Used by `examTimingCore`,
   `examMachine`, App Check and the warm-up.
8. **`twinSync.test.ts`.** The client, the functions and the rules are three builds that cannot
   typecheck each other. It is the only thing connecting them.
9. **The comment discipline.** Nearly every non-obvious decision records the failure it prevents.

---

## 9 · Open work

### Code

| | | Size |
|---|---|---|
| **F-1 / R-12** | Split `index.ts` by family. 269 module-level declarations, **69 referenced by 3+ blocks**, so a `shared.ts` extraction comes first, then families one PR at a time | **L** |
| **R-15** | Second region for the exam hot path, or explicitly accept single-region risk in the availability contract | **L** |

### Waiting on operational evidence

- **Exam machine stage 2b** — flip shadow → enforcing, and add the guard `handleTerminate` lacks
  (it sets `'terminated'` with no check on current state, so a violation arriving after a
  successful hand-in would move a *submitted* paper). Needs one clean exam cycle.
- **CSP promotion** — needs a quiet soak, then tighten `script-src` (it still carries
  `'unsafe-inline'`) before promoting.

### Operational, no code

1. **Flip `APP_CHECK_ENFORCED=true`** — highest-value item; console evidence already supports it.
2. Grant `roles/run.developer`, then `WARMUP_ENABLED=true` — see `DEPLOY.md §9a`. Costs money.
3. Verify `vendor/face-api/face-api-weights.sha256` against upstream — recorded with nothing to
   check against.
4. ⚠️ Confirm Cloud Scheduler is enabled (S-9).
5. Optional: set the `VITE_FIREBASE_*` vars in a preview environment to get staging.

### Known and accepted

- **Storage has no tenancy.** Paths are `question-images/{timestamp}-{random}`, so staff at one
  institute can list another's images. Closing it needs the prefix to carry the tenant and a
  migration of existing objects. Staff-only is the containment available without moving every file.
- **`canWriteAcademic` still ignores `schoolsManagementEnabled` for create and rename.** Only the
  lifecycle axis is fenced — it was the one with the audit trail attached. Closing the rest needs a
  callable per hierarchy write.
- **Web Owner password copy differs** (`'New password is too weak.'` vs the other three's
  `'Password is too weak.'`). Product copy, not a refactor.
- **Cross-tenant denials on hierarchy collections raise a rules *evaluation error*** rather than a
  clean `false`. Pre-existing, reproduced against unmodified rules, fails closed — noise that masks
  real errors in the emulator log.

---

## Appendix A · Audit history

The original audit (2026-08-15) raised nine findings and fifteen recommendations. All P1s are
closed. What follows is the record — particularly the parts where the audit was wrong, which are
kept because the *way* they were wrong is instructive.

### Where the audit was wrong

**F-4 — "an exported callable with zero callers; delete or wire it."**
Deleting would have been exactly backwards. `setHierarchyNodeLifecycle` was not unused — the
capability was being exercised through a *worse* door: a direct Firestore write that skipped the
audit row, left the lifecycle envelope unset, ignored `schoolsManagementEnabled`, and had no
reverse gear. The audited path existed; the product used the unaudited one.
*Lesson: "no callers" is a fact about references, not about whether a capability is in use.*

**F-6 — "`functions/lib/` is tracked in git."**
It is not, and has not been. The claim came from `DEPLOY.md §7`'s own self-correction, trusted
without checking. The concern was real for exactly one file — `functions/timing-core.cjs`, build
output that a hand-run sweep could pass against while stale.
*Lesson: a prose claim about a repository is not evidence about it. Ask git.*

**F-7 — "refactor the two question pages onto `QuestionBankCore`."**
Assessed and declined. They look ~65% identical but differ on *features*, not drift. The valuable
work was elsewhere: 11 copies of `formatDate` in 6 spellings, none guarding unparseable input.
*Lesson: a duplication metric can point at the wrong file.*

**R-9 — "add `functions` to the workspace, extract `shared/`. Effort: M."**
Too cheap. `firebase.json` sets `"source": "functions"` and the CLI packages that directory, so a
`file:../shared` dependency fails at install in Cloud Build. The twins are not an oversight — the
deployment model pushes toward them. Re-scoped to **L**.

**R-1 — "raise the judge sweep's per-run limit."**
The limit was never the bottleneck. The cluster runs 4 workers — its own compose file calls that
"the real concurrency ceiling of the whole platform" — and the sweep awaited one paper at a time.
*Lesson: measure the pipe before widening the tap.*

### Findings and outcomes

| | Finding | Outcome |
|---|---|---|
| F-1 | `index.ts` is one 13,959-line module | **open** — the last structural item |
| F-2 | Client/server twins, guarded only by comments | Guard extended to 4 unpinned twins incl. the functions↔rules one; restructure re-scoped to L |
| F-3 | App Check initialised but not enforced | All 53 callables wired behind one flag ⚠️ off |
| F-4 | *(see above)* | Callable widened to the UI's two-tier grant, client rewired, rules fenced, `R-10` added |
| F-5 | CSP mostly report-only, nowhere to report | `/api/csp-report` added; both policies report |
| F-6 | *(see above)* | `timing-core.cjs` untracked; root `.gitignore` gained `.env` |
| F-7 | Role-surface duplication | Formatters folded (13 copies → 1 module, `en-GB`); page merge **declined** |
| F-8 | Four parallel auth contexts | Admission decision → `accessGate`; password ops → `roleAuth`; `login` stays per-role |
| F-9 | `ExamShell` state unmanaged | `examMachine` extracted, proven, wired in shadow mode |

### Things found while fixing other things

- **SEB proof verification had zero test coverage.** Every suite set `requireSEB: false`, so the
  control that makes a locked-down exam locked down was exercised by nothing. Now `R-17`.
- **The exam machine table was incomplete**, and a call-site reading could not have caught it: one
  site re-enters `loading` from an effect whose deps include `session`, so an auth refresh resets
  from anywhere. Modelled as a *reset*, outside the transition relation, so the absorbing-terminal
  guarantee survives.
- **Shadow mode logged its evidence to the candidate's browser console** — unread, and unreachable
  inside SEB. Now rides the heartbeat.
- **The reset-request error mapping diverged**: Institute and Faculty swallowed
  `auth/invalid-email`, Student did not. Resolved toward the narrower reading.
- **The warm-up's first budget (420s) exceeded its 300s schedule**, which would have overlapped
  runs and judged papers twice. Caught before merge.

### Recommendations

**Done:** R-1 (judge throughput, re-diagnosed) · R-2 (F-4, wired not deleted) · R-3 (CSP sink) ·
R-4 (env config) · R-5 (vendored weights) · R-6 (App Check, staged) · R-7 (build output,
retargeted) · R-8 (warm-up, staged) · R-10 (formatters; page merge declined) · R-11 (auth,
stages 1–2) · R-13 (exam machine, stages 1–2a) · R-14 (rotation runbook, plus the constraint
removed).

**Open:** R-9 (shared package — L, deployment-constrained) · R-12 (split `index.ts` — L) ·
R-15 (second region — L).

---

*Derived from the repository. Deployed state marked ⚠️ should be verified against the live project
before it is treated as settled.*
