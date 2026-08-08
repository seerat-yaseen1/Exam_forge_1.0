/**
 * CODE ANSWER EDITOR — what a candidate writes a coding answer in
 *
 * CodeMirror 6, loaded lazily. The exam bundle already carries KaTeX and the
 * repo already defers xlsx (~142 KB gzip) on exactly this reasoning: an editor
 * and eight language grammars have no business being downloaded by a candidate
 * sitting an MCQ paper. Nothing here is imported statically — the whole editor
 * arrives on first render of a coding question.
 *
 * The decisions this component makes about ANSWERS live in codeAnswer.ts,
 * where the suite can reach them. What is left here is the editor itself, the
 * run button and the results panel.
 *
 * ── THE TWO THINGS THIS FILE MUST NOT GET WRONG ───────────────────
 *
 * 1. The wrapper carries data-exam-code-editor. IntegrityEngine keys its
 *    clipboard exemption on that attribute, so an editor without it fires a
 *    paste violation on every ordinary edit; an element with it that is NOT an
 *    answer editor would open a hole in the exam's clipboard policy. It goes
 *    on the wrapper and nowhere else.
 *
 * 2. An untouched question reports NO answer. While the buffer still matches
 *    the starter, onChange receives an empty source, which isAnswered reads as
 *    unanswered and the server treats as a blank rather than as work to judge.
 *    Nothing else in the app needs to know starter code exists.
 *
 *    Note that the editor writes nothing at all on mount — the listener fires
 *    only on docChanged — so a question the candidate never opens has no answer
 *    document, not an empty one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CODE_EDITOR_ATTR,
} from './IntegrityEngine';
import {
  JUDGE_LANGUAGES,
  JUDGE_LANGUAGE_LABEL,
  TEST_STATUS_LABEL,
  type CandidateVerdict,
  type JudgeLanguage,
  type SampleRunResponse,
} from './judgeTypes';
import {
  answerFrom,
  bufferForLanguage,
  initialLanguage,
  resolveLanguages,
  runSummary,
  starterFor,
  type CodeAnswerValue,
  type CodeSpec,
} from './codeAnswer';

// ── Lazy CodeMirror ───────────────────────────────────────────────
//
// One dynamic import for the editor core, one per language grammar, both
// cached. A candidate who never opens a coding question downloads neither.

type CmModule = typeof import('codemirror');
let cmCore: Promise<CmModule> | null = null;
const loadCore = (): Promise<CmModule> => (cmCore ??= import('codemirror'));

const grammarLoaders: Partial<Record<JudgeLanguage, () => Promise<unknown>>> = {
  python3:    () => import('@codemirror/lang-python').then((m) => m.python()),
  javascript: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  typescript: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  java:       () => import('@codemirror/lang-java').then((m) => m.java()),
  c:          () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  cpp:        () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  csharp:     () => import('@codemirror/lang-java').then((m) => m.java()),   // closest available grammar
  go:         () => import('@codemirror/lang-go').then((m) => m.go()),
  rust:       () => import('@codemirror/lang-rust').then((m) => m.rust()),
  php:        () => import('@codemirror/lang-php').then((m) => m.php()),
  sql:        () => import('@codemirror/lang-sql').then((m) => m.sql()),
  // kotlin and ruby have no first-party CM6 grammar. They load with no
  // highlighting rather than not loading at all — a plain editor is a working
  // editor, and refusing the language would make the question unanswerable.
};

// ── Props ─────────────────────────────────────────────────────────

interface CodeAnswerEditorProps {
  questionId: string;
  codeSpec?: CodeSpec;
  /** The stored answer, if the candidate has one. */
  value?: CodeAnswerValue | null;
  /**
   * Receives `{ language, source: '' }` when the question is not answered —
   * an untouched starter, or an editor the candidate has emptied.
   *
   * An empty source rather than null because the renderer's onAnswer channel
   * carries AnswerValue and has no "no answer" arm. Both sides read it the same
   * way: isAnswered treats empty source as unanswered, and the server treats it
   * as a blank rather than as something to judge.
   */
  onChange: (value: CodeAnswerValue) => void;
  /** Locked during freezes, after submission, and while a run is in flight. */
  disabled?: boolean;
  /** Runs the visible tests. Wired to the runCodeSample callable by the shell. */
  onRun?: (language: JudgeLanguage, source: string) => Promise<SampleRunResponse>;
}

// ── Component ─────────────────────────────────────────────────────

export function CodeAnswerEditor({
  questionId,
  codeSpec,
  value,
  onChange,
  disabled = false,
  onRun,
}: CodeAnswerEditorProps) {
  const languages = useMemo(
    () => resolveLanguages(codeSpec, JUDGE_LANGUAGES), [codeSpec]);

  const [language, setLanguage] = useState<JudgeLanguage>(
    () => initialLanguage(codeSpec, value, JUDGE_LANGUAGES));

  // Per-language drafts, so switching away and back does not destroy work.
  const draftsRef = useRef<Record<string, string>>({});
  const [source, setSource] = useState<string>(() =>
    value?.source ?? starterFor(codeSpec, initialLanguage(codeSpec, value, JUDGE_LANGUAGES)));

  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [verdict, setVerdict] = useState<CandidateVerdict | null>(null);
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);

  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<{ destroy: () => void; state: { doc: { toString(): string } };
                           dispatch: (t: unknown) => void } | null>(null);

  // Latest onChange without re-creating the editor on every parent render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const specRef = useRef(codeSpec);
  specRef.current = codeSpec;
  const langRef = useRef(language);
  langRef.current = language;

  // ── Build the editor ────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    let view: { destroy: () => void } | null = null;

    (async () => {
      const [{ EditorView, basicSetup }, grammar] = await Promise.all([
        loadCore(),
        grammarLoaders[language]?.().catch(() => null) ?? Promise.resolve(null),
      ]);
      if (cancelled || !hostRef.current) return;

      const extensions: unknown[] = [
        basicSetup,
        EditorView.updateListener.of((update: { docChanged: boolean;
                                                state: { doc: { toString(): string } } }) => {
          if (!update.docChanged) return;
          const next = update.state.doc.toString();
          draftsRef.current[langRef.current] = next;
          setSource(next);
          // THE STARTER CONTRACT. While the buffer still matches what the
          // question supplied, this question has no answer at all.
          onChangeRef.current(
            answerFrom(langRef.current, next, specRef.current)
            ?? { language: langRef.current, source: '' },
          );
        }),
        EditorView.editable.of(!disabled),
      ];
      if (grammar) extensions.push(grammar);

      view = new EditorView({
        doc: source,
        extensions: extensions as never,
        parent: hostRef.current,
      });
      viewRef.current = view as never;
      if (!cancelled) setReady(true);
    })();

    return () => {
      cancelled = true;
      view?.destroy();
      viewRef.current = null;
    };
    // Rebuilt on language change (the grammar is an extension) and on lock
    // state. `source` is intentionally NOT a dependency: it is the editor's
    // own output, and re-running on it would rebuild on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, disabled, questionId]);

  // ── Language switch ─────────────────────────────────────────────
  const switchLanguage = useCallback((next: JudgeLanguage) => {
    if (next === language) return;
    draftsRef.current[language] = source;
    const buffer = bufferForLanguage(next, draftsRef.current, codeSpec);
    setLanguage(next);
    setSource(buffer);
    // The stored answer follows the visible buffer immediately, so a candidate
    // who switches language and submits is graded on what they can see.
    onChange(answerFrom(next, buffer, codeSpec) ?? { language: next, source: '' });
    setVerdict(null);
    setRunNotice(null);
  }, [language, source, codeSpec, onChange]);

  // ── Run ─────────────────────────────────────────────────────────
  const run = useCallback(async () => {
    if (!onRun || running) return;
    setRunning(true);
    setRunNotice(null);
    try {
      const res = await onRun(language, source);
      setRemaining(res.remaining);
      if (!res.ok) {
        setRunNotice(
          res.reason === 'quota_exhausted' ? 'You have used all your runs for this question.'
          : res.reason === 'cooling_down'  ? `Please wait ${Math.ceil(res.retryAfterMs / 1000)}s before running again.`
          : res.reason === 'disabled'      ? 'Running code is turned off for this exam.'
          : 'This question has no sample tests to run.',
        );
        return;
      }
      setVerdict(res.verdict);
      if (!res.judgeAvailable) {
        // NEVER phrased as a failure of their code. The judge being down says
        // nothing about the answer, and their submission is marked from the
        // hidden tests later whether or not they ever ran it.
        setRunNotice('The code runner is temporarily unavailable. Your answer is saved and will still be marked.');
      }
    } catch {
      setRunNotice('Could not reach the code runner. Your answer is saved and will still be marked.');
    } finally {
      setRunning(false);
    }
  }, [onRun, running, language, source]);

  const locked = disabled || running;

  return (
    <div className="flex flex-col gap-3">
      {/* ── Toolbar ── */}
      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-sm opacity-70" htmlFor={`lang-${questionId}`}>Language</label>
        <select
          id={`lang-${questionId}`}
          className="text-sm rounded border px-2 py-1"
          value={language}
          disabled={locked}
          onChange={(e) => switchLanguage(e.target.value as JudgeLanguage)}
        >
          {languages.map((l) => (
            <option key={l} value={l}>{JUDGE_LANGUAGE_LABEL[l]}</option>
          ))}
        </select>

        {onRun && (
          <>
            <button
              type="button"
              className="text-sm rounded px-3 py-1 border disabled:opacity-50"
              onClick={run}
              disabled={locked || !ready}
            >
              {running ? 'Running…' : 'Run sample tests'}
            </button>
            {remaining !== null && (
              <span className="text-xs opacity-60">{remaining} runs left</span>
            )}
          </>
        )}
      </div>

      {/* ── Editor ──
          data-exam-code-editor is what IntegrityEngine keys its clipboard
          exemption on. It belongs on this wrapper and nowhere else. */}
      <div
        {...{ [CODE_EDITOR_ATTR]: 'true' }}
        ref={hostRef}
        className="rounded border overflow-hidden text-sm"
        style={{ minHeight: 240 }}
      >
        {!ready && (
          <div className="p-4 text-sm opacity-60">Loading editor…</div>
        )}
      </div>

      {/* ── Run feedback ── */}
      {runNotice && (
        <div className="text-sm rounded border px-3 py-2 opacity-90">{runNotice}</div>
      )}

      {verdict && verdict.status === 'compile_error' && (
        <div className="text-sm rounded border px-3 py-2">
          <div className="font-medium mb-1">Your program did not compile</div>
          <pre className="whitespace-pre-wrap text-xs opacity-80">{verdict.compileMessage}</pre>
        </div>
      )}

      {verdict && verdict.status === 'completed' && (
        <div className="text-sm rounded border">
          <div className="px-3 py-2 border-b font-medium">
            {runSummary(verdict.results, verdict.hiddenCount)}
          </div>
          <ul className="divide-y">
            {verdict.results.map((r, i) => (
              <li key={r.testId} className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">
                    {r.status === 'passed' ? '✓' : '✗'} Sample {i + 1}
                  </span>
                  <span className="text-xs opacity-60">{TEST_STATUS_LABEL[r.status]}</span>
                  {r.timeMs !== undefined && (
                    <span className="text-xs opacity-50">{r.timeMs} ms</span>
                  )}
                </div>
                {r.status !== 'passed' && r.stdout !== undefined && (
                  <pre className="mt-1 text-xs whitespace-pre-wrap opacity-80">
                    Your output: {r.stdout || '(nothing)'}
                  </pre>
                )}
                {r.stderr && (
                  <pre className="mt-1 text-xs whitespace-pre-wrap opacity-60">{r.stderr}</pre>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export default CodeAnswerEditor;
