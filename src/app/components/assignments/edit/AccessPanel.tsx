import { useEffect, useMemo, useState } from 'react';
import { X, Search } from 'lucide-react';
import { EditPanelShell, Field } from './EditPanelShell';
import { editableFields } from './useEditableFields';
import { updateAssessmentAccess, type Assessment } from '../../../../lib/assessmentService';
import { getAllStudents, getStudentsByInstitute, type Student } from '../../../../lib/firebaseService';

type Props = {
  assessment: Assessment;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (patch: Partial<Assessment>) => void;
};

export function AccessPanel({ assessment, open, onOpenChange, onSaved }: Props) {
  const fields = editableFields(assessment.status);

  const [blocked, setBlocked] = useState<string[]>(assessment.blockedStudents ?? []);
  const [students, setStudents] = useState<Student[]>([]);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setBlocked(assessment.blockedStudents ?? []);
      setQuery('');
    }
  }, [open, assessment.id]);

  useEffect(() => {
    if (!open) return;
    // An unfiltered students scan is only permitted for webOwner by the
    // security rules. For institute-owned assessments, scope by the owning
    // institute so the query is provable (this panel is currently mounted
    // only from the webOwner edit menu, but keep it role-safe).
    const fetchStudents =
      assessment.ownerType === 'institute'
        ? getStudentsByInstitute(assessment.ownerId)
        : getAllStudents();
    fetchStudents.then(setStudents).catch(() => setStudents([]));
  }, [open, assessment.ownerType, assessment.ownerId]);

  const studentMap = useMemo(() => {
    const m = new Map<string, Student>();
    students.forEach((s) => m.set(s.id, s));
    return m;
  }, [students]);

  const searchResults = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return students
      .filter((s) => !blocked.includes(s.id))
      .filter((s) =>
        s.name?.toLowerCase().includes(q) ||
        s.email?.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q)
      )
      .slice(0, 8);
  }, [students, query, blocked]);

  const dirty =
    JSON.stringify([...blocked].sort()) !==
    JSON.stringify([...(assessment.blockedStudents ?? [])].sort());

  const handleSave = async () => {
    setSaving(true);
    try {
      const patch: Partial<Assessment> = { blockedStudents: blocked };
      await updateAssessmentAccess(assessment.id, patch);
      onSaved(patch);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditPanelShell
      open={open}
      onOpenChange={onOpenChange}
      title="Edit access"
      description="Block specific students from entering or re-entering this assessment."
      dirty={dirty}
      saving={saving}
      canSave={true}
      onSave={handleSave}
    >
      {!fields.targetType && (
        <p className="text-xs mb-4 px-3 py-2" style={{ background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border)', borderRadius: 2, color: 'var(--ef-text-muted)' }}>
          Targeting (who the assessment is assigned to) is locked once the assessment leaves draft.
        </p>
      )}

      {fields.blockedStudents && (
        <>
          <Field label="Add a student to the block list">
            <div className="flex items-center gap-2 px-3 py-2" style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}>
              <Search size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by name, email, or ID"
                className="flex-1 text-xs bg-transparent outline-none"
                style={{ color: 'var(--ef-ink)' }}
              />
            </div>
            {searchResults.length > 0 && (
              <div className="mt-1" style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}>
                {searchResults.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => { setBlocked((prev) => [...prev, s.id]); setQuery(''); }}
                    className="w-full text-left text-xs px-3 py-2 hover:bg-[var(--ef-canvas-raised)]"
                    style={{ color: 'var(--ef-ink)' }}
                  >
                    <span>{s.name}</span>
                    <span className="ml-2" style={{ color: 'var(--ef-text-muted)' }}>{s.email}</span>
                  </button>
                ))}
              </div>
            )}
          </Field>

          <Field label={`Blocked students (${blocked.length})`}>
            {blocked.length === 0 ? (
              <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>No students are blocked.</p>
            ) : (
              <div className="space-y-1">
                {blocked.map((id) => {
                  const s = studentMap.get(id);
                  return (
                    <div
                      key={id}
                      className="flex items-center justify-between gap-2 px-3 py-2"
                      style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-canvas-raised)' }}
                    >
                      <div className="min-w-0">
                        <p className="text-xs truncate" style={{ color: 'var(--ef-ink)' }}>{s?.name ?? id}</p>
                        {s?.email && <p className="text-xs truncate" style={{ color: 'var(--ef-text-muted)' }}>{s.email}</p>}
                      </div>
                      <button
                        onClick={() => setBlocked((prev) => prev.filter((x) => x !== id))}
                        className="p-1 hover:opacity-70"
                        style={{ color: 'var(--ef-text-muted)' }}
                        title="Remove"
                      >
                        <X size={12} strokeWidth={1.5} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </Field>
        </>
      )}
    </EditPanelShell>
  );
}
