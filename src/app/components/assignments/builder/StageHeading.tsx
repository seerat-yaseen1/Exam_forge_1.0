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

import { stageDef, type BuilderStage } from './stages';

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
