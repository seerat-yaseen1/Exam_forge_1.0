/**
 * bulkUploadParser.ts
 *
 * Pure functions that convert a parsed XLSX workbook into structured
 * ParsedRow[] arrays — one per engine. No Firestore or React involved.
 *
 * Validation is split into two passes:
 *   1. parseWorkbook()  — structural / value-level validation (synchronous)
 *   2. resolveSubjects() — subject resolution against registry (async, done in UI layer)
 */

import * as XLSX from 'xlsx';
import { type QuestionDraft } from './QuestionTypeEngine';
import { type Subject, resolveSubject, normalizeSubject } from '../../../lib/subjectService';
import { type Difficulty, type Question, findDuplicateCandidates } from '../../../lib/questionBankService';
import {
  scoreAgainstPool,
  verdictFor,
  pct,
  type DuplicateScore,
} from '../../../lib/duplicateDetection';

// ══════════════════════════════════════════════════════════════════
// OUTPUT TYPES
// ══════════════════════════════════════════════════════════════════

export type RowStatus =
  | 'valid'
  | 'warning'   // has warnings but will still save
  | 'error';    // blocked — will NOT be saved

export type RowWarning = {
  field: string;
  message: string;
};

export type RowError = {
  field: string;
  message: string;
};

export type SubjectResolution =
  | { kind: 'exact' | 'alias' | 'fuzzy'; canonicalName: string; note?: string }
  | { kind: 'new'; canonicalName: string };

export type ParsedRow = {
  /** 1-based row index in the sheet (for error messages). */
  rowIndex: number;
  /** The source sheet this row came from. */
  sheet: 'MCQ' | 'Text' | 'Match';
  /** Parsed draft (populated even with warnings; may be partial on error rows). */
  draft: Partial<QuestionDraft>;
  /** Raw values from the sheet (kept for display). */
  raw: Record<string, string>;
  status: RowStatus;
  errors: RowError[];
  warnings: RowWarning[];
  /** Filled in by resolveSubjectsInRows() — not set by parseWorkbook(). */
  subjectResolution?: SubjectResolution;
  /** Filled in by scoreDuplicatesInRows() — three independent scores + match pointer. */
  duplicateScore?: DuplicateScore;
};

export type ParsedWorkbook = {
  mcq:   ParsedRow[];
  text:  ParsedRow[];
  match: ParsedRow[];
  /** Sheets found in the file that we recognise. */
  sheetsFound: ('MCQ' | 'Text' | 'Match')[];
};

// ══════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ══════════════════════════════════════════════════════════════════

const INSTRUCTION_MARKERS = ['INSTRUCTION', 'EXAMPLE', 'NOTE:', '-- DO NOT'];

function isInstructionRow(raw: Record<string, string>): boolean {
  return Object.values(raw).some((v) =>
    INSTRUCTION_MARKERS.some((m) => v?.toUpperCase().startsWith(m))
  );
}

function cellStr(raw: Record<string, string>, key: string): string {
  return (raw[key] ?? '').toString().trim();
}

function parseDifficulty(raw: string): { difficulty: Difficulty; defaulted: boolean } {
  const v = raw.trim().toLowerCase();
  if (v === 'easy')   return { difficulty: 'easy',   defaulted: false };
  if (v === 'medium') return { difficulty: 'medium', defaulted: false };
  if (v === 'hard')   return { difficulty: 'hard',   defaulted: false };
  return { difficulty: 'medium', defaulted: true };
}

function parseTags(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
}

function isValidUrl(raw: string): boolean {
  if (!raw) return true; // empty is fine
  try { new URL(raw); return raw.startsWith('http://') || raw.startsWith('https://'); }
  catch { return false; }
}

function newOptId(letter: string): string {
  return `opt_${letter}`;
}

// ══════════════════════════════════════════════════════════════════
// MCQ PARSER
// ══════════════════════════════════════════════════════════════════

const MCQ_TYPES = ['single', 'multi', 'truefalse', 'fillblank'];
const OPT_LETTERS = ['a', 'b', 'c', 'd', 'e'];

function parseMCQRow(raw: Record<string, string>, rowIndex: number): ParsedRow {
  const errors:   RowError[]   = [];
  const warnings: RowWarning[] = [];

  // type
  const typeRaw = cellStr(raw, 'type').toLowerCase();
  if (!MCQ_TYPES.includes(typeRaw)) {
    errors.push({ field: 'type', message: `Invalid type "${cellStr(raw, 'type')}". Must be: single, multi, truefalse, fillblank.` });
  }
  const variant = MCQ_TYPES.includes(typeRaw) ? typeRaw as any : null;
  const isTF = variant === 'truefalse';

  // stem
  const stem = cellStr(raw, 'stem');
  if (!stem) errors.push({ field: 'stem', message: 'Question stem is required.' });

  // stem image
  const stemImageUrl = cellStr(raw, 'stem_image_url');
  if (stemImageUrl && !isValidUrl(stemImageUrl))
    errors.push({ field: 'stem_image_url', message: 'stem_image_url must start with http:// or https://' });

  // options
  let options: { id: string; text: string; image?: string }[] = [];
  if (isTF) {
    options = [
      { id: 'opt_a', text: 'True' },
      { id: 'opt_b', text: 'False' },
    ];
  } else {
    OPT_LETTERS.forEach((l) => {
      const text = cellStr(raw, `option_${l}`);
      if (text) {
        const imgUrl = cellStr(raw, `option_${l}_image_url`);
        if (imgUrl && !isValidUrl(imgUrl))
          errors.push({ field: `option_${l}_image_url`, message: `option_${l}_image_url must start with http:// or https://` });
        options.push({ id: newOptId(l), text, ...(imgUrl ? { image: imgUrl } : {}) });
      }
    });
    if (options.length < 2) {
      errors.push({ field: 'options', message: 'At least 2 options (option_a, option_b) are required.' });
    }
  }

  // correct answer
  const correctRaw = cellStr(raw, 'correct').toUpperCase();
  let correctIds: string[] = [];

  if (isTF) {
    if (correctRaw === 'TRUE')  correctIds = ['opt_a'];
    else if (correctRaw === 'FALSE') correctIds = ['opt_b'];
    else errors.push({ field: 'correct', message: 'For True/False, correct must be "True" or "False".' });
  } else {
    const letters = correctRaw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (letters.length === 0) {
      errors.push({ field: 'correct', message: 'At least one correct answer must be specified.' });
    } else {
      // validate that each referenced letter has an option with text
      letters.forEach((l) => {
        const opt = options.find((o) => o.id === newOptId(l));
        if (!opt) {
          errors.push({ field: 'correct', message: `Correct answer "${l.toUpperCase()}" references an empty or missing option.` });
        } else {
          correctIds.push(opt.id);
        }
      });

      if (variant === 'single' && letters.length > 1) {
        warnings.push({ field: 'correct', message: 'Type is "single" but multiple correct answers are marked — first one will be used.' });
        correctIds = [correctIds[0]];
      }
    }
  }

  // subject + metadata
  const subjectRaw = cellStr(raw, 'subject');
  if (!subjectRaw) errors.push({ field: 'subject', message: 'Subject is required.' });

  const { difficulty, defaulted } = parseDifficulty(cellStr(raw, 'difficulty'));
  if (defaulted && cellStr(raw, 'difficulty')) {
    warnings.push({ field: 'difficulty', message: `Unknown difficulty "${cellStr(raw, 'difficulty')}" — defaulted to "medium".` });
  }

  const draft: Partial<QuestionDraft> = {
    engine: 'mcq',
    variant,
    stem,
    ...(stemImageUrl ? { stemImage: stemImageUrl } : {}),
    options,
    correctIds,
    modelAnswer: '',
    pairs: [],
    correctPairs: [],
    subject: normalizeSubject(subjectRaw || ''),
    topic: cellStr(raw, 'topic'),
    tags: parseTags(cellStr(raw, 'tags')),
    difficulty,
    explanation: cellStr(raw, 'explanation'),
  };

  return {
    rowIndex,
    sheet: 'MCQ',
    draft,
    raw,
    status: errors.length > 0 ? 'error' : warnings.length > 0 ? 'warning' : 'valid',
    errors,
    warnings,
  };
}

// ══════════════════════════════════════════════════════════════════
// TEXT PARSER
// ══════════════════════════════════════════════════════════════════

const TEXT_TYPES = ['short', 'long'];

function parseTextRow(raw: Record<string, string>, rowIndex: number): ParsedRow {
  const errors:   RowError[]   = [];
  const warnings: RowWarning[] = [];

  const typeRaw = cellStr(raw, 'type').toLowerCase();
  if (!TEXT_TYPES.includes(typeRaw))
    errors.push({ field: 'type', message: `Invalid type "${cellStr(raw, 'type')}". Must be: short, long.` });
  const variant = TEXT_TYPES.includes(typeRaw) ? typeRaw as any : 'short';

  const stem = cellStr(raw, 'stem');
  if (!stem) errors.push({ field: 'stem', message: 'Question stem is required.' });

  const stemImageUrl = cellStr(raw, 'stem_image_url');
  if (stemImageUrl && !isValidUrl(stemImageUrl))
    errors.push({ field: 'stem_image_url', message: 'stem_image_url must start with http:// or https://' });

  const subjectRaw = cellStr(raw, 'subject');
  if (!subjectRaw) errors.push({ field: 'subject', message: 'Subject is required.' });

  const { difficulty, defaulted } = parseDifficulty(cellStr(raw, 'difficulty'));
  if (defaulted && cellStr(raw, 'difficulty'))
    warnings.push({ field: 'difficulty', message: `Unknown difficulty "${cellStr(raw, 'difficulty')}" — defaulted to "medium".` });

  const draft: Partial<QuestionDraft> = {
    engine: 'text',
    variant,
    stem,
    ...(stemImageUrl ? { stemImage: stemImageUrl } : {}),
    options: [],
    correctIds: [],
    modelAnswer: cellStr(raw, 'model_answer'),
    pairs: [],
    correctPairs: [],
    subject: normalizeSubject(subjectRaw || ''),
    topic: cellStr(raw, 'topic'),
    tags: parseTags(cellStr(raw, 'tags')),
    difficulty,
    explanation: cellStr(raw, 'explanation'),
  };

  return {
    rowIndex,
    sheet: 'Text',
    draft,
    raw,
    status: errors.length > 0 ? 'error' : warnings.length > 0 ? 'warning' : 'valid',
    errors,
    warnings,
  };
}

// ══════════════════════════════════════════════════════════════════
// MATCH PARSER
// ══════════════════════════════════════════════════════════════════

const MAX_PAIRS = 8;

function parseMatchRow(raw: Record<string, string>, rowIndex: number): ParsedRow {
  const errors:   RowError[]   = [];
  const warnings: RowWarning[] = [];

  const stem = cellStr(raw, 'stem');
  if (!stem) errors.push({ field: 'stem', message: 'Question stem is required.' });

  const stemImageUrl = cellStr(raw, 'stem_image_url');
  if (stemImageUrl && !isValidUrl(stemImageUrl))
    errors.push({ field: 'stem_image_url', message: 'stem_image_url must start with http:// or https://' });

  // Parse pairs
  const pairs: { leftId: string; leftText: string; rightId: string; rightText: string }[] = [];
  const correctPairs: { leftId: string; rightId: string }[] = [];

  for (let i = 1; i <= MAX_PAIRS; i++) {
    const leftText  = cellStr(raw, `pair${i}_a`);
    const rightText = cellStr(raw, `pair${i}_b`);

    if (!leftText && !rightText) continue; // empty pair — skip
    if (leftText && !rightText) {
      errors.push({ field: `pair${i}`, message: `pair${i}_a has text but pair${i}_b is empty.` });
      continue;
    }
    if (!leftText && rightText) {
      errors.push({ field: `pair${i}`, message: `pair${i}_b has text but pair${i}_a is empty.` });
      continue;
    }

    const leftId  = `l${i}`;
    const rightId = `r${i}`;
    pairs.push({ leftId, leftText, rightId, rightText });
    correctPairs.push({ leftId, rightId });
  }

  if (pairs.length < 2) {
    errors.push({ field: 'pairs', message: 'At least 2 complete pairs are required.' });
  }

  const subjectRaw = cellStr(raw, 'subject');
  if (!subjectRaw) errors.push({ field: 'subject', message: 'Subject is required.' });

  const { difficulty, defaulted } = parseDifficulty(cellStr(raw, 'difficulty'));
  if (defaulted && cellStr(raw, 'difficulty'))
    warnings.push({ field: 'difficulty', message: `Unknown difficulty "${cellStr(raw, 'difficulty')}" — defaulted to "medium".` });

  const draft: Partial<QuestionDraft> = {
    engine: 'match',
    variant: null,
    stem,
    ...(stemImageUrl ? { stemImage: stemImageUrl } : {}),
    options: [],
    correctIds: [],
    modelAnswer: '',
    pairs,
    correctPairs,
    subject: normalizeSubject(subjectRaw || ''),
    topic: cellStr(raw, 'topic'),
    tags: parseTags(cellStr(raw, 'tags')),
    difficulty,
    explanation: cellStr(raw, 'explanation'),
  };

  return {
    rowIndex,
    sheet: 'Match',
    draft,
    raw,
    status: errors.length > 0 ? 'error' : warnings.length > 0 ? 'warning' : 'valid',
    errors,
    warnings,
  };
}

// ══════════════════════════════════════════════════════════════════
// WORKBOOK ENTRY POINT
// ══════════════════════════════════════════════════════════════════

/**
 * Parse an XLSX ArrayBuffer into structured rows.
 *
 * Skips:
 *   - Completely empty rows
 *   - Rows matching INSTRUCTION_MARKERS
 *   - Row 2 of each sheet (template instruction row, always skipped)
 */
export function parseWorkbook(buffer: ArrayBuffer): ParsedWorkbook {
  const wb = XLSX.read(buffer, { type: 'array' });

  const result: ParsedWorkbook = {
    mcq:  [],
    text: [],
    match: [],
    sheetsFound: [],
  };

  const sheetMap: Record<string, 'mcq' | 'text' | 'match'> = {
    'MCQ':   'mcq',
    'Text':  'text',
    'Match': 'match',
  };

  for (const sheetName of wb.SheetNames) {
    const key = sheetMap[sheetName];
    if (!key) continue;

    const ws = wb.Sheets[sheetName];
    // Convert to array of objects (header row = first row)
    const rows: Record<string, any>[] = XLSX.utils.sheet_to_json(ws, {
      raw:    false,
      defval: '',
    });

    if (rows.length === 0) continue;
    result.sheetsFound.push(sheetName as any);

    rows.forEach((row, i) => {
      const rowIndex = i + 2; // +2 because row 1 = header
      // Skip instruction row (row index 2 = i === 0 after header)
      if (i === 0) return;

      const raw: Record<string, string> = {};
      Object.keys(row).forEach((k) => { raw[k.trim().toLowerCase()] = String(row[k] ?? '').trim(); });

      // Skip empty rows
      const allEmpty = Object.values(raw).every((v) => !v);
      if (allEmpty) return;

      // Skip instruction markers
      if (isInstructionRow(raw)) return;

      if (key === 'mcq')   result.mcq.push(parseMCQRow(raw, rowIndex));
      if (key === 'text')  result.text.push(parseTextRow(raw, rowIndex));
      if (key === 'match') result.match.push(parseMatchRow(raw, rowIndex));
    });
  }

  return result;
}

// ══════════════════════════════════════════════════════════════════
// SUBJECT RESOLUTION PASS (async — called from UI with subjects list)
// ══════════════════════════════════════════════════════════════════

/**
 * Annotate each ParsedRow with subject resolution info.
 * Does NOT mutate rows with errors — only rows with status 'valid' or 'warning'.
 * Returns a new array (does not mutate input).
 */
export function resolveSubjectsInRows(
  rows: ParsedRow[],
  subjects: Subject[],
  topics: import('../../../lib/subjectService').Topic[] = [],
): ParsedRow[] {
  return rows.map((row) => {
    const rawSubject = (row.draft.subject ?? '').trim();
    const rawTopic   = (row.draft.topic   ?? '').trim();
    if (!rawSubject) return row;

    const result = resolveSubject(rawSubject, subjects);

    let resolution: SubjectResolution;
    let updatedDraft = { ...row.draft };
    const updatedWarnings = [...row.warnings];
    const updatedErrors   = [...row.errors];
    let resolvedSubject: Subject | null = null;

    if (result.kind === 'exact' || result.kind === 'alias' || result.kind === 'fuzzy') {
      resolvedSubject = result.subject;
      updatedDraft.subject   = result.subject.name;
      updatedDraft.subjectId = result.subject.id;

      if (result.kind === 'exact') {
        resolution = { kind: 'exact', canonicalName: result.subject.name };
      } else if (result.kind === 'alias') {
        resolution = { kind: 'alias', canonicalName: result.subject.name, note: `Matched via alias "${result.matchedAlias}"` };
        updatedWarnings.push({ field: 'subject', message: `"${rawSubject}" matched via alias → "${result.subject.name}"` });
      } else {
        resolution = { kind: 'fuzzy', canonicalName: result.subject.name, note: `Fuzzy match (${Math.round(result.score * 100)}% similar)` };
        updatedWarnings.push({ field: 'subject', message: `"${rawSubject}" fuzzy-matched to "${result.subject.name}" — verify this is correct` });
      }
    } else {
      // kind === 'new' — strict mode: reject unknown subjects
      resolution = { kind: 'new', canonicalName: result.normalised };
      updatedErrors.push({
        field: 'subject',
        message: `Subject "${result.normalised}" doesn't exist. Create it on the Subjects page first.`,
      });
    }

    // Topic resolution — must match by name within the resolved subject's topics
    if (resolvedSubject && rawTopic) {
      const normTopic = rawTopic.toLowerCase().trim();
      const match = topics.find(
        (t) => t.subjectId === resolvedSubject!.id && t.name.toLowerCase() === normTopic
      );
      if (match) {
        updatedDraft.topic   = match.name;
        updatedDraft.topicId = match.id;
      } else {
        updatedErrors.push({
          field: 'topic',
          message: `Topic "${rawTopic}" not found under subject "${resolvedSubject.name}". Create it on the Subjects page first.`,
        });
      }
    } else if (resolvedSubject && !rawTopic) {
      updatedErrors.push({ field: 'topic', message: 'Topic is required.' });
    }

    return {
      ...row,
      draft: updatedDraft,
      warnings: updatedWarnings,
      errors: updatedErrors,
      subjectResolution: resolution,
      status: updatedErrors.length > 0
        ? 'error'
        : updatedWarnings.length > 0 ? 'warning' : 'valid',
    };
  });
}

// ══════════════════════════════════════════════════════════════════
// TEMPLATE GENERATION
// ══════════════════════════════════════════════════════════════════

/** Generate and trigger download of the XLSX template with example rows. */
export function downloadTemplate(): void {
  const wb = XLSX.utils.book_new();

  // ── MCQ sheet ──────────────────────────────────────────────────
  const mcqHeaders = [
    'type', 'stem', 'option_a', 'option_b', 'option_c', 'option_d', 'option_e',
    'correct', 'subject', 'topic', 'tags', 'difficulty', 'explanation',
    'stem_image_url', 'option_a_image_url', 'option_b_image_url',
    'option_c_image_url', 'option_d_image_url', 'option_e_image_url',
  ];

  const mcqRows = [
    mcqHeaders,
    // Instruction row (always skipped by parser)
    ['INSTRUCTION: Fill from row 3 onwards. type = single|multi|truefalse|fillblank. correct = A for single, A,C for multi, True/False for T/F.', ...Array(mcqHeaders.length - 1).fill('')],
    // Example 1 — single correct MCQ with math
    ['single', 'If $x^2 + 2x + 1 = 0$, what is the value of $x$?', '-1', '0', '1', '2', '', 'A', 'Mathematics', 'Algebra', 'quadratic, roots', 'easy', 'Factor: $(x+1)^2=0 \\Rightarrow x=-1$', '', '', '', '', '', ''],
    // Example 2 — multi correct
    ['multi', 'Which of the following are prime numbers?', '2', '3', '4', '5', '9', 'A,B,D', 'Mathematics', 'Number Theory', 'prime, factors', 'easy', '2, 3, 5 are prime. 4 and 9 are composite.', '', '', '', '', '', ''],
    // Example 3 — true/false
    ['truefalse', 'The sum of angles in a triangle is 180°.', '', '', '', '', '', 'True', 'Mathematics', 'Geometry', 'triangle, angles', 'easy', 'Angle sum property of triangles.', '', '', '', '', '', ''],
    // Example 4 — fill blank
    ['fillblank', 'The speed of light is approximately ___ km/s.', '3,00,000', '1,00,000', '1,50,000', '6,00,000', '', 'A', 'Physics', 'Light', 'speed, light, constants', 'medium', 'c ≈ 3×10⁸ m/s = 3,00,000 km/s', '', '', '', '', '', ''],
  ];

  const mcqWS = XLSX.utils.aoa_to_sheet(mcqRows);
  // Style header row (column widths only — xlsx doesn't support full styling without a premium lib)
  mcqWS['!cols'] = mcqHeaders.map(() => ({ wch: 22 }));
  XLSX.utils.book_append_sheet(wb, mcqWS, 'MCQ');

  // ── Text sheet ─────────────────────────────────────────────────
  const textHeaders = [
    'type', 'stem', 'model_answer',
    'subject', 'topic', 'tags', 'difficulty', 'explanation', 'stem_image_url',
  ];

  const textRows = [
    textHeaders,
    ['INSTRUCTION: Fill from row 3 onwards. type = short|long.', ...Array(textHeaders.length - 1).fill('')],
    ['short', 'State Newton\'s Second Law of Motion.', 'Force equals mass times acceleration: $F = ma$.', 'Physics', 'Laws of Motion', 'newton, force, acceleration', 'easy', 'F = ma where F is force in Newtons, m is mass in kg, a is acceleration in m/s².', ''],
    ['long', 'Explain the causes and consequences of the French Revolution.', 'Key causes: financial crisis, social inequality, Enlightenment ideas. Consequences: rise of Napoleon, spread of democratic ideals, abolition of feudalism.', 'History', 'Modern History', 'revolution, france, 18th century', 'hard', 'Evaluate social, political, and economic dimensions.', ''],
  ];

  const textWS = XLSX.utils.aoa_to_sheet(textRows);
  textWS['!cols'] = textHeaders.map(() => ({ wch: 28 }));
  XLSX.utils.book_append_sheet(wb, textWS, 'Text');

  // ── Match sheet ────────────────────────────────────────────────
  const matchHeaders = [
    'stem',
    'pair1_a', 'pair1_b', 'pair2_a', 'pair2_b', 'pair3_a', 'pair3_b',
    'pair4_a', 'pair4_b', 'pair5_a', 'pair5_b', 'pair6_a', 'pair6_b',
    'pair7_a', 'pair7_b', 'pair8_a', 'pair8_b',
    'subject', 'topic', 'tags', 'difficulty', 'explanation', 'stem_image_url',
  ];

  const matchRows = [
    matchHeaders,
    ['INSTRUCTION: Fill from row 3 onwards. pair1_a = Column A item, pair1_b = matching Column B item. Repeat for each pair (up to 8).', ...Array(matchHeaders.length - 1).fill('')],
    [
      'Match the countries with their capitals.',
      'India', 'New Delhi', 'France', 'Paris', 'Japan', 'Tokyo', 'Germany', 'Berlin', '', '', '', '', '', '', '', '',
      'General Knowledge', 'World Capitals', 'geography, capitals', 'easy', '', '',
    ],
    [
      'Match the scientists with their discoveries.',
      'Isaac Newton', 'Laws of Motion', 'Albert Einstein', 'Theory of Relativity', 'Marie Curie', 'Radioactivity', '', '', '', '', '', '', '', '', '', '',
      'Science', 'Famous Scientists', 'scientists, discoveries', 'medium', '', '',
    ],
  ];

  const matchWS = XLSX.utils.aoa_to_sheet(matchRows);
  matchWS['!cols'] = matchHeaders.map(() => ({ wch: 20 }));
  XLSX.utils.book_append_sheet(wb, matchWS, 'Match');

  // ── Download ───────────────────────────────────────────────────
  XLSX.writeFile(wb, 'STRATUM_Question_Template.xlsx');
}

// ══════════════════════════════════════════════════════════════════
// SUMMARY HELPERS
// ══════════════════════════════════════════════════════════════════

export type UploadSummary = {
  totalParsed:  number;
  valid:        number;
  warnings:     number;
  errors:       number;
  willSave:     number;
  willSkip:     number;
};

export function computeSummary(rows: ParsedRow[]): UploadSummary {
  const valid    = rows.filter((r) => r.status === 'valid').length;
  const warnings = rows.filter((r) => r.status === 'warning').length;
  const errors   = rows.filter((r) => r.status === 'error').length;
  return {
    totalParsed: rows.length,
    valid,
    warnings,
    errors,
    willSave:  valid + warnings,
    willSkip:  errors,
  };
}

export function getAllRows(wb: ParsedWorkbook): ParsedRow[] {
  return [...wb.mcq, ...wb.text, ...wb.match];
}

export function getSaveableRows(rows: ParsedRow[]): ParsedRow[] {
  return rows.filter((r) => r.status !== 'error');
}

// ══════════════════════════════════════════════════════════════════
// DUPLICATE DETECTION PASS
// ══════════════════════════════════════════════════════════════════

/**
 * Score each row against the existing question pool. Scoped to same
 * subjectId+topicId per row.
 *
 *   - exact_stem        → row becomes 'error' (block)
 *   - reordered_options → row becomes 'error' (block)
 *   - stemSim or optionsSim ≥ 85%   → 'warning'
 *   - stemSim or optionsSim ≥ 60%   → 'warning' (informational)
 *
 * Must be called AFTER resolveSubjectsInRows() so subjectId / topicId are set.
 * Skips rows already in 'error' state (no point scoring a broken row).
 *
 * Also de-duplicates WITHIN the upload itself: rows are compared against
 * prior rows in the same batch, not just the existing pool.
 */
export function scoreDuplicatesInRows(
  rows: ParsedRow[],
  pool: Question[],
): ParsedRow[] {
  // Seen-in-batch accumulator: tracks rows already validated within THIS upload
  // so two identical rows in the same file also flag each other.
  const inBatch: Array<{ id?: string } & Question> = [];

  return rows.map((row) => {
    if (row.status === 'error') return row;

    const draft = row.draft;
    if (!draft.subjectId || !draft.topicId || !draft.stem) return row;

    // ── Build candidate pool: existing DB + already-seen batch rows ──
    const dbCandidates  = findDuplicateCandidates(
      { subjectId: draft.subjectId, topicId: draft.topicId },
      pool,
    );
    const batchCandidates = inBatch.filter(
      (b) => b.subjectId === draft.subjectId && b.topicId === draft.topicId,
    );

    // ── Shape draft into ScoreableQuestion ──
    const scoreable = {
      stem:          draft.stem,
      options:       (draft.options ?? []).map((o) => o.text ?? ''),
      // Map correctIds → option texts so detection compares apples-to-apples
      correctAnswer: (draft.correctIds ?? [])
        .map((cid) => (draft.options ?? []).find((o) => o.id === cid)?.text ?? '')
        .filter(Boolean),
    };

    // Existing-pool questions already have option text + correct text — use directly
    const poolScoreable = [
      ...dbCandidates.map((q) => ({
        id:            q.id,
        stem:          q.stem ?? '',
        options:       (q.options ?? []).map((o: any) => o.text ?? ''),
        correctAnswer: (q.correctIds ?? [])
          .map((cid: string) => (q.options ?? []).find((o: any) => o.id === cid)?.text ?? '')
          .filter(Boolean),
      })),
      ...batchCandidates.map((b: any) => ({
        id:            b.id,
        stem:          b.stem ?? '',
        options:       (b.options ?? []).map((o: any) => o.text ?? ''),
        correctAnswer: (b.correctIds ?? [])
          .map((cid: string) => (b.options ?? []).find((o: any) => o.id === cid)?.text ?? '')
          .filter(Boolean),
      })),
    ];

    const score = scoreAgainstPool(scoreable, poolScoreable);
    const verdict = verdictFor(score);

    // ── Mutate status based on verdict ──
    const newErrors:   RowError[]   = [...row.errors];
    const newWarnings: RowWarning[] = [...row.warnings];

    if (verdict === 'block') {
      const reason = score.matchedReason === 'exact_stem'
        ? 'Exact duplicate of an existing question'
        : 'Same options (reordered) and same correct answer as an existing question';
      newErrors.push({
        field: 'duplicate',
        message: `${reason}${score.matchedQuestionId ? ` (id: ${score.matchedQuestionId})` : ''}.`,
      });
    } else if (verdict === 'warn' || verdict === 'note') {
      newWarnings.push({
        field: 'duplicate',
        message: `Possible duplicate — stem ${pct(score.stemSim)}, options ${pct(score.optionsSim)}, answer ${score.answerMatch ? 'matches' : 'differs'}.`,
      });
    }

    // Add to in-batch pool ONLY if not blocked (no point comparing future rows against a discarded one).
    if (verdict !== 'block') {
      inBatch.push({
        id:         `batch-row-${row.rowIndex}`,
        stem:       draft.stem ?? '',
        options:    (draft.options ?? []) as any,
        correctIds: (draft.correctIds ?? []) as any,
        subjectId:  draft.subjectId,
        topicId:    draft.topicId,
      } as any);
    }

    return {
      ...row,
      duplicateScore: score,
      errors:   newErrors,
      warnings: newWarnings,
      status: newErrors.length > 0
        ? 'error'
        : newWarnings.length > 0 ? 'warning' : 'valid',
    };
  });
}
