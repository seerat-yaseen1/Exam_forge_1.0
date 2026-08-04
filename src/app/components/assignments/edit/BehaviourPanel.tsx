import { useEffect, useState, useMemo } from 'react';
import { EditPanelShell, Field } from './EditPanelShell';
import { editableFields } from './useEditableFields';
import { Switch } from '../../ui/switch';
import { updateAssessmentBehaviour, type Assessment } from '../../../../lib/assessmentService';
import {
  deriveShowResultsTo, deriveAllowReviewTo, type VisibilityAudience,
} from '../../../../lib/visibility';
import {
  computeAutoOverallLimitFromSections,
  sumSectionsAndBreaksMinutesFromSections,
  DEFAULT_OVERALL_GRACE_SECONDS,
} from '../builder/shared';
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
  // ── Overall exam timer ─────────────────────────────────────────
  // Auto on when the exam currently has no explicit overall limit (so a
  // never-configured exam adopts the computed budget on save); off when a
  // value was already chosen. overallGrace has its own knob (blank = 30s).
  const [overallAuto, setOverallAuto] = useState(assessment.overallTimeLimit == null);
  const [overallLimit, setOverallLimit] = useState<string>(
    assessment.overallTimeLimit != null ? String(assessment.overallTimeLimit) : ''
  );
  const [overallGrace, setOverallGrace] = useState<string>(
    assessment.overallGraceSeconds != null ? String(assessment.overallGraceSeconds) : ''
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
      setOverallAuto(assessment.overallTimeLimit == null);
      setOverallLimit(assessment.overallTimeLimit != null ? String(assessment.overallTimeLimit) : '');
      setOverallGrace(assessment.overallGraceSeconds != null ? String(assessment.overallGraceSeconds) : '');
      setShowResultsTo(deriveShowResultsTo(assessment));
      setAllowReviewTo(deriveAllowReviewTo(assessment));
    }
  }, [open, assessment.id]);

  const passingNum = passing.trim() === '' ? undefined : Number(passing);
  const passingValid = passingNum === undefined || (passingNum >= 0 && passingNum <= 100);

  // Auto budget computed from the (frozen, published) sections + grace knobs.
  const autoOverallLimit = useMemo(
    () => computeAutoOverallLimitFromSections(
      assessment.sections ?? [],
      assessment.sectionGraceSeconds,
      overallGrace ? parseInt(overallGrace, 10) : undefined,
    ),
    [assessment.sections, assessment.sectionGraceSeconds, overallGrace]
  );
  const overallLimitDisplay = overallAuto ? String(autoOverallLimit) : overallLimit;
  // The value that will be saved: auto budget when Auto is on, else the manual
  // entry (blank manual = no overall cap → undefined).
  const effectiveOverallLimit = overallAuto
    ? autoOverallLimit
    : (overallLimit.trim() === '' ? undefined : parseInt(overallLimit, 10));
  const overallGraceNum = overallGrace.trim() === '' ? undefined : parseInt(overallGrace, 10);

  // Impossible-limit warning (manual only): overall cap below the bare sum of
  // section time + breaks means students cannot finish.
  const overallFloor = useMemo(
    () => sumSectionsAndBreaksMinutesFromSections(assessment.sections ?? []),
    [assessment.sections]
  );
  const overallTooShort =
    !overallAuto && effectiveOverallLimit != null && effectiveOverallLimit > 0
    && overallFloor > 0 && effectiveOverallLimit < overallFloor;

  const overallDirty =
    fields.overallTimer && (
      effectiveOverallLimit !== assessment.overallTimeLimit ||
      overallGraceNum !== assessment.overallGraceSeconds
    );

  const dirty =
    (fields.shuffleQuestions && shuffle !== assessment.shuffleQuestions) ||
    (fields.passingScore && passingNum !== assessment.passingScore) ||
    overallDirty ||
    (fields.showResults && showResultsTo.join() !== deriveShowResultsTo(assessment).join()) ||
    (fields.allowReview && allowReviewTo.join() !== deriveAllowReviewTo(assessment).join());

  const handleSave = async () => {
    setSaving(true);
    try {
      const patch: Partial<Assessment> = {};
      if (fields.shuffleQuestions) patch.shuffleQuestions = shuffle;
      if (fields.passingScore) patch.passingScore = passingNum;
      if (fields.overallTimer) {
        patch.overallTimeLimit = effectiveOverallLimit;
        patch.overallGraceSeconds = overallGraceNum;
      }
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

      {fields.overallTimer && (
        <div className="py-3" style={{ borderTop: '1px solid #F0EFEB' }}>
          <div className="flex items-center justify-between mb-1.5">
            <div className="flex-1">
              <p className="text-xs" style={{ color: '#0C0C0B' }}>Overall time limit (minutes)</p>
              <p className="text-xs mt-0.5" style={{ color: '#6B6B66' }}>
                Whole-exam cap, counted from when a student begins. Hard-cuts the exam when it runs out. Blank = no cap.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                if (overallAuto) setOverallLimit(String(autoOverallLimit));
                setOverallAuto((v) => !v);
              }}
              className="flex items-center gap-1 px-2 py-0.5"
              style={{
                borderRadius: 2,
                border: `1px solid ${overallAuto ? '#B8E6C8' : '#E3E1DB'}`,
                background: overallAuto ? '#F0F9F4' : '#FFFFFF',
              }}
            >
              <span className="text-xs" style={{ color: overallAuto ? '#1E7B3C' : '#6B6B66' }}>Auto</span>
            </button>
          </div>
          <input
            type="number"
            min={1}
            value={overallLimitDisplay}
            onChange={(e) => setOverallLimit(e.target.value)}
            readOnly={overallAuto}
            placeholder="Blank = no overall cap"
            className="w-full text-xs px-3 py-2"
            style={{
              border: '1px solid #E3E1DB', borderRadius: 2,
              background: overallAuto ? '#F7F6F3' : '#FFFFFF',
              color: overallAuto ? '#6B6A65' : '#0C0C0B',
            }}
          />
          {overallAuto && (
            <p className="text-xs mt-1" style={{ color: '#6B6B66' }}>
              Auto: section time + section grace + breaks + overall grace (currently {autoOverallLimit}m).
            </p>
          )}
          {overallTooShort && (
            <p className="text-xs mt-1" style={{ color: '#9B2828' }}>
              Below the total section time + breaks ({overallFloor}m) — students cannot finish; the exam will hard-cut early.
            </p>
          )}

          <div className="mt-3">
            <p className="text-xs mb-1" style={{ color: '#0C0C0B' }}>Overall grace period (seconds)</p>
            <input
              type="number"
              min={0}
              value={overallGrace}
              onChange={(e) => setOverallGrace(e.target.value)}
              placeholder={`Blank = ${DEFAULT_OVERALL_GRACE_SECONDS}s default`}
              className="w-full text-xs px-3 py-2"
              style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF', color: '#0C0C0B' }}
            />
          </div>
        </div>
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
        {hint && <p className="text-xs mt-0.5" style={{ color: '#6B6B66' }}>{hint}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}