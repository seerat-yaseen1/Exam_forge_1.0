import { useEffect, useState } from 'react';
import { EditPanelShell, Field } from './EditPanelShell';
import { editableFields } from './useEditableFields';
import { updateAssessmentDetails, type Assessment } from '../../../../lib/assessmentService';

type Props = {
  assessment: Assessment;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (patch: Partial<Assessment>) => void;
};

export function DetailsPanel({ assessment, open, onOpenChange, onSaved }: Props) {
  const fields = editableFields(assessment.status);

  const [title, setTitle] = useState(assessment.title);
  const [description, setDescription] = useState(assessment.description);
  const [subject, setSubject] = useState(assessment.subject);
  const [saving, setSaving] = useState(false);

  // Reset whenever the assessment changes or sheet reopens
  useEffect(() => {
    if (open) {
      setTitle(assessment.title);
      setDescription(assessment.description);
      setSubject(assessment.subject);
    }
  }, [open, assessment.id]);

  const dirty =
    title !== assessment.title ||
    description !== assessment.description ||
    (fields.subject && subject !== assessment.subject);

  const canSave = title.trim().length > 0;

  const handleSave = async () => {
    setSaving(true);
    try {
      const patch: Partial<Assessment> = {
        title: title.trim(),
        description,
      };
      if (fields.subject) patch.subject = subject;
      await updateAssessmentDetails(assessment.id, patch);
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
      title="Edit details"
      description="Title, description, and subject."
      dirty={dirty}
      saving={saving}
      canSave={canSave}
      onSave={handleSave}
    >
      {fields.title && (
        <Field label="Title">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full text-xs px-3 py-2"
            style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)', color: 'var(--ef-ink)' }}
          />
        </Field>
      )}

      {fields.description && (
        <Field label="Description">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            className="w-full text-xs px-3 py-2"
            style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)', color: 'var(--ef-ink)' }}
          />
        </Field>
      )}

      {fields.subject && (
        <Field label="Subject">
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="w-full text-xs px-3 py-2"
            style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)', color: 'var(--ef-ink)' }}
          />
        </Field>
      )}
    </EditPanelShell>
  );
}
