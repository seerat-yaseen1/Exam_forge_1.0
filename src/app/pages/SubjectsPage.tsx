import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, Loader2, FolderTree, Hash, Trash2, ArrowRightLeft, Pencil, BookOpen, Layers } from 'lucide-react';
import {
  getAllSubjects,
  getAllTopics,
  createSubjectWithSlug,
  createTopicWithSlug,
  deleteSubject,
  deleteTopic,
  moveTopic,
  updateSubject,
  updateTopic,
  isValidSlugId,
  SLUG_ID_REGEX,
  type Subject,
  type Topic,
} from '../../lib/subjectService';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';

// ──────────────────────────────────────────────────────────────────
// SubjectsPage — tabs: Subjects | Topics (with subject filter)
// IDs are user-typed slugs: 1–4 letters + '-' + 1–4 digits
// ──────────────────────────────────────────────────────────────────

type Tab = 'subjects' | 'topics';

export function SubjectsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('subjects');

  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [loadingSubjects, setLoadingSubjects] = useState(true);

  const [topics, setTopics] = useState<Topic[]>([]);
  const [loadingTopics, setLoadingTopics] = useState(true);

  const [showSubjectForm, setShowSubjectForm] = useState(false);
  const [showTopicForm, setShowTopicForm] = useState(false);

  // Topics-tab subject filter ('' = all subjects)
  const [filterSubjectId, setFilterSubjectId] = useState<string>('');

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

  const subjectsById = useMemo(() => {
    const m: Record<string, Subject> = {};
    subjects.forEach((s) => { m[s.id] = s; });
    return m;
  }, [subjects]);

  const filteredTopics = useMemo(() => {
    if (!filterSubjectId) return topics;
    return topics.filter((t) => t.subjectId === filterSubjectId);
  }, [topics, filterSubjectId]);

  const topicCountBySubject = useMemo(() => {
    const m: Record<string, number> = {};
    topics.forEach((t) => { m[t.subjectId] = (m[t.subjectId] ?? 0) + 1; });
    return m;
  }, [topics]);

  // Default subject for "Add Topic" form: current filter, or first subject
  const defaultNewTopicSubject = filterSubjectId || subjects[0]?.id || '';

  return (
    <div className="px-4 py-6 md:px-10 md:py-8" style={{ maxWidth: 1280, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10 }}>
        <FolderTree size={18} strokeWidth={1.5} />
        <h1 style={{ margin: 0 }}>Subjects</h1>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-0 mb-0 overflow-x-auto" style={{ borderBottom: '1px solid #E3E1DB' }}>
        <TabButton
          active={activeTab === 'subjects'}
          onClick={() => setActiveTab('subjects')}
          icon={<BookOpen size={12} strokeWidth={1.5} />}
          label="Subjects"
          count={subjects.length}
        />
        <TabButton
          active={activeTab === 'topics'}
          onClick={() => setActiveTab('topics')}
          icon={<Layers size={12} strokeWidth={1.5} />}
          label="Topics"
          count={topics.length}
        />
      </div>

      {/* ── Subjects tab ── */}
      {activeTab === 'subjects' && (
        <div style={{ background: '#FFFFFF', border: '1px solid #E8E7E1', borderTop: 'none', borderRadius: '0 0 4px 4px' }}>
          <div style={{ padding: 14, borderBottom: '1px solid #E8E7E1', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, letterSpacing: '0.04em', color: '#6B6B66' }}>ALL SUBJECTS</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowSubjectForm((v) => !v)}
              style={{ height: 28, padding: '0 12px', fontSize: 12 }}
            >
              <Plus size={12} strokeWidth={1.5} /> New Subject
            </Button>
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
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 p-3 sm:p-4">
              {subjects.map((s) => (
                <SubjectCard
                  key={s.id}
                  subject={s}
                  topicCount={topicCountBySubject[s.id] ?? 0}
                  onUpdated={async () => { await refreshSubjects(); await refreshTopics(); }}
                  onDeleted={async () => { await refreshSubjects(); await refreshTopics(); }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Topics tab ── */}
      {activeTab === 'topics' && (
        <div style={{ background: '#FFFFFF', border: '1px solid #E8E7E1', borderTop: 'none', borderRadius: '0 0 4px 4px' }}>
          <div style={{ padding: 14, borderBottom: '1px solid #E8E7E1', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, letterSpacing: '0.04em', color: '#6B6B66' }}>TOPICS</span>
              <select
                value={filterSubjectId}
                onChange={(e) => setFilterSubjectId(e.target.value)}
                style={{ fontSize: 12, padding: '4px 8px', border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF', color: '#0C0C0B' }}
              >
                <option value="">All subjects ({topics.length})</option>
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({topics.filter((t) => t.subjectId === s.id).length})
                  </option>
                ))}
              </select>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowTopicForm((v) => !v)}
              disabled={subjects.length === 0}
              style={{ height: 28, padding: '0 12px', fontSize: 12 }}
            >
              <Plus size={12} strokeWidth={1.5} /> New Topic
            </Button>
          </div>

          {showTopicForm && (
            <NewTopicForm
              subjects={subjects}
              defaultSubjectId={defaultNewTopicSubject}
              onCreated={async () => {
                setShowTopicForm(false);
                await refreshTopics();
                await refreshSubjects();
              }}
              onCancel={() => setShowTopicForm(false)}
            />
          )}

          {loadingTopics ? (
            <div style={{ padding: 24, textAlign: 'center', color: '#83827C' }}>
              <Loader2 size={16} className="animate-spin" />
            </div>
          ) : filteredTopics.length === 0 ? (
            <EmptyHint
              text={
                filterSubjectId
                  ? `No topics in ${subjectsById[filterSubjectId]?.name ?? 'this subject'} yet.`
                  : 'No topics yet. Click + New Topic to create one.'
              }
            />
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {filteredTopics.map((t) => (
                <TopicRow
                  key={t.id}
                  topic={t}
                  subject={subjectsById[t.subjectId]}
                  subjects={subjects}
                  showSubject={!filterSubjectId}
                  onChanged={async () => { await refreshTopics(); await refreshSubjects(); }}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default SubjectsPage;

// ── Sub-components ────────────────────────────────────────────────

function TabButton({
  active, onClick, icon, label, count,
}: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; count: number }) {
  return (
    <button
      onClick={onClick}
      className="relative flex items-center gap-1.5 px-4 py-2.5 text-xs select-none transition-colors"
      style={{
        color: active ? '#0C0C0B' : '#9A9891',
        fontWeight: active ? 500 : 400,
        letterSpacing: '0.03em',
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {icon}
      {label}
      <span
        style={{
          fontSize: 10,
          color: active ? '#6B6B66' : '#C4C3BD',
          background: active ? '#F0EFEB' : 'transparent',
          padding: '1px 5px',
          borderRadius: 2,
        }}
      >
        {count}
      </span>
      {active && (
        <span
          className="absolute bottom-0 left-0 right-0"
          style={{ height: 1.5, background: '#0C0C0B' }}
        />
      )}
    </button>
  );
}

function SlugChip({ id }: { id: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        background: '#0C0C0B',
        color: '#FFFFFF',
        fontSize: 10,
        padding: '2px 6px',
        borderRadius: 2,
        letterSpacing: '0.04em',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      }}
    >
      <Hash size={9} strokeWidth={1.8} />
      {id}
    </span>
  );
}

function SubjectPill({ subject }: { subject: Subject | undefined }) {
  if (!subject) return <span style={{ fontSize: 11, color: '#C4C3BD' }}>—</span>;
  return (
    <span
      style={{
        fontSize: 11,
        color: '#6B6B66',
        background: '#F7F6F3',
        border: '1px solid #EEECEA',
        padding: '2px 7px',
        borderRadius: 2,
        whiteSpace: 'nowrap',
      }}
    >
      {subject.name}
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

function SubjectCard({
  subject, topicCount, onUpdated, onDeleted,
}: {
  subject: Subject;
  topicCount: number;
  onUpdated: (newId: string) => void;
  onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <div style={{ background: '#FAFAF7', border: '1px solid #E8E7E1', borderRadius: 3 }}>
        <EditSlugForm
          initialId={subject.id}
          initialName={subject.name}
          onSave={async (newId, newName) => {
            await updateSubject(subject.id, newId, newName);
            setEditing(false);
            onUpdated(newId);
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-3 p-4 transition-colors hover:bg-[#FAFAF8]"
      style={{
        background: '#FFFFFF',
        border: '1px solid #E8E7E1',
        borderRadius: 3,
        minHeight: 120,
      }}
    >
      {/* Header: slug + actions */}
      <div className="flex items-start justify-between gap-2">
        <SlugChip id={subject.id} />
        <div className="flex items-center gap-0.5 flex-shrink-0 -mt-1 -mr-1">
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

      {/* Name */}
      <p
        className="break-words"
        style={{ color: '#0C0C0B', fontSize: 14, lineHeight: 1.4, flex: 1 }}
      >
        {subject.name}
      </p>

      {/* Stats footer */}
      <div
        className="flex items-center gap-4 pt-3"
        style={{ borderTop: '1px solid #F2F1EC' }}
      >
        <div className="flex items-center gap-1.5" style={{ color: '#6B6B66' }}>
          <BookOpen size={11} strokeWidth={1.5} style={{ color: '#9A9891' }} />
          <span style={{ fontSize: 12 }}>{subject.questionCount}</span>
          <span style={{ fontSize: 11, color: '#9A9891' }}>questions</span>
        </div>
        <div className="flex items-center gap-1.5" style={{ color: '#6B6B66' }}>
          <Layers size={11} strokeWidth={1.5} style={{ color: '#9A9891' }} />
          <span style={{ fontSize: 12 }}>{topicCount}</span>
          <span style={{ fontSize: 11, color: '#9A9891' }}>topics</span>
        </div>
      </div>
    </div>
  );
}

function TopicRow({
  topic, subject, subjects, showSubject, onChanged,
}: {
  topic: Topic;
  subject: Subject | undefined;
  subjects: Subject[];
  showSubject: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <li>
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
      </li>
    );
  }

  return (
    <li
      style={{
        padding: '12px 14px',
        borderBottom: '1px solid #F2F1EC',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
      }}
    >
      <SlugChip id={topic.id} />
      <span className="min-w-0 truncate" style={{ flex: 1 }}>{topic.name}</span>
      {showSubject && <SubjectPill subject={subject} />}
      <span style={{ fontSize: 11, color: '#83827C', whiteSpace: 'nowrap' }}>{topic.questionCount} Q</span>
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
    </li>
  );
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#83827C', padding: 4 }}
      title={title}
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
      <button
        onClick={() => setOpen(true)}
        style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#83827C', padding: 4 }}
        title="Move topic to another subject"
        disabled={candidates.length === 0}
      >
        <ArrowRightLeft size={13} strokeWidth={1.5} />
      </button>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <select
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        disabled={busy}
        style={{ fontSize: 12, padding: '2px 6px', border: '1px solid #E8E7E1', borderRadius: 2 }}
      >
        <option value="">→ subject…</option>
        {candidates.map((s) => (
          <option key={s.id} value={s.id}>{s.id} · {s.name}</option>
        ))}
      </select>
      <Button size="sm" onClick={submit} disabled={busy || !target} style={{ height: 24, padding: '0 8px', fontSize: 11 }}>
        {busy ? <Loader2 size={11} className="animate-spin" /> : 'Move'}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setTarget(''); }} disabled={busy} style={{ height: 24, padding: '0 8px', fontSize: 11 }}>
        ✕
      </Button>
    </div>
  );
}

function NewTopicForm({
  subjects, defaultSubjectId, onCreated, onCancel,
}: {
  subjects: Subject[];
  defaultSubjectId: string;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [subjectId, setSubjectId] = useState(defaultSubjectId);
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
    <div style={{ padding: 14, borderBottom: '1px solid #E8E7E1', background: '#FAFAF7' }}>
      {/* Subject selector — required */}
      <div style={{ marginBottom: 8 }}>
        <label style={{ fontSize: 11, color: '#6B6B66', display: 'block', marginBottom: 4 }}>
          Subject <span style={{ color: '#B91C1C' }}>*</span>
        </label>
        <select
          value={subjectId}
          onChange={(e) => setSubjectId(e.target.value)}
          disabled={busy}
          style={{
            width: '100%', maxWidth: 320, fontSize: 12, padding: '6px 8px',
            border: `1px solid ${!subjectId ? '#F2CECE' : '#E3E1DB'}`, borderRadius: 2, background: '#FFFFFF', color: '#0C0C0B',
          }}
        >
          <option value="">— pick a subject —</option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>{s.name} ({s.id})</option>
          ))}
        </select>
      </div>

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
