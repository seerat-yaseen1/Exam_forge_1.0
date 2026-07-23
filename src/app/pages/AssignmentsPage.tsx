import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import {
  Plus, X, Eye, Pencil, Trash2, Loader2, ClipboardList,
  Target, Clock, Calendar, AlertTriangle, Search, CheckCircle2,
  FileText, CalendarClock, ArrowRight, Timer, Award,
  ChevronRight, Layers, CheckSquare, Square, AlertCircle,
  Shuffle, BarChart2, BookOpen, Lock, Users, Building2, Zap, Infinity as InfinityIcon,
  Copy, Shield, Upload,
} from 'lucide-react';
import {
  getAllInstitutes,
  getAllStudents,
  type Institute,
  type Student,
} from '../../lib/firebaseService';
import {
  getAllAssessments,
  createAssessment,
  updateAssessment,
  softDeleteAssessment,
  duplicateAssessment,
  type DuplicateOptions,
  statusColor,
  formatAssignmentTarget,
  resolveQuestionsForSections,
  validateSelectionRules,
  applyTierDefaults,
  getAssessmentSEBKeys,
  setAssessmentSEBKeys,
  uploadAssessmentSebFile,
  deleteAssessmentSebFile,
  type Assessment,
  type AssessmentDraft,
  type AssessmentStatus,
  type AssignmentTarget,
  type AssessmentSection,
} from '../../lib/assessmentService';
import {
  deriveShowResultsTo, deriveAllowReviewTo,
  DEFAULT_SHOW_RESULTS_TO, DEFAULT_ALLOW_REVIEW_TO,
  type VisibilityAudience,
} from '../../lib/visibility';
import { AudienceSelector } from '../components/assignments/AudienceSelector';
import { getAllQuestions, type Question } from '../../lib/questionBankService';
import { getAllSubjects, type Subject } from '../../lib/subjectService';
import { AllocationPanelCore } from '../components/assignments/allocation/AllocationPanelCore';
import { emptyAllocationDraft, getAllocation, commitAllocation, type AllocationDraft, type AllocationNodeType } from '../../lib/allocationService';
import { EditMenu } from '../components/assignments/edit/EditMenu';
// ── Batch F1a extractions ─────────────────────────────────────────
import {
  makeSectionId, SECTION_LETTERS, defaultSectionName, DIFFICULTIES, DIFF_LABEL, DIFF_COLORS,
  toDateTimeLocal, fromDateTimeLocal, dateToInputLocal, formatDateTime,
  formatDateShort, mutabilityFor,
  type Difficulty, type RuleDraft, type SectionDraft, type FieldMutability,
} from '../components/assignments/builder/shared';
import {
  StatusBadgeChip, StatPill, SkeletonRow, FilterBar, EmptyState,
} from '../components/assignments/list/ListChrome';
import { AssessmentRow } from '../components/assignments/list/AssessmentRow';
import {
  DuplicateModal, DeleteModal, PreviewModal,
} from '../components/assignments/list/AssessmentModals';
import {
  Field, SectionLabel, inputStyle, selectStyle, DurationIndicator, PresetChip,
  SegmentedToggle, StartScheduleControl, EndScheduleControl, LockedFieldWrapper,
  DifficultyRow, SettingsToggle,
} from '../components/assignments/builder/controls';
import {
  RuleBuilderPanel, SectionTopicPicker, SubjectPickerPhase, TopicPickerPhase,
} from '../components/assignments/builder/topicPickers';
import {
  InstitutePicker, StudentPicker,
} from '../components/assignments/builder/targetPickers';
import { AssessmentPanel } from '../components/assignments/builder/AssessmentPanel';

export function AssignmentsPage() {
  const navigate = useNavigate();
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [allQuestions, setAllQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);

  const [panelOpen, setPanelOpen] = useState(false);
  const [panelMode, setPanelMode] = useState<'create' | 'edit'>('create');
  const [editTarget, setEditTarget] = useState<Assessment | null>(null);
  const [previewAssessment, setPreviewAssessment] = useState<Assessment | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Assessment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [duplicateTarget, setDuplicateTarget] = useState<Assessment | null>(null);
  const [duplicating, setDuplicating] = useState(false);
  // Post-duplicate feedback (hierarchy re-resolution result, or failure).
  const [duplicateNotice, setDuplicateNotice] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const fetchAll = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [assessData, questionsData] = await Promise.all([getAllAssessments(), getAllQuestions()]);
      setAssessments(assessData.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      setAllQuestions(questionsData);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const handleSave = async (
    draft: AssessmentDraft,
    seb: { keys: string[]; file: File | null; clearFile: boolean } = { keys: [], file: null, clearFile: false },
    allocation: { mode: 'legacy' | 'rules'; nodeType: AllocationNodeType | ''; nodeIds: string[]; expectedVersion: number } =
      { mode: 'legacy', nodeType: '', nodeIds: [], expectedVersion: 0 },
  ) => {
    // Stage 4b: the per-exam .seb file needs the assessment id, which only
    // exists after creation — hence the upload happens here, not in the pane.
    const applySebFile = async (id: string): Promise<string | undefined> => {
      if (seb.clearFile) { await deleteAssessmentSebFile(id).catch(() => {}); return undefined; }
      if (!seb.file) return undefined;
      const url = await uploadAssessmentSebFile(id, seb.file);
      await updateAssessment(id, { sebConfigFileUrl: url });
      return url;
    };

    // Phase C: rule-based allocation commits AFTER the assessment id exists —
    // same reason as the .seb file. resolveAllocation stamps allocationMode
    // and materializes the member list; it re-validates server-side and throws
    // on empty / archived / cross-institute / version-mismatch.
    const applyAllocation = async (id: string): Promise<void> => {
      if (allocation.mode !== 'rules' || !allocation.nodeType) return;
      await commitAllocation(id, allocation.nodeType, allocation.nodeIds, allocation.expectedVersion);
    };

    if (panelMode === 'create') {
      const saved = await createAssessment(draft);
      // Stage 4: per-exam keys live in a side collection keyed by the id we
      // only have after creation. Empty array deletes/skips the override.
      await setAssessmentSEBKeys(saved.id, seb.keys).catch(() => {});
      const url = await applySebFile(saved.id).catch(() => undefined);
      if (url) saved.sebConfigFileUrl = url;
      // Allocation commit is NOT swallowed — a failure (archived node, empty,
      // version mismatch) must surface. The assessment already exists as a
      // draft WITHOUT allocationMode, so it's a safe legacy doc until re-saved.
      await applyAllocation(saved.id);
      if (allocation.mode === 'rules') (saved as { allocationMode?: string }).allocationMode = 'rules';
      setAssessments((prev) => [saved, ...prev]);
    } else if (editTarget) {
      await updateAssessment(editTarget.id, draft);
      await setAssessmentSEBKeys(editTarget.id, seb.keys).catch(() => {});
      const uploadedUrl = await applySebFile(editTarget.id).catch(() => undefined);
      if (uploadedUrl) draft.sebConfigFileUrl = uploadedUrl;
      await applyAllocation(editTarget.id);
      const totalMarks = draft.questions.reduce((s, q) => s + q.marks, 0);
      const updated = { ...editTarget, ...draft, totalMarks, updatedAt: new Date().toISOString() } as Assessment;
      if (allocation.mode === 'rules') (updated as { allocationMode?: string }).allocationMode = 'rules';
      setAssessments((prev) => prev.map((a) => (a.id === editTarget.id ? updated : a)));
    }
    setPanelOpen(false);
    setEditTarget(null);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await softDeleteAssessment(deleteTarget.id);
      setAssessments((prev) => prev.filter((a) => a.id !== deleteTarget.id));
      setDeleteTarget(null);
    } finally { setDeleting(false); }
  };

  const handleDuplicate = async (opts: DuplicateOptions, title: string) => {
    if (!duplicateTarget) return;
    setDuplicating(true);
    setDuplicateNotice(null);
    try {
      const { assessment: copy, allocation } = await duplicateAssessment(duplicateTarget.id, opts, title);
      // Show the new draft at the top of the list immediately.
      setAssessments((prev) => [copy, ...prev]);
      setDuplicateTarget(null);
      // A hierarchy copy re-resolves its selection against today's hierarchy,
      // so its roster can legitimately differ from the source's. Say so —
      // silently landing a different roster is how the original bug hid.
      if (allocation.kind === 'rules_recreated') {
        setDuplicateNotice({
          tone: 'info',
          text: `Hierarchy allocation re-resolved for the copy — ${allocation.count} student${allocation.count === 1 ? '' : 's'} allocated. This can differ from the original if students have moved.`,
        });
      } else if (allocation.kind === 'rules_failed') {
        setDuplicateNotice({
          tone: 'warn',
          text: `The copy was created, but ${allocation.reason}. It currently targets nobody — open it and set "Assign To" before publishing.`,
        });
      }
    } catch (e: any) {
      // Previously swallowed into console only, so a failed duplicate looked
      // like a no-op. Surface it.
      console.error('[AssignmentsPage] duplicate failed', e);
      setDuplicateNotice({ tone: 'warn', text: e?.message || 'Duplicate failed. Nothing was created.' });
    } finally { setDuplicating(false); }
  };

  const openCreate = () => { setEditTarget(null); setPanelMode('create'); setPanelOpen(true); };
  const openEdit = (a: Assessment) => { setEditTarget(a); setPanelMode('edit'); setPanelOpen(true); };

  const filtered = assessments.filter((a) => {
    if (statusFilter && a.status !== statusFilter) return false;
    if (search) {
      const s = search.toLowerCase();
      if (!a.title.toLowerCase().includes(s) && !a.subject.toLowerCase().includes(s) && !a.description.toLowerCase().includes(s)) return false;
    }
    return true;
  });

  const draftCount = assessments.filter((a) => a.status === 'draft').length;
  const activeCount = assessments.filter((a) => a.status === 'active').length;
  const closedCount = assessments.filter((a) => a.status === 'closed').length;

  return (
    <>
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        className="px-4 py-6 md:px-8 md:py-10" style={{ maxWidth: 1120, margin: '0 auto' }}>

        {/* Header */}
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between mb-8"
          style={{ borderBottom: '1px solid #E3E1DB', paddingBottom: 20 }}>
          <div>
            <p className="text-xs mb-1" style={{ color: '#9A9891', letterSpacing: '0.1em' }}>WEB OWNER</p>
            <h1 className="text-base" style={{ color: '#0C0C0B' }}>Assessments</h1>
            <p className="text-xs mt-1" style={{ color: '#B0AEA8' }}>
              Create and manage assessments for institutes and students.
            </p>
          </div>
          <button onClick={openCreate}
            className="flex items-center justify-center gap-1.5 text-xs px-4 py-2.5 transition-opacity hover:opacity-80 self-start md:mt-1"
            style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, letterSpacing: '0.03em' }}>
            <Plus size={12} strokeWidth={2} /> Create Assessment
          </button>
        </div>

        {/* Duplicate outcome notice */}
        {duplicateNotice && (
          <div className="flex items-start gap-2 px-3 py-2.5 mb-5"
            style={{
              background: duplicateNotice.tone === 'warn' ? '#FFFBEB' : '#F7F6F3',
              border: `1px solid ${duplicateNotice.tone === 'warn' ? '#FDE68A' : '#E3E1DB'}`,
              borderRadius: 2,
            }}>
            <p className="text-xs flex-1" style={{ color: duplicateNotice.tone === 'warn' ? '#92400E' : '#4A4A45', lineHeight: 1.6 }}>
              {duplicateNotice.text}
            </p>
            <button onClick={() => setDuplicateNotice(null)}
              className="text-xs transition-opacity hover:opacity-60"
              style={{ color: '#9A9891' }}>Dismiss</button>
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-8">
          <StatPill icon={<ClipboardList size={13} strokeWidth={1.5} style={{ color: '#9A9891' }} />} label="Total Assessments" value={loading ? '…' : String(assessments.length)} />
          <StatPill icon={<FileText size={13} strokeWidth={1.5} style={{ color: '#9A9891' }} />} label="Drafts" value={loading ? '…' : String(draftCount)} />
          <StatPill icon={<Target size={13} strokeWidth={1.5} style={{ color: '#9A9891' }} />} label="Active" value={loading ? '…' : String(activeCount)} />
          <StatPill icon={<Clock size={13} strokeWidth={1.5} style={{ color: '#9A9891' }} />} label="Closed" value={loading ? '…' : String(closedCount)} />
        </div>

        {/* List */}
        <div style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3 }}>
          <FilterBar search={search} setSearch={setSearch} statusFilter={statusFilter} setStatusFilter={setStatusFilter} />
          {!loading && filtered.length > 0 && (
            <div className="hidden md:flex items-center gap-4 px-5 py-2" style={{ background: '#FAFAF8', borderBottom: '1px solid #F0EFEB' }}>
              <div className="flex-shrink-0 w-16"><span className="text-xs" style={{ color: '#C4C3BD', letterSpacing: '0.08em' }}>STATUS</span></div>
              <div className="flex-1"><span className="text-xs" style={{ color: '#C4C3BD', letterSpacing: '0.08em' }}>ASSESSMENT</span></div>
              <div className="flex-shrink-0 text-right" style={{ minWidth: 148 }}><span className="text-xs" style={{ color: '#C4C3BD', letterSpacing: '0.08em' }}>DATE RANGE</span></div>
              <div className="flex-shrink-0 w-20" />
            </div>
          )}
          {loading && <><SkeletonRow /><SkeletonRow /><SkeletonRow /></>}
          {!loading && filtered.map((a) => (
            <AssessmentRow key={a.id} assessment={a}
              onPreview={() => setPreviewAssessment(a)}
              onPatched={(patch) => setAssessments((prev) => prev.map((x) => (x.id === a.id ? { ...x, ...patch, updatedAt: new Date().toISOString() } as Assessment : x)))}
              onOpenLegacyEditor={() => openEdit(a)}
              onDelete={() => setDeleteTarget(a)}
              onDuplicate={() => setDuplicateTarget(a)}
              onRoster={() => navigate(`/dashboard/assignments/${a.id}/roster`)} />
          ))}
          {!loading && filtered.length === 0 && <EmptyState filtered={!!(search || statusFilter)} onAdd={openCreate} />}
          {!loading && filtered.length > 0 && (
            <div className="px-5 py-3 flex items-center justify-between" style={{ borderTop: '1px solid #F0EFEB' }}>
              <span className="text-xs" style={{ color: '#C4C3BD' }}>
                {filtered.length} {filtered.length === 1 ? 'assessment' : 'assessments'}
                {(search || statusFilter) && ' matching filters'}
              </span>
              {(search || statusFilter) && (
                <button onClick={() => { setSearch(''); setStatusFilter(''); }}
                  className="text-xs transition-opacity hover:opacity-60" style={{ color: '#9A9891' }}>
                  Clear filters
                </button>
              )}
            </div>
          )}
        </div>
      </motion.div>

      {/* Full-page panel */}
      <AnimatePresence>
        {panelOpen && (
          <AssessmentPanel mode={panelMode} assessment={editTarget} allQuestions={allQuestions}
            onSave={handleSave} onClose={() => { setPanelOpen(false); setEditTarget(null); }} />
        )}
      </AnimatePresence>

      {/* Preview */}
      <AnimatePresence>
        {previewAssessment && <PreviewModal assessment={previewAssessment} onClose={() => setPreviewAssessment(null)} />}
      </AnimatePresence>

      {/* Delete */}
      <AnimatePresence>
        {duplicateTarget && <DuplicateModal assessment={duplicateTarget} onConfirm={handleDuplicate}
          onCancel={() => setDuplicateTarget(null)} duplicating={duplicating} />}
        {deleteTarget && <DeleteModal assessment={deleteTarget} onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)} deleting={deleting} />}
      </AnimatePresence>
    </>
  );
}