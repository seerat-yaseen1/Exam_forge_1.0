// ── Question-rights ceiling editor (permission-model Phase 2) ──────
// Web Owner surface, mounted in the institute Permissions tab. Sets the
// CEILING: per right (create/edit/share/delete), whether the institute has
// it, and which modes it may grant onward to faculty (direct / request).
// The institute admin's per-faculty editor is clamped to whatever is set
// here; the server re-clamps on every write.

import { useState } from 'react';
import { Check } from 'lucide-react';
import { Button, Card, Toggle } from '../console/ui';
import {
  setInstituteQuestionRightsCeiling,
  type QuestionRightsCeiling,
  type QuestionRightName,
  type QuestionRightMode,
} from '../../../lib/firebaseService';
import { RIGHT_NAMES, emptyCeiling } from '../../../lib/questionRights';

const RIGHT_LABEL: Record<QuestionRightName, string> = {
  create: 'Create',
  edit:   'Edit',
  share:  'Share',
  delete: 'Delete',
};

const RIGHT_HINT: Record<QuestionRightName, string> = {
  create: 'Author new questions in the institute pool.',
  edit:   'Modify their own questions.',
  share:  'Share their own questions within the institute.',
  delete: 'Remove their own questions.',
};

export function QuestionRightsCeilingEditor({
  instituteId,
  initial,
  onSaved,
}: {
  instituteId: string;
  initial?: QuestionRightsCeiling;
  onSaved?: (ceiling: QuestionRightsCeiling) => void;
}) {
  const [ceiling, setCeiling] = useState<QuestionRightsCeiling>(initial ?? emptyCeiling());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const toggleAllowed = (r: QuestionRightName) => {
    setSaved(false);
    setCeiling((prev) => {
      const next = { ...prev, [r]: { ...prev[r], allowed: !prev[r].allowed } };
      // Turning a right off clears its grantable modes.
      if (!next[r].allowed) next[r].modes = [];
      return next;
    });
  };

  const toggleMode = (r: QuestionRightName, mode: QuestionRightMode) => {
    setSaved(false);
    setCeiling((prev) => {
      const has = prev[r].modes.includes(mode);
      const modes = has ? prev[r].modes.filter((m) => m !== mode) : [...prev[r].modes, mode];
      return { ...prev, [r]: { ...prev[r], modes } };
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      await setInstituteQuestionRightsCeiling(instituteId, ceiling);
      setSaved(true);
      onSaved?.(ceiling);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <p className="ef-t-sm ef-muted" style={{ marginBottom: 14, lineHeight: 'var(--ef-leading-relaxed)' }}>
        The most this institute may hold, and — per right — the modes it may pass on to its
        faculty. Everything is off by default: the institute admin can grant a faculty member
        a right only at or below this line.
      </p>

      <Card padded={false} style={{ marginBottom: 16 }}>
        {RIGHT_NAMES.map((r) => {
          const c = ceiling[r];
          return (
            <div key={r}>
              <Toggle
                label={RIGHT_LABEL[r]}
                description={RIGHT_HINT[r]}
                checked={c.allowed}
                busy={saving}
                onChange={() => toggleAllowed(r)}
              />
              {/* Grantable modes — only meaningful when the right is allowed. */}
              {c.allowed && (
                <div
                  className="flex items-center gap-2 flex-wrap"
                  style={{ padding: '0 var(--ef-pad-card) 14px' }}
                >
                  <span className="ef-t-xs ef-muted">Faculty may be granted this as:</span>
                  {(['direct', 'request'] as QuestionRightMode[]).map((mode) => {
                    const on = c.modes.includes(mode);
                    return (
                      <button
                        key={mode}
                        type="button"
                        className="ef-chip"
                        data-tone={on ? 'success' : undefined}
                        aria-pressed={on}
                        disabled={saving}
                        onClick={() => toggleMode(r, mode)}
                        style={{ cursor: saving ? 'not-allowed' : 'pointer' }}
                        title={
                          mode === 'request'
                            ? 'The faculty member raises a request; the institute admin approves it.'
                            : 'The faculty member acts immediately.'
                        }
                      >
                        {mode === 'direct' ? 'Direct' : 'By approval'}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </Card>

      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={save} loading={saving}>
          {!saving && <Check size={13} strokeWidth={2} />}
          Save ceiling
        </Button>
        {saved && <span className="ef-t-sm" style={{ color: 'var(--ef-success)' }}>Saved.</span>}
      </div>
    </div>
  );
}