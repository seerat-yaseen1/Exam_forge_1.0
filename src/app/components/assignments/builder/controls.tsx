/**
 * builder/controls — form controls and small building blocks of the
 * assessment builder: Field, SectionLabel, input styles, duration indicator,
 * schedule controls, segmented toggle, locked-field wrapper, difficulty row,
 * settings toggle. (Batch F1b: extracted verbatim from AssignmentsPage.tsx;
 * no logic changes.)
 */
import React from 'react';
import { Clock, Calendar, AlertTriangle, CheckCircle2, AlertCircle, Lock, Zap, Infinity as InfinityIcon } from 'lucide-react';
import { type Subject } from '../../../../lib/subjectService';
import { Difficulty, RuleDraft, DIFF_LABEL, DIFF_COLORS, dateToInputLocal } from './shared';
import { type GradingPolicy, type PenaltyType } from '../../../../lib/assessmentService';
import { formatDateTime } from '../../../../lib/dateFormat';

export function Field({ label, hint, required, children }: {
  label: string; hint?: string; required?: boolean; children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-1.5 mb-1.5">
        <label className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
          {label}{required && <span style={{ color: 'var(--ef-danger)' }}> *</span>}
        </label>
        {hint && <span style={{ color: 'var(--ef-text-muted)', fontSize: 10 }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

export function SectionLabel({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <div style={{ flex: 1, height: 1, background: 'var(--ef-border-subtle)' }} />
      <span style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em', fontSize: 10, flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, height: 1, background: 'var(--ef-border-subtle)' }} />
    </div>
  );
}

export const inputStyle: React.CSSProperties = {
  border: '1px solid var(--ef-border)', borderRadius: 2,
  color: 'var(--ef-ink)', background: 'var(--ef-surface)',
  width: '100%', fontSize: 12, padding: '7px 10px', outline: 'none',
};

export const selectStyle: React.CSSProperties = { ...inputStyle, appearance: 'auto' };

/**
 * The exam window, always resolved to something an author can read.
 *
 * ── WHAT WAS WRONG ────────────────────────────────────────────────
 * This returned `null` unless BOTH dates were set. So the default state of a
 * new assessment — start immediately, no deadline — showed nothing at all, and
 * the only description of when the paper ran was two segmented buttons plus a
 * sentence of prose under each. An author could not see the window; they had
 * to assemble it from two controls and remember which was which.
 *
 * Worse, "Start immediately" read as an ABSENCE. The field was empty, no date
 * appeared anywhere, and the natural reading of a form with no date in it is
 * that the date has not been set yet — which is exactly the state an author is
 * trying to avoid before publishing.
 *
 * Both ends now resolve to a value: immediate shows the date and time it would
 * actually open, and no-deadline says so in the same line rather than leaving
 * a blank where the reader expects a date.
 *
 * ── WHY THE CLOCK TICKS ───────────────────────────────────────────
 * `now` is state, refreshed once a minute, not a value read at render. An
 * author who opens the builder and spends twenty minutes on sections would
 * otherwise be looking at a start time twenty minutes stale — a number that is
 * wrong in the one direction that matters, since it is displayed precisely to
 * answer "when does this open".
 */
export function ScheduleWindow({ startDate, endDate, totalSectionTime = 0 }: {
  startDate: string; endDate: string; totalSectionTime?: number;
}) {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const immediate = !startDate;
  const noDeadline = !endDate;

  const s = immediate ? now : new Date(startDate);
  const e = noDeadline ? null : new Date(endDate);
  const startValid = !isNaN(s.getTime());
  const endValid = e !== null && !isNaN(e.getTime());

  // A half-typed datetime-local value. Say nothing rather than render
  // "Invalid Date" at someone mid-keystroke.
  if (!startValid || (!noDeadline && !endValid)) return null;

  const startLabel = formatDateTime(s.toISOString());
  const endLabel = noDeadline ? 'No deadline' : formatDateTime(e!.toISOString());

  const diffMins = endValid ? Math.floor((e!.getTime() - s.getTime()) / 60000) : null;

  // ── The window is inverted ──
  if (diffMins !== null && diffMins <= 0) {
    return (
      <WindowBox tone="danger" icon={<AlertTriangle size={11} strokeWidth={1.5} style={{ color: 'var(--ef-danger)', flexShrink: 0 }} />}>
        <WindowRange start={startLabel} end={endLabel} tone="danger" />
        <p className="text-xs mt-1" style={{ color: 'var(--ef-danger)', lineHeight: 1.5 }}>
          The deadline is before the start — students would never be able to begin.
        </p>
      </WindowBox>
    );
  }

  // ── The window cannot fit the paper ──
  // Unchanged rule: the window must exceed the total section time by at least
  // a minute. Only checkable when there IS a deadline; an open-ended window is
  // long enough by construction.
  const required = totalSectionTime + 1;
  if (diffMins !== null && totalSectionTime > 0 && diffMins < required) {
    const shortBy = required - diffMins;
    return (
      <WindowBox tone="danger" icon={<AlertTriangle size={11} strokeWidth={1.5} style={{ color: 'var(--ef-danger)', flexShrink: 0 }} />}>
        <WindowRange start={startLabel} end={endLabel} tone="danger" />
        <p className="text-xs mt-1" style={{ color: 'var(--ef-danger)', lineHeight: 1.5 }}>
          That window is <strong>{durationLabel(diffMins)}</strong> — too short. Extend it by at least{' '}
          <strong>{durationLabel(shortBy)}</strong> to cover every section's time limit ({totalSectionTime}m) plus a minute's buffer.
        </p>
      </WindowBox>
    );
  }

  return (
    <WindowBox tone="ok" icon={<Clock size={11} strokeWidth={1.5} style={{ color: 'var(--ef-success-strong)', flexShrink: 0 }} />}>
      <WindowRange start={startLabel} end={endLabel} tone="ok" />
      <p className="text-xs mt-1" style={{ color: 'var(--ef-success-strong)', opacity: 0.85, lineHeight: 1.5 }}>
        {immediate && noDeadline
          ? 'Opens the moment you publish and stays open until you close it.'
          : immediate
            ? `Opens the moment you publish · ${durationLabel(diffMins!)} window`
            : noDeadline
              ? 'Stays open until you close it.'
              : `${durationLabel(diffMins!)} window`}
      </p>
    </WindowBox>
  );
}

/** `start —— end`, the shape the author asked to see the schedule in. */
function WindowRange({ start, end, tone }: { start: string; end: string; tone: 'ok' | 'danger' }) {
  const color = tone === 'ok' ? 'var(--ef-success-strong)' : 'var(--ef-danger)';
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <span className="text-xs" style={{ color }}><strong>{start}</strong></span>
      <span className="text-xs" style={{ color, opacity: 0.5 }}>——</span>
      <span className="text-xs" style={{ color }}><strong>{end}</strong></span>
    </div>
  );
}

function WindowBox({ tone, icon, children }: {
  tone: 'ok' | 'danger'; icon: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2 px-3 py-2.5"
      style={{
        background: tone === 'ok' ? 'var(--ef-success-bg)' : 'var(--ef-danger-bg)',
        border: `1px solid ${tone === 'ok' ? 'var(--ef-success-border)' : 'var(--ef-danger-border)'}`,
        borderRadius: 2,
      }}>
      <span style={{ marginTop: 2 }}>{icon}</span>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

/** 95 → "1h 35m". */
function durationLabel(mins: number): string {
  const h = Math.floor(mins / 60), m = mins % 60;
  return h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ''}` : `${m}m`;
}

// ── Field mutability ──────────────────────────────────────────────

export function PresetChip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-2.5 py-1 transition-all"
      style={{
        background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 999,
        fontSize: 11, color: 'var(--ef-text-subtle)', letterSpacing: '0.01em',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'var(--ef-ink)';
        (e.currentTarget as HTMLElement).style.color = 'var(--ef-surface)';
        (e.currentTarget as HTMLElement).style.borderColor = 'var(--ef-ink)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'var(--ef-surface)';
        (e.currentTarget as HTMLElement).style.color = 'var(--ef-text-subtle)';
        (e.currentTarget as HTMLElement).style.borderColor = 'var(--ef-border)';
      }}
    >
      {label}
    </button>
  );
}

export function SegmentedToggle({
  leftLabel, rightLabel, leftIcon, rightIcon, isLeft, onLeft, onRight,
}: {
  leftLabel: string; rightLabel: string;
  leftIcon: React.ReactNode; rightIcon: React.ReactNode;
  isLeft: boolean; onLeft: () => void; onRight: () => void;
}) {
  const btn = (active: boolean): React.CSSProperties => ({
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
    gap: 6, padding: '7px 10px', fontSize: 11, letterSpacing: '0.02em',
    background: active ? 'var(--ef-ink)' : 'transparent',
    color: active ? 'var(--ef-surface)' : 'var(--ef-text-muted)',
    transition: 'all 0.15s',
    cursor: active ? 'default' : 'pointer',
  });
  return (
    <div className="flex" style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)', overflow: 'hidden' }}>
      <button type="button" onClick={onLeft} style={btn(isLeft)}>{leftIcon}{leftLabel}</button>
      <button type="button" onClick={onRight} style={btn(!isLeft)}>{rightIcon}{rightLabel}</button>
    </div>
  );
}

export function StartScheduleControl({
  startDate, setStartDate,
}: { startDate: string; setStartDate: (v: string) => void }) {
  const isImmediate = !startDate;

  const setRelative = (mins: number) => {
    const d = new Date(Date.now() + mins * 60000);
    setStartDate(dateToInputLocal(d));
  };
  const setTomorrow9 = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    setStartDate(dateToInputLocal(d));
  };
  const switchToScheduled = () => {
    if (!startDate) setRelative(60);
  };

  return (
    <Field label="Start">
      <div className="space-y-2">
        <SegmentedToggle
          leftLabel="Start immediately"
          rightLabel="Schedule for later"
          leftIcon={<Zap size={11} strokeWidth={1.5} />}
          rightIcon={<Calendar size={11} strokeWidth={1.5} />}
          isLeft={isImmediate}
          onLeft={() => setStartDate('')}
          onRight={switchToScheduled}
        />

        {/* No prose under the immediate branch. It used to read "Students can
            begin as soon as the assessment is published", which ScheduleWindow
            now says a few pixels below — and says better, because it says it
            beside the actual date. Two statements of one fact within one
            screen is how an author learns to read neither. */}
        {isImmediate ? null : (
          <>
            <div className="flex items-center gap-2 px-3 py-2"
              style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}>
              <Calendar size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
              <input type="datetime-local" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                className="flex-1 outline-none"
                style={{ background: 'transparent', color: 'var(--ef-ink)', fontSize: 12, border: 'none' }} />
            </div>
            <div className="flex flex-wrap gap-1.5">
              <PresetChip label="In 15 min" onClick={() => setRelative(15)} />
              <PresetChip label="In 1 hr" onClick={() => setRelative(60)} />
              <PresetChip label="Tomorrow 9 AM" onClick={setTomorrow9} />
            </div>
          </>
        )}
      </div>
    </Field>
  );
}

export function EndScheduleControl({
  endDate, setEndDate, startDate,
}: { endDate: string; setEndDate: (v: string) => void; startDate: string }) {
  const hasDeadline = !!endDate;

  const baseDate = (): Date => {
    if (startDate) {
      const d = new Date(startDate);
      if (!isNaN(d.getTime())) return d;
    }
    return new Date();
  };

  const setRelative = (mins: number) => {
    const d = new Date(baseDate().getTime() + mins * 60000);
    setEndDate(dateToInputLocal(d));
  };
  const switchToDeadline = () => {
    if (!endDate) setRelative(60);
  };

  return (
    <Field label="End">
      <div className="space-y-2">
        <SegmentedToggle
          leftLabel="No deadline"
          rightLabel="Set deadline"
          leftIcon={<InfinityIcon size={11} strokeWidth={1.5} />}
          rightIcon={<Calendar size={11} strokeWidth={1.5} />}
          isLeft={!hasDeadline}
          onLeft={() => setEndDate('')}
          onRight={switchToDeadline}
        />

        {/* Same as the start control: the window summary below states this. */}
        {!hasDeadline ? null : (
          <>
            <div className="flex items-center gap-2 px-3 py-2"
              style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}>
              <Calendar size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
              <input type="datetime-local" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                className="flex-1 outline-none"
                style={{ background: 'transparent', color: 'var(--ef-ink)', fontSize: 12, border: 'none' }}
                min={startDate || undefined} />
            </div>
            <div className="flex flex-wrap gap-1.5">
              <PresetChip label="+30 min" onClick={() => setRelative(30)} />
              <PresetChip label="+1 hr" onClick={() => setRelative(60)} />
              <PresetChip label="+2 hr" onClick={() => setRelative(120)} />
              <PresetChip label="+1 day" onClick={() => setRelative(60 * 24)} />
            </div>
            <p className="text-xs px-1" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.5 }}>
              Presets are relative to {startDate ? 'the start time' : 'now'}.
            </p>
          </>
        )}
      </div>
    </Field>
  );
}

// ── Locked field wrapper ──────────────────────────────────────────

export function LockedFieldWrapper({ label, reason, children }: {
  label: string; reason: string; children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{label}</span>
        <div className="flex items-center gap-1">
          <Lock size={9} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
          <span style={{ color: 'var(--ef-text-muted)', fontSize: 10 }}>{reason}</span>
        </div>
      </div>
      <div style={{ opacity: 0.4, pointerEvents: 'none', userSelect: 'none' }}>
        {children}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// RULE BUILDER — right-panel component for step 2
// Three-level hierarchy: Subject → Topic → Difficulty
// ══════════════════════════════════════════════════════════════════

// PenaltyInput — the penalty type (fixed marks | percent of the question's
// marks) + magnitude. Shared by the exam default, section override, and the
// per-difficulty-row override. Teacher types a POSITIVE number; the server
// subtracts it. Emits partial GradingPolicy patches.
export function PenaltyInput({
  policy, onChange, compact,
}: {
  policy: GradingPolicy;
  onChange: (patch: Partial<GradingPolicy>) => void;
  compact?: boolean;
}) {
  const type: PenaltyType = policy.penaltyType ?? 'fixed';
  return (
    <div className="flex items-center gap-1.5">
      {/* type toggle */}
      <div className="flex" style={{ borderRadius: 2, overflow: 'hidden', border: '1px solid var(--ef-border)' }}>
        {(['fixed', 'percent'] as PenaltyType[]).map((t) => {
          const active = type === t;
          return (
            <button
              key={t}
              type="button"
              onClick={() => onChange({ penaltyType: t })}
              style={{
                fontSize: compact ? 10 : 11,
                padding: compact ? '2px 6px' : '4px 9px',
                background: active ? 'var(--ef-danger)' : 'var(--ef-surface)',
                color: active ? 'var(--ef-surface)' : 'var(--ef-text-muted)',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              {t === 'fixed' ? 'marks' : '%'}
            </button>
          );
        })}
      </div>
      {/* magnitude */}
      <div className="flex items-center gap-1 px-2 py-1"
        style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}>
        <span style={{ color: 'var(--ef-danger)', fontSize: compact ? 11 : 12 }}>−</span>
        <input
          type="number"
          value={policy.penaltyValue ?? ''}
          onChange={(e) => onChange({ penaltyValue: e.target.value === '' ? undefined : Math.max(0, parseFloat(e.target.value)) })}
          placeholder="0"
          min="0"
          step={type === 'percent' ? '5' : '0.5'}
          className="outline-none text-center"
          style={{
            width: compact ? 40 : 48, fontSize: compact ? 11 : 12, border: 'none',
            background: 'transparent', color: 'var(--ef-ink)',
          }}
        />
        <span style={{ color: 'var(--ef-text-muted)', fontSize: 10 }}>{type === 'percent' ? '%' : 'mk'}</span>
      </div>
    </div>
  );
}

export function DifficultyRow({
  diff, available, bankTotal, rule,
  onCountChange, onMarksChange,
  negMarkingOn, rowPolicy, inheritedPenaltyLabel, onRowPolicyChange,
}: {
  diff: Difficulty;
  available: number;
  bankTotal: number;
  rule: RuleDraft | undefined;
  onCountChange: (v: string) => void;
  onMarksChange: (v: string) => void;
  // Negative-marking per-level override (Standard/Linear only). When
  // negMarkingOn is false the whole control is hidden (hard gate closed).
  // rowPolicy is this row's own override (undefined = inherit); the resolved
  // inherited value is shown as placeholder text so the teacher sees what
  // "inherit" means. onRowPolicyChange emits a partial patch (or clears).
  negMarkingOn?: boolean;
  rowPolicy?: GradingPolicy;
  inheritedPenaltyLabel?: string;
  onRowPolicyChange?: (patch: Partial<GradingPolicy> | null) => void;
}) {
  const count = parseInt(rule?.count ?? '', 10) || 0;
  const isEmpty = bankTotal === 0;
  const isOver = count > available;
  const hasValue = count > 0;
  const dc = DIFF_COLORS[diff];
  const rowOverrides = !!rowPolicy && (rowPolicy.penaltyValue !== undefined || rowPolicy.negativeMarking === false);

  return (
    <div
      className="flex items-center gap-2.5 py-1.5 px-3 mx-2 my-0.5"
      style={{
        borderRadius: 2,
        border: hasValue ? `1px solid ${isOver ? 'var(--ef-danger-border)' : 'var(--ef-border)'}` : '1px solid transparent',
        background: hasValue ? (isOver ? 'var(--ef-danger-bg)' : 'var(--ef-surface)') : 'transparent',
        opacity: isEmpty ? 0.4 : 1,
      }}
    >
      {/* Difficulty badge */}
      <span
        className="flex-shrink-0 capitalize"
        style={{
          background: dc.bg, color: dc.text, border: `1px solid ${dc.border}`,
          borderRadius: 2, fontSize: 10, padding: '2px 7px', minWidth: 48, textAlign: 'center',
        }}
      >
        {DIFF_LABEL[diff]}
      </span>

      {/* Available count */}
      <span className="flex-shrink-0 text-xs" style={{ color: available === 0 ? 'var(--ef-text-muted)' : 'var(--ef-text-muted)', minWidth: 62 }}>
        {isEmpty ? 'none in bank' : `${available} avail.`}
      </span>

      {/* Pick count */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <span style={{ color: 'var(--ef-text-muted)', fontSize: 11 }}>pick</span>
        <input
          type="number"
          disabled={isEmpty}
          value={rule?.count ?? ''}
          onChange={(e) => onCountChange(e.target.value)}
          placeholder="0"
          min="0"
          max={available}
          className="outline-none text-center"
          style={{
            width: 38, padding: '3px 4px', fontSize: 12, borderRadius: 2,
            border: `1px solid ${isOver ? 'var(--ef-danger-border)' : 'var(--ef-border)'}`,
            background: isOver ? 'var(--ef-danger-bg)' : 'var(--ef-surface)',
            color: isOver ? 'var(--ef-danger)' : 'var(--ef-ink)',
            cursor: isEmpty ? 'not-allowed' : 'text',
          }}
        />
      </div>

      {/* Marks per Q */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <input
          type="number"
          disabled={isEmpty}
          value={rule?.marksPerQuestion ?? ''}
          onChange={(e) => onMarksChange(e.target.value)}
          placeholder="1"
          min="0.5"
          step="0.5"
          className="outline-none text-center"
          style={{
            width: 38, padding: '3px 4px', fontSize: 12, borderRadius: 2,
            border: '1px solid var(--ef-border)', background: 'var(--ef-surface)', color: 'var(--ef-ink)',
            cursor: isEmpty ? 'not-allowed' : 'text',
          }}
        />
        <span style={{ color: 'var(--ef-text-muted)', fontSize: 10 }}>mk/Q</span>
      </div>

      {/* Per-level negative-marking override (Standard/Linear, gate open) */}
      {negMarkingOn && !isEmpty && hasValue && onRowPolicyChange && (
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {rowOverrides ? (
            <>
              <PenaltyInput compact policy={rowPolicy ?? {}} onChange={(patch) => onRowPolicyChange(patch)} />
              <button
                type="button"
                onClick={() => onRowPolicyChange(null)}
                title="Reset to inherited penalty"
                style={{ fontSize: 10, color: 'var(--ef-text-muted)', padding: '2px 4px', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                reset
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => onRowPolicyChange({ penaltyValue: 0 })}
              title="Override the penalty for this difficulty"
              className="flex items-center gap-1"
              style={{
                fontSize: 10, color: 'var(--ef-text-muted)', padding: '2px 7px',
                border: '1px dashed var(--ef-border)', borderRadius: 2, background: 'transparent', cursor: 'pointer',
              }}
            >
              <span style={{ color: 'var(--ef-text-muted)' }}>−penalty:</span>
              <span>{inheritedPenaltyLabel ?? 'inherited'}</span>
            </button>
          )}
        </div>
      )}

      {/* Subtotal + status */}
      <div className="flex items-center gap-1.5 ml-auto flex-shrink-0">
        {hasValue && !isOver && (
          <span style={{ color: 'var(--ef-text-muted)', fontSize: 10 }}>
            {count * (parseFloat(rule?.marksPerQuestion ?? '') || 1)} mk
          </span>
        )}
        {hasValue && (
          isOver
            ? <div className="flex items-center gap-0.5">
                <AlertCircle size={11} strokeWidth={1.5} style={{ color: 'var(--ef-danger)' }} />
                <span style={{ color: 'var(--ef-danger)', fontSize: 10 }}>only {available}</span>
              </div>
            : <CheckCircle2 size={12} strokeWidth={1.5} style={{ color: 'var(--ef-success-strong)' }} />
        )}
      </div>
    </div>
  );
}


// ── Settings toggle row ───────────────────────────────────────────

export function SettingsToggle({ icon, label, hint, value, onChange, locked, lockReason }: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  value: boolean;
  onChange: (v: boolean) => void;
  locked?: boolean;
  lockReason?: string;
}) {
  return (
    <button
      type="button"
      onClick={locked ? undefined : () => onChange(!value)}
      className="w-full flex items-center gap-4 px-4 py-3 text-left transition-colors"
      style={{
        border: '1px solid var(--ef-border)',
        borderRadius: 2,
        background: value ? 'var(--ef-canvas-raised)' : 'var(--ef-surface)',
        opacity: locked ? 0.45 : 1,
        cursor: locked ? 'default' : 'pointer',
        pointerEvents: locked ? 'none' : 'auto',
      }}
    >
      {/* Icon */}
      <div className="flex items-center justify-center flex-shrink-0"
        style={{ width: 28, height: 28, borderRadius: 2, background: 'var(--ef-canvas)', border: '1px solid var(--ef-border-subtle)' }}>
        {icon}
      </div>

      {/* Label + hint */}
      <div className="flex-1 min-w-0">
        <p className="text-xs" style={{ color: 'var(--ef-ink)' }}>{label}</p>
        <p className="text-xs mt-0.5" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.5 }}>{hint}</p>
      </div>

      {/* Lock indicator or toggle track */}
      {locked ? (
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <Lock size={10} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
          {lockReason && <span style={{ color: 'var(--ef-text-muted)', fontSize: 10 }}>{lockReason}</span>}
        </div>
      ) : (
        <div
          className="flex-shrink-0 transition-colors"
          style={{
            width: 34,
            height: 18,
            borderRadius: 9,
            background: value ? 'var(--ef-ink)' : 'var(--ef-track)',
            position: 'relative',
          }}
        >
          <div
            className="transition-transform"
            style={{
              position: 'absolute',
              top: 3,
              left: value ? 18 : 3,
              width: 12,
              height: 12,
              borderRadius: '50%',
              background: 'var(--ef-surface)',
            }}
          />
        </div>
      )}
    </button>
  );
}

// ══════════════════════════════════════════════════════════════════
// INSTITUTE PICKER — inline checkbox list for "Specific Institutes"
// ══════════════════════════════════════════════════════════════════