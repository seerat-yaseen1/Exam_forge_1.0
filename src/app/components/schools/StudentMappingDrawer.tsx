import { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  X, Search, Loader2, Users, Check, UserMinus, UserPlus,
} from 'lucide-react';
import {
  getStudentsByInstitute,
  getMappingsByNode,
  getMappingsByStudent,
  createMapping,
  deleteMapping,
  generateId,
  type NodeLevel,
  NODE_LEVEL_LABELS,
  type AcademicMapping,
  type Student,
} from '../../../lib/firebaseService';

interface Props {
  open: boolean;
  nodeId: string;
  nodeType: NodeLevel;
  nodeName: string;
  breadcrumb: string;
  instituteId: string;
  onClose: () => void;
}

export function StudentMappingDrawer({ open, nodeId, nodeType, nodeName, breadcrumb, instituteId, onClose }: Props) {
  // Institute students
  const [students, setStudents] = useState<Student[]>([]);
  // Mappings already pointing to THIS node
  const [existingMappings, setExistingMappings] = useState<AcademicMapping[]>([]);
  const [loading, setLoading] = useState(false);

  // Selection state
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Saving
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [successCount, setSuccessCount] = useState<number | null>(null);

  // Search
  const [search, setSearch] = useState('');

  const alreadyMappedIds = useMemo(
    () => new Set(existingMappings.map((m) => m.studentId)),
    [existingMappings]
  );

  // B-1 — cross-node membership: a student may be in MULTIPLE sections/groups.
  // Map studentId → their OTHER placements (excluding this node), so an admin
  // sees "already in Section A · Group 2" while assigning and avoids accidental
  // double-placement. Multiple membership is allowed by design — this is
  // transparency, not a block.
  const [otherPlacements, setOtherPlacements] = useState<Map<string, string[]>>(new Map());

  // ── Fetch data ──────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setSuccessCount(null);
    setSearch('');
    setLoading(true);
    Promise.all([
      getStudentsByInstitute(instituteId),
      getMappingsByNode(nodeId),
    ])
      .then(([studs, maps]) => {
        setStudents(studs.filter((s) => s.status === 'active'));
        setExistingMappings(maps);
        // Load each student's other placements (section/group level only —
        // those are the meaningful "also assigned here" signals). Fire-and-
        // forget: the list renders immediately, placement chips fill in after.
        loadOtherPlacements(studs.filter((s) => s.status === 'active').map((s) => s.id));
      })
      .finally(() => setLoading(false));
  }, [open, nodeId, instituteId]);

  // Load other section/group placements for the visible students.
  const loadOtherPlacements = async (studentIds: string[]) => {
    const map = new Map<string, string[]>();
    // Cap the lookup to keep it light on very large institutes; the rest still
    // assign fine, they just won't show the chip until reopened/searched.
    const capped = studentIds.slice(0, 300);
    await Promise.all(capped.map(async (sid) => {
      try {
        const mine = await getMappingsByStudent(sid);
        const others = mine
          .filter((m) => m.nodeId !== nodeId &&
            (m.nodeType === 'section' || m.nodeType === 'group'))
          .map((m) => m.nodeName)
          .filter(Boolean);
        if (others.length > 0) map.set(sid, others);
      } catch { /* non-fatal — chip just won't show */ }
    }));
    setOtherPlacements(map);
  };

  // ── Filtered students ───────────────────────────────────────────

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return students;
    return students.filter(
      (s) => s.name.toLowerCase().includes(q) || s.email.toLowerCase().includes(q)
    );
  }, [students, search]);

  // ── Toggle selection ────────────────────────────────────────────

  const toggleStudent = (studentId: string) => {
    if (alreadyMappedIds.has(studentId)) return; // already mapped, not selectable
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(studentId)) next.delete(studentId);
      else next.add(studentId);
      return next;
    });
  };

  // ── Assign ──────────────────────────────────────────────────────

  const handleAssign = async () => {
    if (selected.size === 0) return;
    setSaving(true);

    // Note: same-node duplicates can't occur here — already-mapped students are
    // unselectable (toggleStudent guard). Multiple membership across DIFFERENT
    // nodes is allowed and expected; the placement chips show where else a
    // student sits so this is a deliberate choice, not an accident.

    // Create mappings for all selected students
    const now = new Date().toISOString();
    const createdMappings: AcademicMapping[] = [];
    for (const studentId of selected) {
      const student = students.find((s) => s.id === studentId)!;
      const mapping: AcademicMapping = {
        id: generateId(),
        instituteId,
        studentId,
        studentName: student.name,
        studentEmail: student.email,
        nodeType,
        nodeId,
        nodeName,
        breadcrumb,
        createdAt: now,
      };
      await createMapping(mapping);
      createdMappings.push(mapping);
    }

    setExistingMappings((prev) => [...prev, ...createdMappings]);
    setSelected(new Set());
    setSuccessCount(createdMappings.length);
    setSaving(false);
    setTimeout(() => setSuccessCount(null), 4000);
  };

  // ── Remove mapping ──────────────────────────────────────────────

  const handleRemove = async (mappingId: string) => {
    setRemovingId(mappingId);
    try {
      await deleteMapping(mappingId);
      setExistingMappings((prev) => prev.filter((m) => m.id !== mappingId));
    } finally {
      setRemovingId(null);
    }
  };

  // ── Render ──────────────────────────────────────────────────────

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-40"
            style={{ background: 'rgba(12,12,11,0.18)' }}
            onClick={onClose}
          />

          {/* Drawer — wider to show two sections */}
          <motion.div
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="fixed right-0 top-0 bottom-0 z-50 flex flex-col w-full sm:w-[500px] sm:max-w-full"
            style={{ background: '#FFFFFF', borderLeft: '1px solid #E3E1DB', boxShadow: '-8px 0 32px rgba(12,12,11,0.06)' }}
          >
            {/* Header */}
            <div className="px-4 sm:px-6 py-4 sm:py-5" style={{ borderBottom: '1px solid #E3E1DB' }}>
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-xs mb-0.5" style={{ color: '#6B6B66', letterSpacing: '0.08em' }}>
                    ASSIGN STUDENTS · {NODE_LEVEL_LABELS[nodeType].toUpperCase()}
                  </p>
                  <h2 className="text-sm" style={{ color: '#0C0C0B' }}>{nodeName}</h2>
                  <p className="text-xs mt-1 truncate" style={{ color: '#6B6B66' }}>{breadcrumb}</p>
                </div>
                <button onClick={onClose} style={{ color: '#6B6B66', flexShrink: 0, marginTop: 2 }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = '#0C0C0B')}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = '#6B6B66')}>
                  <X size={16} strokeWidth={1.5} />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <div className="flex items-center justify-center py-20">
                  <Loader2 size={18} strokeWidth={1} className="animate-spin" style={{ color: '#6B6B66' }} />
                </div>
              ) : (
                <>
                  {/* ── Currently assigned ── */}
                  {existingMappings.length > 0 && (
                    <div className="px-6 py-4" style={{ borderBottom: '1px solid #F0EFEB' }}>
                      <p className="text-xs mb-3" style={{ color: '#6B6B66', letterSpacing: '0.06em' }}>
                        CURRENTLY ASSIGNED ({existingMappings.length})
                      </p>
                      <div className="space-y-1">
                        {existingMappings.map((m) => (
                          <div
                            key={m.id}
                            className="flex items-center justify-between px-3 py-2 rounded"
                            style={{ background: '#F7F6F3', border: '1px solid #E3E1DB' }}
                          >
                            <div className="min-w-0">
                              <p className="text-xs truncate" style={{ color: '#0C0C0B' }}>{m.studentName}</p>
                              <p className="text-xs truncate" style={{ color: '#6B6B66' }}>{m.studentEmail}</p>
                            </div>
                            <button
                              onClick={() => handleRemove(m.id)}
                              disabled={removingId === m.id}
                              title="Remove assignment"
                              className="ml-3 p-1.5 transition-colors"
                              style={{ color: '#6B6B66', flexShrink: 0 }}
                              onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = '#9B2828')}
                              onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = '#6B6B66')}
                            >
                              {removingId === m.id
                                ? <Loader2 size={11} className="animate-spin" />
                                : <UserMinus size={12} strokeWidth={1.5} />}
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* ── Add students ── */}
                  <div className="px-6 py-4">
                    <p className="text-xs mb-3" style={{ color: '#6B6B66', letterSpacing: '0.06em' }}>
                      ADD STUDENTS
                    </p>

                    {/* Search */}
                    <div className="relative mb-3">
                      <Search size={13} strokeWidth={1.5} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: '#6B6B66' }} />
                      <input
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search by name or email…"
                        className="w-full pl-8 pr-3 py-2 text-xs outline-none"
                        style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FAFAF8', color: '#0C0C0B' }}
                        onFocus={(e) => (e.currentTarget.style.borderColor = '#0C0C0B')}
                        onBlur={(e) => (e.currentTarget.style.borderColor = '#E3E1DB')}
                      />
                    </div>

                    {/* Success notice */}
                    <AnimatePresence>
                      {successCount !== null && (
                        <motion.div
                          initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                          className="flex items-center gap-2 px-3 py-2.5 mb-3 rounded"
                          style={{ background: '#F0F7F2', border: '1px solid #C6DECE' }}
                        >
                          <Check size={12} strokeWidth={2} style={{ color: '#2A6B3A' }} />
                          <p className="text-xs" style={{ color: '#2A6B3A' }}>
                            {successCount} student{successCount !== 1 ? 's' : ''} assigned successfully.
                          </p>
                        </motion.div>
                      )}
                    </AnimatePresence>

                    {/* Student list */}
                    {filtered.length === 0 ? (
                      <div className="flex flex-col items-center py-10">
                        <Users size={24} strokeWidth={1} style={{ color: '#DDDBD5' }} />
                        <p className="text-xs mt-3" style={{ color: '#6B6B66' }}>
                          {search ? 'No students match your search.' : 'No active students in this institute.'}
                        </p>
                      </div>
                    ) : (
                      <div style={{ border: '1px solid #E3E1DB', borderRadius: 3, overflow: 'hidden' }}>
                        {filtered.map((student, index) => {
                          const isMapped = alreadyMappedIds.has(student.id);
                          const isSelected = selected.has(student.id);
                          const isLast = index === filtered.length - 1;

                          return (
                            <button
                              key={student.id}
                              onClick={() => toggleStudent(student.id)}
                              disabled={isMapped}
                              className="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors"
                              style={{
                                borderBottom: isLast ? 'none' : '1px solid #F0EFEB',
                                background: isSelected ? '#F0F7F2' : isMapped ? '#FAFAF8' : 'white',
                                cursor: isMapped ? 'not-allowed' : 'pointer',
                                opacity: isMapped ? 0.6 : 1,
                              }}
                            >
                              {/* Checkbox */}
                              <div
                                className="flex-shrink-0 flex items-center justify-center"
                                style={{
                                  width: 16, height: 16, borderRadius: 2,
                                  border: `1px solid ${isSelected ? '#2A6B3A' : '#D4D2CC'}`,
                                  background: isSelected ? '#2A6B3A' : 'transparent',
                                  transition: 'all 0.12s',
                                }}
                              >
                                {isSelected && <Check size={10} strokeWidth={2.5} style={{ color: 'white' }} />}
                                {isMapped && <Check size={10} strokeWidth={2} style={{ color: '#6B6B66' }} />}
                              </div>

                              {/* Info */}
                              <div className="min-w-0 flex-1">
                                <p className="text-xs truncate" style={{ color: '#0C0C0B' }}>{student.name}</p>
                                <p className="text-xs truncate" style={{ color: '#6B6B66' }}>{student.email}</p>
                                {(() => {
                                  const places = otherPlacements.get(student.id);
                                  if (!places || places.length === 0) return null;
                                  const shown = places.slice(0, 2).join(' · ');
                                  const extra = places.length > 2 ? ` +${places.length - 2}` : '';
                                  return (
                                    <p className="text-xs truncate mt-0.5" style={{ color: '#B08A3E' }}
                                      title={places.join(' · ')}>
                                      also in: {shown}{extra}
                                    </p>
                                  );
                                })()}
                              </div>

                              {isMapped && (
                                <span className="text-xs px-1.5 py-0.5 flex-shrink-0"
                                  style={{ background: '#F0EFEB', color: '#6B6B66', borderRadius: 2 }}>
                                  Assigned
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-4 flex items-center justify-between" style={{ borderTop: '1px solid #E3E1DB' }}>
              <span className="text-xs" style={{ color: '#6B6B66' }}>
                {selected.size > 0 ? `${selected.size} selected` : 'Select students to assign'}
              </span>
              <div className="flex items-center gap-3">
                <button onClick={onClose} className="text-xs px-4 py-2"
                  style={{ color: '#6B6B66', border: '1px solid #E3E1DB', borderRadius: 2 }}>
                  Close
                </button>
                <button
                  onClick={handleAssign}
                  disabled={selected.size === 0 || saving}
                  className="flex items-center gap-2 text-xs px-4 py-2 transition-opacity"
                  style={{
                    background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2,
                    opacity: selected.size === 0 || saving ? 0.4 : 1,
                    cursor: selected.size === 0 || saving ? 'not-allowed' : 'pointer',
                  }}
                >
                  {saving
                    ? <Loader2 size={12} className="animate-spin" />
                    : <UserPlus size={12} strokeWidth={1.5} />}
                  Assign {selected.size > 0 ? `(${selected.size})` : ''}
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}