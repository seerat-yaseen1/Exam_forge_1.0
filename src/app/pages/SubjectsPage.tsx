/**
 * The subject and topic registry — subjects → topics → the questions in one.
 *
 * ── WHAT CHANGED ──────────────────────────────────────────────────
 * The structure was already sound: a master-to-detail drill-in, built
 * mobile-first with real 44px targets. Two things were not.
 *
 * 1. It asked its questions through the browser. Nine `confirm()` and
 *    `alert()` calls — "Delete topic \"Probability\" (prob-0001)?", "Merged.
 *    12 question(s) re-pointed." — inside an otherwise designed product.
 *    Merging two topics rewrites every question tagged with one of them and
 *    then deletes it; that is not a decision to put behind an OS dialog with
 *    an OK button. Every one is now a sheet that names the verb and says what
 *    the consequence is, or a toast that says what happened.
 *
 * 2. Subjects listed one per row at every width, so a platform with forty of
 *    them was a forty-item scroll on a 1440px screen — while the topics one
 *    level down were already in a responsive grid. Subjects now match, and
 *    both levels gained a search box.
 *
 * The forms moved into sheets for the same reason: an inline form that pushes
 * the list down re-flows the thing you were looking at in order to ask you
 * three fields.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  ArrowLeft, ArrowRightLeft, BookOpen, ChevronRight, FolderTree, Layers, Merge,
  Pencil, Plus, RefreshCw, Trash2,
} from 'lucide-react';
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
  type Subject,
  type Topic,
} from '../../lib/subjectService';
import { QuestionBankCore } from '../components/questions/QuestionBankCore';
import {
  Button, Card, EmptyState, PageHeader, PageShell, SectionHeading, StatRow, StatTile,
  useToast,
} from '../components/console/ui';
import { ConfirmSheet, SearchField, Sheet, Toolbar } from '../components/console/data';
import { Field, SelectField } from '../components/console/fields';

/**
 * The id rule, in words.
 *
 * The page used to print the regex source — `^[a-z]{1,4}-\d{1,4}$` — under
 * the field, which tells a developer everything and a registrar nothing.
 * SLUG_ID_REGEX stays the authority; this is how it reads out loud, and the
 * live example under it is what most people will copy anyway.
 */
const SLUG_FORMAT = 'One to four lowercase letters, a hyphen, then one to four digits';

function errorText(e: unknown): string {
  return (e as { message?: string })?.message ?? String(e);
}

// ══════════════════════════════════════════════════════════════════
// PAGE
// ══════════════════════════════════════════════════════════════════

export function SubjectsPage() {
  const { say, toast } = useToast();

  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [loading, setLoading] = useState(true);
  const [recounting, setRecounting] = useState(false);

  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [topicId, setTopicId] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [newSubjectOpen, setNewSubjectOpen] = useState(false);
  const [newTopicOpen, setNewTopicOpen] = useState(false);
  const [renaming, setRenaming] = useState<{ kind: 'subject' | 'topic'; id: string; name: string } | null>(null);
  const [deletingSubject, setDeletingSubject] = useState<Subject | null>(null);
  const [deletingTopic, setDeletingTopic] = useState<Topic | null>(null);
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState<Topic | null>(null);
  const [merging, setMerging] = useState<Topic | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [s, t] = await Promise.all([getAllSubjects(), getAllTopics()]);
      setSubjects(s);
      setTopics(t);
    } catch (e) {
      say(errorText(e), 'danger');
    } finally {
      setLoading(false);
    }
  }, [say]);

  useEffect(() => { reload(); }, [reload]);

  const recount = async () => {
    setRecounting(true);
    try {
      await refreshAllTopicCounts();
      await reload();
      say('Question counts recalculated.', 'success');
    } catch (e) {
      say(errorText(e), 'danger');
    } finally {
      setRecounting(false);
    }
  };

  const topicsBySubject = useMemo(() => {
    const m: Record<string, Topic[]> = {};
    topics.forEach((t) => { (m[t.subjectId] ??= []).push(t); });
    return m;
  }, [topics]);

  const subject = subjectId ? subjects.find((s) => s.id === subjectId) ?? null : null;
  const topic = topicId ? topics.find((t) => t.id === topicId) ?? null : null;
  const subjectTopics = subject ? topicsBySubject[subject.id] ?? [] : [];

  // Clearing the search on every level change is deliberate: a filter that
  // survives a drill-in silently hides half of the next screen.
  const goTo = (nextSubject: string | null, nextTopic: string | null) => {
    setSubjectId(nextSubject);
    setTopicId(nextTopic);
    setQuery('');
  };

  const matches = (id: string, name: string) => {
    const q = query.trim().toLowerCase();
    return !q || id.toLowerCase().includes(q) || name.toLowerCase().includes(q);
  };

  const visibleSubjects = subjects.filter((s) => matches(s.id, s.name));
  const visibleTopics = subjectTopics.filter((t) => matches(t.id, t.name));

  const totalQuestions = subjects.reduce((n, s) => n + (s.questionCount ?? 0), 0);

  // ── Level 3: one topic's questions ─────────────────────────────

  if (subject && topic) {
    return (
      <PageShell>
        <PageHeader
          eyebrow={
            <button type="button" className="ef-crumb" onClick={() => goTo(subject.id, null)}>
              <ArrowLeft size={12} strokeWidth={1.8} />
              {subject.name} · topics
            </button>
          }
          title={topic.name}
          subtitle={`Every question tagged ${topic.id}. Anything added here is tagged with this topic automatically.`}
        >
          <div className="flex items-center gap-2 flex-wrap">
            <span className="ef-chip ef-mono-chip">{topic.id}</span>
            <span className="ef-t-xs ef-muted">in {subject.name}</span>
          </div>
        </PageHeader>

        <QuestionBankCore
          lockSubjectId={subject.id}
          lockTopicId={topic.id}
          showAddButton
          onChanged={reload}
        />
        {toast}
      </PageShell>
    );
  }

  // ── Level 2: one subject's topics ──────────────────────────────

  if (subject) {
    return (
      <PageShell>
        <PageHeader
          eyebrow={
            <button type="button" className="ef-crumb" onClick={() => goTo(null, null)}>
              <ArrowLeft size={12} strokeWidth={1.8} />
              All subjects
            </button>
          }
          title={subject.name}
          subtitle="Topics divide a subject up. A question is tagged with exactly one of them, which is what lets a paper ask for two questions from probability."
          actions={
            <>
              <Button
                size="sm"
                onClick={() => setRenaming({ kind: 'subject', id: subject.id, name: subject.name })}
              >
                <Pencil size={12} strokeWidth={1.7} />
                Rename
              </Button>
              <Button size="sm" variant="danger" onClick={() => setDeletingSubject(subject)}>
                <Trash2 size={12} strokeWidth={1.7} />
                Delete
              </Button>
            </>
          }
        >
          <div className="flex items-center gap-3 flex-wrap">
            <span className="ef-chip ef-mono-chip">{subject.id}</span>
            <span className="ef-t-xs ef-muted inline-flex items-center gap-1.5">
              <BookOpen size={12} strokeWidth={1.7} />
              {subject.questionCount ?? 0} questions
            </span>
            <span className="ef-t-xs ef-muted inline-flex items-center gap-1.5">
              <Layers size={12} strokeWidth={1.7} />
              {subjectTopics.length} topics
            </span>
          </div>
        </PageHeader>

        <Toolbar
          end={
            <Button size="sm" variant="primary" onClick={() => setNewTopicOpen(true)}>
              <Plus size={12} strokeWidth={1.9} />
              New topic
            </Button>
          }
        >
          <SearchField
            value={query}
            onChange={setQuery}
            label="Search topics"
            placeholder="Search topics by name or id…"
          />
        </Toolbar>

        {loading ? (
          <CardGridSkeleton />
        ) : visibleTopics.length === 0 ? (
          <EmptyState
            icon={<Layers size={28} strokeWidth={1.1} />}
            title={query ? 'Nothing matches' : 'No topics yet'}
            body={
              query
                ? 'No topic in this subject matches that search.'
                : 'A subject with no topics cannot be drawn from by a paper rule. Add the first one.'
            }
            action={
              query ? (
                <Button onClick={() => setQuery('')}>Clear search</Button>
              ) : (
                <Button variant="primary" onClick={() => setNewTopicOpen(true)}>
                  <Plus size={13} strokeWidth={1.9} />
                  New topic
                </Button>
              )
            }
          />
        ) : (
          <div className="ef-card-grid">
            {visibleTopics.map((t) => (
              <RegistryCard
                key={t.id}
                id={t.id}
                name={t.name}
                questionCount={t.questionCount ?? 0}
                onOpen={() => goTo(subject.id, t.id)}
                actions={
                  <>
                    <IconAction
                      title="Merge into another topic"
                      onClick={() => setMerging(t)}
                      disabled={subjectTopics.length < 2}
                    >
                      <Merge size={14} strokeWidth={1.7} />
                    </IconAction>
                    <IconAction
                      title="Move to another subject"
                      onClick={() => setMoving(t)}
                      disabled={subjects.length < 2}
                    >
                      <ArrowRightLeft size={14} strokeWidth={1.7} />
                    </IconAction>
                    <IconAction title="Rename topic" onClick={() => setRenaming({ kind: 'topic', id: t.id, name: t.name })}>
                      <Pencil size={14} strokeWidth={1.7} />
                    </IconAction>
                    <IconAction title="Delete topic" onClick={() => setDeletingTopic(t)}>
                      <Trash2 size={14} strokeWidth={1.7} />
                    </IconAction>
                  </>
                }
              />
            ))}
          </div>
        )}

        <SlugFormSheet
          open={newTopicOpen}
          onClose={() => setNewTopicOpen(false)}
          title="New topic"
          description={`It will belong to ${subject.name}.`}
          submitLabel="Create topic"
          example="prob-0001"
          onSubmit={async (id, name) => {
            await createTopicWithSlug(id, name, subject.id);
            setNewTopicOpen(false);
            await reload();
            say(`Topic ${name} created.`, 'success');
          }}
        />

        {sharedSheets()}
        {toast}
      </PageShell>
    );
  }

  // ── Level 1: every subject ─────────────────────────────────────

  return (
    <PageShell>
      <PageHeader
        eyebrow={
          <>
            <span className="ef-eyebrow-dot" />
            Web owner
          </>
        }
        title="Subjects"
        subtitle="The taxonomy every question is filed under. Papers are built from it — a rule that asks for three questions from a topic is asking this registry."
        actions={
          <>
            <Button size="sm" onClick={recount} disabled={recounting} title="Recalculate question counts from the questions themselves">
              <RefreshCw size={12} strokeWidth={1.7} className={recounting ? 'animate-spin' : ''} />
              Recount
            </Button>
            <Button size="sm" variant="primary" onClick={() => setNewSubjectOpen(true)}>
              <Plus size={12} strokeWidth={1.9} />
              New subject
            </Button>
          </>
        }
      />

      <div style={{ marginBottom: 26 }}>
        <StatRow>
          <StatTile
            label="Subjects"
            value={loading ? '—' : subjects.length}
            icon={<FolderTree size={13} strokeWidth={1.7} />}
            sub="top level"
            hint="The coarsest division. Every topic belongs to exactly one."
          />
          <StatTile
            label="Topics"
            value={loading ? '—' : topics.length}
            icon={<Layers size={13} strokeWidth={1.7} />}
            sub="across all subjects"
            hint="What a paper rule actually draws from."
          />
          <StatTile
            label="Questions filed"
            value={loading ? '—' : totalQuestions}
            icon={<BookOpen size={13} strokeWidth={1.7} />}
            sub="counted per subject"
            hint="From each subject's stored count. Recount rebuilds these from the questions themselves."
          />
        </StatRow>
      </div>

      <SectionHeading label="All subjects" count={loading ? undefined : subjects.length} />

      <Toolbar>
        <SearchField
          value={query}
          onChange={setQuery}
          label="Search subjects"
          placeholder="Search subjects by name or id…"
        />
      </Toolbar>

      {loading ? (
        <CardGridSkeleton />
      ) : visibleSubjects.length === 0 ? (
        <EmptyState
          icon={<FolderTree size={28} strokeWidth={1.1} />}
          title={query ? 'Nothing matches' : 'No subjects yet'}
          body={
            query
              ? 'No subject matches that search.'
              : 'Nothing can be filed until there is somewhere to file it. Create the first subject, then give it topics.'
          }
          action={
            query ? (
              <Button onClick={() => setQuery('')}>Clear search</Button>
            ) : (
              <Button variant="primary" onClick={() => setNewSubjectOpen(true)}>
                <Plus size={13} strokeWidth={1.9} />
                New subject
              </Button>
            )
          }
        />
      ) : (
        <div className="ef-card-grid">
          {visibleSubjects.map((s) => (
            <RegistryCard
              key={s.id}
              id={s.id}
              name={s.name}
              questionCount={s.questionCount ?? 0}
              topicCount={(topicsBySubject[s.id] ?? []).length}
              onOpen={() => goTo(s.id, null)}
            />
          ))}
        </div>
      )}

      <SlugFormSheet
        open={newSubjectOpen}
        onClose={() => setNewSubjectOpen(false)}
        title="New subject"
        description="The id is typed rather than generated: it is what bulk uploads and question records refer to, so it has to be readable and stable."
        submitLabel="Create subject"
        example="math-0001"
        onSubmit={async (id, name) => {
          await createSubjectWithSlug(id, name);
          setNewSubjectOpen(false);
          await reload();
          say(`Subject ${name} created.`, 'success');
        }}
      />

      {sharedSheets()}
      {toast}
    </PageShell>
  );

  // ── The dialogs both levels use ────────────────────────────────

  function sharedSheets() {
    return (
      <>
        {renaming && (
          <SlugFormSheet
            open
            onClose={() => setRenaming(null)}
            title={renaming.kind === 'subject' ? 'Rename subject' : 'Rename topic'}
            description="Changing the id re-points every question filed under it. Nothing is lost, but anything that referred to the old id by hand will need updating."
            submitLabel="Save"
            initialId={renaming.id}
            initialName={renaming.name}
            example={renaming.kind === 'subject' ? 'math-0001' : 'prob-0001'}
            onSubmit={async (id, name) => {
              if (renaming.kind === 'subject') {
                await updateSubject(renaming.id, id, name);
                if (subjectId === renaming.id) setSubjectId(id);
              } else {
                await updateTopic(renaming.id, id, name);
                if (topicId === renaming.id) setTopicId(id);
              }
              setRenaming(null);
              await reload();
              say('Renamed.', 'success');
            }}
          />
        )}

        <ConfirmSheet
          open={!!deletingSubject}
          onClose={() => setDeletingSubject(null)}
          busy={busy}
          title="Delete this subject?"
          confirmLabel="Delete subject"
          body={
            deletingSubject && (
              <>
                <strong className="ef-ink">{deletingSubject.name}</strong> ({deletingSubject.id}) will be
                removed from the registry. Its {(topicsBySubject[deletingSubject.id] ?? []).length} topic
                {(topicsBySubject[deletingSubject.id] ?? []).length === 1 ? '' : 's'} and the{' '}
                {deletingSubject.questionCount ?? 0} question
                {(deletingSubject.questionCount ?? 0) === 1 ? '' : 's'} filed under it lose their
                classification.
              </>
            )
          }
          onConfirm={async () => {
            if (!deletingSubject) return;
            setBusy(true);
            try {
              await deleteSubject(deletingSubject.id);
              const name = deletingSubject.name;
              setDeletingSubject(null);
              goTo(null, null);
              await reload();
              say(`${name} deleted.`, 'success');
            } catch (e) {
              say(errorText(e), 'danger');
            } finally {
              setBusy(false);
            }
          }}
        />

        <ConfirmSheet
          open={!!deletingTopic}
          onClose={() => setDeletingTopic(null)}
          busy={busy}
          title="Delete this topic?"
          confirmLabel="Delete topic"
          body={
            deletingTopic && (
              <>
                <strong className="ef-ink">{deletingTopic.name}</strong> ({deletingTopic.id}) will be
                removed. The {deletingTopic.questionCount ?? 0} question
                {(deletingTopic.questionCount ?? 0) === 1 ? '' : 's'} tagged with it stay, but no paper
                rule can draw from them until they are filed somewhere else. Merging into another topic
                keeps them reachable.
              </>
            )
          }
          onConfirm={async () => {
            if (!deletingTopic) return;
            setBusy(true);
            try {
              await deleteTopic(deletingTopic.id);
              const name = deletingTopic.name;
              setDeletingTopic(null);
              await reload();
              say(`${name} deleted.`, 'success');
            } catch (e) {
              say(errorText(e), 'danger');
            } finally {
              setBusy(false);
            }
          }}
        />

        <PickTargetSheet
          open={!!moving}
          onClose={() => setMoving(null)}
          title="Move to another subject"
          description={moving ? `Every question tagged ${moving.id} moves with it.` : ''}
          label="Move into"
          placeholder="Pick a subject…"
          submitLabel="Move topic"
          options={subjects.filter((s) => s.id !== moving?.subjectId).map((s) => ({ value: s.id, label: `${s.name} · ${s.id}` }))}
          onSubmit={async (target) => {
            if (!moving) return;
            const res = await moveTopic(moving.id, target);
            setMoving(null);
            await reload();
            say(`Moved. ${res.updatedQuestions} question${res.updatedQuestions === 1 ? '' : 's'} reassigned.`, 'success');
          }}
        />

        <PickTargetSheet
          open={!!merging}
          onClose={() => setMerging(null)}
          title="Merge into another topic"
          description={
            merging
              ? `Every question tagged ${merging.id} is re-pointed at the topic you choose, and ${merging.id} is deleted. This cannot be undone.`
              : ''
          }
          label="Merge into"
          placeholder="Pick a topic…"
          submitLabel="Merge topics"
          tone="danger"
          options={subjectTopics
            .filter((t) => t.id !== merging?.id)
            .map((t) => ({ value: t.id, label: `${t.name} · ${t.id}` }))}
          onSubmit={async (target) => {
            if (!merging) return;
            const res = await mergeTopics(merging.id, target);
            setMerging(null);
            await reload();
            say(`Merged. ${res.updatedQuestions} question${res.updatedQuestions === 1 ? '' : 's'} re-pointed.`, 'success');
          }}
        />
      </>
    );
  }
}

export default SubjectsPage;

// ══════════════════════════════════════════════════════════════════
// PIECES
// ══════════════════════════════════════════════════════════════════

/** One subject or topic, as a card you can open. */
function RegistryCard({
  id,
  name,
  questionCount,
  topicCount,
  onOpen,
  actions,
}: {
  id: string;
  name: string;
  questionCount: number;
  topicCount?: number;
  onOpen: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <Card padded={false} className="flex flex-col">
      <button
        type="button"
        onClick={onOpen}
        className="ef-registry-open flex flex-col gap-3 text-left w-full"
        style={{ padding: 'var(--ef-pad-card)' }}
      >
        <span className="flex items-center justify-between gap-2">
          <span className="ef-chip ef-mono-chip">{id}</span>
          <ChevronRight size={16} strokeWidth={1.7} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
        </span>
        <span className="ef-t-md ef-ink break-words" style={{ fontWeight: 500 }}>
          {name}
        </span>
        <span className="flex items-center gap-4 flex-wrap">
          <span className="ef-t-xs ef-muted inline-flex items-center gap-1.5">
            <BookOpen size={12} strokeWidth={1.7} />
            {questionCount} question{questionCount === 1 ? '' : 's'}
          </span>
          {topicCount !== undefined && (
            <span className="ef-t-xs ef-muted inline-flex items-center gap-1.5">
              <Layers size={12} strokeWidth={1.7} />
              {topicCount} topic{topicCount === 1 ? '' : 's'}
            </span>
          )}
        </span>
      </button>

      {actions && (
        <div
          className="flex items-center gap-0.5 flex-wrap"
          style={{ padding: '6px 10px', borderTop: '1px solid var(--ef-border-subtle)' }}
        >
          {actions}
        </div>
      )}
    </Card>
  );
}

function IconAction({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className="ef-icon-btn"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
    >
      {children}
    </button>
  );
}

function CardGridSkeleton() {
  return (
    <div className="ef-card-grid" aria-busy="true">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="ef-skeleton" style={{ height: 132 }} />
      ))}
    </div>
  );
}

// ── Sheets ────────────────────────────────────────────────────────

/**
 * Create or rename a subject or a topic.
 *
 * One sheet for four cases, because they are one form: a typed id, a name,
 * and the rule the id has to satisfy. The id being user-typed rather than
 * generated is the reason the format hint is always visible rather than only
 * appearing once it has been got wrong.
 */
function SlugFormSheet({
  open,
  onClose,
  title,
  description,
  submitLabel,
  example,
  initialId = '',
  initialName = '',
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  submitLabel: string;
  example: string;
  initialId?: string;
  initialName?: string;
  onSubmit: (id: string, name: string) => Promise<void>;
}) {
  const [id, setId] = useState(initialId);
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setId(initialId);
    setName(initialName);
    setError('');
    setBusy(false);
  }, [open, initialId, initialName]);

  const idValid = isValidSlugId(id);
  const canSubmit = idValid && name.trim().length > 0 && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(id.trim(), name.trim());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      variant="centre"
      title={title}
      description={description}
      footer={
        <div className="flex items-center gap-2.5">
          <Button variant="primary" size="lg" onClick={submit} disabled={!canSubmit} loading={busy}>
            {submitLabel}
          </Button>
          <Button size="lg" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="flex flex-col" style={{ gap: 16 }}>
        <Field
          label="Identifier"
          value={id}
          onChange={(e) => {
            setId(e.target.value.toLowerCase());
            setError('');
          }}
          disabled={busy}
          placeholder={example}
          autoFocus
          style={{ fontFamily: 'ui-monospace, monospace', letterSpacing: '0.06em' }}
          hint={
            <span style={{ color: id && !idValid ? 'var(--ef-danger)' : undefined }}>
              {SLUG_FORMAT} — for example {example}
            </span>
          }
        />
        <Field
          label="Name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError('');
          }}
          disabled={busy}
          placeholder="What people will read"
        />
        {error && (
          <p className="ef-t-sm" role="alert" style={{ color: 'var(--ef-danger)' }}>
            {error}
          </p>
        )}
      </div>
    </Sheet>
  );
}

/** Move or merge: pick one target, confirm, done. */
function PickTargetSheet({
  open,
  onClose,
  title,
  description,
  label,
  placeholder,
  submitLabel,
  options,
  onSubmit,
  tone = 'primary',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  label: string;
  placeholder: string;
  submitLabel: string;
  options: Array<{ value: string; label: string }>;
  onSubmit: (target: string) => Promise<void>;
  tone?: 'primary' | 'danger';
}) {
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setTarget('');
    setError('');
    setBusy(false);
  }, [open]);

  const submit = async () => {
    if (!target || busy) return;
    setBusy(true);
    setError('');
    try {
      await onSubmit(target);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      variant="centre"
      title={title}
      description={description}
      footer={
        <div className="flex items-center gap-2.5">
          <Button
            variant={tone === 'danger' ? 'danger' : 'primary'}
            size="lg"
            onClick={submit}
            disabled={!target || busy}
            loading={busy}
          >
            {submitLabel}
          </Button>
          <Button size="lg" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      }
    >
      <div className="flex flex-col" style={{ gap: 16 }}>
        <SelectField
          label={label}
          value={target}
          disabled={busy}
          onChange={(e) => {
            setTarget(e.target.value);
            setError('');
          }}
        >
          <option value="">{placeholder}</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </SelectField>
        {error && (
          <p className="ef-t-sm" role="alert" style={{ color: 'var(--ef-danger)' }}>
            {error}
          </p>
        )}
      </div>
    </Sheet>
  );
}
