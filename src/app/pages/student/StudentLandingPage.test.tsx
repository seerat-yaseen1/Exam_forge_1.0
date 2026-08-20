/**
 * The Overview page, mounted.
 *
 * The page's whole claim is that it leads with the ONE thing a student has to
 * deal with, and that its idea of "the one thing" is the same one the
 * assessment list puts at the top. studentSchedule.test.ts proves the rule;
 * this proves the page renders the rule's answer rather than the first row of
 * whatever the server returned.
 *
 * It also covers the failure that would be invisible in review: a dashboard
 * that renders "Nothing due" while an exam is open.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import type { Assessment } from '../../../lib/assessmentService';
import type { Attempt, AttemptStatus } from '../../../lib/submissionService';
import type { AcademicMapping } from '../../../lib/firebaseService';

// ── Doubles ───────────────────────────────────────────────────────

const getAssessmentsForStudent = vi.fn<() => Promise<Assessment[]>>(async () => []);
const getAttemptsByStudent = vi.fn<() => Promise<Attempt[]>>(async () => []);
const getMappingsByStudent = vi.fn<() => Promise<AcademicMapping[]>>(async () => []);

vi.mock('../../../lib/assessmentService', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAssessmentsForStudent: () => getAssessmentsForStudent(),
}));
vi.mock('../../../lib/submissionService', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAttemptsByStudent: () => getAttemptsByStudent(),
}));
vi.mock('../../../lib/firebaseService', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getMappingsByStudent: () => getMappingsByStudent(),
}));
vi.mock('../../context/StudentAuthContext', () => ({
  useStudentAuth: () => ({
    session: {
      studentId: 's1',
      name: 'Priya Menon',
      email: 'priya@x.edu',
      status: 'active',
      instituteName: 'Northwind Institute',
      instituteCode: 'A3B7C2',
      createdAt: '2026-01-04T00:00:00.000Z',
    },
    loading: false,
  }),
}));

const { StudentLandingPage } = await import('./StudentLandingPage');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ── Fixtures ──────────────────────────────────────────────────────

const NOW = new Date('2026-08-20T12:00:00.000Z');
const hours = (n: number) => new Date(NOW.getTime() + n * 3600_000).toISOString();

function assessment(over: Partial<Assessment> = {}): Assessment {
  return {
    id: 'a1',
    title: 'Thermodynamics',
    subject: 'Physics',
    status: 'active',
    totalMarks: 100,
    questions: [{ id: 'q1' }],
    maxAttempts: 1,
    passingScore: 40,
    showResults: true,
    allowReview: true,
    updatedAt: NOW.toISOString(),
    ...over,
  } as unknown as Assessment;
}

function attempt(over: Partial<Attempt> & { id: string }): Attempt {
  return {
    assessmentId: 'a1',
    studentId: 's1',
    status: 'submitted' as AttemptStatus,
    createdAt: hours(-40),
    startedAt: hours(-40),
    submittedAt: hours(-39),
    ...over,
  } as unknown as Attempt;
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  getAssessmentsForStudent.mockResolvedValue([]);
  getAttemptsByStudent.mockResolvedValue([]);
  getMappingsByStudent.mockResolvedValue([]);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

async function mount(): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <MemoryRouter>
        <StudentLandingPage />
      </MemoryRouter>,
    );
  });
  // Let the three fetches settle.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  return host!;
}

// ══════════════════════════════════════════════════════════════════

describe('StudentLandingPage', () => {
  it('greets the student by first name and says where they are', async () => {
    const el = await mount();
    expect(el.textContent).toContain('Priya.');
    expect(el.textContent).toContain('Northwind Institute');
    expect(el.textContent).toContain('priya@x.edu');
  });

  it('leads with the open exam that closes first', async () => {
    getAssessmentsForStudent.mockResolvedValue([
      assessment({ id: 'later', title: 'Optics', startDate: hours(-1), endDate: hours(30) }),
      assessment({ id: 'soon', title: 'Thermodynamics', startDate: hours(-1), endDate: hours(3) }),
    ]);
    const el = await mount();

    expect(el.textContent).toContain('Open now');
    // The headline card names the urgent one, and offers the action for it.
    expect(el.textContent).toContain('Thermodynamics');
    expect(el.textContent).toContain('Begin');
    expect(el.textContent).toContain('Closes in');
  });

  it('leads with an unfinished sitting over an exam that closes sooner', async () => {
    getAssessmentsForStudent.mockResolvedValue([
      assessment({ id: 'soon', title: 'Optics', startDate: hours(-1), endDate: hours(1) }),
      assessment({ id: 'mid', title: 'Thermodynamics', startDate: hours(-1), endDate: hours(9), maxAttempts: 2 }),
    ]);
    getAttemptsByStudent.mockResolvedValue([
      attempt({ id: 'live', assessmentId: 'mid', status: 'in_progress', submittedAt: undefined }),
    ]);
    const el = await mount();

    expect(el.textContent).toContain('You have a sitting in progress');
    expect(el.textContent).toContain('Resume sitting');
    // …and warns about the consequence of walking away from it.
    expect(el.textContent).toContain('submitted automatically');
  });

  it('counts down to the OPENING of a scheduled exam, not its close', async () => {
    getAssessmentsForStudent.mockResolvedValue([
      assessment({ id: 'future', title: 'Optics', startDate: hours(6), endDate: hours(9) }),
    ]);
    const el = await mount();

    expect(el.textContent).toContain('Scheduled next');
    expect(el.textContent).toContain('Opens in');
    // Nothing to start yet, so no Begin button to press.
    expect(el.textContent).not.toContain('Begin');
  });

  it('says nothing is due only when nothing actually is', async () => {
    getAssessmentsForStudent.mockResolvedValue([
      assessment({ id: 'over', startDate: hours(-40), endDate: hours(-2) }),
    ]);
    const el = await mount();
    expect(el.textContent).toContain('Nothing due');
  });

  it('summarises the account at a glance, including what is still being marked', async () => {
    getAssessmentsForStudent.mockResolvedValue([
      assessment({ id: 'open', startDate: hours(-1), endDate: hours(5) }),
      assessment({ id: 'done', title: 'Optics', startDate: hours(-40), endDate: hours(-2) }),
      assessment({ id: 'missed', title: 'Statics', startDate: hours(-40), endDate: hours(-2) }),
    ]);
    getAttemptsByStudent.mockResolvedValue([
      attempt({
        id: 'x',
        assessmentId: 'done',
        scores: {
          total: 72, available: 100, percentage: 72, passed: true,
          bySection: [], requiresManualReview: false,
        },
      } as unknown as Partial<Attempt> & { id: string }),
    ]);
    const el = await mount();

    expect(el.textContent).toContain('Open now');
    expect(el.textContent).toContain('Submitted');
    expect(el.textContent).toContain('Missed');
    expect(el.textContent).toContain('Average best');
    expect(el.textContent).toContain('72%');
  });

  it('shows the placement it was given, and an explanation when there is none', async () => {
    const el = await mount();
    expect(el.textContent).toContain('No placement yet');

    act(() => root!.unmount());
    root = null;
    host!.remove();

    getMappingsByStudent.mockResolvedValue([
      {
        id: 'm1',
        nodeType: 'course',
        nodeName: 'Applied Thermodynamics',
        breadcrumb: 'Northwind › Engineering › Applied Thermodynamics',
        createdAt: NOW.toISOString(),
      } as unknown as AcademicMapping,
    ]);
    const el2 = await mount();
    expect(el2.textContent).toContain('Applied Thermodynamics');
    expect(el2.textContent).toContain('Course');
  });

  it('surfaces a failed load with a way to try again', async () => {
    // The page logs the failure; that is correct behaviour and not something
    // this run needs to print.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getAssessmentsForStudent.mockRejectedValue(new Error('network is down'));
    const el = await mount();
    expect(el.textContent).toContain('network is down');
    expect(el.querySelector('[role="alert"]')).not.toBeNull();
  });
});
