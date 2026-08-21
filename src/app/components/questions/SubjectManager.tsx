import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Plus, X, Loader2, Merge, RefreshCw, Pencil, Check,
  AlertTriangle, CheckCircle2, Tag, ChevronDown, ChevronUp,
} from 'lucide-react';
import {
  type Subject, type MergeProgress,
  getAllSubjects, createSubject, renameSubject,
  addAlias, removeAlias, mergeSubjects, refreshAllSubjectCounts,
  normalizeSubject,
} from '../../../lib/subjectService';
import { invalidateSubjectCache } from './SubjectCombobox';

// ── Shared input style ────────────────────────────────────────────────────────
const inp: React.CSSProperties = {
  background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border)', color: 'var(--ef-ink)',
  borderRadius: 2, outline: 'none', fontSize: 14,
  padding: '8px 12px', width: '100%',
};
function iFocus(e: React.FocusEvent<HTMLInputElement>) { e.target.style.borderColor = 'var(--ef-ink)'; e.target.style.background = 'var(--ef-surface)'; }
function iBlur (e: React.FocusEvent<HTMLInputElement>) { e.target.style.borderColor = 'var(--ef-border)'; e.target.style.background = 'var(--ef-canvas-raised)'; }

// ── Alias tag input ───────────────────────────────────────────────────────────

function AliasRow({
  alias, onRemove, removing,
}: { alias: string; onRemove: () => void; removing: boolean }) {
  return (
    <span
      className="flex items-center gap-1 px-2 py-0.5 text-xs select-none"
      style={{ background: 'var(--ef-border-subtle)', borderRadius: 2, color: 'var(--ef-text-subtle)' }}
    >
      {alias}
      <button
        type="button"
        onClick={onRemove}
        disabled={removing}
        className="transition-opacity hover:opacity-60 ml-0.5"
        style={{ color: 'var(--ef-text-muted)', cursor: removing ? 'not-allowed' : 'pointer' }}
      >
        {removing ? <Loader2 size={9} className="animate-spin" /> : <X size={9} strokeWidth={2} />}
      </button>
    </span>
  );
}

// ── Subject card ──────────────────────────────────────────────────────────────

function SubjectCard({
  subject, onUpdated, onDeleted, canEdit = true,
}: {
  subject: Subject;
  onUpdated: (s: Subject) => void;
  onDeleted: (id: string) => void;
  canEdit?: boolean;
}) {
  const [expanded,     setExpanded]     = useState(false);
  const [renaming,     setRenaming]     = useState(false);
  const [newName,      setNewName]      = useState(subject.name);
  const [renameErr,    setRenameErr]    = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [newAlias,     setNewAlias]     = useState('');
  const [addingAlias,  setAddingAlias]  = useState(false);
  const [removingAlias, setRemovingAlias] = useState<string | null>(null);

  const submitRename = async () => {
    const n = newName.trim();
    if (!n || n === subject.name) { setRenaming(false); return; }
    setRenameErr('');
    setRenameSaving(true);
    try {
      const updated = await renameSubject(subject.id, n);
      invalidateSubjectCache();
      onUpdated(updated);
      setRenaming(false);
    } catch (err: any) {
      setRenameErr(err?.message ?? 'Rename failed.');
    } finally {
      setRenameSaving(false);
    }
  };

  const submitAddAlias = async () => {
    const a = newAlias.trim();
    if (!a) return;
    setAddingAlias(true);
    try {
      await addAlias(subject.id, a);
      invalidateSubjectCache();
      onUpdated({ ...subject, aliases: [...subject.aliases, normalizeSubject(a)] });
      setNewAlias('');
    } finally {
      setAddingAlias(false);
    }
  };

  const submitRemoveAlias = async (alias: string) => {
    setRemovingAlias(alias);
    try {
      await removeAlias(subject.id, alias);
      invalidateSubjectCache();
      onUpdated({ ...subject, aliases: subject.aliases.filter((a) => a !== alias) });
    } finally {
      setRemovingAlias(null);
    }
  };

  return (
    <div style={{ border: '1px solid var(--ef-border)', borderRadius: 3, background: 'var(--ef-surface)', marginBottom: 8 }}>
      {/* Card header */}
      <div className="flex items-center gap-3 px-4 py-3">
        {/* Name / rename inline */}
        <div className="flex-1 min-w-0">
          {renaming ? (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') { setRenaming(false); setNewName(subject.name); } }}
                style={{ ...inp, flex: 1, width: 'auto', padding: '5px 8px', fontSize: 13 }}
                onFocus={iFocus} onBlur={iBlur}
                autoFocus
              />
              <button type="button" onClick={submitRename} disabled={renameSaving}
                className="flex items-center gap-1 text-xs px-2.5 py-1.5 transition-opacity"
                style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2 }}
              >
                {renameSaving ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} strokeWidth={2} />}
              </button>
              <button type="button" onClick={() => { setRenaming(false); setNewName(subject.name); }}
                className="text-xs px-2.5 py-1.5" style={{ color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2 }}
              >
                <X size={10} strokeWidth={2} />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm" style={{ color: 'var(--ef-ink)' }}>{subject.name}</span>
              {canEdit && (
              <button
                type="button" onClick={() => { setRenaming(true); setNewName(subject.name); }}
                className="transition-opacity hover:opacity-60" title="Rename"
                style={{ color: 'var(--ef-text-muted)' }}
              >
                <Pencil size={11} strokeWidth={1.5} />
              </button>
              )}
            </div>
          )}
          {renameErr && <p className="text-xs mt-1" style={{ color: 'var(--ef-danger)' }}>{renameErr}</p>}
        </div>

        {/* Question count */}
        <span
          className="text-xs px-2 py-0.5 select-none flex-shrink-0"
          style={{ background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)', borderRadius: 2, color: 'var(--ef-text-muted)' }}
        >
          {subject.questionCount} {subject.questionCount === 1 ? 'question' : 'questions'}
        </span>

        {/* Alias count pill */}
        {subject.aliases.length > 0 && (
          <span className="text-xs flex-shrink-0" style={{ color: 'var(--ef-text-muted)' }}>
            {subject.aliases.length} alias{subject.aliases.length > 1 ? 'es' : ''}
          </span>
        )}

        {/* Expand toggle */}
        <button
          type="button" onClick={() => setExpanded((v) => !v)}
          className="transition-opacity hover:opacity-60 flex-shrink-0" style={{ color: 'var(--ef-text-muted)' }}
        >
          {expanded ? <ChevronUp size={14} strokeWidth={1.5} /> : <ChevronDown size={14} strokeWidth={1.5} />}
        </button>
      </div>

      {/* Expanded alias management */}
      {expanded && (
        <div className="px-4 pb-4 pt-1" style={{ borderTop: '1px solid var(--ef-border-subtle)' }}>
          <p className="text-xs mb-2" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.06em' }}>ALIASES</p>
          <p className="text-xs mb-3" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
            Aliases are alternate names that resolve to this subject. When a question or bulk-upload uses an alias, it is automatically mapped to <strong>{subject.name}</strong>.
          </p>
          <div className="flex flex-wrap gap-1.5 mb-3">
            {subject.aliases.length === 0 && (
              <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>No aliases yet.</span>
            )}
            {subject.aliases.map((a) => (
              canEdit ? (
                <AliasRow
                  key={a} alias={a}
                  onRemove={() => submitRemoveAlias(a)}
                  removing={removingAlias === a}
                />
              ) : (
                <span key={a} className="text-xs px-2 py-0.5" style={{ background: 'var(--ef-border-subtle)', color: 'var(--ef-text-muted)', borderRadius: 2 }}>
                  {a}
                </span>
              )
            ))}
          </div>

          {/* Add alias (maintenance) */}
          {canEdit && (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newAlias}
              onChange={(e) => setNewAlias(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitAddAlias(); }}
              placeholder="Add alias (e.g. QUANT, Maths)"
              style={{ ...inp, flex: 1, width: 'auto', padding: '7px 10px', fontSize: 13 }}
              onFocus={iFocus} onBlur={iBlur}
            />
            <button
              type="button" onClick={submitAddAlias} disabled={addingAlias || !newAlias.trim()}
              className="flex items-center gap-1.5 text-xs px-3 py-2 transition-opacity"
              style={{
                background: newAlias.trim() ? 'var(--ef-ink)' : 'var(--ef-track)',
                color: 'var(--ef-surface)', borderRadius: 2,
                cursor: newAlias.trim() ? 'pointer' : 'not-allowed',
              }}
            >
              {addingAlias ? <Loader2 size={10} className="animate-spin" /> : <Plus size={10} strokeWidth={2} />}
              Add
            </button>
          </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Merge modal ───────────────────────────────────────────────────────────────

function MergeModal({
  subjects,
  onComplete,
  onClose,
}: {
  subjects: Subject[];
  onComplete: (updatedSubjects: Subject[]) => void;
  onClose:   () => void;
}) {
  const [sourceId,   setSourceId]   = useState('');
  const [targetId,   setTargetId]   = useState('');
  const [confirm,    setConfirm]    = useState('');
  const [phase,      setPhase]      = useState<'pick' | 'preview' | 'merging' | 'done'>('pick');
  const [progress,   setProgress]   = useState<MergeProgress | null>(null);
  const [result,     setResult]     = useState<{ updatedCount: number } | null>(null);
  const [err,        setErr]        = useState<string | null>(null);

  const source = subjects.find((s) => s.id === sourceId);
  const target = subjects.find((s) => s.id === targetId);

  const canPreview = !!sourceId && !!targetId && sourceId !== targetId;
  const canMerge   = confirm === 'MERGE';

  const executeMerge = async () => {
    if (!canMerge || !source || !target) return;
    setPhase('merging');
    try {
      const res = await mergeSubjects(source.id, target.id, (p) => setProgress(p));
      setResult(res);
      invalidateSubjectCache();
      setPhase('done');
      // Rebuild subject list: remove source, update target alias count
      const updated = subjects
        .filter((s) => s.id !== source.id)
        .map((s) => s.id === target.id
          ? { ...s, questionCount: s.questionCount + res.updatedCount }
          : s
        );
      onComplete(updated);
    } catch (e: any) {
      setErr(e?.message ?? 'Merge failed.');
      setPhase('preview');
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      style={{ background: 'rgba(12,12,11,0.32)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.97, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.97, opacity: 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="w-full"
        style={{ maxWidth: 480, background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 sm:px-5 py-3.5 sm:py-4" style={{ borderBottom: '1px solid var(--ef-border)' }}>
          <div>
            <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>SUBJECT MANAGER</p>
            <p className="text-sm mt-0.5" style={{ color: 'var(--ef-ink)' }}>Merge Subjects</p>
          </div>
          {phase !== 'merging' && (
            <button onClick={onClose} className="p-1 hover:opacity-60 transition-opacity" style={{ color: 'var(--ef-text-muted)' }}>
              <X size={14} strokeWidth={1.5} />
            </button>
          )}
        </div>

        <div className="px-5 py-5">
          {(phase === 'pick' || phase === 'preview') && (
            <>
              {/* Destructive warning */}
              <div className="flex items-start gap-2.5 px-3 py-3 mb-5" style={{ background: 'var(--ef-danger-bg)', border: '1px solid var(--ef-danger-border)', borderRadius: 2 }}>
                <AlertTriangle size={13} strokeWidth={1.5} style={{ color: 'var(--ef-danger)', flexShrink: 0, marginTop: 1 }} />
                <p className="text-xs" style={{ color: 'var(--ef-danger)', lineHeight: 1.7 }}>
                  Merge is <strong>permanent and cannot be undone</strong>. All questions with the source subject will be updated to the target. The source subject will be deleted and its name will become an alias of the target.
                </p>
              </div>

              {/* Source */}
              <div className="mb-4">
                <label className="block text-xs mb-1.5" style={{ color: 'var(--ef-text-subtle)' }}>Replace this subject (source)</label>
                <select
                  value={sourceId} onChange={(e) => setSourceId(e.target.value)}
                  style={{ ...inp, appearance: 'none', cursor: 'pointer' }}
                >
                  <option value="">— select subject to replace —</option>
                  {subjects.map((s) => (
                    <option key={s.id} value={s.id} disabled={s.id === targetId}>
                      {s.name} ({s.questionCount} questions)
                    </option>
                  ))}
                </select>
              </div>

              {/* Target */}
              <div className="mb-5">
                <label className="block text-xs mb-1.5" style={{ color: 'var(--ef-text-subtle)' }}>…with this subject (target)</label>
                <select
                  value={targetId} onChange={(e) => setTargetId(e.target.value)}
                  style={{ ...inp, appearance: 'none', cursor: 'pointer' }}
                >
                  <option value="">— select destination subject —</option>
                  {subjects.map((s) => (
                    <option key={s.id} value={s.id} disabled={s.id === sourceId}>
                      {s.name} ({s.questionCount} questions)
                    </option>
                  ))}
                </select>
              </div>

              {/* Preview */}
              {canPreview && source && target && (
                <div className="px-4 py-4 mb-5" style={{ background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
                  <p className="text-xs mb-2" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>IMPACT PREVIEW</p>
                  <p className="text-xs mb-1" style={{ color: 'var(--ef-ink)', lineHeight: 1.7 }}>
                    <strong>{source.questionCount}</strong> questions tagged <strong>"{source.name}"</strong> will be updated to <strong>"{target.name}"</strong>.
                  </p>
                  <p className="text-xs mb-1" style={{ color: 'var(--ef-ink)', lineHeight: 1.7 }}>
                    <strong>"{source.name}"</strong> will be removed from the registry.
                  </p>
                  <p className="text-xs" style={{ color: 'var(--ef-ink)', lineHeight: 1.7 }}>
                    <strong>"{source.name}"</strong> will become an alias of <strong>"{target.name}"</strong> — future uploads using this name will auto-map to the target.
                  </p>
                </div>
              )}

              {/* Typed confirmation */}
              {canPreview && (
                <div className="mb-5">
                  <label className="block text-xs mb-1.5" style={{ color: 'var(--ef-text-subtle)' }}>
                    Type <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--ef-border-subtle)', padding: '1px 5px', borderRadius: 2, letterSpacing: '0.08em' }}>MERGE</code> to confirm
                  </label>
                  <input
                    type="text"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    placeholder="MERGE"
                    style={inp}
                    onFocus={iFocus} onBlur={iBlur}
                  />
                </div>
              )}

              {err && <p className="text-xs mb-3" style={{ color: 'var(--ef-danger)' }}>{err}</p>}
            </>
          )}

          {phase === 'merging' && progress && (
            <div className="flex flex-col items-center py-8">
              <Loader2 size={22} className="animate-spin mb-4" style={{ color: 'var(--ef-text-muted)' }} />
              <p className="text-sm mb-1" style={{ color: 'var(--ef-ink)' }}>
                {progress.phase === 'counting' ? 'Counting affected questions…' :
                 progress.phase === 'updating' ? `Updating questions… ${progress.done} / ${progress.total}` :
                 progress.phase === 'cleanup'  ? 'Cleaning up registry…' :
                 'Done'}
              </p>
              {progress.total > 0 && (
                <div className="w-full mt-4" style={{ maxWidth: 240 }}>
                  <div style={{ height: 3, background: 'var(--ef-border)', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%',
                      width: `${Math.round((progress.done / progress.total) * 100)}%`,
                      background: 'var(--ef-ink)', borderRadius: 2, transition: 'width 0.3s',
                    }} />
                  </div>
                </div>
              )}
            </div>
          )}

          {phase === 'done' && result && (
            <div className="flex flex-col items-center py-8">
              <div className="flex items-center justify-center mb-4" style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--ef-success-bg)', border: '1px solid var(--ef-success-border)' }}>
                <CheckCircle2 size={20} strokeWidth={1.5} style={{ color: 'var(--ef-success)' }} />
              </div>
              <p className="text-sm mb-1" style={{ color: 'var(--ef-ink)' }}>Merge complete</p>
              <p className="text-xs" style={{ color: 'var(--ef-success)' }}>{result.updatedCount} questions updated.</p>
              <p className="text-xs mt-1" style={{ color: 'var(--ef-text-muted)' }}>
                "{source?.name}" is now an alias of "{target?.name}".
              </p>
            </div>
          )}
        </div>

        {(phase === 'pick' || phase === 'preview') && (
          <div className="flex items-center gap-3 px-5 py-4" style={{ borderTop: '1px solid var(--ef-border)' }}>
            <button
              type="button"
              onClick={executeMerge}
              disabled={!canMerge || !canPreview}
              className="flex items-center gap-1.5 text-xs px-4 py-2.5 transition-opacity"
              style={{
                background: canMerge && canPreview ? 'var(--ef-danger)' : 'var(--ef-track)',
                color: 'var(--ef-surface)', borderRadius: 2,
                cursor: canMerge && canPreview ? 'pointer' : 'not-allowed',
              }}
            >
              <Merge size={11} strokeWidth={1.5} /> Confirm Merge
            </button>
            <button type="button" onClick={onClose} className="text-xs px-4 py-2.5" style={{ color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
              Cancel
            </button>
          </div>
        )}

        {phase === 'done' && (
          <div className="flex items-center gap-3 px-5 py-4" style={{ borderTop: '1px solid var(--ef-border)' }}>
            <button type="button" onClick={onClose} className="text-xs px-4 py-2.5" style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2 }}>
              Close
            </button>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export function SubjectManager({
  canMaintain = true,
  onSubjectsChange,
}: {
  // Permission-model Phase 0: subject taxonomy is GLOBAL, so maintenance
  // (create / rename / alias / merge / refresh counts — the last two run
  // full question-collection scans the tenant-fence rules deny to
  // non-webOwner staff) is webOwner-only for now. Institute/faculty pages
  // pass canMaintain={false} and get read-only browsing. The taxonomy is
  // slated to follow the same rights model as questions later.
  canMaintain?: boolean;
  onSubjectsChange?: (subjects: Subject[]) => void;
} = {}) {
  const [subjects,       setSubjects]       = useState<Subject[]>([]);
  const [loading,        setLoading]        = useState(true);
  const [search,         setSearch]         = useState('');
  const [showMerge,      setShowMerge]      = useState(false);
  const [adding,         setAdding]         = useState(false);
  const [newSubjectName, setNewSubjectName] = useState('');
  const [addErr,         setAddErr]         = useState('');
  const [refreshing,     setRefreshing]     = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const all = await getAllSubjects();
    setSubjects(all);
    onSubjectsChange?.(all);
    if (!silent) setLoading(false);
  }, [onSubjectsChange]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    const name = newSubjectName.trim();
    if (!name) return;
    setAddErr('');
    setAdding(true);
    try {
      const created = await createSubject(name);
      invalidateSubjectCache();
      setSubjects((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setNewSubjectName('');
    } catch (err: any) {
      setAddErr(err?.message ?? 'Could not create subject.');
    } finally {
      setAdding(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshAllSubjectCounts();
      await load(true);
    } finally {
      setRefreshing(false);
    }
  };

  const filtered = subjects.filter(
    (s) =>
      s.name.toLowerCase().includes(search.toLowerCase()) ||
      s.aliases.some((a) => a.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div>
      {/* Toolbar */}
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        {/* Search */}
        <div
          className="flex items-center gap-2 px-3 py-2 flex-1"
          style={{ background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border)', borderRadius: 2, minWidth: 180 }}
        >
          <Tag size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
          <input
            type="text" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search subjects or aliases…"
            className="flex-1 text-xs outline-none"
            style={{ background: 'transparent', color: 'var(--ef-ink)', fontSize: 14 }}
          />
        </div>

        {/* Refresh counts (maintenance) */}
        {canMaintain && (
        <button
          type="button" onClick={handleRefresh} disabled={refreshing}
          title="Refresh question counts from Firestore"
          className="flex items-center gap-1.5 text-xs px-3 py-2 transition-opacity hover:opacity-70"
          style={{ border: '1px solid var(--ef-border)', borderRadius: 2, color: 'var(--ef-text-muted)', background: 'var(--ef-canvas-raised)' }}
        >
          {refreshing
            ? <Loader2 size={12} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />
            : <RefreshCw size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
          }
          Refresh counts
        </button>
        )}

        {/* Merge (maintenance) */}
        {canMaintain && (
        <button
          type="button" onClick={() => setShowMerge(true)}
          className="flex items-center gap-1.5 text-xs px-3 py-2 transition-opacity hover:opacity-70"
          style={{ border: '1px solid var(--ef-border)', borderRadius: 2, color: 'var(--ef-text-muted)', background: 'var(--ef-canvas-raised)' }}
        >
          <Merge size={12} strokeWidth={1.5} /> Merge subjects
        </button>
        )}
      </div>

      {/* Add new subject (maintenance) */}
      {canMaintain && (
      <div className="flex items-center gap-2 mb-5">
        <input
          type="text"
          value={newSubjectName}
          onChange={(e) => setNewSubjectName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
          placeholder="New subject name…"
          style={{ ...inp, flex: 1, width: 'auto', padding: '8px 12px' }}
          onFocus={iFocus} onBlur={iBlur}
        />
        <button
          type="button" onClick={handleAdd} disabled={adding || !newSubjectName.trim()}
          className="flex items-center gap-1.5 text-xs px-4 py-2.5 transition-opacity"
          style={{
            background: newSubjectName.trim() ? 'var(--ef-ink)' : 'var(--ef-track)',
            color: 'var(--ef-surface)', borderRadius: 2, flexShrink: 0,
            cursor: newSubjectName.trim() ? 'pointer' : 'not-allowed',
          }}
        >
          {adding ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} strokeWidth={2} />}
          Add Subject
        </button>
      </div>
      )}
      {addErr && <p className="text-xs mb-3" style={{ color: 'var(--ef-danger)' }}>{addErr}</p>}

      {/* Stats row */}
      <p className="text-xs mb-3" style={{ color: 'var(--ef-text-muted)' }}>
        {subjects.length} subjects · {subjects.reduce((acc, s) => acc + s.questionCount, 0)} questions total
        {search && <span> · showing {filtered.length} results</span>}
      </p>

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={18} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center py-12" style={{ color: 'var(--ef-text-muted)' }}>
          <div style={{ width: 1, height: 24, background: 'linear-gradient(to bottom, transparent, var(--ef-border-muted))', marginBottom: 12 }} />
          <p className="text-xs" style={{ letterSpacing: '0.1em' }}>
            {search ? 'NO SUBJECTS MATCH' : 'NO SUBJECTS YET'}
          </p>
        </div>
      ) : (
        <div>
          {filtered.map((s) => (
            <SubjectCard
              key={s.id}
              subject={s}
              canEdit={canMaintain}
              onUpdated={(updated) => setSubjects((prev) => prev.map((x) => x.id === updated.id ? updated : x))}
              onDeleted={(id) => setSubjects((prev) => prev.filter((x) => x.id !== id))}
            />
          ))}
        </div>
      )}

      {/* Merge modal */}
      <AnimatePresence>
        {showMerge && (
          <MergeModal
            subjects={subjects}
            onComplete={(updated) => { setSubjects(updated); setShowMerge(false); }}
            onClose={() => setShowMerge(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}