import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  getAllSubjects,
  getTopicsBySubject,
  type Subject,
  type Topic,
} from '../../../lib/subjectService';

// ──────────────────────────────────────────────────────────────────
// SubjectTopicSelect — strict dropdowns backed by slug IDs.
// Topic dropdown is empty until a subject is selected, then shows
// only that subject's topics.
//
// Emits both the slug IDs (preferred) and the canonical names
// (kept on the question for back-compat with reports / older queries).
// ──────────────────────────────────────────────────────────────────

export type SubjectTopicValue = {
  subjectId: string | null;
  subjectName: string;
  topicId: string | null;
  topicName: string;
};

interface Props {
  subjectId: string | null;
  topicId: string | null;
  onChange: (v: SubjectTopicValue) => void;
  subjectError?: string;
  topicError?: string;
}

const sel: React.CSSProperties = {
  width: '100%',
  height: 38,
  padding: '0 10px',
  border: '1px solid var(--ef-border)',
  borderRadius: 2,
  background: 'var(--ef-surface)',
  fontSize: 14,
};

export function SubjectTopicSelect({ subjectId, topicId, onChange, subjectError, topicError }: Props) {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [loadingSubjects, setLoadingSubjects] = useState(true);
  const [loadingTopics, setLoadingTopics] = useState(false);

  // Load subjects once
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await getAllSubjects();
        if (!cancelled) setSubjects(list);
      } finally {
        if (!cancelled) setLoadingSubjects(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Load topics whenever the subject changes
  useEffect(() => {
    if (!subjectId) { setTopics([]); return; }
    let cancelled = false;
    setLoadingTopics(true);
    (async () => {
      try {
        const list = await getTopicsBySubject(subjectId);
        if (!cancelled) setTopics(list);
      } finally {
        if (!cancelled) setLoadingTopics(false);
      }
    })();
    return () => { cancelled = true; };
  }, [subjectId]);

  const currentSubject = subjects.find((s) => s.id === subjectId) ?? null;
  const currentTopic   = topics.find((t) => t.id === topicId) ?? null;

  const handleSubjectChange = (newSubjectId: string) => {
    const s = subjects.find((x) => x.id === newSubjectId);
    onChange({
      subjectId: newSubjectId || null,
      subjectName: s?.name ?? '',
      topicId: null,
      topicName: '',
    });
  };

  const handleTopicChange = (newTopicId: string) => {
    const t = topics.find((x) => x.id === newTopicId);
    onChange({
      subjectId: currentSubject?.id ?? null,
      subjectName: currentSubject?.name ?? '',
      topicId: newTopicId || null,
      topicName: t?.name ?? '',
    });
  };

  return (
    <div className="grid grid-cols-2 gap-x-4">
      <div>
        <label className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.04em' }}>SUBJECT *</label>
        <select
          value={subjectId ?? ''}
          onChange={(e) => handleSubjectChange(e.target.value)}
          style={{
            ...sel,
            marginTop: 4,
            borderColor: subjectError ? 'var(--ef-danger)' : 'var(--ef-border)',
          }}
          disabled={loadingSubjects}
        >
          <option value="">{loadingSubjects ? 'Loading…' : '— select subject —'}</option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>{s.id} · {s.name}</option>
          ))}
        </select>
        {subjectError && <div style={{ fontSize: 12, color: 'var(--ef-danger)', marginTop: 4 }}>{subjectError}</div>}
      </div>

      <div>
        <label className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.04em' }}>TOPIC *</label>
        <select
          value={topicId ?? ''}
          onChange={(e) => handleTopicChange(e.target.value)}
          style={{
            ...sel,
            marginTop: 4,
            borderColor: topicError ? 'var(--ef-danger)' : 'var(--ef-border)',
            color: subjectId ? 'var(--ef-ink)' : 'var(--ef-text-muted)',
          }}
          disabled={!subjectId || loadingTopics}
        >
          <option value="">
            {!subjectId
              ? 'Select subject first'
              : loadingTopics
                ? 'Loading…'
                : topics.length === 0
                  ? 'No topics — create one on Subjects page'
                  : '— select topic —'}
          </option>
          {topics.map((t) => (
            <option key={t.id} value={t.id}>{t.id} · {t.name}</option>
          ))}
        </select>
        {topicError && <div style={{ fontSize: 12, color: 'var(--ef-danger)', marginTop: 4 }}>{topicError}</div>}
        {loadingTopics && (
          <div style={{ fontSize: 12, color: 'var(--ef-text-muted)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
            <Loader2 size={11} className="animate-spin" /> loading topics…
          </div>
        )}
      </div>
    </div>
  );
}
