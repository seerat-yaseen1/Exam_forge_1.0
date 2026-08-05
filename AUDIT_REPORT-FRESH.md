# 🔍 STRATUM / Exam Forge — Fresh Full-Codebase Audit

> **Date:** 2026-08-04
> **Scope:** whole repository — `src/` (React SPA), `functions/` (Cloud Functions), `firestore.rules`, `storage.rules.tsx`, `api/` (Vercel SEB endpoint), build config, and repo hygiene. Every role flow traced end to end: **web owner, institute, faculty, student, and the assessment engine**.
> **Method:** code-derived. Backend verified by compiling the functions and running all six test suites; frontend verified by a production Vite build **and** a full `tsc --noEmit` type-check (which the project's `vite build` never performs). Findings traced to `file:line`.
> **Actions taken this pass:** one broken test gate and three repo-hygiene regressions were **fixed** (all introduced by the most recent *"Update files from Figma Make"* commits). The frontend type findings are **documented, not mass-edited** — see each entry for why.

---

## 📊 Executive summary

| Severity | Count | Theme |
|:--------:|:-----:|-------|
| 🔴 **HIGH** | 1 | Grading regression-test gate was broken — **fixed** |
| 🟡 **MEDIUM** | 2 | Repo-hygiene regressions from the Figma round-trip — **fixed**; frontend never type-checked |
| 🟢 **LOW** | 4 | Latent type traps & dead UI (non-crashing), cosmetic, stray files |

**Bottom line.** The security-critical core is genuinely strong and stayed strong: server-authoritative timing, frozen exam contracts, question secrecy, tenant isolation, the deletion-rights ceiling, SEB verification, and role/routing separation are all really implemented and are backed by **13,446 timing states / 84,062 assertions + 64 freeze + 85 e2e + 93 probe + 52 round-3 + 40 grading checks, all green**. Prior audit findings (H1 section-lock re-materialization, the A/B/S/N/F/D series) remain fixed in the source.

What this pass found is that the **Figma Make round-trip is silently eroding the scaffolding around that core** — it broke the grading test suite, deleted the `.gitignore`, and re-committed stale compiled output. None of these touch runtime security, but the grading break means `npm test` was red, so the regression gate protecting the exam-scoring engine was **not actually running**. Those are fixed here. Separately, the frontend has **never been type-checked** (Vite transpiles without checking), and `tsc` surfaces 68 errors — 33 are dead boilerplate, the rest are latent traps and one entirely dead profile panel.

---

## 🔴 HIGH

### H1 · The grading regression-test gate was broken by the Figma sync — *fixed*

**Where:** `functions/package.json` (`test`, `test:grading`) → `functions/test/audit.grading.cjs`

The most recent *"Update files from Figma Make"* commit (`a8fcd29`) **moved** `functions/test/audit.grading.cjs` to `functions/audit.grading.cjs` (a git rename visible in the diff) but changed neither the npm scripts nor the file's own `require`. Two things broke at once:

1. `npm test` and `npm run test:grading` invoke `node test/audit.grading.cjs`, which no longer existed → `MODULE_NOT_FOUND` for the test file itself.
2. Even run from its new location the file fails, because it does `require('./fakeFirestore.cjs')` and `fakeFirestore.cjs` lives in `test/`.

Measured: `npm test` ran the first five suites green and then died:

```
Error: Cannot find module '/home/user/Exam_forge_1.0/functions/test/audit.grading.cjs'
```

**Why it matters.** `audit.grading.cjs` is the 40-check suite that guards the exam-scoring engine — negative marking, partial credit, the honest `passed = null` verdict on half-marked papers (G-02), vanished-question handling (G-04), frozen-paper marks, and "every finalisation path reaches the same mark" (G-10). With `npm test` red at that step, a green run was unobtainable, so **the scoring regression gate was effectively off**. A grading change could regress without any suite catching it.

**Fix applied:** restored the file to `functions/test/audit.grading.cjs` (`git mv`). `npm test` is green again across **all six** suites (exit 0), including `G-01 … G-10`.

**Root cause is a process, not a line of code.** The Make file is the source of truth and does not carry `test/audit.grading.cjs` in that path, so a future sync can re-break this. The durable fix is to keep the test tree stable across Make exports (or exclude `functions/test/` from the round-trip).

---

## 🟡 MEDIUM

### M1 · `.gitignore` deleted and compiled output re-tracked — *fixed*

**Where:** repository root `.gitignore` (deleted in `f5f5ca4`), `functions/lib/index.js(.map)`

The Figma sync **deleted the entire `.gitignore`** and re-committed a stale `functions/lib/index.js` (708 lines) as a tracked file. Consequences observed:

- `functions/lib/` was tracked again — the exact ~8,000-line build-output churn the **prior audit's M2** fix removed by adding that ignore. A local `npm run build` immediately dirtied the tree.
- With no `.gitignore`, `node_modules/`, `dist/`, and `package-lock.json` became accidental-commit candidates.

**Fix applied:** restored the canonical `.gitignore` from the last good commit (`24f1b6c`), untracked `functions/lib/` (`git rm --cached`), and added `dist/` (Vite output, Vercel-built). `firebase.json`'s `predeploy` runs `npm run build`, so nothing depends on `lib/` being committed. Same root-cause note as H1: a future Make export can re-delete it.

### M2 · The frontend is never type-checked — 68 `tsc` errors sit latent

**Where:** build pipeline (`package.json` `build` = `vite build`), `tsconfig.json`

`vite build` **transpiles without type-checking**, and there is no `tsc --noEmit` in the build or in CI. Running it by hand surfaces **68 errors**. They break down as:

- **33 — dead shadcn boilerplate** (`src/app/components/ui/{accordion,carousel,chart,command,drawer,sonner,input-otp,…}.tsx`) referencing npm packages that aren't dependencies (`recharts`, `cmdk`, `vaul`, `embla-carousel-react`, …). Verified **none are imported anywhere** in the app, so Vite tree-shakes them out — harmless, but pure noise that hides real errors.
- **35 — real type mismatches** in app code, detailed as LOW findings below. None crash at runtime (that's why the app builds and runs), but each is a place where the types actively lie about the data, which is how the *next* edit introduces a real bug.

**Recommendation:** add `"typecheck": "tsc --noEmit"` and run it in CI; delete the unused `ui/` components (or install their deps) so the signal isn't buried. This is the single highest-leverage durable improvement — it's what would have caught every LOW below, and it's what will catch the next Make round-trip's damage.

---

## 🟢 LOW (non-crashing; documented, not fixed)

### L1 · `StudentProfilePage` "Program Details" panel is dead code — can never render

**Where:** `src/app/pages/student/StudentProfilePage.tsx:180-225` (18 of the 35 real `tsc` errors)

The panel is gated on `session.group?.length || session.section?.length || session.program?.length || …`, but **none of those fields exist on `StudentSession`** (`StudentAuthContext.tsx:17-28` carries only ids, name, email, status, institute fields). Every term is `undefined`, the guard is always falsy, and the panel **never shows**. The academic data does reach the page — via `<AcademicStructure studentId={…}/>` just below, which queries live mappings — so this is redundant dead UI, not missing information. Fix is either to hydrate those fields onto the session or delete the panel.

### L2 · `InstituteLogo` type lies about its shape (declares `logoUrl`, runtime uses `dataUrl`)

**Where:** `src/lib/firebaseService.ts:99-102`; read at `InstituteAuthContext.tsx:155`, `StudentAuthContext.tsx:162`, `FacultyAuthContext.tsx:169`; written at `InstituteAuthContext.tsx:303` (4 errors)

The stored document is `{ dataUrl, updatedAt }` (and `firestore.rules:192` validates `dataUrl`). The read and write sites both use `.dataUrl`, so logos **work** — but the `InstituteLogo` type says `{ instituteId, logoUrl }`, so the compiler can't protect either side. A one-line type correction removes the trap and clears four `tsc` errors.

### L3 · Institute logo silently never renders on the change-password screens

**Where:** `src/app/pages/student/StudentChangePasswordPage.tsx:96-98`, `src/app/pages/faculty/FacultyChangePasswordPage.tsx:96-98` (4 errors)

Both read `session.logoUrl`, a field that doesn't exist on `StudentSession` / `FacultySession`. It's always `undefined`, so the code safely falls back to `<LogoMark/>` — the institute's uploaded logo just never appears on those two screens (it's available as `instituteLogo` on the context, not on `session`). Cosmetic; no crash.

### L4 · Smaller type traps (each latent, none currently reachable as a bug)

- **`ViolationOverlay` label/icon maps omit `extension_detected`** (`src/app/components/exam/ViolationOverlay.tsx:38,52`). Safe today only because `extension_detected` is not a `WARNING_VIOLATION_TYPE`, so `handleViolation` returns before this overlay is ever asked to render it (`ExamShell.tsx:2963-2978`). Add it to both maps before that assumption changes.
- **`readOnly` on a `<select>`** (`src/app/components/assignments/builder/DetailsStep.tsx:1397`) is not a valid DOM attribute and is ignored; the control is effectively locked only because it's a controlled `value` with no `onChange` (which also logs a React dev warning). Use `disabled` instead.
- **Duplicate local `Student` type** in `AddStudentDrawer.tsx` uses `role: 'student'` while `firebaseService.Student` uses `role: 'Student'`, forcing casts in `StudentTab.tsx:102,157` and `AddStudentDrawer.tsx:207`. Import the one canonical type.
- **Filter-value widening** in `AssessmentRosterCore.tsx:2742` and a `ParsedRow` cast in `QuestionTypeEngine.tsx:854` — harmless type widening.

### L5 · Stray root file

`new-file.tsx` — an empty 0-byte file at the repo root, nothing imports it. Safe to delete.

---

## ✅ Verified healthy (traced this pass, no action needed)

- **Auth & routing.** Four isolated auth contexts, each re-deriving the session from the Firebase custom claim (`role`, `instituteId`, `facultyId`/`studentId`) on every `onAuthStateChanged`; login rejects role mismatches server-verified; soft-deleted institutes/members and expired institutes are blocked at session build (`*AuthContext.tsx`). Dashboard layouts gate on `loading` before `!user` to avoid the refresh bounce. TOTP MFA for the web owner is correctly handled, including the "MFA is not a failed password" reauth subtlety (`AuthContext.tsx:222-255`).
- **Firestore rules.** Default-deny, role-scoped, tenant-fenced. Students get `get` (not `list`) on assessments and only for exams they're assigned to; the questions/answer-key collections are web-owner-write-only with staff reads tenant-fenced; attempts restrict student patches to `answers`+`updatedAt` inside a materialized time window (`answerWriteWindowOpen`), and staff to `updatedAt` only; audit trails (`deletionAudit`, `allocationAudit`, `allocation*`) are client-immutable. All consistent with the callable-only write model.
- **Cloud Functions (48 callables).** `createAuthUser`/`deleteAuthUser` enforce role+tenant+rights server-side (including the faculty `canCreateStudents` gate that used to be UI-only); `startExam` re-derives every security/timing value server-side, freezes the paper+timing+grading contract onto the attempt, and creates the attempt in a transaction so racing starts can't double-admit; `getExamQuestions`/`getStudentAssessments` require a live sitting and strip other students' ids; `submitSection` re-materializes the answer-write lock on advance (the prior H1 fix, present on both on-time and late branches); freeze/unfreeze run through the ledger with a per-clock credit/penalty cap and an authority ladder.
- **SEB verification** (`api/seb-verify.js`) verifies the config-key hash and the caller's Firebase ID token, binds the minted token to `uid`+`assessmentId`, uses constant-time compares, and fails closed on misconfig while falling back to env keys on a Firestore outage.
- **Grading honesty.** `passed` is three-state (`null` while `requiresManualReview`), a text answer *can* be marked by a human (G-01 green), out-of-paper answers are ignored, and every finalisation path reaches the same mark.

---

---

## 🔧 Follow-up pass — all LOW findings fixed (2026-08-04, second commit)

The `src/` findings were subsequently fixed. **Real-code `tsc` errors: 35 → 0.** The 33 dead `ui/` boilerplate errors remain (see M2 — they need a delete-or-install decision, not a code fix). `vite build` succeeds and all six backend suites stayed green.

Two of the fixes turned out to be **live user-facing bugs**, not merely type noise:

| Finding | What it actually was | Fix |
|---|---|---|
| **L1** | Student "Program Details" panel could never render — the six fields it reads were never on the session, so admin-entered tags (group, section, program, degree level, specialisation, school) were **invisible to every student**. The data *is* written, by `AddStudentDrawer` and `BulkStudentModal`. | Hydrated the six fields onto `StudentSession` from the student doc already fetched — zero extra reads. Panel now works as authored. |
| **L3** | The institute's uploaded logo **never appeared** on either change-password screen (student + faculty) — both read `session.logoUrl`, which does not exist; the generic mark rendered every time. | Read `instituteLogo` from the auth context instead. |
| **L2** | `InstituteLogo` type described `{ instituteId, logoUrl }`; the stored document is `{ dataUrl, updatedAt }`. Logos worked, but the compiler could check neither side. | Type corrected to match the document and `firestore.rules:192`. |
| **L4** | `ViolationOverlay`'s two `Record<ViolationType, …>` maps were missing `extension_detected` — total by declaration, partial in fact. Safe only because that type is not a warning type today. | Added to both maps. |
| **L4** | `readOnly` on a `<select>` is ignored by the DOM; the control was locked only by being controlled with no `onChange` (which also logs a React warning). | Changed to `disabled`. |
| **L4** | Duplicate `Student` interface in `AddStudentDrawer` forced casts on every hand-off to/from `firebaseService`. | Re-exported as an alias of the canonical type; casts removed. |
| **L4** | `status: 'ok'` in a synthetic `ParsedRow` is not a member of `RowStatus` (`valid\|warning\|error`); an `as ParsedRow` cast hid it. Inert — the modal never reads it. | Corrected to `'valid'`. |
| **L4** | Filter-tab array widened to `string` because a trailing `.filter()` broke contextual typing. | Annotation moved onto the array literal. |

### 🆕 Two findings surfaced *by* the fixes

**N1 · `StudentTab.handleToggleStatus` had an unhandled null.** `getStudent()` returns `Student | null` and the result was used directly (`data.status`). A student deleted or made unreadable between the list rendering and the toggle click threw a `TypeError`, which the surrounding `catch` swallowed into a console log — the row spinner simply stopped, with nothing shown to the admin. Now throws a stated error so the failure is visible. (`StudentTab.tsx:155`)

**N2 · The two student-creation paths disagree on stored `role` casing.** `AddStudentDrawer:171` writes `role: 'student'`; `BulkStudentModal:202` writes `role: 'Student'`. The `students` collection therefore holds a genuine mix, depending on how each student was added.

**Inert, and deliberately left alone.** Nothing authorises on this field — every role check reads the Firebase custom claim (the four auth contexts, `firestore.rules`), and the only `.role ===` comparisons in `src/` are `TrashPanel` testing lifecycle records for `'institute'`. The type is now the honest union `'Student' | 'student'` so the split is visible to the compiler. **Normalising it needs a backfill of existing documents, not a type edit** — aligning one writer alone would leave old data split while making the split invisible, which is worse than stating it. Flagged for a product decision.

---

## What was changed

**First commit (`42b75f6`):**

| Change | Type | Finding |
|---|---|---|
| `git mv functions/audit.grading.cjs → functions/test/audit.grading.cjs` | fix | H1 |
| Restored `.gitignore`; untracked `functions/lib/`; ignored `dist/` | fix | M1 |
| This report | doc | — |

**Second commit:**

| Change | Type | Finding |
|---|---|---|
| `StudentAuthContext.tsx` — six program fields hydrated onto the session | fix | L1 |
| `firebaseService.ts` — `InstituteLogo` corrected; `Student.role` union | fix | L2, N2 |
| `Student`/`FacultyChangePasswordPage.tsx` — logo from context | fix | L3 |
| `ViolationOverlay.tsx`, `DetailsStep.tsx`, `AddStudentDrawer.tsx`, `QuestionTypeEngine.tsx`, `AssessmentRosterCore.tsx` | fix | L4 |
| `StudentTab.tsx` — null guard + narrowed status union | fix | N1, L4 |

**Still open, by decision:** the M2 type-check adoption. Adding `"typecheck": "tsc --noEmit"` is now worthwhile — real code is at zero errors, so the gate would be meaningful — but it stays red until the 33 unused `ui/` components are either deleted or have their dependencies installed. That is a product call, so it is flagged rather than made here.

<sub>Backend verified green: `npm test` → 13,446 timing states · 84,062 assertions · 64 freeze · 85 e2e · 93 probe · 52 round-3 · 40 grading. Frontend verified: `vite build` succeeds; `tsc --noEmit` reports the 68 errors catalogued above.</sub>
