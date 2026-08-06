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
import { Loader2, Check, ArrowUpFromLine } from 'lucide-react';
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

  const pill = (on: boolean) => ({
    border: `1px solid ${on ? 'var(--ef-success-border-alt)' : 'var(--ef-border)'}`,
    borderRadius: 2,
    background: on ? 'var(--ef-success-bg-alt)' : 'var(--ef-surface)',
    color: on ? 'var(--ef-success)' : 'var(--ef-text-muted)',
    cursor: saving ? ('not-allowed' as const) : ('pointer' as const),
  });

  return (
    <div>
      <p className="text-xs mb-3" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
        The maximum deletion rights this institute may hold. Per resource: whether
        the institute may delete it, how the institute itself acts, and which modes
        it may grant to faculty. Everything is off by default. Deletions are
        reversible until permanently removed.
      </p>

      {editable.map((r) => {
        const c = ceiling[r];
        return (
          <div
            key={r}
            className="px-3 py-3 md:px-4 mb-2"
            style={{ background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)', borderRadius: 2 }}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs" style={{ color: 'var(--ef-ink)' }}>{resourceLabel(r)}</p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--ef-text-muted)' }}>{RESOURCE_HINT[r]}</p>
              </div>
              <button
                onClick={() => toggleAllowed(r)}
                disabled={saving}
                className="flex items-center gap-2 text-xs px-3 py-1.5 transition-all select-none flex-shrink-0"
                style={pill(c.allowed)}
              >
                <span style={{
                  display: 'inline-flex', width: 28, height: 16, borderRadius: 8,
                  background: c.allowed ? 'var(--ef-success)' : '#D4D2CC',
                  alignItems: 'center', padding: '0 2px', transition: 'background 0.2s',
                  justifyContent: c.allowed ? 'flex-end' : 'flex-start',
                }}>
                  <span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: '50%', background: 'var(--ef-surface)' }} />
                </span>
                {c.allowed ? 'Allowed' : 'Off'}
              </button>
            </div>

            {c.allowed && (
              <div className="mt-3 pl-0.5 flex flex-col gap-2.5">
                {/* How the INSTITUTE ADMIN itself acts */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs" style={{ color: 'var(--ef-text-muted)', minWidth: 96 }}>
                    Institute acts:
                  </span>
                  {(['direct', 'request'] as DeletionMode[]).map((mode) => {
                    const on = (c.selfMode ?? 'direct') === mode;
                    return (
                      <button
                        key={mode}
                        onClick={() => setSelfMode(r, mode)}
                        disabled={saving}
                        className="text-xs px-2.5 py-1 transition-all select-none"
                        style={pill(on)}
                        title={mode === 'request'
                          ? 'The institute admin raises a request to the Web Owner instead of deleting directly.'
                          : 'The institute admin deletes without approval.'}
                      >
                        {mode === 'direct' ? 'Directly' : 'Request Web Owner'}
                      </button>
                    );
                  })}
                </div>

                {/* What it may grant ONWARD to faculty */}
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs" style={{ color: 'var(--ef-text-muted)', minWidth: 96 }}>
                    Grant faculty:
                  </span>
                  {(['direct', 'request'] as DeletionMode[]).map((mode) => {
                    const on = c.modes.includes(mode);
                    return (
                      <button
                        key={mode}
                        onClick={() => toggleGrantMode(r, mode)}
                        disabled={saving}
                        className="text-xs px-2.5 py-1 transition-all select-none"
                        style={pill(on)}
                        title={mode === 'request'
                          ? 'Faculty raise a request to the institute admin.'
                          : 'Faculty delete without approval.'}
                      >
                        {mode === 'direct' ? 'Direct' : 'Request'}
                      </button>
                    );
                  })}
                  <span className="text-xs" style={{ color: '#C4C2BC' }}>
                    (or neither — institute-only)
                  </span>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Web-owner-only resources shown as locked, so their absence is explained */}
      {reserved.map((r) => (
        <div
          key={r}
          className="px-3 py-2.5 md:px-4 mb-2 flex items-center justify-between gap-3"
          style={{ background: '#F4F3F0', border: '1px dashed #DAD8D2', borderRadius: 2, opacity: 0.85 }}
        >
          <div className="min-w-0">
            <p className="text-xs" style={{ color: '#7A7873' }}>{resourceLabel(r)}</p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--ef-text-muted)' }}>{RESOURCE_HINT[r]}</p>
          </div>
          <span className="text-xs px-2.5 py-1 flex-shrink-0"
            style={{ border: '1px solid var(--ef-border)', borderRadius: 2, color: 'var(--ef-text-muted)', background: 'var(--ef-surface)' }}>
            Web Owner only
          </span>
        </div>
      ))}

      {/* Content-transfer capability — separate from the ceiling because it is
          exercised while ACTIVE, not a deletion mode. */}
      <div className="px-3 py-3 md:px-4 mb-2 mt-3"
        style={{ background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex items-start gap-2">
            <ArrowUpFromLine size={13} strokeWidth={1.5} style={{ color: '#7A7873', marginTop: 1, flexShrink: 0 }} />
            <div>
              <p className="text-xs" style={{ color: 'var(--ef-ink)' }}>Transfer content to Web Owner</p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--ef-text-muted)' }}>
                Let this institute hand its questions and banks up to you before it
                is deleted. Exercised while the institute is active; otherwise its
                content is wiped with the tenant.
              </p>
            </div>
          </div>
          <button
            onClick={() => { setSaved(false); setTransfer((t) => ({ allowed: !t.allowed })); }}
            disabled={saving}
            className="flex items-center gap-2 text-xs px-3 py-1.5 transition-all select-none flex-shrink-0"
            style={pill(transfer.allowed)}
          >
            <span style={{
              display: 'inline-flex', width: 28, height: 16, borderRadius: 8,
              background: transfer.allowed ? 'var(--ef-success)' : '#D4D2CC',
              alignItems: 'center', padding: '0 2px', transition: 'background 0.2s',
              justifyContent: transfer.allowed ? 'flex-end' : 'flex-start',
            }}>
              <span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: '50%', background: 'var(--ef-surface)' }} />
            </span>
            {transfer.allowed ? 'Allowed' : 'Off'}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-3 mt-4">
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-1.5 text-xs px-4 py-2 transition-opacity hover:opacity-80"
          style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, cursor: saving ? 'not-allowed' : 'pointer' }}
        >
          {saving ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} strokeWidth={2} />}
          Save ceiling
        </button>
        {saved && <span className="text-xs" style={{ color: 'var(--ef-success)' }}>Saved.</span>}
      </div>
    </div>
  );
}