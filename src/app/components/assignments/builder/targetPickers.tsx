/**
 * builder/targetPickers — assignment-target pickers: InstitutePicker and
 * StudentPicker. (Batch F1c: extracted verbatim from AssignmentsPage.tsx;
 * no logic changes.)
 */
import { useState, useEffect, useMemo } from 'react';
import { X, Loader2, AlertTriangle, Search, CheckCircle2, Users, Building2 } from 'lucide-react';
import { getAllInstitutes, getAllStudents, type Institute, type Student } from '../../../../lib/firebaseService';

export function InstitutePicker({
  selectedIds,
  onChange,
  locked,
}: {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  locked: boolean;
}) {
  const [institutes, setInstitutes] = useState<Institute[]>([]);
  const [loadingInst, setLoadingInst] = useState(true);
  const [search, setSearch] = useState('');

  useEffect(() => {
    getAllInstitutes()
      .then((list) =>
        setInstitutes(
          list
            .filter((i) => i.status !== 'disabled')
            .sort((a, b) => a.name.localeCompare(b.name))
        )
      )
      .finally(() => setLoadingInst(false));
  }, []);

  const filtered = institutes.filter(
    (i) =>
      !search ||
      i.name.toLowerCase().includes(search.toLowerCase()) ||
      i.code.toLowerCase().includes(search.toLowerCase())
  );

  const toggle = (id: string) => {
    if (locked) return;
    onChange(
      selectedIds.includes(id)
        ? selectedIds.filter((x) => x !== id)
        : [...selectedIds, id]
    );
  };

  return (
    <div
      style={{
        border: '1px solid var(--ef-border)',
        borderRadius: 2,
        background: 'var(--ef-surface)',
        marginTop: 6,
        opacity: locked ? 0.5 : 1,
        pointerEvents: locked ? 'none' : 'auto',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{ borderBottom: '1px solid var(--ef-border-subtle)', background: 'var(--ef-canvas-raised)' }}
      >
        <div className="flex items-center gap-1.5">
          <Building2 size={11} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
          <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
            {selectedIds.length === 0
              ? 'No institutes selected'
              : `${selectedIds.length} institute${selectedIds.length !== 1 ? 's' : ''} selected`}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {filtered.length > 0 && filtered.some((i) => !selectedIds.includes(i.id)) && (
            <button
              onClick={() => onChange([...new Set([...selectedIds, ...filtered.map((i) => i.id)])])}
              className="text-xs transition-opacity hover:opacity-60"
              style={{ color: 'var(--ef-text-muted)' }}
            >
              Select all ({filtered.length})
            </button>
          )}
          {selectedIds.length > 0 && (
            <button
              onClick={() => onChange([])}
              className="text-xs transition-opacity hover:opacity-60"
              style={{ color: 'var(--ef-text-muted)' }}
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Search */}
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}
      >
        <Search size={11} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search institutes…"
          className="flex-1 text-xs outline-none bg-transparent"
          style={{ color: 'var(--ef-ink)' }}
        />
        {search && (
          <button onClick={() => setSearch('')}>
            <X size={10} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
          </button>
        )}
      </div>

      {/* List */}
      <div style={{ maxHeight: 200, overflowY: 'auto' }}>
        {loadingInst ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 size={14} strokeWidth={1} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-6 text-center">
            <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>No institutes found</span>
          </div>
        ) : (
          filtered.map((inst) => {
            const isSelected = selectedIds.includes(inst.id);
            return (
              <button
                key={inst.id}
                onClick={() => toggle(inst.id)}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors"
                style={{
                  background: isSelected ? 'var(--ef-canvas-raised)' : 'var(--ef-surface)',
                  borderBottom: '1px solid var(--ef-canvas)',
                }}
              >
                {/* Checkbox */}
                <div
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 2,
                    border: `1px solid ${isSelected ? 'var(--ef-ink)' : 'var(--ef-border-muted)'}`,
                    background: isSelected ? 'var(--ef-ink)' : 'var(--ef-surface)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  {isSelected && (
                    <CheckCircle2 size={9} strokeWidth={2.5} style={{ color: 'var(--ef-surface)' }} />
                  )}
                </div>

                <span className="flex-1 text-xs" style={{ color: 'var(--ef-ink)' }}>
                  {inst.name}
                </span>

                <span
                  className="text-xs px-1.5 py-0.5 flex-shrink-0"
                  style={{
                    background: 'var(--ef-border-subtle)', color: 'var(--ef-text-muted)',
                    borderRadius: 2, fontSize: 10,
                  }}
                >
                  {inst.code}
                </span>
              </button>
            );
          })
        )}
      </div>

      {/* Empty selection warning */}
      {selectedIds.length === 0 && !loadingInst && institutes.length > 0 && (
        <div
          className="flex items-center gap-2 px-3 py-2"
          style={{ borderTop: '1px solid var(--ef-border-subtle)', background: 'var(--ef-warning-bg)' }}
        >
          <AlertTriangle size={10} strokeWidth={1.5} style={{ color: 'var(--ef-warning)', flexShrink: 0 }} />
          <span style={{ color: 'var(--ef-warning)', fontSize: 10 }}>
            No institutes selected — no students will receive this assessment.
          </span>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// STUDENT PICKER — institute-filtered checkbox list for "Specific Students"
// ══════════════════════════════════════════════════════════════════

export function StudentPicker({
  selectedIds,
  onChange,
  locked,
}: {
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  locked: boolean;
}) {
  const [students, setStudents] = useState<Student[]>([]);
  const [institutes, setInstitutes] = useState<Institute[]>([]);
  const [loadingStudents, setLoadingStudents] = useState(true);
  const [search, setSearch] = useState('');
  const [filterInstId, setFilterInstId] = useState<string>('all');

  useEffect(() => {
    Promise.all([getAllStudents(), getAllInstitutes()]).then(([studs, insts]) => {
      setStudents(studs.filter((s) => s.status !== 'disabled'));
      setInstitutes(insts);
      setLoadingStudents(false);
    });
  }, []);

  const instMap = useMemo(() => {
    const m: Record<string, string> = {};
    institutes.forEach((i) => { m[i.id] = i.name; });
    return m;
  }, [institutes]);

  // Only show institutes that actually have students
  const instTabs = useMemo(
    () =>
      institutes
        .filter((i) => students.some((s) => s.instituteId === i.id))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [institutes, students]
  );

  const filtered = students.filter((s) => {
    const matchInst = filterInstId === 'all' || s.instituteId === filterInstId;
    const matchSearch =
      !search ||
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.email.toLowerCase().includes(search.toLowerCase());
    return matchInst && matchSearch;
  });

  const toggle = (id: string) => {
    if (locked) return;
    onChange(
      selectedIds.includes(id)
        ? selectedIds.filter((x) => x !== id)
        : [...selectedIds, id]
    );
  };

  const selectAllVisible = () => {
    if (locked) return;
    onChange([...new Set([...selectedIds, ...filtered.map((s) => s.id)])]);
  };

  return (
    <div
      style={{
        border: '1px solid var(--ef-border)',
        borderRadius: 2,
        background: 'var(--ef-surface)',
        marginTop: 6,
        opacity: locked ? 0.5 : 1,
        pointerEvents: locked ? 'none' : 'auto',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{ borderBottom: '1px solid var(--ef-border-subtle)', background: 'var(--ef-canvas-raised)' }}
      >
        <div className="flex items-center gap-1.5">
          <Users size={11} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
          <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
            {selectedIds.length === 0
              ? 'No students selected'
              : `${selectedIds.length} student${selectedIds.length !== 1 ? 's' : ''} selected`}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {filtered.length > 0 && filtered.some((s) => !selectedIds.includes(s.id)) && (
            <button
              onClick={selectAllVisible}
              className="text-xs transition-opacity hover:opacity-60"
              style={{ color: 'var(--ef-text-muted)' }}
            >
              Select {filterInstId === 'all' ? 'all' : 'all in institute'} ({filtered.length})
            </button>
          )}
          {selectedIds.length > 0 && (
            <button
              onClick={() => onChange([])}
              className="text-xs transition-opacity hover:opacity-60"
              style={{ color: 'var(--ef-text-muted)' }}
            >
              Clear all
            </button>
          )}
        </div>
      </div>

      {/* Institute filter pills */}
      {!loadingStudents && instTabs.length > 1 && (
        <div
          className="flex items-center gap-1.5 px-3 py-2 overflow-x-auto"
          style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}
        >
          <button
            onClick={() => setFilterInstId('all')}
            className="text-xs px-2.5 py-1 flex-shrink-0 transition-colors"
            style={{
              borderRadius: 2,
              background: filterInstId === 'all' ? 'var(--ef-ink)' : 'var(--ef-border-subtle)',
              color: filterInstId === 'all' ? 'var(--ef-surface)' : 'var(--ef-text-muted)',
              border: filterInstId === 'all' ? '1px solid var(--ef-ink)' : '1px solid var(--ef-border)',
            }}
          >
            All institutes
          </button>
          {instTabs.map((inst) => {
            const isActive = filterInstId === inst.id;
            const countInInst = selectedIds.filter((id) =>
              students.find((s) => s.id === id && s.instituteId === inst.id)
            ).length;
            return (
              <button
                key={inst.id}
                onClick={() => setFilterInstId(inst.id)}
                className="text-xs px-2.5 py-1 flex-shrink-0 transition-colors flex items-center gap-1"
                style={{
                  borderRadius: 2,
                  background: isActive ? 'var(--ef-ink)' : 'var(--ef-border-subtle)',
                  color: isActive ? 'var(--ef-surface)' : 'var(--ef-text-muted)',
                  border: isActive ? '1px solid var(--ef-ink)' : '1px solid var(--ef-border)',
                }}
              >
                {inst.name}
                {countInInst > 0 && (
                  <span
                    style={{
                      background: isActive ? 'rgba(255,255,255,0.25)' : 'var(--ef-ink)',
                      color: 'var(--ef-surface)',
                      borderRadius: 9,
                      fontSize: 9,
                      padding: '1px 5px',
                    }}
                  >
                    {countInInst}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Search */}
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}
      >
        <Search size={11} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name or email…"
          className="flex-1 text-xs outline-none bg-transparent"
          style={{ color: 'var(--ef-ink)' }}
        />
        {search && (
          <button onClick={() => setSearch('')}>
            <X size={10} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
          </button>
        )}
      </div>

      {/* Student list */}
      <div style={{ maxHeight: 240, overflowY: 'auto' }}>
        {loadingStudents ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 size={14} strokeWidth={1} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-6 text-center">
            <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
              {search ? 'No students match your search' : 'No students found'}
            </span>
          </div>
        ) : (
          filtered.map((student) => {
            const isSelected = selectedIds.includes(student.id);
            const instName = instMap[student.instituteId] ?? '—';
            return (
              <button
                key={student.id}
                onClick={() => toggle(student.id)}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors"
                style={{
                  background: isSelected ? 'var(--ef-canvas-raised)' : 'var(--ef-surface)',
                  borderBottom: '1px solid var(--ef-canvas)',
                }}
              >
                {/* Checkbox */}
                <div
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 2,
                    border: `1px solid ${isSelected ? 'var(--ef-ink)' : 'var(--ef-border-muted)'}`,
                    background: isSelected ? 'var(--ef-ink)' : 'var(--ef-surface)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  {isSelected && (
                    <CheckCircle2 size={9} strokeWidth={2.5} style={{ color: 'var(--ef-surface)' }} />
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-xs" style={{ color: 'var(--ef-ink)' }}>{student.name}</p>
                  <p className="text-xs" style={{ color: 'var(--ef-text-muted)', marginTop: 1 }}>{student.email}</p>
                </div>

                <span
                  className="text-xs px-1.5 py-0.5 flex-shrink-0"
                  style={{
                    background: 'var(--ef-border-subtle)', color: 'var(--ef-text-muted)',
                    borderRadius: 2, fontSize: 10,
                    maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                  title={instName}
                >
                  {instName}
                </span>
              </button>
            );
          })
        )}
      </div>

      {/* Empty selection warning */}
      {selectedIds.length === 0 && !loadingStudents && students.length > 0 && (
        <div
          className="flex items-center gap-2 px-3 py-2"
          style={{ borderTop: '1px solid var(--ef-border-subtle)', background: 'var(--ef-warning-bg)' }}
        >
          <AlertTriangle size={10} strokeWidth={1.5} style={{ color: 'var(--ef-warning)', flexShrink: 0 }} />
          <span style={{ color: 'var(--ef-warning)', fontSize: 10 }}>
            No students selected — this assessment will not be visible to anyone.
          </span>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// STEP 2 — Rules + Settings (top strip + full-width rule builder)
// ══════════════════════════════════════════════════════════════════