/**
 * CODE ANSWER — the decisions the editor makes, separated from the editor
 *
 * CodeAnswerEditor is a CodeMirror instance, a language selector, a run button
 * and a results panel. None of that is where the mistakes live. The mistakes
 * live in "has this candidate actually answered?", "which language are they
 * writing in?" and "what happens to their work when they switch language?",
 * so those are here, as pure functions, where the suite can reach them.
 */

import type { JudgeLanguage } from './judgeTypes';

/** Author-supplied delivery settings for a coding question. */
export interface CodeSpec {
  languages?: string[];
  /** Per-language starting buffer. Absent means an empty editor. */
  starterCode?: Record<string, string>;
}

export interface CodeAnswerValue {
  language: string;
  source: string;
}

/** Line endings are a platform artefact of the editor, never the candidate's intent. */
function normalise(s: string): string {
  return s.replace(/\r\n?/g, '\n').trim();
}

export function starterFor(spec: CodeSpec | undefined, language: string): string {
  return spec?.starterCode?.[language] ?? '';
}

/**
 * Is what is in the editor still what the question put there?
 *
 * THIS IS THE WHOLE STARTER-CODE PROBLEM. A coding question arrives with its
 * editor already full, so "there is text in the box" — the test every other
 * engine uses — would mark it answered before the candidate has read it. The
 * navigator would show a complete grid, and "all questions answered" would be
 * a statement about a paper nobody had touched.
 *
 * Whitespace and line endings do not count as work: a candidate who pressed
 * Enter twice has not answered, and should not be told they have.
 */
export function isUnmodifiedStarter(source: string, starter: string): boolean {
  const s = normalise(source);
  return s.length === 0 || s === normalise(starter);
}

/**
 * The answer to store, or null for "this question is not answered".
 *
 * Returning null rather than an empty answer is what keeps the contract in one
 * place: an untouched question has NO answer document, so isAnswered's
 * `!answer` branch catches it and the navigator needs to know nothing about
 * starter code.
 *
 * The stored source is the RAW buffer, not the normalised one. Normalisation
 * decides whether this counts as an answer; it must never edit the candidate's
 * submission, whose exact bytes are what the judge will be given.
 */
export function answerFrom(
  language: string,
  source: string,
  spec: CodeSpec | undefined,
): CodeAnswerValue | null {
  if (isUnmodifiedStarter(source, starterFor(spec, language))) return null;
  return { language, source };
}

/**
 * Languages this question accepts.
 *
 * An author who listed none meant "any language the platform supports", which
 * is the sensible reading of an empty restriction — not "no languages", which
 * would render the question unanswerable.
 */
export function resolveLanguages(
  spec: CodeSpec | undefined,
  supported: readonly JudgeLanguage[],
): JudgeLanguage[] {
  const listed = spec?.languages;
  if (!Array.isArray(listed) || listed.length === 0) return [...supported];
  const allowed = listed.filter((l): l is JudgeLanguage =>
    (supported as readonly string[]).includes(l));
  // An author who restricted to languages the platform cannot run has made a
  // mistake, and an empty selector is a dead question. Falling back to the full
  // list keeps the paper answerable; the authoring side is where this should be
  // caught, and it is not the candidate's problem to discover mid-exam.
  return allowed.length > 0 ? allowed : [...supported];
}

/**
 * Which language the editor opens in.
 *
 * A candidate who already chose one keeps it, even if an author narrowed the
 * list afterwards — the paper they sat is the paper they sat, and silently
 * moving their code into a different language would be worse than honouring a
 * stale choice.
 */
export function initialLanguage(
  spec: CodeSpec | undefined,
  existing: CodeAnswerValue | null | undefined,
  supported: readonly JudgeLanguage[],
): JudgeLanguage {
  const languages = resolveLanguages(spec, supported);
  const chosen = existing?.language;
  if (chosen && (supported as readonly string[]).includes(chosen)) return chosen as JudgeLanguage;
  return languages[0];
}

/**
 * The buffer to show when the candidate switches to `language`.
 *
 * Per-language drafts are kept so switching away and back does not destroy
 * work. Switching language in a code editor is usually exploratory — "what
 * would this look like in Python?" — and an editor that answers that by
 * deleting what you wrote teaches you never to try it.
 */
export function bufferForLanguage(
  language: string,
  drafts: Record<string, string>,
  spec: CodeSpec | undefined,
): string {
  const draft = drafts[language];
  if (typeof draft === 'string' && draft.length > 0) return draft;
  return starterFor(spec, language);
}

/** Human-facing summary of a finished run, for the results panel. */
export function runSummary(
  results: Array<{ status: string }>,
  hiddenCount: number,
): string {
  const passed = results.filter((r) => r.status === 'passed').length;
  const head = `${passed} of ${results.length} sample ${results.length === 1 ? 'test' : 'tests'} passed`;
  // The hidden count is the number that stops a green sample run from reading
  // as a finished answer.
  if (hiddenCount > 0) {
    return `${head} · ${hiddenCount} hidden ${hiddenCount === 1 ? 'test' : 'tests'} will run at marking`;
  }
  return head;
}
