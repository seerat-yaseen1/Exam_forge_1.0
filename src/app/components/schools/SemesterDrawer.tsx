import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Loader2, Check } from 'lucide-react';
import {
  generateId,
  createSemester, updateSemester,
  type Semester,
} from '../../../lib/firebaseService';
import { type HierarchyItem } from './HierarchyPanel';
import { type AncestryMap } from './NodeDrawer';

interface Props {
  open: boolean;
  editing?: HierarchyItem | null;
  editingRaw?: Semester | null; // full semester doc for pre-filling type + number
  ancestry: AncestryMap;
  instituteId: string;
  onClose: () => void;
  onSaved: (item: HierarchyItem) => void;
}

export function SemesterDrawer({ open, editing, editingRaw, ancestry, instituteId, onClose, onSaved }: Props) {
  const [semType, setSemType] = useState<'Semester' | 'Trimester'>('Semester');
  const [number, setNumber] = useState('1');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const isEdit = !!editing;

  useEffect(() => {
    if (open) {
      setSemType(editingRaw?.type ?? 'Semester');
      setNumber(String(editingRaw?.number ?? 1));
      setError('');
    }
  }, [open, editingRaw]);

  const derivedName = `${semType} ${number}`;

  const handleSave = async () => {
    const num = parseInt(number, 10);
    if (!num || num < 1) { setError('Number must be a positive integer.'); return; }
    setSaving(true);
    setError('');
    try {
      const now = new Date().toISOString();
      if (isEdit && editing) {
        await updateSemester(editing.id, { name: derivedName, type: semType, number: num, updatedAt: now });
        onSaved({ ...editing, name: derivedName, subtitle: `${semType} · ${num}` });
      } else {
        const id = generateId();
        await createSemester({
          id,
          instituteId,
          schoolId: ancestry.schoolId!,
          levelId: ancestry.levelId!,
          programId: ancestry.programId!,
          sessionId: ancestry.sessionId!,
          yearId: ancestry.yearId!,
          name: derivedName,
          type: semType,
          number: num,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        });
        onSaved({ id, name: derivedName, level: 'semester', subtitle: `${semType} · ${num}` });
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
            className="fixed right-0 top-0 bottom-0 z-50 flex flex-col w-full sm:w-[400px] sm:max-w-full"
            style={{ background: 'var(--ef-surface)', borderLeft: '1px solid var(--ef-border)', boxShadow: '-8px 0 32px rgba(12,12,11,0.06)' }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 sm:px-6 py-4 sm:py-5" style={{ borderBottom: '1px solid var(--ef-border)' }}>
              <div>
                <p className="text-xs mb-0.5" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>
                  {isEdit ? 'EDIT' : 'NEW'} SEMESTER / TRIMESTER
                </p>
                <h2 className="text-sm" style={{ color: 'var(--ef-ink)' }}>
                  {isEdit ? `Editing "${editing!.name}"` : 'Add Semester or Trimester'}
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
              {/* Type selector */}
              <label className="block mb-2 text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.06em' }}>
                TYPE *
              </label>
              <div className="flex gap-2 mb-5">
                {(['Semester', 'Trimester'] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setSemType(t)}
                    className="flex-1 py-2.5 text-xs transition-all"
                    style={{
                      border: `1px solid ${semType === t ? 'var(--ef-ink)' : 'var(--ef-border)'}`,
                      borderRadius: 2,
                      background: semType === t ? 'var(--ef-ink)' : 'var(--ef-surface)',
                      color: semType === t ? 'var(--ef-surface)' : 'var(--ef-text-subtle)',
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>

              {/* Number */}
              <label className="block mb-1.5 text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.06em' }}>
                NUMBER *
              </label>
              <input
                type="number"
                min={1}
                value={number}
                onChange={(e) => setNumber(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSave()}
                placeholder="e.g. 1"
                className="w-full px-3 py-2.5 text-sm outline-none transition-colors"
                style={{
                  border: `1px solid ${error ? 'var(--ef-danger-border)' : 'var(--ef-border)'}`,
                  borderRadius: 2,
                  background: 'var(--ef-canvas-raised)',
                  color: 'var(--ef-ink)',
                }}
                onFocus={(e) => (e.currentTarget.style.borderColor = error ? 'var(--ef-danger-border)' : 'var(--ef-ink)')}
                onBlur={(e) => (e.currentTarget.style.borderColor = error ? 'var(--ef-danger-border)' : 'var(--ef-border)')}
              />
              {error && <p className="text-xs mt-1.5" style={{ color: 'var(--ef-danger)' }}>{error}</p>}

              {/* Preview */}
              <div className="mt-5 px-4 py-3 rounded" style={{ background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)' }}>
                <p className="text-xs mb-1" style={{ color: 'var(--ef-text-muted)' }}>Will be created as</p>
                <p className="text-sm" style={{ color: 'var(--ef-ink)' }}>{derivedName}</p>
              </div>

              <p className="text-xs mt-4" style={{ color: 'var(--ef-text-muted)' }}>
                Semesters and trimesters are optional. If no semesters are added under a year, courses can be assigned directly to that year.
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
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} strokeWidth={2} />}
                {isEdit ? 'Save Changes' : 'Create'}
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
