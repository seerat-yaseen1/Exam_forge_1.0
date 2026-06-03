import { useEffect, useState } from 'react';
import { EditPanelShell, Field } from './EditPanelShell';
import { editableFields } from './useEditableFields';
import { updateAssessmentSchedule, type Assessment } from '../../../../lib/assessmentService';

type Props = {
  assessment: Assessment;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (patch: Partial<Assessment>) => void;
};

// Convert ISO string → value for <input type="datetime-local">
function toLocal(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocal(local: string): string | undefined {
  return local ? new Date(local).toISOString() : undefined;
}

export function SchedulePanel({ assessment, open, onOpenChange, onSaved }: Props) {
  const fields = editableFields(assessment.status);

  const [startDate, setStartDate] = useState(toLocal(assessment.startDate));
  const [endDate, setEndDate] = useState(toLocal(assessment.endDate));
  const [maxAttempts, setMaxAttempts] = useState<string>(
    assessment.maxAttempts != null ? String(assessment.maxAttempts) : ''
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setStartDate(toLocal(assessment.startDate));
      setEndDate(toLocal(assessment.endDate));
      setMaxAttempts(assessment.maxAttempts != null ? String(assessment.maxAttempts) : '');
    }
  }, [open, assessment.id]);

  const originalEnd = toLocal(assessment.endDate);
  // Extend-only: new end date must be ≥ original end (if one exists)
  const endValid =
    fields.endDate === 'extend-only'
      ? !originalEnd || (!!endDate && endDate >= originalEnd)
      : true;

  const attemptsNum = maxAttempts.trim() === '' ? undefined : Number(maxAttempts);
  const attemptsValid = attemptsNum === undefined || (Number.isInteger(attemptsNum) && attemptsNum >= 1);

  const dirty =
    (fields.startDate && startDate !== toLocal(assessment.startDate)) ||
    (fields.endDate && endDate !== toLocal(assessment.endDate)) ||
    (fields.maxAttempts && attemptsNum !== assessment.maxAttempts);

  const canSave = endValid && attemptsValid;

  const handleSave = async () => {
    setSaving(true);
    try {
      const patch: Partial<Assessment> = {};
      if (fields.startDate) patch.startDate = fromLocal(startDate);
      if (fields.endDate) patch.endDate = fromLocal(endDate);
      if (fields.maxAttempts) patch.maxAttempts = attemptsNum;
      await updateAssessmentSchedule(assessment.id, patch);
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
      title="Edit schedule"
      description={
        assessment.status === 'active'
          ? 'Window is live — start date is locked; end date can only be extended.'
          : 'Test window and attempt limits.'
      }
      dirty={dirty}
      saving={saving}
      canSave={canSave}
      onSave={handleSave}
    >
      {fields.startDate && (
        <Field label="Start date">
          <input
            type="datetime-local"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-full text-xs px-3 py-2"
            style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF', color: '#0C0C0B' }}
          />
        </Field>
      )}

      {fields.endDate && (
        <Field
          label="End date"
          hint={fields.endDate === 'extend-only' && originalEnd
            ? `Must be on or after current end (${originalEnd.replace('T', ' ')}).`
            : undefined}
        >
          <input
            type="datetime-local"
            value={endDate}
            min={fields.endDate === 'extend-only' ? originalEnd || undefined : undefined}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-full text-xs px-3 py-2"
            style={{
              border: `1px solid ${endValid ? '#E3E1DB' : '#D97757'}`,
              borderRadius: 2, background: '#FFFFFF', color: '#0C0C0B',
            }}
          />
        </Field>
      )}

      {fields.maxAttempts && (
        <Field label="Max attempts" hint="Leave blank for unlimited. Per-student overrides are managed in the roster.">
          <input
            type="number"
            min={1}
            value={maxAttempts}
            onChange={(e) => setMaxAttempts(e.target.value)}
            placeholder="Unlimited"
            className="w-full text-xs px-3 py-2"
            style={{
              border: `1px solid ${attemptsValid ? '#E3E1DB' : '#D97757'}`,
              borderRadius: 2, background: '#FFFFFF', color: '#0C0C0B',
            }}
          />
        </Field>
      )}
    </EditPanelShell>
  );
}
