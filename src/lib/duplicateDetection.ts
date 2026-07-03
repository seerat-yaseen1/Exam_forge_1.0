/**
 * Duplicate detection for questions — pure functions, no Firestore.
 *
 * Produces three INDEPENDENT scores per candidate pair:
 *   - stemSim     0..1   (exact match → 1, fuzzy via shingle-Jaccard + Levenshtein refinement)
 *   - optionsSim  0..1   (reordered-equal → 1, otherwise Jaccard on normalized option strings)
 *   - answerMatch boolean (normalized correct-answer comparison)
 *
 * Caller decides what to do with these (warn / block / display). See callers
 * in bulkUploadParser.ts and QuestionTypeEngine.tsx.
 *
 * NOTE: detection is scoped to same-subjectId + same-topicId by the caller —
 * this file does not filter; it scores whatever pool it receives.
 */

// ── Tunable constants (exposed so callers can read for UI thresholds) ─────
export const WARN_THRESHOLD  = 0.85;   // ≥ this → warn (yellow/red)
export const NOTE_THRESHOLD  = 0.60;   // ≥ this → note (yellow)
export const EXACT_THRESHOLD = 1.0;    // == this → block (exact match)

// ── Reason codes ──────────────────────────────────────────────────────────
export type MatchReason =
  | 'confirmed_duplicate'  // stem + options + answer all 100% → certain duplicate
  | 'same_stem_answer'     // stem + answer 100%, options differ → review (different distractors)
  | 'exact_stem'           // stem 100% but answer differs → review
  | 'reordered_options'    // same option set + same correct answer, stem differs → review
  | 'fuzzy_stem'           // similar but not identical stems
  | 'option_overlap'       // options overlap strongly even though stems don't
  | 'none';                // nothing significant

export interface DuplicateScore {
  stemSim:     number;            // 0..1
  optionsSim:  number;            // 0..1
  answerMatch: boolean;
  matchedQuestionId: string | null;
  matchedReason: MatchReason;
}

// Minimum shape we need from a question for scoring. Matches both
// existing-question records and in-progress drafts.
export interface ScoreableQuestion {
  id?: string;
  stem: string;
  options?: string[];
  correctAnswer?: string | string[] | null;
}

// ── String normalization ──────────────────────────────────────────────────

/** Lowercase, collapse whitespace, strip punctuation. Used for hashing + comparison. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’“”]/g, "'") // smart quotes → straight
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')           // punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
}

/** Word-level 3-shingles. Used for cheap Jaccard prefilter on fuzzy stems. */
export function shingles(s: string, k = 3): Set<string> {
  const words = normalize(s).split(' ').filter(Boolean);
  if (words.length < k) return new Set([words.join(' ')]);
  const out = new Set<string>();
  for (let i = 0; i <= words.length - k; i++) {
    out.add(words.slice(i, i + k).join(' '));
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Levenshtein-based similarity, normalized to 0..1.
 * Only called after Jaccard prefilter narrows candidates — too expensive otherwise.
 */
export function levenshteinSim(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;

  const m = a.length, n = b.length;
  // Row-only DP to keep memory at O(min(m, n)).
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,        // insert
        prev[j] + 1,            // delete
        prev[j - 1] + cost,     // substitute
      );
    }
    [prev, curr] = [curr, prev];
  }

  const dist = prev[n];
  const maxLen = Math.max(m, n);
  return 1 - dist / maxLen;
}

// ── Options helpers ───────────────────────────────────────────────────────

function normalizeOptions(opts: string[] | undefined): string[] {
  return (opts ?? []).map(normalize).filter(Boolean);
}

/** Stable signature for option SET (order-insensitive). Equal signature → reordered. */
export function optionsSignature(opts: string[] | undefined): string {
  return [...normalizeOptions(opts)].sort().join('||');
}

/** Jaccard over normalized option strings. */
export function optionsJaccard(a: string[] | undefined, b: string[] | undefined): number {
  const setA = new Set(normalizeOptions(a));
  const setB = new Set(normalizeOptions(b));
  return jaccard(setA, setB);
}

// ── Correct-answer match ──────────────────────────────────────────────────

/** Normalize a correct-answer value (string OR string[]) into a stable string for comparison. */
function normalizeAnswer(ans: string | string[] | null | undefined): string {
  if (ans == null) return '';
  if (Array.isArray(ans)) return [...ans].map(normalize).sort().join('||');
  return normalize(ans);
}

export function answersMatch(a: ScoreableQuestion, b: ScoreableQuestion): boolean {
  const na = normalizeAnswer(a.correctAnswer);
  const nb = normalizeAnswer(b.correctAnswer);
  return na.length > 0 && na === nb;
}

// ── Per-pair scorer ───────────────────────────────────────────────────────

/**
 * Score a single (new, existing) pair. Cheap-first:
 *  1. Exact-stem hash compare → short-circuit to stemSim 1.0
 *  2. Reordered-options signature → optionsSim 1.0
 *  3. Stem shingle-Jaccard → if ≥ NOTE_THRESHOLD, refine with Levenshtein
 *  4. Options Jaccard
 *  5. Answer compare
 */
export function scorePair(neu: ScoreableQuestion, existing: ScoreableQuestion): DuplicateScore {
  const nStem = normalize(neu.stem);
  const eStem = normalize(existing.stem);

  // ── stem ──
  let stemSim: number;
  if (nStem.length > 0 && nStem === eStem) {
    stemSim = 1;
  } else {
    const jac = jaccard(shingles(neu.stem), shingles(existing.stem));
    stemSim = jac < NOTE_THRESHOLD
      ? jac                                   // not close enough to bother with Levenshtein
      : Math.max(jac, levenshteinSim(nStem, eStem));
  }

  // ── options ──
  const sigA = optionsSignature(neu.options);
  const sigB = optionsSignature(existing.options);
  const optionsSim = (sigA.length > 0 && sigA === sigB)
    ? 1
    : optionsJaccard(neu.options, existing.options);

  // ── answer ──
  const answerMatch = answersMatch(neu, existing);

  // ── reason ──
  let matchedReason: MatchReason = 'none';
  if (stemSim >= EXACT_THRESHOLD && optionsSim >= EXACT_THRESHOLD && answerMatch) {
    matchedReason = 'confirmed_duplicate';
  }
  else if (stemSim >= EXACT_THRESHOLD && answerMatch)     matchedReason = 'same_stem_answer';
  else if (stemSim >= EXACT_THRESHOLD)                    matchedReason = 'exact_stem';
  else if (optionsSim >= EXACT_THRESHOLD && answerMatch)  matchedReason = 'reordered_options';
  else if (stemSim >= WARN_THRESHOLD)                     matchedReason = 'fuzzy_stem';
  else if (optionsSim >= WARN_THRESHOLD)                  matchedReason = 'option_overlap';
  
  return {
    stemSim,
    optionsSim,
    answerMatch,
    matchedQuestionId: existing.id ?? null,
    matchedReason,
  };
}

// ── Pool orchestrator ─────────────────────────────────────────────────────

/**
 * Score `draft` against every question in `pool`. Returns the SINGLE highest-
 * concern match (priority: exact_stem > reordered_options > fuzzy_stem > option_overlap > none).
 *
 * Caller is responsible for pre-filtering the pool to same subjectId + topicId.
 */
export function scoreAgainstPool(
  draft: ScoreableQuestion,
  pool: ScoreableQuestion[],
): DuplicateScore {
 const priority: Record<MatchReason, number> = {
    confirmed_duplicate: 6,
    same_stem_answer:    5,
    exact_stem:          4,
    reordered_options:   3,
    fuzzy_stem:          2,
    option_overlap:      1,
    none:                0,
  };

  let best: DuplicateScore = {
    stemSim: 0, optionsSim: 0, answerMatch: false,
    matchedQuestionId: null, matchedReason: 'none',
  };

  for (const existing of pool) {
    if (existing.id && draft.id && existing.id === draft.id) continue; // skip self
    const s = scorePair(draft, existing);
    if (priority[s.matchedReason] > priority[best.matchedReason]) {
      best = s;
    } else if (priority[s.matchedReason] === priority[best.matchedReason]) {
      // Tiebreak on max(stemSim, optionsSim) so we pick the strongest match.
      const sBest = Math.max(s.stemSim, s.optionsSim);
      const bBest = Math.max(best.stemSim, best.optionsSim);
      if (sBest > bBest) best = s;
    }
  }

  return best;
}

// ── UI helpers (used by both bulk + single-create surfaces) ───────────────

export type Verdict = 'clean' | 'note' | 'warn' | 'block';

export function verdictFor(score: DuplicateScore): Verdict {
  // Only a full triple match (stem + options + answer) is a certain duplicate.
  if (score.matchedReason === 'confirmed_duplicate') return 'block';
  // Everything else meaningful goes to human review.
  if (score.matchedReason === 'same_stem_answer')    return 'warn';
  if (score.matchedReason === 'exact_stem')          return 'warn';
  if (score.matchedReason === 'reordered_options')   return 'warn';
  const top = Math.max(score.stemSim, score.optionsSim);
  if (top >= WARN_THRESHOLD) return 'warn';
  if (top >= NOTE_THRESHOLD) return 'note';
  return 'clean';
}

export function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
