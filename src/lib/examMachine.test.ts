/**
 * EXAM MACHINE — the sweep that has to pass before anything is rewired
 *
 * The module is inert (audit F-9, stage 1). Its whole justification is that
 * the transition table can be proven before ExamShell depends on it, so these
 * tests are not a formality attached to a small module — they ARE the stage.
 *
 * Two kinds of assertion, and the second is the one that matters:
 *
 *   • the table is well-formed and totally covered — every state, every pair;
 *   • the SAFETY properties hold. Those are stated as properties over the whole
 *     state space rather than as examples, because "a submitted paper cannot go
 *     back to answering" is a claim about all ten states and 100 pairs, not
 *     about the one path someone thought to write down.
 */

import { describe, it, expect } from 'vitest';
import {
  EXAM_STATES,
  TRANSITIONS,
  TERMINAL_STATES,
  canAnswer,
  canTransition,
  isTerminal,
  observeTransition,
  reachableFrom,
  transition,
  type ExamState,
} from './examMachine';

const ALL = EXAM_STATES;

describe('the table is well-formed', () => {
  it('every state has an entry', () => {
    for (const s of ALL) expect(TRANSITIONS[s], `${s} has no entry`).toBeDefined();
  });

  it('every successor is itself a known state', () => {
    // A typo in the table is otherwise a state that can be entered and never
    // left, because nothing has an entry for it.
    for (const s of ALL) {
      for (const next of TRANSITIONS[s]) {
        expect(ALL, `${s} → ${next}: ${next} is not a known state`).toContain(next);
      }
    }
  });

  it('no state lists a duplicate successor', () => {
    for (const s of ALL) {
      expect(new Set(TRANSITIONS[s]).size, `${s} lists a duplicate`)
        .toBe(TRANSITIONS[s].length);
    }
  });

  it('no state transitions to itself', () => {
    // A self-edge means "this transition is a no-op", which is a thing the
    // CALLER should decide not to do. In the table it would silently make
    // every re-entrancy bug legal.
    for (const s of ALL) {
      expect(TRANSITIONS[s], `${s} transitions to itself`).not.toContain(s);
    }
  });
});

describe('reachability', () => {
  it('every state is reachable from loading', () => {
    // An unreachable state is dead code in the component — a branch of the
    // render that no sequence of events can produce.
    const reachable = reachableFrom('loading');
    for (const s of ALL) {
      expect(reachable.has(s), `${s} is unreachable from loading`).toBe(true);
    }
  });

  it('every non-terminal state can still reach a terminal one', () => {
    // The liveness half. A non-terminal state with no path to submitted /
    // terminated / error is a sitting that can never end — the candidate is
    // stuck in the shell with no way out, which on this screen means no way
    // to hand in a paper.
    for (const s of ALL) {
      if (isTerminal(s)) continue;
      const reach = reachableFrom(s);
      const endings = TERMINAL_STATES.filter((t) => reach.has(t));
      expect(endings.length, `${s} can never reach a terminal state`).toBeGreaterThan(0);
    }
  });
});

describe('safety — the properties the scattered setters cannot express', () => {
  it('terminal states are absorbing, for every target', () => {
    // Stated over all 3 × 10 pairs rather than the two anyone would think to
    // write. This is the property that forbids a violation arriving after a
    // successful hand-in from moving a submitted paper to terminated.
    for (const from of TERMINAL_STATES) {
      for (const to of ALL) {
        expect(canTransition(from, to), `${from} → ${to} should be refused`).toBe(false);
      }
    }
  });

  it('a submitted paper can never return to answering', () => {
    for (const s of ALL) {
      const reach = reachableFrom(s);
      if (s === 'submitted') {
        expect(reach.has('ready'), 'submitted can reach ready').toBe(false);
      }
    }
    expect(canTransition('submitted', 'ready')).toBe(false);
  });

  it('a final submit in flight cannot return to answering', () => {
    // The edge ExamShell holds with a synchronous `submittingRef` lock BESIDE
    // the status, precisely because the status alone could not say it.
    expect(canTransition('submitting_exam', 'ready')).toBe(false);
    expect(canTransition('submit_failed', 'ready')).toBe(false);
  });

  it('a failed submit can only be retried, terminated, or left alone', () => {
    expect([...TRANSITIONS.submit_failed].sort()).toEqual(['submitting_exam', 'terminated']);
  });

  it('only `ready` permits an answer', () => {
    for (const s of ALL) {
      expect(canAnswer(s), `canAnswer(${s})`).toBe(s === 'ready');
    }
  });

  it('every non-terminal state can be terminated', () => {
    // The invigilator / integrity-threshold path has to reach a sitting
    // wherever it currently is. A state that could not be terminated would be
    // a place to hide from the violation limit.
    for (const s of ALL) {
      if (isTerminal(s)) continue;
      expect(canTransition(s, 'terminated'), `${s} cannot be terminated`).toBe(true);
    }
  });
});

describe('exhaustive pair sweep', () => {
  it('every one of the 100 pairs is decided, and agrees with the table', () => {
    let legal = 0;
    for (const from of ALL) {
      for (const to of ALL) {
        const allowed = canTransition(from, to);
        expect(typeof allowed).toBe('boolean');
        // transition() and canTransition() must never disagree — two
        // expressions of one rule is the failure mode this whole codebase
        // keeps hitting (see examTimingCore's header).
        expect(transition(from, to).ok, `${from} → ${to}`).toBe(allowed);
        if (allowed) legal++;
      }
    }
    expect(legal).toBe(ALL.reduce((n, s) => n + TRANSITIONS[s].length, 0));
    // Pin the count. A future edit that widens the machine has to change this
    // number deliberately, which is the point — the dangerous edit here is one
    // that ADDS an edge without anyone noticing.
    expect(legal).toBe(26);
  });

  it('a refused transition reports the current state, not the attempted one', () => {
    // The caller assigns the result. Returning the target on a refusal would
    // move the sitting anyway — the bug the value shape exists to prevent.
    const r = transition('submitted', 'ready');
    expect(r.ok).toBe(false);
    expect(r.state).toBe('submitted');
  });

  it('a refusal explains itself in terms a log reader can act on', () => {
    const terminal = transition('terminated', 'ready');
    expect(terminal.ok).toBe(false);
    expect(!terminal.ok && terminal.reason).toMatch(/terminal/);

    const illegal = transition('ready', 'submitted');
    expect(illegal.ok).toBe(false);
    expect(!illegal.ok && illegal.reason).toMatch(/not a legal transition/);
  });
});

describe('reset — the edge a call-site reading could not see', () => {
  it('re-entering loading is a reset from every state, including terminal ones', () => {
    // The load effect depends on [assessmentId, session, loading]; a change in
    // `session` identity re-runs it from wherever the shell was. So this must
    // hold for all ten, not just the live ones.
    for (const s of ALL) {
      expect(observeTransition(s, 'loading'), `${s} → loading`).toEqual({ kind: 'reset' });
    }
  });

  it('reset does NOT make loading a legal transition target', () => {
    // The whole reason it is modelled outside the relation. If this ever
    // starts passing, `submitted → loading → ready` is reachable and a
    // submitted paper is answerable again.
    for (const s of ALL) {
      if (s === 'loading') continue;
      expect(canTransition(s, 'loading'), `${s} → loading should not be an edge`).toBe(false);
    }
  });

  it('the absorbing property survives the reset carve-out', () => {
    for (const from of TERMINAL_STATES) {
      for (const to of ALL) {
        if (to === 'loading') continue;   // reset, handled above
        expect(canTransition(from, to), `${from} → ${to}`).toBe(false);
      }
    }
  });

  it('shadow mode classifies legal and illegal moves apart', () => {
    expect(observeTransition('ready', 'submitting_exam')).toEqual({ kind: 'legal' });
    const bad = observeTransition('submitted', 'ready');
    expect(bad.kind).toBe('illegal');
    expect(bad.kind === 'illegal' && bad.reason).toMatch(/terminal/);
  });

  it('shadow mode decides every pair', () => {
    for (const from of ALL) {
      for (const to of ALL) {
        expect(['legal', 'reset', 'illegal']).toContain(observeTransition(from, to).kind);
      }
    }
  });
});

describe('the paths a real sitting takes', () => {
  /** Walk a sequence, asserting each step is legal. */
  function walk(path: ExamState[]): void {
    for (let i = 0; i < path.length - 1; i++) {
      const r = transition(path[i], path[i + 1]);
      expect(r.ok, `${path[i]} → ${path[i + 1]} in [${path.join(' → ')}]`).toBe(true);
    }
  }

  it('single-section exam, straight through', () => {
    walk(['loading', 'ready', 'submitting_exam', 'submitted']);
  });

  it('multi-section with a break between', () => {
    walk(['loading', 'ready', 'submitting_section', 'on_break', 'ready',
          'submitting_exam', 'submitted']);
  });

  it('student_choice delivery, picking each section', () => {
    walk(['loading', 'choosing_section', 'ready', 'submitting_section',
          'choosing_section', 'ready', 'submitting_exam', 'submitted']);
  });

  it('a resumed sitting re-entering mid-break', () => {
    // startExam/verifyAndResume can land a reload straight into a break, which
    // is why `loading` fans out past `ready`.
    walk(['loading', 'on_break', 'choosing_section', 'ready']);
  });

  it('a submit that fails and is retried', () => {
    walk(['loading', 'ready', 'submitting_exam', 'submit_failed',
          'submitting_exam', 'submitted']);
  });

  it('termination mid-answer', () => {
    walk(['loading', 'ready', 'terminated']);
  });

  it('a load failure', () => {
    walk(['loading', 'error']);
  });
});
