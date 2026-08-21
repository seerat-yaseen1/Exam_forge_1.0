/**
 * The heading every stage opens with.
 *
 * One component rather than eight hand-rolled headers, because the thing that
 * makes a workspace legible is that every stage announces itself the same way:
 * what this is, and what it is for. The builder previously had three different
 * heading treatments across its three steps — a numbered "STEP 1 OF 3" block,
 * an inline "STEP 2 OF 3 — RULES & SETTINGS" strip beside a Back link, and a
 * third variant for allocation — so moving between them felt like moving
 * between three tools.
 *
 * The blurb is not decoration. Half the builder's power is in decisions an
 * author cannot evaluate without knowing what the stage governs — narrowing
 * the subject pool silently narrows every later choice, and nothing said so.
 */

import { ChevronRight, Lock } from 'lucide-react';
import { stageDef, type BuilderStage, type StageDef, type StageLock } from './stages';

export function StageHeading({
  stage,
  /** Optional trailing controls — a Back link, an action for this stage. */
  children,
}: {
  stage: BuilderStage;
  children?: React.ReactNode;
}) {
  const def = stageDef(stage);
  return (
    <div className="flex items-start justify-between gap-4 mb-7">
      <div style={{ minWidth: 0 }}>
        <h2 className="text-base mb-1" style={{ color: 'var(--ef-ink)' }}>{def.label}</h2>
        <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6, maxWidth: 620 }}>
          {def.blurb}
        </p>
      </div>
      {children && <div className="flex items-center gap-2 flex-shrink-0">{children}</div>}
    </div>
  );
}

/**
 * The locked-fields notice, shown on any stage of a published assessment.
 *
 * Previously rendered once, on step 1 only — so an author editing a live exam
 * saw the explanation on the setup screen and then met greyed-out controls on
 * the schedule and security screens with nothing to explain them.
 */
export function LockedNotice({ status }: { status: 'active' | 'closed' }) {
  return (
    <div className="flex items-start gap-2.5 mb-6 px-3 py-3"
      style={{ background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
      <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
        {status === 'active'
          ? <>Some fields are locked because this test is <strong>live</strong>. Anything a sitting student has already been promised cannot be changed underneath them.</>
          : <>Some fields are locked because this test is <strong>closed</strong>.</>}
      </p>
    </div>
  );
}

/**
 * The forward affordance, in the one shape every stage uses.
 *
 * ── WHY THIS IS SHARED ────────────────────────────────────────────
 * There were five of these — one in SetupStep, one for the settings stages in
 * DetailsStep, one after the rule matrix, one in QuestionSourceStep, and the
 * subject and topic pickers' own Next links — each hand-rolled, and by the
 * time stage locking arrived each would have needed the same three additions:
 * read the lock, disable, explain. Five copies of a rule is five chances for
 * one of them to keep walking an author into a stage the rail has shut.
 *
 * ── WHY A DISABLED BUTTON RATHER THAN A HIDDEN ONE ────────────────
 * The reason is the point. An author who cannot go forward needs to know what
 * would let them, and this is the place they are already looking — it is the
 * replacement for the "Title is required" message that sat in SetupStep for
 * the whole life of the builder and could never render, because the state
 * that would have shown it was only ever set to false.
 */
export function StageContinue({ next, lock, onNavigate }: {
  /** The stage after this one, or null at the end of the flow. */
  next: StageDef | null;
  /** That stage's lock. Open in edit mode and after the first save. */
  lock: StageLock;
  onNavigate: (id: BuilderStage) => void;
}) {
  if (!next) return null;

  if (!lock.open) {
    return (
      <div className="flex items-center justify-end gap-2.5">
        <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
          {lock.reason}
        </span>
        <span
          className="flex items-center gap-2 text-xs px-5 py-2.5"
          style={{
            background: 'var(--ef-track)', color: 'var(--ef-surface)', borderRadius: 2,
            cursor: 'not-allowed', letterSpacing: '0.03em',
          }}
        >
          <Lock size={11} strokeWidth={1.5} /> {next.label}
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-end">
      <button
        onClick={() => onNavigate(next.id)}
        className="flex items-center gap-2 text-xs px-5 py-2.5 transition-opacity hover:opacity-80"
        style={{
          background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2,
          cursor: 'pointer', letterSpacing: '0.03em',
        }}
      >
        Continue to {next.label} <ChevronRight size={12} strokeWidth={2} />
      </button>
    </div>
  );
}
