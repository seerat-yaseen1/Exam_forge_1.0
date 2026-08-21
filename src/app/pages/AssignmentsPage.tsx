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
import { getAllQuestions, getAllQuestionGroups, type Question, type QuestionGroup } from '../../lib/questionBankService';
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
  StatusBadgeChip, SkeletonRow, FilterBar, EmptyState,
} from '../components/assignments/list/ListChrome';
import {
  Button, Card, PageHeader, PageShell, StatRow, StatTile, Toast,
} from '../components/console/ui';
import { AssessmentRow } from '../components/assignments/list/AssessmentRow';
import {
  DuplicateModal, DeleteModal, PreviewModal, SourcePickerModal,
} from '../components/assignments/list/AssessmentModals';
import {
  Field, SectionLabel, inputStyle, selectStyle, PresetChip,
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
  const [allGroups, setAllGroups] = useState<QuestionGroup[]>([]);
  const [loading, setLoading] = useState(true);

  const [panelOpen, setPanelOpen] = useState(false);
  const [panelMode, setPanelMode] = useState<'create' | 'edit'>('create');
  const [editTarget, setEditTarget] = useState<Assessment | null>(null);
  const [previewAssessment, setPreviewAssessment] = useState<Assessment | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Assessment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [duplicateTarget, setDuplicateTarget] = useState<Assessment | null>(null);
  /** The "start from existing" source picker, which hands off to DuplicateModal. */
  const [pickingSource, setPickingSource] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  // Post-duplicate feedback (hierarchy re-resolution result, or failure).
  const [duplicateNotice, setDuplicateNotice] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  // The notice used to be a dismissible banner above the list. As a toast it
  // has to clear itself — a warning about a duplicate that never goes away
  // becomes part of the page's furniture and stops being read.
  useEffect(() => {
    if (!duplicateNotice) return;
    const t = setTimeout(() => setDuplicateNotice(null), 8000);
    return () => clearTimeout(t);
  }, [duplicateNotice]);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const fetchAll = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [assessData, questionsData, groupsData] = await Promise.all([
        getAllAssessments(),
        getAllQuestions(),
        // FAILS SOFT, and must. Grouped sets are additive content: a paper can
        // be built entirely without them, so failing to read them may never
        // cost the caller the assessments list or the question bank alongside.
        //
        // This is not hypothetical — it is the bug this catch was added for.
        // A bare read here took down the whole Promise.all whenever
        // /questionGroups was unreadable (rules not yet deployed being the
        // obvious case, since Firestore denies any collection with no matching
        // rule), so setAssessments and setAllQuestions never ran. The page
        // rendered zero assessments and zero topics against a database that
        // had lost nothing. Same reasoning as the session claim in ExamShell.
        getAllQuestionGroups().catch((e) => {
          console.warn('[assignments] question groups unavailable — continuing without them', e);
          return [];
        }),
      ]);
      setAssessments(assessData.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      setAllQuestions(questionsData);
      setAllGroups(groupsData);
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
      <PageShell>
        <PageHeader
          eyebrow={
            <>
              <span className="ef-eyebrow-dot" />
              Web owner
            </>
          }
          title="Assessments"
          subtitle="A paper, plus who sits it and when. Everything here is built by the platform and published to institutes or straight to students."
          actions={
            <>
              {/* ── Two ways in ──
                  Duplicating an exam was already the fastest way to build a
                  new one — structure, rules, grading policy and security tier
                  all come across — but it lived behind an unlabelled icon at
                  the end of a row, so only authors who went looking found it.
                  Most exams are a variant of last term's, and a builder whose
                  only visible entry point is a blank form makes every one of
                  those start from nothing.

                  Create stays primary. This is the shortcut, not the default. */}
              {assessments.length > 0 && (
                <Button size="sm" onClick={() => setPickingSource(true)}>
                  <Copy size={12} strokeWidth={1.7} />
                  Start from existing
                </Button>
              )}
              <Button size="sm" variant="primary" onClick={openCreate}>
                <Plus size={12} strokeWidth={1.9} />
                Create assessment
              </Button>
            </>
          }
        />

        <div style={{ marginBottom: 26 }}>
          <StatRow>
            <StatTile
              label="All assessments"
              value={loading ? '—' : assessments.length}
              icon={<ClipboardList size={13} strokeWidth={1.7} />}
              sub="built by the platform"
              hint="Everything not deleted, at any status."
            />
            <StatTile
              label="Drafts"
              value={loading ? '—' : draftCount}
              icon={<FileText size={13} strokeWidth={1.7} />}
              tone={draftCount > 0 ? 'warning' : undefined}
              sub={draftCount > 0 ? 'not published' : 'none waiting'}
              hint="Invisible to students until published."
            />
            <StatTile
              label="Active"
              value={loading ? '—' : activeCount}
              icon={<Target size={13} strokeWidth={1.7} />}
              tone={activeCount > 0 ? 'success' : undefined}
              sub={activeCount > 0 ? 'open to students' : 'nothing live'}
              hint="Published and inside its window."
            />
            <StatTile
              label="Closed"
              value={loading ? '—' : closedCount}
              icon={<Clock size={13} strokeWidth={1.7} />}
              sub="finished"
              hint="Past their window, or closed by hand. Results and rosters stay readable."
            />
          </StatRow>
        </div>

        <FilterBar
          search={search}
          setSearch={setSearch}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
        />

        {loading ? (
          <Card padded={false}>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </Card>
        ) : filtered.length === 0 ? (
          <EmptyState filtered={!!(search || statusFilter)} onAdd={openCreate} />
        ) : (
          <Card padded={false}>
            <div
              className="hidden md:flex items-center gap-4"
              style={{
                padding: '9px var(--ef-pad-card)',
                background: 'var(--ef-canvas-raised)',
                borderBottom: '1px solid var(--ef-border-subtle)',
              }}
            >
              <span className="ef-t-2xs ef-muted flex-shrink-0" style={{ width: 64, letterSpacing: 'var(--ef-tracking-eyebrow)', textTransform: 'uppercase' }}>Status</span>
              <span className="ef-t-2xs ef-muted flex-1" style={{ letterSpacing: 'var(--ef-tracking-eyebrow)', textTransform: 'uppercase' }}>Assessment</span>
              <span className="ef-t-2xs ef-muted flex-shrink-0 text-right" style={{ minWidth: 148, letterSpacing: 'var(--ef-tracking-eyebrow)', textTransform: 'uppercase' }}>Window</span>
              <span className="flex-shrink-0" style={{ width: 80 }} />
            </div>
            {filtered.map((a) => (
              <AssessmentRow
                key={a.id}
                assessment={a}
                onPreview={() => setPreviewAssessment(a)}
                onPatched={(patch) => setAssessments((prev) => prev.map((x) => (x.id === a.id ? { ...x, ...patch, updatedAt: new Date().toISOString() } as Assessment : x)))}
                onOpenLegacyEditor={() => openEdit(a)}
                onDelete={() => setDeleteTarget(a)}
                onDuplicate={() => setDuplicateTarget(a)}
                onRoster={() => navigate(`/dashboard/assignments/${a.id}/roster`)}
              />
            ))}
          </Card>
        )}

        {!loading && filtered.length > 0 && (search || statusFilter) && (
          <p className="ef-t-xs ef-muted" style={{ marginTop: 12 }}>
            Showing {filtered.length} of {assessments.length}.{' '}
            <button
              type="button"
              onClick={() => { setSearch(''); setStatusFilter(''); }}
              style={{ background: 'none', border: 0, padding: 0, color: 'var(--ef-accent)', cursor: 'pointer', font: 'inherit' }}
            >
              Clear filters
            </button>
          </p>
        )}

        <Toast
          message={duplicateNotice?.text ?? ''}
          tone={duplicateNotice?.tone === 'warn' ? 'danger' : 'ink'}
        />
      </PageShell>

      {/* Full-page panel */}
      <AnimatePresence>
        {panelOpen && (
          <AssessmentPanel mode={panelMode} assessment={editTarget} allQuestions={allQuestions} allGroups={allGroups}
            onSave={handleSave} onClose={() => { setPanelOpen(false); setEditTarget(null); }} />
        )}
      </AnimatePresence>

      {/* Preview */}
      <AnimatePresence>
        {previewAssessment && <PreviewModal assessment={previewAssessment} onClose={() => setPreviewAssessment(null)} />}
      </AnimatePresence>

      {/* Delete */}
      <AnimatePresence>
        {pickingSource && (
          <SourcePickerModal
            assessments={assessments}
            onPick={(a) => { setPickingSource(false); setDuplicateTarget(a); }}
            onCancel={() => setPickingSource(false)}
          />
        )}
        {duplicateTarget && <DuplicateModal assessment={duplicateTarget} onConfirm={handleDuplicate}
          onCancel={() => setDuplicateTarget(null)} duplicating={duplicating} />}
        {deleteTarget && <DeleteModal assessment={deleteTarget} onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)} deleting={deleting} />}
      </AnimatePresence>
    </>
  );
}