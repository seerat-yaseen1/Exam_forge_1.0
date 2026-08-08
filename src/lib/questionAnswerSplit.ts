/**
 * THE ANSWER SPLIT — which fields of a question are the answer key
 *
 * A question is stored twice: a public document in `questions`, and a sibling
 * in `questionAnswers` that Firestore rules keep away from students. This
 * module owns the one list that decides which fields go where, and the
 * function that wipes them from the public copy.
 *
 * It lives apart from questionBankService for two reasons. It is the security
 * boundary of the whole question bank, so it deserves a name and a file rather
 * than being three helpers in the middle of a CRUD module. And it is pure —
 * no Firestore, no firebase import — so the suite can prove the invariant
 * directly instead of inferring it from a write path it cannot run.
 *
 * ── IMPORT DIRECTION ──────────────────────────────────────────────
 *
 * TYPES ONLY from questionBankService (erased at build, so no runtime cycle);
 * questionBankService imports VALUES from here. Same arrangement as
 * itemTypes.ts, and for the same reason — a value import in this direction
 * creates a cycle Vite resolves to `undefined` at module-init time.
 */

import type { CodeTest, CorrectPair, Question, QuestionAnswer } from './questionBankService';

/**
 * The fields that are the answer, and must never sit on the public document.
 *
 * `tests` is here because the hidden test suite IS the answer key for a coding
 * question. On the public document it would ship to every browser inside the
 * exam payload — the same exposure as publishing correctIds, and harder to
 * notice because nothing on screen would look wrong.
 */
export const ANSWER_KEYS = ['correctIds', 'correctPairs', 'modelAnswer', 'tests'] as const;

export type AnswerKey = (typeof ANSWER_KEYS)[number];

export type AnswerFields = {
  correctIds: string[];
  correctPairs: CorrectPair[];
  modelAnswer: string;
  tests: CodeTest[];
};

/** What a public read returns in place of the answer fields. */
export function emptyAnswerDefaults(): AnswerFields {
  return { correctIds: [], correctPairs: [], modelAnswer: '', tests: [] };
}

/** Pull the answer fields out of a draft, skipping ones it does not set. */
export function pickAnswerFields(q: Partial<Question>): Partial<QuestionAnswer> {
  const out: Partial<QuestionAnswer> = {};
  if (q.correctIds   !== undefined) out.correctIds   = q.correctIds;
  if (q.correctPairs !== undefined) out.correctPairs = q.correctPairs;
  if (q.modelAnswer  !== undefined) out.modelAnswer  = q.modelAnswer;
  if (q.tests        !== undefined) out.tests        = q.tests;
  return out;
}

/** Remove the answer fields entirely, for update paths that must not touch them. */
export function stripAnswerFields<T extends Partial<Question>>(q: T): T {
  const out: Record<string, unknown> = { ...q };
  for (const k of ANSWER_KEYS) delete out[k];
  return out as T;
}

/**
 * The public payload. Answer fields are overwritten with empties rather than
 * deleted, so a pre-migration document that still carries them inline is
 * neutralised by the same call — the point is that what lands in `questions`
 * cannot contain an answer, whatever the caller passed in.
 */
export function sanitizePublic<T extends Partial<Question>>(q: T): T & AnswerFields {
  return { ...q, ...emptyAnswerDefaults() };
}
