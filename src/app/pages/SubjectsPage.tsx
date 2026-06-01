import React, { useState, useEffect, useCallback } from 'react';
import { Plus, Loader2, FolderTree, Hash, Trash2, ArrowRightLeft, Pencil } from 'lucide-react';
import {
  getAllSubjects,
  getTopicsBySubject,
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
// SubjectsPage — list subjects (left) + drill-down topics (right)
// IDs are user-typed slugs: 1–4 letters + '-' + 1–4 digits
// ──────────────────────────────────────────────────────────────────

export function SubjectsPage() {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [loadingSubjects, setLoadingSubjects] = useState(true);
  const [selectedSubjectId, setSelectedSubjectId] = useState<string | null>(null);

  const [topics, setTopics] = useState<Topic[]>([]);
  const [loadingTopics, setLoadingTopics] = useState(false);

  const [showSubjectForm, setShowSubjectForm] = useState(false);
  const [showTopicForm, setShowTopicForm] = useState(false);

  const refreshSubjects = useCallback(async () => {
    setLoadingSubjects(true);
    try {
      setSubjects(await getAllSubjects());
    } finally {
      setLoadingSubjects(false);
    }
  }, []);

  const refreshTopics = useCallback(async (subjectId: string) => {
    setLoadingTopics(true);
    try {
      setTopics(await getTopicsBySubject(subjectId));
    } finally {
      setLoadingTopics(false);
    }
  }, []);

  useEffect(() => { refreshSubjects(); }, [refreshSubjects]);

  useEffect(() => {
    if (selectedSubjectId) refreshTopics(selectedSubjectId);
    else setTopics([]);
  }, [selectedSubjectId, refreshTopics]);

  const selectedSubject = subjects.find((s) => s.id === selectedSubjectId) ?? null;

  return (
    <div style={{ padding: '32px 40px', maxWidth: 1280, margin: '0 auto' }}>
      <div style={{ marginBottom: 24, display: 'flex', alignItems: 'center', gap: 10 }}>
        <FolderTree size={18} strokeWidth={1.5} />
        <h1 style={{ margin: 0 }}>Subjects</h1>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 24 }}>
        {/* ── Subjects column ── */}
        <div style={{ background: '#FFFFFF', border: '1px solid #E8E7E1', borderRadius: 4 }}>
          <div style={{ padding: 14, borderBottom: '1px solid #E8E7E1', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, letterSpacing: '0.04em' }}>SUBJECTS</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowSubjectForm((v) => !v)}
              style={{ height: 26, padding: '0 10px', fontSize: 12 }}
            >
              <Plus size={12} strokeWidth={1.5} /> New
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
            <EmptyHint text="No subjects yet. Click + New to create one." />
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {subjects.map((s) => (
                <SubjectRow
                  key={s.id}
                  subject={s}
                  selected={s.id === selectedSubjectId}
                  onSelect={() => setSelectedSubjectId(s.id)}
                  onUpdated={async (newId) => {
                    await refreshSubjects();
                    if (selectedSubjectId === s.id) setSelectedSubjectId(newId);
                  }}
                  onDeleted={async () => {
                    if (selectedSubjectId === s.id) setSelectedSubjectId(null);
                    await refreshSubjects();
                  }}
                />
              ))}
            </ul>
          )}
        </div>

        {/* ── Topics column ── */}
        <div style={{ background: '#FFFFFF', border: '1px solid #E8E7E1', borderRadius: 4 }}>
          <div style={{ padding: 14, borderBottom: '1px solid #E8E7E1', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 13, letterSpacing: '0.04em' }}>
              {selectedSubject ? `TOPICS — ${selectedSubject.name}` : 'TOPICS'}
            </span>
            {selectedSubject && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowTopicForm((v) => !v)}
                style={{ height: 26, padding: '0 10px', fontSize: 12 }}
              >
                <Plus size={12} strokeWidth={1.5} /> New
              </Button>
            )}
          </div>

          {!selectedSubject ? (
            <EmptyHint text="Select a subject on the left to view and add its topics." />
          ) : (
            <>
              {showTopicForm && (
                <NewTopicForm
                  subjectId={selectedSubject.id}
                  onCreated={async () => {
                    setShowTopicForm(false);
                    await refreshTopics(selectedSubject.id);
                  }}
                  onCancel={() => setShowTopicForm(false)}
                />
              )}
              {loadingTopics ? (
                <div style={{ padding: 24, textAlign: 'center', color: '#83827C' }}>
                  <Loader2 size={16} className="animate-spin" />
                </div>
              ) : topics.length === 0 ? (
                <EmptyHint text="No topics in this subject yet." />
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {topics.map((t) => (
                    <TopicRow
                      key={t.id}
                      topic={t}
                      subjects={subjects}
                      onChanged={async () => {
                        await refreshSubjects();
                        if (selectedSubject) await refreshTopics(selectedSubject.id);
                      }}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
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
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <Input
          placeholder="ID e.g. math-0001"
          value={id}
          onChange={(e) => setId(e.target.value.toLowerCase())}
          style={{ width: 150, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
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

function SubjectRow({
  subject, selected, onSelect, onUpdated, onDeleted,
}: {
  subject: Subject;
  selected: boolean;
  onSelect: () => void;
  onUpdated: (newId: string) => void;
  onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <li>
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
      </li>
    );
  }

  return (
    <li
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '12px 14px',
        background: selected ? '#F2F1EC' : 'transparent',
        borderBottom: '1px solid #F2F1EC',
      }}
    >
      <button
        onClick={onSelect}
        style={{
          flex: 1, display: 'flex', alignItems: 'center', gap: 10,
          background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0,
        }}
      >
        <SlugChip id={subject.id} />
        <span style={{ flex: 1 }}>{subject.name}</span>
        <span style={{ fontSize: 11, color: '#83827C' }}>{subject.questionCount}</span>
      </button>
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
    </li>
  );
}

function TopicRow({
  topic, subjects, onChanged,
}: { topic: Topic; subjects: Subject[]; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <div>
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
    <li
      style={{
        padding: '12px 14px',
        borderBottom: '1px solid #F2F1EC',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <SlugChip id={topic.id} />
      <span style={{ flex: 1 }}>{topic.name}</span>
      <span style={{ fontSize: 11, color: '#83827C' }}>{topic.questionCount}</span>
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
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <Input
          value={id}
          onChange={(e) => setId(e.target.value.toLowerCase())}
          style={{ width: 150, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
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
  subjectId, onCreated, onCancel,
}: { subjectId: string; onCreated: () => void; onCancel: () => void }) {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const idValid = isValidSlugId(id);

  const submit = async () => {
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
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <Input
          placeholder="ID e.g. prob-0001"
          value={id}
          onChange={(e) => setId(e.target.value.toLowerCase())}
          style={{ width: 150, fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
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
        <Button size="sm" onClick={submit} disabled={busy || !idValid || !name.trim()}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : 'Create'}
        </Button>
      </div>
    </div>
  );
}
