/**
 * ALLOCATION CORE — pure resolution logic (Phase B of plans/ALLOCATION_SYSTEM_PLAN.md)
 *
 * ZERO Firestore imports by design: this module operates on plain snapshots
 * so the exact code that runs in production is also the code the headless
 * sweep proves correct (functions/allocation.sweep.cjs). The fetch layer in
 * index.ts assembles CoreInput from targeted queries and passes it here.
 *
 * Semantics (identical to the D2 client scaffold, re-proven here):
 *   • A student mapped at ANY node is a member of every ancestor of that
 *     node — targeting a course includes students mapped at its sections
 *     and groups; targeting a year spans semester and semester-null chains.
 *   • Union across selected nodes; a multi-mapped student appears once,
 *     with every selected node that admitted them recorded in viaNodeIds.
 *   • Archived nodes: selecting one is a hard error (never a silent ∅);
 *     archived DESCENDANTS are excluded from expansion.
 *   • 'institute' mode = every student of the institute, mapped or not.
 */

// ── Node-type vocabulary ───────────────────────────────────────────

export const NODE_TYPE_ORDER = [
  'institute', 'school', 'academicLevel', 'program', 'academicSession',
  'academicYear', 'semester', 'course', 'section', 'group',
] as const;

export type AllocNodeType = (typeof NODE_TYPE_ORDER)[number];
export type SubNodeType = Exclude<AllocNodeType, 'institute'>;

export const NODE_TYPE_LABELS: Record<AllocNodeType, string> = {
  institute: 'Institute', school: 'School', academicLevel: 'Level',
  program: 'Program', academicSession: 'Session', academicYear: 'Year',
  semester: 'Semester', course: 'Course', section: 'Section', group: 'Group',
};

/** Firestore collection per node type (below institute). */
export const COLLECTION_OF: Record<SubNodeType, string> = {
  school: 'schools', academicLevel: 'academicLevels', program: 'programs',
  academicSession: 'academicSessions', academicYear: 'academicYears',
  semester: 'semesters', course: 'courses', section: 'sections', group: 'groups',
};

/** The ancestor-id field that descendant docs carry for a given level. */
export const ANCESTOR_FIELD: Record<SubNodeType, string> = {
  school: 'schoolId', academicLevel: 'levelId', program: 'programId',
  academicSession: 'sessionId', academicYear: 'yearId', semester: 'semesterId',
  course: 'courseId', section: 'sectionId',
  group: 'groupId', // groups have no descendants; never used for expansion
};

/** Node types strictly BELOW t (the expansion set). */
export function typesBelow(t: AllocNodeType): SubNodeType[] {
  const i = NODE_TYPE_ORDER.indexOf(t);
  return NODE_TYPE_ORDER.slice(i + 1) as SubNodeType[];
}

// ── Limits (system plan §2) ────────────────────────────────────────

export const MAX_NODES_PER_ALLOCATION = 200;
export const AUDIT_DELTA_ID_CAP = 5000;

// ── Core input / output shapes ─────────────────────────────────────

export type CoreSelectedNode = {
  id: string;
  name: string;
  status: string;            // 'active' | 'archived'
  instituteId: string;
};

export type CoreDescendant = {
  id: string;
  status: string;
  /** which SELECTED node this doc descends from (its ANCESTOR_FIELD[nodeType] value) */
  parentSelectedId: string;
};

export type CoreMapping = {
  studentId: string;
  nodeId: string;
  instituteId: string;
};

export type CoreInput = {
  nodeType: AllocNodeType;
  /** ids the caller asked for (to detect missing docs) */
  requestedIds: string[];
  /** the selected node docs that were actually found */
  selected: CoreSelectedNode[];
  /** all docs below nodeType whose ancestor field matches a selected id */
  descendants: CoreDescendant[];
  /** mappings at selected nodes ∪ descendants (fetch layer may over-fetch; core filters) */
  mappings: CoreMapping[];
  /** institute mode only: every student of the selected institute(s) */
  instituteStudents?: { id: string; instituteId: string }[];
  /** existing member studentIds with source == 'rules' (delta base) */
  currentRulesMemberIds: string[];
};

export type CoreMember = {
  studentId: string;
  instituteId: string;
  viaNodeIds: string[];
};

export type CoreResult = {
  /** always-fatal problems (bad selection) — commit AND dry-run report these */
  errors: string[];
  /** fatal only at commit (e.g. resolves to nobody) */
  commitBlockers: string[];
  /** non-blocking notices (zero-count nodes) */
  warnings: string[];
  members: CoreMember[];
  byNode: { nodeId: string; count: number }[];
  delta: { added: string[]; removed: string[] };
};

// ── Resolution ─────────────────────────────────────────────────────

export function resolveCore(input: CoreInput): CoreResult {
  const errors: string[] = [];
  const commitBlockers: string[] = [];
  const warnings: string[] = [];

  const { nodeType, requestedIds, selected } = input;

  // Shape validation
  if (!NODE_TYPE_ORDER.includes(nodeType)) {
    errors.push(`Unknown node type "${nodeType}".`);
  }
  if (requestedIds.length === 0) {
    errors.push('At least one node must be selected.');
  }
  if (requestedIds.length > MAX_NODES_PER_ALLOCATION) {
    errors.push(`Too many nodes selected (${requestedIds.length}); the cap is ${MAX_NODES_PER_ALLOCATION}.`);
  }
  if (new Set(requestedIds).size !== requestedIds.length) {
    errors.push('Duplicate node ids in the selection.');
  }

  // Existence + status + institute consistency
  const foundIds = new Set(selected.map((n) => n.id));
  requestedIds.forEach((id) => {
    if (!foundIds.has(id)) errors.push(`Node ${id} does not exist.`);
  });
  selected.forEach((n) => {
    if (n.status !== 'active') {
      errors.push(`"${n.name}" is archived — remove it from the selection (archived nodes never resolve silently).`);
    }
  });
  if (nodeType !== 'institute') {
    const insts = new Set(selected.map((n) => n.instituteId));
    if (insts.size > 1) {
      errors.push('All selected nodes must belong to the same institute.');
    }
  }

  if (errors.length > 0) {
    return { errors, commitBlockers, warnings, members: [], byNode: [], delta: { added: [], removed: [] } };
  }

  // ── Membership ───────────────────────────────────────────────────
  const via = new Map<string, Set<string>>();          // studentId → selected nodeIds
  const instOf = new Map<string, string>();            // studentId → instituteId
  const perNode = new Map<string, Set<string>>();      // selected nodeId → studentIds
  selected.forEach((n) => perNode.set(n.id, new Set()));

  const admit = (studentId: string, instituteId: string, viaNodeId: string) => {
    const v = via.get(studentId) ?? new Set<string>();
    v.add(viaNodeId);
    via.set(studentId, v);
    if (!instOf.has(studentId)) instOf.set(studentId, instituteId);
    perNode.get(viaNodeId)?.add(studentId);
  };

  if (nodeType === 'institute') {
    const byInst = new Map<string, string[]>();
    (input.instituteStudents ?? []).forEach((s) => {
      const arr = byInst.get(s.instituteId) ?? [];
      arr.push(s.id);
      byInst.set(s.instituteId, arr);
    });
    selected.forEach((inst) => {
      (byInst.get(inst.id) ?? []).forEach((sid) => admit(sid, inst.id, inst.id));
    });
  } else {
    // nodeId → the SELECTED node it belongs to. A descendant may point at
    // another descendant rather than straight at a selected node (B-2: a course
    // resolves sideways to sections, whose groups then point at those sections),
    // so we chain transitively up to the selected root. Iterating to a fixed
    // point also makes the result independent of descendant array order.
    const selectedIds = new Set(selected.map((n) => n.id));
    const parentOf = new Map<string, string>();
    input.descendants.forEach((d) => {
      if (d.status !== 'active') return;               // archived descendants excluded
      parentOf.set(d.id, d.parentSelectedId);
    });
    const owner = new Map<string, string>();
    selected.forEach((n) => owner.set(n.id, n.id));
    const rootOf = (id: string): string | undefined => {
      let cur: string | undefined = id;
      const seen = new Set<string>();
      while (cur && !selectedIds.has(cur)) {
        if (seen.has(cur)) return undefined;            // cycle guard
        seen.add(cur);
        cur = parentOf.get(cur);
      }
      return cur && selectedIds.has(cur) ? cur : undefined;
    };
    parentOf.forEach((_p, id) => {
      const root = rootOf(id);
      if (root) owner.set(id, root);
    });
    input.mappings.forEach((m) => {
      const own = owner.get(m.nodeId);
      if (own) admit(m.studentId, m.instituteId, own);
    });
  }

  const members: CoreMember[] = [...via.entries()]
    .map(([studentId, v]) => ({
      studentId,
      instituteId: instOf.get(studentId) ?? '',
      viaNodeIds: [...v].sort(),
    }))
    .sort((a, b) => a.studentId.localeCompare(b.studentId));

  const byNode = selected.map((n) => {
    const count = perNode.get(n.id)?.size ?? 0;
    if (count === 0) warnings.push(`"${n.name}" currently resolves to 0 students.`);
    return { nodeId: n.id, count };
  }).sort((a, b) => b.count - a.count);

  if (members.length === 0) {
    commitBlockers.push('This selection resolves to nobody — an assessment cannot be allocated to zero students.');
  }

  // ── Delta vs current rules-sourced members ───────────────────────
  // Manual members are INVISIBLE here by construction: the fetch layer only
  // passes source=='rules' ids, so sync can never add, remove, or re-count
  // a manually added member (system plan invariant 2).
  const current = new Set(input.currentRulesMemberIds);
  const next = new Set(members.map((m) => m.studentId));
  const added = [...next].filter((id) => !current.has(id)).sort();
  const removed = [...current].filter((id) => !next.has(id)).sort();

  return { errors, commitBlockers, warnings, members, byNode, delta: { added, removed } };
}

// ── Small shared helper ────────────────────────────────────────────

/** Chunk an array for Firestore 'in' queries (limit 30). */
export function chunk<T>(arr: T[], size = 30): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}