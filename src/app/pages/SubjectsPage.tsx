import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, Loader2, FolderTree, Trash2, ArrowRightLeft, Pencil, BookOpen, Layers, ChevronRight, ArrowLeft, Merge, RefreshCw } from 'lucide-react';
import {
  getAllSubjects,
  getAllTopics,
  createSubjectWithSlug,
  createTopicWithSlug,
  deleteSubject,
  deleteTopic,
  moveTopic,
  mergeTopics,
  refreshAllTopicCounts,
  updateSubject,
  updateTopic,
  isValidSlugId,
  SLUG_ID_REGEX,
  type Subject,
  type Topic,
} from '../../lib/subjectService';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { QuestionBankCore } from '../components/questions/QuestionBankCore';

// ──────────────────────────────────────────────────────────────────
// SubjectsPage — master → detail drill-in. The list shows subject
// cards; clicking one slides into a detail view where its topics live.
// IDs are user-typed slugs: 1–4 letters + '-' + 1–4 digits.
// Mobile-first (works at 320px).
// ──────────────────────────────────────────────────────────────────

export function SubjectsPage() {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [loadingSubjects, setLoadingSubjects] = useState(true);

  const [topics, setTopics] = useState<Topic[]>([]);
  const [loadingTopics, setLoadingTopics] = useState(true);

  const [showSubjectForm, setShowSubjectForm] = useState(false);
  const [selectedSubjectId, setSelectedSubjectId] = useState<string | null>(null);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [recounting, setRecounting] = useState(false);

  const refreshSubjects = useCallback(async () => {
    setLoadingSubjects(true);
    try {
      setSubjects(await getAllSubjects());
    } finally {
      setLoadingSubjects(false);
    }
  }, []);

  const refreshTopics = useCallback(async () => {
    setLoadingTopics(true);
    try {
      setTopics(await getAllTopics());
    } finally {
      setLoadingTopics(false);
    }
  }, []);

  useEffect(() => { refreshSubjects(); refreshTopics(); }, [refreshSubjects, refreshTopics]);

  const recountTopics = useCallback(async () => {
    setRecounting(true);
    try {
      await refreshAllTopicCounts();
      await refreshTopics();
    } catch (e: any) {
      alert(e.message ?? String(e));
    } finally {
      setRecounting(false);
    }
  }, [refreshTopics]);

  // Topics grouped by their subject for the detail view.
  const topicsBySubject = useMemo(() => {
    const m: Record<string, Topic[]> = {};
    topics.forEach((t) => { (m[t.subjectId] ??= []).push(t); });
    return m;
  }, [topics]);

  const topicCountBySubject = useMemo(() => {
    const m: Record<string, number> = {};
    topics.forEach((t) => { m[t.subjectId] = (m[t.subjectId] ?? 0) + 1; });
    return m;
  }, [topics]);

  const selectedSubject = selectedSubjectId
    ? subjects.find((s) => s.id === selectedSubjectId) ?? null
    : null;
  const selectedTopic = selectedTopicId
    ? topics.find((t) => t.id === selectedTopicId) ?? null
    : null;

  return (
    <div className="px-4 py-6 md:px-10 md:py-8" style={{ maxWidth: 1280, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10 }}>
        <FolderTree size={18} strokeWidth={1.5} />
        <h1 style={{ margin: 0 }}>Subjects</h1>
      </div>

      <div style={{ background: 'var(--ef-surface)', border: '1px solid #E8E7E1', borderRadius: 4, overflow: 'hidden' }}>
        {selectedSubject && selectedTopic ? (
          <TopicQuestionsView
            key={selectedTopic.id}
            subject={selectedSubject}
            topic={selectedTopic}
            onBack={() => setSelectedTopicId(null)}
            onChanged={async () => { await refreshTopics(); await refreshSubjects(); }}
          />
        ) : selectedSubject ? (
          <SubjectDetail
            key={selectedSubject.id}
            subject={selectedSubject}
            topics={topicsBySubject[selectedSubject.id] ?? []}
            allSubjects={subjects}
            topicsLoading={loadingTopics}
            onBack={() => { setSelectedSubjectId(null); setSelectedTopicId(null); }}
            onOpenTopic={(id) => setSelectedTopicId(id)}
            onRenamed={(newId) => { setSelectedSubjectId(newId); refreshSubjects(); refreshTopics(); }}
            onDeleted={() => { setSelectedSubjectId(null); setSelectedTopicId(null); refreshSubjects(); refreshTopics(); }}
            onTopicsChanged={async () => { await refreshTopics(); await refreshSubjects(); }}
          />
        ) : (
          <>
            <div style={{ padding: 14, borderBottom: '1px solid #E8E7E1', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, letterSpacing: '0.04em', color: 'var(--ef-text-muted)' }}>
                ALL SUBJECTS
                {topics.length > 0 && <span style={{ color: 'var(--ef-text-muted)' }}> · {topics.length} topics</span>}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={recountTopics}
                  disabled={recounting}
                  title="Recalculate question counts for all topics"
                  style={{ height: 28, padding: '0 10px', fontSize: 12 }}
                >
                  {recounting
                    ? <Loader2 size={12} className="animate-spin" />
                    : <RefreshCw size={12} strokeWidth={1.5} />}
                  Recount
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShowSubjectForm((v) => !v)}
                  style={{ height: 28, padding: '0 12px', fontSize: 12 }}
                >
                  <Plus size={12} strokeWidth={1.5} /> New Subject
                </Button>
              </div>
            </div>

            {showSubjectForm && (
              <NewSubjectForm
                onCreated={async () => {
                  setShowSubjectForm(false);
                  await refreshSubjects();
                }}
                onCancel={() => setShowSubjectForm(false)}
              />
            )}

            {loadingSubjects ? (
              <div style={{ padding: 24, textAlign: 'center', color: '#83827C' }}>
                <Loader2 size={16} className="animate-spin" />
              </div>
            ) : subjects.length === 0 ? (
              <EmptyHint text="No subjects yet. Click + New Subject to create one." />
            ) : (
              <div className="flex flex-col gap-3 p-3 sm:p-4">
                {subjects.map((s) => (
                  <SubjectCard
                    key={s.id}
                    subject={s}
                    topicCount={topicCountBySubject[s.id] ?? 0}
                    onOpen={() => { setSelectedSubjectId(s.id); setSelectedTopicId(null); }}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default SubjectsPage;

// ── Sub-components ────────────────────────────────────────────────

function SlugChip({ id }: { id: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        background: 'var(--ef-ink)',
        color: 'var(--ef-surface)',
        fontSize: 10,
        padding: '2px 6px',
        borderRadius: 2,
        letterSpacing: '0.04em',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        whiteSpace: 'nowrap',
      }}
    >
      {id}
    </span>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div style={{ padding: 24, textAlign: 'center', color: '#83827C', fontSize: 13 }}>
      {text}
    </div>
  );
}

function NewSubjectForm({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const idValid = isValidSlugId(id);

  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      await createSubjectWithSlug(id.trim(), name);
      setId(''); setName('');
      onCreated();
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: 14, borderBottom: '1px solid #E8E7E1', background: '#FAFAF7' }}>
      <div className="flex flex-col sm:flex-row" style={{ gap: 8, marginBottom: 8 }}>
        <Input
          placeholder="ID e.g. math-0001"
          value={id}
          onChange={(e) => setId(e.target.value.toLowerCase())}
          style={{ width: '100%', maxWidth: 200, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
          disabled={busy}
        />
        <Input
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
        />
      </div>
      <div style={{ fontSize: 11, color: idValid || id === '' ? '#83827C' : '#B91C1C', marginBottom: 8 }}>
        Format: {SLUG_ID_REGEX.toString().slice(1, -1)} — e.g. <code>math-0001</code>
      </div>
      {err && <div style={{ fontSize: 12, color: '#B91C1C', marginBottom: 8 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button size="sm" onClick={submit} disabled={busy || !idValid || !name.trim()}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : 'Create'}
        </Button>
      </div>
    </div>
  );
}

// List item — clicking drills into the subject's detail view.
function SubjectCard({
  subject, topicCount, onOpen,
}: {
  subject: Subject;
  topicCount: number;
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      className="flex flex-col gap-3 p-4 text-left w-full cursor-pointer transition-colors hover:bg-[var(--ef-canvas-raised)]"
      style={{
        background: 'var(--ef-surface)',
        border: '1px solid #E8E7E1',
        borderRadius: 3,
        touchAction: 'manipulation',
      }}
    >
      {/* Header: slug + drill affordance */}
      <div className="flex items-center justify-between gap-2">
        <SlugChip id={subject.id} />
        <ChevronRight size={16} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
      </div>

      {/* Name */}
      <p className="break-words" style={{ color: 'var(--ef-ink)', fontSize: 14, lineHeight: 1.4 }}>
        {subject.name}
      </p>

      {/* Stats footer */}
      <div className="flex items-center gap-4 pt-3" style={{ borderTop: '1px solid #F2F1EC' }}>
        <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--ef-text-muted)' }}>
          <BookOpen size={11} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
          <span style={{ fontSize: 12 }}>{subject.questionCount}</span>
          <span style={{ fontSize: 11, color: 'var(--ef-text-muted)' }}>questions</span>
        </span>
        <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--ef-text-muted)' }}>
          <Layers size={11} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
          <span style={{ fontSize: 12 }}>{topicCount}</span>
          <span style={{ fontSize: 11, color: 'var(--ef-text-muted)' }}>topics</span>
        </span>
      </div>
    </button>
  );
}

// Detail view — slides in; the subject's topics are managed here.
function SubjectDetail({
  subject, topics, allSubjects, topicsLoading, onBack, onOpenTopic, onRenamed, onDeleted, onTopicsChanged,
}: {
  subject: Subject;
  topics: Topic[];
  allSubjects: Subject[];
  topicsLoading: boolean;
  onBack: () => void;
  onOpenTopic: (topicId: string) => void;
  onRenamed: (newId: string) => void;
  onDeleted: () => void;
  onTopicsChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [addingTopic, setAddingTopic] = useState(false);

  return (
    <div className="animate-in fade-in slide-in-from-right-4 duration-200">
      {/* Back bar */}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid #E8E7E1' }}>
        <button
          onClick={onBack}
          aria-label="Back to all subjects"
          className="inline-flex items-center gap-1.5 rounded-sm transition-colors min-h-[44px] sm:min-h-[32px] px-2 -ml-2 hover:bg-[#F2F1EC]"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--ef-text-muted)', fontSize: 12, touchAction: 'manipulation' }}
        >
          <ArrowLeft size={14} strokeWidth={1.5} /> All subjects
        </button>
      </div>

      {/* Subject header */}
      {editing ? (
        <EditSlugForm
          initialId={subject.id}
          initialName={subject.name}
          onSave={async (newId, newName) => {
            await updateSubject(subject.id, newId, newName);
            setEditing(false);
            onRenamed(newId);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <div style={{ padding: 16, borderBottom: '1px solid #E8E7E1' }}>
          <div className="flex items-start justify-between gap-2" style={{ marginBottom: 10 }}>
            <SlugChip id={subject.id} />
            <div className="flex items-center gap-1 flex-shrink-0 -mt-2 -mr-2 sm:-mt-1 sm:-mr-1">
              <IconBtn title="Edit subject" onClick={() => setEditing(true)}>
                <Pencil size={13} strokeWidth={1.5} />
              </IconBtn>
              <IconBtn
                title="Delete subject"
                onClick={async () => {
                  if (!confirm(`Delete subject "${subject.name}" (${subject.id})?`)) return;
                  try {
                    await deleteSubject(subject.id);
                    onDeleted();
                  } catch (e: any) {
                    alert(e.message ?? String(e));
                  }
                }}
              >
                <Trash2 size={13} strokeWidth={1.5} />
              </IconBtn>
            </div>
          </div>
          <p className="break-words" style={{ color: 'var(--ef-ink)', fontSize: 16, lineHeight: 1.3, marginBottom: 10 }}>
            {subject.name}
          </p>
          <div className="flex items-center gap-4">
            <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--ef-text-muted)' }}>
              <BookOpen size={11} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
              <span style={{ fontSize: 12 }}>{subject.questionCount}</span>
              <span style={{ fontSize: 11, color: 'var(--ef-text-muted)' }}>questions</span>
            </span>
            <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--ef-text-muted)' }}>
              <Layers size={11} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
              <span style={{ fontSize: 12 }}>{topics.length}</span>
              <span style={{ fontSize: 11, color: 'var(--ef-text-muted)' }}>topics</span>
            </span>
          </div>
        </div>
      )}

      {/* Topics list */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 14px', borderBottom: '1px solid #F2F1EC' }}>
        <span style={{ fontSize: 12, letterSpacing: '0.04em', color: 'var(--ef-text-muted)' }}>TOPICS</span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setAddingTopic((v) => !v)}
          style={{ height: 28, padding: '0 12px', fontSize: 12 }}
        >
          <Plus size={12} strokeWidth={1.5} /> New Topic
        </Button>
      </div>

      {addingTopic && (
        <NewTopicForm
          fixedSubjectId={subject.id}
          subjects={allSubjects}
          onCreated={async () => { setAddingTopic(false); onTopicsChanged(); }}
          onCancel={() => setAddingTopic(false)}
        />
      )}

      {topicsLoading ? (
        <div style={{ padding: 20, textAlign: 'center', color: '#83827C' }}>
          <Loader2 size={14} className="animate-spin" />
        </div>
      ) : topics.length === 0 ? (
        <EmptyHint text="No topics in this subject yet. Click + New Topic to create one." />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 p-3 sm:p-4">
          {topics.map((t) => (
            <TopicCard
              key={t.id}
              topic={t}
              subjects={allSubjects}
              siblingTopics={topics}
              onOpen={() => onOpenTopic(t.id)}
              onChanged={onTopicsChanged}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TopicCard({
  topic, subjects, siblingTopics, onOpen, onChanged,
}: {
  topic: Topic;
  subjects: Subject[];
  siblingTopics: Topic[];
  onOpen: () => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <div style={{ background: '#FAFAF7', border: '1px solid #E8E7E1', borderRadius: 3 }}>
        <EditSlugForm
          initialId={topic.id}
          initialName={topic.name}
          onSave={async (newId, newName) => {
            await updateTopic(topic.id, newId, newName);
            setEditing(false);
            onChanged();
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div
      className="flex flex-col"
      style={{ background: 'var(--ef-surface)', border: '1px solid #E8E7E1', borderRadius: 3 }}
    >
      {/* Clickable region → drill into this topic's questions */}
      <button
        onClick={onOpen}
        className="flex flex-col gap-3 p-4 text-left w-full cursor-pointer transition-colors hover:bg-[var(--ef-canvas-raised)]"
        style={{ background: 'transparent', border: 'none', touchAction: 'manipulation', borderRadius: '3px 3px 0 0' }}
      >
        <div className="flex items-center justify-between gap-2">
          <SlugChip id={topic.id} />
          <ChevronRight size={16} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
        </div>
        <p className="break-words" style={{ color: 'var(--ef-ink)', fontSize: 14, lineHeight: 1.4 }}>
          {topic.name}
        </p>
        <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--ef-text-muted)' }}>
          <BookOpen size={11} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
          <span style={{ fontSize: 12 }}>{topic.questionCount}</span>
          <span style={{ fontSize: 11, color: 'var(--ef-text-muted)' }}>questions</span>
        </span>
      </button>

      {/* Action bar */}
      <div
        className="flex flex-wrap items-center gap-1 px-2 py-1.5"
        style={{ borderTop: '1px solid #F2F1EC' }}
      >
        <MergeTopicControl topic={topic} siblingTopics={siblingTopics} onMerged={onChanged} />
        <MoveTopicControl topic={topic} subjects={subjects} onMoved={onChanged} />
        <IconBtn title="Edit topic" onClick={() => setEditing(true)}>
          <Pencil size={13} strokeWidth={1.5} />
        </IconBtn>
        <IconBtn
          title="Delete topic"
          onClick={async () => {
            if (!confirm(`Delete topic "${topic.name}" (${topic.id})?`)) return;
            await deleteTopic(topic.id);
            onChanged();
          }}
        >
          <Trash2 size={13} strokeWidth={1.5} />
        </IconBtn>
      </div>
    </div>
  );
}

// Third drill level — questions inside one topic (shared QuestionBankCore, locked).
function TopicQuestionsView({
  subject, topic, onBack, onChanged,
}: {
  subject: Subject;
  topic: Topic;
  onBack: () => void;
  onChanged: () => void;
}) {
  return (
    <div className="animate-in fade-in slide-in-from-right-4 duration-200">
      {/* Back bar */}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid #E8E7E1' }}>
        <button
          onClick={onBack}
          aria-label={`Back to ${subject.name} topics`}
          className="inline-flex items-center gap-1.5 rounded-sm transition-colors min-h-[44px] sm:min-h-[32px] px-2 -ml-2 hover:bg-[#F2F1EC]"
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--ef-text-muted)', fontSize: 12, touchAction: 'manipulation' }}
        >
          <ArrowLeft size={14} strokeWidth={1.5} /> {subject.name} · topics
        </button>
      </div>

      {/* Topic header */}
      <div style={{ padding: 16, borderBottom: '1px solid #E8E7E1' }}>
        <div className="flex items-center gap-2" style={{ marginBottom: 8 }}>
          <SlugChip id={topic.id} />
          <span style={{ fontSize: 11, color: 'var(--ef-text-muted)' }}>in {subject.name}</span>
        </div>
        <p className="break-words" style={{ color: 'var(--ef-ink)', fontSize: 16, lineHeight: 1.3 }}>{topic.name}</p>
      </div>

      {/* Shared question bank, scoped to this topic */}
      <QuestionBankCore
        lockSubjectId={subject.id}
        lockTopicId={topic.id}
        showAddButton
        onChanged={onChanged}
      />
    </div>
  );
}

function IconBtn({
  title, onClick, disabled, children,
}: { title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={title}
      title={title}
      // Touch-friendly: ≥44px tap target on mobile (pointer: coarse), compact on desktop.
      className="inline-flex items-center justify-center rounded-sm transition-colors min-h-[44px] min-w-[44px] sm:min-h-[30px] sm:min-w-[30px] hover:bg-[#F2F1EC] disabled:opacity-40 disabled:cursor-not-allowed"
      style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#83827C', touchAction: 'manipulation' }}
    >
      {children}
    </button>
  );
}

function EditSlugForm({
  initialId, initialName, onSave, onCancel,
}: {
  initialId: string;
  initialName: string;
  onSave: (newId: string, newName: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [id, setId] = useState(initialId);
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const idValid = isValidSlugId(id);

  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      await onSave(id.trim(), name);
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: 12, borderBottom: '1px solid #E8E7E1', background: '#FAFAF7' }}>
      <div className="flex flex-col sm:flex-row" style={{ gap: 8, marginBottom: 8 }}>
        <Input
          value={id}
          onChange={(e) => setId(e.target.value.toLowerCase())}
          style={{ width: '100%', maxWidth: 200, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
          disabled={busy}
        />
        <Input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
      </div>
      <div style={{ fontSize: 11, color: idValid ? '#83827C' : '#B91C1C', marginBottom: 8 }}>
        Format: {SLUG_ID_REGEX.toString().slice(1, -1)}
      </div>
      {err && <div style={{ fontSize: 12, color: '#B91C1C', marginBottom: 8 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button size="sm" onClick={submit} disabled={busy || !idValid || !name.trim()}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : 'Save'}
        </Button>
      </div>
    </div>
  );
}

function MoveTopicControl({
  topic, subjects, onMoved,
}: { topic: Topic; subjects: Subject[]; onMoved: () => void }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const candidates = subjects.filter((s) => s.id !== topic.subjectId);

  const submit = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const res = await moveTopic(topic.id, target);
      alert(`Moved. ${res.updatedQuestions} question(s) reassigned.`);
      setOpen(false);
      setTarget('');
      onMoved();
    } catch (e: any) {
      alert(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <IconBtn
        title="Move topic to another subject"
        onClick={() => setOpen(true)}
        disabled={candidates.length === 0}
      >
        <ArrowRightLeft size={13} strokeWidth={1.5} />
      </IconBtn>
    );
  }

  // Open state spans the full row width so the select + buttons never overflow at 320px.
  return (
    <div className="flex flex-wrap items-center gap-2 w-full mt-1">
      <select
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        disabled={busy}
        className="min-w-0"
        style={{ flex: 1, fontSize: 12, padding: '6px 8px', border: '1px solid #E8E7E1', borderRadius: 2, background: 'var(--ef-surface)', color: 'var(--ef-ink)' }}
      >
        <option value="">→ move to subject…</option>
        {candidates.map((s) => (
          <option key={s.id} value={s.id}>{s.id} · {s.name}</option>
        ))}
      </select>
      <Button size="sm" onClick={submit} disabled={busy || !target} style={{ height: 30, padding: '0 10px', fontSize: 12 }}>
        {busy ? <Loader2 size={11} className="animate-spin" /> : 'Move'}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setTarget(''); }} disabled={busy} style={{ height: 30, padding: '0 10px', fontSize: 12 }}>
        Cancel
      </Button>
    </div>
  );
}

function MergeTopicControl({
  topic, siblingTopics, onMerged,
}: { topic: Topic; siblingTopics: Topic[]; onMerged: () => void }) {
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  // Can only merge into another topic in the same subject.
  const candidates = siblingTopics.filter((t) => t.id !== topic.id);

  const submit = async () => {
    if (!target) return;
    const targetTopic = candidates.find((t) => t.id === target);
    if (!confirm(
      `Merge "${topic.name}" (${topic.id}) into "${targetTopic?.name}" (${target})?\n\n` +
      `All questions tagged "${topic.id}" will be re-pointed to "${target}", and "${topic.id}" will be deleted. This can't be undone.`
    )) return;
    setBusy(true);
    try {
      const res = await mergeTopics(topic.id, target);
      alert(`Merged. ${res.updatedQuestions} question(s) re-pointed to "${target}".`);
      setOpen(false);
      setTarget('');
      onMerged();
    } catch (e: any) {
      alert(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <IconBtn
        title="Merge this topic into another"
        onClick={() => setOpen(true)}
        disabled={candidates.length === 0}
      >
        <Merge size={13} strokeWidth={1.5} />
      </IconBtn>
    );
  }

  // Open state spans the full row width so the select + buttons never overflow at 320px.
  return (
    <div className="flex flex-wrap items-center gap-2 w-full mt-1">
      <select
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        disabled={busy}
        className="min-w-0"
        style={{ flex: 1, fontSize: 12, padding: '6px 8px', border: '1px solid #E8E7E1', borderRadius: 2, background: 'var(--ef-surface)', color: 'var(--ef-ink)' }}
      >
        <option value="">⤵ merge into topic…</option>
        {candidates.map((t) => (
          <option key={t.id} value={t.id}>{t.id} · {t.name}</option>
        ))}
      </select>
      <Button size="sm" onClick={submit} disabled={busy || !target} style={{ height: 30, padding: '0 10px', fontSize: 12 }}>
        {busy ? <Loader2 size={11} className="animate-spin" /> : 'Merge'}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setTarget(''); }} disabled={busy} style={{ height: 30, padding: '0 10px', fontSize: 12 }}>
        Cancel
      </Button>
    </div>
  );
}

function NewTopicForm({
  subjects, fixedSubjectId, onCreated, onCancel,
}: {
  subjects: Subject[];
  fixedSubjectId?: string;       // when set, form is scoped to one subject (no picker)
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [subjectId, setSubjectId] = useState(fixedSubjectId ?? '');
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const idValid = isValidSlugId(id);

  const submit = async () => {
    if (!subjectId) { setErr('Pick a subject.'); return; }
    setErr(null);
    setBusy(true);
    try {
      await createTopicWithSlug(id.trim(), name, subjectId);
      setId(''); setName('');
      onCreated();
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ padding: 14, borderBottom: '1px solid #F2F1EC', background: '#FAFAF7' }}>
      {/* Subject selector — only when not scoped to a specific subject */}
      {!fixedSubjectId && (
        <div style={{ marginBottom: 8 }}>
          <label style={{ fontSize: 11, color: 'var(--ef-text-muted)', display: 'block', marginBottom: 4 }}>
            Subject <span style={{ color: '#B91C1C' }}>*</span>
          </label>
          <select
            value={subjectId}
            onChange={(e) => setSubjectId(e.target.value)}
            disabled={busy}
            style={{
              width: '100%', maxWidth: 320, fontSize: 12, padding: '6px 8px',
              border: `1px solid ${!subjectId ? 'var(--ef-danger-border)' : 'var(--ef-border)'}`, borderRadius: 2, background: 'var(--ef-surface)', color: 'var(--ef-ink)',
            }}
          >
            <option value="">— pick a subject —</option>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>{s.name} ({s.id})</option>
            ))}
          </select>
        </div>
      )}

      <div className="flex flex-col sm:flex-row" style={{ gap: 8, marginBottom: 8 }}>
        <Input
          placeholder="ID e.g. prob-0001"
          value={id}
          onChange={(e) => setId(e.target.value.toLowerCase())}
          style={{ width: '100%', maxWidth: 200, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
          disabled={busy}
        />
        <Input
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
        />
      </div>
      <div style={{ fontSize: 11, color: idValid || id === '' ? '#83827C' : '#B91C1C', marginBottom: 8 }}>
        Format: {SLUG_ID_REGEX.toString().slice(1, -1)} — e.g. <code>prob-0001</code>
      </div>
      {err && <div style={{ fontSize: 12, color: '#B91C1C', marginBottom: 8 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button size="sm" onClick={submit} disabled={busy || !subjectId || !idValid || !name.trim()}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : 'Create'}
        </Button>
      </div>
    </div>
  );
}
