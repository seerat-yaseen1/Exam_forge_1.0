// ══════════════════════════════════════════════════════════════════
// ALLOCATION SERVICE — client-side support for rule-based allocation
// (Phase D2 of plans/ALLOCATION_SYSTEM_PLAN.md)
//
// PERMANENT parts of this file: types, hierarchy bundle loading,
// breadcrumb construction, node-row shaping. The picker and preview
// need these regardless of where resolution runs.
//
// ⚠️ SCAFFOLD (THROWAWAY) parts are marked with [SCAFFOLD] below:
// preview RESOLUTION currently runs in the browser so the UI can be
// exercised before the backend exists. In Phase B/C this is replaced
// by the `resolveAllocation` callable (dry-run mode) and DELETED.
// Nothing in this file ever WRITES — commit is server-only by design
// (system plan invariant 9).
// ══════════════════════════════════════════════════════════════════

import {
  firestoreQuery,
  getAllInstitutes,
  getStudentsByInstitute,
  NODE_LEVEL_LABELS,
  type AcademicLevel,
  type AcademicMapping,
  type AcademicSession,
  type AcademicYear,
  type Course,
  type Group,
  type Institute,
  type NodeLevel,
  type Program,
  type School,
  type Section,
  type Semester,
  type Student,
} from './firebaseService';

// ── Types ──────────────────────────────────────────────────────────

/** Everything selectable as an allocation target. 'institute' sits above NodeLevel. */
export type AllocationNodeType = 'institute' | NodeLevel;

export const ALLOCATION_NODE_TYPE_LABELS: Record<AllocationNodeType, string> = {
  institute: 'Institute',
  ...NODE_LEVEL_LABELS,
};

/** Ordered top→bottom. Filters for a picked type are exactly the types ABOVE it. */
export const ALLOCATION_TYPE_ORDER: AllocationNodeType[] = [
  'institute', 'school', 'academicLevel', 'program', 'academicSession',
  'academicYear', 'semester', 'course', 'section', 'group',
];

/** The ancestor-id field each hierarchy doc carries for a given level. */
export const LEVEL_ID_FIELD: Record<Exclude<AllocationNodeType, 'institute'>, string> = {
  school: 'schoolId',
  academicLevel: 'levelId',
  program: 'programId',
  academicSession: 'sessionId',
  academicYear: 'yearId',
  semester: 'semesterId',
  course: 'courseId',
  section: 'sectionId',
  group: 'groupId', // groups carry no descendants; field unused for filtering below group
};

/** The in-progress allocation choice, lifted into the builder so it survives step navigation. */
export type AllocationDraft = {
  instituteId: string;
  instituteName: string;
  nodeType: AllocationNodeType | '';
  nodeIds: string[];
};

export const emptyAllocationDraft = (): AllocationDraft => ({
  instituteId: '', instituteName: '', nodeType: '', nodeIds: [],
});

/** A picker/preview row: one selectable node, normalized across all nine collections. */
export type AllocationNodeRow = {
  id: string;
  nodeType: AllocationNodeType;
  name: string;
  instituteId: string;
  /** ancestor ids by field name (schoolId, levelId, …) — null when not applicable */
  ancestors: Record<string, string | null>;
  /** "School of Eng › UG › B.Tech › 2025-26 › Year 2 › Sem 3 › Data Structures" (path ABOVE the node) */
  breadcrumb: string;
  /** immediate parent display name — used for row grouping in the picker */
  parentName: string;
  /** resolved student headcount for this node (unique students mapped at-or-below it) */
  studentCount: number;
};

export type AllocationPreviewStudent = {
  id: string;
  name: string;
  email: string;
  /** which SELECTED node(s) admitted this student — the "via" answer */
  viaNodeIds: string[];
};

export type AllocationPreviewResult = {
  count: number;
  byNode: { nodeId: string; name: string; breadcrumb: string; count: number }[];
  students: AllocationPreviewStudent[];
};

// ── Institutes (thin passthrough for the panel) ───────────────────

export async function listInstitutesForAllocation(): Promise<Institute[]> {
  return getAllInstitutes();
}

// ── Hierarchy bundle ───────────────────────────────────────────────
// One load per institute: all nine node collections + mappings + students.
// This powers breadcrumbs, filter chips, per-node counts, and (for now)
// the scaffold resolution — all as pure in-memory work after one fetch pass.

export type HierarchyBundle = {
  instituteId: string;
  schools: School[];
  levels: AcademicLevel[];
  programs: Program[];
  sessions: AcademicSession[];
  years: AcademicYear[];
  semesters: Semester[];
  courses: Course[];
  sections: Section[];
  groups: Group[];
  mappings: AcademicMapping[];
  students: Student[];
  /** id → display name across every node collection (breadcrumb rendering) */
  nameOf: Map<string, string>;
};

const bundleCache = new Map<string, HierarchyBundle>();

export function invalidateHierarchyBundle(instituteId?: string) {
  if (instituteId) bundleCache.delete(instituteId);
  else bundleCache.clear();
}

export async function loadHierarchyBundle(instituteId: string, force = false): Promise<HierarchyBundle> {
  if (!force && bundleCache.has(instituteId)) return bundleCache.get(instituteId)!;

  const byInst = <T,>(col: string) =>
    firestoreQuery<T>(col, 'instituteId', '==', instituteId);

  const [
    schools, levels, programs, sessions, years,
    semesters, courses, sections, groups,
    mappings, students,
  ] = await Promise.all([
    byInst<School>('schools'),
    byInst<AcademicLevel>('academicLevels'),
    byInst<Program>('programs'),
    byInst<AcademicSession>('academicSessions'),
    byInst<AcademicYear>('academicYears'),
    byInst<Semester>('semesters'),
    byInst<Course>('courses'),
    byInst<Section>('sections'),
    byInst<Group>('groups'),
    byInst<AcademicMapping>('academicMappings'),
    getStudentsByInstitute(instituteId),
  ]);

  const active = <T extends { status?: string }>(rows: T[]) =>
    rows.filter((r) => (r as any).status !== 'archived');

  const nameOf = new Map<string, string>();
  const index = (rows: { id: string; name: string }[]) =>
    rows.forEach((r) => nameOf.set(r.id, r.name));
  [schools, levels, programs, sessions, years, semesters, courses, sections, groups]
    .forEach((rows) => index(rows as any));

  const bundle: HierarchyBundle = {
    instituteId,
    schools: active(schools), levels: active(levels), programs: active(programs),
    sessions: active(sessions), years: active(years), semesters: active(semesters),
    courses: active(courses), sections: active(sections), groups: active(groups),
    mappings, students, nameOf,
  };
  bundleCache.set(instituteId, bundle);
  return bundle;
}

// ── Node rows ──────────────────────────────────────────────────────

type AnyNode = {
  id: string; name: string; instituteId: string;
  schoolId?: string; levelId?: string; programId?: string; sessionId?: string;
  yearId?: string; semesterId?: string | null; courseId?: string; sectionId?: string;
};

function collectionFor(bundle: HierarchyBundle, t: AllocationNodeType): AnyNode[] {
  switch (t) {
    case 'school': return bundle.schools as AnyNode[];
    case 'academicLevel': return bundle.levels as AnyNode[];
    case 'program': return bundle.programs as AnyNode[];
    case 'academicSession': return bundle.sessions as AnyNode[];
    case 'academicYear': return bundle.years as AnyNode[];
    case 'semester': return bundle.semesters as AnyNode[];
    case 'course': return bundle.courses as AnyNode[];
    case 'section': return bundle.sections as AnyNode[];
    case 'group': return bundle.groups as AnyNode[];
    default: return [];
  }
}

const ANCESTOR_FIELDS_IN_ORDER: { type: AllocationNodeType; field: keyof AnyNode }[] = [
  { type: 'school', field: 'schoolId' },
  { type: 'academicLevel', field: 'levelId' },
  { type: 'program', field: 'programId' },
  { type: 'academicSession', field: 'sessionId' },
  { type: 'academicYear', field: 'yearId' },
  { type: 'semester', field: 'semesterId' },
  { type: 'course', field: 'courseId' },
  { type: 'section', field: 'sectionId' },
];

function breadcrumbFor(bundle: HierarchyBundle, node: AnyNode): { crumb: string; parentName: string } {
  const parts: string[] = [];
  ANCESTOR_FIELDS_IN_ORDER.forEach(({ field }) => {
    const id = node[field] as string | null | undefined;
    if (id) {
      const nm = bundle.nameOf.get(id);
      if (nm) parts.push(nm);
    }
  });
  return { crumb: parts.join(' › '), parentName: parts[parts.length - 1] ?? '—' };
}

/**
 * All active nodes of one type in the institute, shaped for the picker —
 * breadcrumb, parent grouping, ancestors for filter chips, and a resolved
 * per-node student count.
 */
export function nodeRowsOfType(bundle: HierarchyBundle, t: AllocationNodeType): AllocationNodeRow[] {
  if (t === 'institute') return []; // institute mode has no sub-node list
  const memberSets = memberSetsByNode(bundle, t);
  return collectionFor(bundle, t).map((n) => {
    const { crumb, parentName } = breadcrumbFor(bundle, n);
    const ancestors: Record<string, string | null> = {};
    ANCESTOR_FIELDS_IN_ORDER.forEach(({ field }) => {
      ancestors[field as string] = (n[field] as string | null | undefined) ?? null;
    });
    return {
      id: n.id, nodeType: t, name: n.name, instituteId: n.instituteId,
      ancestors, breadcrumb: crumb, parentName,
      studentCount: memberSets.get(n.id)?.size ?? 0,
    };
  }).sort((a, b) => a.breadcrumb.localeCompare(b.breadcrumb) || a.name.localeCompare(b.name));
}

/** How many nodes of each type exist — drives the node-type selector's counts. */
export function nodeTypeCounts(bundle: HierarchyBundle): Record<AllocationNodeType, number> {
  return {
    institute: 1,
    school: bundle.schools.length,
    academicLevel: bundle.levels.length,
    program: bundle.programs.length,
    academicSession: bundle.sessions.length,
    academicYear: bundle.years.length,
    semester: bundle.semesters.length,
    course: bundle.courses.length,
    section: bundle.sections.length,
    group: bundle.groups.length,
  };
}

// ── [SCAFFOLD] Resolution — replaced by the server dry-run in Phase B ──
// Mirrors the system-plan algorithm §3a-3: a node's member set = students
// with a mapping AT the node or at any DESCENDANT node (descendants found
// via the denormalized ancestor-id fields every doc carries). Union across
// the selected nodes; per-student via-node attribution retained.

function descendantIds(bundle: HierarchyBundle, t: Exclude<AllocationNodeType, 'institute'>, nodeId: string): Set<string> {
  const ids = new Set<string>([nodeId]);
  if (t === 'group') return ids; // leaf
  const field = LEVEL_ID_FIELD[t];
  const below = ALLOCATION_TYPE_ORDER.slice(ALLOCATION_TYPE_ORDER.indexOf(t) + 1) as
    Exclude<AllocationNodeType, 'institute'>[];
  below.forEach((childType) => {
    collectionFor(bundle, childType).forEach((n) => {
      if ((n as any)[field] === nodeId) ids.add(n.id);
    });
  });
  return ids;
}

/** [SCAFFOLD] Unique member set per node of type t (drives per-row counts). */
function memberSetsByNode(bundle: HierarchyBundle, t: Exclude<AllocationNodeType, 'institute'>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  // Precompute mapping-node → students once.
  const byMappedNode = new Map<string, string[]>();
  bundle.mappings.forEach((m) => {
    const arr = byMappedNode.get(m.nodeId) ?? [];
    arr.push(m.studentId);
    byMappedNode.set(m.nodeId, arr);
  });
  collectionFor(bundle, t).forEach((n) => {
    const set = new Set<string>();
    descendantIds(bundle, t, n.id).forEach((did) => {
      (byMappedNode.get(did) ?? []).forEach((sid) => set.add(sid));
    });
    out.set(n.id, set);
  });
  return out;
}

/**
 * [SCAFFOLD] Client-side preview resolution — union of the selected nodes,
 * with via-node attribution. Institute mode = every student of the institute
 * (mapped or not), matching system-plan D2/D8 semantics.
 * DELETED in Phase C when the UI switches to resolveAllocation(dryRun).
 */
export function resolvePreviewScaffold(
  bundle: HierarchyBundle,
  nodeType: AllocationNodeType,
  nodeIds: string[],
): AllocationPreviewResult {
  const studentInfo = new Map(bundle.students.map((s) => [s.id, s]));

  if (nodeType === 'institute') {
    const students = bundle.students.map((s) => ({
      id: s.id, name: s.name ?? s.id, email: s.email ?? '', viaNodeIds: [bundle.instituteId],
    }));
    return {
      count: students.length,
      byNode: [{ nodeId: bundle.instituteId, name: 'Entire institute', breadcrumb: '', count: students.length }],
      students,
    };
  }

  const t = nodeType as Exclude<AllocationNodeType, 'institute'>;
  const rows = new Map(nodeRowsOfType(bundle, t).map((r) => [r.id, r]));
  const via = new Map<string, Set<string>>(); // studentId → selected nodeIds
  const byNode: AllocationPreviewResult['byNode'] = [];

  const byMappedNode = new Map<string, string[]>();
  bundle.mappings.forEach((m) => {
    const arr = byMappedNode.get(m.nodeId) ?? [];
    arr.push(m.studentId);
    byMappedNode.set(m.nodeId, arr);
  });

  nodeIds.forEach((nid) => {
    const set = new Set<string>();
    descendantIds(bundle, t, nid).forEach((did) => {
      (byMappedNode.get(did) ?? []).forEach((sid) => set.add(sid));
    });
    set.forEach((sid) => {
      const v = via.get(sid) ?? new Set<string>();
      v.add(nid);
      via.set(sid, v);
    });
    const row = rows.get(nid);
    byNode.push({
      nodeId: nid,
      name: row?.name ?? nid,
      breadcrumb: row?.breadcrumb ?? '',
      count: set.size,
    });
  });

  const students: AllocationPreviewStudent[] = [...via.entries()].map(([sid, v]) => {
    const s = studentInfo.get(sid);
    return { id: sid, name: s?.name ?? sid, email: s?.email ?? '', viaNodeIds: [...v] };
  }).sort((a, b) => a.name.localeCompare(b.name));

  return { count: students.length, byNode: byNode.sort((a, b) => b.count - a.count), students };
}