import { describe, it, expect } from 'vitest';
import {
  resolveCore,
  chunk,
  typesBelow,
  NODE_TYPE_ORDER,
  MAX_NODES_PER_ALLOCATION,
  type CoreInput,
} from './allocationCore';

describe('typesBelow', () => {
  it('returns every type below the given type, in order', () => {
    expect(typesBelow('academicYear')).toEqual(['semester', 'course', 'section', 'group']);
  });

  it('returns an empty array for the last type in the order', () => {
    expect(typesBelow('group')).toEqual([]);
  });

  it('returns everything except institute when called on institute', () => {
    expect(typesBelow('institute')).toEqual(NODE_TYPE_ORDER.slice(1));
  });
});

describe('chunk', () => {
  it('chunks an array into groups of the default size (30)', () => {
    const arr = Array.from({ length: 65 }, (_, i) => i);
    const chunks = chunk(arr);
    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(30);
    expect(chunks[1].length).toBe(30);
    expect(chunks[2].length).toBe(5);
  });

  it('respects a custom chunk size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns an empty array for an empty input', () => {
    expect(chunk([])).toEqual([]);
  });
});

describe('resolveCore', () => {
  const baseInput = (overrides: Partial<CoreInput> = {}): CoreInput => ({
    nodeType: 'section',
    requestedIds: ['s1'],
    selected: [{ id: 's1', name: 'Section 1', status: 'active', instituteId: 'inst1' }],
    descendants: [],
    mappings: [],
    currentRulesMemberIds: [],
    ...overrides,
  });

  it('errors on an unknown node type', () => {
    const result = resolveCore(baseInput({ nodeType: 'bogus' as any }));
    expect(result.errors).toContain('Unknown node type "bogus".');
  });

  it('errors when no nodes are selected', () => {
    const result = resolveCore(baseInput({ requestedIds: [] }));
    expect(result.errors).toContain('At least one node must be selected.');
  });

  it('errors when the selection exceeds MAX_NODES_PER_ALLOCATION', () => {
    const ids = Array.from({ length: MAX_NODES_PER_ALLOCATION + 1 }, (_, i) => `n${i}`);
    const result = resolveCore(baseInput({ requestedIds: ids, selected: [] }));
    expect(result.errors.some((e) => e.includes('Too many nodes selected'))).toBe(true);
  });

  it('errors on duplicate ids in the selection', () => {
    const result = resolveCore(baseInput({ requestedIds: ['s1', 's1'] }));
    expect(result.errors).toContain('Duplicate node ids in the selection.');
  });

  it('errors when a requested node does not exist', () => {
    const result = resolveCore(baseInput({ requestedIds: ['missing'], selected: [] }));
    expect(result.errors).toContain('Node missing does not exist.');
  });

  it('errors when a selected node is archived', () => {
    const result = resolveCore(baseInput({
      selected: [{ id: 's1', name: 'Section 1', status: 'archived', instituteId: 'inst1' }],
    }));
    expect(result.errors.some((e) => e.includes('archived'))).toBe(true);
  });

  it('errors when selected nodes span multiple institutes', () => {
    const result = resolveCore(baseInput({
      requestedIds: ['s1', 's2'],
      selected: [
        { id: 's1', name: 'Section 1', status: 'active', instituteId: 'inst1' },
        { id: 's2', name: 'Section 2', status: 'active', instituteId: 'inst2' },
      ],
    }));
    expect(result.errors).toContain('All selected nodes must belong to the same institute.');
  });

  it('resolves direct mappings at a selected node', () => {
    const result = resolveCore(baseInput({
      mappings: [{ studentId: 'stu1', nodeId: 's1', instituteId: 'inst1' }],
    }));
    expect(result.errors).toEqual([]);
    expect(result.members).toEqual([
      { studentId: 'stu1', instituteId: 'inst1', viaNodeIds: ['s1'] },
    ]);
    expect(result.byNode).toEqual([{ nodeId: 's1', count: 1 }]);
  });

  it('includes students mapped at descendant nodes (transitive chain)', () => {
    const result = resolveCore(baseInput({
      nodeType: 'academicYear',
      requestedIds: ['y1'],
      selected: [{ id: 'y1', name: 'Year 1', status: 'active', instituteId: 'inst1' }],
      descendants: [
        { id: 'sem1', status: 'active', parentSelectedId: 'y1' },
        { id: 'sec1', status: 'active', parentSelectedId: 'sem1' },
      ],
      mappings: [{ studentId: 'stu1', nodeId: 'sec1', instituteId: 'inst1' }],
    }));
    expect(result.errors).toEqual([]);
    expect(result.members[0].studentId).toBe('stu1');
    expect(result.members[0].viaNodeIds).toEqual(['y1']);
  });

  it('excludes archived descendants from expansion', () => {
    const result = resolveCore(baseInput({
      nodeType: 'academicYear',
      requestedIds: ['y1'],
      selected: [{ id: 'y1', name: 'Year 1', status: 'active', instituteId: 'inst1' }],
      descendants: [
        { id: 'sem1', status: 'archived', parentSelectedId: 'y1' },
      ],
      mappings: [{ studentId: 'stu1', nodeId: 'sem1', instituteId: 'inst1' }],
    }));
    expect(result.members).toEqual([]);
    expect(result.commitBlockers.length).toBeGreaterThan(0);
  });

  it('unions multi-mapped students and records every admitting node', () => {
    const result = resolveCore(baseInput({
      requestedIds: ['s1', 's2'],
      selected: [
        { id: 's1', name: 'Section 1', status: 'active', instituteId: 'inst1' },
        { id: 's2', name: 'Section 2', status: 'active', instituteId: 'inst1' },
      ],
      mappings: [
        { studentId: 'stu1', nodeId: 's1', instituteId: 'inst1' },
        { studentId: 'stu1', nodeId: 's2', instituteId: 'inst1' },
      ],
    }));
    expect(result.members.length).toBe(1);
    expect(result.members[0].viaNodeIds).toEqual(['s1', 's2']);
  });

  it('institute mode admits every institute student regardless of mapping', () => {
    const result = resolveCore(baseInput({
      nodeType: 'institute',
      requestedIds: ['inst1'],
      selected: [{ id: 'inst1', name: 'Institute 1', status: 'active', instituteId: 'inst1' }],
      instituteStudents: [{ id: 'stu1', instituteId: 'inst1' }, { id: 'stu2', instituteId: 'inst1' }],
    }));
    expect(result.members.map((m) => m.studentId).sort()).toEqual(['stu1', 'stu2']);
  });

  it('warns when a selected node resolves to zero students', () => {
    const result = resolveCore(baseInput());
    expect(result.warnings.some((w) => w.includes('resolves to 0 students'))).toBe(true);
  });

  it('sets a commitBlocker when the whole selection resolves to nobody', () => {
    const result = resolveCore(baseInput());
    expect(result.commitBlockers.length).toBeGreaterThan(0);
    expect(result.members).toEqual([]);
  });

  it('computes delta added/removed against currentRulesMemberIds', () => {
    const result = resolveCore(baseInput({
      mappings: [{ studentId: 'stu2', nodeId: 's1', instituteId: 'inst1' }],
      currentRulesMemberIds: ['stu1'],
    }));
    expect(result.delta.added).toEqual(['stu2']);
    expect(result.delta.removed).toEqual(['stu1']);
  });

  it('does not include manual (non-rules) members in the delta baseline', () => {
    const result = resolveCore(baseInput({
      mappings: [{ studentId: 'stu1', nodeId: 's1', instituteId: 'inst1' }],
      currentRulesMemberIds: [],
    }));
    // stu1 resolves fresh; since it wasn't in currentRulesMemberIds it's "added"
    expect(result.delta.added).toEqual(['stu1']);
    expect(result.delta.removed).toEqual([]);
  });

  it('short-circuits and returns no members/byNode when there are validation errors', () => {
    const result = resolveCore(baseInput({ requestedIds: [] }));
    expect(result.members).toEqual([]);
    expect(result.byNode).toEqual([]);
    expect(result.delta).toEqual({ added: [], removed: [] });
  });
});
