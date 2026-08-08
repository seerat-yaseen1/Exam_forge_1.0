/**
 * The judge vocabulary, client side.
 *
 * A deliberate twin of the language list in functions/src/judgeCore.ts rather
 * than an import: this project ships the client and the functions as separate
 * TypeScript builds with no shared package, and the existing convention for
 * that is a twin with a keep-in-sync note (see resolveGradingPolicy and its
 * server twin). Keep in EXACT sync — a language present here and absent there
 * is a language the picker offers and the judge rejects.
 */

export type JudgeLanguage =
  | 'python3'
  | 'javascript'
  | 'typescript'
  | 'java'
  | 'c'
  | 'cpp'
  | 'csharp'
  | 'go'
  | 'rust'
  | 'kotlin'
  | 'php'
  | 'ruby'
  | 'sql';

export const JUDGE_LANGUAGES: readonly JudgeLanguage[] = [
  'python3', 'javascript', 'typescript', 'java', 'c', 'cpp',
  'csharp', 'go', 'rust', 'kotlin', 'php', 'ruby', 'sql',
];

export const JUDGE_LANGUAGE_LABEL: Record<JudgeLanguage, string> = {
  python3:    'Python 3',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  java:       'Java',
  c:          'C',
  cpp:        'C++',
  csharp:     'C#',
  go:         'Go',
  rust:       'Rust',
  kotlin:     'Kotlin',
  php:        'PHP',
  ruby:       'Ruby',
  sql:        'SQL',
};

/** One visible test result, as the server's redacted verdict reports it. */
export interface CandidateTestResult {
  testId: string;
  status: 'passed' | 'wrong_answer' | 'timeout' | 'runtime_error'
        | 'memory_exceeded' | 'output_exceeded' | 'skipped';
  timeMs?: number;
  memoryKb?: number;
  stdout?: string;
  stderr?: string;
}

/** The verdict shape runCodeSample returns — hidden tests already stripped. */
export interface CandidateVerdict {
  status: 'completed' | 'compile_error' | 'judge_unavailable' | 'internal_error';
  compileMessage?: string;
  results: CandidateTestResult[];
  hiddenCount: number;
  judgedAt: string;
}

/** The full response from the runCodeSample callable. */
export type SampleRunResponse =
  | { ok: true; verdict: CandidateVerdict; remaining: number; judgeAvailable: boolean }
  | {
      ok: false;
      reason: 'disabled' | 'quota_exhausted' | 'cooling_down' | 'no_samples';
      remaining: number;
      retryAfterMs: number;
    };

export const TEST_STATUS_LABEL: Record<CandidateTestResult['status'], string> = {
  passed:          'Passed',
  wrong_answer:    'Wrong output',
  timeout:         'Timed out',
  runtime_error:   'Runtime error',
  memory_exceeded: 'Out of memory',
  output_exceeded: 'Too much output',
  skipped:         'Not run',
};
