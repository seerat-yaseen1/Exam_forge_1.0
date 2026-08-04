import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Loader2, Check } from 'lucide-react';
import {
  generateId,
  createCourse, updateCourse,
  type Course,
} from '../../../lib/firebaseService';
import { type HierarchyItem } from './HierarchyPanel';
import { type AncestryMap } from './NodeDrawer';

interface Props {
  open: boolean;
  editing?: HierarchyItem | null;
  editingRaw?: Course | null;
  ancestry: AncestryMap;
  instituteId: string;
  // When true, course attaches directly to the year (semesterId = null)
  directToYear?: boolean;
  onClose: () => void;
  onSaved: (item: HierarchyItem) => void;
}

export function CourseDrawer({ open, editing, editingRaw, ancestry, instituteId, directToYear, onClose, onSaved }: Props) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<{ name?: string; code?: string }>({});

  const isEdit = !!editing;

  useEffect(() => {
    if (open) {
      setName(editing?.name ?? '');
      setCode(editingRaw?.code ?? editing?.meta ?? '');
      setErrors({});
    }
  }, [open, editing, editingRaw]);

  const validate = () => {
    const e: { name?: string; code?: string } = {};
    if (!name.trim()) e.name = 'Course name is required.';
    if (!code.trim()) e.code = 'Course code is required.';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;
    setSaving(true);
    try {
      const now = new Date().toISOString();
      const trimName = name.trim();
      const trimCode = code.trim().toUpperCase();

      if (isEdit && editing) {
        await updateCourse(editing.id, { name: trimName, code: trimCode, updatedAt: now });
        onSaved({ ...editing, name: trimName, meta: trimCode });
      } else {
        const id = generateId();
        // B-2 placement (Option A — inferred from which parent id is set):
        //   section context  → section-level course (sectionId set)
        //   directToYear     → whole-year course (semesterId null)
        //   otherwise        → whole-semester course
        const isSectionLevel = Boolean(ancestry.sectionId);
        const semesterId = isSectionLevel
          ? (ancestry.semesterId ?? null)
          : directToYear ? null : (ancestry.semesterId ?? null);
        await createCourse({
          id,
          instituteId,
          schoolId: ancestry.schoolId!,
          levelId: ancestry.levelId!,
          programId: ancestry.programId!,
          sessionId: ancestry.sessionId!,
          yearId: ancestry.yearId!,
          semesterId,
          ...(isSectionLevel ? { sectionId: ancestry.sectionId } : {}),
          name: trimName,
          code: trimCode,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        });
        onSaved({ id, name: trimName, level: 'course', meta: trimCode });
      }
    } catch (e: any) {
      setErrors({ name: e.message || 'Failed to save. Please try again.' });
    } finally {
      setSaving(false);
    }
  };

  const parentLabel = ancestry.sectionId
    ? 'This course will be attached to the selected section.'
    : directToYear
      ? 'This course will be attached directly to the year (no semester).'
      : ancestry.semesterId
        ? 'This course will be attached to the selected semester.'
        : 'This course will be attached to the year.';

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-40"
            style={{ background: 'rgba(12,12,11,0.18)' }}
            onClick={onClose}
          />
          <motion.div
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="fixed right-0 top-0 bottom-0 z-50 flex flex-col w-full sm:w-[420px] sm:max-w-full"
            style={{ background: '#FFFFFF', borderLeft: '1px solid #E3E1DB', boxShadow: '-8px 0 32px rgba(12,12,11,0.06)' }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 sm:px-6 py-4 sm:py-5" style={{ borderBottom: '1px solid #E3E1DB' }}>
              <div>
                <p className="text-xs mb-0.5" style={{ color: '#6B6B66', letterSpacing: '0.08em' }}>
                  {isEdit ? 'EDIT' : 'NEW'} COURSE
                </p>
                <h2 className="text-sm" style={{ color: '#0C0C0B' }}>
                  {isEdit ? `Editing "${editing!.name}"` : 'Add Course'}
                </h2>
              </div>
              <button onClick={onClose} style={{ color: '#6B6B66' }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = '#0C0C0B')}
                onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = '#6B6B66')}>
                <X size={16} strokeWidth={1.5} />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 px-6 py-6 overflow-y-auto space-y-5">
              {/* Course Name */}
              <div>
                <label className="block mb-1.5 text-xs" style={{ color: '#6B6B66', letterSpacing: '0.06em' }}>
                  COURSE NAME *
                </label>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Data Structures and Algorithms"
                  className="w-full px-3 py-2.5 text-sm outline-none transition-colors"
                  style={{
                    border: `1px solid ${errors.name ? '#E5A5A5' : '#E3E1DB'}`,
                    borderRadius: 2, background: '#FAFAF8', color: '#0C0C0B',
                  }}
                  onFocus={(e) => (e.currentTarget.style.borderColor = errors.name ? '#E5A5A5' : '#0C0C0B')}
                  onBlur={(e) => (e.currentTarget.style.borderColor = errors.name ? '#E5A5A5' : '#E3E1DB')}
                />
                {errors.name && <p className="text-xs mt-1" style={{ color: '#9B2828' }}>{errors.name}</p>}
              </div>

              {/* Course Code */}
              <div>
                <label className="block mb-1.5 text-xs" style={{ color: '#6B6B66', letterSpacing: '0.06em' }}>
                  COURSE CODE *
                </label>
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSave()}
                  placeholder="e.g. CS301"
                  className="w-full px-3 py-2.5 text-sm outline-none transition-colors"
                  style={{
                    border: `1px solid ${errors.code ? '#E5A5A5' : '#E3E1DB'}`,
                    borderRadius: 2, background: '#FAFAF8', color: '#0C0C0B',
                    fontFamily: 'monospace', letterSpacing: '0.06em',
                  }}
                  onFocus={(e) => (e.currentTarget.style.borderColor = errors.code ? '#E5A5A5' : '#0C0C0B')}
                  onBlur={(e) => (e.currentTarget.style.borderColor = errors.code ? '#E5A5A5' : '#E3E1DB')}
                />
                {errors.code && <p className="text-xs mt-1" style={{ color: '#9B2828' }}>{errors.code}</p>}
              </div>

              {/* Parent context note */}
              <div className="px-4 py-3 rounded" style={{ background: '#F7F6F3', border: '1px solid #E3E1DB' }}>
                <p className="text-xs" style={{ color: '#6B6B66' }}>{parentLabel}</p>
              </div>
            </div>

            {/* Footer */}
            <div className="px-6 py-4 flex items-center justify-end gap-3" style={{ borderTop: '1px solid #E3E1DB' }}>
              <button onClick={onClose} disabled={saving}
                className="text-xs px-4 py-2"
                style={{ color: '#6B6B66', border: '1px solid #E3E1DB', borderRadius: 2 }}>
                Cancel
              </button>
              <button onClick={handleSave} disabled={saving}
                className="flex items-center gap-2 text-xs px-4 py-2 transition-opacity"
                style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, opacity: saving ? 0.7 : 1 }}>
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} strokeWidth={2} />}
                {isEdit ? 'Save Changes' : 'Create Course'}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}