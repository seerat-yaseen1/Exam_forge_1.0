# STRATUM — Student Allocation: UI Plan (v1.1, webOwner builder only)

> Companion to `ALLOCATION_SYSTEM_PLAN.md` v2. Screen-level specification for Phases D–E.
> v1.1 change: §3 picker fully revised — search-first + ancestor filter chips replaces
> the drill-down + side-rail design. Everything else unchanged.
> Everything here is additive: legacy targeting UI is never modified, only sat beside.
> Component discipline: shared-core pattern (like `AssessmentRosterCore`) — built once,
> mounted only in webOwner surfaces for v1.

---

## 1 · Component architecture (new files, existing conventions)

```
src/app/components/assignments/allocation/
  AllocationPanelCore.tsx      // the whole allocation surface; mounted by AccessPanel (webOwner)
  NodePickerModal.tsx          // institute → node type → search-first flat list (§3)
  AllocationPreview.tsx        // live footer: counts, per-node breakdown, view-list expansion
  ConfirmAllocationDialog.tsx  // delta review + commit (+ live-exam banner variant)
  AllocationHistoryStrip.tsx   // audit deltas timeline (compact)
  AddMemberDialog.tsx          // roster "Add student" search flow
src/lib/allocationService.ts   // client wrappers for the callables + member/audit reads
```

- `AccessPanel.tsx` (existing, webOwner edit flow) gains a mode switch and mounts `AllocationPanelCore`; legacy targeting UI untouched, conditionally shown.
- `AssessmentRosterCore.tsx` (god node — additive branch only): rule-path assessments populate from `assessmentMembers`, gain "Add student" + history strip. Legacy assessments render byte-identically.
- Institute/faculty builders: no mounts, no changes, no imports. Mirror later = mount + scope param.

---

## 2 · Access panel — targeting mode

**State A — legacy assessment (default, all existing):** today's UI exactly. On assessments with NO attempts and NO rule allocation, a quiet "Switch to rule-based allocation" link; switching shows a one-time explainer and takes effect only on the first materialization — until that commit the assessment stays fully legacy. No auto-conversion, ever.

**State B — rule-path assessment**, top to bottom:
1. **Target summary card** — nodeType label + node chips (name, breadcrumb tooltip, removable); "Edit selection" reopens the picker pre-loaded.
2. **Drift banner** (only when drift ≠ 0) — "🔄 +12 students since last sync" + **Sync** → ConfirmAllocationDialog with the delta.
3. **AllocationPreview** (§5).
4. **AllocationHistoryStrip** (§8, last 3 events, expandable).

Empty state: one primary action — "Choose who takes this exam" → picker.

---

## 3 · NodePickerModal — search-first selection (FINALIZED)

Minimal chrome: one search input, a lazy filter-chip row, one flat list, a footer count. No tree widget, no drill-down navigation, no side rail.

**Step 1 — Institute.** Searchable list (name + code). Single-select (one institute per allocation, per system plan). Exception: node type "Institute" in step 2 flips step 3 into multi-select of institutes — the one sanctioned cross-institute form.

**Step 2 — Node type.** Ten options (School … Group) with live counts for the chosen institute ("Sections — 42"); zero-count types disabled. Copy note: "Students with no academic mapping can only be reached via Institute targeting or added manually from the roster."

**Step 3 — the list.** One query fetches ALL nodes of the chosen type in the institute (denormalized `instituteId`). All narrowing is client-side over fields the docs already carry.

**Layer 1 — hierarchy-aware search.** One command-palette-style input. The query is tokenized; every token must match some segment of a row's breadcrumb (or name). `data struct sec a` → "…› Data Structures › Sec A" only. `year 2 cse` → all nodes under both. Matched tokens highlight inside the breadcrumb so relevance is self-evident. Keyboard end-to-end: type → arrows → space selects → enter commits.

**Layer 2 — ancestor filter chips (Excel-filter mechanic, not navigation).**
- The filter row offers **only levels ABOVE the chosen node type** — you never filter by the type you're picking. Picking Sections → possible filters School · Level · Program · Session · Year · Semester · Course. Picking Groups adds Section to that set; picking Courses drops Course from it; picking Schools has none (search only). One rule, no special cases.
- Each dropdown is populated from the **distinct values of that field across currently visible rows**, with counts ("B.Tech CSE (120)"). Selecting one keeps matching rows; the list narrows in place, never navigates.
- Filters **render lazily** — a dropdown appears only when it has >1 distinct value among visible rows. One-school institutes never see a School filter.
- Filters **cascade automatically**: with Program=B.Tech CSE set, the Course dropdown rebuilds from remaining rows and offers only that program's courses.
- **Duplicate-name disambiguation is structural:** a course "in multiple programs" is, in STRATUM's schema, multiple course docs each with a single ancestor chain — so the Course dropdown shows "Data Structures — B.Tech CSE" vs "Data Structures — BCA" as distinct entries, and filtering by Program first makes the shared name unambiguous. Either order works; the row breadcrumb is the final proof.
- `semesterId: null` chains handle themselves: dropdowns only offer values that exist, so non-semester programs simply produce no Semester option.
- Search (Layer 1) and filters (Layer 2) are the same operation underneath — both narrow the visible rows — two input styles for two habits.

**Layer 3 — selection persistence.** Selected nodes pin to a "Selected — N" section at the top of the list (removable there), surviving any search/filter changes across the whole session. The footer "N nodes selected" is the single source of truth. Select-all and per-group select-all operate on the **currently visible (filtered) rows** — so "all sections of Data Structures" = filter to the course → select all.

**Row anatomy:** node name · muted full breadcrumb · right-aligned student count (from dry-run `byNodeCounts` once a selection exists; on-hover before that). Rows grouped by immediate parent with sticky, selectable group headers.

**The D10 nudge:** when select-all is used and every selected node shares one parent — "You've selected every Section of *Data Structures*. Target the Course instead if sections created later should be included automatically." One click converts. Dismissible, once per session, never blocking.

**Accelerators:**
- **Recents** — an empty picker opens showing this institute's recently/frequently targeted nodes before any typing.
- **"Copy allocation from…"** — seed the selection from another assessment's node set, then adjust. (Exam series: same cohort, ten tests — a 2-minute selection becomes 5 seconds.)

Footer: "N nodes selected" + Cancel / "Use selection" (returns chips to the panel; nothing saved or resolved yet).

---

## 4 · Selection → preview loop

Any chip-set change fires a **debounced (600 ms) `resolveAllocation(dryRun)`**. In flight: skeleton counts; previous figures grey out — never stale numbers presented as current. Dry-run errors (archived node, cross-institute node, cap) render red on the offending chip and disable Confirm. Warnings (D10 case, redundant containment) render amber, non-blocking.

---

## 5 · AllocationPreview — the live footer

- **Headline:** "**1,847 students** will be allocated · 14 sections · Institute A" (+ "· 3 added manually" once manual members exist — counted separately, never conflated).
- **Per-node breakdown:** node → count, sorted desc; zero-count nodes flagged ("Sec D — 0 students mapped") — a data-entry surprise, not an error.
- **"View full list"** → paged via `getAllocationPreviewPage`: grouped by node, searchable by name/email; each row shows matched node(s) ("via Sec A, Grp 2"). Manual members in their own group with `addedBy` + date.
- **Delta line** when a previous version exists: "+3 since version 4", expandable to exactly who.

---

## 6 · ConfirmAllocationDialog — the only write path

Triggered by "Confirm allocation" (first), "Sync" (drift), or "Save changes" (edited selection):
- Old → new version; full delta (added listed, paged; removed always empty in v1 — a selection edit that would shrink the list on an ACTIVE exam replaces Confirm with a blocking explanation per D7).
- **Live-exam variant:** red banner — "This exam is **LIVE**. 3 students gain entry immediately on confirm." High_stake adds: "Added students will need the exam's .seb configuration file."
- Above 10,000 resolved: type-the-count confirmation.
- Commit → `resolveAllocation(commit, expectedVersion)`. On `ALLOCATION_CHANGED`: non-destructive — "Allocation was changed elsewhere. Review the updated preview." — dialog refreshes to a fresh dry-run, selections preserved.
- Success: toast; panel re-renders from the committed doc; history strip gains the event.

---

## 7 · Roster integration (`AssessmentRosterCore`, rule-path only)

- **Population:** rows from `assessmentMembers` (by assessmentId), joined with attempt streams exactly as today. Badge for `source:'manual'` ("Added manually"). Legacy assessments: zero rendering change.
- **"Add student" (webOwner only):** `AddMemberDialog` — search enrolled students (name/email/id; institute filter defaults to the allocation's institute but is not restricted to it — the external/retest case); rows show enrollment breadcrumbs; Add → `addManualMember` → row appears live, audit recorded. Already-member rows show "Already allocated (via Sec A)" instead of the button — idempotent in UI as in API.
- High_stake manual add → reminder toast: "Ensure this student receives the .seb configuration file."
- Freeze/unfreeze, block/unblock, attempt streaming: untouched on both paths.

---

## 8 · AllocationHistoryStrip

Reverse-chronological from `allocationAudit`:
`"v5 · Sync · +12 · by <name> · Jul 12, 10:04"` / `"Manual add · Priya S. · by <name> · 10:31 · LIVE"`.
Rows expand to paged delta lists. `isLive` events carry the LIVE tag. Read-only forever — no edit affordance exists to build, by design.

---

## 9 · Publish-readiness checklist (builder, high_stake only)

On publish: checklist of — per-exam Config Key registered · .seb file uploaded · quit URL configured · allocation non-empty — each unmet line linking to the fixing surface. Publish disabled until all pass; the server enforces the same list regardless (system plan §7) — the UI mirrors the gate, it is not the gate.

---

## 10 · States, errors, copy discipline

- Skeletons for loading counts/lists; never spinners over stale numbers.
- Students see nothing of this feature beyond allocated exams on their dashboard; non-members probing an exam get the existing uniform denial.
- Error copy carries counts and node names, never other students' PII (matches the logging invariant).
- Existing builder styling throughout (shadcn primitives, existing drawer/dialog patterns); no new design language. Desktop-first; usable at tablet width; no phone-specific work in v1.

---

## 11 · Phase D/E acceptance walkthrough (manual E2E)

1. Create assessment → rule mode → Institute A → Sections → filter Program=B.Tech CSE, Course=Data Structures → select-all (D10 nudge appears) → keep sections → confirm v1 → members + audit `create`/`materialize` exist.
2. Search `year 2 bca sec` → add 2 more sections across a different program in the same session (Layer 3 tray holds all) → delta +N → confirm v2.
3. Map a new student into a targeted section via hierarchy admin → drift banner +1 → Sync → v3 names the student; manual members untouched.
4. Publish (high_stake) → checklist blocks until key/file/quit-URL set → passes → active.
5. Roster → Add student from a DIFFERENT institute → manual badge → student's dashboard shows the exam → enters through full gates → attempt stamped with allocationVersion + source.
6. Concurrent second-admin edit → first commit wins; second gets the re-preview flow; nothing corrupted.
7. Legacy assessment side-by-side → identical to production today; no rule surfaces visible.
8. Copy-allocation-from seeds a new assessment's picker from #1's node set → adjust → confirm.

---

*Phase D/E deliverables will follow the standard format: full files, paths, change summary on top.*
