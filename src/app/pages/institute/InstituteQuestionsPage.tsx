/**
 * The institute's own question pool.
 *
 * Everything you can see here lives in components/questions/QuestionPool —
 * see that file for why. What is left is what is actually about an institute
 * admin: which questions they may edit (their own; faculty-authored ones are
 * visible institute-wide but not editable), and the fact that their writes
 * always resolve to direct mode because there is nobody above them to ask.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Navigate } from 'react-router';
import { BookOpen, Download, Layers, Pencil, Plus, Trash2, Upload } from 'lucide-react';
import {
  getQuestionsByOwner, getQuestionsByInstitute,
  createQuestionAsRole, editQuestionAsRole, deleteQuestionAsRole,
  type Question,
} from '../../../lib/questionBankService';
import { getFacultyByInstitute } from '../../../lib/firebaseService';
import { getAllSubjects, type Subject } from '../../../lib/subjectService';
import { QuestionTypeEngine, type QuestionDraft } from '../../components/questions/QuestionTypeEngine';
import { SubjectManager } from '../../components/questions/SubjectManager';
import { BulkUploadModal } from '../../components/questions/BulkUploadModal';
import { ExportModal } from '../../components/questions/ExportModal';
import {
  DeleteQuestionSheet, EditorSheet, PreviewSheet, QuestionPool,
  filterQuestions, isFiltered, usePoolFilters,
} from '../../components/questions/QuestionPool';
import { useInstituteAuth } from '../../context/InstituteAuthContext';
import {
  Button, PageHeader, PageShell, StatRow, StatTile,
} from '../../components/console/ui';
import { Tabs, type RowAction } from '../../components/console/data';

type Tab = 'pool' | 'subjects';

export function InstituteQuestionsPage() {
  const { session } = useInstituteAuth();

  // Both guards live at the BOTTOM of this component, just above the return.
  // See the note on FacultyAssignmentsPage: gating here changed the hook
  // count between the render where `session` was still null and the one after
  // it arrived, which is the "Rendered more hooks than during the previous
  // render" crash. Everything from here down is a hook or derived from one.
  const instituteId = session?.instituteId ?? '';
  const canAdminCreateQuestions = session?.canAdminCreateQuestions ?? false;

  const [questions, setQuestions] = useState<Question[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  // facultyId → display name, for the author badge on faculty-authored
  // questions surfaced by institute-wide visibility.
  const [facultyNames, setFacultyNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  const [tab, setTab] = useState<Tab>('pool');
  const [filters, setFilters] = usePoolFilters();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<'create' | 'edit'>('create');
  const [editTarget, setEditTarget] = useState<Question | null>(null);
  const [previewQ, setPreviewQ] = useState<Question | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Question | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [bulkUploadOpen, setBulkUploadOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  const fetchAll = useCallback(async (silent = false) => {
    // No tenant yet — the guards below are about to redirect. Leaving
    // `loading` true keeps the skeleton up for that frame.
    if (!instituteId) return;
    if (!silent) setLoading(true);
    try {
      const [own, wide, subjs, faculty] = await Promise.all([
        // Own questions WITH answer keys (admin authors/edits these).
        getQuestionsByOwner('institute', instituteId),
        // Everything authored inside the institute — includes faculty
        // questions (public only; their keys stay owner-scoped). Phase-1
        // institute-wide visibility.
        getQuestionsByInstitute(instituteId),
        getAllSubjects(),
        getFacultyByInstitute(instituteId),
      ]);
      setFacultyNames(Object.fromEntries(faculty.map((f) => [f.id, f.name])));
      // Merge: own questions (keyed, editable) take precedence over their
      // public twin in the wide set; faculty questions come through as
      // public-only. De-dupe by id.
      const ownIds = new Set(own.map((q) => q.id));
      const merged = [...own, ...wide.filter((q) => !ownIds.has(q.id))];
      setQuestions(merged.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      setSubjects(subjs);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [instituteId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Audit S-02. These three actions used to write straight to Firestore via
  // createQuestion / updateQuestion / softDeleteQuestion, which meant the
  // institute path skipped the question-rights ceiling entirely — an institute
  // whose ceiling says create is not allowed could still create. Phase 2A
  // moved the FACULTY page onto the *AsRole callables and this page was never
  // brought along, so the enforcement existed but only half the callers used
  // it. The callables apply the same ceiling check server-side and are now the
  // only write path, since the rules no longer accept these writes from
  // anyone but the webOwner.
  //
  // No request-mode branch here, unlike the faculty page: an institute admin
  // always resolves to direct mode (assertQuestionRight returns 'direct' for
  // admins and throws on requireMode 'request'), because request mode means
  // "ask the institute admin" and there is nobody above them to ask.
  const handleSave = async (draft: QuestionDraft) => {
    if (editorMode === 'create') {
      // Owner and tenant stamp are assigned SERVER-side from the caller's
      // verified claims; anything sent from here would be ignored.
      const { id } = await createQuestionAsRole(
        draft as Omit<Question, 'id' | 'isDeleted' | 'createdAt' | 'updatedAt'>,
      );
      const saved = {
        ...draft,
        id,
        ownerType: 'institute' as const,
        ownerId: instituteId,
        instituteId,
        isDeleted: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as Question;
      setQuestions((prev) => [saved, ...prev]);
    } else if (editTarget) {
      await editQuestionAsRole(editTarget.id, draft as Partial<Question>, {
        prevSubjectId: editTarget.subjectId ?? null,
        prevTopicId: editTarget.topicId ?? null,
      });
      const updated = { ...editTarget, ...draft, updatedAt: new Date().toISOString() } as Question;
      setQuestions((prev) => prev.map((q) => (q.id === editTarget.id ? updated : q)));
    }
    setEditorOpen(false);
    setEditTarget(null);
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteQuestionAsRole(deleteTarget.id, {
        subjectId: deleteTarget.subjectId ?? null,
        topicId: deleteTarget.topicId ?? null,
      });
      setQuestions((prev) => prev.filter((q) => q.id !== deleteTarget.id));
      setDeleteTarget(null);
    } finally {
      setDeleting(false);
    }
  };

  const openCreate = () => { setEditTarget(null); setEditorMode('create'); setEditorOpen(true); };
  const openEdit = (q: Question) => { setEditTarget(q); setEditorMode('edit'); setEditorOpen(true); };

  /** Own questions are editable. Faculty-authored ones are visible only. */
  const isMine = useCallback(
    (q: Question) => q.ownerType === 'institute' && q.ownerId === instituteId,
    [instituteId],
  );

  const visible = useMemo(() => filterQuestions(questions, filters), [questions, filters]);

  const meta = useCallback(
    (q: Question) =>
      isMine(q)
        ? { author: 'Mine', mine: true }
        : q.ownerType === 'faculty'
          ? { author: facultyNames[q.ownerId ?? ''] ?? 'Faculty', mine: false }
          : {},
    [isMine, facultyNames],
  );

  const actions = useCallback(
    (q: Question): RowAction[] =>
      isMine(q)
        ? [
            { label: 'Edit', icon: <Pencil size={14} strokeWidth={1.7} />, onSelect: () => openEdit(q) },
            {
              label: 'Delete',
              icon: <Trash2 size={14} strokeWidth={1.7} />,
              tone: 'danger',
              onSelect: () => setDeleteTarget(q),
            },
          ]
        : [],
    [isMine],
  );

  // Guards: redirect if signed out, or if permission was revoked mid-session.
  // Last thing before the return, so the hook count above never varies.
  if (!session) return <Navigate to="/institute/login" replace />;
  if (!canAdminCreateQuestions) return <Navigate to="/institute/dashboard" replace />;

  return (
    <PageShell>
      <PageHeader
        eyebrow={
          <>
            <span className="ef-eyebrow-dot" />
            Institute admin
          </>
        }
        title="Questions"
        subtitle={`Your institute's own pool — written here, visible only inside ${session.instituteName}, and never shared outside it.`}
        actions={
          <Button variant="primary" size="sm" onClick={openCreate}>
            <Plus size={12} strokeWidth={1.9} />
            Add question
          </Button>
        }
      />

      <div style={{ marginBottom: 26 }}>
        <StatRow>
          <StatTile
            label="Questions"
            value={loading ? '—' : questions.length}
            icon={<BookOpen size={13} strokeWidth={1.7} />}
            sub={loading ? 'loading' : `${questions.filter(isMine).length} written by you`}
            hint="Everything authored inside this institute — yours and your faculty's."
          />
          <StatTile
            label="Subjects"
            value={loading ? '—' : subjects.length}
            icon={<Layers size={13} strokeWidth={1.7} />}
            sub="available to tag with"
            hint="The shared subject list. Your platform administrator maintains it."
          />
        </StatRow>
      </div>

      <Tabs
        items={[
          { key: 'pool', label: 'Question pool', count: loading ? undefined : questions.length },
          { key: 'subjects', label: 'Subjects', count: loading ? undefined : subjects.length },
        ]}
        active={tab}
        onChange={(k) => setTab(k as Tab)}
        label="Question bank sections"
      />

      <div style={{ marginTop: 'var(--ef-gap)' }}>
        {tab === 'pool' ? (
          <>
            <QuestionPool
              questions={visible}
              loading={loading}
              filters={filters}
              onFilters={setFilters}
              meta={meta}
              actions={actions}
              onPreview={setPreviewQ}
              onAdd={openCreate}
              emptyBody="Write one, or bring a spreadsheet of them in with Bulk upload. Everything here stays inside your institute."
              toolbarEnd={
                <>
                  <Button size="sm" onClick={() => setExportOpen(true)}>
                    <Download size={12} strokeWidth={1.7} />
                    Export
                  </Button>
                  <Button size="sm" onClick={() => setBulkUploadOpen(true)}>
                    <Upload size={12} strokeWidth={1.7} />
                    Bulk upload
                  </Button>
                </>
              }
            />
            {!loading && visible.length > 0 && (
              <p className="ef-t-xs ef-muted" style={{ marginTop: 12 }}>
                {isFiltered(filters)
                  ? `Showing ${visible.length} of ${questions.length}.`
                  : `${questions.length} question${questions.length === 1 ? '' : 's'}.`}
              </p>
            )}
          </>
        ) : (
          <SubjectManager canMaintain={false} onSubjectsChange={setSubjects} />
        )}
      </div>

      <EditorSheet
        open={editorOpen}
        mode={editorMode}
        onClose={() => { setEditorOpen(false); setEditTarget(null); }}
      >
        <QuestionTypeEngine
          initialData={editTarget ?? undefined}
          ownerType="institute"
          ownerId={instituteId}
          instituteId={instituteId}
          onSave={handleSave}
          onCancel={() => { setEditorOpen(false); setEditTarget(null); }}
        />
      </EditorSheet>

      <PreviewSheet question={previewQ} onClose={() => setPreviewQ(null)} />

      <DeleteQuestionSheet
        question={deleteTarget}
        busy={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
        consequence="This removes the question from your pool. Assessments that already contain it keep the copy they were built with."
      />

      {bulkUploadOpen && (
        <BulkUploadModal
          onClose={() => setBulkUploadOpen(false)}
          onComplete={() => { setBulkUploadOpen(false); fetchAll(true); }}
          ownerType="institute"
          ownerId={instituteId}
          instituteId={instituteId}
        />
      )}

      {exportOpen && (
        <ExportModal questions={questions} subjects={subjects} onClose={() => setExportOpen(false)} />
      )}
    </PageShell>
  );
}
