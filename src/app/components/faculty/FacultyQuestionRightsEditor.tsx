// ── Per-faculty question rights editor (permission-model Phase 2) ──
// Institute-admin surface, rendered per faculty inside FacultyTab. Grants
// this faculty member question rights AT OR BELOW the institute ceiling.
// A right the ceiling doesn't allow is not offered; a mode the ceiling
// doesn't permit is not offered. The server re-clamps on save, so nothing
// here can exceed the ceiling even if tampered.

import { useState } from 'react';
import { Loader2, Check } from 'lucide-react';
import {
  setFacultyQuestionRights,
  type FacultyQuestionRights,
  type QuestionRightsCeiling,
  type QuestionRightName,
  type QuestionRightMode,
} from '../../../lib/firebaseService';
import {
  RIGHT_NAMES, emptyFacultyRights, instituteHasRight, grantableModes, clampRightsToCeiling,
} from '../../../lib/questionRights';

const LABEL: Record<QuestionRightName, string> = {
  create: 'Create', edit: 'Edit', share: 'Share', delete: 'Delete',
};

export function FacultyQuestionRightsEditor({
  facultyId,
  ceiling,
  initial,
  onSaved,
}: {
  facultyId: string;
  ceiling: QuestionRightsCeiling | undefined;
  initial?: FacultyQuestionRights;
  onSaved?: (rights: FacultyQuestionRights) => void;
}) {
  const [rights, setRights] = useState<FacultyQuestionRights>(
    // Clamp any stored rights to the current ceiling on open, so a ceiling
    // that shrank since granting is reflected immediately.
    clampRightsToCeiling(initial ?? emptyFacultyRights(), ceiling),
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Rights the institute can offer at all.
  const offerable = RIGHT_NAMES.filter((r) => instituteHasRight(ceiling, r));

  if (offerable.length === 0) {
    return (
      <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
        This institute has no question rights enabled. Ask the Web Owner to raise the ceiling first.
      </p>
    );
  }

  const toggleGranted = (r: QuestionRightName) => {
    setSaved(false);
    setRights((prev) => {
      const modes = grantableModes(ceiling, r);
      const nowGranted = !prev[r].granted;
      return {
        ...prev,
        [r]: {
          granted: nowGranted,
          // Default to the first grantable mode when turning on.
          mode: nowGranted ? (modes.includes(prev[r].mode) ? prev[r].mode : modes[0]) : prev[r].mode,
        },
      };
    });
  };

  const setMode = (r: QuestionRightName, mode: QuestionRightMode) => {
    setSaved(false);
    setRights((prev) => ({ ...prev, [r]: { ...prev[r], mode } }));
  };

  const save = async () => {
    setSaving(true);
    try {
      const clamped = clampRightsToCeiling(rights, ceiling);
      await setFacultyQuestionRights(facultyId, clamped);
      setRights(clamped);
      setSaved(true);
      onSaved?.(clamped);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2">
      <p className="text-xs mb-2" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.05em' }}>QUESTION RIGHTS</p>
      {offerable.map((r) => {
        const modes = grantableModes(ceiling, r);
        const fr = rights[r];
        return (
          <div key={r} className="flex items-center justify-between gap-3 py-1.5">
            <span className="text-xs" style={{ color: 'var(--ef-ink)' }}>{LABEL[r]}</span>
            <div className="flex items-center gap-2">
              {/* Mode selector — only when granted and >1 mode available */}
              {fr.granted && modes.length > 0 && (
                <div className="flex items-center gap-1">
                  {modes.map((mode) => {
                    const on = fr.mode === mode;
                    return (
                      <button
                        key={mode}
                        onClick={() => setMode(r, mode)}
                        disabled={saving}
                        className="text-xs px-2 py-0.5 transition-all select-none"
                        style={{
                          border: `1px solid ${on ? 'var(--ef-success-border-alt)' : 'var(--ef-border)'}`,
                          borderRadius: 2,
                          background: on ? 'var(--ef-success-bg-alt)' : 'var(--ef-surface)',
                          color: on ? 'var(--ef-success)' : 'var(--ef-text-muted)',
                          cursor: saving ? 'not-allowed' : 'pointer',
                        }}
                        title={mode === 'request' ? 'Faculty raises a request you approve (approval workflow arrives in a later phase)' : undefined}
                      >
                        {mode === 'direct' ? 'Direct' : 'Request'}
                      </button>
                    );
                  })}
                </div>
              )}
              <button
                onClick={() => toggleGranted(r)}
                disabled={saving}
                className="text-xs px-2.5 py-0.5 transition-all select-none"
                style={{
                  border: `1px solid ${fr.granted ? 'var(--ef-success-border-alt)' : 'var(--ef-border)'}`,
                  borderRadius: 2,
                  background: fr.granted ? 'var(--ef-success-bg-alt)' : 'var(--ef-surface)',
                  color: fr.granted ? 'var(--ef-success)' : 'var(--ef-text-muted)',
                  cursor: saving ? 'not-allowed' : 'pointer',
                }}
              >
                {fr.granted ? 'Granted' : 'Off'}
              </button>
            </div>
          </div>
        );
      })}
      <div className="flex items-center gap-3 mt-3">
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 transition-opacity hover:opacity-80"
          style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, cursor: saving ? 'not-allowed' : 'pointer' }}
        >
          {saving ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} strokeWidth={2} />}
          Save rights
        </button>
        {saved && <span className="text-xs" style={{ color: 'var(--ef-success)' }}>Saved.</span>}
      </div>
    </div>
  );
}