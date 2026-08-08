/**
 * CODE AUTHORING — what makes a coding question answerable and gradable
 *
 * Every rule here exists because breaking it produces a question that LOOKS
 * fine in the bank and fails at a point where nobody can fix it: mid-exam, or
 * at marking, in front of a candidate who did nothing wrong.
 *
 * Pure, and separate from the editor component, so the rules are proven by the
 * suite rather than by clicking through a drawer.
 *
 * ── SEVERITY MEANS SOMETHING ──────────────────────────────────────
 *
 * `error`   — the question cannot be graded or cannot be answered. Saving is
 *             blocked, because the alternative is discovering it during a
 *             sitting.
 * `warning` — the question works, but an author almost certainly did not mean
 *             it. Shown, never blocking: an author who genuinely wants a
 *             question with no runnable samples is entitled to one.
 */

import {
  type CodeSpec,
  type CodeTest,
} from './questionBankService';

/** Mirrors JUDGE_LANGUAGES in functions/src/judgeCore.ts. Keep in EXACT sync. */
export const AUTHORING_LANGUAGES = [
  'python3', 'javascript', 'typescript', 'java', 'c', 'cpp',
  'csharp', 'go', 'rust', 'kotlin', 'php', 'ruby', 'sql',
] as const;

export type AuthoringLanguage = (typeof AUTHORING_LANGUAGES)[number];

export const LANGUAGE_LABEL: Record<AuthoringLanguage, string> = {
  python3: 'Python 3', javascript: 'JavaScript', typescript: 'TypeScript',
  java: 'Java', c: 'C', cpp: 'C++', csharp: 'C#', go: 'Go',
  rust: 'Rust', kotlin: 'Kotlin', php: 'PHP', ruby: 'Ruby', sql: 'SQL',
};

export const COMPARISON_LABEL: Record<NonNullable<CodeTest['comparison']>, string> = {
  trimmed: 'Ignore trailing whitespace (recommended)',
  exact:   'Exact match',
  tokens:  'Ignore all whitespace',
  numeric: 'Numeric, within a tolerance',
};

export interface AuthoringIssue {
  severity: 'error' | 'warning';
  /** Which control to point at. 'tests' means the suite as a whole. */
  field: 'languages' | 'starterCode' | 'limits' | 'tests';
  /** Index into the test list, when the issue is about one test. */
  testIndex?: number;
  message: string;
}

/** The weight a test carries if the author sets none. Mirrors weightOf in judgeCore. */
export function defaultWeight(test: CodeTest): number {
  if (typeof test.weight === 'number' && Number.isFinite(test.weight) && test.weight >= 0) {
    return test.weight;
  }
  return test.visible ? 0 : 1;
}

export function totalWeight(tests: CodeTest[]): number {
  return tests.reduce((sum, t) => sum + defaultWeight(t), 0);
}

/** A fresh test row, defaulted the way most authors want it. */
export function newTest(visible: boolean): CodeTest {
  return {
    id: `t_${Math.random().toString(36).slice(2, 10)}`,
    stdin: '',
    expected: '',
    visible,
    comparison: 'trimmed',
  };
}

/**
 * Every reason this question would misbehave, worst first.
 *
 * Returns issues rather than throwing or returning a boolean, because an
 * author fixing three problems should see three problems, not one at a time.
 */
export function validateCodeQuestion(
  spec: CodeSpec | undefined,
  tests: CodeTest[],
): AuthoringIssue[] {
  const issues: AuthoringIssue[] = [];
  const err = (field: AuthoringIssue['field'], message: string, testIndex?: number) =>
    issues.push({ severity: 'error', field, message, testIndex });
  const warn = (field: AuthoringIssue['field'], message: string, testIndex?: number) =>
    issues.push({ severity: 'warning', field, message, testIndex });

  // ── Languages ──────────────────────────────────────────────────
  const languages = spec?.languages ?? [];
  const unknown = languages.filter(
    (l) => !(AUTHORING_LANGUAGES as readonly string[]).includes(l));
  if (unknown.length > 0) {
    err('languages', `The judge cannot run: ${unknown.join(', ')}.`);
  }
  if (languages.length > 0 && unknown.length === languages.length) {
    // Every language is unsupported, so the delivery side falls back to
    // offering all of them — which is not what this author asked for, and they
    // should be told rather than left to discover it in an exam.
    err('languages', 'No selected language can be run, so the question would open in every language instead.');
  }

  // ── Starter code ───────────────────────────────────────────────
  const starterKeys = Object.keys(spec?.starterCode ?? {});
  if (languages.length > 0) {
    const orphaned = starterKeys.filter((k) => !languages.includes(k));
    if (orphaned.length > 0) {
      warn('starterCode', `Starter code for ${orphaned.join(', ')} will never be shown — that language is not offered.`);
    }
    const missing = languages.filter((l) => !starterKeys.includes(l) && unknown.indexOf(l) === -1);
    if (starterKeys.length > 0 && missing.length > 0) {
      warn('starterCode', `No starter code for ${missing.join(', ')} — candidates get an empty editor for those.`);
    }
  }

  // ── Tests ──────────────────────────────────────────────────────
  if (tests.length === 0) {
    err('tests', 'Add at least one test case — there is nothing to mark this question against.');
    return issues;
  }

  const seen = new Set<string>();
  tests.forEach((t, i) => {
    if (!t.id || seen.has(t.id)) {
      // Duplicate ids collide in the verdict map, so one result silently
      // overwrites another and the mark is computed from fewer tests than ran.
      err('tests', 'Two tests share an id, which would make one of them uncountable.', i);
    }
    seen.add(t.id);

    if (t.expected.trim().length === 0) {
      warn('tests', 'Expected output is empty — this passes only if the program prints nothing.', i);
    }
    if (t.comparison === 'numeric') {
      const tol = t.tolerance;
      if (tol !== undefined && (!Number.isFinite(tol) || tol < 0)) {
        err('tests', 'Tolerance must be a number of zero or more.', i);
      }
    }
    if (t.weight !== undefined && (!Number.isFinite(t.weight) || t.weight < 0)) {
      err('tests', 'Weight must be a number of zero or more.', i);
    }
  });

  // ── Gradability ────────────────────────────────────────────────
  if (totalWeight(tests) <= 0) {
    // The single most important rule here. A suite with no weight cannot
    // produce a mark: the server refuses to guess and sends the paper to
    // manual review, so the failure surfaces after the exam rather than now.
    err('tests',
      'No test carries any weight, so this question cannot be marked. '
      + 'Visible tests are worth 0 by default — add a hidden test, or give a visible one a weight.');
  }

  if (!tests.some((t) => t.visible)) {
    warn('tests',
      'No visible tests, so candidates cannot run their code before submitting.');
  }
  if (!tests.some((t) => !t.visible)) {
    warn('tests',
      'Every test is visible. Candidates can read the expected output, so a program that hardcodes it will score full marks.');
  }

  return issues;
}

/** Convenience for the save button. */
export function hasBlockingIssue(issues: AuthoringIssue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}
