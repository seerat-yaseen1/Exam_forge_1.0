// ── Question-rights ceiling editor (permission-model Phase 2) ──────
// Web Owner surface, mounted in the institute Permissions tab. Sets the
// CEILING: per right (create/edit/share/delete), whether the institute has
// it, and which modes it may grant onward to faculty (direct / request).
// The institute admin's per-faculty editor is clamped to whatever is set
// here; the server re-clamps on every write.

import { useState } from 'react';
import { Loader2, Check } from 'lucide-react';
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
      <p className="text-xs mb-3" style={{ color: '#9A9891', lineHeight: 1.6 }}>
        The maximum question rights this institute may hold, and — per right — the modes it may grant to its faculty.
        Everything is off by default. The institute admin can grant faculty rights only at or below this ceiling.
      </p>

      {RIGHT_NAMES.map((r) => {
        const c = ceiling[r];
        return (
          <div
            key={r}
            className="px-3 py-3 md:px-4 mb-2"
            style={{ background: '#F7F6F3', border: '1px solid #E3E1DB', borderRadius: 2 }}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs" style={{ color: '#0C0C0B' }}>{RIGHT_LABEL[r]}</p>
                <p className="text-xs mt-0.5" style={{ color: '#9A9891' }}>{RIGHT_HINT[r]}</p>
              </div>
              <button
                onClick={() => toggleAllowed(r)}
                disabled={saving}
                className="flex items-center gap-2 text-xs px-3 py-1.5 transition-all select-none flex-shrink-0"
                style={{
                  border: `1px solid ${c.allowed ? '#C6DECE' : '#E3E1DB'}`,
                  borderRadius: 2,
                  background: c.allowed ? '#F0F7F2' : '#FFFFFF',
                  color: c.allowed ? '#2A6B3A' : '#9A9891',
                  cursor: saving ? 'not-allowed' : 'pointer',
                }}
              >
                <span style={{
                  display: 'inline-flex', width: 28, height: 16, borderRadius: 8,
                  background: c.allowed ? '#2A6B3A' : '#D4D2CC',
                  alignItems: 'center', padding: '0 2px', transition: 'background 0.2s',
                  justifyContent: c.allowed ? 'flex-end' : 'flex-start',
                }}>
                  <span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: '50%', background: '#FFFFFF' }} />
                </span>
                {c.allowed ? 'Allowed' : 'Off'}
              </button>
            </div>

            {/* Grantable modes — only meaningful when the right is allowed */}
            {c.allowed && (
              <div className="flex items-center gap-2 mt-3 pl-0.5">
                <span className="text-xs" style={{ color: '#B0AEA8' }}>Grantable to faculty as:</span>
                {(['direct', 'request'] as QuestionRightMode[]).map((mode) => {
                  const on = c.modes.includes(mode);
                  return (
                    <button
                      key={mode}
                      onClick={() => toggleMode(r, mode)}
                      disabled={saving}
                      className="text-xs px-2.5 py-1 transition-all select-none"
                      style={{
                        border: `1px solid ${on ? '#C6DECE' : '#E3E1DB'}`,
                        borderRadius: 2,
                        background: on ? '#F0F7F2' : '#FFFFFF',
                        color: on ? '#2A6B3A' : '#9A9891',
                        cursor: saving ? 'not-allowed' : 'pointer',
                      }}
                      title={mode === 'request' ? 'Request mode requires the approval workflow (coming in a later phase)' : undefined}
                    >
                      {mode === 'direct' ? 'Direct' : 'Request'}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      <div className="flex items-center gap-3 mt-4">
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-1.5 text-xs px-4 py-2 transition-opacity hover:opacity-80"
          style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, cursor: saving ? 'not-allowed' : 'pointer' }}
        >
          {saving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} strokeWidth={2} />}
          Save ceiling
        </button>
        {saved && <span className="text-xs" style={{ color: '#2A6B3A' }}>Saved.</span>}
      </div>
    </div>
  );
}