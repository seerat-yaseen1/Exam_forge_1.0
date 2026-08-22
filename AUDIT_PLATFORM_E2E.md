# End-to-End Platform Audit

**Date:** 2026-08-22 · **Branch:** `claude/platform-mock-tests-extension-uaqjhp` · **Base:** `main` @ `8d8d0c3`

Scope: (1) debug / does it work, (2) component integration, (3) security audit.
Every claim below is backed by a command that was actually run, or a `file:line`
that can be re-checked. Where I could not prove something, I say so.

---

## Resolution status

The audit is kept below as written. This is what has since been done about it.

| # | Finding | Status |
|---|---|---|
| S-1 | seb-verify: work before authentication | **Fixed.** Auth moved above the Firestore read; cache bounded; id shape validated. 19 probes in `api/seb-verify.test.js`, two of which fail if the ordering is put back. |
| S-2 | App Check not enforced | **Open — yours to run.** No code change needed; it is the four console/deploy steps in `functions/src/index.ts`. Must land before self-signup traffic. |
| S-3 | Images public-by-URL | **Open — a design decision**, not a patch. See §4. |
| S-4 | Storage has no tenancy | **Open.** Needs a prefix change plus a migration of existing objects. |
| S-5 | react-router advisories | **Fixed.** 7.13.0 → 7.18.2. Typecheck, 1,010 tests and the build all clean on it. |
| S-6 | Transitive `uuid` advisory | **Won't fix, deliberately** — see below. |
| S-7 | No linter | **Fixed.** ESLint 9 flat config, wired into CI. It found a real crash on the way in — see below. |
| S-8 | ~1 hour revocation window | **Accepted**, as it already was. |

Two things found while fixing, which were not in the original audit:

- **A latent React crash in four pages.** `FacultyAssignmentsPage`,
  `FacultyQuestionsPage`, `InstituteAssignmentsPage` and
  `InstituteQuestionsPage` each gated on `session` and returned early *above*
  their hooks. `session` is null while the auth context resolves, so the first
  render called two hooks and the render after it arrived called six or more —
  React compares the counts and throws *"Rendered more hooks than during the
  previous render"*. It survived only because the redirect usually unmounts the
  page before the session lands, which is a race, not a design. All four now
  gate below every hook. **This is exactly the bug class §S-7 predicted:**
  correctly typed, invisible to 1,010 passing tests, and only reachable in a
  real browser over real time.
- **The frontend test suite never ran in CI.** The workflow ran `tsc --noEmit`
  and stopped, so the largest body of frontend verification in the repository
  was running on developer machines only. Now wired in, along with lint.

**Why S-6 is deliberately not fixed:** npm's proposed remedy is
`firebase-admin@10.3.0` — a **major downgrade** from the pinned `^14.2.0`, on
the SDK that runs every exam. The advisory itself is a missing buffer bounds
check in `uuid` v3/v5/v6 *when an explicit `buf` argument is passed*; Google's
libraries call `v4()` without one, so the vulnerable path is not reached.
Forcing two majors onto a transitive dependency via `overrides` to silence an
unreachable advisory is a worse trade than waiting for the upstream bump.

---

## 0 · Verdict

**Nothing is broken.** 2,195 assertions across both halves of the codebase pass,
typecheck is clean, both builds are clean, and every client→server seam I could
mechanically verify resolves. This is a genuinely well-engineered codebase — the
test discipline (a 13,446-state model of the exam timing machine, rules probes
run against the real emulator, concurrency suites that catch what the fake
Firestore cannot) is well above what I normally see at this stage.

So the honest answer to "debug the code" is: **there was no defect to fix.**

The findings below are therefore not bugs. They are one real security weakness
in an unauthenticated endpoint, one security control that is built but switched
off, and a set of accepted-risk items worth re-deciding **because the B2C
mock-test direction changes their blast radius.**

---

## 1 · Evidence — what was actually run

Node 22 was on the box; the repo hard-pins Node 24 and `scripts/require-node-24.mjs`
is right that results on the wrong major "say nothing about what actually ships".
Node 24.19.0 was installed before anything below was run.

| Check | Command | Result |
|---|---|---|
| Frontend typecheck | `npm run typecheck` | **clean** |
| Frontend tests | `npm test` | **991 passed / 48 files, 0 failed** |
| Frontend build | `npm run build` | **clean**, built in 11.2s |
| Functions build | `npm --prefix functions run build` | **clean** |
| Functions suites | `npm --prefix functions test` | **exit 0 — all suites** |

Functions suites individually (all exit 0):

| Suite | Result |
|---|---|
| timing sweep | 13,446 states, 84,062 property assertions, 27 regressions — zero defects |
| `exam.e2e` | 85 passed / 10 scenarios |
| `groups.suite` | 109 passed / 8 scenarios |
| `audit.probe` | 121 passed / 24 probes |
| `audit.round3/4/5` | 63 + 65 + 30 passed |
| `audit.grading` | 162 passed / 27 probes |
| `manual.grading` | 91 passed / 14 probes |
| `risk.suite` | 67 passed / 17 scenarios |
| `judge.suite` / `judge0.suite` | 146 + 78 passed |
| `rules.suite` (emulator) | 121 passed / 12 scenarios |
| `concurrency.suite` (emulator) | 25 passed / 5 scenarios |
| `bulkdelete.emulator` | 41 passed / 6 scenarios |

**Total: 1,204 functions assertions + 991 frontend tests = 2,195. Zero failures.**

The emulator suites ran for real (Java present), so the Firestore rules were
exercised against the actual rules file, not a mock.

---

## 2 · Integration verification

### 2.1 Client ↔ callable wiring — clean

Cross-checked every `httpsCallable(functions, '…')` in `src/` and `api/` against
every `export const … = onCall` in `functions/src/index.ts`:

- **56** callables exported.
- **46** distinct names called from 24 client files.
- **0 client calls with no matching export** — no broken wiring, no 404-at-runtime.
- **0 dead callables** — the 10 that my first regex missed are all reached through
  multi-line call sites (e.g. `lifecycleService.ts:67`, `submissionService.ts:1151`,
  `sessionSecurity.ts:47`).

### 2.2 Firestore index coverage — complete

Multiple equality filters do not need composite indexes; only equality+inequality,
`where`+`orderBy` on a different field, and `array-contains` combinations do. I
isolated exactly those and matched each to `firestore.indexes.json`:

| Query | Index | Status |
|---|---|---|
| `attempts` status`==` + answersLockedAfter`<` (`index.ts:1618`) | `status ASC, answersLockedAfter ASC` | covered |
| `deletionAudit` entityType+entityId+orderBy createdAt (`deletionAudit.ts:280`) | `entityType, entityId, createdAt DESC` | covered |
| `deletionAudit` instituteId+orderBy createdAt (`:295`) | `instituteId, createdAt DESC` | covered |
| `assessments` array-contains instituteIds + status + isDeleted (`assessmentService.ts:1763`) | `assignedTo.instituteIds CONTAINS, isDeleted, status` | covered |
| `assessments` assignedTo.type + status + isDeleted (`:1758`) | `assignedTo.type, isDeleted, status` | covered |
| `assessments` startDate`>=`+`<=` (`index.ts:14861`) | same-field range → auto index | covered by design |

The warm-up query at `index.ts:14855` deliberately filters `status` in memory
specifically to avoid needing a composite index that could fail at the moment it
is needed. That is the right call and it is documented.

### 2.3 CI — healthy (the comment in `ci.yml` is stale)

`.github/workflows/ci.yml` carries a long note saying the workflow "has produced
zero runs since it landed on main". **That is no longer true.** The GitHub API
reports **214 runs**, and every run on `main` and on PR branches through
2026-08-21 concluded `success`. The diagnostic comment should be trimmed so it
stops describing a resolved incident as a live one.

---

## 3 · Security audit

### 3.1 What is solid

- **All 56 callables are authorization-guarded.** Zero unguarded. The two that
  are auth-only are correct: `getServerTime` (returns a clock) and
  `revokeSessions`, which revokes only `request.auth.uid` — a user can only log
  *themselves* out everywhere (`index.ts:13291`).
- **Firestore rules**: 51 match blocks, 145 allow clauses, **zero blanket
  `if true`**, explicit default-deny, and leftover dev collections explicitly
  blocked. The rules are exercised by 121 emulator probes.
- **XSS surface is closed.** All three `dangerouslySetInnerHTML` sites in the
  codebase route through `renderKatex`, which sets **`trust: false`**
  (`RichText.tsx:128`) — that disables `\href`, `\htmlData` and friends, which is
  the actual KaTeX injection vector. The error fallback escapes with
  `escapeHtml` (`:132`). Code blocks never touch raw HTML by design.
- **CSP is real and enforced**, with no `unsafe-inline`/`unsafe-eval` in
  `script-src`, plus `object-src 'none'`, `frame-ancestors 'none'`,
  `base-uri 'self'`, `form-action 'self'`. And `cspPolicy.test.ts` checks the
  policy against the app's actual origins in CI — that is a class of bug most
  teams never close.
- **CSV formula injection is handled** (`resultsExport.ts:386`), and the claim
  that the `.xlsx` branch is safe without it is correct: typed string cells are
  not formulas.
- **No secrets in the repo.** The only key-shaped string is the Firebase web
  `apiKey` (`firebase.ts:50`), which is public by design and ships in the bundle
  regardless.
- **`api/csp-report.js`** is properly bounded: 64 KB body cap, 20 reports per
  request, 300-char field clipping, and CRLF stripping (log-injection safe).
- **Vendored `xlsx` is 0.20.3** — past the prototype-pollution (0.19.3) and
  ReDoS (0.20.2) fixes. Vendoring it is the correct response to SheetJS leaving npm.

### 3.2 Findings

| # | Severity | Finding | Location |
|---|---|---|---|
| **S-1** | **Medium** | Unauthenticated Firestore read amplification + unbounded cache growth in `seb-verify` | `api/seb-verify.js:243-320` |
| **S-2** | **Medium** (config) | App Check is implemented but not enforced | `functions/src/index.ts:150` |
| **S-3** | Low | Question images are public-by-URL, bypassing all rules | `storage.rules` (documented) |
| **S-4** | Low | Storage has no tenancy — staff can list another institute's images | `storage.rules` (documented) |
| **S-5** | Low | `react-router` 7.13.0 carries high-severity advisories — **not exploitable here** | `package.json` |
| **S-6** | Low | 7 moderate npm advisories in functions, single root cause, not reachable | transitive |
| **S-7** | Info | No linter configured | — |
| **S-8** | Info | ~1 hour token-revocation window on Firestore | documented, accepted |

---

## 4 · Findings in detail

### S-1 · `seb-verify` does expensive, attacker-steerable work before authenticating

**Medium.** This is the one genuine new weakness found.

`api/seb-verify.js` is unauthenticated at the network edge and runs its steps in
this order:

1. reject non-POST, check env config
2. require `assessmentId` in the body — **any non-empty string passes**
3. require the `x-safeexambrowser-configkeyhash` header — **any non-empty value passes**
4. **`resolveConfigKeys(...)` → Firestore REST read on `sebAssessmentKeys/{assessmentId}`** (`:286`)
5. compare the hash → 403 on mismatch
6. **only now** verify the caller's Firebase ID token (`:317`)

Step 3 is described in the code as the cheap gate because "Chrome never sends
it" — true of an ordinary browser, but an attacker sends it trivially with any
junk value. So an **unauthenticated** caller can reach step 4 at will, and step 4
is keyed on an **attacker-controlled** `assessmentId` with no format or length
validation. Two consequences:

- **Firestore read amplification.** Each distinct `assessmentId` is a cache miss
  and therefore one Firestore REST read, plus a service-account token round-trip
  on cold caches. Unauthenticated, and billable.
- **Unbounded memory growth.** `keysCache` (`:66`) is a module-level `Map` with
  no eviction and no size cap. On a warm Vercel instance, varying `assessmentId`
  grows it until the instance is recycled.

`encodeURIComponent` does prevent path traversal, so this is availability and
cost, not data exposure. No key material leaks — the 403 is returned regardless.

**Fix, and why it is safe:** move the ID-token verification (step 6) to before
`resolveConfigKeys` (step 4), and bound the cache. This is **behaviourally
invisible to legitimate clients**, because the client already refuses to call
the endpoint unauthenticated — `assessmentService.ts:2267` returns
`AUTH_REQUIRED` before the `fetch` is ever made. Only an attacker sees a
different code. Additionally validate `assessmentId` against the id format the
platform actually issues.

### S-2 · App Check is bought and not spent

**Medium, and it is a config decision, not a code gap.** The web app already
initialises App Check with reCAPTCHA v3, so every user already pays the
round-trip — but `APP_CHECK_ENFORCED` defaults to `false` (`index.ts:150`), so a
request arriving with no token (curl, a script, a replayed ID token from outside
the app) is served identically to one from the real app. The startup log says so
out loud on every cold start, which is the right instinct.

The staged rollout in the header comment (monitor → verify ~100% → flip the env
var → redeploy) is exactly right and should simply be executed. **This matters
much more for the B2C direction than it does today**: institute students are a
known, bounded population; self-signup students are not, and unattested
callables are the surface a scraper uses to enumerate a question bank.

Note also the stated scope: enforcement covers `EXAM_HOT_PATH` only. Staff
callables are deliberately not covered yet and need their own soak.

### S-3 · Question images are public-by-URL — relevant to your content-protection goal

`storage.rules` was correctly tightened to staff-only reads, and the comment
explains why students are unaffected: they never use the Storage SDK, because
`ImageUploader` stores the result of `getDownloadURL()` on the question.

The consequence deserves stating plainly, because it bears directly on the
mock-test plan: **a Firebase download URL carries its own access token and does
not consult Storage rules at all.** Any student who copies a question image URL
out of the DOM has a link that works for anyone, from any browser, indefinitely
— no login, no institute, no exam window. For a paid mock-test product where the
buyer is the leaker, that is a real leak channel, and it is one that canvas
rendering would not close either (the URL is in the network log regardless).

Closing it means serving images through an authorized path rather than a
tokenized public URL.

### S-4 · Storage has no tenancy

Objects live at `question-images/{timestamp}-{random}.{ext}` with no
`instituteId`, so faculty at institute A can list institute B's images. Already
documented in `storage.rules` and honestly labelled as not-fixed. Containment
today is staff-only. A real fix needs the tenant in the prefix plus a migration
of existing objects.

### S-5 · react-router advisories — real CVEs, not exploitable in this app

`npm audit` reports 12 advisories against `react-router` 7.13.0, several rated
high. I checked each against how this app actually uses the library rather than
reporting the number:

- The app uses `createBrowserRouter` (`routes.tsx:79`) in **library mode** — a
  pure SPA. There is no SSR, no RSC, no framework mode, no prerendering.
- That rules out the turbo-stream RCE, the RSC XSS pair, the prerender Location
  XSS, the `__manifest` DoS, the single-fetch DoS, the SSR `deserializeErrors`
  injection, and both CSRF advisories — every one requires a server-rendering
  mode this app does not run.
- The two that *could* apply in library mode are the open-redirect pair
  (backslash and `//` protocol-relative targets in `<Link>`/`useNavigate`).
  **Neither is reachable**: every `navigate()` target in the codebase is a
  literal or comes from an internal map — `LOGIN_PATH[role]`,
  `appearancePathFor(pathname)`, or a literal nav path. No route target is
  derived from `useSearchParams` or any other user-controlled input. The only
  `searchParams` reads are `oobCode` (`ResetPasswordActionPage.tsx:50`) and a
  results-tab filter.

**So: bump it as hygiene, not as an incident.** Worth doing before you add
self-signup, since that is exactly when a `?next=` redirect parameter tends to
get introduced — and that is the pattern these advisories bite.

### S-6 · Functions dependency advisories — one root cause, not reachable

7 moderate, and all 7 are the same advisory surfacing through the dependency
chain: `uuid` → `gaxios`/`teeny-request`/`retry-request` → `@google-cloud/storage`
→ `firebase-admin` → `firebase-functions`. The advisory is a missing buffer
bounds check in uuid **v3/v5/v6 when an explicit `buf` argument is passed**.
Google's libraries call `v4()` without `buf`, so the vulnerable path is not
reached. The fix is an upstream `firebase-admin` bump, or an `overrides` pin if
you want the audit clean sooner.

`face-api.js` → `@tensorflow/tfjs-core` (low) is the same shape: a transitive
advisory in a pinned vision dependency, used only for the proctoring face check.

### S-7 · No linter

There is no ESLint/Biome config and no lint script. `tsc --noEmit` catches type
errors but not `react-hooks/exhaustive-deps`, unused variables, floating
promises, or accidental `console.log` in production paths. For a codebase this
disciplined it is a conspicuous gap — and the class of bug it catches
(a stale closure in a `useEffect` on the exam hot path) is precisely the class
your test suite cannot reach, because it only bites in a real browser.

### S-8 · The revocation hour

Documented at `index.ts:13336` and accepted knowingly: disabling an account
revokes refresh tokens immediately, but Firestore rules do not check revocation,
so an already-minted ID token stays valid for up to an hour. The alternative
costs a document read on the exam hot path. I agree with the trade as stated —
noting it only so it stays a decision rather than a surprise.

---

## 5 · What I did not verify

Stating the limits so nothing here is over-read:

- **No runtime execution against a real Firebase project.** Findings are from
  static reading, the emulator suites, and the type/build system.
- **No browser-level testing.** No Playwright run, so rendering, hook behaviour,
  and the integrity engine's real-browser event handling are unverified here.
- **No penetration testing** of the deployed endpoints.
- **S-1 is reasoned from the code path, not demonstrated** against the live
  endpoint — I did not send traffic to production.

---

## 6 · Recommended order of work

Before any new feature work, including the games:

1. **S-1** — reorder auth in `seb-verify`, bound the cache, validate the id. Small, contained, safe.
2. **S-2** — run the App Check rollout to enforcement. It is written; it needs the console steps.
3. **S-7** — add ESLint with `react-hooks` and `@typescript-eslint`, wire it into the existing CI job.
4. **S-5 / S-6** — dependency bumps as routine hygiene.
5. **S-3** — decide the image-serving model. This one is a prerequisite for the
   mock-test product, not for the games.

None of these blocks starting the games work, except that **S-1 and S-2 should
land before any self-signup traffic exists.**

---

## 7 · Bearing on the gamified aptitude tests

The audit result that matters most for the games: **`engine` is the extension
point in this codebase, not block type** — the same conclusion
`PLATFORM_EXTENSION_PLAN.md` §0 reached, and the code confirms it. `engine`
drives the authoring UI, the exam renderer, `sanitizeQuestionForStudent`'s field
whitelist (`index.ts:5929`), the grading switch, the bulk-upload sheets, the
navigator's answered-detection, and the `AttemptAnswer` union. A game added as
anything other than an engine renders a blank card.

Two things I would want answered before the games land, both visible in this audit:

- **The student-facing field whitelist is an allow-list.** Any new field a game
  needs (`gameSpec`, seed, config) reaches the student only if it is added to
  `sanitizeQuestionForStudent` explicitly. That is the correct design and it
  means the games integration has a single, reviewable choke point.
- **Scoring.** `ItemScoring = 'auto' | 'manual' | 'hybrid'` already exists
  (`itemTypes.ts:121`), and the manual path is now complete. A game that
  produces a score needs to decide which of the three it is *before* the data
  model is written, because `requiresManualReview` forces an attempt away from a
  true verdict until it is cleared (`index.ts:4656`).

I have not seen the games repository, so nothing above is a judgement about the
games themselves — only about the seam they will attach to.
