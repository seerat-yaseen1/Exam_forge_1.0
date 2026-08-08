/**
 * CODE FIELD — a code editor for authoring surfaces
 *
 * The same lazy CodeMirror the candidate editor uses, in a form authoring can
 * drop into a form. Loaded on demand for the same reason: nobody writing an
 * MCQ should download an editor and a grammar.
 *
 * ── WHY THIS EXISTS AT ALL ────────────────────────────────────────
 *
 * Authors were writing starter code and expected output into bare textareas —
 * no indentation, no highlighting, and no way to see the one thing that
 * decides whether a candidate passes.
 *
 * Whitespace is not cosmetic here. A trailing space on a line of expected
 * output is invisible in a textarea and is the difference between a correct
 * program passing and failing under the `exact` comparison. `showWhitespace`
 * makes it visible, and that is the single most useful thing this component
 * does — more than highlighting, which is merely pleasant.
 *
 * ── NOT THE CANDIDATE EDITOR ──────────────────────────────────────
 *
 * Deliberately does NOT carry data-exam-code-editor. That attribute is what
 * IntegrityEngine keys its clipboard exemption on; putting it on an authoring
 * field would open a hole in the exam's paste policy from a surface that never
 * appears during an exam. Authoring has no integrity engine and needs no
 * exemption.
 */

import { useEffect, useRef } from 'react';
import type { AuthoringLanguage } from '../../../lib/codeAuthoring';

// ── Lazy CodeMirror ───────────────────────────────────────────────
// Separate cache from the candidate editor's: these are different bundles in
// the graph, and sharing a promise across them would couple two lazy chunks
// that have no reason to load together.

type CmModule = typeof import('codemirror');
let cmCore: Promise<CmModule> | null = null;
const loadCore = (): Promise<CmModule> => (cmCore ??= import('codemirror'));

type ViewModule = typeof import('@codemirror/view');
let cmView: Promise<ViewModule> | null = null;
const loadView = (): Promise<ViewModule> => (cmView ??= import('@codemirror/view'));

const grammars: Partial<Record<AuthoringLanguage, () => Promise<unknown>>> = {
  python3:    () => import('@codemirror/lang-python').then((m) => m.python()),
  javascript: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  typescript: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  java:       () => import('@codemirror/lang-java').then((m) => m.java()),
  c:          () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  cpp:        () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  csharp:     () => import('@codemirror/lang-java').then((m) => m.java()),
  go:         () => import('@codemirror/lang-go').then((m) => m.go()),
  rust:       () => import('@codemirror/lang-rust').then((m) => m.rust()),
  php:        () => import('@codemirror/lang-php').then((m) => m.php()),
  sql:        () => import('@codemirror/lang-sql').then((m) => m.sql()),
};

interface CodeFieldProps {
  value: string;
  onChange: (next: string) => void;
  /** Absent means no highlighting — correct for test I/O, which is not code. */
  language?: AuthoringLanguage;
  /**
   * Render spaces, tabs and the trailing edge of lines.
   *
   * On for expected output and stdin. A trailing space there is invisible and
   * decisive; an author who cannot see it cannot fix it, and the failure lands
   * on a candidate who wrote a correct program.
   */
  showWhitespace?: boolean;
  minHeight?: number;
  placeholder?: string;
}

export function CodeField({
  value,
  onChange,
  language,
  showWhitespace = false,
  minHeight = 120,
  placeholder,
}: CodeFieldProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<{
    destroy: () => void;
    state: { doc: { toString(): string; length: number } };
    dispatch: (t: unknown) => void;
  } | null>(null);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Built once per (language, whitespace) pair. Both are extensions, so a
  // change to either needs a rebuild; `value` deliberately is not a dependency,
  // because it is this editor's own output and rebuilding on it would destroy
  // the cursor on every keystroke.
  useEffect(() => {
    let cancelled = false;
    let view: { destroy: () => void } | null = null;

    (async () => {
      const [{ EditorView, basicSetup }, viewMod, grammar] = await Promise.all([
        loadCore(),
        loadView(),
        language ? (grammars[language]?.().catch(() => null) ?? Promise.resolve(null)) : Promise.resolve(null),
      ]);
      if (cancelled || !hostRef.current) return;

      const extensions: unknown[] = [
        basicSetup,
        EditorView.updateListener.of((u: { docChanged: boolean; state: { doc: { toString(): string } } }) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
      ];
      if (grammar) extensions.push(grammar);
      if (showWhitespace && viewMod.highlightWhitespace) {
        extensions.push(viewMod.highlightWhitespace());
        // Trailing whitespace gets its own marker: it is the case that decides
        // a mark, and it is the one a highlighter for all whitespace still
        // makes easy to miss at the end of a line.
        if (viewMod.highlightTrailingWhitespace) {
          extensions.push(viewMod.highlightTrailingWhitespace());
        }
      }

      view = new EditorView({ doc: value, extensions: extensions as never, parent: hostRef.current });
      viewRef.current = view as never;
    })();

    return () => { cancelled = true; view?.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, showWhitespace]);

  // Adopt a value changed from outside — a snippet inserted, a template
  // applied, a form reset. Guarded on inequality so the editor is not rewritten
  // while someone is typing into it, which would move their cursor to the end.
  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current === value) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
  }, [value]);

  return (
    <div
      ref={hostRef}
      className="rounded border overflow-hidden text-sm"
      style={{ minHeight }}
      data-placeholder={placeholder}
    />
  );
}

export default CodeField;
