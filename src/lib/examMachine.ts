// ══════════════════════════════════════════════════════════════════
// EXAM SHELL STATE MACHINE — what a sitting is allowed to do next
// (Audit F-9, stage 1)
// ══════════════════════════════════════════════════════════════════
//
// PURE. No React, no Firestore, no clock, no I/O of any kind. Same discipline
// as examTimingCore, and for the same reason: it is what makes the entire
// state space reachable from a test.
//
// NOTHING CALLS THIS YET, and that is deliberate — it is the staging the
// timing core used (its own header: "Phase 3a ships it inert, with its sweep,
// so the logic can be proven before anything depends on it. Phase 3b points
// computeAttemptLocks at it"). ExamShell is 4,279 lines on the exam critical
// path; proving the transition table first and rewiring second is the only
// version of this change that can be reviewed in pieces.
//
// ── WHAT IT IS FOR ────────────────────────────────────────────────
//
// ExamShell already HAS this machine. It is spelled as a ten-member
// `ShellStatus` union driven by twenty-six `setShellStatus` calls scattered
// across the component, plus a `shellStatusRef` shadow copy that exists
// because "shellStatus updates asynchronously" and three separate effects need
// to read it without re-arming.
//
// Nothing in that arrangement knows which transitions are legal. `ready` is
// reachable from any line that types it, and the guards that keep a submitted
// paper from going back to `ready` are `if (shellStatusRef.current !== 'ready')
// return;` written out by hand at each site — a check that is correct
// everywhere it appears and absent everywhere it does not.
//
// This module makes the legal edges the data, so the illegal ones become
// unrepresentable rather than merely unreached.
//
// ── THE TRANSITION TABLE IS DERIVED, NOT INVENTED ─────────────────
//
// Every edge below corresponds to a real `setShellStatus` call site, read at
// `43d895a`. Where the machine is STRICTER than the component, it is called
// out on the edge itself — see the note on the terminal states, which is the
// one place this table forbids something ExamShell currently permits.

/**
 * The ten states, mirroring `ShellStatus` in ExamShell.tsx.
 *
 * A twin, and guarded as one — see twinSync.test.ts. While this module is
 * inert the twin is harmless, but the whole point is to wire it up later, and
 * a table that has quietly drifted from the union it is meant to replace would
 * be worse than no table at all.
 */
export const EXAM_STATES = [
  'loading',
  'ready',
  'choosing_section',
  'on_break',
  'submitting_section',
  'submitting_exam',
  'submit_failed',
  'submitted',
  'terminated',
  'error',
] as const;

export type ExamState = (typeof EXAM_STATES)[number];

/**
 * Legal successors, keyed by current state.
 *
 * Read as: "from X, the sitting may next be in any of these."
 */
export const TRANSITIONS: Record<ExamState, readonly ExamState[]> = {
  // Entry. The load resolves into whichever state the SERVER says the attempt
  // is already in — a resumed sitting can land mid-break or at a section pick,
  // which is why this fans out so widely.
  loading: ['ready', 'choosing_section', 'on_break', 'error', 'terminated'],

  // Answering. The only state in which the candidate can write anything.
  ready: ['submitting_section', 'submitting_exam', 'terminated', 'error'],

  // student_choice delivery: the picker is open.
  choosing_section: ['ready', 'error', 'terminated'],

  // Between sections. Resolves either straight into the next section or into
  // the picker, per BreakState.then.
  on_break: ['ready', 'choosing_section', 'terminated', 'error'],

  // A section is being handed in. Resolves to the next section, a break, the
  // picker, or a failure.
  submitting_section: ['ready', 'on_break', 'choosing_section', 'error', 'terminated'],

  // The paper is being handed in. NOTE THE ABSENCE OF `ready`: once a final
  // submit is in flight the candidate must never return to answering, and this
  // is the edge whose absence says so. In ExamShell that guarantee currently
  // rests on `submittingRef`, a synchronous lock held beside the status
  // precisely because the status alone could not express it.
  submitting_exam: ['submitted', 'submit_failed', 'terminated'],

  // A final submit threw. Retry is the ONLY forward move — deliberately not
  // `ready`, because the answers are already flushed and re-opening the paper
  // after a failed hand-in is how a sitting gets answered twice.
  submit_failed: ['submitting_exam', 'terminated'],

  // ── Terminal ────────────────────────────────────────────────────
  //
  // THIS IS WHERE THE MACHINE IS STRICTER THAN THE COMPONENT, and it is the
  // one divergence that has to be resolved when this gets wired.
  //
  // `handleTerminate` sets 'terminated' with no guard on the current state
  // (`if (!att) return;` and nothing else), so today a violation event
  // arriving after a successful hand-in would move a SUBMITTED paper to
  // terminated. The window is small and may well be unreachable in practice —
  // the integrity engine is torn down on submit — but "may well be" is the
  // problem, and it is exactly the class of thing a scattered setter cannot
  // rule out.
  //
  // Both are modelled as absorbing. Wiring this up means adding the guard
  // `handleTerminate` is missing, not relaxing the table to match it.
  submitted: [],
  terminated: [],

  // Within one mount, an error is final: the shell renders its error screen
  // and recovery is a reload, which remounts and re-enters at 'loading'.
  error: [],
};

/** States from which a sitting can never move again. */
export const TERMINAL_STATES: readonly ExamState[] =
  EXAM_STATES.filter((s) => TRANSITIONS[s].length === 0);

export function isTerminal(state: ExamState): boolean {
  return TRANSITIONS[state].length === 0;
}

/** May a sitting move directly from `from` to `to`? */
export function canTransition(from: ExamState, to: ExamState): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * The result of attempting a move.
 *
 * A REFUSAL IS NOT AN EXCEPTION. An illegal transition here means a race the
 * component lost — a late timer firing into a submitted paper, a violation
 * arriving after termination — and those are routine, not exceptional. Throwing
 * would turn a benign race into a white screen inside an exam, which is the
 * one thing the exam error boundary exists to make survivable. So the caller
 * gets a value it can log and ignore.
 */
export type TransitionResult =
  | { ok: true; state: ExamState }
  | { ok: false; state: ExamState; reason: string };

export function transition(from: ExamState, to: ExamState): TransitionResult {
  if (canTransition(from, to)) return { ok: true, state: to };
  if (isTerminal(from)) {
    return {
      ok: false,
      state: from,
      reason: `${from} is terminal — a sitting cannot move to ${to} once it has ended`,
    };
  }
  return {
    ok: false,
    state: from,
    reason: `${from} → ${to} is not a legal transition`,
  };
}

/**
 * Can the candidate write an answer right now?
 *
 * One predicate, replacing the hand-written `shellStatusRef.current !== 'ready'`
 * guard that appears at several call sites and is absent at others. The write
 * gate that actually protects the record is server-side — firestore.rules
 * narrows a student's attempt patch to `answers` inside a materialised time
 * window — so this is the client's half: it stops the shell from ATTEMPTING a
 * write the server would refuse, and keeps the refusal out of the candidate's
 * face.
 */
export function canAnswer(state: ExamState): boolean {
  return state === 'ready';
}

// ══════════════════════════════════════════════════════════════════
// RESET — the edge a call-site reading could not see
// ══════════════════════════════════════════════════════════════════
//
// Stage 1 derived the table from the twenty-six `setShellStatus` sites. That
// was the right method and it still missed something, which is worth recording
// rather than quietly patching: one of those sites is `setShellStatus('loading')`
// at the top of the load effect, and the effect's dependency array is
// `[assessmentId, session, loading]`.
//
// `session` is an object from useStudentAuth. If its identity changes — an auth
// refresh, a token renewal — the effect re-runs and the shell re-enters
// `loading` from wherever it was. A call site tells you the TARGET of a
// transition; only the surrounding effect tells you the sources, and here the
// sources are "any state the shell can be in when auth re-resolves".
//
// MODELLED AS A RESET, NOT AS EDGES. The alternative was to add `loading` as a
// successor of every state, and that would have destroyed the property the
// machine exists for: `submitted → loading → ready` would make a submitted
// paper answerable again, so the absorbing-terminal guarantee would have been
// traded away to describe an auth refresh. A reset is not a move within a
// sitting; it is the sitting being set up again, which is what a remount is.
// Keeping it outside the transition relation is what lets both statements stay
// true at once.

/** Is this target a fresh entry rather than a move within a sitting? */
export function isReset(to: ExamState): boolean {
  return to === 'loading';
}

export type ShadowOutcome =
  | { kind: 'legal' }
  | { kind: 'reset' }
  | { kind: 'illegal'; reason: string };

/**
 * What SHADOW MODE reports. Classifies without deciding.
 *
 * The shell calls this on every status change and performs the change either
 * way (see `advanceShell` in ExamShell). That is deliberate and matches how
 * the timing core was introduced: `checkTimingInvariants` logged
 * "INVARIANT VIOLATION" when a callable and the resolver disagreed, for a
 * whole release, before anything depended on the resolver being right.
 *
 * Enforcing a table that is wrong in one edge would strand a candidate in an
 * exam. Logging one that is wrong in one edge produces a line in a console.
 * The reset edge above is precisely the kind of thing that would have been
 * found this way if it had not been found by reading; assume there are others.
 */
export function observeTransition(from: ExamState, to: ExamState): ShadowOutcome {
  if (isReset(to)) return { kind: 'reset' };
  const r = transition(from, to);
  return r.ok ? { kind: 'legal' } : { kind: 'illegal', reason: r.reason };
}

/** Every state reachable from `loading`, breadth-first. Used by the sweep. */
export function reachableFrom(start: ExamState): Set<ExamState> {
  const seen = new Set<ExamState>([start]);
  const queue: ExamState[] = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of TRANSITIONS[cur]) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return seen;
}
