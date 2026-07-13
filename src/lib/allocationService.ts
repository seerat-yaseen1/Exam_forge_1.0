// ══════════════════════════════════════════════════════════════════
// ALLOCATION SERVICE — client support for rule-based allocation
// (Phase C of plans/ALLOCATION_SYSTEM_PLAN.md)
//
// PERMANENT: types, hierarchy bundle loading, breadcrumb construction,
// node-row shaping (the PICKER needs these locally regardless of where
// resolution runs).
//
// Phase C: the D2 client scaffold resolver is GONE. Preview and commit
// now call the `resolveAllocation` Cloud Function (dry-run / commit);
// manual adds call `addManualMember`; the resolved list pages through
// `getAllocationPreviewPage`. Nothing here writes directly — commit is
// server-only by design (system plan invariant 9).
// ══════════════════════════════════════════════════════════════════

import { httpsCallable } from 'firebase/functions';
import { functions } from './firebase';

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
 *
 * NOTE: the per-node count here is a LOCAL, display-only estimate computed
 * from the already-loaded bundle so the picker rows show a number without a
 * round-trip. The AUTHORITATIVE counts come from resolveAllocation(dryRun)
 * once nodes are selected (system plan §3a). Picker counts and server counts
 * agree by construction (same upward-membership rule), but the server is the
 * source of truth.
 */
export function nodeRowsOfType(bundle: HierarchyBundle, t: AllocationNodeType): AllocationNodeRow[] {
  if (t === 'institute') return []; // institute mode has no sub-node list
  const memberSets = localMemberSetsByNode(bundle, t);
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

/** Local, display-only member set per node (drives picker row counts). */
function localMemberSetsByNode(bundle: HierarchyBundle, t: Exclude<AllocationNodeType, 'institute'>): Map<string, Set<string>> {
  const byMappedNode = new Map<string, string[]>();
  bundle.mappings.forEach((m) => {
    const arr = byMappedNode.get(m.nodeId) ?? [];
    arr.push(m.studentId);
    byMappedNode.set(m.nodeId, arr);
  });
  const below = ALLOCATION_TYPE_ORDER.slice(ALLOCATION_TYPE_ORDER.indexOf(t) + 1) as
    Exclude<AllocationNodeType, 'institute'>[];
  const field = LEVEL_ID_FIELD[t];
  const out = new Map<string, Set<string>>();
  collectionFor(bundle, t).forEach((n) => {
    const set = new Set<string>();
    (byMappedNode.get(n.id) ?? []).forEach((sid) => set.add(sid));
    if (t !== 'group') {
      below.forEach((childType) => {
        collectionFor(bundle, childType).forEach((c) => {
          if ((c as any)[field] === n.id && (c as any).status !== 'archived') {
            (byMappedNode.get(c.id) ?? []).forEach((sid) => set.add(sid));
          }
        });
      });
    }
    out.set(n.id, set);
  });
  return out;
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

// ── Server callables (Phase C) ─────────────────────────────────────

export type ResolvePreviewResponse = {
  valid: boolean;
  errors: string[];
  commitBlockers: string[];
  warnings: string[];
  resolvedCount: number;
  byNode: { nodeId: string; count: number }[];
  deltaCounts: { added: number; removed: number };
  sampleStudents: { id: string; name: string; email: string }[];
  isLive: boolean;
};

export type ResolveCommitResponse = {
  version: number;
  resolvedCount: number;
  deltaCounts: { added: number; removed: number };
};

/** Dry-run preview — the live footer's source of truth (replaces the scaffold). */
export async function previewAllocation(
  assessmentId: string,
  nodeType: AllocationNodeType,
  nodeIds: string[],
  expectedVersion: number,
): Promise<ResolvePreviewResponse> {
  const call = httpsCallable<
    { assessmentId: string; nodeType: string; nodeIds: string[]; expectedVersion: number; dryRun: boolean },
    ResolvePreviewResponse
  >(functions, 'resolveAllocation');
  const res = await call({ assessmentId, nodeType, nodeIds, expectedVersion, dryRun: true });
  return res.data;
}

/** Commit — the only write path. Throws on validation / version-mismatch / live-shrink. */
export async function commitAllocation(
  assessmentId: string,
  nodeType: AllocationNodeType,
  nodeIds: string[],
  expectedVersion: number,
): Promise<ResolveCommitResponse> {
  const call = httpsCallable<
    { assessmentId: string; nodeType: string; nodeIds: string[]; expectedVersion: number; dryRun: boolean },
    ResolveCommitResponse
  >(functions, 'resolveAllocation');
  const res = await call({ assessmentId, nodeType, nodeIds, expectedVersion, dryRun: false });
  return res.data;
}

/** Roster "Add student" — idempotent, webOwner-only, external/retest escape hatch. */
export async function addManualMember(
  assessmentId: string,
  studentId: string,
): Promise<{ ok: boolean; alreadyMember: boolean; source?: string }> {
  const call = httpsCallable<
    { assessmentId: string; studentId: string },
    { ok: boolean; alreadyMember: boolean; source?: string }
  >(functions, 'addManualMember');
  const res = await call({ assessmentId, studentId });
  return res.data;
}

export type AllocationMemberRow = {
  docId: string; studentId: string; instituteId: string; source: string;
  viaNodeIds: string[]; addedBy: string; createdAt: string; name: string; email: string;
};

/** Paged resolved-list reads — never downloads the whole list at once. */
export async function getAllocationPreviewPage(
  assessmentId: string,
  opts: { limit?: number; cursor?: string; source?: 'rules' | 'manual' } = {},
): Promise<{ rows: AllocationMemberRow[]; nextCursor: string | null }> {
  const call = httpsCallable<
    { assessmentId: string; limit?: number; cursor?: string; source?: 'rules' | 'manual' },
    { rows: AllocationMemberRow[]; nextCursor: string | null }
  >(functions, 'getAllocationPreviewPage');
  const res = await call({ assessmentId, ...opts });
  return res.data;
}

/** Read the stored allocation doc (version + node summaries) for edit mode. */
export async function getAllocation(assessmentId: string): Promise<{
  version: number; nodeType: AllocationNodeType; nodeIds: string[];
  nodes: { nodeId: string; nodeName: string; breadcrumb: string; instituteId: string }[];
  resolvedCount: number; manualCount: number; instituteId: string;
} | null> {
  const snap = await firestoreQuery<any>('allocations', 'assessmentId', '==', assessmentId);
  const doc = snap[0];
  if (!doc) return null;
  return {
    version: doc.version ?? 0,
    nodeType: doc.nodeType, nodeIds: doc.nodeIds ?? [], nodes: doc.nodes ?? [],
    resolvedCount: doc.resolvedCount ?? 0, manualCount: doc.manualCount ?? 0,
    instituteId: doc.instituteId ?? '',
  };
}