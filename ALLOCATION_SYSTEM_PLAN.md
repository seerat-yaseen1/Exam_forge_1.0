# STRATUM — Student Allocation System: Design & Build Plan
## v2 — SIMPLIFIED MODEL (supersedes v1 in full)

> Status: DESIGN BASELINE — confirmed through design review, no code exists yet.
> Scope: **webOwner only.** Institute-admin / faculty mirrors deferred (§11).
> Prime directive: **purely additive — nothing that exists today changes behavior.**
> Companion document: `ALLOCATION_UI_PLAN.md` (screen-level UI specification).

---

## 0 · What changed from v1 (summary of the simplification)

| v1 | v2 (this document) |
|---|---|
| General rule list: include/exclude × node/students selectors | **One flat allocation object: a node TYPE + N node IDs of that type. Union only.** |
| Exclude rules, precedence semantics (Q4), conflict/containment analysis | **Deleted.** Pure union — no precedence question exists |
| CSV / explicit-students selector in the rule path | **Deleted.** Hand-picked lists remain available on the untouched legacy path |
| Mixed-level selection tray, subtree-collapse picker rules | **Deleted.** Picker = institute → node type → flat checkbox list |
| Missed students via enroll-and-admit combined action | **Replaced: roster → search enrolled student → manual add to exam** (decouples enrollment from admission; also covers external/retest students with zero academic-data side effects) |

**Unchanged from v1** (the architecture was never about rule richness):
membership storage (`assessmentMembers`, deterministic doc IDs, O(1) entry gate), server-side resolver with dry-run preview, versioned transactional materialization, append-only audit with deltas, student-dashboard discovery, high_stake publish gate, additive-only posture, phase structure, verification-first discipline.

---

## 1 · Decisions locked (full register)

| # | Decision |
|---|---|
| D1 | Allocation = `{ nodeType, nodeIds[] }` — one node type per assessment allocation, multi-select within that type, resolved as a **union**. No excludes, no mixed types, in v1 |
| D2 | nodeType may be ANY hierarchy level: institute, school, level, program, session, year, semester, course, section, group |
| D3 | Legacy path (`assignedTo`: all / institutes / students) untouched forever. An assessment uses legacy OR rules, opt-in, set once by the Cloud Function |
| D4 | The materialized membership list is the ONLY thing `startExam` checks (rule path). Rules are the recipe; the list is the meal |
| D5 | The list changes **only** through explicit, audited admin actions: **materialize/sync** (rules-sourced) or **manual add** (roster-sourced). Never as a side effect of hierarchy edits |
| D6 | Membership docs carry `source: 'rules' \| 'manual'`. **Sync recomputes rules-sourced members only and never touches manual members** |
| D7 | Additions allowed while the exam is live (all tiers, normal gates apply). List-shrinking sync results are rejected in v1; removals deferred (Q5). Manual-add removal likewise deferred |
| D8 | Missed / late / external students: enroll on the portal normally (pure hierarchy op), then roster → "Add student" → search → add. webOwner only |
| D9 | Drift indicator: allocation panel dry-runs against current mappings and shows "+N since last sync"; **Sync** re-materializes with delta preview. Sync refreshes membership of the CHOSEN nodes only — it never adds nodes |
| D10 | "All sections" ≠ "the course": select-all stores today's explicit nodeIds (new sections NOT auto-covered); targeting the parent course covers future sections on next sync. UI nudges when select-all is used at a level whose parent could be targeted instead |
| D11 | Per-exam SEB Config Key + `.seb` file mandatory for high_stake only (platform keys default elsewhere); folded into the publish-readiness gate (§7) |
| D12 | webOwner only in v1. Mirror seams built in (§11), mirror itself deferred |

---

## 2 · Data model — three new collections + one optional field

### 2a · `allocations/{assessmentId}` — the allocation definition (one per rule-path assessment)

```
assessmentId        string      // == doc id
ownerType           'webOwner'  // v1 constant; mirror seam
version             number      // increments per committed materialization; txn precondition
status              'draft' | 'confirmed'
nodeType            'institute'|'school'|'level'|'program'|'session'|'year'|'semester'|'course'|'section'|'group'
nodeIds             string[]    // cap 200
nodes: [{                       // denormalized at save — survives renames/archival
  nodeId, nodeName, breadcrumb, instituteId
}]
instituteId         string      // the single institute this allocation targets (v1: exactly one; mirror seam)
resolvedCount       number      // rules-sourced count summary
manualCount         number      // manual-member count summary
lastMaterializedAt  string      // ISO, server-set
lastMaterializedBy  string      // uid
createdAt / updatedAt           // ISO, server-set
```

Written **only by Cloud Functions**. Client: webOwner read; all client writes denied.

> v1 targets nodes within ONE institute per assessment (matches the settled picker flow:
> select institute → node type → nodes). Multi-institute exams remain fully served by the
> legacy `assignedTo.type='institutes'` path, or by nodeType='institute' with multiple
> institute nodes — which is the one sanctioned cross-institute form and keeps
> `instituteId` above as `'*'` in that case.

### 2b · `assessmentMembers/{assessmentId}_{studentId}` — the materialized list

```
assessmentId        string
studentId           string
instituteId         string      // denormalized from student profile
source              'rules' | 'manual'
active              true        // v1 always true; removal semantics later = field flip
admittedByVersion   number      // allocation version (rules) or version at time of add (manual)
addedBy             string      // uid — meaningful for manual; function identity for rules
createdAt           string      // ISO, server-set
```

**Membership-storage rationale (unchanged from v1, restated):** top-level collection with deterministic doc ID beats (a) an array on the assessment doc — 1 MB cliff on exactly the biggest exams, full-list rewrites, read weight — and (b) a subcollection — collection-group index + fiddlier rules for student discovery. Deterministic ID gives `startExam` an O(1) `doc().get()` with no query, delta writes are natural (3 added students = 3 docs), and rules stay flat.

New composite index: `assessmentMembers (studentId ASC, active ASC)`.
Roster reads use `where('assessmentId','==',x)` — single-field, auto-indexed.

### 2c · `allocationAudit/{autoId}` — append-only history

```
assessmentId    string
version         number
actorUid        string          // from request.auth — never client-supplied
actorRole       'webOwner'
action          'create' | 'materialize' | 'sync' | 'manual_add'
delta           { addedStudentIds: string[], removedStudentIds: string[] }  // removed always [] in v1
deltaCounts     { added: number, removed: number }
allocationSnapshot { nodeType, nodeIds, nodes }   // for materialize/sync; null for manual_add
manualStudent   { studentId, name } | null        // for manual_add
isLive          boolean         // assessment was active at the time
at              string          // ISO server timestamp
```

Function-written only. Client: webOwner read; **no create/update/delete for any client principal, including webOwner** — immutability is structural.
Size guard: deltas over ~5,000 IDs store counts + first 5,000 + `truncated: true`.

### 2d · The only touch to an existing document

```
assessments/{id}.allocationMode?: 'rules'   // undefined = legacy (all existing docs).
                                            // Set once by the Cloud Function on first
                                            // materialization. Client may never write it
                                            // (rules-enforced, same pattern as securityLockedAt).
```

No other existing field changes. No migration. Undefined behaves exactly as today.

---

## 3 · Cloud Functions (all new except one gate added inside `startExam`)

### 3a · `resolveAllocation` — preview and commit, one code path

```
Input:  { assessmentId, nodeType, nodeIds[], expectedVersion, dryRun }
dryRun → { valid, errors[], warnings[], resolvedCount, byNodeCounts[{nodeId,count}],
           delta: { added[], removed[] },     // vs current rules-sourced members
           sampleStudents[] }                 // capped preview page; full list via 3d
commit → { version, deltaCounts, resolvedCount }
```

Algorithm:
```
1. AuthZ: webOwner claim required. (Explicit parameterized scope step — mirror seam.)
2. Validate: nodeType legal; 1 ≤ nodeIds ≤ 200; all nodes exist, status=='active',
   same nodeType, and (unless nodeType=='institute') same instituteId.
   Archived node in a NEW selection → hard error. Archived node encountered at
   SYNC of an existing allocation → hard error with the node named — never silent ∅.
3. Expand nodes → Set<studentId>:
   • nodeType 'institute' → students where instituteId == nodeId
   • any other level → descendant Section/Group ids via the denormalized ancestor
     fields already on those docs (e.g. sections where courseId==X), plus the node
     itself; then academicMappings where nodeId in [ids] (chunked ≤30); collect
     studentIds. No tree recursion; no schema change to mappings.
   Handles semesterId==null program chains (both branch shapes in the descendant query).
4. final = union across nodeIds. Per-student matched-node ids recorded for the
   preview's "via which node" answer.
5. delta = final vs current members where source=='rules'.
   Manual members are INVISIBLE to this computation — never added, never removed,
   never counted in delta (D6).
6. dryRun → return preview. STOP.
7. Commit → transaction:
   a. re-read allocations/{id}; assert version == expectedVersion
      (mismatch → 'ALLOCATION_CHANGED — re-preview'; the concurrent-admins race,
      handled in exactly one place)
   b. if assessment.status=='active' && delta.removed non-empty → REJECT (D7)
   c. write allocation doc (nodes denormalized, version+1, summaries)
   d. delta-write members: CREATE docs for delta.added only, source='rules'
   e. first commit only: set assessment.allocationMode='rules'
   f. append audit entry (action: 'materialize' or 'sync')
   Batching: >~490 member writes overflow the 500-op txn → txn commits
   rules/version/audit with a 'materializing' flag, member docs land via
   BulkWriter batches, flag cleared on completion. Safe because v1 is
   additions-only: a student either has a doc yet or not — no torn state.
8. No resolved lists, no PII in logs. Errors carry counts and node ids, never names/emails.
```

### 3b · `addManualMember` — the roster flow

```
Input:  { assessmentId, studentId }
1. AuthZ: webOwner.
2. Assessment must exist, allocationMode=='rules', not deleted.
3. Student must exist. (Deliberately NO requirement that the student belong to the
   allocation's institute — this is the external/retest escape hatch, and it is
   webOwner-only by construction.)
4. Idempotent: member doc already exists → return current state, no duplicate audit.
5. Create assessmentMembers doc: source='manual', addedBy=caller uid.
6. Append audit entry (action:'manual_add', manualStudent named).
Student passes all normal startExam gates thereafter — no shortcut path, including
SEB/device/camera on high_stake (UI reminds the admin the student needs the .seb file).
```

### 3c · `startExam` — the ONLY change to an existing function

```
if assessment.allocationMode == 'rules':
    member = get(assessmentMembers/{assessmentId}_{studentId})   // O(1) by doc id
    if !exists || member.active !== true → uniform permission-denied
    attempt.allocationVersion = member.admittedByVersion         // provenance stamp
    attempt.allocationSource  = member.source                    // forensics
else:
    existing assignedTo gate — byte-for-byte unchanged
```

- `blockedStudents` stays where it is, applies to BOTH paths (block = runtime discipline; allocation = admission — the boundary stands).
- Enumeration hardening: not-assigned / not-found / unpublished return one uniform client error; specifics to server logs only.
- `securityLockedAt` explicitly does NOT cover allocation — manual adds and sync must work on live high_stake exams. Stated in code comment + rules clause.
- All other exam callables untouched (they operate on attempts; an attempt exists only if `startExam` admitted it).

### 3d · `getAllocationPreviewPage` (small, read-only)

Paged resolved-list reads for the panel's "View list" expansion and the pre-confirm review (grouped by node, searchable server-side by name/email prefix). Exists so the dry-run response stays bounded and the panel never downloads 10k students in one shot. webOwner only.

---

## 4 · Student discovery — dashboard integration

New service function (additive; new `src/lib/allocationService.ts`):

```
getRuleAllocatedAssessments(studentId):
  query assessmentMembers where studentId==X && active==true   // the new composite index
  → batch-fetch assessments by id, chunks of 30 (existing convention)
  → filter: status in ['active','closed'], isDeleted==false
```

`StudentAssessmentsPage` shows legacy visible set ∪ rule-path set, deduped by id. Neither path knows the other exists. Firestore rules allow a student to read `assessmentMembers` docs where `resource.data.studentId == request.auth.token.studentId` — own memberships only.

---

## 5 · Security rules & indexes (ship WITH Phase B, not after)

| Collection | Client read | Client write |
|---|---|---|
| `allocations/*` | webOwner | **false** |
| `assessmentMembers/*` | webOwner; student own-docs only | **false** |
| `allocationAudit/*` | webOwner | **false** — immutable to everyone |

Plus: `assessments` clause forbids client writes to `allocationMode` (function-only).
Institute/faculty reads: deliberately absent in v1; the denormalized `instituteId` fields make those clauses one-liners at mirror time.
PII posture: encryption at rest/in transit is platform-default; the controlled surfaces are function logs (nothing listed in §3a-8), error messages (counts, never names), and audit readability (webOwner only).
Deploy: `firebase deploy --only firestore:rules,firestore:indexes` (exact commands at delivery, per workflow).

---

## 6 · Resolver correctness harness (Phase B gate — before any UI)

Resolver core = pure function (allocation + hierarchy snapshot + mappings snapshot → member set + per-node counts), extracted from the Firestore fetch layer so it sweeps headlessly.

- Synthetic world: 3 institutes × schools → groups; ~5,000 fake students; deliberate multi-mapping; semester-null branches; unmapped students; archived nodes.
- Property sweep (headless Node, generated allocations across every nodeType):
  union idempotence/commutativity (nodeId order never matters); node(parent) ⊇ node(child); multi-mapped student appears once with all matched nodes; archived-node → hard error never ∅; semester-null chains; caps; empty-result rejection; delta correctness across sequential syncs; **manual-member invariance under sync** (the D6 property — swept explicitly); version-precondition race → exactly one concurrent commit wins.
- Emulator pass: transaction + BulkWriter overflow behavior; rules denials (all client writes to the three collections fail; student cross-reads fail; own-reads pass); `startExam` admits member / rejects non-member with uniform errors; **legacy-assessment regression cases — rule machinery deployed, legacy path byte-identical**.
- Zero-defect gate before Phase C.

---

## 7 · High_stake publish-readiness gate

Publishing (status → active) a high_stake assessment requires ALL of:
1. Per-exam Config Key registered in `sebAssessmentKeys/{assessmentId}` (D11)
2. `.seb` file uploaded (`sebConfigFileUrl` set)
3. Quit URL configured in the SEB config — **the open backlog item lands here**, as a checklist line with a home instead of a one-off fix
4. Allocation non-empty: rule path → `resolvedCount + manualCount > 0`; legacy → `assignedTo` present

Enforced server-side; mirrored as a visible checklist in the builder so failure happens at publish time with a reason, not on exam morning. `.seb` retrieval stays authed-read in v1 (Q6 deferred; the membership doc is exactly the entitlement check a future mint-a-link callable will use).

---

## 8 · Build phases (each independently deployable; stop-anywhere safe)

> Order revised (owner decision, Jul 12): **UI-first** — D1 → D2 → B → C → E. During D2 the
> preview counts run on a client-side scaffold resolver (read-only, clearly marked throwaway)
> and the Confirm/commit action is stubbed — client writes to allocation collections are
> forbidden by design (invariant 9), so no membership data exists until B lands. The scaffold
> is deleted when B wires in; the harness still gates before any real membership write.

| Phase | Contents | Deploy surface | Gate |
|---|---|---|---|
| **A** ✅ | This document + `ALLOCATION_UI_PLAN.md` | none | Owner sign-off |
| **D1** ✅ | Builder wizard 2→3 steps: legacy Assign To relocated from Step 1 Basics to new Step 3 (Allocation); zero behavior change; webOwner builder only | frontend auto-deploy | Visual verification |
| **D2** | Allocation panel UI per `ALLOCATION_UI_PLAN.md` §2–§6 (fourth "By hierarchy" mode in Step 3 + edit-flow AccessPanel), preview on scaffold, commit stubbed | frontend auto-deploy | Manual E2E on staging data |
| **B** | Pure resolver core + synthetic-world harness + sweep; `resolveAllocation`, `addManualMember`, `getAllocationPreviewPage`; rules + indexes | `--only functions:resolveAllocation,functions:addManualMember,functions:getAllocationPreviewPage` + `firestore:rules,firestore:indexes` | Sweep zero-defect |
| **C** | `startExam` gate + provenance + enumeration hardening; `allocationService` + `StudentAssessmentsPage` merge; publish gate; D2 scaffold deleted, UI wired to server dry-run/commit | `--only functions:startExam` + frontend auto-deploy | Emulator pass incl. legacy regression |
| **E** | Roster integration (member-list population, "Add student", allocation history strip) per UI plan §7–§8 | frontend auto-deploy | — |

Per workflow: full-file deliveries, change-summary block on top, Cloud Shell always `git pull` first + explicit flags; any functions change ships the entire `functions/src/index.ts`.

---

## 9 · Invariants

1. The membership list changes ONLY through `resolveAllocation` commits and `addManualMember` — never as a side effect of hierarchy edits, enrollment, or anything else.
2. Sync recomputes `source=='rules'` members only. Manual members are invisible to sync — never removed, never re-counted, never re-sourced.
3. `startExam` trusts only the membership doc (rule path) or `assignedTo` (legacy) — never a client claim.
4. Preview and commit are one code path (`dryRun` flag).
5. Allocation edits never touch in-flight attempts. Stopping a mid-exam student is `blockedStudents` / `freezeAttempt`.
6. Legacy-path assessments are byte-for-byte unaffected by this system's existence.
7. Audit is append-only for every principal; actor identity from `request.auth` only.
8. No resolved lists, CSV content, or student PII in logs or error messages.
9. `allocationMode`, `allocations`, `assessmentMembers`, `allocationAudit`: function-written only.

---

## 10 · Explicitly out of scope for v1 (with the seam that keeps each cheap)

| Deferred | Seam in v1 |
|---|---|
| Exclude rules / mixed node types / CSV selector | Allocation object is one typed shape; richer selectors are additive fields on a machinery (resolver/audit/materialization) that is selector-agnostic |
| Removals while live; manual-member removal (Q5) | `active` flag exists; delta.removed plumbing exists and is rejected, not absent |
| Institute-admin / faculty mirror + faculty delegation | Scope param in resolver; `instituteId` denormalized everywhere; shared-core UI component |
| Per-student `.seb` mint-a-link (Q6) | Membership doc IS the entitlement check |
| Notifications for added students | Materialization/manual-add audit deltas are the natural event source |
| Per-institute schedule windows; eligibility/re-attempt selectors | Additive on the same shape |
| Legacy→rules migration tooling | Both paths coexist indefinitely; migration optional forever |
| Open electives (courses enrolling students across programs) | v1 keeps strict tree semantics. Convention: host open electives under a dedicated neutral node so program-level targeting stays unpolluted; target electives directly by course (always correct). The real fix — splitting HOME structure from ENROLLMENT — is a hierarchy redesign the allocation system survives unchanged, since it resolves whatever the mappings say |
| Session → Batch rename | Display-label change only (`NODE_LEVEL_LABELS`); allocation UI inherits it automatically. Never rename `sessionId` fields or the `academicSessions` collection |

---

## 11 · Mirror-readiness (built now, used later)

1. `resolveAllocation` takes an explicit caller-scope step even though webOwner trivially passes — mirroring = narrower scope, not a new system.
2. `instituteId` denormalized on the allocation, every node entry, and every member doc — future institute-scoped reads/rules are one-line clauses.
3. The allocation panel is a shared-core component mounted only in the webOwner builder — mirroring = mount + scope param, per the existing role-mirror discipline.

---

*No open design inputs remain. Next delivery on "go": Phase B, in the standard format.*