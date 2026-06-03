import { useEffect, useState } from 'react';
import { EditPanelShell, Field } from './EditPanelShell';
import { editableFields } from './useEditableFields';
import { Switch } from '../../ui/switch';
import { updateAssessmentBehaviour, type Assessment } from '../../../../lib/assessmentService';

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
  const [showResults, setShowResults] = useState(assessment.showResults);
  const [allowReview, setAllowReview] = useState(assessment.allowReview);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setShuffle(assessment.shuffleQuestions);
      setPassing(assessment.passingScore != null ? String(assessment.passingScore) : '');
      setShowResults(assessment.showResults);
      setAllowReview(assessment.allowReview);
    }
  }, [open, assessment.id]);

  const passingNum = passing.trim() === '' ? undefined : Number(passing);
  const passingValid = passingNum === undefined || (passingNum >= 0 && passingNum <= 100);

  const dirty =
    (fields.shuffleQuestions && shuffle !== assessment.shuffleQuestions) ||
    (fields.passingScore && passingNum !== assessment.passingScore) ||
    (fields.showResults && showResults !== assessment.showResults) ||
    (fields.allowReview && allowReview !== assessment.allowReview);

  const handleSave = async () => {
    setSaving(true);
    try {
      const patch: Partial<Assessment> = {};
      if (fields.shuffleQuestions) patch.shuffleQuestions = shuffle;
      if (fields.passingScore) patch.passingScore = passingNum;
      if (fields.showResults) patch.showResults = showResults;
      if (fields.allowReview) patch.allowReview = allowReview;
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
        <ToggleRow
          label="Show results after submission"
          hint="Student sees their score immediately."
          checked={showResults}
          onChange={setShowResults}
        />
      )}

      {fields.allowReview && (
        <ToggleRow
          label="Allow answer review"
          hint="Student can review their answers after submission."
          checked={allowReview}
          onChange={setAllowReview}
        />
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
