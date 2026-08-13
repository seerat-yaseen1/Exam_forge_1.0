/**
 * WHICH RECORDS EACH TRASH VIEW ASKS FOR.
 *
 * The Web Owner's trash was one undifferentiated list of every deleted record
 * on the platform. It is now two views over the same component:
 *
 *   • inside an institute  → that institute's faculty and students, only
 *   • platform level       → deleted institutes, only
 *
 * Both call getAllTrashed. The entire correctness of the split therefore lives
 * in which collections it queries and which filters it attaches — a scoping
 * mistake would leak one tenant's deleted people into another tenant's screen,
 * which is the specific thing this change exists to prevent. So the queries are
 * asserted directly rather than inferred from the screen.
 *
 * Firestore is mocked because the assertion is about the QUERY, not about what
 * comes back: a stub that returns nothing still proves what was asked for.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: Array<{ collection: string; wheres: Array<[string, string, unknown]> }> = [];

vi.mock('./firebase', () => ({ db: {}, functions: {} }));

vi.mock('firebase/firestore', () => ({
  collection: (_db: unknown, name: string) => ({ __collection: name }),
  where: (field: string, op: string, value: unknown) => ({ __where: [field, op, value] }),
  query: (col: { __collection: string }, ...constraints: Array<{ __where: [string, string, unknown] }>) => {
    calls.push({
      collection: col.__collection,
      wheres: constraints.map((c) => c.__where),
    });
    return {};
  },
  getDocs: async () => ({ docs: [] }),
}));

const { getAllTrashed } = await import('./lifecycleService');

/** Which collections were queried, in a stable order. */
const collectionsQueried = () => calls.map((c) => c.collection).sort();
/** The instituteId filter attached to a given collection's query, if any. */
const instituteFilterFor = (name: string) =>
  calls.find((c) => c.collection === name)?.wheres.find((w) => w[0] === 'instituteId')?.[2];

beforeEach(() => { calls.length = 0; });

describe('institute-scoped trash (User Management → institute → Users → Trash)', () => {
  it('asks only for that institute\'s faculty and students', async () => {
    await getAllTrashed('inst_A');
    expect(collectionsQueried()).toEqual(['faculty', 'students']);
  });

  it('THE POINT — every query is filtered to that institute', async () => {
    await getAllTrashed('inst_A');
    // Without these, Institute A's screen would list Institute B's deleted
    // people. This is the assertion the whole change rests on.
    expect(instituteFilterFor('faculty')).toBe('inst_A');
    expect(instituteFilterFor('students')).toBe('inst_A');
  });

  it('never asks for institutes — a tenant does not sit inside a tenant', async () => {
    await getAllTrashed('inst_A');
    expect(collectionsQueried()).not.toContain('institutes');
  });

  it('still filters on softDeleted, so live records cannot appear', async () => {
    await getAllTrashed('inst_A');
    for (const c of calls) {
      expect(c.wheres).toContainEqual(['lifecycleState', '==', 'softDeleted']);
    }
  });
});

describe('platform-level trash (User Management)', () => {
  it('asks only for institutes', async () => {
    await getAllTrashed(undefined, ['institute']);
    expect(collectionsQueried()).toEqual(['institutes']);
  });

  it('THE POINT — it no longer reaches into people at all', async () => {
    await getAllTrashed(undefined, ['institute']);
    // The complaint that prompted this change: institute users were being
    // presented as a global Web Owner trash. They are not queried here now.
    expect(collectionsQueried()).not.toContain('faculty');
    expect(collectionsQueried()).not.toContain('students');
  });

  it('does not scope institutes by instituteId — the doc IS the institute', async () => {
    await getAllTrashed(undefined, ['institute']);
    expect(instituteFilterFor('institutes')).toBeUndefined();
  });
});

describe('the default is unchanged', () => {
  it('omitting roles with no institute still returns all three', async () => {
    // The Institute Admin's panel and any other existing caller pass no roles.
    // Their behaviour must be byte-identical to before the parameter existed.
    await getAllTrashed();
    expect(collectionsQueried()).toEqual(['faculty', 'institutes', 'students']);
  });

  it('omitting roles WITH an institute still returns faculty and students', async () => {
    // This is exactly what the Institute Admin's Trash does today
    // (InstituteLandingPage passes instituteId and nothing else).
    await getAllTrashed('inst_A');
    expect(collectionsQueried()).toEqual(['faculty', 'students']);
  });
});
