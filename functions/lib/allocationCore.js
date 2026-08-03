"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.AUDIT_DELTA_ID_CAP = exports.MAX_NODES_PER_ALLOCATION = exports.ANCESTOR_FIELD = exports.COLLECTION_OF = exports.NODE_TYPE_LABELS = exports.NODE_TYPE_ORDER = void 0;
exports.typesBelow = typesBelow;
exports.resolveCore = resolveCore;
exports.chunk = chunk;
// ── Node-type vocabulary ───────────────────────────────────────────
exports.NODE_TYPE_ORDER = [
    'institute', 'school', 'academicLevel', 'program', 'academicSession',
    'academicYear', 'semester', 'course', 'section', 'group',
];
exports.NODE_TYPE_LABELS = {
    institute: 'Institute', school: 'School', academicLevel: 'Level',
    program: 'Program', academicSession: 'Session', academicYear: 'Year',
    semester: 'Semester', course: 'Course', section: 'Section', group: 'Group',
};
/** Firestore collection per node type (below institute). */
exports.COLLECTION_OF = {
    school: 'schools', academicLevel: 'academicLevels', program: 'programs',
    academicSession: 'academicSessions', academicYear: 'academicYears',
    semester: 'semesters', course: 'courses', section: 'sections', group: 'groups',
};
/** The ancestor-id field that descendant docs carry for a given level. */
exports.ANCESTOR_FIELD = {
    school: 'schoolId', academicLevel: 'levelId', program: 'programId',
    academicSession: 'sessionId', academicYear: 'yearId', semester: 'semesterId',
    course: 'courseId', section: 'sectionId',
    group: 'groupId', // groups have no descendants; never used for expansion
};
/** Node types strictly BELOW t (the expansion set). */
function typesBelow(t) {
    const i = exports.NODE_TYPE_ORDER.indexOf(t);
    return exports.NODE_TYPE_ORDER.slice(i + 1);
}
// ── Limits (system plan §2) ────────────────────────────────────────
exports.MAX_NODES_PER_ALLOCATION = 200;
exports.AUDIT_DELTA_ID_CAP = 5000;
// ── Resolution ─────────────────────────────────────────────────────
function resolveCore(input) {
    const errors = [];
    const commitBlockers = [];
    const warnings = [];
    const { nodeType, requestedIds, selected } = input;
    // Shape validation
    if (!exports.NODE_TYPE_ORDER.includes(nodeType)) {
        errors.push(`Unknown node type "${nodeType}".`);
    }
    if (requestedIds.length === 0) {
        errors.push('At least one node must be selected.');
    }
    if (requestedIds.length > exports.MAX_NODES_PER_ALLOCATION) {
        errors.push(`Too many nodes selected (${requestedIds.length}); the cap is ${exports.MAX_NODES_PER_ALLOCATION}.`);
    }
    if (new Set(requestedIds).size !== requestedIds.length) {
        errors.push('Duplicate node ids in the selection.');
    }
    // Existence + status + institute consistency
    const foundIds = new Set(selected.map((n) => n.id));
    requestedIds.forEach((id) => {
        if (!foundIds.has(id))
            errors.push(`Node ${id} does not exist.`);
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
    const via = new Map(); // studentId → selected nodeIds
    const instOf = new Map(); // studentId → instituteId
    const perNode = new Map(); // selected nodeId → studentIds
    selected.forEach((n) => perNode.set(n.id, new Set()));
    const admit = (studentId, instituteId, viaNodeId) => {
        const v = via.get(studentId) ?? new Set();
        v.add(viaNodeId);
        via.set(studentId, v);
        if (!instOf.has(studentId))
            instOf.set(studentId, instituteId);
        perNode.get(viaNodeId)?.add(studentId);
    };
    if (nodeType === 'institute') {
        const byInst = new Map();
        (input.instituteStudents ?? []).forEach((s) => {
            const arr = byInst.get(s.instituteId) ?? [];
            arr.push(s.id);
            byInst.set(s.instituteId, arr);
        });
        selected.forEach((inst) => {
            (byInst.get(inst.id) ?? []).forEach((sid) => admit(sid, inst.id, inst.id));
        });
    }
    else {
        // nodeId → the SELECTED node it belongs to. A descendant may point at
        // another descendant rather than straight at a selected node (B-2: a course
        // resolves sideways to sections, whose groups then point at those sections),
        // so we chain transitively up to the selected root. Iterating to a fixed
        // point also makes the result independent of descendant array order.
        const selectedIds = new Set(selected.map((n) => n.id));
        const parentOf = new Map();
        input.descendants.forEach((d) => {
            if (d.status !== 'active')
                return; // archived descendants excluded
            parentOf.set(d.id, d.parentSelectedId);
        });
        const owner = new Map();
        selected.forEach((n) => owner.set(n.id, n.id));
        const rootOf = (id) => {
            let cur = id;
            const seen = new Set();
            while (cur && !selectedIds.has(cur)) {
                if (seen.has(cur))
                    return undefined; // cycle guard
                seen.add(cur);
                cur = parentOf.get(cur);
            }
            return cur && selectedIds.has(cur) ? cur : undefined;
        };
        parentOf.forEach((_p, id) => {
            const root = rootOf(id);
            if (root)
                owner.set(id, root);
        });
        input.mappings.forEach((m) => {
            const own = owner.get(m.nodeId);
            if (own)
                admit(m.studentId, m.instituteId, own);
        });
    }
    const members = [...via.entries()]
        .map(([studentId, v]) => ({
        studentId,
        instituteId: instOf.get(studentId) ?? '',
        viaNodeIds: [...v].sort(),
    }))
        .sort((a, b) => a.studentId.localeCompare(b.studentId));
    const byNode = selected.map((n) => {
        const count = perNode.get(n.id)?.size ?? 0;
        if (count === 0)
            warnings.push(`"${n.name}" currently resolves to 0 students.`);
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
function chunk(arr, size = 30) {
    const out = [];
    for (let i = 0; i < arr.length; i += size)
        out.push(arr.slice(i, i + size));
    return out;
}
//# sourceMappingURL=allocationCore.js.map