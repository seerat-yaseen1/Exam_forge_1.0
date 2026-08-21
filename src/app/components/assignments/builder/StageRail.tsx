/**
 * The builder's left rail: where you are, where you can go, and what you have
 * built so far.
 *
 * Every stage is always clickable. That is the point of the change — see
 * stages.ts for why the wizard it replaced was the wrong shape — and it means
 * this component has no concept of a locked or future stage. Completeness is
 * reported, never enforced; the publish path is what enforces.
 *
 * The paper summary sits at the BOTTOM of this rail rather than in a third
 * column, for two reasons. It keeps the builder to two columns, so the stage
 * content never has to compete with a side panel for width on a 1280px laptop.
 * And it puts "what have I built" directly under "what am I building" —
 * the author reads the rail top to bottom and ends on the answer.
 */

import { CheckCircle2, Circle, AlertCircle } from 'lucide-react';
import {
  type BuilderStage,
  type PaperTotals,
  type StageDef,
  type StageStatus,
} from './stages';

export function StageRail({
  stages,
  current,
  statusFor,
  totals,
  onSelect,
}: {
  /** The stages THIS draft has — see visibleBuilderStages. Not always all of
   *  them: a hand-picked, non-randomized paper has no topic or matrix work
   *  left to do, and showing those rows would offer work that cannot exist. */
  stages: readonly StageDef[];
  current: BuilderStage;
  statusFor: (id: BuilderStage) => StageStatus;
  totals: PaperTotals;
  onSelect: (id: BuilderStage) => void;
}) {
  return (
    <div
      className="flex flex-col flex-shrink-0"
      style={{
        width: 236,
        borderRight: '1px solid var(--ef-border)',
        background: 'var(--ef-surface)',
      }}
    >
      {/* ── Stages ── */}
      <div className="flex-1 overflow-y-auto py-4">
        {stages.map((stage) => {
          const status = statusFor(stage.id);
          const isCurrent = current === stage.id;
          return (
            <button
              key={stage.id}
              onClick={() => onSelect(stage.id)}
              className="w-full flex items-center gap-2.5 px-4 text-left transition-colors"
              style={{
                minHeight: 38,
                background: isCurrent ? 'var(--ef-canvas)' : 'transparent',
                // A left edge rather than a filled pill: the rail is read as a
                // list, and a solid block would make the current row look like
                // a button among labels.
                borderLeft: `2px solid ${isCurrent ? 'var(--ef-ink)' : 'transparent'}`,
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                if (!isCurrent) (e.currentTarget as HTMLElement).style.background = 'var(--ef-canvas-raised)';
              }}
              onMouseLeave={(e) => {
                if (!isCurrent) (e.currentTarget as HTMLElement).style.background = 'transparent';
              }}
            >
              <StageMark status={status} />
              <span
                className="text-xs flex-1 truncate"
                style={{ color: isCurrent ? 'var(--ef-ink)' : 'var(--ef-text-subtle)' }}
              >
                {stage.label}
              </span>
              {status.detail && (
                <span
                  className="text-xs flex-shrink-0"
                  style={{ color: status.state === 'todo' ? 'var(--ef-warning)' : 'var(--ef-text-muted)' }}
                >
                  {status.detail}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <PaperSummary totals={totals} />
    </div>
  );
}

/**
 * The state marker.
 *
 * 'todo' is amber, not red. Red says "you broke something"; amber says "this
 * still wants you". An author three minutes into a new assessment has four
 * unfinished required stages and has done nothing wrong — a rail of red dots
 * would be an accusation at the exact moment they need encouragement.
 */
function StageMark({ status }: { status: StageStatus }) {
  if (status.state === 'done') {
    return <CheckCircle2 size={12} strokeWidth={1.5} style={{ color: 'var(--ef-success-strong)', flexShrink: 0 }} />;
  }
  if (status.state === 'todo') {
    return <AlertCircle size={12} strokeWidth={1.5} style={{ color: 'var(--ef-warning)', flexShrink: 0 }} />;
  }
  return <Circle size={12} strokeWidth={1.25} style={{ color: 'var(--ef-border-muted)', flexShrink: 0 }} />;
}

/**
 * What the author has actually built.
 *
 * The old builder showed this as a single chip in the top bar — "3 sections ·
 * 45 Q · 90 marks" — and only from step 2 onward, so for the whole of the
 * section-building work, when the numbers are changing with every edit and are
 * the only feedback that the rules did what was intended, there was nothing.
 *
 * `approximate` matters more than it looks. A group rule drawing 'all' of its
 * children has no count until the draw at publish, so a bare "45" would be a
 * confident lie. "≥ 45" is the honest reading and it is also the useful one:
 * it tells the author the paper is at least this big.
 */
function PaperSummary({ totals }: { totals: PaperTotals }) {
  const empty = totals.sections === 0 || (totals.questions === 0 && !totals.approximate);
  const approx = totals.approximate ? '≥ ' : '';

  return (
    <div
      className="flex-shrink-0 px-4 py-4"
      style={{ borderTop: '1px solid var(--ef-border)', background: 'var(--ef-canvas-raised)' }}
    >
      <p className="text-xs mb-3" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>
        THIS PAPER
      </p>

      {empty ? (
        <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
          Nothing yet. Add a section and a question rule and it will appear here.
        </p>
      ) : (
        <div className="space-y-2">
          <SummaryRow label="Sections" value={String(totals.sections)} />
          <SummaryRow label="Questions" value={`${approx}${totals.questions}`} />
          <SummaryRow label="Marks" value={`${approx}${totals.marks}`} />
          {totals.minutes > 0 && (
            <SummaryRow label="Time" value={formatMinutes(totals.minutes)} />
          )}
        </div>
      )}
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{label}</span>
      <span className="text-xs tabular-nums" style={{ color: 'var(--ef-ink)' }}>{value}</span>
    </div>
  );
}

/** 90 → "1h 30m". Authors think in hours once a paper passes one. */
export function formatMinutes(total: number): string {
  if (total < 60) return `${total}m`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
