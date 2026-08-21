/**
 * CODE SPEC EDITOR — authoring a coding question
 *
 * Two halves that are stored in two different places for one reason:
 *
 *   codeSpec  → the QUESTION document. Languages, starter code and limits are
 *               all shown to the candidate; none of it is the answer.
 *   tests     → the QUESTION ANSWER document, beside correctIds. The hidden
 *               suite IS the answer key, and a test on the public document
 *               ships to every browser inside the exam payload.
 *
 * The split is enforced in questionBankService (ANSWER_KEYS), not here — this
 * component just hands both halves up. But it is the reason the test list is
 * visually separated from everything else, rather than being one long form.
 *
 * The rules that decide whether a question is answerable and gradable live in
 * lib/codeAuthoring.ts, where the suite can reach them.
 */

import { useMemo } from 'react';
import { Plus, Trash2, Eye, EyeOff, AlertTriangle, Info } from 'lucide-react';
import {
  AUTHORING_LANGUAGES,
  COMPARISON_LABEL,
  LANGUAGE_LABEL,
  defaultWeight,
  newTest,
  totalWeight,
  validateCodeQuestion,
  type AuthoringLanguage,
} from '../../../lib/codeAuthoring';
import type { CodeSpec, CodeTest } from '../../../lib/questionBankService';
import { starterTemplate } from '../../../lib/codeSnippets';
import { CodeField } from './CodeField';

interface CodeSpecEditorProps {
  spec: CodeSpec;
  tests: CodeTest[];
  onSpecChange: (spec: CodeSpec) => void;
  onTestsChange: (tests: CodeTest[]) => void;
}

const FIELD = 'w-full text-sm rounded border px-2 py-1.5';
const MONO: React.CSSProperties = { fontFamily: 'var(--font-mono)' };

export function CodeSpecEditor({ spec, tests, onSpecChange, onTestsChange }: CodeSpecEditorProps) {
  const issues = useMemo(() => validateCodeQuestion(spec, tests), [spec, tests]);
  const languages = (spec.languages ?? []) as AuthoringLanguage[];
  const weight = totalWeight(tests);

  const setSpec = (patch: Partial<CodeSpec>) => onSpecChange({ ...spec, ...patch });
  const patchTest = (i: number, patch: Partial<CodeTest>) =>
    onTestsChange(tests.map((t, j) => (j === i ? { ...t, ...patch } : t)));

  const toggleLanguage = (lang: AuthoringLanguage) => {
    const next = languages.includes(lang)
      ? languages.filter((l) => l !== lang)
      : [...languages, lang];
    // Starter code for a language that is no longer offered is kept, not
    // deleted: an author unticking a language by accident should not lose the
    // buffer they wrote. validateCodeQuestion warns that it will not be shown.
    setSpec({ languages: next });
  };

  const issuesFor = (i: number) => issues.filter((x) => x.testIndex === i);
  const generalIssues = issues.filter((x) => x.testIndex === undefined);

  return (
    <div className="space-y-6">
      {/* ── Languages ── */}
      <section className="space-y-2">
        <div className="flex items-baseline gap-2">
          <h4 className="text-sm font-medium">Languages</h4>
          <span className="text-xs opacity-60">
            {languages.length === 0 ? 'None selected — every language is offered' : `${languages.length} selected`}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {AUTHORING_LANGUAGES.map((lang) => {
            const on = languages.includes(lang);
            return (
              <button
                key={lang}
                type="button"
                onClick={() => toggleLanguage(lang)}
                className="text-xs rounded border px-2 py-1"
                style={{
                  background: on ? 'var(--ef-ink)' : 'var(--ef-surface)',
                  color: on ? 'var(--ef-surface)' : 'var(--ef-ink)',
                }}
              >
                {LANGUAGE_LABEL[lang]}
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Starter code ── */}
      {languages.length > 0 && (
        <section className="space-y-2">
          <h4 className="text-sm font-medium">Starter code</h4>
          <p className="text-xs opacity-60">
            Optional. A candidate who does not change it counts as not having answered.
          </p>
          {languages.map((lang) => {
            const current = spec.starterCode?.[lang] ?? '';
            return (
              <div key={lang} className="space-y-1">
                <div className="flex items-center gap-2">
                  <label className="text-xs opacity-70">{LANGUAGE_LABEL[lang]}</label>
                  <button
                    type="button"
                    className="text-xs rounded border px-2 py-0.5"
                    onClick={() => {
                      // Confirm ONLY when there is something to lose. An author
                      // filling an empty field should not be asked to approve
                      // it; one about to lose a buffer they wrote should.
                      if (current.trim().length > 0
                          && !window.confirm(`Replace the ${LANGUAGE_LABEL[lang]} starter code with the template?`)) {
                        return;
                      }
                      setSpec({
                        starterCode: { ...(spec.starterCode ?? {}), [lang]: starterTemplate(lang) },
                      });
                    }}
                  >
                    {current.trim().length === 0 ? 'Use template' : 'Replace with template'}
                  </button>
                </div>
                <CodeField
                  value={current}
                  language={lang}
                  minHeight={110}
                  onChange={(next) =>
                    setSpec({ starterCode: { ...(spec.starterCode ?? {}), [lang]: next } })
                  }
                />
              </div>
            );
          })}
        </section>
      )}

      {/* ── Limits ── */}
      <section className="space-y-2">
        <h4 className="text-sm font-medium">Limits</h4>
        <p className="text-xs opacity-60">
          Applied to every test. Clamped server-side, so a value beyond the platform
          ceiling is reduced rather than rejected.
        </p>
        <div className="flex gap-3 flex-wrap">
          <label className="text-xs space-y-1">
            <span className="opacity-70 block">CPU per test (ms)</span>
            <input
              type="number" className={FIELD} style={{ width: 130 }}
              value={spec.limits?.cpuMs ?? 2000}
              onChange={(e) => setSpec({ limits: { ...spec.limits, cpuMs: Number(e.target.value) } })}
            />
          </label>
          <label className="text-xs space-y-1">
            <span className="opacity-70 block">Memory (KB)</span>
            <input
              type="number" className={FIELD} style={{ width: 130 }}
              value={spec.limits?.memoryKb ?? 262144}
              onChange={(e) => setSpec({ limits: { ...spec.limits, memoryKb: Number(e.target.value) } })}
            />
          </label>
        </div>
      </section>

      {/* ── Tests ── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-sm font-medium">Test cases</h4>
            <p className="text-xs opacity-60">
              Hidden tests decide the mark. Visible ones are what a candidate may run.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="text-xs rounded border px-2 py-1 flex items-center gap-1"
              onClick={() => onTestsChange([...tests, newTest(true)])}
            >
              <Plus size={12} /> Visible
            </button>
            <button
              type="button"
              className="text-xs rounded border px-2 py-1 flex items-center gap-1"
              onClick={() => onTestsChange([...tests, newTest(false)])}
            >
              <Plus size={12} /> Hidden
            </button>
          </div>
        </div>

        {tests.length === 0 && (
          <p className="text-xs opacity-60 border rounded px-3 py-4 text-center">
            No test cases yet. A coding question cannot be marked without at least one.
          </p>
        )}

        {tests.map((t, i) => {
          const rowIssues = issuesFor(i);
          return (
            <div key={t.id} className="border rounded p-3 space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  className="text-xs rounded border px-2 py-1 flex items-center gap-1"
                  onClick={() => patchTest(i, { visible: !t.visible })}
                  title={t.visible
                    ? 'Visible: the candidate can read this and run it'
                    : 'Hidden: runs only at marking'}
                >
                  {t.visible ? <Eye size={12} /> : <EyeOff size={12} />}
                  {t.visible ? 'Visible' : 'Hidden'}
                </button>

                <label className="text-xs flex items-center gap-1">
                  <span className="opacity-70">Weight</span>
                  <input
                    type="number" min={0} step={0.5}
                    className="text-sm rounded border px-2 py-1"
                    style={{ width: 70 }}
                    value={t.weight ?? defaultWeight(t)}
                    onChange={(e) => patchTest(i, { weight: Number(e.target.value) })}
                  />
                </label>

                <select
                  className="text-xs rounded border px-2 py-1"
                  value={t.comparison ?? 'trimmed'}
                  onChange={(e) => patchTest(i, { comparison: e.target.value as CodeTest['comparison'] })}
                >
                  {Object.entries(COMPARISON_LABEL).map(([k, label]) => (
                    <option key={k} value={k}>{label}</option>
                  ))}
                </select>

                {t.comparison === 'numeric' && (
                  <label className="text-xs flex items-center gap-1">
                    <span className="opacity-70">±</span>
                    <input
                      type="number" step="any"
                      className="text-sm rounded border px-2 py-1"
                      style={{ width: 90 }}
                      value={t.tolerance ?? 1e-9}
                      onChange={(e) => patchTest(i, { tolerance: Number(e.target.value) })}
                    />
                  </label>
                )}

                <button
                  type="button"
                  className="text-xs rounded border px-2 py-1 ml-auto"
                  onClick={() => onTestsChange(tests.filter((_, j) => j !== i))}
                  aria-label="Remove test"
                >
                  <Trash2 size={12} />
                </button>
              </div>

              {/* Whitespace is shown in both. A trailing space on a line of
                  expected output is invisible in a textarea and is exactly what
                  fails a correct program under the `exact` comparison — an
                  author who cannot see it cannot fix it, and the cost lands on
                  the candidate. */}
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-xs opacity-70">Input (stdin)</label>
                  <CodeField
                    value={t.stdin}
                    showWhitespace
                    minHeight={90}
                    onChange={(next) => patchTest(i, { stdin: next })}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs opacity-70">Expected output</label>
                  <CodeField
                    value={t.expected}
                    showWhitespace
                    minHeight={90}
                    onChange={(next) => patchTest(i, { expected: next })}
                  />
                </div>
              </div>

              {rowIssues.map((iss, k) => (
                <p
                  key={k}
                  className="text-xs flex items-start gap-1"
                  style={{ color: iss.severity === 'error' ? 'var(--ef-danger)' : 'var(--ef-text-muted)' }}
                >
                  {iss.severity === 'error' ? <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                                            : <Info size={12} className="mt-0.5 flex-shrink-0" />}
                  {iss.message}
                </p>
              ))}
            </div>
          );
        })}

        {/* The number an author needs and would otherwise have to compute:
            visible tests are worth 0 by default, so a suite can look full and
            still be unmarkable. */}
        {tests.length > 0 && (
          <p className="text-xs opacity-60">
            Total weight {weight} across {tests.filter((t) => !t.visible).length} hidden
            and {tests.filter((t) => t.visible).length} visible {tests.length === 1 ? 'test' : 'tests'}.
          </p>
        )}
      </section>

      {/* ── Question-level issues ── */}
      {generalIssues.length > 0 && (
        <ul className="space-y-1">
          {generalIssues.map((iss, k) => (
            <li
              key={k}
              className="text-xs flex items-start gap-1"
              style={{ color: iss.severity === 'error' ? 'var(--ef-danger)' : 'var(--ef-text-muted)' }}
            >
              {iss.severity === 'error' ? <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                                        : <Info size={12} className="mt-0.5 flex-shrink-0" />}
              {iss.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default CodeSpecEditor;
