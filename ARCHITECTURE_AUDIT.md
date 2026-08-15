# Architecture & System Boundaries — Audit

**Scope:** frontend architecture, Firebase Functions, Firestore, Storage, Authentication,
external services, Admin SDK usage, client/server trust boundaries, shared utilities, state
management, data flow, dependency graph, single points of failure, critical-path components,
availability assumptions.

**Method:** static read of the repository at `claude/architecture-audit-boundaries-decg8j`
(base `e840a4f`). Everything below is grounded in a file and, where a number is claimed, in a
command that produced it. No runtime, no live project, no emulator — so this audit describes
the *system as committed*, and says so explicitly wherever the deployed state could differ
(App Check enforcement, Cloud Scheduler enablement, Judge0 cluster health, Vercel env vars).

---

## 0 · System at a glance

| | |
|---|---|
| Product | STRATUM / Exam Forge — multi-tenant online examination platform |
| Tenancy | Web Owner (platform) → Institute → Faculty → Student |
| Frontend | React 18 + Vite 6 SPA, React Router 7, deployed on **Vercel** |
| API | 53 `onCall` + 3 `onSchedule` Firebase Functions (Gen 2, Node 24), **all `us-central1`** |
| Data | Firestore (49 rule-governed collections), Firebase Storage (2 prefixes) |
| Identity | Firebase Auth, single tenant, role carried in **custom claims** |
| Edge | One Vercel serverless route: `/api/seb-verify` |
| Sandbox | Self-hosted Judge0 on a VM inside the project VPC, no external IP |

**Size.** ~80,800 LOC frontend (231 files, 24 test files) · 16,420 LOC functions
(5 files, one of them 13,465 lines) · 1,410 lines of Firestore rules · 64 lines of Storage rules.

---

## 1 · Architecture diagram

### 1.1 Runtime topology and trust zones

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ZONE 0 — UNTRUSTED · the candidate's machine                                 │
│                                                                              │
│   Browser / Safe Exam Browser                                                │
│   ┌────────────────────────────────────────────────────────────────────┐     │
│   │ React SPA (Vercel-served static bundle)                            │     │
│   │  Root ─ PlatformSettingsProvider ─ AuthProvider                     │     │
│   │    ├── /dashboard   DashboardLayout        (Web Owner)              │     │
│   │    ├── /institute   InstituteRoot  → InstituteAuthProvider          │     │
│   │    ├── /faculty     FacultyRoot    → FacultyAuthProvider            │     │
│   │    └── /student     StudentRoot    → StudentAuthProvider            │     │
│   │            ├── exam/:id/briefing   ErrorBoundary variant="exam"     │     │
│   │            └── exam/:id/shell      ErrorBoundary variant="exam"     │     │
│   │                    └── ExamShell (4,279 LOC) ◄── CRITICAL PATH      │     │
│   │                          IntegrityEngine · FaceMonitor ·            │     │
│   │                          ExtensionWatchdog · QuestionRenderer       │     │
│   │  src/lib/*  — 37 service modules, the only Firebase callers         │     │
│   └────────────────────────────────────────────────────────────────────┘     │
└───┬───────────────┬──────────────────┬───────────────────┬───────────────────┘
    │               │                  │                   │
    │ HTTPS         │ callable         │ Firestore/Storage │ POST + SEB header
    │ static        │ (ID token +      │ SDK (ID token)    │ + ID token
    │               │  App Check tok)  │                   │
    ▼               ▼                  ▼                   ▼
┌─────────┐   ┌──────────────────┐  ┌──────────────┐  ┌────────────────────────┐
│ ZONE 1  │   │ ZONE 2 — TRUSTED │  │ ZONE 3       │  │ ZONE 1 — SEMI-TRUSTED  │
│ Vercel  │   │ Cloud Functions  │  │ Firestore +  │  │ Vercel serverless      │
│ CDN     │   │ us-central1      │  │ Storage      │  │ /api/seb-verify        │
│         │   │                  │  │              │  │                        │
│ SPA     │   │ 53 onCall        │  │ RULES ARE    │  │ · reads SEB hash hdr   │
│ assets  │   │  3 onSchedule    │  │ THE ONLY     │  │ · verifies Firebase ID │
│ /models │   │                  │  │ GUARD on     │  │   token (RS256, no SDK)│
│ weights │   │ ADMIN SDK        │  │ this path    │  │ · reads config keys via│
│         │   │ ── bypasses ──►  │  │              │  │   Firestore REST + SA  │
│         │   │ all rules        │  │ 49 collections│ │ · mints HMAC proof     │
└─────────┘   └────┬─────────────┘  └──────────────┘  │   {uid, aid, exp 90s}  │
                   │                                   └───────────┬────────────┘
                   │ VPC connector                                 │
                   │ exam-forge-connector                          │ shares
                   │ PRIVATE_RANGES_ONLY                           │ SEB_SIGNING_SECRET
                   ▼                                               │
        ┌──────────────────────────┐                               │
        │ ZONE 4 — PRIVATE         │                               │
        │ Judge0 VM 10.128.0.2:2358│                               │
        │ no external IP, 1 host   │◄──────────────────────────────┘
        │ docker compose, no HA    │        (secret must match exactly,
        └──────────────────────────┘         across two deploy systems)

  EXTERNAL, build/runtime:
    fonts.googleapis.com   (build-injected <link>, runtime fetch)
    google reCAPTCHA v3    (App Check attestation)
    raw.githubusercontent.com (npm postinstall — face-api weights) ◄── BUILD SPOF
    cdn.sheetjs.com        (vendored to repo; no longer fetched at install)
```

### 1.2 Exam critical path — data flow

```
STUDENT                     CLIENT                    SERVER                     STORE
   │
   │ open briefing
   ├───────────────► ExamBriefingPage
   │                    ├─ getAssessment ─────────────────────────────────► assessments (get)
   │                    ├─ getSEBPublicInfo ────────────────────────────► publicSettings
   │                    └─ scanForExtensions (client-only, advisory)
   │
   │ if requireSEB:
   │                 POST /api/seb-verify ──► Vercel edge
   │                                            ├─ SHA256(url+configKey) vs header
   │                                            ├─ verify ID token (RS256)
   │                                            └─ mint v1.<b64>.<hmac>  ── 90 s TTL
   │
   ├───────────────► startExam(assessmentId, sebToken, sessionId, fingerprint)
   │                                          ├─ assertSEB (uid+aid bound)
   │                                          ├─ assertNotBlocked
   │                                          ├─ membership: allocationMode
   │                                          │    'rules' → assessmentMembers/{aid_sid}
   │                                          │    else    → assignedTo
   │                                          ├─ freeze examSnapshot ────► attempts (create)
   │                                          └─ compute deadlines (examTimingCore)
   │
   ├───────────────► getExamQuestions ────────► sanitizeQuestionForStudent
   │                                            (field whitelist; answer keys never sent)
   │
   │ answering:
   │   debounce 1.5 s ──► updateDoc(attempts/{id}) ─────────► RULES: answers+updatedAt only
   │   sequential mode ─► submitAnswerAndAdvance / saveAnswerNoAdvance (callable)
   │   heartbeat 15 s ──► examHeartbeat ─────────► gaps, fingerprint drift, SEB re-proof
   │   violations ──────► logViolation ──────────► server-incremented, append-only
   │   code "Run" ──────► runCodeSample ─────────► Judge0 (VPC)
   │
   ├───────────────► submitSection ──► startSection ──► … ──► gradeAttempt
   │                                          ├─ scoreAttemptAnswers
   │                                          ├─ coding? set codeJudgePending ─┐
   │                                          └─ write scores ────────────────┼─► attempts
   │                                                                          │
   │                 scheduledJudgeCoding (every 5 min, LIMIT 50) ◄───────────┘
   │                    └─ Judge0 ──► attemptVerdicts ──► settle paper
   │
   └───────────────► ExamResultsPage ──► getExamVerdict / getAnswerKeysForReview
```

### 1.3 Frontend module dependency graph (`src/lib`)

```
                         firebase.ts  (app · db · auth · storage · functions · AppCheck)
                              ▲
        ┌─────────────────────┼──────────────────────┬────────────────┬──────────────┐
        │                     │                      │                │              │
  firebaseService      subjectService        assessmentService   deletionRights  sessionSecurity
   (CRUD + hierarchy)   (subjects/topics)          ▲             (ceilings)
        ▲                     ▲                    │
        │                     └───────┐            │
        │                             │            │
   allocationService          questionBankService ─┘
   questionRights                ▲   ▲   ▲
   resultsExport ────────────────┘   │   └──── itemTypes ──┐
        │                            │                     │
        │                     questionShareService         │
        │                     questionAnswerSplit          │
        │                     codeAuthoring ──► codeSnippets
        │                                                  │
        └──────────► submissionService ◄───────────────────┘
                        ▲   ▲   ▲   ▲
                        │   │   │   └── deviceFingerprint
                        │   │   └────── codeTelemetry ──► codeReplay
                        │   └────────── codeVerdictView
                        └────────────── heartbeatQuiet, manualGradingService

  NO CYCLES.  Two hubs: firebase.ts (leaf; 19 importers in src/lib, 33 across src/) and
  questionBankService / submissionService (fan-in from the exam + authoring surfaces).
```

---

## 2 · Component responsibilities

### 2.1 Frontend

| Component | Responsibility | Notes |
|---|---|---|
| `src/app/App.tsx` | Outermost `ErrorBoundary` → `Suspense` → `RouterProvider` | Boundary deliberately **above** Suspense so a 404'd lazy chunk after redeploy shows a reload prompt, not a white screen |
| `src/app/routes.tsx` | Whole route tree; every page lazy, every layout/root eager | Eager shell is deliberate — lazy roots would create a request waterfall |
| `Root.tsx` | `PlatformSettingsProvider` → `AuthProvider` (Web Owner) | Branding sits above all four role trees |
| `InstituteRoot` / `FacultyRoot` / `StudentRoot` | Mount the per-role auth provider for their subtree | Three near-identical 14-line files |
| `context/AuthContext` (378) | Web Owner session **+ TOTP MFA** (enroll/confirm/disable/resolve) | Only role with MFA |
| `context/InstituteAuthContext` (369) | Institute session, `instituteCode` check, validity window | |
| `context/FacultyAuthContext` (355) | Faculty session | **~45% identical to Institute's after role-name normalisation** (196 differing lines) |
| `context/StudentAuthContext` (395) | Student session, program tag arrays, lifecycle + `activeUntil` gate | |
| `context/PlatformSettingsContext` (85) | Platform branding/name | Extracted out of AuthContext (M4) |
| `layouts/*DashboardLayout` | Chrome + nav per role | Four files |
| `pages/student/ExamShell.tsx` | **The sitting.** Section nav, answer state, debounced saves, timers, integrity, overlays, submit | **4,279 LOC · 44 `useState` · 29 `useRef` · 32 `useEffect`** |
| `components/exam/IntegrityEngine` | Keyboard/focus/clipboard restrictions | |
| `components/exam/FaceMonitor` | Webcam PiP + TinyFaceDetector; dynamic-imports face-api (~600 KB) | Weights self-hosted at `/models` |
| `components/exam/ExtensionWatchdog` + `extensionScan` + `extensionIdProbe` | Browser-extension detection (advisory) | |
| `components/*Core` | Shared bodies: `QuestionBankCore`, `ReportsInboxCore`, `AssessmentRosterCore`, `AllocationPanelCore` | Adoption is **uneven** — see §6.2 |

### 2.2 Service layer (`src/lib`, 37 modules)

| Module | LOC | Responsibility |
|---|---|---|
| `assessmentService` | 2,067 | Assessment CRUD, SEB token acquisition, `getStudentAssessments`, `resolveAllocation`, `sebDiagnostics` |
| `questionBankService` | 2,042 | Question/group CRUD via `*AsRole` callables, `getExamQuestions`, `getAnswerKeysForReview` |
| `submissionService` | 2,037 | **Whole exam runtime API**: start/section/answer/heartbeat/violation/freeze/verdict/grade + the only two `onSnapshot` listeners |
| `firebaseService` | 1,519 | Generic Firestore helpers + all identity CRUD + the 9-level academic hierarchy + every permission-flag setter |
| `itemTypes` | 1,088 | Question-type registry shared by authoring and rendering |
| `subjectService` | 793 | Subjects/topics, cascade rename/merge |
| `firebase.ts` | 57 | **The single Firebase entry point.** App, Firestore, Storage, Auth, Functions, App Check |
| `deletionRights` / `lifecycle` / `deletionAudit` / `bulkDelete` / `erasureService` | ~1,300 | Deletion ceilings, soft-delete lifecycle, audit trail, GDPR erasure |
| `codeAuthoring` / `codeVerdictView` / `codeTelemetry` / `codeReplay` / `codeSnippets` | ~1,400 | Coding-item authoring, verdict presentation, keystroke telemetry |
| `twinSync.test.ts` | 290 | **Guards client↔server list drift by reading server source as text** |

### 2.3 Cloud Functions (`functions/src`)

| Module | LOC | Responsibility |
|---|---|---|
| `index.ts` | **13,465** | All 56 exports + ~90 helpers. Auth, deletion/lifecycle, grading, exam runtime, SEB verification, question rights, allocation, judging |
| `examTimingCore.ts` | 1,228 | **The single implementation of every deadline.** Deliberately extracted so the write gate and the resolver cannot disagree |
| `judgeCore.ts` | 948 | Provider-agnostic judge state machine, language list, comparison modes |
| `judge0Adapter.ts` | 523 | Judge0-specific: pinned language ids, base64 both ways, never delegates comparison |
| `allocationCore.ts` | 256 | Hierarchy-rule → student-set resolution |

**Function families (56 exports):**

| Family | Count | Examples |
|---|---|---|
| Exam runtime (`EXAM_HOT_PATH`) | 10 | `startExam`, `getExamQuestions`, `submitAnswerAndAdvance`, `saveAnswerNoAdvance`, `examHeartbeat`, `registerSession`, `logViolation`, `startSection`, `submitSection`, `getExamVerdict` |
| Grading | 6 | `gradeAttempt`, `gradeProvisional`, `regradeAttempts`, `setManualMark`, `getAnswerKeysForReview`, `rejudgeAttemptCoding` |
| Identity & lifecycle | 9 | `createAuthUser`, `deleteAuthUser`, `restoreEntity`, `purgeEntity`, `setHierarchyNodeLifecycle`, `executeErasure`, … |
| Deletion governance | 5 | `submitDeletionRequest`, `resolveDeletionRequest`, `getDeletionImpact`, `getInstitutePurgePreview`, … |
| Question rights | 10 | `createQuestionAsRole`, `editQuestionAsRole`, `deleteQuestionAsRole`, `shareQuestionsAsRole`, `submitQuestionRequest`, … |
| Allocation | 3 | `resolveAllocation`, `addManualMember`, `getAllocationPreviewPage` |
| Coding/judge | 3 | `runCodeSample`, `recordCodeTelemetry`, `scheduledJudgeCoding` |
| Invigilation | 4 | `freezeAttempt`, `unfreezeAttempt`, `softDeleteAttempt`, `reportExtensionCheck` |
| Scheduled | 3 | `scheduledCloseExpiredAttempts` (60 min), `scheduledPurge` (daily 03:00), `scheduledJudgeCoding` (5 min) |

---

## 3 · Trust boundaries

There are **five** crossings. Each is listed with what it actually validates.

### TB-1 · Browser → Firestore/Storage (direct SDK)

The client holds a Firebase ID token and talks to Firestore directly. **Security rules are the
only guard** — there is no proxy. Authorization rests entirely on custom claims:

```
{ role: 'webOwner' }
{ role: 'institute', instituteId }
{ role: 'faculty',   instituteId, facultyId }
{ role: 'student',   instituteId, studentId }
```

Claims are minted **only** by `createAuthUser` (Admin SDK). A client cannot self-assign a role.

What the rules enforce, per the collections that matter:

| Collection | Student | Faculty / Institute | Notes |
|---|---|---|---|
| `questions` | **read denied** | read: own-tenant + webOwner content | Students get content *only* via `getExamQuestions`. **Writes narrowed to `isWebOwner()`** so institute/faculty must go through the `*AsRole` callables where the rights ceiling actually lives |
| `assessments` | `get` only, never `list`, only if assigned | own + assigned-published | List-vs-get split is deliberate |
| `attempts` | own only; **update whitelisted to `answers` + `updatedAt`** | own institute | `sectionTimings`, `currentSectionIdx`, `integrityLog`, `activeSessionId` are **server-only** — the clock, the violation log and the session claim cannot be forged from the console |
| `platformSettings` (SEB config keys) | denied | denied | webOwner only; functions read via Admin SDK |
| `publicSettings` | read if signed in | read | Non-secret half of the SEB info, split out precisely so the keys stay unreadable |
| `provisionalGrades` | denied | own institute | `allow write: if false` — server-written only |

**Verified strength:** the answer-write whitelist is the load-bearing control of the whole exam.
`hasOnly()` on top-level keys catches dot-path writes (`answers.q_xyz` counts as `answers`), and
`answerWriteWindowOpen()` bounds it against the server-materialised lock.

### TB-2 · Browser → Cloud Functions (callable)

Every callable re-derives identity from `request.auth.token` and **never trusts payload identity**.
The pattern is consistent across the 53 handlers:

```ts
if (!request.auth) throw new HttpsError('unauthenticated', …);
const role = request.auth.token.role as string | undefined;
const studentId = request.auth.token.studentId as string | undefined;
if (role !== 'student' || !studentId) throw new HttpsError('permission-denied', …);
```

Client-supplied data is treated as **advisory and explicitly documented as such** —
`cameraDeclined`, `deviceClass`, and the device `fingerprint` all carry comments stating they
are honest-majority signals, not evidence. `sanitiseFingerprint` clips to four known fields at
120 chars each before anything reaches a document.

`startExam` still *accepts* `sections`, `shuffleQuestions`, `sectionStartOrder` for cached-client
compatibility but **reads none of them** — exam shape is derived server-side from the assessment
(D-07). That is the correct posture and worth preserving.

**Gap:** no callable declares `enforceAppCheck`. App Check is initialised client-side
(`src/lib/firebase.ts:33`) and the token rides along, but with `enforceAppCheck` unset the v2
default is permissive — a request **without** an App Check token is still served. See F-3.

### TB-3 · Browser (in SEB) → Vercel edge → Cloud Functions

The most interesting boundary in the system, and correctly reasoned.

SEB injects `X-SafeExamBrowser-ConfigKeyHash` **only on same-origin requests**, so the header is
unreadable from `cloudfunctions.net`. The design moves verification to the app's own origin and
bridges with a signed token:

1. `/api/seb-verify` recomputes `SHA256(absoluteURL + configKey)` and compares constant-time
   against the header.
2. It verifies the caller's Firebase ID token itself (RS256 against Google's certs, no
   `firebase-admin` — the bundle stays dependency-free).
3. It mints `v1.<b64url(JSON)>.<hex HMAC>` bound to **both** `uid` and `aid` (assessment), TTL 90 s.
4. `assertSEB` in the functions verifies the HMAC and both bindings.

Both bindings are load-bearing and both are present: `uid` stops one student in SEB minting
proofs for classmates in Chrome; `aid` stops a platform-config session being replayed against an
exam demanding its own key.

**Fails closed correctly:** missing `SEB_SIGNING_SECRET` → `SEB_NOT_CONFIGURED`, never
"SEB satisfied". **Fails open by design in one place:** if Firestore is unreachable,
`resolveConfigKeys` falls back to the `SEB_CONFIG_KEYS` env list rather than bricking a scheduled
exam. That trade is documented and defensible, but it means the env fallback must be kept current
or a Firestore outage silently changes which keys are accepted.

### TB-4 · Cloud Functions → Firestore (Admin SDK)

**Admin SDK bypasses all rules.** This is the intended privileged path and is what makes the
whitelist model in TB-1 work: everything a student must not forge is written here instead.
`initializeApp()` at `functions/src/index.ts:191` with default credentials.

The correctness of the entire model therefore rests on each of the 56 handlers doing its own
authorization. Spot-checked across families (`gradeAttempt`, `getExamQuestions`, `startSection`,
`createQuestionAsRole`, `resolveAllocation`) — all gate on claims before touching data. Dedicated
guards exist and are used consistently: `assertSEB`, `assertSession`, `assertNotBlocked`,
`assertInvigilator`, `assertQuestionRight`, `assertInstituteActiveS`, `requireWebOwner`.

### TB-5 · Cloud Functions → Judge0 (VPC)

Private-range egress only, through `exam-forge-connector`. The cluster has no external IP. Both
judge-touching functions (`runCodeSample`, `scheduledJudgeCoding`) carry `JUDGE_ACCESS`; either one
missing it fails as `judge_unavailable` against a healthy cluster. Candidate output is redacted
before return (`redactForCandidate`).

### Boundary summary

| # | Crossing | Guard | Fails |
|---|---|---|---|
| TB-1 | Browser → Firestore/Storage | Security rules + custom claims | closed (default deny) |
| TB-2 | Browser → callable | `request.auth.token` re-derivation | closed |
| TB-3 | SEB → Vercel → functions | Config-key hash + HMAC proof (uid+aid) | closed on secret; **open to env keys** on Firestore outage |
| TB-4 | Functions → Firestore | **none** (Admin SDK) — per-handler authz is the guard | n/a |
| TB-5 | Functions → Judge0 | VPC private range + auth token | **safe-degrades silently** to manual review |

---

## 4 · Single points of failure

Ranked by blast radius.

| # | SPOF | Blast radius | Evidence |
|---|---|---|---|
| **S-1** | **`functions/src/index.ts` — one 13,465-line module holding all 56 exports** | A bad deploy or a helper regression touches every capability at once. `DEPLOY.md §5` forbids cherry-picking *because* the exports share mutated helpers, so the mitigation for one risk (drift) is the amplifier for the other (blast radius) | `wc -l functions/src/index.ts` |
| **S-2** | **Single region `us-central1` for all 56 functions** | A regional outage stops every exam in flight, everywhere | 47 explicit `region:` literals, 0 others |
| **S-3** | **`ExamShell.tsx` — 4,279 LOC, 44 `useState`, 29 `useRef`, 32 `useEffect`** | Every sitting runs through this one component. Its own error boundary can only offer *reload* (correctly — the alternative is walking out of an exam unrecorded) | `routes.tsx:191-198` |
| **S-4** | **Judge0: one VM, `docker compose up`, no HA, no external IP** | Coding items stop marking. Degrades *safely* (`NullJudgeAdapter` → manual review) but **silently** — one log line is the entire signal | `DEPLOY.md §2` |
| **S-5** | **`/api/seb-verify` is the only place a SEB header can be read** | Vercel outage or an env drift = every SEB-required exam fails closed and cannot start | `api/seb-verify.js` header comment |
| **S-6** | **`SEB_SIGNING_SECRET` lives in two deploy systems** (Vercel env + Firebase secret) | A rotation applied to one and not the other rejects every SEB proof platform-wide | `api/seb-verify.js:44`, `index.ts:62` |
| **S-7** | **Hardcoded Firebase config — zero env vars in the frontend** | One project only. No staging/prod separation; pointing at another project requires a code edit and redeploy | `grep -rn "import.meta.env" src/` → 0 hits |
| **S-8** | **`postinstall` curls face-api weights from `raw.githubusercontent.com`** | `npm i` fails ⇒ Vercel build fails. `public/models/` is gitignored so the fetch is mandatory, and the URL points at a third-party repo's `master` | `package.json` scripts; `.gitignore` |
| **S-9** | **Cloud Scheduler** drives `scheduledJudgeCoding` (5 min), `scheduledCloseExpiredAttempts` (60 min), `scheduledPurge` (daily) | Scheduler disabled ⇒ coding papers never mark, expired attempts never close, purges never run — all silently | `index.ts:1443, 1870, 13425` |
| **S-10** | **`exam-forge-connector`** — one shared VPC connector | Both judge functions depend on it; connector loss = `judge_unavailable` | `JUDGE_ACCESS`, `index.ts:145` |
| **S-11** | **Firebase Auth as the single IdP for all four roles** | Auth outage = nobody signs in. No offline or break-glass path exists | four auth contexts |

---

## 5 · Availability & capacity assumptions

Stated target in code comments: **10,000 concurrent students**.

| Assumption | Where | Assessment |
|---|---|---|
| `maxInstances: 200`, `concurrency: 80` on the 10 hot-path functions ⇒ ~16,000 in-flight | `EXAM_HOT_PATH`, `index.ts:110` | **Sound.** In-flight = arrival × duration; 10k starts over 10 s at ~300 ms ≈ 300 in flight. The headroom is for the cold-start pathological case. The 200 ceiling is a **project CPU quota limit**, not a choice — raising it needs a quota request |
| `minInstances: 0` — cold-start cliff at exam open | same | **Accepted risk with a manual mitigation.** The comment prescribes setting 2–3 on `startExam`/`getExamQuestions` before a large sitting and back to 0 after. **That procedure is documented but not automated** — it depends on a human remembering |
| Heartbeat every 15 s per student | `ExamShell.tsx:1951` | At 10k students ≈ **667 rps sustained** on `examHeartbeat` alone, each doing a document read + conditional write. Well inside the instance ceiling; worth watching as a Firestore cost/throughput line |
| Answer saves debounced 1.5 s, direct to Firestore | `submissionService.ts:909` | One attempt doc per student ⇒ per-document write rate stays under Firestore's ~1 write/s/doc soft limit under normal answering. Rapid-fire answering on one attempt is the contention case |
| Window expiry polled every 30 s; UI clock every 500 ms | `ExamShell.tsx:1933, 929` | Client-side only; deadlines are server-authoritative via `examTimingCore` |
| SEB token TTL 90 s, refreshed by the 15 s heartbeat | `api/seb-verify.js:54` | Comfortable margin (6×) |
| SEB config-key cache 2 minutes | `api/seb-verify.js:55` | A key added on the settings page is live within 2 min, no redeploy |
| **`scheduledJudgeCoding` processes `.limit(50)` per 5-minute run** | `index.ts:13444` | **⚠ This is the capacity gap.** Ceiling is **600 papers/hour**. A 10,000-student cohort with coding items needs **~17 hours** to drain. The sweep is correctly designed to drain across runs rather than outlast its timeout — but the rate was not sized against the stated 10k target |
| A paper exhausts at `MAX_JUDGE_ATTEMPTS` (5) with **no in-product re-arm** | `DEPLOY.md §2` | `regradeAttempts` re-reads existing verdicts; it does not re-judge. An exhausted paper needs manual intervention |
| Deploy skew: a full functions deploy lands over several minutes; `deploy-functions.sh` batching widens it to ~10 min | `DEPLOY.md §5` | Explicitly "do not run during a live sitting" |

---

## 6 · Findings

### 6.1 Structural

**F-1 · `functions/src/index.ts` is a 13,465-line module (S-1).**
Five modules were already extracted — `examTimingCore`, `judgeCore`, `judge0Adapter`,
`allocationCore` — and each extraction was clearly worth it (the timing core exists precisely
because "every timing defect in this module has been two expressions of the same rule
disagreeing"). The same argument applies to the families that remain co-resident: grading,
deletion governance, question rights, and the exam runtime share nothing but the file. Splitting
them does **not** conflict with `DEPLOY.md §5` — that rule is about deploying all *exports*
together, which stays true regardless of how many source files they live in.

**F-2 · Client and server share no code; only text-matching guards the twins.**
`pnpm-workspace.yaml` lists `packages: ['.']` — `functions/` is outside the workspace, so a shared
package is not currently possible. At least six lists are duplicated with "keep in EXACT sync"
comments: `ANSWER_KEYS`/`ANSWER_KEYS_S`, `JUDGE_LANGUAGES` (×3 copies),
`MAX_JUDGE_ATTEMPTS`, the student question whitelist, `breakAfterCompletion`, grading defaults.

`twinSync.test.ts` is a genuinely good mitigation and its header documents a **real** production
failure this class of drift already caused (coding answer keys written to the public question
document while every grading path read an empty suite). But it guards by *regex over source text*
— it covers the lists someone thought to add, and a rename breaks the test rather than the twin.
Adding `functions` to the workspace and extracting a `shared/` package would make the class
impossible rather than detectable.

**F-3 · App Check is initialised but not enforced on callables.**
`initializeAppCheck` runs in `src/lib/firebase.ts:33` with a reCAPTCHA v3 provider, so clients
attach tokens. No callable sets `enforceAppCheck: true` (0 occurrences in `functions/src`), and the
firebase-functions v2 default is permissive — a request with **no** App Check token is still
served. Firestore/Storage enforcement is a console setting this repo cannot show. Net: the
attestation is being paid for (reCAPTCHA round-trip on every client) without the callable-side
benefit. Enforcing needs a staged rollout — turn on monitoring in the console first, confirm token
coverage, then flip `enforceAppCheck` on the hot path.

> **Partly addressed (2026-08-15).** The ten `EXAM_HOT_PATH` callables now carry
> `enforceAppCheck: APP_CHECK_ENFORCED`, read from `process.env.APP_CHECK_ENFORCED` and
> **defaulting to false** — so behaviour is unchanged until someone opts in. The point is to make
> the flip a config change (`functions/.env.<project>` + redeploy, reversible the same way) rather
> than a code change that has to clear review while a cohort waits. A cold-start log line states
> the resolved value, so "is enforcement on?" is answerable from `functions:log` instead of
> inferred. Steps 1–2 of the rollout — register the provider for every domain, then watch the
> verified/unverified split reach ~100% over a full exam cycle — are console work this repository
> cannot do or verify. The staff-driven callables are deliberately not covered: they are a
> different client population and deserve their own soak.

**F-4 · `setHierarchyNodeLifecycle` is an exported callable with zero callers.**
`grep` across `src/` and `api/` finds no reference outside its own definition and one comment.
It is deployed, reachable by any authenticated client, and exercised by nothing. Either wire it or
remove it — an unused privileged endpoint is attack surface that no test covers.

**F-5 · Content-Security-Policy is enforcing only four directives.**
`vercel.json` enforces `frame-ancestors`, `object-src`, `base-uri`, `form-action`. The meaningful
half — `script-src`, `connect-src`, `default-src`, `img-src` — is in
`Content-Security-Policy-Report-Only`, and that policy has **no `report-uri`/`report-to`**, so
violations go to the browser console and nowhere a human will see them. The report-only policy is
already written; it needs a reporting endpoint, then a promotion. Note `script-src` there includes
`'unsafe-inline'`, which should be tightened before promotion or the enforced policy will be
weaker than it looks.

> **Partly addressed (2026-08-15).** Added `/api/csp-report`, and wired `report-uri` +
> `report-to` (with a `Reporting-Endpoints` header) into **both** policies — the enforcing one
> too, so a real block is recorded as `disposition=enforce` rather than only showing up as a
> user-visible breakage. Violations now land in the Vercel function log as one greppable
> `[csp] …` line each.
>
> The sink accepts both wire formats, because browsers disagree: legacy
> `application/csp-report` (a single `{"csp-report":{…}}`) and the Reporting API's
> `application/reports+json` (a *batch* of envelopes). It is unauthenticated by necessity —
> browsers send reports without credentials — so it is bounded on every axis an anonymous caller
> controls: 64 KB body, 20 reports per request, 300 chars per field, and newlines stripped from
> every echoed value so an attacker-chosen `blocked-uri` cannot forge a second log line.
> Verified against all six of those behaviours before commit.
>
> **This does not promote the policy**, and deliberately so. Promotion is only responsible after
> the sink has been quiet across a real exam cycle — that soak is the whole reason the endpoint
> exists. Two entries look like promotion casualties already and should be checked against the
> logs rather than assumed dead: `connect-src` still allows `raw.githubusercontent.com` (a
> *build*-time host, not a runtime one) and `cdn.jsdelivr.net` (no reference found in `src/`).

**F-6 · Tracked generated output — ~~`functions/lib/`~~ `functions/timing-core.cjs`.**

> **Correction (2026-08-15).** The original text of this finding said `functions/lib/` is tracked,
> citing `DEPLOY.md §7`'s self-correction. **That was wrong, and wrong in the same way §7 itself
> was**: I trusted a prose claim about the repository instead of asking git. `functions/.gitignore`
> has contained `lib/` (alongside `.env*` and `sa-key.json`) for some time — `git ls-files
> functions/lib` returns nothing and `git check-ignore` matches. §7's "this describes a state the
> repo is not in" note is now itself describing a state the repo is not in. The lesson is §0's, one
> level down: a point-in-time claim about a file rots, so verify against the tool that knows.

The underlying concern was real, but it applied to exactly one file: **`functions/timing-core.cjs`**
— 950 lines of output from `npm run build:core`, committed.

The exposure was narrow, which is why this is a P2-shaped fix rather than the integrity hole the
original text implied. `test:timing` runs `build:core` before `timing.sweep.cjs`, so the npm path
always regenerates and never consumed a stale copy. The gap was the *direct* invocation:
`timing.sweep.cjs:19` does a bare `require('./timing-core.cjs')`, so running the sweep by hand
tested whatever was last committed rather than what is in `examTimingCore.ts` — silently, and with
a full green pass.

**Fixed:** untracked and added to `functions/.gitignore` (with `.tmp-core/`). A hand-run sweep now
fails with a module-not-found instead of quietly proving the wrong build — the loud-failure posture
the rest of this codebase already takes. Root `.gitignore` also gained `.env` / `.env.local` /
`.DS_Store`, which it lacked; `functions/.gitignore` already covered its own.

### 6.2 Frontend architecture

**F-7 · Role-surface duplication is real and unevenly addressed.**
The `*Core` extraction is the right pattern and is fully applied to reports
(`ReportsInboxCore` — all three roles) and rosters (`AssessmentRosterCore` — all three). It is
**not** applied to questions: `QuestionsPage` (Web Owner) is 236 lines and delegates to
`QuestionBankCore`, while `InstituteQuestionsPage` (816) and `FacultyQuestionsPage` (873) only
*mention* the Core in a comment and hand-roll the whole surface. Those two files are **~65%
identical** after normalising role names (279 differing lines of ~816/873).

The same shape repeats in the auth contexts: Institute and Faculty differ by 196 of ~360 lines,
much of that role-name substitution. Four providers × ~370 lines is four places to fix any session
bug.

**F-8 · Four parallel auth contexts, one Firebase Auth instance.**
Each role gets its own provider, session shape, login, `changePassword`, `requestPasswordReset`
and `logout` — all backed by the same `auth` singleton and distinguished only by the `role` claim.
A single parameterised provider with a role-specific session builder would collapse ~1,500 lines
into a few hundred. The MFA path (Web Owner only) is the one genuine divergence.

**F-9 · `ExamShell.tsx` state is unmanaged at its scale (S-3).**
44 `useState` + 29 `useRef` + 32 `useEffect` in one component, coordinating server-authoritative
attempt state (via `subscribeToAttempt`), local answer drafts, timers, integrity counters, overlay
state and submit flow. There is no reducer, no state machine, no store. The exam has genuinely
discrete states — briefing → in_progress → frozen → section-break → submitted/terminated — and
`useReducer` over an explicit machine would make the illegal transitions unrepresentable rather
than merely unreached.

### 6.3 What is working well — do not regress it

Recorded because an audit that only lists faults invites someone to "fix" a deliberate design.

1. **`examTimingCore` as the single deadline implementation**, with `checkTimingInvariants` logging
   `INVARIANT VIOLATION` when a callable and the resolver disagree. This is the correct answer to
   the failure class the codebase kept hitting.
2. **The attempt-update whitelist.** Moving `sectionTimings`, `integrityLog` and `activeSessionId`
   out of client reach — with the reasoning recorded inline — is what makes the exam trustworthy.
   `integrityLog` in particular: `increment()` in the client was never protection, because a plain
   `updateDoc` could zero the counters.
3. **`get`-vs-`list` splitting on `assessments`.** Rule statements are additive; granting students
   single-document reads without reopening `list` is a precise use of that.
4. **Server-derived exam shape.** `startExam` accepting but ignoring client-supplied `sections`
   is exactly right for cached-client compatibility.
5. **`redactForCandidate` / `sanitizeQuestionForStudent` / `sanitizeAssessmentForStudent`** — field
   whitelists rather than blacklists, including `blockedStudents` and `attemptOverrides` reduced to
   the caller's own entry.
6. **Judge0 never does the comparison.** Delegating correctness to the sandbox would silently
   downgrade numeric questions to exact string matching.
7. **The comment discipline throughout.** Nearly every non-obvious decision carries the failure it
   prevents. This is unusual and it is why this audit could be this specific.

---

## 7 · Recommendations

Ordered by (risk reduced) ÷ (effort).

| # | Action | Addresses | Effort |
|---|---|---|---|
| R-1 | Raise `scheduledJudgeCoding`'s per-run limit and/or shorten the interval; size it against the real cohort. Add an alert on `codeJudgePending` backlog age | §5 capacity gap | S |
| R-2 | Delete or wire `setHierarchyNodeLifecycle` | F-4 | S |
| R-3 | ~~Add a `report-uri` to the report-only CSP~~ **DONE** — `/api/csp-report` sink added and both policies now report. Promotion to enforcing still pending a soak (tighten `script-src` first) | F-5 | S |
| R-4 | Move the frontend Firebase config to `import.meta.env` so staging is possible without a code edit | S-7 | S |
| R-5 | Vendor the face-api weights into the repo (as `xlsx` already is) instead of curling GitHub at postinstall | S-8 | S |
| R-6 | ~~Set `enforceAppCheck`~~ **PARTLY DONE** — the ten hot-path callables now read an `APP_CHECK_ENFORCED` flag (default off). Remaining: console monitoring, then flip the env var | F-3 | M |
| R-7 | ~~Gitignore `functions/lib/`~~ **DONE, retargeted** — `lib/` was already ignored; the real tracked artefact was `functions/timing-core.cjs`, now untracked and ignored | F-6 | S |
| R-8 | Automate the pre-exam `minInstances` warm-up (a scheduled bump keyed off the assessment window) rather than relying on a documented manual step | §5 cold start | M |
| R-9 | Add `functions` to `pnpm-workspace.yaml`, extract `shared/` for the twinned lists and types; keep `twinSync.test.ts` for what cannot move | F-2 | M |
| R-10 | Refactor `InstituteQuestionsPage` / `FacultyQuestionsPage` onto `QuestionBankCore`, matching how reports and rosters already work | F-7 | M |
| R-11 | Collapse the four auth contexts into one parameterised provider with a role-specific session builder | F-8 | M |
| R-12 | Split `functions/src/index.ts` by family (exam runtime / grading / identity+lifecycle / question rights / allocation), keeping a thin `index.ts` that re-exports all 56 | F-1, S-1 | L |
| R-13 | Model `ExamShell`'s attempt state as an explicit reducer/state machine | F-9, S-3 | L |
| R-14 | Document a SEB secret-rotation runbook that updates Vercel and Firebase together | S-6 | S |
| R-15 | Evaluate a second region for the exam hot path, or accept and document single-region risk explicitly in the availability contract | S-2 | L |

---

*Audit performed against the repository as committed. Deployed-state facts that a static read
cannot establish — App Check console enforcement, Cloud Scheduler enablement, Judge0 cluster
health, Vercel environment variables, Firestore quota headroom — are flagged as such above and
should be verified against the live project before any of them is treated as settled.*
