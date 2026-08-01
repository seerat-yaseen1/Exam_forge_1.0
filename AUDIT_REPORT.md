# 🔍 STRATUM — Codebase Audit Report

> **Scope:** Whole-codebase, code-derived analysis across `src/`, `functions/`, `firestore.rules`, `api/`, and repo hygiene.
> **Method:** 6 phases, evidence traced to exact files and line numbers. Every claim verified against source — not documentation or memory.
> **Type:** Read-only audit. No files were modified.
> **Date:** 2026-08-01

---

## 📊 Executive Summary

| Severity | Count | Theme |
|:--------:|:-----:|-------|
| 🔴 **HIGH** | 2 | Real bugs — fix before deploy |
| 🟡 **MEDIUM** | 2 | Correctness robustness + documentation liabilities |
| 🟢 **LOW** | 5 | Hygiene / cosmetic (non-exploitable) |

**Bottom line:** The platform is largely well-stitched — server-authoritative timing, question secrecy, tenant isolation, and role/routing separation are all genuinely implemented and verified end-to-end. Two real bugs need attention before the time-enforcement deploy: a missing answer-lock re-materialization on section submit (**H1**), and a tenant privilege-escalation gap in the Firestore rules (**H2**).

---

## 🔴 HIGH Severity

### H1 · `answersLockedAfter` is not re-materialized on section submit

**Phase:** 1 — Server-authoritative time enforcement
**Impact:** Answer-write window for the next section is computed against a stale deadline.

`answersLockedAfter` is written in only **two** places:

| Location | File |
|---|---|
| `startExam` | `functions/src/index.ts:5193` |
| `startSection` | `functions/src/index.ts:5536` |

It is **never written in `submitSection`** (`functions/src/index.ts:5600–5793`). The Firestore rule that gates answer writes depends on it:

```txt
// firestore.rules:712 — answerWriteWindowOpen()
!diff.affectedKeys().hasAny(['answers'])
  || answersLockedAfter == null
  || request.time < answersLockedAfter
```

On **sequential advance**, `ExamShell.doSectionSubmit` (`src/app/pages/student/ExamShell.tsx:1928–1947`) does **not** call `startSection` for the next section — so `answersLockedAfter` still reflects the *previous* section's deadline.

**Precise scope (affected):**
- Standard-delivery exams
- Multiple sections
- Sequential advance
- **No break** between sections

**Immune:**
- ✅ Linear / adaptive delivery (server writes via `submitAnswerAndAdvance`, bypasses the rule)
- ✅ Single-section exams
- ✅ Flows that route through a break → `startSection`

**Fix direction:** Call `computeAttemptLocks` and write `answersLockedAfter` / `sectionLockedAfter` inside `submitSection` for the next section — or force a `startSection` call on every sequential advance.

---

### H2 · Institute can self-escalate its own permission ceilings

**Phase:** 3 — Service layer & Firestore rules
**Impact:** An authenticated institute admin can raise web-owner-controlled ceilings on its own document.

The institutes update rule has **no field whitelist**:

```txt
// firestore.rules:161
allow update: if isWebOwner() || isInstituteSelf(instituteId);
```

An institute admin can `updateDoc` its own `institutes/{id}` and flip web-owner-governed flags — `canAdminCreateFaculty`, `questionRightsCeiling`, `activeUntil`, etc. A client writer path already exists:

```txt
setInstituteQuestionRightsCeiling → src/lib/firebaseService.ts:1426
```

**Partial backstop (and the gap):**

| Path | Server re-clamp? | Result |
|---|:---:|---|
| Question rights (`assertQuestionRight`, `functions/src/index.ts:5814`) | ❌ No re-clamp (`:5836`) | Escalation is **enforceable by the tenant** |
| Deletion rights (`setInstituteDeletionRightsCeiling`, `firebaseService.ts:1442`) | ✅ Re-clamped | Protected |

**Fix direction:** Add a field whitelist to the institutes self-update rule that excludes all web-owner-governed flags — mirror the existing `students` / `faculty` field-whitelist pattern (`firestore.rules:672–678`).

---

## 🟡 MEDIUM Severity

### M1 · Documentation is materially false and will mislead future work

**Phase:** 4 / 5

`CLAUDE.md` — the primary AI navigation aid — contains claims contradicted by the source:

- ❌ **"No Firebase Auth — passwords compared in browser JS"** (§8). The code uses real `signInWithEmailAndPassword` + custom claims in **all four** auth contexts.
- ❌ Lists a **nonexistent** `emailService.ts`.
- ❌ **Omits ~15 real `src/lib` services** — the entire deletion / lifecycle / allocation subsystem:

  ```
  allocationService     deletionAudit          deletionImpact
  deletionRequestService  deletionRights       duplicateDetection
  erasureService        lifecycle              lifecycleService
  questionReportService questionRequestService questionRights
  resultsExport         sessionSecurity        subjectDataService
  subjectRequestService visibility
  ```

Any assistant trusting the map reasons about the wrong auth model and misses the largest part of the service layer.

**Fix direction:** Rewrite `CLAUDE.md` §3 (directory map) and §8 (conventions) to match reality.

---

### M2 · Stale committed build artifact

**Phase:** 5

`functions/lib/index.js` is a **stale compile** of `functions/src/index.ts`:

| File | Size | Note |
|---|---|---|
| `functions/src/index.ts` | 315 KB | Source of truth (41 exports) |
| `functions/lib/index.js` | 33 KB | Stale — missing whole functions |

`submitAnswerAndAdvance` appears **0×** in `lib`, 4× in `src`.

**Why it is not a runtime bug:** `firebase.json` sets `predeploy: npm run build` (`tsc`), so `lib/` is regenerated on every deploy.

**Why it still matters:** A deploy that bypasses predeploy ships a crippled backend, and the committed artifact is misleading.

**Fix direction:** Add `functions/lib/` to `.gitignore` and remove it from version control.

---

## 🟢 LOW Severity

| ID | Finding | Location | Note |
|:--:|---------|----------|------|
| **L1** | Loose web-owner role check — a **role-less** token passes as web-owner in the UI | `src/app/context/AuthContext.tsx:103,126` | Backstopped: rules require explicit `role()=='webOwner'`, so such a token sees no data. Tighten to a positive check. |
| **L2** | Dead scaffolding — zero references anywhere | `supabase/functions/server/*`, `utils/supabase/info.tsx`, `functions/unenroll-mfa.js` | Figma Make / one-off leftovers. Remove. |
| **L3** | Dead exports — `lifecycleOf`, `accessOf`, `isActive`, `isArchived`, `isSoftDeleted` unused | `src/lib/lifecycle.ts` | Its *types* are used, so keep the file; drop or adopt the helpers. |
| **L4** | Redundant guard — both `ProtectedRoute` and layout `!user` redirect | `src/app/components/ProtectedRoute.tsx` + `DashboardLayout.tsx` | Harmless overlap. |
| **L5** | `allocation.sweep.cjs` referenced only from a code comment | `functions/allocation.sweep.cjs` | Confirm it is scheduled out-of-repo, else dead. |

---

## ✅ Verified Working (end-to-end)

- **Server-authoritative timing** — `getServerTime` / `startExam` / `startSection` / `submitSection` materialize `sectionLockedAfter` / `overallLockedAfter`, enforced by rules; client skew-corrects via midpoint-RTT (`submissionService.ts:683`); grace periods persisted (`DetailsStep.tsx:492,499`) and applied. *Only* the section-submit re-lock (**H1**) is broken.
- **Question secrecy** — `sanitizeQuestionForStudent` (`functions/src/index.ts:3778`) whitelists fields, zeroing `correctIds` / `correctPairs` / `modelAnswer`; students denied direct `questions` reads by rules.
- **Tenant isolation is real, not a filter** — unconstrained tenant list queries are *rejected*, not silently narrowed; `getAll*` helpers succeed only for web-owner.
- **Role / routing isolation** — single `Root` → `AuthProvider` global ancestor; each tenant tree nests its own provider; 3 of 4 contexts strict-gate on `role`; every layout redirects on missing session; no cross-role context imports.
- **Auth model** — Firebase Auth + custom claims; email-keyed resets (enumeration fix); soft-delete / lifecycle + `activeUntil` expiry enforced in every context; `revokeOtherSessionsKeepCurrent` on password change.
- **Live subsystems fully stitched** — allocation (client ↔ `allocationCore` ↔ server), resume (`verifyAndResume`, three-layer), SEB `api/` endpoints (wired via `vercel.json` + 6 callers).

---

## 🛠️ Recommended Order of Action

1. **H1** — blocks the time-enforcement deploy (the exact feature under change).
2. **H2** — tenant privilege escalation; add the institutes field whitelist + re-clamp question-rights server-side.
3. **M1** — rewrite `CLAUDE.md` §3 / §8 (cheap, high-leverage for every future change).
4. **M2 + L2 / L3 / L5** — repo hygiene sweep.
5. **L1 / L4** — consistency polish.

---

<sub>Generated from a 6-phase, code-only audit of the STRATUM codebase. All findings traceable to the cited file:line references.</sub>
