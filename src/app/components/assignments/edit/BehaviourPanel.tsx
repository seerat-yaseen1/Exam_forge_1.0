import { useEffect, useState } from 'react';
import { EditPanelShell, Field } from './EditPanelShell';
import { editableFields } from './useEditableFields';
import { Switch } from '../../ui/switch';
import { updateAssessmentBehaviour, type Assessment } from '../../../../lib/assessmentService';
import {
  deriveShowResultsTo, deriveAllowReviewTo, type VisibilityAudience,
} from '../../../../lib/visibility';
import { AudienceSelector } from '../AudienceSelector';

type Props = {
  assessment: Assessment;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (patch: Partial<Assessment>) => void;
};

export function BehaviourPanel({ assessment, open, onOpenChange, onSaved }: Props) {
  const fields = editableFields(assessment.status);

  const [shuffle, setShuffle] = useState(assessment.shuffleQuestions);
  const [passing, setPassing] = useState<string>(
    assessment.passingScore != null ? String(assessment.passingScore) : ''
  );
  // N5 final form — audience arrays are the source of truth; legacy booleans
  // are re-derived from the 'students' entry at save time.
  const [showResultsTo, setShowResultsTo] = useState<VisibilityAudience[]>(deriveShowResultsTo(assessment));
  const [allowReviewTo, setAllowReviewTo] = useState<VisibilityAudience[]>(deriveAllowReviewTo(assessment));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setShuffle(assessment.shuffleQuestions);
      setPassing(assessment.passingScore != null ? String(assessment.passingScore) : '');
      setShowResultsTo(deriveShowResultsTo(assessment));
      setAllowReviewTo(deriveAllowReviewTo(assessment));
    }
  }, [open, assessment.id]);

  const passingNum = passing.trim() === '' ? undefined : Number(passing);
  const passingValid = passingNum === undefined || (passingNum >= 0 && passingNum <= 100);

  const dirty =
    (fields.shuffleQuestions && shuffle !== assessment.shuffleQuestions) ||
    (fields.passingScore && passingNum !== assessment.passingScore) ||
    (fields.showResults && showResultsTo.join() !== deriveShowResultsTo(assessment).join()) ||
    (fields.allowReview && allowReviewTo.join() !== deriveAllowReviewTo(assessment).join());

  const handleSave = async () => {
    setSaving(true);
    try {
      const patch: Partial<Assessment> = {};
      if (fields.shuffleQuestions) patch.shuffleQuestions = shuffle;
      if (fields.passingScore) patch.passingScore = passingNum;
      if (fields.showResults) {
        patch.showResultsTo = showResultsTo;
        patch.showResults   = showResultsTo.includes('students');
      }
      if (fields.allowReview) {
        patch.allowReviewTo = allowReviewTo;
        patch.allowReview   = allowReviewTo.includes('students');
      }
      await updateAssessmentBehaviour(assessment.id, patch);
      onSaved(patch);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <EditPanelShell
      open={open}
      onOpenChange={onOpenChange}
      title="Edit behaviour"
      description="Grading and student-facing display options."
      dirty={dirty}
      saving={saving}
      canSave={passingValid}
      onSave={handleSave}
    >
      {fields.passingScore && (
        <Field label="Passing score (%)" hint="0–100. Leave blank for no pass threshold.">
          <input
            type="number"
            min={0}
            max={100}
            value={passing}
            onChange={(e) => setPassing(e.target.value)}
            className="w-full text-xs px-3 py-2"
            style={{
              border: `1px solid ${passingValid ? '#E3E1DB' : '#D97757'}`,
              borderRadius: 2, background: '#FFFFFF', color: '#0C0C0B',
            }}
          />
        </Field>
      )}

      {fields.shuffleQuestions && (
        <ToggleRow
          label="Shuffle questions"
          hint="Randomise question order per student."
          checked={shuffle}
          onChange={setShuffle}
        />
      )}

      {fields.showResults && (
        <div className="py-3" style={{ borderTop: '1px solid #F0EFEB' }}>
          <AudienceSelector
            label="Show results"
            hint="Who can see scores and outcomes after submission."
            value={showResultsTo}
            onChange={setShowResultsTo}
          />
        </div>
      )}

      {fields.allowReview && (
        <div className="py-3" style={{ borderTop: '1px solid #F0EFEB' }}>
          <AudienceSelector
            label="Allow review"
            hint="Who can see the questions and correct answers after submission."
            value={allowReviewTo}
            onChange={setAllowReviewTo}
          />
        </div>
      )}
    </EditPanelShell>
  );
}

function ToggleRow({ label, hint, checked, onChange }: {
  label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3" style={{ borderTop: '1px solid #F0EFEB' }}>
      <div className="flex-1">
        <p className="text-xs" style={{ color: '#0C0C0B' }}>{label}</p>
        {hint && <p className="text-xs mt-0.5" style={{ color: '#9A9891' }}>{hint}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}