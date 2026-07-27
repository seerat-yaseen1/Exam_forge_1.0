/**
 * ErrorBoundary — the app's only defence against a render-time throw.
 *
 * Audit 2026-07-26 E-01: there were ZERO error boundaries anywhere in the
 * codebase. React's documented behaviour when an error escapes render with no
 * boundary above it is to unmount the WHOLE tree — so any throw, in any
 * component, blanked the entire screen to white. Mid-exam that also took the
 * student's unsaved answers with it, since they live in ExamShell state that
 * dies with the unmount.
 *
 * Must be a class: getDerivedStateFromError / componentDidCatch have no hook
 * equivalent. This is the one place a class component is still required.
 *
 * ── Why reload, and only reload ───────────────────────────────────────
 * Recovery is deliberately a full `window.location.reload()` rather than a
 * soft "try again" that clears the error state in place. A soft reset would
 * re-render the same subtree from whatever half-built state caused the throw,
 * which either throws again immediately or — worse — appears to work while
 * some invariant is quietly broken. A reload rebuilds from server state, which
 * for this app is authoritative anyway (the attempt, its timers, its section
 * progress and its integrity counters all live server-side). Predictable beats
 * clever on the one screen the student cannot afford to have misbehave.
 *
 * ── Why the exam variant has no way out ───────────────────────────────
 * SECURITY: the exam fallback offers reload and NOTHING else — no dashboard
 * link, no sign-out, no "leave exam". An error screen inside a locked-down
 * sitting is an escape-hatch risk: if a student can provoke a render throw
 * (malformed question content, a crafted answer value, a device-specific
 * rendering bug) and the boundary hands them a button out, that is a way to
 * abandon a supervised exam without submitting and without the violation
 * being recorded. Reload is safe precisely because it lands back in ExamShell,
 * which resumes the same server-side attempt. Do not add navigation here.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

type Variant = 'app' | 'exam';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** 'exam' removes every exit route from the fallback — see the note above. */
  variant?: Variant;
  /** Prefix for the console group, so a crash report says where it happened. */
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // No error-reporting backend exists yet, so this matches what the rest of
    // the codebase does with unexpected failures: log it with enough context
    // to be actionable. componentStack is the valuable half — it names the
    // component that threw, which the error alone usually does not.
    const label = this.props.label ?? this.props.variant ?? 'app';
    console.error(`[ErrorBoundary:${label}] render error`, error, info.componentStack);
  }

  private reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const isExam = this.props.variant === 'exam';

    return (
      <div
        className="fixed inset-0 flex flex-col items-center justify-center px-8"
        style={{ background: '#F7F6F3' }}
      >
        <AlertTriangle size={20} strokeWidth={1} style={{ color: '#9B2828' }} />

        <p className="text-xs mt-4 text-center" style={{ color: '#9B2828', maxWidth: 380 }}>
          {isExam
            ? 'The exam page ran into a problem and could not continue.'
            : 'Something went wrong and this page could not be displayed.'}
        </p>

        <p className="text-xs mt-2 text-center" style={{ color: '#9A9891', maxWidth: 380 }}>
          {isExam
            // Honest about the gap rather than reassuring: in standard delivery
            // answers autosave on a 1.5s debounce, but in linear/adaptive the
            // current answer is held client-side until the student advances, so
            // it can genuinely be lost here. Promising "nothing is lost" would
            // be a lie in exactly the mode where it matters most.
            ? 'Your saved answers are safe. Reload to return to your exam — you may need to re-enter your answer to the question you were on. Your time and progress are kept on the server.'
            : 'Reloading usually fixes this. If it keeps happening, please report it.'}
        </p>

        <button
          type="button"
          onClick={this.reload}
          className="text-xs mt-6 px-4 py-2"
          style={{ background: '#2F2F2B', color: '#FFFFFF', borderRadius: 2 }}
        >
          {isExam ? 'Reload and continue exam' : 'Reload page'}
        </button>

        {/* No secondary action in exam mode — see the security note in the
            file header. Outside an exam a hard link to sign-in is a
            legitimate escape from a page that will not render. */}
        {!isExam && (
          <a
            href="/login"
            className="text-xs mt-3 px-4 py-2"
            style={{ color: '#9A9891' }}
          >
            Back to sign in
          </a>
        )}
      </div>
    );
  }
}