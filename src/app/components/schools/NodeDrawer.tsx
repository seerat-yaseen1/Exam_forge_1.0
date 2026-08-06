import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Loader2, Check } from 'lucide-react';
import {
  type NodeLevel, NODE_LEVEL_LABELS, generateId,
  createSchool, updateSchool,
  createAcademicLevel, updateAcademicLevel,
  createProgram, updateProgram,
  createAcademicSession, updateAcademicSession,
  createAcademicYear, updateAcademicYear,
  createSection, updateSection,
  createGroup, updateGroup,
} from '../../../lib/firebaseService';
import { type HierarchyItem } from './HierarchyPanel';

export type AncestryMap = {
  schoolId?: string;
  levelId?: string;
  programId?: string;
  sessionId?: string;
  yearId?: string;
  semesterId?: string | null;
  courseId?: string;
  sectionId?: string;
};

interface Props {
  open: boolean;
  level: NodeLevel;
  editing?: HierarchyItem | null;
  ancestry: AncestryMap;
  instituteId: string;
  onClose: () => void;
  onSaved: (item: HierarchyItem) => void;
}

export function NodeDrawer({ open, level, editing, ancestry, instituteId, onClose, onSaved }: Props) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const isEdit = !!editing;
  const levelLabel = NODE_LEVEL_LABELS[level];

  useEffect(() => {
    if (open) {
      setName(editing?.name ?? '');
      setError('');
    }
  }, [open, editing]);

  const handleSave = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setError(`${levelLabel} name is required.`); return; }
    setSaving(true);
    setError('');
    try {
      const now = new Date().toISOString();
      if (isEdit && editing) {
        // Edit path — only update name
        await updateNode(level, editing.id, trimmed);
        onSaved({ ...editing, name: trimmed });
      } else {
        // Create path
        const id = generateId();
        await createNode(level, id, trimmed, ancestry, instituteId, now);
        onSaved({ id, name: trimmed, level });
      }
    } catch (e: any) {
      setError(e.message || 'Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  };

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
          {/* Drawer */}
          <motion.div
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="fixed right-0 top-0 bottom-0 z-50 flex flex-col w-full sm:w-[400px] sm:max-w-full"
            style={{ background: 'var(--ef-surface)', borderLeft: '1px solid var(--ef-border)', boxShadow: '-8px 0 32px rgba(12,12,11,0.06)' }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 sm:px-6 py-4 sm:py-5" style={{ borderBottom: '1px solid var(--ef-border)' }}>
              <div>
                <p className="text-xs mb-0.5" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>
                  {isEdit ? 'EDIT' : 'NEW'} {levelLabel.toUpperCase()}
                </p>
                <h2 className="text-sm" style={{ color: 'var(--ef-ink)' }}>
                  {isEdit ? `Editing "${editing!.name}"` : `Add ${levelLabel}`}
                </h2>
              </div>
              <button onClick={onClose} style={{ color: 'var(--ef-text-muted)' }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--ef-ink)')}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)')}>
                <X size={16} strokeWidth={1.5} />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 px-6 py-6 overflow-y-auto">
              <label className="block mb-1.5 text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.06em' }}>
                {levelLabel.toUpperCase()} NAME *
              </label>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSave()}
                placeholder={getPlaceholder(level)}
                className="w-full px-3 py-2.5 text-sm outline-none transition-colors"
                style={{
                  border: `1px solid ${error ? '#E5A5A5' : 'var(--ef-border)'}`,
                  borderRadius: 2,
                  background: 'var(--ef-canvas-raised)',
                  color: 'var(--ef-ink)',
                }}
                onFocus={(e) => (e.currentTarget.style.borderColor = error ? '#E5A5A5' : 'var(--ef-ink)')}
                onBlur={(e) => (e.currentTarget.style.borderColor = error ? '#E5A5A5' : 'var(--ef-border)')}
              />
              {error && (
                <p className="text-xs mt-1.5" style={{ color: 'var(--ef-danger)' }}>{error}</p>
              )}
              <p className="text-xs mt-3" style={{ color: 'var(--ef-text-muted)' }}>
                {getHint(level)}
              </p>
            </div>

            {/* Footer */}
            <div className="px-6 py-4 flex items-center justify-end gap-3" style={{ borderTop: '1px solid var(--ef-border)' }}>
              <button onClick={onClose} disabled={saving}
                className="text-xs px-4 py-2"
                style={{ color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
                Cancel
              </button>
              <button onClick={handleSave} disabled={saving}
                className="flex items-center gap-2 text-xs px-4 py-2 transition-opacity"
                style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, opacity: saving ? 0.7 : 1 }}>
                {saving
                  ? <Loader2 size={12} className="animate-spin" />
                  : <Check size={12} strokeWidth={2} />}
                {isEdit ? 'Save Changes' : `Create ${levelLabel}`}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

// ── Helpers ────────────────────────────────────────────────────────

function getPlaceholder(level: NodeLevel): string {
  const map: Partial<Record<NodeLevel, string>> = {
    school:          'e.g. School of Engineering',
    academicLevel:   'e.g. UG, PG, Diploma',
    program:         'e.g. B.Tech, MBA, B.Sc',
    academicSession: 'e.g. 2024-25',
    academicYear:    'e.g. Year 1',
    section:         'e.g. Section A',
    group:           'e.g. Group 1',
  };
  return map[level] ?? 'Enter name';
}

function getHint(level: NodeLevel): string {
  const map: Partial<Record<NodeLevel, string>> = {
    school:          'The highest academic container. Groups related programs under one school.',
    academicLevel:   'Broad academic level such as Undergraduate, Postgraduate, or Diploma.',
    program:         'The specific degree or certificate program offered under this level.',
    academicSession: 'The admission or academic cycle year, e.g. 2024-25.',
    academicYear:    'Year of study within the program, e.g. Year 1, Year 2.',
    section:         'A division of students within this course, e.g. Section A.',
    group:           'A smaller subdivision inside a section, e.g. Group 1.',
  };
  return map[level] ?? '';
}

async function updateNode(level: NodeLevel, id: string, name: string): Promise<void> {
  const updatedAt = new Date().toISOString();
  switch (level) {
    case 'school':          return updateSchool(id, { name, updatedAt });
    case 'academicLevel':   return updateAcademicLevel(id, { name, updatedAt });
    case 'program':         return updateProgram(id, { name, updatedAt });
    case 'academicSession': return updateAcademicSession(id, { name, updatedAt });
    case 'academicYear':    return updateAcademicYear(id, { name, updatedAt });
    case 'section':         return updateSection(id, { name, updatedAt });
    case 'group':           return updateGroup(id, { name, updatedAt });
    default: throw new Error(`${level} is handled by a specialized drawer`);
  }
}

async function createNode(
  level: NodeLevel,
  id: string,
  name: string,
  ancestry: AncestryMap,
  instituteId: string,
  now: string,
): Promise<void> {
  const base = { id, instituteId, name, status: 'active' as const, createdAt: now, updatedAt: now };
  switch (level) {
    case 'school':
      return createSchool(base);
    case 'academicLevel':
      return createAcademicLevel({ ...base, schoolId: ancestry.schoolId! });
    case 'program':
      return createProgram({ ...base, schoolId: ancestry.schoolId!, levelId: ancestry.levelId! });
    case 'academicSession':
      return createAcademicSession({ ...base, schoolId: ancestry.schoolId!, levelId: ancestry.levelId!, programId: ancestry.programId! });
    case 'academicYear':
      return createAcademicYear({ ...base, schoolId: ancestry.schoolId!, levelId: ancestry.levelId!, programId: ancestry.programId!, sessionId: ancestry.sessionId! });
    case 'section':
      // B-2: a section's parent is its semester (or year when annual). courseId
      // is no longer a required parent — it's optional legacy metadata, only set
      // if the caller explicitly passed one.
      return createSection({
        ...base,
        schoolId: ancestry.schoolId!, levelId: ancestry.levelId!, programId: ancestry.programId!,
        sessionId: ancestry.sessionId!, yearId: ancestry.yearId!,
        semesterId: ancestry.semesterId ?? null,
        ...(ancestry.courseId ? { courseId: ancestry.courseId } : {}),
      });
    case 'group':
      return createGroup({
        ...base,
        schoolId: ancestry.schoolId!, levelId: ancestry.levelId!, programId: ancestry.programId!,
        sessionId: ancestry.sessionId!, yearId: ancestry.yearId!,
        semesterId: ancestry.semesterId ?? null,
        sectionId: ancestry.sectionId!,
        ...(ancestry.courseId ? { courseId: ancestry.courseId } : {}),
      });
    default:
      throw new Error(`${level} must be created through a specialized drawer`);
  }
}