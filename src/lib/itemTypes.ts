// ══════════════════════════════════════════════════════════════════
// ASSESSMENT ITEM TYPES — the platform's canonical taxonomy
// ══════════════════════════════════════════════════════════════════
//
// One list, in one file, of every kind of assessment item Exam Forge either
// delivers today or has committed to delivering. Nothing here changes how a
// question is stored, selected, rendered or graded — this module is a
// *registry*: names, categories, badges and the binding from a taxonomy entry
// to the engine that actually implements it.
//
// WHY IT EXISTS
//
// The item vocabulary was previously spread across four places that had no
// idea about each other: the `TYPE_OPTIONS` array in the authoring drawer, the
// `questionTypeLabel`/`questionTypeBadge` if-ladders in questionBankService,
// `GROUP_KIND_LABEL` for grouped sets, and the type-filter dropdowns rebuilt
// by hand on three separate question-bank pages. Adding an item type meant
// finding all four; renaming one meant the bank filter silently stopped
// matching the badge it was filtering on. This registry is the single source
// those surfaces now read from.
//
// It also records the types that are NOT built yet. That is deliberate. The
// difference between "MCQ" and "Hotspot" is not that one is a real idea and
// the other isn't — it is that one has an engine behind it and the other has
// only a name. Writing both down, with the difference made explicit and
// unfakeable (see LIVE below), is what stops a planned type from being quietly
// half-wired into a picker and shown to faculty as if it worked.
//
// ── THE ONE RULE ──────────────────────────────────────────────────
//
// A type is LIVE if and only if it appears in one of the binding tables in
// §3 — that is, if a real `QuestionEngine`/`QuestionVariant` pair or a real
// `GroupKind` resolves to it. `itemTypeStatus()` derives liveness from those
// tables and nothing else; there is no hand-written `status: 'live'` field
// anyone can set. A def therefore cannot claim to work when no engine backs
// it, which is the failure this whole file is built to prevent.
//
// The binding tables are `Record<>`s over the engine unions, so they are
// exhaustive: add a variant to `MCQVariant` or a kind to `GroupKind` and the
// compiler refuses to build until the new one is mapped to a taxonomy entry.
//
// ── IMPORT DIRECTION ──────────────────────────────────────────────
//
// This module imports TYPES ONLY from questionBankService (erased at build,
// so no runtime cycle) and questionBankService imports VALUES from here. Keep
// it that way — a value import in this direction creates a cycle that Vite
// resolves to `undefined` at module-init time, which surfaces as a blank
// question bank rather than as an error.

import type {
  GroupKind,
  MCQVariant,
  QuestionEngine,
  QuestionVariant,
  TextVariant,
} from './questionBankService';

// ══════════════════════════════════════════════════════════════════
// 1 · CATEGORIES
// ══════════════════════════════════════════════════════════════════

export type ItemCategory =
  | 'objective'
  | 'subjective'
  | 'grouped'
  | 'coding'
  | 'game'
  | 'multimedia'
  | 'practical'
  | 'future';

/** Display order — used verbatim by every picker and filter. */
export const ITEM_CATEGORIES: ItemCategory[] = [
  'objective',
  'subjective',
  'grouped',
  'coding',
  'game',
  'multimedia',
  'practical',
  'future',
];

export const ITEM_CATEGORY_LABEL: Record<ItemCategory, string> = {
  objective:  'Objective',
  subjective: 'Subjective',
  grouped:    'Grouped Item',
  coding:     'Coding',
  game:       'Cognitive Game',
  multimedia: 'Multimedia',
  practical:  'Practical',
  future:     'Future',
};

export const ITEM_CATEGORY_SUMMARY: Record<ItemCategory, string> = {
  objective:  'Machine-scorable items with a fixed key.',
  subjective: 'Written responses a human grades against a model answer or rubric.',
  grouped:    'A shared stimulus with dependent sub-questions.',
  coding:     'Code or query written and executed against test cases.',
  game:       'Timed cognitive tasks scored on speed and accuracy, not subject knowledge.',
  multimedia: 'Recorded or drawn responses — audio, video, annotation, whiteboard.',
  practical:  'Task-based work inside a simulated tool or environment.',
  future:     'Named directions with no design behind them yet.',
};

// ══════════════════════════════════════════════════════════════════
// 2 · THE REGISTRY
// ══════════════════════════════════════════════════════════════════

/**
 * How a response turns into marks.
 *
 *   'auto'   — scored on the server from the answer key, no human involved.
 *   'manual' — a grader awards the marks; the attempt finalises with
 *              `requiresManualReview` set (see gradeAttempt).
 *   'hybrid' — an automatic component plus a human component (test cases pass,
 *              then a reviewer judges approach; a game's raw score mapped onto
 *              a marks band).
 */
export type ItemScoring = 'auto' | 'manual' | 'hybrid';

type ItemTypeSpec = {
  category: ItemCategory;
  /** Full name, as it appears in the taxonomy and in pickers. */
  label: string;
  /** Short chip label. Kept ≤ 6 characters where possible. */
  badge: string;
  scoring: ItemScoring;
  /** One line: what the candidate actually does. */
  summary: string;
  /**
   * The rollout track this type sits on. Present ⇒ designed and committed,
   * absent ⇒ named only. Ignored entirely for live types, whose status comes
   * from the binding tables. See PLATFORM_EXTENSION_PLAN.md for the phase
   * numbering and ASSESSMENT_ITEM_TYPES.md for the per-type change lists.
   */
  phase?: string;
  /**
   * For a type that isn't live but has a usable stand-in today — the honest
   * answer to "so what do I do right now?". Surfaced in the authoring picker
   * so faculty aren't left guessing.
   */
  today?: string;
};

/**
 * Every item type, keyed by its stable id.
 *
 * The KEY is the id — `ItemTypeId` is derived from this object, so the union
 * and the registry cannot drift apart. Ids are permanent: they are what any
 * future per-type config, analytics dimension or blueprint rule will store, so
 * rename the `label` freely and never the key.
 *
 * Insertion order is display order within a category.
 */
const ITEM_TYPE_SPECS = {
  // ── Objective ───────────────────────────────────────────────────
  //
  // MCQ is ONE type in two forms, not two types. Both are multiple-choice
  // questions; they differ in how many options are correct, and the interface
  // has to say which form the candidate is looking at before they answer —
  // single renders round radio indicators, multiple renders square checkboxes
  // and states outright that more than one option is correct. A candidate who
  // picks one answer to a multiple-correct question because nothing told them
  // otherwise has been failed by the interface, not by their knowledge.
  'mcq-single': {
    category: 'objective',
    label: 'MCQ — Single Correct',
    badge: 'MCQ',
    scoring: 'auto',
    summary: 'Exactly one option is correct. Shown as radio buttons.',
  },
  'mcq-multi': {
    category: 'objective',
    label: 'MCQ — Multiple Correct',
    badge: 'Multi',
    scoring: 'auto',
    summary: 'More than one option is correct. Shown as checkboxes, labelled as such, and given partial credit.',
  },
  'true-false': {
    category: 'objective',
    label: 'True / False',
    badge: 'T/F',
    scoring: 'auto',
    summary: 'Binary choice against a statement.',
  },
  'match-the-following': {
    category: 'objective',
    label: 'Match the Following',
    badge: 'Match',
    scoring: 'auto',
    summary: 'Pair each item in the left column with one on the right.',
  },
  'sequence': {
    category: 'objective',
    label: 'Sequence / Ordering',
    badge: 'Seq',
    scoring: 'auto',
    summary: 'Arrange items into the correct order.',
    phase: 'Objective engine track',
    today: 'Approximate with an MCQ whose options are candidate orderings.',
  },
  'fill-blank': {
    category: 'objective',
    label: 'Fill in the Blank',
    badge: 'Fill',
    scoring: 'auto',
    summary: 'Choose what belongs in the ___ marked in the stem.',
  },
  'numeric': {
    category: 'objective',
    label: 'Numeric Answer',
    badge: 'Num',
    scoring: 'auto',
    summary: 'Type a number, matched against a value with a tolerance range.',
    phase: 'Objective engine track',
    today: 'Use Short Answer and grade it by hand, or an MCQ over candidate values.',
  },
  'hotspot': {
    category: 'objective',
    label: 'Hotspot',
    badge: 'Spot',
    scoring: 'auto',
    summary: 'Click the correct region of an image.',
    phase: 'Objective engine track',
  },
  'drag-drop': {
    category: 'objective',
    label: 'Drag & Drop',
    badge: 'Drag',
    scoring: 'auto',
    summary: 'Drag items into labelled targets or zones.',
    phase: 'Objective engine track',
  },
  'matrix-grid': {
    category: 'objective',
    label: 'Matrix / Grid',
    badge: 'Grid',
    scoring: 'auto',
    summary: 'Answer a grid of related prompts sharing one option set.',
    phase: 'Objective engine track',
    today: 'Author each row as its own MCQ inside a grouped set.',
  },

  // ── Subjective ──────────────────────────────────────────────────
  'short-answer': {
    category: 'subjective',
    label: 'Short Answer',
    badge: 'Short',
    scoring: 'manual',
    summary: 'A brief written response — a line or two.',
  },
  'long-answer': {
    category: 'subjective',
    label: 'Long Answer',
    badge: 'Long',
    scoring: 'manual',
    summary: 'An extended written or analytical response.',
  },
  'essay': {
    category: 'subjective',
    label: 'Essay',
    badge: 'Essay',
    scoring: 'manual',
    summary: 'A structured composition scored against a rubric, with a word target.',
    phase: 'Subjective engine track',
    today: 'Use Long Answer — it has no word counter or rubric grid yet.',
  },
  'case-analysis': {
    category: 'subjective',
    label: 'Case Analysis',
    badge: 'Case',
    scoring: 'manual',
    summary: 'A written analysis of a supplied case, scored on named criteria.',
    phase: 'Subjective engine track',
    today: 'Put a Long Answer child under a Caselet set.',
  },
  'file-upload': {
    category: 'subjective',
    label: 'File Upload',
    badge: 'File',
    scoring: 'manual',
    summary: 'Submit a document or artefact as the answer.',
    phase: 'Subjective engine track',
  },

  // ── Grouped Item ────────────────────────────────────────────────
  'reading-comprehension': {
    category: 'grouped',
    label: 'Reading Comprehension',
    badge: 'RC',
    scoring: 'auto',
    summary: 'A passage with dependent sub-questions.',
  },
  'data-interpretation': {
    category: 'grouped',
    label: 'Data Interpretation',
    badge: 'DI',
    scoring: 'auto',
    summary: 'A table or chart with dependent sub-questions.',
  },
  'seating-arrangement': {
    category: 'grouped',
    label: 'Seating Arrangement',
    badge: 'Seat',
    scoring: 'auto',
    summary: 'Positional constraints with dependent sub-questions.',
  },
  'blood-relation': {
    category: 'grouped',
    label: 'Blood Relation',
    badge: 'Rel',
    scoring: 'auto',
    summary: 'A family-tree premise with dependent sub-questions.',
    phase: 'Grouped kinds — additive',
    today: 'Author it as a Multi-question Passage; only the filter label differs.',
  },
  'puzzle': {
    category: 'grouped',
    label: 'Puzzle',
    badge: 'Puzzle',
    scoring: 'auto',
    summary: 'A logical puzzle with dependent sub-questions.',
  },
  'caselet': {
    category: 'grouped',
    label: 'Caselet',
    badge: 'Caselet',
    scoring: 'auto',
    summary: 'A short prose case with dependent sub-questions.',
  },
  'logical-set': {
    category: 'grouped',
    label: 'Logical Set',
    badge: 'Logic',
    scoring: 'auto',
    summary: 'A shared set of logical conditions with dependent sub-questions.',
    phase: 'Grouped kinds — additive',
    today: 'Author it as a Multi-question Passage; only the filter label differs.',
  },
  'multi-question-passage': {
    category: 'grouped',
    label: 'Multi-question Passage',
    badge: 'Set',
    scoring: 'auto',
    summary: 'Any other stimulus shared by several sub-questions.',
  },

  // ── Coding ──────────────────────────────────────────────────────
  'coding-challenge': {
    category: 'coding',
    label: 'Coding Challenge',
    badge: 'Code',
    scoring: 'hybrid',
    summary: 'Write a program judged against hidden and visible test cases.',
    phase: 'Extension Phase 2 — Coding',
  },
  'sql-challenge': {
    category: 'coding',
    label: 'SQL Challenge',
    badge: 'SQL',
    scoring: 'hybrid',
    summary: 'Write a query judged on the result set it returns.',
    phase: 'Extension Phase 2 — Coding',
  },
  'debugging': {
    category: 'coding',
    label: 'Debugging',
    badge: 'Debug',
    scoring: 'hybrid',
    summary: 'Fix broken code until the supplied tests pass.',
    phase: 'Extension Phase 2 — Coding',
  },
  'output-prediction': {
    category: 'coding',
    label: 'Output Prediction',
    badge: 'Output',
    scoring: 'auto',
    summary: 'State what a given program prints.',
    phase: 'Extension Phase 2 — Coding',
    today: 'Author it as an MCQ or Short Answer with the snippet in the stem.',
  },
  'code-review': {
    category: 'coding',
    label: 'Code Review',
    badge: 'Review',
    scoring: 'manual',
    summary: 'Critique a diff or snippet — correctness, style, risk.',
    phase: 'Extension Phase 2 — Coding',
    today: 'Author it as a Long Answer with the snippet in the stem.',
  },

  // ── Cognitive Game ──────────────────────────────────────────────
  'game-memory': {
    category: 'game',
    label: 'Memory',
    badge: 'Mem',
    scoring: 'hybrid',
    summary: 'Recall sequences or positions after a delay.',
    phase: 'Extension Phase 3 — Games',
  },
  'game-attention': {
    category: 'game',
    label: 'Attention',
    badge: 'Attn',
    scoring: 'hybrid',
    summary: 'Sustain focus on a target signal among distractors.',
    phase: 'Extension Phase 3 — Games',
  },
  'game-reaction': {
    category: 'game',
    label: 'Reaction',
    badge: 'React',
    scoring: 'hybrid',
    summary: 'Respond to a stimulus as fast as accuracy allows.',
    phase: 'Extension Phase 3 — Games',
  },
  'game-logical-pattern': {
    category: 'game',
    label: 'Logical Pattern',
    badge: 'Pattern',
    scoring: 'hybrid',
    summary: 'Infer and continue a rule from examples, under time pressure.',
    phase: 'Extension Phase 3 — Games',
  },
  'game-spatial': {
    category: 'game',
    label: 'Spatial Ability',
    badge: 'Spatial',
    scoring: 'hybrid',
    summary: 'Rotate, fold or navigate shapes mentally.',
    phase: 'Extension Phase 3 — Games',
  },
  'game-multitasking': {
    category: 'game',
    label: 'Multitasking',
    badge: 'Multi-T',
    scoring: 'hybrid',
    summary: 'Hold two or more concurrent tasks without dropping either.',
    phase: 'Extension Phase 3 — Games',
  },
  'game-processing-speed': {
    category: 'game',
    label: 'Processing Speed',
    badge: 'Speed',
    scoring: 'hybrid',
    summary: 'Work through simple comparisons at volume against the clock.',
    phase: 'Extension Phase 3 — Games',
  },
  'game-decision-making': {
    category: 'game',
    label: 'Decision Making',
    badge: 'Decide',
    scoring: 'hybrid',
    summary: 'Choose under uncertainty, trading speed against payoff.',
    phase: 'Extension Phase 3 — Games',
  },

  // ── Multimedia ──────────────────────────────────────────────────
  'audio-response': {
    category: 'multimedia',
    label: 'Audio Response',
    badge: 'Audio',
    scoring: 'manual',
    summary: 'Record a spoken answer.',
    phase: 'Multimedia track',
  },
  'video-response': {
    category: 'multimedia',
    label: 'Video Response',
    badge: 'Video',
    scoring: 'manual',
    summary: 'Record a video answer to a prompt.',
    phase: 'Multimedia track',
  },
  'image-annotation': {
    category: 'multimedia',
    label: 'Image Annotation',
    badge: 'Annot',
    scoring: 'manual',
    summary: 'Mark up an image and label what was found.',
    phase: 'Multimedia track',
  },
  'speech-recording': {
    category: 'multimedia',
    label: 'Speech Recording',
    badge: 'Speech',
    scoring: 'hybrid',
    summary: 'Read or speak to a prompt, scored on fluency and accuracy.',
    phase: 'Multimedia track',
  },
  'whiteboard': {
    category: 'multimedia',
    label: 'Whiteboard',
    badge: 'Board',
    scoring: 'manual',
    summary: 'Draw or work out the answer on a canvas.',
    phase: 'Multimedia track',
  },

  // ── Practical ───────────────────────────────────────────────────
  'simulation': {
    category: 'practical',
    label: 'Simulation',
    badge: 'Sim',
    scoring: 'hybrid',
    summary: 'Operate a simulated system and reach a target state.',
    phase: 'Practical track',
  },
  'virtual-lab': {
    category: 'practical',
    label: 'Virtual Lab',
    badge: 'Lab',
    scoring: 'hybrid',
    summary: 'Run a procedure in a virtual laboratory and report results.',
    phase: 'Practical track',
  },
  'spreadsheet-exercise': {
    category: 'practical',
    label: 'Spreadsheet Exercise',
    badge: 'Sheet',
    scoring: 'hybrid',
    summary: 'Build formulas or a model in a spreadsheet against a brief.',
    phase: 'Practical track',
  },
  'design-exercise': {
    category: 'practical',
    label: 'Design Exercise',
    badge: 'Design',
    scoring: 'manual',
    summary: 'Produce a design artefact to a brief.',
    phase: 'Practical track',
  },
  'workflow-task': {
    category: 'practical',
    label: 'Workflow Task',
    badge: 'Flow',
    scoring: 'hybrid',
    summary: 'Complete a multi-step process in a tool, judged on the trail left behind.',
    phase: 'Practical track',
  },

  // ── Future ──────────────────────────────────────────────────────
  // No `phase` on any of these, and that is the point: they are directions,
  // not commitments. `itemTypeStatus()` reports them as 'future' precisely
  // because nothing here has a design yet.
  'ai-interview': {
    category: 'future',
    label: 'AI Interview',
    badge: 'AI-Int',
    scoring: 'hybrid',
    summary: 'A conversational interview conducted and scored by a model.',
  },
  'live-interview': {
    category: 'future',
    label: 'Live Interview',
    badge: 'Live',
    scoring: 'manual',
    summary: 'A scheduled human interview scored inside the platform.',
  },
  'external-assessment': {
    category: 'future',
    label: 'External Assessment',
    badge: 'Ext',
    scoring: 'hybrid',
    summary: 'A third-party assessment launched and scored back into a result.',
  },
  'psychometric-inventory': {
    category: 'future',
    label: 'Psychometric Inventory',
    badge: 'Psych',
    scoring: 'auto',
    summary: 'A trait inventory producing a profile rather than a mark.',
  },
  'adaptive-item': {
    category: 'future',
    label: 'Adaptive Item',
    badge: 'Adapt',
    scoring: 'auto',
    summary: 'An item served by difficulty targeting off the running ability estimate.',
  },
} as const satisfies Record<string, ItemTypeSpec>;

/**
 * Stable identifier for an item type.
 *
 * Derived from the registry rather than declared beside it — a def with no id,
 * or an id with no def, is not expressible.
 */
export type ItemTypeId = keyof typeof ITEM_TYPE_SPECS;

export type ItemTypeDef = ItemTypeSpec & { id: ItemTypeId };

export const ITEM_TYPE_IDS = Object.keys(ITEM_TYPE_SPECS) as ItemTypeId[];

export const ITEM_TYPE_BY_ID: Record<ItemTypeId, ItemTypeDef> = Object.fromEntries(
  ITEM_TYPE_IDS.map((id) => [id, { ...ITEM_TYPE_SPECS[id], id }]),
) as Record<ItemTypeId, ItemTypeDef>;

/** Every type, in taxonomy order (category by category). */
export const ITEM_TYPES: ItemTypeDef[] = ITEM_TYPE_IDS.map((id) => ITEM_TYPE_BY_ID[id]);

// ══════════════════════════════════════════════════════════════════
// 3 · BINDINGS — what is actually implemented
// ══════════════════════════════════════════════════════════════════
//
// These four tables ARE the definition of "live". Every entry is a promise
// that the full path exists for that type: authoring editor, preview, student
// renderer, answered-detection, answer-key storage, server sanitiser, grading
// branch, bulk upload and export. Do not add a row here in advance of that
// path — a row here is what makes the type selectable in the authoring drawer.
//
// The Records are exhaustive over the engine unions, so extending
// `MCQVariant`, `TextVariant` or `GroupKind` is a compile error until the new
// member names the taxonomy entry it satisfies.

export const ITEM_TYPE_FOR_MCQ_VARIANT: Record<MCQVariant, ItemTypeId> = {
  single:    'mcq-single',
  multi:     'mcq-multi',
  truefalse: 'true-false',
  fillblank: 'fill-blank',
};

export const ITEM_TYPE_FOR_TEXT_VARIANT: Record<TextVariant, ItemTypeId> = {
  short: 'short-answer',
  long:  'long-answer',
};

/** The match engine has no variants — one engine, one taxonomy entry. */
export const ITEM_TYPE_FOR_MATCH: ItemTypeId = 'match-the-following';

/**
 * Grouped sets bind by `GroupKind`, not by engine: a group's CHILDREN are
 * ordinary mcq/text/match questions, and the taxonomy entry describes the set
 * they hang off. `generic` — the catch-all kind — is exactly what the taxonomy
 * calls a Multi-question Passage, so that is where it maps. Blood Relation and
 * Logical Set are authored as `generic` today and get their own kinds when the
 * grouped-kinds work lands; until then they stay non-live rather than aliasing
 * onto `generic`, which would make three taxonomy entries resolve to one kind
 * and break the round trip back out.
 */
export const ITEM_TYPE_FOR_GROUP_KIND: Record<GroupKind, ItemTypeId> = {
  rc:      'reading-comprehension',
  di:      'data-interpretation',
  seating: 'seating-arrangement',
  puzzle:  'puzzle',
  caselet: 'caselet',
  generic: 'multi-question-passage',
};

/** How a live taxonomy entry is reached in storage. */
export type ItemTypeBinding =
  | { surface: 'question'; engine: QuestionEngine; variant: QuestionVariant }
  | { surface: 'group'; groupKind: GroupKind };

/** Inverted binding tables — built once, at module load. */
const BINDING_BY_ID: Partial<Record<ItemTypeId, ItemTypeBinding>> = (() => {
  const out: Partial<Record<ItemTypeId, ItemTypeBinding>> = {};
  for (const [variant, id] of Object.entries(ITEM_TYPE_FOR_MCQ_VARIANT)) {
    out[id] = { surface: 'question', engine: 'mcq', variant: variant as MCQVariant };
  }
  for (const [variant, id] of Object.entries(ITEM_TYPE_FOR_TEXT_VARIANT)) {
    out[id] = { surface: 'question', engine: 'text', variant: variant as TextVariant };
  }
  out[ITEM_TYPE_FOR_MATCH] = { surface: 'question', engine: 'match', variant: null };
  for (const [kind, id] of Object.entries(ITEM_TYPE_FOR_GROUP_KIND)) {
    out[id] = { surface: 'group', groupKind: kind as GroupKind };
  }
  return out;
})();

const LIVE_ITEM_TYPE_IDS: ReadonlySet<ItemTypeId> = new Set(
  Object.keys(BINDING_BY_ID) as ItemTypeId[],
);

// ══════════════════════════════════════════════════════════════════
// 4 · STATUS
// ══════════════════════════════════════════════════════════════════

/**
 * 'live'    — an engine backs it; authorable, deliverable and gradable today.
 * 'planned' — designed and on a named track, not built.
 * 'future'  — named only.
 */
export type ItemTypeStatus = 'live' | 'planned' | 'future';

export const ITEM_STATUS_LABEL: Record<ItemTypeStatus, string> = {
  live:    'Available',
  planned: 'Planned',
  future:  'Future',
};

/**
 * Derived, never declared. Liveness comes from the binding tables and the
 * planned/future split from whether a track was named — so a type cannot be
 * advertised as working, or as scheduled, by editing a label.
 */
export function itemTypeStatus(id: ItemTypeId): ItemTypeStatus {
  if (LIVE_ITEM_TYPE_IDS.has(id)) return 'live';
  return ITEM_TYPE_BY_ID[id].phase ? 'planned' : 'future';
}

export function isItemTypeLive(id: ItemTypeId): boolean {
  return LIVE_ITEM_TYPE_IDS.has(id);
}

/** Where a live type lives in storage; null for everything not yet built. */
export function itemTypeBinding(id: ItemTypeId): ItemTypeBinding | null {
  return BINDING_BY_ID[id] ?? null;
}

// ══════════════════════════════════════════════════════════════════
// 5 · RESOLVERS — storage shape → taxonomy entry
// ══════════════════════════════════════════════════════════════════

/**
 * The taxonomy entry for a stored question.
 *
 * Returns null for a shape the registry doesn't know — an engine/variant
 * combination written by a future version of the app, or a corrupt document.
 * Callers must handle null rather than assume: the question bank renders
 * legacy and unknown rows side by side, and a throw here would take the whole
 * list down with it.
 */
export function itemTypeIdForQuestion(
  engine: QuestionEngine,
  variant: QuestionVariant,
): ItemTypeId | null {
  if (engine === 'mcq') {
    return variant && variant in ITEM_TYPE_FOR_MCQ_VARIANT
      ? ITEM_TYPE_FOR_MCQ_VARIANT[variant as MCQVariant]
      : null;
  }
  if (engine === 'text') {
    return variant && variant in ITEM_TYPE_FOR_TEXT_VARIANT
      ? ITEM_TYPE_FOR_TEXT_VARIANT[variant as TextVariant]
      : null;
  }
  if (engine === 'match') return ITEM_TYPE_FOR_MATCH;
  return null;
}

export function itemTypeForQuestion(
  engine: QuestionEngine,
  variant: QuestionVariant,
): ItemTypeDef | null {
  const id = itemTypeIdForQuestion(engine, variant);
  return id ? ITEM_TYPE_BY_ID[id] : null;
}

export function itemTypeIdForGroupKind(kind: GroupKind): ItemTypeId {
  return ITEM_TYPE_FOR_GROUP_KIND[kind];
}

export function itemTypeForGroupKind(kind: GroupKind): ItemTypeDef {
  return ITEM_TYPE_BY_ID[ITEM_TYPE_FOR_GROUP_KIND[kind]];
}

// ══════════════════════════════════════════════════════════════════
// 6 · SELECTORS
// ══════════════════════════════════════════════════════════════════

export function itemTypesInCategory(category: ItemCategory): ItemTypeDef[] {
  return ITEM_TYPES.filter((t) => t.category === category);
}

export function itemTypesWithStatus(status: ItemTypeStatus): ItemTypeDef[] {
  return ITEM_TYPES.filter((t) => itemTypeStatus(t.id) === status);
}

/** Everything authorable today, in taxonomy order. */
export function liveItemTypes(): ItemTypeDef[] {
  return ITEM_TYPES.filter((t) => isItemTypeLive(t.id));
}

/** Live standalone question types — what the authoring drawer can build. */
export function liveQuestionItemTypes(): Array<{
  def: ItemTypeDef;
  engine: QuestionEngine;
  variant: QuestionVariant;
}> {
  const out: Array<{ def: ItemTypeDef; engine: QuestionEngine; variant: QuestionVariant }> = [];
  for (const def of ITEM_TYPES) {
    const binding = itemTypeBinding(def.id);
    if (binding?.surface === 'question') {
      out.push({ def, engine: binding.engine, variant: binding.variant });
    }
  }
  return out;
}

/** Categories that have at least one type, in display order. */
export function populatedCategories(): ItemCategory[] {
  return ITEM_CATEGORIES.filter((c) => itemTypesInCategory(c).length > 0);
}

export function itemTypeLabel(id: ItemTypeId): string {
  return ITEM_TYPE_BY_ID[id].label;
}

export function itemTypeBadge(id: ItemTypeId): string {
  return ITEM_TYPE_BY_ID[id].badge;
}
