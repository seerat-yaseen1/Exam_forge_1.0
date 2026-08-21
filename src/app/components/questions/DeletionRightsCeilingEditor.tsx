// ── Deletion-rights ceiling editor ────────────────────────────────
// (Feature #15, Phase 2. Web Owner surface, mounted in the institute
// Permissions tab beside QuestionRightsCeilingEditor, which this
// deliberately mirrors so the two feel like one system.)
//
// Sets the CEILING for entity DELETION, per resource:
//   • allowed  — may the institute delete this resource type at all?
//   • selfMode — how the institute ITSELF acts (direct = do it now;
//                request = must ask the Web Owner). This is what makes
//                "the institute admin can raise a request when it lacks
//                permission" a first-class setting.
//   • modes    — which modes it may grant ONWARD to faculty.
//
// Everything is off by default. The institute admin's per-faculty editor
// (Phase 3) is clamped to whatever is set here; the server re-clamps on
// every deletion, and attempt + institute are forced off regardless.
//
// NAME COLLISION NOTE: deletionRights.ts shares six export names with
// questionRights.ts (emptyCeiling, clampCeiling, etc.). This file imports
// ONLY from deletionRights and never touches questionRights, so no alias
// is needed here — but a component importing both must alias. See the
// deletionRights.ts header.

import { useState } from 'react';
import { Check, ArrowUpFromLine } from 'lucide-react';
import { Button, Card, Toggle } from '../console/ui';
import {
  setInstituteDeletionRightsCeiling,
  setInstituteContentTransferRight,
} from '../../../lib/firebaseService';
import {
  DELETABLE_RESOURCES,
  emptyCeiling,
  clampCeiling,
  isWebOwnerOnly,
  resourceLabel,
  type DeletionRightsCeiling,
  type DeletableResource,
  type DeletionMode,
  type ContentTransferRight,
} from '../../../lib/deletionRights';

const RESOURCE_HINT: Record<DeletableResource, string> = {
  institute:    'Reserved to the Web Owner — a tenant cannot delete tenants.',
  faculty:      'Remove faculty accounts. Their content succeeds to the institute.',
  student:      'Remove student accounts. Attempts and reports are always kept.',
  assessment:   'Remove assessments the institute owns.',
  questionBank: 'Remove question banks the institute owns.',
  subjectTopic: 'Remove subjects and topics from the taxonomy.',
  attempt:      'Reserved to the Web Owner — attempts are the audit trail.',
};

export function DeletionRightsCeilingEditor({
  instituteId,
  initial,
  initialTransfer,
  onSaved,
}: {
  instituteId: string;
  initial?: DeletionRightsCeiling;
  initialTransfer?: ContentTransferRight;
  onSaved?: (ceiling: DeletionRightsCeiling, transfer: ContentTransferRight) => void;
}) {
  // clampCeiling on load as well as save: a ceiling written by an older
  // build, or one where attempt/institute were somehow stored as allowed,
  // must never render as if those were grantable.
  const [ceiling, setCeiling] = useState<DeletionRightsCeiling>(
    clampCeiling(initial ?? emptyCeiling()),
  );
  const [transfer, setTransfer] = useState<ContentTransferRight>(
    initialTransfer ?? { allowed: false },
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Only resources an institute can actually hold are shown as editable;
  // the web-owner-only ones render as locked rows so the Web Owner can see
  // WHY they can't be granted, rather than the resources silently missing.
  const editable = DELETABLE_RESOURCES.filter((r) => !isWebOwnerOnly(r));
  const reserved = DELETABLE_RESOURCES.filter((r) => isWebOwnerOnly(r));

  const toggleAllowed = (r: DeletableResource) => {
    setSaved(false);
    setCeiling((prev) => {
      const wasAllowed = prev[r].allowed;
      return {
        ...prev,
        [r]: wasAllowed
          ? { allowed: false, modes: [], selfMode: 'direct' }   // off clears modes
          : { allowed: true, modes: prev[r].modes, selfMode: prev[r].selfMode ?? 'direct' },
      };
    });
  };

  const setSelfMode = (r: DeletableResource, mode: DeletionMode) => {
    setSaved(false);
    setCeiling((prev) => ({ ...prev, [r]: { ...prev[r], selfMode: mode } }));
  };

  const toggleGrantMode = (r: DeletableResource, mode: DeletionMode) => {
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
      // Clamp once more immediately before persisting — the server will
      // re-clamp on every deletion, but sending a clean document keeps the
      // stored config honest.
      const clean = clampCeiling(ceiling);
      await setInstituteDeletionRightsCeiling(instituteId, clean);
      await setInstituteContentTransferRight(instituteId, transfer);
      setCeiling(clean);
      setSaved(true);
      onSaved?.(clean, transfer);
    } finally {
      setSaving(false);
    }
  };

  /** A choose-one or toggle-many chip inside an expanded resource row. */
  const modeChip = (on: boolean, label: string, title: string, onClick: () => void, key: string) => (
    <button
      key={key}
      type="button"
      className="ef-chip"
      data-tone={on ? 'success' : undefined}
      aria-pressed={on}
      disabled={saving}
      onClick={onClick}
      title={title}
      style={{ cursor: saving ? 'not-allowed' : 'pointer' }}
    >
      {label}
    </button>
  );

  return (
    <div>
      <p className="ef-t-sm ef-muted" style={{ marginBottom: 14, lineHeight: 'var(--ef-leading-relaxed)' }}>
        The most this institute may delete. Per kind of record: whether it may be deleted at
        all, how the institute itself acts, and what it may pass on to faculty. Everything is
        off by default, and every deletion stays reversible until it is permanently removed.
      </p>

      <Card padded={false} style={{ marginBottom: 16 }}>
        {editable.map((r) => {
          const c = ceiling[r];
          return (
            <div key={r}>
              <Toggle
                label={resourceLabel(r)}
                description={RESOURCE_HINT[r]}
                checked={c.allowed}
                busy={saving}
                onChange={() => toggleAllowed(r)}
              />

              {c.allowed && (
                <div className="flex flex-col gap-2.5" style={{ padding: '0 var(--ef-pad-card) 14px' }}>
                  {/* How the INSTITUTE ADMIN itself acts */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="ef-t-xs ef-muted" style={{ minWidth: 104 }}>
                      The institute:
                    </span>
                    {(['direct', 'request'] as DeletionMode[]).map((mode) =>
                      modeChip(
                        (c.selfMode ?? 'direct') === mode,
                        mode === 'direct' ? 'Deletes directly' : 'Asks you first',
                        mode === 'request'
                          ? 'The institute admin raises a request to the Web Owner instead of deleting.'
                          : 'The institute admin deletes without approval.',
                        () => setSelfMode(r, mode),
                        `self-${mode}`,
                      ),
                    )}
                  </div>

                  {/* What it may grant ONWARD to faculty */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="ef-t-xs ef-muted" style={{ minWidth: 104 }}>
                      Faculty may:
                    </span>
                    {(['direct', 'request'] as DeletionMode[]).map((mode) =>
                      modeChip(
                        c.modes.includes(mode),
                        mode === 'direct' ? 'Delete directly' : 'Ask the admin',
                        mode === 'request'
                          ? 'Faculty raise a request to the institute admin.'
                          : 'Faculty delete without approval.',
                        () => toggleGrantMode(r, mode),
                        `grant-${mode}`,
                      ),
                    )}
                    <span className="ef-t-xs" style={{ color: 'var(--ef-border-strong)' }}>
                      or neither, and only the institute may
                    </span>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {/* Web-owner-only resources shown as locked, so their absence is explained. */}
        {reserved.map((r) => (
          <div
            key={r}
            className="ef-toggle-row flex items-start justify-between gap-4"
            data-locked=""
          >
            <div className="min-w-0">
              <p className="ef-t-sm ef-ink" style={{ fontWeight: 500 }}>{resourceLabel(r)}</p>
              <p className="ef-t-xs ef-muted" style={{ marginTop: 3, lineHeight: 'var(--ef-leading-relaxed)' }}>
                {RESOURCE_HINT[r]}
              </p>
            </div>
            <span className="ef-chip ef-chip--sm flex-shrink-0">Yours only</span>
          </div>
        ))}
      </Card>

      {/* Content-transfer capability — separate from the ceiling because it is
          exercised while ACTIVE, not a deletion mode. */}
      <Card padded={false} style={{ marginBottom: 16 }}>
        <Toggle
          label="Hand content up to you before deletion"
          description="Lets this institute transfer its questions and banks to the platform while it is still active. Without it, that content is wiped along with the tenant."
          icon={<ArrowUpFromLine size={14} strokeWidth={1.7} />}
          checked={transfer.allowed}
          busy={saving}
          onChange={() => { setSaved(false); setTransfer((t) => ({ allowed: !t.allowed })); }}
        />
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
