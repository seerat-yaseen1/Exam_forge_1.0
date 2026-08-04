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

export function Field({ label, hint, required, children }: {
  label: string; hint?: string; required?: boolean; children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-1.5 mb-1.5">
        <label className="text-xs" style={{ color: '#6B6B66' }}>
          {label}{required && <span style={{ color: '#9B2828' }}> *</span>}
        </label>
        {hint && <span style={{ color: '#6B6B66', fontSize: 10 }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

export function SectionLabel({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 pt-1">
      <div style={{ flex: 1, height: 1, background: '#F0EFEB' }} />
      <span style={{ color: '#6B6B66', letterSpacing: '0.1em', fontSize: 10, flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, height: 1, background: '#F0EFEB' }} />
    </div>
  );
}

export const inputStyle: React.CSSProperties = {
  border: '1px solid #E3E1DB', borderRadius: 2,
  color: '#0C0C0B', background: '#FFFFFF',
  width: '100%', fontSize: 12, padding: '7px 10px', outline: 'none',
};

export const selectStyle: React.CSSProperties = { ...inputStyle, appearance: 'auto' };

export function DurationIndicator({ startDate, endDate, totalSectionTime = 0 }: {
  startDate: string; endDate: string; totalSectionTime?: number;
}) {
  const s = new Date(startDate), e = new Date(endDate);
  if (isNaN(s.getTime()) || isNaN(e.getTime()) || e <= s) return null;
  const diffMins = Math.floor((e.getTime() - s.getTime()) / 60000);
  const h = Math.floor(diffMins / 60), m = diffMins % 60;
  const label = h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ''}` : `${m}m`;

  const required = totalSectionTime + 1; // window must be at least 1 min more than total section time
  const tooShort = totalSectionTime > 0 && diffMins < required;

  if (tooShort) {
    const shortBy = required - diffMins;
    const shortLabel = shortBy >= 60
      ? `${Math.floor(shortBy / 60)}h${shortBy % 60 > 0 ? ` ${shortBy % 60}m` : ''}`
      : `${shortBy}m`;
    return (
      <div className="flex items-center gap-2 px-3 py-2"
        style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2 }}>
        <AlertTriangle size={11} strokeWidth={1.5} style={{ color: '#9B2828', flexShrink: 0 }} />
        <span className="text-xs" style={{ color: '#9B2828' }}>
          Window <strong>{label}</strong> is too short — extend by at least <strong>{shortLabel}</strong> to cover all section time limits ({totalSectionTime}m total) plus a 1m buffer.
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2"
      style={{ background: '#F0F9F4', border: '1px solid #B8E6C8', borderRadius: 2 }}>
      <Clock size={11} strokeWidth={1.5} style={{ color: '#1E7B3C', flexShrink: 0 }} />
      <span className="text-xs" style={{ color: '#1E7B3C' }}>Window duration: <strong>{label}</strong></span>
    </div>
  );
}

// ── Field mutability ──────────────────────────────────────────────

export function PresetChip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-2.5 py-1 transition-all"
      style={{
        background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 999,
        fontSize: 11, color: '#4A4A45', letterSpacing: '0.01em',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = '#0C0C0B';
        (e.currentTarget as HTMLElement).style.color = '#FFFFFF';
        (e.currentTarget as HTMLElement).style.borderColor = '#0C0C0B';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = '#FFFFFF';
        (e.currentTarget as HTMLElement).style.color = '#4A4A45';
        (e.currentTarget as HTMLElement).style.borderColor = '#E3E1DB';
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
    background: active ? '#0C0C0B' : 'transparent',
    color: active ? '#FFFFFF' : '#6B6B66',
    transition: 'all 0.15s',
    cursor: active ? 'default' : 'pointer',
  });
  return (
    <div className="flex" style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF', overflow: 'hidden' }}>
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

        {isImmediate ? (
          <p className="text-xs flex items-start gap-1.5 px-1" style={{ color: '#6B6B66', lineHeight: 1.5 }}>
            <Zap size={10} strokeWidth={1.5} style={{ flexShrink: 0, marginTop: 2 }} />
            Students can begin as soon as the assessment is published.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2 px-3 py-2"
              style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}>
              <Calendar size={12} strokeWidth={1.5} style={{ color: '#6B6B66', flexShrink: 0 }} />
              <input type="datetime-local" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                className="flex-1 outline-none"
                style={{ background: 'transparent', color: '#0C0C0B', fontSize: 12, border: 'none' }} />
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

        {!hasDeadline ? (
          <p className="text-xs flex items-start gap-1.5 px-1" style={{ color: '#6B6B66', lineHeight: 1.5 }}>
            <InfinityIcon size={10} strokeWidth={1.5} style={{ flexShrink: 0, marginTop: 2 }} />
            The assessment stays open until you close it manually.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2 px-3 py-2"
              style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}>
              <Calendar size={12} strokeWidth={1.5} style={{ color: '#6B6B66', flexShrink: 0 }} />
              <input type="datetime-local" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                className="flex-1 outline-none"
                style={{ background: 'transparent', color: '#0C0C0B', fontSize: 12, border: 'none' }}
                min={startDate || undefined} />
            </div>
            <div className="flex flex-wrap gap-1.5">
              <PresetChip label="+30 min" onClick={() => setRelative(30)} />
              <PresetChip label="+1 hr" onClick={() => setRelative(60)} />
              <PresetChip label="+2 hr" onClick={() => setRelative(120)} />
              <PresetChip label="+1 day" onClick={() => setRelative(60 * 24)} />
            </div>
            <p className="text-xs px-1" style={{ color: '#6B6B66', lineHeight: 1.5 }}>
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
        <span className="text-xs" style={{ color: '#6B6B66' }}>{label}</span>
        <div className="flex items-center gap-1">
          <Lock size={9} strokeWidth={1.5} style={{ color: '#6B6B66' }} />
          <span style={{ color: '#6B6B66', fontSize: 10 }}>{reason}</span>
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
      <div className="flex" style={{ borderRadius: 2, overflow: 'hidden', border: '1px solid #E3E1DB' }}>
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
                background: active ? '#9B2828' : '#FFFFFF',
                color: active ? '#FFFFFF' : '#6B6A65',
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
        style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}>
        <span style={{ color: '#9B2828', fontSize: compact ? 11 : 12 }}>−</span>
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
            background: 'transparent', color: '#0C0C0B',
          }}
        />
        <span style={{ color: '#6B6B66', fontSize: 10 }}>{type === 'percent' ? '%' : 'mk'}</span>
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
        border: hasValue ? `1px solid ${isOver ? '#F2CECE' : '#E3E1DB'}` : '1px solid transparent',
        background: hasValue ? (isOver ? '#FDF5F5' : '#FFFFFF') : 'transparent',
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
      <span className="flex-shrink-0 text-xs" style={{ color: available === 0 ? '#6B6B66' : '#6B6B66', minWidth: 62 }}>
        {isEmpty ? 'none in bank' : `${available} avail.`}
      </span>

      {/* Pick count */}
      <div className="flex items-center gap-1 flex-shrink-0">
        <span style={{ color: '#6B6B66', fontSize: 11 }}>pick</span>
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
            border: `1px solid ${isOver ? '#F2CECE' : '#E3E1DB'}`,
            background: isOver ? '#FDF5F5' : '#FFFFFF',
            color: isOver ? '#9B2828' : '#0C0C0B',
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
            border: '1px solid #E3E1DB', background: '#FFFFFF', color: '#0C0C0B',
            cursor: isEmpty ? 'not-allowed' : 'text',
          }}
        />
        <span style={{ color: '#6B6B66', fontSize: 10 }}>mk/Q</span>
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
                style={{ fontSize: 10, color: '#6B6B66', padding: '2px 4px', background: 'none', border: 'none', cursor: 'pointer' }}
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
                fontSize: 10, color: '#6B6B66', padding: '2px 7px',
                border: '1px dashed #E3E1DB', borderRadius: 2, background: 'transparent', cursor: 'pointer',
              }}
            >
              <span style={{ color: '#6B6B66' }}>−penalty:</span>
              <span>{inheritedPenaltyLabel ?? 'inherited'}</span>
            </button>
          )}
        </div>
      )}

      {/* Subtotal + status */}
      <div className="flex items-center gap-1.5 ml-auto flex-shrink-0">
        {hasValue && !isOver && (
          <span style={{ color: '#6B6B66', fontSize: 10 }}>
            {count * (parseFloat(rule?.marksPerQuestion ?? '') || 1)} mk
          </span>
        )}
        {hasValue && (
          isOver
            ? <div className="flex items-center gap-0.5">
                <AlertCircle size={11} strokeWidth={1.5} style={{ color: '#9B2828' }} />
                <span style={{ color: '#9B2828', fontSize: 10 }}>only {available}</span>
              </div>
            : <CheckCircle2 size={12} strokeWidth={1.5} style={{ color: '#1E7B3C' }} />
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
        border: '1px solid #E3E1DB',
        borderRadius: 2,
        background: value ? '#FAFAF8' : '#FFFFFF',
        opacity: locked ? 0.45 : 1,
        cursor: locked ? 'default' : 'pointer',
        pointerEvents: locked ? 'none' : 'auto',
      }}
    >
      {/* Icon */}
      <div className="flex items-center justify-center flex-shrink-0"
        style={{ width: 28, height: 28, borderRadius: 2, background: '#F7F6F3', border: '1px solid #EEECEA' }}>
        {icon}
      </div>

      {/* Label + hint */}
      <div className="flex-1 min-w-0">
        <p className="text-xs" style={{ color: '#0C0C0B' }}>{label}</p>
        <p className="text-xs mt-0.5" style={{ color: '#6B6B66', lineHeight: 1.5 }}>{hint}</p>
      </div>

      {/* Lock indicator or toggle track */}
      {locked ? (
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <Lock size={10} strokeWidth={1.5} style={{ color: '#6B6B66' }} />
          {lockReason && <span style={{ color: '#6B6B66', fontSize: 10 }}>{lockReason}</span>}
        </div>
      ) : (
        <div
          className="flex-shrink-0 transition-colors"
          style={{
            width: 34,
            height: 18,
            borderRadius: 9,
            background: value ? '#0C0C0B' : '#D9D8D3',
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
              background: '#FFFFFF',
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