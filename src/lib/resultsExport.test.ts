/**
 * The integrity sheet.
 *
 * This is the file a moderation meeting works from, and it is the last place
 * an error is cheap: once it has been circulated, a wrong or missing column is
 * a decision made about a student on bad information. The mapping from stored
 * record to printed row is therefore asserted rather than eyeballed.
 *
 * Both things under test here were recorded by the system and shown to nobody
 * until now — the violation positions, and the entire pause ledger.
 */

import { describe, it, expect } from 'vitest';
import { buildIntegrityRows, type ExportedAttempt } from './resultsExport';
import type { Attempt } from './submissionService';
import type { Student } from './firebaseService';

const student = { id: 'stu_1', name: 'Ada Lovelace', email: 'ada@example.test' } as Student;

function exported(over: Partial<Attempt>): ExportedAttempt[] {
  return [{
    student,
    attemptNumber: 1,
    counted: true,
    attempt: {
      id: 'att_1',
      status: 'submitted',
      integrityLog: {
        tabSwitches: 0, focusLosses: 0, fullscreenExits: 0, copyAttempts: 0,
        pasteAttempts: 0, rightClickAttempts: 0, multiPersonEvents: 0,
        faceAbsenceEvents: 0, devtoolsEvents: 0, keyboardBlockEvents: 0,
        extensionEvents: 0, totalViolations: 0, violations: [], autoTerminated: false,
      },
      ...over,
    } as Attempt,
  }];
}

const row = (over: Partial<Attempt>) => buildIntegrityRows(exported(over))[0];

describe('the pause record reaches the sheet', () => {
  const freezes: Attempt['freezes'] = [{
    id: 'fz_1',
    startedAt: '2026-08-14T10:00:00.000Z',
    endedAt: '2026-08-14T10:10:00.000Z',
    reason: 'invigilator',
    frozenBy: 'fac_1',
    elapsedMs: 600_000,      // 10 minutes paused
    grantedMs: 420_000,      // 7 minutes given back
    decidedBy: 'fac_1',
    note: 'Fire alarm',
  }];

  it('reports how long the sitting was paused and how much came back', () => {
    const r = row({ freezes });
    expect(r['Pauses']).toBe(1);
    expect(r['Paused Total']).toBe(600);
    expect(r['Time Credited Back']).toBe(420);
  });

  it('carries the reason, the decider and the note into the log', () => {
    // The three things an appeal actually turns on.
    const log = String(row({ freezes })['Pause Log']);
    expect(log).toContain('invigilator');
    expect(log).toContain('by fac_1');
    expect(log).toContain('Fire alarm');
    expect(log).toContain('600s elapsed, 420s credited');
  });

  it('reports a deduction against the clock it was taken from', () => {
    const r = row({
      freezes,
      penalties: [{
        id: 'pen_1', freezeId: 'fz_1', clock: 'section',
        amountMs: 120_000, decidedAt: '2026-08-14T10:10:00.000Z', decidedBy: 'fac_1',
      }],
    });
    expect(r['Time Deducted']).toBe(120);
    expect(String(r['Pause Log'])).toContain('-120s section');
  });

  it('marks a pause that is still open rather than reporting a decision', () => {
    // A running pause has no credit decision yet. Printing "0s credited" would
    // report a decision nobody has made.
    const log = String(row({
      freezes: [{ ...freezes[0], endedAt: null, elapsedMs: null, grantedMs: null }],
    })['Pause Log']);
    expect(log).toContain('still open');
    expect(log).not.toContain('credited');
  });

  it('sums across several pauses', () => {
    const r = row({
      freezes: [
        freezes[0],
        { ...freezes[0], id: 'fz_2', elapsedMs: 300_000, grantedMs: 300_000 },
      ],
    });
    expect(r['Pauses']).toBe(2);
    expect(r['Paused Total']).toBe(900);
    expect(r['Time Credited Back']).toBe(720);
  });

  it('leaves the pause columns BLANK for a sitting that was never paused', () => {
    // Not zero. A zero reads as a measured quantity — "paused, and given
    // nothing back" — which is the reading that sends a reviewer to the wrong
    // student.
    const r = row({});
    expect(r['Pauses']).toBe('');
    expect(r['Paused Total']).toBe('');
    expect(r['Time Credited Back']).toBe('');
    expect(r['Time Deducted']).toBe('');
    expect(r['Pause Log']).toBe('');
  });
});

describe('violation context reaches the sheet', () => {
  const withViolations = (violations: Attempt['integrityLog']['violations']) =>
    row({
      integrityLog: {
        ...exported({})[0].attempt.integrityLog,
        violations,
        totalViolations: violations.length,
      },
    });

  it('prints where each violation happened, not just its type', () => {
    const cell = String(withViolations([
      {
        type: 'tab_switch', timestamp: '2026-08-14T10:05:00.000Z',
        detail: 'Document became hidden', questionNumber: 4, sectionNumber: 2,
      },
    ])['Recent Violations']);
    expect(cell).toContain('tab_switch');
    expect(cell).toContain('Q4/S2');
    expect(cell).toContain('Document became hidden');
  });

  it('handles an event logged before positions existed', () => {
    // No position is not a broken row — an old event genuinely does not know
    // where the student was, and inventing one would be worse.
    const cell = String(withViolations([
      { type: 'right_click', timestamp: '2026-08-14T10:05:00.000Z' },
    ])['Recent Violations']);
    expect(cell).toContain('right_click');
    expect(cell).not.toContain('undefined');
    expect(cell).not.toContain('Q');
  });

  it('bounds the cell on a sitting that generated hundreds of events', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      type: 'focus_loss' as const,
      timestamp: new Date(Date.parse('2026-08-14T10:00:00.000Z') + i * 1000).toISOString(),
      detail: 'Window lost focus',
    }));
    const cell = String(withViolations(many)['Recent Violations']);
    expect(cell.split(' | ')).toHaveLength(25);
    // The most recent are the ones a meeting asks about; the full record stays
    // on the attempt for anyone who needs it.
    expect(cell).toContain(many[many.length - 1].timestamp);
    expect(cell).not.toContain(many[0].timestamp);
  });

  it('is blank when nothing was recorded', () => {
    expect(row({})['Recent Violations']).toBe('');
  });
});
