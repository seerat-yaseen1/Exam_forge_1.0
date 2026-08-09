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
import {
  MAX_JUDGE_ATTEMPTS,
  RUN_STATUS_LABEL,
  TEST_STATUS_LABEL,
} from './codeVerdictView';
import { codeVerdictDocId } from './submissionService';
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

// ══════════════════════════════════════════════════════════════════
// THE ANSWER DISCRIMINANT — a twin inside the client
// ══════════════════════════════════════════════════════════════════
//
// The same failure as ANSWER_KEYS, on the same day, one build over. Every
// stored answer records which engine produced it, and ExamShell derived that
// with its own ternary instead of from the taxonomy:
//
//     q.engine === 'mcq' ? 'mcq' : q.engine === 'text' ? 'text' : 'match'
//
// Four engines, three arms. Every CODING answer was stored as 'match'. As
// with ANSWER_KEYS nothing failed: no type error (the ternary's union is a
// subset of the field's), no runtime error, no wrong-looking screen. What
// happened was that QuestionNavigator's `type === 'code'` branch — written
// specifically so starter code does not count as an answer — was never
// reached, so a candidate who cleared their editor was shown as having
// answered it and the pre-submit unanswered count was wrong.
//
// The branch's own unit tests passed the whole time, because they built
// `type: 'code'` by hand. Testing both ends of a wire proves nothing about
// the wire, which is what this file is for.

// ══════════════════════════════════════════════════════════════════
// THE VERDICT VOCABULARY — a fourth copy, and the newest
// ══════════════════════════════════════════════════════════════════
//
// The review surfaces render attemptVerdicts, which are written by the
// functions build from types in judgeCore.ts. The client cannot import them,
// so codeVerdictView.ts restates the two status unions and the retry budget —
// a twin, created knowingly, and therefore guarded here at the same time.
//
// What drift would cost: a status the server can emit and the client's label
// map does not name renders as `undefined` in the run panel, on the screen a
// reviewer uses to explain a mark to a candidate.

/** Pull the members out of an `export type NAME = | 'a' | 'b';` declaration. */
function unionMembers(source: string, name: string): string[] {
  // Line comments go first. Every member of these unions is documented inline,
  // and one of those comments contains a semicolon ("every test ran; per-test
  // statuses are authoritative") — which terminated the match after a single
  // member and made the assertion fail against a correct table.
  const code = source.replace(/\/\/[^\n]*/g, '');
  const m = code.match(new RegExp(`export type ${name} =([^;]*);`));
  if (!m) {
    throw new Error(
      `Could not find the ${name} union in functions/src/judgeCore.ts. It was `
      + 'renamed or reshaped — update this test deliberately rather than '
      + 'deleting the assertion, because the twin it guards is still a twin.',
    );
  }
  return Array.from(m[1].matchAll(/'([^']+)'/g)).map((x) => x[1]);
}

describe('judge verdict vocabulary — server types, client labels', () => {
  it('RUN_STATUS_LABEL names every RunStatus the server can emit', () => {
    expect(Object.keys(RUN_STATUS_LABEL).sort())
      .toEqual(unionMembers(serverJudge, 'RunStatus').sort());
  });

  it('TEST_STATUS_LABEL names every TestStatus the server can emit', () => {
    expect(Object.keys(TEST_STATUS_LABEL).sort())
      .toEqual(unionMembers(serverJudge, 'TestStatus').sort());
  });

  it('MAX_JUDGE_ATTEMPTS matches the retry budget the sweep enforces', () => {
    // The client shows "attempts N of MAX" and decides whether to say the
    // runner gave up. A stale copy tells a reviewer a paper is still coming
    // when the sweep stopped trying, or the reverse.
    const m = serverJudge.match(/export const MAX_JUDGE_ATTEMPTS = (\d+)/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBe(MAX_JUDGE_ATTEMPTS);
  });

  it('the verdict document id is built the same way on both sides', () => {
    // A mismatch here does not error — it silently reads a document that does
    // not exist, and every coding answer renders as "no run recorded yet".
    const server = serverIndex.match(
      /export function codeVerdictDocId\([^)]*\): string \{\s*return `([^`]+)`;/,
    );
    expect(server).toBeTruthy();
    expect(server![1]).toBe('${attemptId}__${questionId}');
    expect(codeVerdictDocId('att1', 'q1')).toBe('att1__q1');
  });
});

describe('operator detail stays on the staff side', () => {
  // The roster's run panel now renders verdict.failureReason, because it is
  // the only field that distinguishes an unreachable cluster from a rate limit
  // from a question authored with no tests — all three arrive as the same
  // `judge_unavailable` label.
  //
  // That is safe only for as long as the field cannot reach a candidate. It
  // names the adapter and the transport, and on this deployment it carries the
  // judge's private address. Two independent things keep it staff-side and
  // both are asserted here.

  it('redactForCandidate drops failureReason', () => {
    const fn = serverJudge
      .replace(/\/\/[^\n]*/g, '')
      .match(/export function redactForCandidate[\s\S]*?\n\}/)?.[0];
    expect(fn).toBeTruthy();
    expect(fn).not.toMatch(/failureReason/);
  });

  it('the student results page never mentions it', () => {
    // The other half: even with a correct redaction, a surface that fetched a
    // raw verdict could render it. The student page must not reference the
    // field at all — nor the collection it lives in, other than to say so.
    const studentPage = read('src/app/pages/student/ExamResultsPage.tsx');
    expect(studentPage).not.toMatch(/failureReason/);
    expect(studentPage).not.toMatch(/getCodeVerdicts/);
  });
});

describe('the answer discriminant has exactly one writer', () => {
  const examShell = read('src/app/pages/student/ExamShell.tsx');
  const submission = read('src/lib/submissionService.ts');

  it('ExamShell derives it from the taxonomy', () => {
    expect(examShell).toMatch(/answerTypeForEngine\(/);
  });

  it('ExamShell does not hand-roll it from a ternary', () => {
    // Anchored on the SHAPE of the defect rather than its exact text: any
    // ternary branching on an engine literal is how the second copy comes
    // back. If a future ternary over `.engine` is genuinely unrelated to the
    // answer type, narrow this assertion rather than deleting it.
    expect(examShell).not.toMatch(/\.engine === '(?:mcq|text|match|code)'\s*\?/);
  });

  it('AttemptAnswer.type is the alias, not a fourth copy of the union', () => {
    expect(submission).toMatch(/type:\s*AnswerDiscriminant/);
    expect(submission).not.toMatch(/type:\s*'mcq'\s*\|/);
  });
});
