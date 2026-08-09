/**
 * TWIN DRIFT — the failure mode this repo is structurally exposed to
 *
 * The client and the Cloud Functions are two separate TypeScript builds with
 * no shared package, so several lists exist TWICE with a "keep in EXACT sync"
 * comment and nothing enforcing it. That comment is not enough, and this file
 * exists because it demonstrably was not:
 *
 *   `ANSWER_KEYS` (client) gained `'tests'` when the coding engine shipped.
 *   `ANSWER_KEYS_S` (server) did not. Nothing failed. No type error, no
 *   runtime error, no wrong-looking screen. What actually happened was that
 *   every coding question authored by faculty or an institute wrote its hidden
 *   test suite to the PUBLIC question document and wrote NOTHING to the answer
 *   document — so the answer key sat in the collection it is kept out of,
 *   while every grading path read an empty suite. The candidate could not run
 *   their code, the judge received zero tests, and the answer sat in manual
 *   review forever.
 *
 * These tests read the two sources as TEXT rather than importing them. The
 * functions build is deliberately outside the client suite (see
 * vitest.config.ts), and importing firebase-functions into jsdom to check a
 * string array would be a far heavier coupling than reading the file.
 *
 * The regexes are anchored on `export`/`const` declarations that are stable
 * parts of each module's public shape. A rename that breaks one of them fails
 * LOUDLY here — which is the point, because a rename is exactly when a twin
 * silently stops being a twin.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

import { ANSWER_KEYS } from './questionAnswerSplit';
import { AUTHORING_LANGUAGES } from './codeAuthoring';
import { JUDGE_LANGUAGES } from '../app/components/exam/judgeTypes';

const root = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

const serverIndex = read('functions/src/index.ts');
const serverJudge = read('functions/src/judgeCore.ts');

/** Pull the string literals out of a `const NAME = [...]` declaration. */
function stringArray(source: string, declaration: RegExp, label: string): string[] {
  const m = source.match(declaration);
  if (!m) {
    throw new Error(
      `Could not find ${label}. The declaration was renamed or reshaped — `
      + 'update this test deliberately rather than deleting the assertion, '
      + 'because the twin it guards is still a twin.',
    );
  }
  return Array.from(m[1].matchAll(/'([^']+)'/g)).map((x) => x[1]);
}

describe('answer-key split — client and server must name the same fields', () => {
  const serverKeys = stringArray(
    serverIndex,
    /const ANSWER_KEYS_S = \[([^\]]*)\]/,
    'ANSWER_KEYS_S in functions/src/index.ts',
  );

  it('ANSWER_KEYS_S matches ANSWER_KEYS exactly', () => {
    // Not "is a superset" and not "contains the important ones". A field on
    // one list and not the other is misfiled in BOTH directions at once: it
    // lands on the public document AND is missing from the answer document.
    expect([...serverKeys].sort()).toEqual([...ANSWER_KEYS].sort());
  });

  it("includes 'tests', the coding answer key", () => {
    // Named on its own because this is the one that broke, and because a
    // future engine's key will break the same way.
    expect(serverKeys).toContain('tests');
  });
});

describe('judge language table — three copies, one list', () => {
  const serverLanguages = stringArray(
    serverJudge,
    /export const JUDGE_LANGUAGES: JudgeLanguage\[\] = \[([\s\S]*?)\]/,
    'JUDGE_LANGUAGES in functions/src/judgeCore.ts',
  );

  it('the client judge list matches the server judge list', () => {
    // A language here and not there is one the picker offers and the judge
    // rejects: the candidate chooses it, writes an answer in it, and the run
    // fails with an argument error they cannot act on.
    expect([...JUDGE_LANGUAGES].sort()).toEqual([...serverLanguages].sort());
  });

  it('the authoring list matches the server judge list', () => {
    // Same failure one step earlier — an author restricts a question to a
    // language the judge cannot run, and validateCodeQuestion's "no selected
    // language can be run" error is the only thing standing between that and
    // a dead question.
    expect([...AUTHORING_LANGUAGES].sort()).toEqual([...serverLanguages].sort());
  });
});

describe('student question whitelist', () => {
  const whitelist = serverIndex.match(
    /function sanitizeQuestionForStudent\([\s\S]*?\n\}/,
  )?.[0];

  it('is findable', () => {
    expect(whitelist).toBeTruthy();
  });

  it('passes codeSpec through, or a coding question arrives unanswerable', () => {
    // codeSpec is PUBLIC: languages, starter code and limits are all things the
    // candidate is shown. Omitted from this whitelist, the exam editor opens
    // empty and unrestricted — resolveLanguages reads an absent spec as "every
    // language", starterFor returns '', and the author's question is not the
    // question that was delivered.
    expect(whitelist).toMatch(/codeSpec/);
  });

  it('never passes the answer fields through', () => {
    // The other half of the same contract. These must be present as EMPTIES,
    // never as `q.<field>`.
    for (const key of ['correctIds', 'correctPairs', 'modelAnswer', 'tests']) {
      expect(whitelist).not.toMatch(new RegExp(`${key}:\\s*q\\.${key}`));
    }
  });
});
