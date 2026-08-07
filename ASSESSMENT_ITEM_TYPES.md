# Assessment Item Types — the taxonomy, and what it costs to build one

**The canonical list of every kind of item Exam Forge delivers or intends to
deliver, what is actually built today, and the change list a new type has to
work through.**

> Companion to `PLATFORM_EXTENSION_PLAN.md` (which phases group questions,
> coding and games) and to the Section & Exam Builder plan (whose Step 1 —
> *Type* — is a choice from this taxonomy). Neither of those documents wrote the
> vocabulary down in one place; this one does.
>
> The taxonomy also lives in code, at `src/lib/itemTypes.ts`. **That file is the
> source of truth** — this document explains it and records the reasoning. If
> the two disagree, the code is right and this file is stale.

---

## 1 · The taxonomy

`✅ live` — an engine backs it; authorable, deliverable and gradable today.
`◻ planned` — designed, on a named track, not built.
`· future` — named only; no design behind it yet.

```
Assessment Item
│
├── Objective
│   ├── ✅ MCQ — Single Correct
│   ├── ✅ MCQ — Multiple Correct
│   ├── ✅ True / False
│   ├── ✅ Match the Following
│   ├── ◻ Sequence / Ordering
│   ├── ✅ Fill in the Blank
│   ├── ◻ Numeric Answer
│   ├── ◻ Hotspot
│   ├── ◻ Drag & Drop
│   └── ◻ Matrix / Grid
│
├── Subjective
│   ├── ✅ Short Answer
│   ├── ✅ Long Answer
│   ├── ◻ Essay
│   ├── ◻ Case Analysis
│   └── ◻ File Upload
│
├── Grouped Item
│   ├── ✅ Reading Comprehension
│   ├── ✅ Data Interpretation
│   ├── ✅ Seating Arrangement
│   ├── ◻ Blood Relation
│   ├── ✅ Puzzle
│   ├── ✅ Caselet
│   ├── ◻ Logical Set
│   └── ✅ Multi-question Passage
│
├── Coding                          ◻ all — Extension Phase 2
│   ├── Coding Challenge
│   ├── SQL Challenge
│   ├── Debugging
│   ├── Output Prediction
│   └── Code Review
│
├── Cognitive Game                  ◻ all — Extension Phase 3
│   ├── Memory              ├── Spatial Ability
│   ├── Attention           ├── Multitasking
│   ├── Reaction            ├── Processing Speed
│   └── Logical Pattern     └── Decision Making
│
├── Multimedia                      ◻ all — Multimedia track
│   ├── Audio Response
│   ├── Video Response
│   ├── Image Annotation
│   ├── Speech Recording
│   └── Whiteboard
│
├── Practical                       ◻ all — Practical track
│   ├── Simulation
│   ├── Virtual Lab
│   ├── Spreadsheet Exercise
│   ├── Design Exercise
│   └── Workflow Task
│
└── Future                          · no design yet
    ├── AI Interview
    ├── Live Interview
    ├── External Assessment
    ├── Psychometric Inventory
    └── Adaptive Item
```

**51 types. 13 are live.** Everything else is a name with a change list
attached, and §5 is that change list.

---

## 2 · What is live, and what it maps onto

Two storage surfaces implement the live types. Standalone questions bind to an
`engine` + `variant` pair; grouped sets bind to a `GroupKind` and their children
are ordinary questions.

| Taxonomy entry | Binding | Scoring |
|---|---|---|
| MCQ — Single Correct | `mcq` / `single` | auto |
| MCQ — Multiple Correct | `mcq` / `multi` | auto, partial credit |
| True / False | `mcq` / `truefalse` | auto |
| Fill in the Blank | `mcq` / `fillblank` | auto |
| Match the Following | `match` / `null` | auto, proportional |
| Short Answer | `text` / `short` | manual |
| Long Answer | `text` / `long` | manual |
| Reading Comprehension | group kind `rc` | auto (children) |
| Data Interpretation | group kind `di` | auto (children) |
| Seating Arrangement | group kind `seating` | auto (children) |
| Puzzle | group kind `puzzle` | auto (children) |
| Caselet | group kind `caselet` | auto (children) |
| Multi-question Passage | group kind `generic` | auto (children) |

Grouped sets say "auto" because their children are MCQs in practice — a child
is an ordinary question with an ordinary engine, so a Long Answer child is
graded by hand exactly like a standalone one.

### Five mapping decisions worth stating outright

**MCQ is one type in two forms, not two types.** Single Correct and Multiple
Correct are both multiple-choice questions; they differ in how many options are
correct. What matters is that the candidate knows which form they are looking at
*before* they answer, so the two are separated by affordance and by wording:

| | Single Correct | Multiple Correct |
|---|---|---|
| Indicator | round radio | square checkbox |
| Instruction | none needed | **"More than one option is correct — select all that apply."** |
| Selection | replaces the previous one | toggles independently |
| Scoring | right or wrong | partial credit, `(hits − wrongs) / correct` |

"Select all that apply" on its own was not enough. It reads as "tick any that
happen to fit", which a candidate can satisfy with one box and move on — and the
checkbox shape is then the only remaining signal, which is easy to miss on a
phone. The instruction now states the fact rather than the interface, and is set
in ink rather than muted grey because it is a rule of the question.

**Fill in the Blank is option-based, not free-entry.** The stem carries `___`
and the candidate picks from supplied answer candidates. A true typed-response
blank is the Numeric Answer / short-text-key problem, and it is not built. The
name is honest about what the candidate sees, not about how it is stored.

**Long Answer and Essay are two entries, one engine.** `text`/`long` is Long
Answer. Essay is listed separately and marked planned because what makes an
essay an essay operationally — a word target, a rubric grid the grader scores
against, criterion-level marks — is exactly what `text`/`long` does not have.
Collapsing them would mean the platform claims a feature it does not have; the
authoring drawer says so directly, in the type's *today* line.

**`generic` is Multi-question Passage.** The catch-all group kind and the
taxonomy's catch-all grouped type are the same thing, so they share a name. This
renames the label faculty see from "Grouped Set" to "Multi-question Passage".

**Blood Relation and Logical Set are NOT aliased onto `generic`.** They can be
authored today as a Multi-question Passage and behave identically — only the
filter label differs — but they stay non-live in the registry rather than
pointing at `generic`. Three taxonomy entries resolving to one group kind would
break the round trip: given a stored `generic` set there would be no way to know
which of the three to call it. They become live when they get their own kinds,
which is a one-line addition to `GroupKind` (see §6).

---

## 3 · The registry

`src/lib/itemTypes.ts` holds the taxonomy as data: id, category, label, badge,
scoring model, one-line summary, and — for the types that aren't built — the
track they sit on and what to use instead in the meantime.

### The one rule

> A type is live **if and only if** a real `QuestionEngine`/`QuestionVariant`
> pair or a real `GroupKind` resolves to it, in the binding tables in §3 of that
> file.

`itemTypeStatus()` derives liveness from those tables and nothing else. There is
no `status: 'live'` field to hand-edit, so **a def cannot claim to work when no
engine backs it** — which is the failure the file exists to prevent. Adding a
row to a binding table is what makes a type selectable in the authoring drawer,
so that row is a promise that all of §5 is done.

The binding tables are `Record<>`s over the engine unions, which makes them
exhaustive: adding a member to `MCQVariant`, `TextVariant` or `GroupKind` is a
compile error until the new member names the taxonomy entry it satisfies. The
`ItemTypeId` union is derived from the registry object rather than declared
beside it, so an id with no def, or a def with no id, is not expressible either.

### Import direction

`itemTypes.ts` imports **types only** from `questionBankService` (erased at
build). `questionBankService` imports **values** from `itemTypes`. Keep it that
way — a value import in the other direction is a runtime cycle that Vite
resolves to `undefined` during module init, which surfaces as a blank question
bank rather than as an error.

### What now reads from it

| Surface | Was | Now |
|---|---|---|
| `questionTypeLabel` / `questionTypeBadge` | two if-ladders | registry lookup |
| `GROUP_KIND_LABEL` | its own literal | derived from the registry |
| Authoring type picker (`QuestionTypeEngine`) | hand-typed `TYPE_OPTIONS` | live question types, plus a collapsed roster of what is planned |
| Bank type filters (×3 pages) | three copies of a badge-string array | one derived array; filters on type **id**, not badge text |
| Student question chip (`QuestionRenderer`) | its own if-ladder | registry lookup |

The bank filter is the reason this was worth doing. It compared
`questionTypeBadge(...)` against a hardcoded string list, in three files — so
renaming a badge silently produced a filter chip that matched nothing, with no
error anywhere. Filtering on the id decouples the two.

---

## 4 · The authoring picker shows what it cannot do

The type picker lists the live types as cards and, below them, a collapsed line:
*"Not yet available — 38 more item types in the taxonomy"*. Expanding it lists
them by category, each with a tooltip carrying the summary and — where one
exists — the stand-in to use today ("Numeric Answer: use Short Answer and grade
it by hand").

This is deliberate. Faculty asking "where is Hotspot?" otherwise cannot tell a
type that is missing from a type they cannot find, and the honest answer is
short enough to just say. It also means the roadmap cannot quietly drift from
what the product shows, because both come from the same array.

---

## 5 · What a new item type actually costs

A type is not done when it has an editor. These are the integration points a
live type has to satisfy — the list is derived from what `mcq`, `text` and
`match` each touch today.

| # | Point | Where | Needed when |
|---|---|---|---|
| 1 | Taxonomy entry | `src/lib/itemTypes.ts` | always |
| 2 | Engine / variant union | `questionBankService.ts:85–88` | new engine or variant |
| 3 | Question field storage | `Question` type, `questionBankService.ts:106` | new response shape |
| 4 | Empty-draft factory | `buildEmptyMCQ` / `Text` / `Match`, `:1615+` | always |
| 5 | Authoring editor | `QuestionTypeEngine.tsx` | always |
| 6 | Faculty preview | `QuestionPreview.tsx` | always |
| 7 | Duplicate detection | `duplicateDetection.ts` + `getDuplicateCheckPool` | new stem/answer shape |
| 8 | Answer-key document | `QuestionAnswer`, `questionBankService.ts:398` | any type with a key |
| 9 | Student renderer | `exam/QuestionRenderer.tsx` | always |
| 10 | Answered-detection | `isAnswered`, `exam/QuestionNavigator.tsx:108` | new answer value shape |
| 11 | Attempt answer union | `AnswerValue`, `submissionService.ts:161`, and its server twin `AttemptAnswerDoc`, `functions/src/index.ts:3561` | new answer value shape |
| 12 | Server field whitelist | `sanitizeQuestionForStudent`, `functions/src/index.ts:4624` | **always — a field not on this allow-list never reaches the candidate** |
| 13 | Grading branch | `scoreMCQMultiplier` / `scoreMatchMultiplier` + the dispatch at `functions/src/index.ts:~3910` | any auto- or hybrid-scored type |
| 14 | Firestore rules validation | `firestore.rules` | new persisted fields |
| 15 | Bulk upload + export | `bulkUploadParser.ts`, `ExportModal.tsx` (one sheet per engine) | new engine |
| 16 | Selection rule kind | `RuleKind`, `assessmentService.ts:226` | only when selection semantics differ (as groups do) |

**A new *variant* of an existing engine is cheap** — points 1, 4, 5, 6, 9, 13
and usually nothing else, because the storage shape, the answer value and the
sanitiser allow-list already cover it. **A new *engine* is expensive** — all 16.
That asymmetry is what should drive sequencing, and it is why the extension plan
insists coding and games are engines rather than block types: ship one as a
block type and the exam renders a blank card.

---

## 6 · The tracks

### Objective engine track — Sequence, Numeric, Hotspot, Drag & Drop, Matrix

The most valuable group and the least designed. Two are near-free and three are
not:

- **Numeric Answer** — a typed number matched against a value plus tolerance.
  New answer value (`number`), new key field, new grading branch. No new
  rendering concepts. **Cheapest real addition in the taxonomy.**
- **Sequence / Ordering** — reuses the match engine's shape almost exactly (an
  ordered list is a mapping from position to item). Worth costing as a `match`
  variant before assuming a new engine.
- **Matrix / Grid** — one option set, N rows. Storage is N sub-answers under one
  question id, which is the first type to break the "one question, one answer
  value" assumption in points 10–13. Author each row as an MCQ inside a grouped
  set until then.
- **Hotspot** and **Drag & Drop** — both need coordinate/zone data on the
  question, pointer interaction in the renderer, and a mobile story. The
  platform already runs exams on phones for the normal tier, so "drag a box"
  needs a touch answer before either can ship.

### Subjective engine track — Essay, Case Analysis, File Upload

Essay and Case Analysis are the same underlying gap: **there is no rubric
model.** Both are `text`/`long` plus criterion-level scoring, a word target, and
a grader UI that awards per criterion. Build the rubric once and both land.

File Upload is different and heavier: candidate-uploaded files during a live
exam means storage rules, virus/type policy, size caps under exam conditions,
and a retention answer that satisfies the erasure paths already in the codebase.

### Grouped kinds — Blood Relation, Logical Set

The smallest change in this document: add two members to `GroupKind`, add their
labels to the registry's binding table (the compiler will demand it), and they
are live. No new engine, no renderer change, no grading change — the group
machinery from Extension Phase 1 already carries them. Worth doing next to any
other grouped work rather than on its own.

### Coding — Extension Phase 2

Designed in `PLATFORM_EXTENSION_PLAN.md` §4. New `code` engine, a `CodingRule`
selection kind, and an execution sandbox — the sandbox, not the item type, is
the real scope. Output Prediction and Code Review are the exceptions: neither
needs execution (one is an MCQ or short answer over a snippet, the other a long
answer over a diff), so both could ship ahead of the sandbox as variants if
there is demand.

### Cognitive Games — Extension Phase 3

Designed in `PLATFORM_EXTENSION_PLAN.md` §5. Beyond the `game` engine, games
break two assumptions the rest of the platform is built on:

- **Timing.** A game carries its own internal clock, so the section timer may
  not apply at all. Flagged as open in the builder plan §6, still open here.
- **Scoring.** A raw game score is not marks. Something has to map
  speed/accuracy onto a marks band, and whether that mapping is per-game, per
  section or per exam is undecided.

### Multimedia and Practical

No design yet beyond the names. Both share one hard prerequisite with File
Upload: **candidate-produced binary artefacts during a proctored exam.** Media
capture, storage rules, retention, and grading a file rather than a value. That
prerequisite should be scoped once, for all of them, rather than three times.

### Future

Five directions, no commitments — which is why none carries a track and all
report as `future`. Adaptive Item is the one with a dependency already written
down: the builder plan's Phase 8 Adaptive Method, whose per-question pacing and
one-at-a-time delivery are a delivery-engine change, not an item type.

---

## 7 · Deliberately not done in this pass

- **No new engine, variant or group kind.** Nothing about how a question is
  stored, selected, rendered or graded changed. The registry names things; it
  does not implement them.
- **No selection-rule change.** `RuleKind` stays `topic | group`. Sections still
  cannot be locked to a single item type — the builder plan's Step 1 — because
  that is a rule-level change and belongs with the section-builder work.
- **No migration.** Nothing reads a stored item-type id, because nothing stores
  one. The ids exist so that future per-type config, analytics dimensions and
  blueprint rules have a stable key to hang off.

## 8 · Visible changes

Three labels move to the taxonomy's vocabulary:

| Where | Was | Now |
|---|---|---|
| `text`/`long`, everywhere | "Long / Essay" (badge "Essay") | "Long Answer" (badge "Long") |
| `mcq`/`multi`, everywhere | "MCQ — Multi Correct" | "MCQ — Multiple Correct" |
| `mcq`/`multi`, in the exam | "Select all that apply." (muted) | "More than one option is correct — select all that apply." (ink) |
| group kind `generic` | "Grouped Set" | "Multi-question Passage" |
| `match` in the type picker | "Match the Columns" | "Match the Following" (the name the rest of the app already used) |

The student-facing chip mid-exam now shows the same name the author picked
rather than its own shorter variant of it ("MCQ — Single Correct", not "MCQ").

## 9 · Open questions

1. **Section-to-type locking.** The builder plan locks a section to one item
   type. At what granularity — engine (`mcq`), taxonomy entry (`mcq-multi`), or
   category (`objective`)? Category is the most useful and the least
   restrictive; entry is what the plan literally says.
2. **Matrix / Grid's answer shape** decides whether "one question, one answer
   value" survives. Answer it before building any of Matrix, Drag & Drop or
   Hotspot, because all three push on it.
3. **Game scoring bands** — per game, per section, or per exam.
4. **Whether Essay is a variant or a rubric flag on Long Answer.** If rubrics
   land as an optional attachment to any manually-graded type, Essay and Case
   Analysis stop being types at all and become configurations. That would be a
   better outcome than three near-identical text variants.
