/**
 * builder/groupRulePicker — GroupRulePanel.
 *
 * Selection rules for GROUPED SETS, sitting alongside the per-difficulty topic
 * rows in RuleBuilderPanel.
 *
 * It is a separate panel rather than another column on the difficulty rows
 * because the UNIT DIFFERS. A topic row asks for N questions; a group row asks
 * for N sets, each contributing some number of questions. Putting "3" in the
 * same column for both would mean two different things depending on the row,
 * which is the kind of ambiguity that produces a paper twice the intended
 * length without anyone noticing until candidates are sitting it.
 */

import { useMemo, useState } from 'react';
import { Layers, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import { GROUP_KIND_LABEL, type QuestionGroup } from '../../../../lib/questionBankService';
import { DIFFICULTIES, DIFF_COLORS, type Difficulty, type RuleDraft, type SectionDraft } from './shared';

// A bucket of interchangeable sets: same taxonomy, same difficulty, same kind.
// That tuple is exactly what a GroupSelectionRule matches on, so one bucket is
// one possible rule.
type Bucket = {
  key: string;
  subject: string;
  topic: string;
  difficulty: Difficulty;
  kind: QuestionGroup['kind'];
  groups: QuestionGroup[];
  /** Smallest live child count in the bucket — caps questionsPerGroup. */
  minChildren: number;
};

const inp: React.CSSProperties = {
  background: 'var(--ef-surface)',
  border: '1px solid var(--ef-border)',
  borderRadius: 2,
  color: 'var(--ef-ink)',
  fontSize: 12,
  padding: '5px 7px',
  width: 62,
  outline: 'none',
};

export function GroupRulePanel({
  sections, activeSectionIdx, setSections, allGroups, childCountByGroupId,
  locked, subjectPoolNames, topicPool,
  subjectNameById, topicNameById,
}: {
  sections: SectionDraft[];
  activeSectionIdx: number;
  setSections: React.Dispatch<React.SetStateAction<SectionDraft[]>>;
  allGroups: QuestionGroup[];
  /** groupId → number of live children. Drives the per-set cap. */
  childCountByGroupId: Record<string, number>;
  locked?: boolean;
  subjectPoolNames?: string[];
  topicPool?: string[];
  subjectNameById?: Record<string, string>;
  topicNameById?: Record<string, string>;
}) {
  const activeSection = sections[activeSectionIdx];
  const [open, setOpen] = useState(false);

  // Same canonicalisation the resolver uses — a renamed subject must not split
  // a bucket in two or hide it from the pool entirely.
  const gSubject = (g: QuestionGroup): string =>
    (subjectNameById && g.subjectId && subjectNameById[g.subjectId]) || g.subject;
  const gTopic = (g: QuestionGroup): string =>
    (topicNameById && g.topicId && topicNameById[g.topicId]) || g.topic;

  const buckets = useMemo<Bucket[]>(() => {
    const subjSet = subjectPoolNames && subjectPoolNames.length > 0 ? new Set(subjectPoolNames) : null;
    const topicSet = topicPool && topicPool.length > 0 ? new Set(topicPool) : null;

    const map = new Map<string, Bucket>();
    for (const g of allGroups) {
      if (g.isDeleted) continue;
      const subject = gSubject(g);
      const topic = gTopic(g);
      if (!subject || !topic) continue;
      if (subjSet && !subjSet.has(subject)) continue;
      if (topicSet && !topicSet.has(`${subject}::${topic}`)) continue;

      // A set with no live questions cannot be drawn — the resolver treats it
      // as ineligible, so offering it here would promise content that the
      // publish-time check then refuses.
      const live = childCountByGroupId[g.id] ?? 0;
      if (live === 0) continue;

      const key = `${subject}::${topic}::${g.difficulty}::${g.kind}`;
      const existing = map.get(key);
      if (existing) {
        existing.groups.push(g);
        existing.minChildren = Math.min(existing.minChildren, live);
      } else {
        map.set(key, {
          key, subject, topic,
          difficulty: g.difficulty,
          kind: g.kind,
          groups: [g],
          minChildren: live,
        });
      }
    }

    return [...map.values()].sort((a, b) =>
      a.subject.localeCompare(b.subject)
      || a.topic.localeCompare(b.topic)
      || DIFFICULTIES.indexOf(a.difficulty) - DIFFICULTIES.indexOf(b.difficulty));
  }, [allGroups, childCountByGroupId, subjectPoolNames, topicPool, subjectNameById, topicNameById]);

  const ruleFor = (b: Bucket): RuleDraft | undefined =>
    activeSection?.rules.find((r) =>
      r.kind === 'group'
      && r.subject === b.subject
      && r.topic === b.topic
      && r.difficulty === b.difficulty
      && (r.groupKind ?? b.kind) === b.kind);

  const patchRule = (b: Bucket, field: 'groupCount' | 'questionsPerGroup' | 'marksPerQuestion', value: string) => {
    setSections((prev) => prev.map((sec, i) => {
      if (i !== activeSectionIdx) return sec;
      const existing = sec.rules.find((r) =>
        r.kind === 'group'
        && r.subject === b.subject
        && r.topic === b.topic
        && r.difficulty === b.difficulty
        && (r.groupKind ?? b.kind) === b.kind);

      if (existing) {
        return {
          ...sec,
          rules: sec.rules.map((r) => (r === existing ? { ...r, [field]: value } : r)),
        };
      }
      const fresh: RuleDraft = {
        kind: 'group',
        subject: b.subject,
        topic: b.topic,
        difficulty: b.difficulty,
        groupKind: b.kind,
        count: '',
        groupCount: '',
        // Default to every question in the set: that is what an author almost
        // always means by "use this DI set", and a subset is the deliberate
        // choice, not the default.
        questionsPerGroup: 'all',
        marksPerQuestion: '1',
        [field]: value,
      };
      return { ...sec, rules: [...sec.rules, fresh] };
    }));
  };

  const clearRule = (b: Bucket) => {
    setSections((prev) => prev.map((sec, i) => i !== activeSectionIdx ? sec : {
      ...sec,
      rules: sec.rules.filter((r) => !(
        r.kind === 'group'
        && r.subject === b.subject
        && r.topic === b.topic
        && r.difficulty === b.difficulty
        && (r.groupKind ?? b.kind) === b.kind)),
    }));
  };

  if (buckets.length === 0) return null;

  const activeCount = activeSection?.rules.filter((r) => r.kind === 'group').length ?? 0;

  return (
    <div style={{ borderTop: '1px solid var(--ef-border-subtle)' }}>
      <button
        className="w-full flex items-center gap-2.5 px-5 py-3 text-left transition-colors"
        style={{ background: open ? 'var(--ef-canvas-raised)' : 'var(--ef-surface)' }}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        {open
          ? <ChevronDown size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
          : <ChevronRight size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />}
        <Layers size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
        <span className="text-xs" style={{ color: 'var(--ef-ink)' }}>Grouped sets</span>
        <span className="text-xs" style={{ color: 'var(--ef-text-muted)', fontSize: 11 }}>
          {buckets.length} available
        </span>
        {activeCount > 0 && (
          <span
            className="text-xs px-1.5 py-0.5 ml-auto"
            style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, fontSize: 10 }}
          >
            {activeCount} in use
          </span>
        )}
      </button>

      {open && (
        <div style={locked ? { pointerEvents: 'none', opacity: 0.5 } : {}}>
          <div
            className="px-5 py-2.5 flex items-start gap-2"
            style={{ background: 'var(--ef-canvas-raised)', borderTop: '1px solid var(--ef-border-subtle)' }}
          >
            <AlertTriangle size={11} strokeWidth={1.5} className="mt-0.5 flex-shrink-0" style={{ color: 'var(--ef-text-muted)' }} />
            <p style={{ color: 'var(--ef-text-muted)', fontSize: 11, lineHeight: 1.5 }}>
              You draw whole <strong>sets</strong>, not individual questions — a DI question without its
              chart is unanswerable. Grouped sets need Standard delivery and no per-question timer.
            </p>
          </div>

          {buckets.map((b) => {
            const rule = ruleFor(b);
            const dc = DIFF_COLORS[b.difficulty];
            const setsWanted = parseInt(rule?.groupCount ?? '', 10) || 0;
            const perSet = rule?.questionsPerGroup ?? 'all';
            const short = setsWanted > b.groups.length;

            // A subset larger than the smallest set in the bucket makes some of
            // those sets ineligible — warn before publish does.
            const perSetN = perSet === 'all' ? null : (parseInt(perSet, 10) || 0);
            const perSetTooBig = perSetN !== null && perSetN > b.minChildren;

            const estimate = perSetN === null
              ? null
              : setsWanted * perSetN;

            return (
              <div
                key={b.key}
                className="px-5 py-3"
                style={{ borderTop: '1px solid var(--ef-border-subtle)' }}
              >
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <span
                    className="text-xs px-1.5 py-0.5"
                    style={{ background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)', borderRadius: 2, color: 'var(--ef-text-muted)', fontSize: 10 }}
                  >
                    {GROUP_KIND_LABEL[b.kind]}
                  </span>
                  <span
                    className="text-xs px-1.5 py-0.5 capitalize"
                    style={{ background: dc.bg, color: dc.text, border: `1px solid ${dc.border}`, borderRadius: 2, fontSize: 10 }}
                  >
                    {b.difficulty}
                  </span>
                  <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{b.subject}</span>
                  <span className="text-xs" style={{ color: 'var(--ef-text-muted)', fontSize: 10 }}>›</span>
                  <span className="text-xs" style={{ color: 'var(--ef-text-muted)', fontSize: 11 }}>{b.topic}</span>
                  <span className="text-xs ml-auto" style={{ color: 'var(--ef-text-muted)', fontSize: 11 }}>
                    {b.groups.length} set{b.groups.length === 1 ? '' : 's'} in bank
                  </span>
                </div>

                <div className="flex items-end gap-3 flex-wrap">
                  <label className="flex flex-col gap-1">
                    <span className="text-xs" style={{ color: 'var(--ef-text-muted)', fontSize: 10 }}>Sets to draw</span>
                    <input
                      type="number" min={0} max={b.groups.length}
                      value={rule?.groupCount ?? ''}
                      onChange={(e) => patchRule(b, 'groupCount', e.target.value)}
                      placeholder="0"
                      style={{ ...inp, borderColor: short ? 'var(--ef-danger)' : 'var(--ef-border)' }}
                    />
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-xs" style={{ color: 'var(--ef-text-muted)', fontSize: 10 }}>Questions per set</span>
                    <select
                      value={perSet}
                      onChange={(e) => patchRule(b, 'questionsPerGroup', e.target.value)}
                      style={{ ...inp, width: 92, padding: '5px 6px' }}
                    >
                      <option value="all">All</option>
                      {Array.from({ length: b.minChildren }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={String(n)}>{n}</option>
                      ))}
                    </select>
                  </label>

                  <label className="flex flex-col gap-1">
                    <span className="text-xs" style={{ color: 'var(--ef-text-muted)', fontSize: 10 }}>Marks / question</span>
                    <input
                      type="number" min={0} step="0.5"
                      value={rule?.marksPerQuestion ?? '1'}
                      onChange={(e) => patchRule(b, 'marksPerQuestion', e.target.value)}
                      style={inp}
                    />
                  </label>

                  {rule && (
                    <button
                      type="button"
                      onClick={() => clearRule(b)}
                      className="text-xs px-2 py-1.5 transition-opacity hover:opacity-60"
                      style={{ border: '1px solid var(--ef-border)', borderRadius: 2, color: 'var(--ef-text-muted)' }}
                    >
                      Clear
                    </button>
                  )}

                  <span className="text-xs ml-auto" style={{ color: 'var(--ef-text-muted)', fontSize: 11 }}>
                    {setsWanted > 0 && (estimate !== null
                      ? `${estimate} question${estimate === 1 ? '' : 's'}`
                      /* "All" cannot be counted until the draw picks which sets,
                         and sets in a bucket may differ in size. Showing a
                         confident number here would be a guess. */
                      : `${setsWanted} set${setsWanted === 1 ? '' : 's'} · count set at publish`)}
                  </span>
                </div>

                {short && (
                  <p className="text-xs mt-2" style={{ color: 'var(--ef-danger)' }}>
                    Only {b.groups.length} set{b.groups.length === 1 ? '' : 's'} available here.
                  </p>
                )}
                {perSetTooBig && (
                  <p className="text-xs mt-2" style={{ color: 'var(--ef-danger)' }}>
                    The smallest set here has {b.minChildren} question{b.minChildren === 1 ? '' : 's'} —
                    asking for {perSetN} makes it ineligible.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
