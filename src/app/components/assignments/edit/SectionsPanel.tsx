import { EditPanelShell } from './EditPanelShell';
import type { Assessment } from '../../../../lib/assessmentService';

type Props = {
  assessment: Assessment;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenLegacyEditor: () => void;
};

/** Sections + question rules are only editable in draft. The existing
 *  full-page builder (AssessmentPanel) handles this surface; this panel
 *  is a thin launcher so the EditMenu can route to it consistently. */
export function SectionsPanel({ assessment, open, onOpenChange, onOpenLegacyEditor }: Props) {
  if (assessment.status !== 'draft') return null;

  return (
    <EditPanelShell
      open={open}
      onOpenChange={onOpenChange}
      title="Edit sections & questions"
      description="Open the full builder to add sections, change rules, or repick questions."
      dirty={false}
      saving={false}
      canSave={false}
      onSave={() => {}}
    >
      <p className="text-xs mb-4" style={{ color: '#4A4A45' }}>
        Section structure, question selection rules, and per-section time limits are
        edited in the full builder. Once this assessment is published, sections become locked.
      </p>
      <button
        onClick={() => { onOpenChange(false); onOpenLegacyEditor(); }}
        className="text-xs px-4 py-2 transition-opacity hover:opacity-80"
        style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2 }}
      >
        Open full builder
      </button>
    </EditPanelShell>
  );
}
