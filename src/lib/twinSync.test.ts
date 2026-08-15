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
import { auditActionLabel } from './deletionAudit';
import { codeVerdictDocId, DEFAULT_QUESTION_GRACE_SECONDS } from './submissionService';
import { HIERARCHY_COLLECTIONS } from './lifecycleService';
import { JUDGE_LANGUAGES } from '../app/components/exam/judgeTypes';

const root = path.resolve(__dirname, '../..');
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

const serverIndex = read('functions/src/index.ts');
const serverJudge = read('functions/src/judgeCore.ts');
const serverTiming = read('functions/src/examTimingCore.ts');
// The rules are a THIRD build with its own language, and they carry twins too —
// see the hierarchy-lifecycle block below. Nothing else in the repo typechecks
// against them, so reading them as text here is not a shortcut, it is the only
// mechanism available.
const rules = read('firestore.rules');

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

/** Pull the members out of a `type NAME = | 'a' | 'b';` declaration. */
function unionMembers(source: string, name: string): string[] {
  // Line comments go first. Every member of these unions is documented inline,
  // and one of those comments contains a semicolon ("every test ran; per-test
  // statuses are authoritative") — which terminated the match after a single
  // member and made the assertion fail against a correct table.
  const code = source.replace(/\/\/[^\n]*/g, '');
  // `export` optional: AuditActionS is module-private on the server.
  const m = code.match(new RegExp(`(?:export )?type ${name} =([^;]*);`));
  if (!m) {
    throw new Error(
      `Could not find the ${name} union in the functions source. It was `
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

describe('audit actions — the server writes them, the client renders them', () => {
  // Found already drifted: the server had been writing attemptFrozen,
  // attemptUnfrozen, attemptGradedProvisional and attemptRewritten rows since
  // Phase 4 and the client union named none of them. Nothing failed, because
  // auditActionLabel falls through to the raw action — so a trail of decisions
  // about someone's exam rendered as `attemptGradedProvisional` in the one
  // view that exists for a person to read.

  it('every server action has a client label', () => {
    const server = unionMembers(serverIndex, 'AuditActionS');
    expect(server.length).toBeGreaterThan(0);
    for (const action of server) {
      // Not just "is in the union" — the label must not be the fallthrough,
      // which is what made the drift invisible in the first place.
      expect(auditActionLabel(action as Parameters<typeof auditActionLabel>[0]))
        .not.toBe(action);
    }
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

// ══════════════════════════════════════════════════════════════════
// THE HIERARCHY LIFECYCLE — a twin that spans THREE builds
// ══════════════════════════════════════════════════════════════════
//
// Added with the F-4 fix, and guarded in the same change rather than later,
// because the whole argument of this file is that a "keep in sync" comment is
// not a mechanism. Two of the three twins below were created by that fix; not
// pinning them would have been the exact mistake it was correcting.
//
// The second one is the security-critical twin in this repository, because it
// is the only one where the two copies live in different LANGUAGES and neither
// build can see the other. TypeScript cannot check a rules file, and the rules
// engine cannot check TypeScript.

describe('hierarchy lifecycle — the collection list', () => {
  const server = (() => {
    const m = serverIndex.match(/const HIERARCHY_COLLECTIONS = \[([\s\S]*?)\] as const;/);
    if (!m) {
      throw new Error(
        'Could not find HIERARCHY_COLLECTIONS in functions/src/index.ts. It was '
        + 'renamed or reshaped — update this test deliberately rather than '
        + 'deleting the assertion, because the twin it guards is still a twin.',
      );
    }
    return Array.from(m[1].matchAll(/'([^']+)'/g)).map((x) => x[1]);
  })();

  it('the client list matches the server list exactly', () => {
    // Drift is silent in BOTH directions and neither is a type error. A
    // collection the client offers and the server does not accept fails the
    // archive with "Unknown hierarchy collection", which reads as a backend
    // fault. One the server accepts and the client omits is a level of the
    // hierarchy that simply cannot be archived, with no error at all — the
    // button works everywhere except there.
    expect([...HIERARCHY_COLLECTIONS].sort()).toEqual([...server].sort());
  });

  it('SchoolsTab can name a collection for every drill level', () => {
    // The third copy. COLLECTION_BY_LEVEL is what turns a UI level into the
    // argument the callable takes; a missing arm is a TypeScript error, but a
    // WRONG arm is not, and it would archive a node in the wrong collection.
    const tab = read('src/app/components/schools/SchoolsTab.tsx');
    const m = tab.match(/const COLLECTION_BY_LEVEL: Record<NodeLevel, HierarchyCollection> = \{([\s\S]*?)\};/);
    expect(m).toBeTruthy();
    const mapped = Array.from(m![1].matchAll(/'([^']+)'/g)).map((x) => x[1]);
    expect([...mapped].sort()).toEqual([...server].sort());
  });
});

describe('hierarchy lifecycle — the rules fence covers what the callable writes', () => {
  // THE ONE THAT MATTERS. setHierarchyNodeLifecycle exists so that archiving a
  // node writes an audit row and honours schoolsManagementEnabled; the rules
  // fence exists so a client cannot skip it by patching the node directly.
  //
  // The fence is a LITERAL LIST of field names in a different language. If the
  // callable ever starts writing a seventh lifecycle field and the rules list
  // is not updated with it, that field becomes forgeable from any staff
  // console — and nothing fails. The audit row still gets written for real
  // archives, the tests still pass, and the only symptom is a field that can
  // be set by someone who should not be able to set it.

  const written = (() => {
    const fn = serverIndex.match(
      /export const setHierarchyNodeLifecycle = onCall<[\s\S]*?batch\.update\(ref, \{([\s\S]*?)\}\);/,
    );
    if (!fn) {
      throw new Error(
        'Could not find the batch.update inside setHierarchyNodeLifecycle. It '
        + 'was renamed or reshaped — update this test deliberately rather than '
        + 'deleting the assertion, because the twin it guards is still a twin.',
      );
    }
    return Array.from(fn[1].matchAll(/^\s{4}([a-zA-Z]+):/gm)).map((x) => x[1]);
  })();

  const fenced = (() => {
    const m = rules.match(/function hierarchyLifecycleUntouched\(\) \{[\s\S]*?hasAny\(\[([\s\S]*?)\]\);/);
    if (!m) {
      throw new Error(
        'Could not find hierarchyLifecycleUntouched in firestore.rules. It was '
        + 'renamed or reshaped — update this test deliberately rather than '
        + 'deleting the assertion, because the twin it guards is still a twin.',
      );
    }
    return Array.from(m[1].matchAll(/'([^']+)'/g)).map((x) => x[1]);
  })();

  // `updatedAt` is written by the callable and deliberately NOT fenced: a
  // rename sets it too, and fencing it would deny every legitimate direct edit.
  // Named explicitly so that adding a second exception has to be a decision
  // someone writes down here, rather than a silent widening of the gap.
  const DELIBERATELY_UNFENCED = new Set(['updatedAt']);

  it('finds both sides', () => {
    expect(written.length).toBeGreaterThan(0);
    expect(fenced.length).toBeGreaterThan(0);
  });

  it('every lifecycle field the callable writes is fenced in the rules', () => {
    const shouldBeFenced = written.filter((k) => !DELIBERATELY_UNFENCED.has(k));
    for (const key of shouldBeFenced) {
      expect(
        fenced,
        `${key} is written by setHierarchyNodeLifecycle but is not in `
        + 'hierarchyLifecycleUntouched(), so a client can set it directly',
      ).toContain(key);
    }
  });

  it('the rules do not fence a field the callable never writes', () => {
    // The reverse drift. Harmless to security, but it denies a write nobody
    // is making — and a fence around a field that no longer exists is how a
    // list stops being read as load-bearing.
    for (const key of fenced) {
      expect(
        written,
        `${key} is fenced in firestore.rules but setHierarchyNodeLifecycle `
        + 'does not write it — the fence has outlived its field',
      ).toContain(key);
    }
  });
});

describe('question grace — one default, two builds', () => {
  it('the client default matches examTimingCore', () => {
    // examTimingCore's own header calls this out: index.ts used to hardcode the
    // question grace as a bare `5` in two places, so a per-assessment override
    // was honoured by the resolver and ignored by the two functions that flag a
    // late answer. The server copies were unified; this is the client one, and
    // it decides whether the shell submits an answer it believes is still in
    // time.
    const m = serverTiming.match(/export const DEFAULT_QUESTION_GRACE_SECONDS = (\d+)/);
    expect(m).toBeTruthy();
    expect(Number(m![1])).toBe(DEFAULT_QUESTION_GRACE_SECONDS);
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
