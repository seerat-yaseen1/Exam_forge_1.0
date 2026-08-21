/**
 * A faculty member's own question pool.
 *
 * The list, the filters and the three dialogs are shared with the institute
 * console — see components/questions/QuestionPool. What is genuinely faculty
 * about this page is the permission model, and it is the interesting part:
 *
 * ── DIRECT, REQUEST, OR NEITHER ───────────────────────────────────
 * Each right (create, edit, delete, share) resolves to one of three modes
 * from the institute's ceiling intersected with this person's grants. Direct
 * acts immediately; request routes the identical payload to the institute
 * admin for approval; none hides the control.
 *
 * The old page expressed that difference only in what happened AFTER you
 * pressed the button — a toast saying "Edit request submitted for approval"
 * where you expected a saved question. Nothing beforehand said your account
 * worked that way. It now says so once, above the pool, and again on every
 * button and confirmation that behaves differently because of it: "Send for
 * approval" rather than "Save", and a delete dialog that does not claim to
 * delete anything.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Navigate } from 'react-router';
import {
  BookOpen, Download, Layers, Pencil, Plus, Share2, ShieldCheck, Trash2, Upload,
} from 'lucide-react';
import {
  getQuestionsByOwner,
  createQuestionAsRole, editQuestionAsRole, deleteQuestionAsRole,
  type Question,
} from '../../../lib/questionBankService';
import {
  getFaculty, getInstitute,
  type FacultyQuestionRights, type QuestionRightsCeiling,
} from '../../../lib/firebaseService';
import { effectiveFacultyMode } from '../../../lib/questionRights';
import { submitQuestionRequest } from '../../../lib/questionRequestService';
import { getAllSubjects, type Subject } from '../../../lib/subjectService';
import { QuestionTypeEngine, type QuestionDraft } from '../../components/questions/QuestionTypeEngine';
import { ShareQuestionsModal } from '../../components/questions/ShareQuestionsModal';
import { SubjectManager } from '../../components/questions/SubjectManager';
import { MyRequestsList } from '../../components/questions/MyRequestsList';
import { BulkUploadModal } from '../../components/questions/BulkUploadModal';
import { ExportModal } from '../../components/questions/ExportModal';
import {
  DeleteQuestionSheet, EditorSheet, PreviewSheet, QuestionPool,
  filterQuestions, isFiltered, usePoolFilters,
} from '../../components/questions/QuestionPool';
import { useFacultyAuth } from '../../context/FacultyAuthContext';
import {
  Button, PageHeader, PageShell, StatRow, StatTile, Toast,
} from '../../components/console/ui';
import { Tabs, type RowAction } from '../../components/console/data';

type Tab = 'pool' | 'subjects' | 'requests';

export function FacultyQuestionsPage() {
  const { session } = useFacultyAuth();

  if (!session) return <Navigate to="/faculty/login" replace />;

  const facultyId = session.facultyId;
  const instituteId = session.instituteId;

  // Effective question rights (permission-model Phase 2): institute ceiling
  // ∩ this faculty's grants. Fetched alongside questions; undefined until
  // loaded (controls stay hidden while unknown — fail closed).
  const [ceiling, setCeiling] = useState<QuestionRightsCeiling | undefined>(undefined);
  const [myRights, setMyRights] = useState<FacultyQuestionRights | undefined>(undefined);

  const createMode = effectiveFacultyMode({ questionRights: myRights }, ceiling, 'create');
  const editMode = effectiveFacultyMode({ questionRights: myRights }, ceiling, 'edit');
  const deleteMode = effectiveFacultyMode({ questionRights: myRights }, ceiling, 'delete');
  const shareMode = effectiveFacultyMode({ questionRights: myRights }, ceiling, 'share');

  const canCreate = createMode !== 'none';
  const canEdit = editMode !== 'none';
  const canDelete = deleteMode !== 'none';
  const canShare = shareMode !== 'none';

  const createIsRequest = createMode === 'request';
  const editIsRequest = editMode === 'request';
  const deleteIsRequest = deleteMode === 'request';
  const shareIsRequest = shareMode === 'request';
  // Any right in request mode ⇒ show the "My requests" tab, and say so.
  const anyRequestMode = createIsRequest || editIsRequest || deleteIsRequest || shareIsRequest;

  const [questions, setQuestions] = useState<Question[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [loading, setLoading] = useState(true);

  const [tab, setTab] = useState<Tab>('pool');
  const [filters, setFilters] = usePoolFilters();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorMode, setEditorMode] = useState<'create' | 'edit'>('create');
  const [editTarget, setEditTarget] = useState<Question | null>(null);
  const [previewQ, setPreviewQ] = useState<Question | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Question | null>(null);
  const [shareTarget, setShareTarget] = useState<Question | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [bulkUploadOpen, setBulkUploadOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 4500);
    return () => clearTimeout(t);
  }, [notice]);

  const fetchAll = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [qs, subjs, fac, inst] = await Promise.all([
        getQuestionsByOwner('faculty', facultyId),
        getAllSubjects(),
        getFaculty(facultyId),
        getInstitute(instituteId),
      ]);
      setQuestions(qs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      setSubjects(subjs);
      setMyRights(fac?.questionRights);
      setCeiling(inst?.questionRightsCeiling);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [facultyId, instituteId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Direct mode executes immediately via the callable; request mode routes
  // the same payload to submitQuestionRequest for institute-admin approval.
  // The RIGHT + mode are re-enforced server-side either way.
  const handleSave = async (draft: QuestionDraft) => {
    if (editorMode === 'create') {
      if (createIsRequest) {
        await submitQuestionRequest({
          type: 'create',
          question: draft as Record<string, unknown>,
          questionStem: (draft as { stem?: string }).stem ?? '',
          subjectId: (draft as { subjectId?: string }).subjectId ?? null,
          topicId: (draft as { topicId?: string }).topicId ?? null,
        });
        setEditorOpen(false);
        setEditTarget(null);
        setNotice('Sent to your institute admin. It appears in My requests.');
        return;
      }
      const { id } = await createQuestionAsRole(
        draft as Omit<Question, 'id' | 'isDeleted' | 'createdAt' | 'updatedAt'>,
      );
      const nowIso = new Date().toISOString();
      const saved = {
        ...draft, id, ownerType: 'faculty', ownerId: facultyId, instituteId,
        isDeleted: false, createdAt: nowIso, updatedAt: nowIso,
      } as Question;
      setQuestions((prev) => [saved, ...prev]);
    } else if (editTarget) {
      if (editIsRequest) {
        await submitQuestionRequest({
          type: 'edit',
          questionId: editTarget.id,
          questionStem: editTarget.stem ?? '',
          question: draft as Record<string, unknown>,
          subjectId: (draft as { subjectId?: string }).subjectId ?? null,
          topicId: (draft as { topicId?: string }).topicId ?? null,
          prevSubjectId: editTarget.subjectId ?? null,
          prevTopicId: editTarget.topicId ?? null,
        });
        setEditorOpen(false);
        setEditTarget(null);
        setNotice('Sent to your institute admin. It appears in My requests.');
        return;
      }
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
      if (deleteIsRequest) {
        await submitQuestionRequest({
          type: 'delete',
          questionId: deleteTarget.id,
          questionStem: deleteTarget.stem ?? '',
          subjectId: deleteTarget.subjectId ?? null,
          topicId: deleteTarget.topicId ?? null,
        });
        setDeleteTarget(null);
        setNotice('Sent to your institute admin. It appears in My requests.');
        return;
      }
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

  const visible = useMemo(() => filterQuestions(questions, filters), [questions, filters]);

  const actions = useCallback(
    (q: Question): RowAction[] => {
      const list: RowAction[] = [];
      if (canEdit) {
        list.push({
          label: editIsRequest ? 'Suggest an edit' : 'Edit',
          icon: <Pencil size={14} strokeWidth={1.7} />,
          onSelect: () => openEdit(q),
        });
      }
      if (canShare) {
        list.push({
          label: shareIsRequest ? 'Ask to share' : 'Share',
          icon: <Share2 size={14} strokeWidth={1.7} />,
          onSelect: () => setShareTarget(q),
        });
      }
      if (canDelete) {
        list.push({
          label: deleteIsRequest ? 'Ask to delete' : 'Delete',
          icon: <Trash2 size={14} strokeWidth={1.7} />,
          tone: deleteIsRequest ? 'default' : 'danger',
          onSelect: () => setDeleteTarget(q),
        });
      }
      return list;
    },
    [canEdit, canShare, canDelete, editIsRequest, shareIsRequest, deleteIsRequest],
  );

  const tabs = [
    { key: 'pool', label: 'Question pool', count: loading ? undefined : questions.length },
    { key: 'subjects', label: 'Subjects', count: loading ? undefined : subjects.length },
    ...(anyRequestMode ? [{ key: 'requests', label: 'My requests' }] : []),
  ];

  return (
    <PageShell>
      <PageHeader
        eyebrow={
          <>
            <span className="ef-eyebrow-dot" />
            Faculty
          </>
        }
        title="Questions"
        subtitle="Your own pool. Nobody else sees these unless you share them."
        actions={
          canCreate && (
            <Button variant="primary" size="sm" onClick={openCreate}>
              <Plus size={12} strokeWidth={1.9} />
              {createIsRequest ? 'Propose a question' : 'Add question'}
            </Button>
          )
        }
      />

      {/* Said once, up front. The old page only revealed this after you had
          written a whole question and pressed Save. */}
      {anyRequestMode && (
        <div
          className="flex items-start gap-3"
          style={{
            padding: '12px 14px',
            marginBottom: 24,
            background: 'var(--ef-accent-soft)',
            border: '1px solid var(--ef-accent-border)',
            borderRadius: 'var(--ef-radius-sm)',
          }}
        >
          <ShieldCheck size={15} strokeWidth={1.7} style={{ color: 'var(--ef-accent)', flexShrink: 0, marginTop: 1 }} />
          <div>
            <p className="ef-t-sm ef-ink" style={{ fontWeight: 500 }}>
              Some of your changes go to your institute admin first
            </p>
            <p className="ef-t-xs ef-muted" style={{ marginTop: 3, lineHeight: 'var(--ef-leading-relaxed)' }}>
              {[
                createIsRequest && 'new questions',
                editIsRequest && 'edits',
                deleteIsRequest && 'deletions',
                shareIsRequest && 'sharing',
              ]
                .filter(Boolean)
                .join(', ')
                .replace(/, ([^,]*)$/, ' and $1')}
              {' need approval. Track them under My requests — nothing is lost while you wait.'}
            </p>
          </div>
        </div>
      )}

      <div style={{ marginBottom: 26 }}>
        <StatRow>
          <StatTile
            label="Questions"
            value={loading ? '—' : questions.length}
            icon={<BookOpen size={13} strokeWidth={1.7} />}
            sub="in your pool"
            hint="Everything you have written. Shared copies stay counted here."
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

      <Tabs items={tabs} active={tab} onChange={(k) => setTab(k as Tab)} label="Question bank sections" />

      <div style={{ marginTop: 'var(--ef-gap)' }}>
        {tab === 'pool' && (
          <>
            <QuestionPool
              questions={visible}
              loading={loading}
              filters={filters}
              onFilters={setFilters}
              actions={actions}
              onPreview={setPreviewQ}
              onAdd={canCreate ? openCreate : undefined}
              addLabel={createIsRequest ? 'Propose a question' : 'Add question'}
              emptyBody={
                canCreate
                  ? 'Write one, or bring a spreadsheet of them in with Bulk upload.'
                  : 'Your institute admin has not given you permission to create questions. Ask them if you need it.'
              }
              toolbarEnd={
                <>
                  <Button size="sm" onClick={() => setExportOpen(true)}>
                    <Download size={12} strokeWidth={1.7} />
                    Export
                  </Button>
                  {canCreate && (
                    <Button size="sm" onClick={() => setBulkUploadOpen(true)}>
                      <Upload size={12} strokeWidth={1.7} />
                      Bulk upload
                    </Button>
                  )}
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
        )}

        {tab === 'subjects' && <SubjectManager canMaintain={false} onSubjectsChange={setSubjects} />}

        {tab === 'requests' && <MyRequestsList facultyId={facultyId} />}
      </div>

      <EditorSheet
        open={editorOpen}
        mode={editorMode}
        onClose={() => { setEditorOpen(false); setEditTarget(null); }}
      >
        <QuestionTypeEngine
          initialData={editTarget ?? undefined}
          ownerType="faculty"
          ownerId={facultyId}
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
        confirmLabel={deleteIsRequest ? 'Send for approval' : 'Delete question'}
        consequence={
          deleteIsRequest
            ? 'Nothing is deleted yet. This asks your institute admin to remove it; the question stays in your pool until they decide.'
            : 'This removes the question from your pool. Assessments that already contain it keep the copy they were built with.'
        }
      />

      {bulkUploadOpen && (
        <BulkUploadModal
          onClose={() => setBulkUploadOpen(false)}
          onComplete={() => { setBulkUploadOpen(false); fetchAll(true); }}
          ownerType="faculty"
          ownerId={facultyId}
          instituteId={instituteId}
        />
      )}

      {exportOpen && (
        <ExportModal questions={questions} subjects={subjects} onClose={() => setExportOpen(false)} />
      )}

      {shareTarget && (
        <ShareQuestionsModal
          instituteId={instituteId}
          selfFacultyId={facultyId}
          questionIds={[shareTarget.id]}
          questionStem={shareTarget.stem ?? ''}
          isRequest={shareIsRequest}
          onClose={() => setShareTarget(null)}
          onShared={(count, wasRequest) => {
            setShareTarget(null);
            setNotice(
              wasRequest
                ? 'Sent to your institute admin. It appears in My requests.'
                : `Shared with ${count} recipient${count === 1 ? '' : 's'}.`,
            );
          }}
        />
      )}

      <Toast message={notice} />
    </PageShell>
  );
}
