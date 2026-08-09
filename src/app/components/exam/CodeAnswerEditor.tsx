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
  MAX_EVENTS,
  bound,
  compact,
  type TelemetryEvent,
} from '../../../lib/codeTelemetry';
import {
  answerFrom,
  bufferForLanguage,
  initialLanguage,
  isUnmodifiedStarter,
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
  /**
   * Flushes a batch of telemetry. Absent means DO NOT RECORD — the shell only
   * supplies it when the tier permits, so an editor with no sink captures
   * nothing rather than buffering a recording that goes nowhere.
   */
  onTelemetry?: (events: TelemetryEvent[], seq: number) => void;
}

/**
 * One labelled block of sample text.
 *
 * `pre` with `whitespace-pre`, not `pre-wrap`: for a sample, the whitespace IS
 * the data. "5 7" and "5\n7" are different inputs and a candidate debugging a
 * parse needs to see which one they were given, so the block scrolls sideways
 * rather than re-flowing. An empty string is rendered as a marker rather than
 * as nothing, because "expected: nothing" and "expected: I forgot to fill this
 * in" look identical when both render as blank.
 */
function SampleField({
  label, value, tone,
}: { label: string; value?: string; tone?: 'bad' }) {
  if (value === undefined) return null;
  return (
    <div className="min-w-0">
      <p className="text-xs opacity-50 mb-0.5">{label}</p>
      <pre
        className="text-xs rounded border px-2 py-1 overflow-x-auto"
        style={{
          whiteSpace: 'pre', margin: 0, maxHeight: 140, overflowY: 'auto',
          opacity: tone === 'bad' ? 0.9 : 0.75,
        }}
      >
        {value === '' ? '(empty)' : value}
      </pre>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────

export function CodeAnswerEditor({
  questionId,
  codeSpec,
  value,
  onChange,
  disabled = false,
  onRun,
  onTelemetry,
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
  const viewRef = useRef<{ destroy: () => void;
                           state: { doc: { toString(): string; length: number } };
                           dispatch: (t: unknown) => void } | null>(null);

  // Latest onChange without re-creating the editor on every parent render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const specRef = useRef(codeSpec);
  specRef.current = codeSpec;
  const langRef = useRef(language);
  langRef.current = language;

  // ── Telemetry buffer ────────────────────────────────────────────
  //
  // Buffered in a ref rather than state: an edit event on every keystroke
  // would re-render the component on every keystroke, which is a real cost in
  // an editor and buys nothing — nothing on screen shows the buffer.
  //
  // The clock is relative to when this editor mounted, so the record survives
  // a device clock that is wrong or is changed mid-exam.
  const startedAtRef = useRef<number>(Date.now());
  const bufferRef = useRef<TelemetryEvent[]>([]);
  const seqRef = useRef(0);
  const onTelemetryRef = useRef(onTelemetry);
  onTelemetryRef.current = onTelemetry;

  const now = () => Date.now() - startedAtRef.current;

  const record = useCallback((e: TelemetryEvent) => {
    // No sink means no recording. The shell withholds onTelemetry when the
    // tier forbids it, so this is where "practice is never recorded" actually
    // takes effect on the client.
    if (!onTelemetryRef.current) return;
    bufferRef.current.push(e);
    // Hard stop rather than unbounded growth. A runaway buffer in an exam tab
    // is a memory problem for the candidate, which is a far worse outcome than
    // an incomplete recording.
    if (bufferRef.current.length > MAX_EVENTS) {
      bufferRef.current = bufferRef.current.slice(-MAX_EVENTS);
    }
  }, []);

  const flush = useCallback(() => {
    const sink = onTelemetryRef.current;
    if (!sink || bufferRef.current.length === 0) return;
    // Compact BEFORE sending: a run of typing becomes one event carrying its
    // duration, which is both smaller and more informative than the keystrokes
    // it replaces.
    const { events } = bound(compact(bufferRef.current));
    bufferRef.current = [];
    sink(events, seqRef.current++);
  }, []);

  // The opening keyframe. Without it replay has no starting document — the
  // editor already contains starter code that no edit event ever produced, so
  // every reconstruction would begin from the wrong text.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!onTelemetry || seededRef.current) return;
    seededRef.current = true;
    record({ k: 'lang', t: now(), to: langRef.current, doc: source });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onTelemetry, record]);

  // Periodic flush. Thirty seconds bounds how much is lost if the tab dies,
  // without turning a writing session into a stream of requests.
  useEffect(() => {
    if (!onTelemetry) return;
    const id = setInterval(flush, 30_000);
    return () => { clearInterval(id); flush(); };
  }, [onTelemetry, flush]);

  // Focus and blur are recorded because leaving the editor mid-question is
  // exactly the kind of thing a reviewer looks for — and exactly the kind of
  // thing that is innocent most of the time, which is why it is a count in a
  // summary and never a verdict.
  useEffect(() => {
    if (!onTelemetry) return;
    const onBlur = () => record({ k: 'blur', t: now() });
    const onFocus = () => record({ k: 'focus', t: now() });
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onTelemetry, record]);

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
        EditorView.updateListener.of((update: {
          docChanged: boolean;
          state: { doc: { toString(): string } };
          changes?: { iterChanges?: (fn: (fromA: number, toA: number, fromB: number, toB: number, inserted: { toString(): string }) => void) => void };
        }) => {
          if (!update.docChanged) return;
          // One event per change range, with its text. This is the unit replay
          // needs; compaction merges the typing runs on the way out.
          update.changes?.iterChanges?.((fromA: number, toA: number, _fB: number, _tB: number, inserted: { toString(): string }) => {
            record({ k: 'edit', t: now(), from: fromA, to: toA, text: inserted.toString() });
          });
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
        // FILL THE HOST, and scroll inside itself.
        //
        // CodeMirror sizes to its content by default, which is right in a
        // stacked column and wrong in a split pane: without this the editor
        // grows past the bottom of the viewport as the candidate types, the
        // whole page scrolls instead of the code, and the toolbar with the Run
        // button leaves the screen. `height: 100%` on the editor plus overflow
        // on the scroller is the CM6 recipe for "fill what you are given".
        //
        // Harmless where there is nothing to fill: the host keeps minHeight
        // 240 and no definite height, so 100% resolves to the content height
        // and the stacked layout behaves as it always did.
        EditorView.theme({
          '&': { height: '100%' },
          '.cm-scroller': { overflow: 'auto' },
        }),
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
    // Carries the buffer, because a switch replaces the whole document and
    // replay has no other way to learn what it was replaced with.
    record({ k: 'lang', t: now(), to: next, doc: buffer });
    setLanguage(next);
    setSource(buffer);
    // The stored answer follows the visible buffer immediately, so a candidate
    // who switches language and submits is graded on what they can see.
    onChange(answerFrom(next, buffer, codeSpec) ?? { language: next, source: '' });
    setVerdict(null);
    setRunNotice(null);
  }, [language, source, codeSpec, onChange]);

  // ── Reset to the starter ────────────────────────────────────────
  //
  // TWO CLICKS, DELIBERATELY. This destroys work, it sits inches from the Run
  // button a candidate presses repeatedly, and there is no undo they will
  // think of under time pressure. A native confirm() is not the answer either:
  // it blocks, a kiosk browser may suppress it, and a modal over an exam reads
  // as something having gone wrong.
  //
  // The armed state disarms itself after a few seconds, so a stray click
  // cannot leave a live confirmation for a second stray click to complete
  // minutes later.
  const [armed, setArmed] = useState(false);
  const disarmRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (disarmRef.current) clearTimeout(disarmRef.current); }, []);

  const disarm = useCallback(() => {
    if (disarmRef.current) clearTimeout(disarmRef.current);
    disarmRef.current = null;
    setArmed(false);
  }, []);

  const resetToStarter = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    const starter = starterFor(specRef.current, langRef.current);

    // BEFORE the change, so the replacement that follows can be recognised as
    // a reset rather than reported as a paste-shaped insertion.
    record({ k: 'reset', t: now() });

    // Dispatched into CodeMirror rather than set through React state: the view
    // is only rebuilt when the LANGUAGE changes, so a state update alone would
    // leave the editor showing the old buffer while everything else believed
    // it had been reset.
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: starter },
    });

    // The per-language draft has to go too, or switching away and back would
    // restore the work the candidate just discarded.
    draftsRef.current[langRef.current] = starter;
    setVerdict(null);
    setRunNotice(null);
    disarm();
    // The editor's own change listener does the rest — it records the edit,
    // updates `source`, and calls onChange, which resolves to "unanswered"
    // because the buffer now matches the starter again.
  }, [record, disarm]);

  const onResetClick = useCallback(() => {
    if (armed) { resetToStarter(); return; }
    setArmed(true);
    if (disarmRef.current) clearTimeout(disarmRef.current);
    disarmRef.current = setTimeout(() => setArmed(false), 4000);
  }, [armed, resetToStarter]);

  // Nothing to put back. Also the state a candidate is in before they have
  // typed anything, where the button would only invite a misclick.
  const atStarter = isUnmodifiedStarter(source, starterFor(codeSpec, language));

  // ── Run ─────────────────────────────────────────────────────────
  const run = useCallback(async () => {
    if (!onRun || running) return;
    setRunning(true);
    setRunNotice(null);
    record({ k: 'run', t: now() });
    // Flush on run: it is a natural checkpoint, and it means a session that
    // ends in a crash still has everything up to the last thing the candidate
    // deliberately did.
    flush();
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
    // `h-full min-h-0` so the editor can FILL a split-pane column instead of
    // sitting at its minimum with the rest of the column empty. In the stacked
    // layout (phones, and inside the authoring preview) there is no height to
    // fill and the flex column collapses to its content exactly as before, so
    // one tree serves both.
    <div className="flex flex-col gap-3 h-full" style={{ minHeight: 0 }}>
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

        {/* Pushed to the far end, away from Run. The two buttons do opposite
            things and one of them cannot be undone. */}
        <button
          type="button"
          className="text-sm rounded px-3 py-1 border disabled:opacity-40 ml-auto"
          onClick={onResetClick}
          onBlur={disarm}
          disabled={locked || !ready || atStarter}
          title={atStarter
            ? 'The editor already holds the starter code'
            : 'Replace your code with the starter code for this language'}
          style={armed
            ? { borderColor: 'var(--ef-danger)', color: 'var(--ef-danger)' }
            : undefined}
        >
          {armed ? 'Discard my code?' : 'Reset'}
        </button>
      </div>

      {armed && (
        <p className="text-xs" style={{ color: 'var(--ef-danger)' }}>
          This replaces everything you have written for{' '}
          {JUDGE_LANGUAGE_LABEL[language]} with the starter code. Click again to
          confirm, or click away to cancel.
        </p>
      )}

      {/* ── Editor ──
          data-exam-code-editor is what IntegrityEngine keys its clipboard
          exemption on. It belongs on this wrapper and nowhere else. */}
      <div
        {...{ [CODE_EDITOR_ATTR]: 'true' }}
        ref={hostRef}
        className="rounded border overflow-hidden text-sm flex-1"
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
                {/* The author's note for this sample, when they wrote one. */}
                {r.label && (
                  <p className="mt-1 text-xs opacity-70">{r.label}</p>
                )}

                {/* THE TEST ITSELF.
                    A sample the candidate cannot read only tells them they are
                    wrong, which is the one thing they already knew. Input and
                    expected output are public for a visible test by
                    definition — that is what "visible" means — and shown on a
                    pass too, because a candidate checking their understanding
                    of the input format needs them exactly as much when the
                    test passes. */}
                {(r.stdin !== undefined || r.expected !== undefined) && (
                  <div className="mt-1.5 grid gap-1.5" style={{ gridTemplateColumns: '1fr 1fr' }}>
                    <SampleField label="Input" value={r.stdin} />
                    <SampleField label="Expected output" value={r.expected} />
                  </div>
                )}

                {/* Actual output, beside the expected it failed to match. */}
                {r.status !== 'passed' && r.stdout !== undefined && (
                  <div className="mt-1.5">
                    <SampleField label="Your output" value={r.stdout} tone="bad" />
                  </div>
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
