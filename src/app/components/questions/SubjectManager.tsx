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
  background: '#FAFAF8', border: '1px solid #E3E1DB', color: '#0C0C0B',
  borderRadius: 2, outline: 'none', fontSize: 13,
  padding: '8px 12px', width: '100%',
};
function iFocus(e: React.FocusEvent<HTMLInputElement>) { e.target.style.borderColor = '#0C0C0B'; e.target.style.background = '#FFFFFF'; }
function iBlur (e: React.FocusEvent<HTMLInputElement>) { e.target.style.borderColor = '#E3E1DB'; e.target.style.background = '#FAFAF8'; }

// ── Alias tag input ───────────────────────────────────────────────────────────

function AliasRow({
  alias, onRemove, removing,
}: { alias: string; onRemove: () => void; removing: boolean }) {
  return (
    <span
      className="flex items-center gap-1 px-2 py-0.5 text-xs select-none"
      style={{ background: '#F0EFEB', borderRadius: 2, color: '#4A4A45' }}
    >
      {alias}
      <button
        type="button"
        onClick={onRemove}
        disabled={removing}
        className="transition-opacity hover:opacity-60 ml-0.5"
        style={{ color: '#9A9891', cursor: removing ? 'not-allowed' : 'pointer' }}
      >
        {removing ? <Loader2 size={9} className="animate-spin" /> : <X size={9} strokeWidth={2} />}
      </button>
    </span>
  );
}

// ── Subject card ──────────────────────────────────────────────────────────────

function SubjectCard({
  subject, onUpdated, onDeleted,
}: {
  subject: Subject;
  onUpdated: (s: Subject) => void;
  onDeleted: (id: string) => void;
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
    <div style={{ border: '1px solid #E3E1DB', borderRadius: 3, background: '#FFFFFF', marginBottom: 8 }}>
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
                style={{ ...inp, flex: 1, width: 'auto', padding: '5px 8px', fontSize: 12 }}
                onFocus={iFocus} onBlur={iBlur}
                autoFocus
              />
              <button type="button" onClick={submitRename} disabled={renameSaving}
                className="flex items-center gap-1 text-xs px-2.5 py-1.5 transition-opacity"
                style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2 }}
              >
                {renameSaving ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} strokeWidth={2} />}
              </button>
              <button type="button" onClick={() => { setRenaming(false); setNewName(subject.name); }}
                className="text-xs px-2.5 py-1.5" style={{ color: '#9A9891', border: '1px solid #E3E1DB', borderRadius: 2 }}
              >
                <X size={10} strokeWidth={2} />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-sm" style={{ color: '#0C0C0B' }}>{subject.name}</span>
              <button
                type="button" onClick={() => { setRenaming(true); setNewName(subject.name); }}
                className="transition-opacity hover:opacity-60" title="Rename"
                style={{ color: '#C4C3BD' }}
              >
                <Pencil size={11} strokeWidth={1.5} />
              </button>
            </div>
          )}
          {renameErr && <p className="text-xs mt-1" style={{ color: '#9B2828' }}>{renameErr}</p>}
        </div>

        {/* Question count */}
        <span
          className="text-xs px-2 py-0.5 select-none flex-shrink-0"
          style={{ background: '#F7F6F3', border: '1px solid #E3E1DB', borderRadius: 2, color: '#9A9891' }}
        >
          {subject.questionCount} {subject.questionCount === 1 ? 'question' : 'questions'}
        </span>

        {/* Alias count pill */}
        {subject.aliases.length > 0 && (
          <span className="text-xs flex-shrink-0" style={{ color: '#B0AEA8' }}>
            {subject.aliases.length} alias{subject.aliases.length > 1 ? 'es' : ''}
          </span>
        )}

        {/* Expand toggle */}
        <button
          type="button" onClick={() => setExpanded((v) => !v)}
          className="transition-opacity hover:opacity-60 flex-shrink-0" style={{ color: '#C4C3BD' }}
        >
          {expanded ? <ChevronUp size={14} strokeWidth={1.5} /> : <ChevronDown size={14} strokeWidth={1.5} />}
        </button>
      </div>

      {/* Expanded alias management */}
      {expanded && (
        <div className="px-4 pb-4 pt-1" style={{ borderTop: '1px solid #F0EFEB' }}>
          <p className="text-xs mb-2" style={{ color: '#9A9891', letterSpacing: '0.06em' }}>ALIASES</p>
          <p className="text-xs mb-3" style={{ color: '#B0AEA8', lineHeight: 1.6 }}>
            Aliases are alternate names that resolve to this subject. When a question or bulk-upload uses an alias, it is automatically mapped to <strong>{subject.name}</strong>.
          </p>
          <div className="flex flex-wrap gap-1.5 mb-3">
            {subject.aliases.length === 0 && (
              <span className="text-xs" style={{ color: '#C4C3BD' }}>No aliases yet.</span>
            )}
            {subject.aliases.map((a) => (
              <AliasRow
                key={a} alias={a}
                onRemove={() => submitRemoveAlias(a)}
                removing={removingAlias === a}
              />
            ))}
          </div>

          {/* Add alias */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={newAlias}
              onChange={(e) => setNewAlias(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitAddAlias(); }}
              placeholder="Add alias (e.g. QUANT, Maths)"
              style={{ ...inp, flex: 1, width: 'auto', padding: '7px 10px', fontSize: 12 }}
              onFocus={iFocus} onBlur={iBlur}
            />
            <button
              type="button" onClick={submitAddAlias} disabled={addingAlias || !newAlias.trim()}
              className="flex items-center gap-1.5 text-xs px-3 py-2 transition-opacity"
              style={{
                background: newAlias.trim() ? '#0C0C0B' : '#C8C7C2',
                color: '#FFFFFF', borderRadius: 2,
                cursor: newAlias.trim() ? 'pointer' : 'not-allowed',
              }}
            >
              {addingAlias ? <Loader2 size={10} className="animate-spin" /> : <Plus size={10} strokeWidth={2} />}
              Add
            </button>
          </div>
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
        style={{ maxWidth: 480, background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 sm:px-5 py-3.5 sm:py-4" style={{ borderBottom: '1px solid #E3E1DB' }}>
          <div>
            <p className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.1em' }}>SUBJECT MANAGER</p>
            <p className="text-sm mt-0.5" style={{ color: '#0C0C0B' }}>Merge Subjects</p>
          </div>
          {phase !== 'merging' && (
            <button onClick={onClose} className="p-1 hover:opacity-60 transition-opacity" style={{ color: '#9A9891' }}>
              <X size={14} strokeWidth={1.5} />
            </button>
          )}
        </div>

        <div className="px-5 py-5">
          {(phase === 'pick' || phase === 'preview') && (
            <>
              {/* Destructive warning */}
              <div className="flex items-start gap-2.5 px-3 py-3 mb-5" style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2 }}>
                <AlertTriangle size={13} strokeWidth={1.5} style={{ color: '#9B2828', flexShrink: 0, marginTop: 1 }} />
                <p className="text-xs" style={{ color: '#9B2828', lineHeight: 1.7 }}>
                  Merge is <strong>permanent and cannot be undone</strong>. All questions with the source subject will be updated to the target. The source subject will be deleted and its name will become an alias of the target.
                </p>
              </div>

              {/* Source */}
              <div className="mb-4">
                <label className="block text-xs mb-1.5" style={{ color: '#4A4A45' }}>Replace this subject (source)</label>
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
                <label className="block text-xs mb-1.5" style={{ color: '#4A4A45' }}>…with this subject (target)</label>
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
                <div className="px-4 py-4 mb-5" style={{ background: '#F7F6F3', border: '1px solid #E3E1DB', borderRadius: 2 }}>
                  <p className="text-xs mb-2" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>IMPACT PREVIEW</p>
                  <p className="text-xs mb-1" style={{ color: '#0C0C0B', lineHeight: 1.7 }}>
                    <strong>{source.questionCount}</strong> questions tagged <strong>"{source.name}"</strong> will be updated to <strong>"{target.name}"</strong>.
                  </p>
                  <p className="text-xs mb-1" style={{ color: '#0C0C0B', lineHeight: 1.7 }}>
                    <strong>"{source.name}"</strong> will be removed from the registry.
                  </p>
                  <p className="text-xs" style={{ color: '#0C0C0B', lineHeight: 1.7 }}>
                    <strong>"{source.name}"</strong> will become an alias of <strong>"{target.name}"</strong> — future uploads using this name will auto-map to the target.
                  </p>
                </div>
              )}

              {/* Typed confirmation */}
              {canPreview && (
                <div className="mb-5">
                  <label className="block text-xs mb-1.5" style={{ color: '#4A4A45' }}>
                    Type <code style={{ fontFamily: 'monospace', background: '#F0EFEB', padding: '1px 5px', borderRadius: 2, letterSpacing: '0.08em' }}>MERGE</code> to confirm
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

              {err && <p className="text-xs mb-3" style={{ color: '#9B2828' }}>{err}</p>}
            </>
          )}

          {phase === 'merging' && progress && (
            <div className="flex flex-col items-center py-8">
              <Loader2 size={22} className="animate-spin mb-4" style={{ color: '#9A9891' }} />
              <p className="text-sm mb-1" style={{ color: '#0C0C0B' }}>
                {progress.phase === 'counting' ? 'Counting affected questions…' :
                 progress.phase === 'updating' ? `Updating questions… ${progress.done} / ${progress.total}` :
                 progress.phase === 'cleanup'  ? 'Cleaning up registry…' :
                 'Done'}
              </p>
              {progress.total > 0 && (
                <div className="w-full mt-4" style={{ maxWidth: 240 }}>
                  <div style={{ height: 3, background: '#E3E1DB', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%',
                      width: `${Math.round((progress.done / progress.total) * 100)}%`,
                      background: '#0C0C0B', borderRadius: 2, transition: 'width 0.3s',
                    }} />
                  </div>
                </div>
              )}
            </div>
          )}

          {phase === 'done' && result && (
            <div className="flex flex-col items-center py-8">
              <div className="flex items-center justify-center mb-4" style={{ width: 44, height: 44, borderRadius: '50%', background: '#F0FBF4', border: '1px solid #C3E8CE' }}>
                <CheckCircle2 size={20} strokeWidth={1.5} style={{ color: '#2A6B3A' }} />
              </div>
              <p className="text-sm mb-1" style={{ color: '#0C0C0B' }}>Merge complete</p>
              <p className="text-xs" style={{ color: '#2A6B3A' }}>{result.updatedCount} questions updated.</p>
              <p className="text-xs mt-1" style={{ color: '#B0AEA8' }}>
                "{source?.name}" is now an alias of "{target?.name}".
              </p>
            </div>
          )}
        </div>

        {(phase === 'pick' || phase === 'preview') && (
          <div className="flex items-center gap-3 px-5 py-4" style={{ borderTop: '1px solid #E3E1DB' }}>
            <button
              type="button"
              onClick={executeMerge}
              disabled={!canMerge || !canPreview}
              className="flex items-center gap-1.5 text-xs px-4 py-2.5 transition-opacity"
              style={{
                background: canMerge && canPreview ? '#9B2828' : '#C8C7C2',
                color: '#FFFFFF', borderRadius: 2,
                cursor: canMerge && canPreview ? 'pointer' : 'not-allowed',
              }}
            >
              <Merge size={11} strokeWidth={1.5} /> Confirm Merge
            </button>
            <button type="button" onClick={onClose} className="text-xs px-4 py-2.5" style={{ color: '#9A9891', border: '1px solid #E3E1DB', borderRadius: 2 }}>
              Cancel
            </button>
          </div>
        )}

        {phase === 'done' && (
          <div className="flex items-center gap-3 px-5 py-4" style={{ borderTop: '1px solid #E3E1DB' }}>
            <button type="button" onClick={onClose} className="text-xs px-4 py-2.5" style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2 }}>
              Close
            </button>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export function SubjectManager() {
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
    if (!silent) setLoading(false);
  }, []);

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
          style={{ background: '#FAFAF8', border: '1px solid #E3E1DB', borderRadius: 2, minWidth: 180 }}
        >
          <Tag size={12} strokeWidth={1.5} style={{ color: '#B0AEA8', flexShrink: 0 }} />
          <input
            type="text" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search subjects or aliases…"
            className="flex-1 text-xs outline-none"
            style={{ background: 'transparent', color: '#0C0C0B', fontSize: 13 }}
          />
        </div>

        {/* Refresh counts */}
        <button
          type="button" onClick={handleRefresh} disabled={refreshing}
          title="Refresh question counts from Firestore"
          className="flex items-center gap-1.5 text-xs px-3 py-2 transition-opacity hover:opacity-70"
          style={{ border: '1px solid #E3E1DB', borderRadius: 2, color: '#9A9891', background: '#FAFAF8' }}
        >
          {refreshing
            ? <Loader2 size={12} className="animate-spin" style={{ color: '#9A9891' }} />
            : <RefreshCw size={12} strokeWidth={1.5} style={{ color: '#9A9891' }} />
          }
          Refresh counts
        </button>

        {/* Merge */}
        <button
          type="button" onClick={() => setShowMerge(true)}
          className="flex items-center gap-1.5 text-xs px-3 py-2 transition-opacity hover:opacity-70"
          style={{ border: '1px solid #E3E1DB', borderRadius: 2, color: '#9A9891', background: '#FAFAF8' }}
        >
          <Merge size={12} strokeWidth={1.5} /> Merge subjects
        </button>
      </div>

      {/* Add new subject */}
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
            background: newSubjectName.trim() ? '#0C0C0B' : '#C8C7C2',
            color: '#FFFFFF', borderRadius: 2, flexShrink: 0,
            cursor: newSubjectName.trim() ? 'pointer' : 'not-allowed',
          }}
        >
          {adding ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} strokeWidth={2} />}
          Add Subject
        </button>
      </div>
      {addErr && <p className="text-xs mb-3" style={{ color: '#9B2828' }}>{addErr}</p>}

      {/* Stats row */}
      <p className="text-xs mb-3" style={{ color: '#B0AEA8' }}>
        {subjects.length} subjects · {subjects.reduce((acc, s) => acc + s.questionCount, 0)} questions total
        {search && <span> · showing {filtered.length} results</span>}
      </p>

      {/* List */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={18} className="animate-spin" style={{ color: '#C4C3BD' }} />
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center py-12" style={{ color: '#C4C3BD' }}>
          <div style={{ width: 1, height: 24, background: 'linear-gradient(to bottom, transparent, #DDDBD5)', marginBottom: 12 }} />
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
