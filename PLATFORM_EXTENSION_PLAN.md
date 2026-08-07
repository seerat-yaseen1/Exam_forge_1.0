# Platform Extension — Group Questions, Coding, Games

**Fit & gap analysis against the current codebase**, and the concrete change list per phase.

> Companion to `deepresearchreportv2.md` (the blueprint-engine research report).
> This document is the reconciliation: what that report proposes, what Exam Forge
> already has, where the two agree, and where the report has to change because it
> was written without the code in front of it.
>
> Prime directive inherited from `ALLOCATION_SYSTEM_PLAN.md`: **purely additive —
> nothing that exists today changes behavior.**

---

## 0 · Executive answer

**The blueprint engine the report proposes is ~70% already built.** `Assessment →
sections[] → rules[]` *is* a blueprint of blocks. What the report calls a
`BlockConfig` exists today as `QuestionSelectionRule`, just narrowed to a single
shape: source is always "everything the author can see", mode is always Random-N,
and constraints are always exactly `subject + topic + difficulty`.

So the work is **not** "build a blueprint engine." It is:

1. **Widen `QuestionSelectionRule` into a discriminated union** so a rule can
   describe things other than "N random questions at difficulty D". That single
   change is what unlocks group blocks, coding blocks and game blocks.
2. **Add a `questionGroups` collection** for shared stimulus (Phase 1).
3. **Add two new engines** — `code` (Phase 2) and `game` (Phase 3) — because in
   this codebase the *engine* is the extension point, not the block type.

The report's biggest structural error is treating coding and games as **block
types**. In Exam Forge, `engine` is what drives the authoring UI, the exam
renderer, the student-facing field whitelist, the grading switch, the bulk-upload
sheets, the navigator's answered-detection, and the `AttemptAnswer` type union. A
block type touches none of those. Ship coding as a block type and the exam
renders a blank card.

---

## 1 · What exists today (verified against the code)

### 1.1 The blueprint layer — already here

| Report concept | Exam Forge today | File |
|---|---|---|
| `Blueprint` | `Assessment` | `src/lib/assessmentService.ts:403` |
| `Section` | `AssessmentSection` | `assessmentService.ts:208` |
| `BlockConfig` | `QuestionSelectionRule` (subject, topic, difficulty, count, marksPerQuestion) | `assessmentService.ts:195` |
| Allocation engine | `resolveQuestionsForSections()` | `assessmentService.ts:277` |
| Publish-time coverage check | `validateSelectionRules()` | `assessmentService.ts:340` |
| `ExamQuestion` | `AssessmentQuestion` (questionId, marks, order) | `assessmentService.ts:185` |
| Ordering rules | `shuffleQuestions` + `sectionStartOrder` → `attempt.questionOrder` | `functions/src/index.ts:7702` |
| Scoring / negative marking | `AssessmentGradingConfig` + `resolveGradingPolicy()` (exam → section → difficulty-row chain, with the exam switch as a hard gate) | `assessmentService.ts:120` and its server twin `functions/src/index.ts:3459` |
| RBAC | `questionRightsCeiling`, per-faculty `questionRights`, request/approval inbox, tenant fence in `firestore.rules` | `src/lib/questionRights.ts`, `firestore.rules:884` |
| Audit | `deletionAudit`, allocation audit, approvals | `src/lib/deletionAudit.ts` |

### 1.2 The item layer — three engines, no groups

```
QuestionEngine = 'mcq' | 'text' | 'match'
  mcq   → variant: single | multi | truefalse | fillblank
  text  → variant: short | long
  match → variant: null
```

Answer keys live in a **sibling `questionAnswers` collection** so Firestore rules
can deny students the key while allowing the question. Students never read
`questions` directly at all — everything comes through `getExamQuestions`, which
runs every doc through `sanitizeQuestionForStudent()` (`functions/src/index.ts:4615`),
a hard field whitelist.

**There is no group, stimulus, passage or caselet concept anywhere in the
repository.** Confirmed by grep across `src/` and `functions/src/`: the only hit
for "comprehension" is a comment giving `"Reading Comprehension"` as an example
*section name*.

### 1.3 What the report can drop

| Report section | Verdict |
|---|---|
| §1 Data model (`Blueprint`/`Section`/`BlockConfig`/`ExamInstance`) | **Rewrite.** Don't introduce a parallel Blueprint entity — extend `AssessmentSection.rules`. A separate model means touching `startExam`, `gradeAttempt`, `normalizeSections`, `ExamShell` and `firestore.rules` simultaneously, which is the highest-risk change available in this codebase. |
| §8 Access control (4 roles) | **Drop.** The existing rights model (ceilings, per-faculty grants, direct-vs-request mode, tenant fence, approvals inbox) is strictly richer than Author/Reviewer/Publisher/Proctor. Implementing the report's model would be a downgrade. Map new item types onto `assertQuestionRight` instead. |
| §9 Scoring | **Mostly drop.** `gradingConfig` already does per-section and per-difficulty negative marking with an exam-level gate, frozen onto the attempt at start. Only the *new engines* need scoring branches. |
| §14 Concurrency (`SELECT … FOR UPDATE SKIP LOCKED`, exposure races) | **Drop for now.** Exam Forge resolves the paper **once at publish**, not per student — every student sits the same frozen `questions[]`, varied only by shuffle. There is no concurrent-generation race. This section only becomes real if you move to per-student paper generation, which is a separate decision. Saves roughly a sprint. |
| §6 Exposure / `exposure_count` on the question | **Defer.** Same reason. Also: a counter on the question doc is a hot-document write in Firestore; if this is wanted later, it belongs in a separate `questionUsage` collection, not on `questions`. |
| §17 Roadmap (18 sprints) | **Rescale.** Sprints 1–12 are largely describing work that already shipped. See §6 below. |

---

## 2 · The one enabling change: rules become a union

Everything in all three phases hangs off this. Today:

```ts
export type QuestionSelectionRule = {
  subject: string;
  topic: string;
  difficulty: 'easy' | 'medium' | 'hard';
  count: number;
  marksPerQuestion: number;
};
```

Proposed — additive, with the absent discriminant defaulting to the legacy shape
so **every existing assessment document keeps working with zero migration**:

```ts
export type TopicRule = {
  kind?: 'topic';               // absent === 'topic' (back-compat)
  subject: string;
  topic: string;
  difficulty: Difficulty;
  count: number;
  marksPerQuestion: number;
};

export type GroupRule = {
  kind: 'group';
  groupKind?: GroupKind;        // 'di' | 'rc' | 'caselet' | 'puzzle' | 'seating' | 'generic'
  subject: string;
  topic: string;
  difficulty: Difficulty;
  groupCount: number;                       // how many groups to draw
  questionsPerGroup: number | 'all';        // how many children from each
  marksPerQuestion: number;
};

export type CodingRule = {                  // Phase 2
  kind: 'coding';
  subject: string;
  topic: string;
  difficulty: Difficulty;
  count: number;
  marksPerQuestion: number;
  languages?: string[];                     // restrict the allowed language set
};

export type GameRule = {                    // Phase 3
  kind: 'game';
  gameId?: string;                          // fixed game, or…
  skill?: string;                           // …random from a skill category
  count: number;
  marksPerQuestion: number;
};

export type QuestionSelectionRule =
  | TopicRule | GroupRule | CodingRule | GameRule;
```

`resolveQuestionsForSections()` gets a `switch (rule.kind ?? 'topic')`. The
existing branch is untouched. `validateSelectionRules()` mirrors it.

This is also where the report's "hybrid block" falls out for free: a section
already holds an *array* of rules, so `[TopicRule, GroupRule, CodingRule]` in one
section **is** a hybrid block. No new concept needed.

**What is still missing versus the report, and worth adding at the same time**
(cheap now, expensive later):

- `AssessmentQuestion` gains `groupId?: string` — the frozen paper must record
  the grouping, or the exam shell has to re-derive it from the bank at runtime.
- Manual/fixed selection: today a rule can only say "N random". A
  `fixedQuestionIds?: string[]` on `TopicRule` covers the report's Manual Block
  without a new rule kind. `QuestionPickerModal` already exists to drive it.

---

## 3 · Phase 1 — Group questions

### 3.1 The five categories collapse to one model

DI, reading comprehension, caselets, puzzles and seating arrangement are
**structurally identical**: one shared stimulus, N dependent sub-questions. They
differ only in what the stimulus *contains*. So: one `QuestionGroup` model, one
`stimulus` field with a format discriminator, and a `kind` tag used purely for
filtering, labels and rule targeting.

| Category | Stimulus format | Typical children |
|---|---|---|
| Data Interpretation | table / chart image / mixed | mcq-single, numeric-ish short text |
| Reading Comprehension | long rich text | mcq-single, mcq-multi, text-short |
| Caselet | rich text (short prose + embedded figures) | mcq-single |
| Puzzle | rich text (+ optional diagram) | mcq-single, match |
| Seating Arrangement | rich text (+ optional diagram) | mcq-single |

Do **not** build five models. Do **not** build a "DI engine".

### 3.2 Model: group as a container, children stay ordinary questions

Two options were considered:

- **(A) `questionGroups` collection + `groupId`/`groupOrder` on `Question`.**
- (B) A new `engine: 'group'` whose question doc nests its children.

**Recommend (A).** Children remain ordinary `questions` docs with existing
engines, which means grading, answer-key storage in `questionAnswers`, the rights
model, the tenant fence, bulk upload and the renderer all keep working *unchanged*
for the child. Only the stimulus is genuinely new. It also lets one DI set mix
MCQ-single, MCQ-multi and short-text children — which real DI sets do.

Option (B) would force a second grading path and a second answer-key storage
shape, for no gain.

```ts
export type GroupKind = 'di' | 'rc' | 'caselet' | 'puzzle' | 'seating' | 'generic';

export type GroupStimulus = {
  format: 'richtext' | 'table' | 'image' | 'mixed';
  body?: string;              // rich text / passage (KaTeX already supported)
  images?: string[];          // Storage download URLs
  table?: {                   // DI tables authored structurally, not as an image
    headers: string[];
    rows: string[][];
    caption?: string;
  };
};

export type QuestionGroup = {
  id: string;
  kind: GroupKind;
  title: string;              // internal label, e.g. "DI — Sales by region 2024"
  stimulus: GroupStimulus;

  // Metadata — mirrors Question exactly so the same filters/pickers work
  subject: string;  topic: string;
  subjectId?: string;  topicId?: string;
  tags: string[];
  difficulty: Difficulty;

  childIds: string[];         // ordered; the authoritative child order

  // Ownership — identical stamp semantics to Question
  ownerType?: QuestionOwnerType;
  ownerId?: string;
  instituteId?: string;       // tenant stamp

  isDeleted: boolean;
  createdAt: string;
  updatedAt: string;
};

// On Question:
  groupId?: string;
  groupOrder?: number;
```

### 3.3 Change list — Phase 1

**`src/lib/questionBankService.ts`**
- `QuestionGroup`, `GroupStimulus`, `GroupKind` types; `groupId`/`groupOrder` on `Question`.
- `COL.questionGroups = 'questionGroups'`.
- CRUD writing group + children in one `writeBatch` (the file already uses batches).
- Deleting a group soft-deletes its children — and `deletionImpact.ts` must report
  the child count, or an author deletes an RC set and silently loses 5 questions.

**`firestore.rules`** — a `match /questionGroups/{id}` block that **mirrors
`/questions/{id}` line for line**: same tenant-fence read, webOwner-only direct
writes, institute/faculty routed through callables. Students denied direct read.
An RC passage is content worth as much as an answer key for exposure purposes;
it goes through `getExamQuestions` like everything else.

**`firestore.indexes.json`** — mirror the `questions` index: `isDeleted + instituteId`.

**`functions/src/index.ts`**
- `sanitizeQuestionForStudent()` → add `groupId`, `groupOrder` to the whitelist.
  *(Field whitelist: if it isn't added, the exam shell can't group anything.)*
- New `sanitizeGroupForStudent()` — stimulus + kind only; no keys, no explanation
  outside review mode.
- `getExamQuestions` → also fetch the distinct groups referenced by the paper;
  return `{ questions, groups }`. Still one round trip.
- New callables `createQuestionGroupAsRole` / `editQuestionGroupAsRole` /
  `deleteQuestionGroupAsRole`, each gated by the **existing** `assertQuestionRight`.
  Do not invent a new right — the ceiling model already covers this.
- **`startExam` group-aware shuffle** — the sharpest breakage in the whole phase.
  Today (`index.ts:7715`) it Fisher–Yates over every qid in the section. With
  groups that puts RC Q3 between two unrelated quant questions and orphans the
  passage. The shuffle must treat a group as **one atomic block**: shuffle blocks,
  keep children contiguous and in `groupOrder`.
- Grading: **no change.** Children grade per engine exactly as today.

**`src/lib/assessmentService.ts`**
- The rule union from §2; `GroupRule` branch in `resolveQuestionsForSections()`
  (pick groups → take `all` or K children → push contiguously with increasing
  `order`), and in `validateSelectionRules()` (count *eligible groups*, where a
  group with fewer children than `questionsPerGroup` is ineligible).
- `usedIds` dedupe extends to group ids so the same DI set can't land in two sections.
- `AssessmentQuestion.groupId?`.

**Exam UI**
- `QuestionRenderer.tsx` — split pane: stimulus left/top, question right/bottom,
  independently scrollable. Mobile: collapsible stimulus drawer. **The report never
  mentions this and it is the single largest UX cost in Phase 1.**
- `QuestionNavigator.tsx` — chips need group banding ("Passage 1 · Q4–8"), or a
  student can't tell which questions share a passage.
- `ExamShell.tsx` — hold a `groupMap` beside `questionMap`, both from the one
  `getExamQuestions` call.

**Authoring UI**
- `QuestionTypeEngine.tsx` — a group-authoring mode: stimulus editor (reuse
  `RichText` + `ImageUploader` + `MathToolbar`) plus a child list that reuses the
  existing per-engine editors verbatim.
- `bulkUploadParser.ts` — a `Groups` sheet, plus a `groupRef` column on the
  existing MCQ/Text/Match sheets to attach children. `ExportModal.tsx` mirrors it.
- `QuestionPickerModal.tsx` — groups appear as a **single expandable row**;
  picking one child of an RC set in isolation is almost always an error.

### 3.4 Two constraints that must be decided before building

**Linear / adaptive delivery.** `submitAnswerAndAdvance` serves one question at a
time and never returns. A student would see the passage on Q1 and lose it on Q2.
For v1: **reject group rules in linear/adaptive sections at publish-time
validation.** (Later option: serve the whole group at once and lock it as a unit.)

**Per-question timers.** `questionTimeLimit` is incoherent against a shared
passage — the first question of an RC set carries the reading cost. Either exclude
group sections from per-question timing, or apply the limit to the group as a
whole. Decide now; it changes the section schema either way.

---

## 4 · Phase 2 — Coding problems

**A new engine, not a block type.** `engine: 'code'`.

### 4.1 Changes

- **`QuestionEngine`** → `'mcq' | 'text' | 'match' | 'code'`.
- **`Question`** gains `codeSpec`: allowed languages, per-language starter code,
  time/memory limits, **sample** I/O (visible).
- **`questionAnswers`** gains `testCases` — hidden tests are answer-key material
  and belong in the collection students can never read. Putting them on the
  question doc would leak the entire test suite through the exam payload.
- **`AttemptAnswer.type`** union gains `'code'`, value `{ language, source }`.
- **`sanitizeQuestionForStudent`** must expose `codeSpec` *minus* hidden tests.
- `QuestionNavigator.isAnswered` needs a `code` branch.
- Bulk upload gets a `Code` sheet; export mirrors.

### 4.2 Grading — the seam already exists

Judge execution is asynchronous and untrusted; `gradeAttempt` computes everything
inline and returns. Do not try to run a judge inside it.

The codebase already has the right shape: `requiresManualReview` +
`passed: boolean | null` (`index.ts:3805`, `3957`) exist precisely so a paper with
unmarked essay questions isn't falsely reported as failed. **Code questions reuse
that state**: mark pending at grade time, run the judge asynchronously, then patch
the result through the existing `regradeAttempts` path. The third state, the
provisional-grade collection, and the server-side regrade are all already built.

Scoring: partial credit = `passRate × marks`. Negative marking is meaningless for
code — either add a `code` branch to `resolveGradingPolicy` or reject negative
marking on coding sections at validation time. Pick one explicitly; silent
inheritance would deduct marks for a failing test case.

### 4.3 Judge and editor

- **Don't build a judge.** Self-host an isolated runner (Judge0 / Piston) in a
  locked-down container, called *from a Cloud Function* with the source. Never
  from the client — the client is the party being tested.
- **Editor bundle cost.** Monaco is heavy. The repo already lazy-loads `xlsx`
  (~142 KB gzip) for exactly this reason; the code editor must follow the same
  discipline, and CodeMirror 6 is the lighter option.
- **Circuit-break the judge** (the report's §18 is right here): a judge outage
  must fail the *coding section's grading*, not block exam assembly or submission.

---

## 5 · Phase 3 — Games

This is the largest mismatch with the current model, and it should be entered with
eyes open. A cognitive game has no stem, no options, no single correct answer, and
its score is a computed metric (span, reaction time, accuracy) rather than a
comparison against a key.

**Two honest options:**

- **(A) `engine: 'game'`** — `AttemptAnswer.value` is a telemetry blob; marks come
  from a per-game scoring function. Fits the existing pipeline; a game can sit
  inside a mixed paper.
- **(B) A separate assessment *type*** — a "game battery" outside the
  question/section model, sharing only the attempt, security and proctoring shell.

**Recommend (A)** if games must appear inside ordinary exams, **(B)** if they're
always standalone batteries. (A) is more work but is the only one that composes.

### 5.1 The integrity problem — state it plainly

**A client-computed game score is forgeable.** This platform's entire integrity
stack — SEB config keys, camera monitoring, extension scanning, server-authoritative
timing, answer keys held in a separate collection, students denied direct reads —
exists because the client is not trusted. A game that posts `{ span: 9 }` and is
believed undoes that in one field.

Mitigation, non-optional: **submit the full event trace, recompute the score
server-side, and reject traces that are physically implausible** (inter-response
intervals below human reaction floor, timestamps inconsistent with the server
clock, impossible monotone improvement). Budget for this — it is the majority of
the real work in Phase 3, and the part most likely to be skipped.

### 5.2 What games break

Each needs an explicit decision, not a default:

- `shuffleQuestions` — a game isn't shuffleable against questions.
- Per-question and per-section timers — games carry their own internal clock.
- Negative marking — meaningless.
- Review mode — "show the correct answer" has no referent.
- `resultsExport.ts` — game metrics aren't a marks column.
- `QuestionNavigator` answered-detection — a game is complete or abandoned, not answered.

---

## 6 · Sequencing

The report's 18-sprint roadmap mostly describes work that has already shipped.
Rescaled against the real codebase:

| Stage | Work | Notes |
|---|---|---|
| **0** | Rule union (§2) + `AssessmentQuestion.groupId` + fixed-question-ids | Enabling change. Additive, no migration. Small. |
| **1a** | `questionGroups` collection, rules, indexes, CRUD, callables | Backend only; nothing student-facing yet. |
| **1b** | `GroupRule` resolution + validation + **group-aware shuffle** | The shuffle is the correctness-critical piece. |
| **1c** | Group authoring UI + picker + bulk upload/export | Largest UI surface in Phase 1. |
| **1d** | Split-pane renderer + navigator banding + `ExamShell` group map | Ship 1b–1d together; each is useless alone. |
| **2a** | `code` engine, `codeSpec`, hidden tests in `questionAnswers`, sanitizer | |
| **2b** | Judge service + async grading via the `requiresManualReview` seam | |
| **2c** | In-exam editor (lazy-loaded), SEB interaction | |
| **3a** | Decide (A) vs (B); server-side score recomputation + trace validation | Do the integrity work *first*, not last. |
| **3b** | Game runtime, results/export integration | |

Phase 1 is genuinely additive and can ship without touching a single existing code
path's behavior. Phases 2 and 3 both add engines, and every engine addition touches
the same seven places — authoring UI, renderer, sanitizer whitelist, grading switch,
`AttemptAnswer` union, navigator, bulk upload. **Write that checklist down once and
apply it twice**; the failure mode is adding an engine and forgetting the whitelist,
which fails silently as an empty question card in a live exam.

---

## 7 · Risks specific to this codebase

| Risk | Why it bites here | Mitigation |
|---|---|---|
| Group split by `shuffleQuestions` | The existing shuffle is per-question and unaware of grouping | Group-aware shuffle in `startExam`, covered by a test |
| Group questions in linear/adaptive sections | Passage served once, unreachable afterwards | Reject at publish-time validation in v1 |
| New engine missing from `sanitizeQuestionForStudent` | Fails silently — blank card mid-exam, no error | Engine-addition checklist; a test asserting every engine's required fields survive the whitelist |
| Hidden test cases on the question doc | Whole test suite ships to the client with the paper | Test cases live in `questionAnswers`, same as every other key |
| Client-computed game scores | Defeats the entire integrity stack | Server-side recomputation from a full event trace |
| Group deletion orphaning children | `deletionImpact` doesn't know about groups | Extend impact analysis before shipping group CRUD |
| Rebuilding scoring/RBAC per the report | Duplicates working, audited systems | Extend `gradingConfig` and `assertQuestionRight`; don't parallel them |

---

## 8 · Open decisions

These need an answer before Phase 1 code starts; each changes the schema:

1. **Per-question timers on group sections** — exclude, or apply to the group?
2. **Group difficulty** — does the group carry it (used for selection), or is it
   derived from children? *(Recommended: the group carries it; children may vary.)*
3. **`questionsPerGroup` < children** — allowed (draw a subset) or all-or-nothing?
   *(Recommended: allow the subset; it's what Remindo's "3 of 8" does, and it's
   the cheapest exposure control available without a usage counter.)*
4. **DI tables** — structural (`table.headers/rows`, accessible, responsive) or
   image-only (faster to build, unusable on mobile, unreadable to screen readers)?
   *(Recommended: structural, with image as a fallback format.)*
5. **Games** — inside mixed papers (A) or standalone batteries (B)?
