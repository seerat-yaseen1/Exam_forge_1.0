// ── Per-faculty deletion rights editor (Feature #15, Phase 3) ─────
// Institute-admin surface, rendered per faculty inside FacultyTab beside
// the question-rights editor, which this deliberately mirrors.
//
// Grants this faculty member deletion rights AT OR BELOW the institute's
// deletion ceiling. A resource the ceiling doesn't allow is not offered; a
// mode the ceiling doesn't permit is not offered. deleteAuthUser re-resolves
// the same logic server-side on every deletion, so nothing granted here can
// exceed the ceiling even if tampered.
//
// THIS IS THE SCREEN THAT CLOSES BUG (f). Until Phase 3, any faculty member
// could delete any student in their institute with no right governing it.
// Now they hold nothing until an institute admin grants it here.
//
// NAME COLLISION: deletionRights.ts and questionRights.ts share six export
// names. This file imports only from deletionRights, so no alias is needed
// here — but FacultyTab imports BOTH and must alias. See the deletionRights
// header.

import { useState } from 'react';
import { Loader2, Check, Info } from 'lucide-react';
import { setFacultyDeletionRights } from '../../../lib/firebaseService';
import {
  DELETABLE_RESOURCES,
  emptyFacultyRights,
  instituteHasRight,
  grantableModes,
  clampRightsToCeiling,
  resourceLabel,
  type FacultyDeletionRights,
  type DeletionRightsCeiling,
  type DeletableResource,
  type DeletionMode,
} from '../../../lib/deletionRights';

/**
 * Resources whose deletion currently runs through a server callable, and is
 * therefore actually enforced by this grant.
 *
 * Phase 3 gates deleteAuthUser, which covers ACCOUNTS. Content deletion
 * (assessments, banks, subjects) still goes through client-side Firestore
 * writes governed by firestore.rules, so a grant here would not yet change
 * what a faculty member can do. Rather than imply an enforcement that does
 * not exist, those rows say so plainly. Phase 6 routes them through
 * callables, at which point this set widens.
 */
const ENFORCED_NOW: DeletableResource[] = ['student', 'faculty'];

export function FacultyDeletionRightsEditor({
  facultyId,
  ceiling,
  initial,
  onSaved,
}: {
  facultyId: string;
  ceiling: DeletionRightsCeiling | undefined;
  initial?: FacultyDeletionRights;
  onSaved?: (rights: FacultyDeletionRights) => void;
}) {
  const [rights, setRights] = useState<FacultyDeletionRights>(
    // Clamp stored rights to the CURRENT ceiling on open, so a ceiling that
    // shrank since granting is reflected immediately rather than showing a
    // grant the server would refuse.
    clampRightsToCeiling(initial ?? emptyFacultyRights(), ceiling),
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Only resources the institute may DELEGATE are offerable. A resource the
  // institute holds but cannot grant onward (modes: []) is correctly absent.
  const offerable = DELETABLE_RESOURCES.filter(
    (r) => instituteHasRight(ceiling, r) && grantableModes(ceiling, r).length > 0,
  );

  if (offerable.length === 0) {
    return (
      <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
        This institute cannot delegate any deletion rights. Ask the Web Owner to
        raise the ceiling, or enable a grantable mode on it.
      </p>
    );
  }

  const toggleGranted = (r: DeletableResource) => {
    setSaved(false);
    setRights((prev) => {
      const modes = grantableModes(ceiling, r);
      const nowGranted = !prev[r].granted;
      return {
        ...prev,
        [r]: {
          granted: nowGranted,
          mode: nowGranted
            ? (modes.includes(prev[r].mode) ? prev[r].mode : modes[0])
            : prev[r].mode,
        },
      };
    });
  };

  const setMode = (r: DeletableResource, mode: DeletionMode) => {
    setSaved(false);
    setRights((prev) => ({ ...prev, [r]: { ...prev[r], mode } }));
  };

  const save = async () => {
    setSaving(true);
    try {
      const clamped = clampRightsToCeiling(rights, ceiling);
      await setFacultyDeletionRights(facultyId, clamped);
      setRights(clamped);
      setSaved(true);
      onSaved?.(clamped);
    } finally {
      setSaving(false);
    }
  };

  const anyUnenforced = offerable.some((r) => !ENFORCED_NOW.includes(r));

  return (
    <div className="mt-4 pt-3" style={{ borderTop: '1px solid #EDEBE5' }}>
      <p className="text-xs mb-2" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.05em' }}>
        DELETION RIGHTS
      </p>

      {offerable.map((r) => {
        const modes = grantableModes(ceiling, r);
        const fr = rights[r];
        const enforced = ENFORCED_NOW.includes(r);
        return (
          <div key={r} className="flex items-center justify-between gap-3 py-1.5">
            <span className="text-xs flex items-center gap-1.5" style={{ color: 'var(--ef-ink)' }}>
              {resourceLabel(r)}
              {!enforced && (
                <span
                  className="text-xs px-1.5"
                  style={{ color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2 }}
                  title="Saved as configuration. Server enforcement for this resource arrives in a later phase."
                >
                  not yet enforced
                </span>
              )}
            </span>
            <div className="flex items-center gap-2">
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
                        title={mode === 'request'
                          ? 'Faculty raises a request you approve. The approval workflow arrives in a later phase; until then this blocks the action.'
                          : 'Faculty deletes without approval.'}
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

      {anyUnenforced && (
        <div className="flex items-start gap-1.5 mt-2 text-xs" style={{ color: 'var(--ef-text-muted)' }}>
          <Info size={11} style={{ marginTop: 1, flexShrink: 0 }} />
          <span>
            Rows marked “not yet enforced” are stored as configuration. Those
            resources are still governed by the existing access rules until a
            later phase routes them through the server.
          </span>
        </div>
      )}

      <div className="flex items-center gap-3 mt-3">
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 transition-opacity hover:opacity-80"
          style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, cursor: saving ? 'not-allowed' : 'pointer' }}
        >
          {saving ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} strokeWidth={2} />}
          Save deletion rights
        </button>
        {saved && <span className="text-xs" style={{ color: 'var(--ef-success)' }}>Saved.</span>}
      </div>
    </div>
  );
}