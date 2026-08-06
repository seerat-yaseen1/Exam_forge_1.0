// ── Institute purge panel (Feature #15, Phase 5b) ─────────────────
// Shown in the Web Owner's institute-delete confirmation, above the password
// gate. Deleting an institute destroys its faculty, students, content and
// attempts (decision D4: "institute goes so goes with their data").
//
// THE ONE JUDGEMENT CALL THIS SURFACES
// A WEBOWNER-OWNED assessment survives the wipe — ownership was never the
// institute's. But the attempts on it by this institute's students are a
// real decision:
//
//   EXCLUSIVE — every attempt came from this institute. Once they are gone
//               the results mean nothing, so deleting is reasonable.
//   SHARED    — other institutes sat it too. Deleting would silently gut a
//               cross-institute exam's history with no record of why.
//
// Defaults to KEEP on every row, including exclusive ones. Destroying the
// Web Owner's own exam history by default — or by omission — is the worst
// failure mode available here, so opting in is always deliberate.

import { useState, useEffect } from 'react';
import { Loader2, AlertTriangle, Database } from 'lucide-react';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../../lib/firebase';

type PurgeAssessment = {
  assessmentId: string;
  title: string | null;
  ownAttempts: number;
  otherInstituteAttempts: number | null;
  exclusive: boolean;
};

type Props = {
  instituteId: string;
  /** Ids whose attempts the Web Owner has opted to delete. */
  selected: string[];
  onChange: (ids: string[]) => void;
};

export function InstitutePurgePanel({ instituteId, selected, onChange }: Props) {
  const [rows, setRows] = useState<PurgeAssessment[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);

    const call = httpsCallable<
      { instituteId: string },
      { ok: true; assessments: PurgeAssessment[] }
    >(functions, 'getInstitutePurgePreview');

    call({ instituteId })
      .then((res) => { if (!cancelled) setRows(res.data.assessments ?? []); })
      .catch((err) => {
        console.error('[purge preview] failed', err);
        if (!cancelled) setFailed(true);
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [instituteId]);

  const toggle = (id: string) => {
    onChange(selected.includes(id)
      ? selected.filter((x) => x !== id)
      : [...selected, id]);
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--ef-text-muted)' }}>
        <Loader2 size={11} className="animate-spin" />
        Checking platform exams this institute sat…
      </div>
    );
  }

  // A failed preview must not read as "nothing to decide". If we cannot
  // establish what the Web Owner would be destroying, say so — the default
  // (keep everything) still holds, so proceeding is safe.
  if (failed) {
    return (
      <div className="flex items-start gap-2 text-xs px-2.5 py-2"
        style={{ background: '#FDF6E7', border: '1px solid #E8D9B0', borderRadius: 2, color: '#7A5B12' }}>
        <AlertTriangle size={12} style={{ marginTop: 1, flexShrink: 0 }} />
        <span>
          Could not check which platform exams this institute sat. Their attempt
          data will be kept.
        </span>
      </div>
    );
  }

  if (rows.length === 0) return null;

  return (
    <div className="px-2.5 py-2"
      style={{ background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
      <div className="flex items-start gap-1.5 mb-2">
        <Database size={11} strokeWidth={1.5} style={{ marginTop: 2, flexShrink: 0, color: '#6B6862' }} />
        <p className="text-xs" style={{ color: '#6B6862', lineHeight: 1.5 }}>
          This institute&apos;s students sat {rows.length} of your platform exam
          {rows.length === 1 ? '' : 's'}. Those exams are yours and will be kept.
          Choose whether their <em>results</em> go too.
        </p>
      </div>

      {rows.map((r) => {
        const on = selected.includes(r.assessmentId);
        return (
          <div key={r.assessmentId}
            className="flex items-start justify-between gap-3 py-1.5"
            style={{ borderTop: '1px solid #EDEBE5' }}>
            <div className="min-w-0">
              <p className="text-xs" style={{ color: 'var(--ef-ink)' }}>
                {r.title ?? r.assessmentId}
              </p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--ef-text-muted)' }}>
                {r.ownAttempts.toLocaleString()} attempt{r.ownAttempts === 1 ? '' : 's'} from this institute
                {r.exclusive
                  ? ' — no other institute sat it'
                  : r.otherInstituteAttempts === null
                    ? ' — other institutes unknown'
                    : `, ${r.otherInstituteAttempts.toLocaleString()} from others`}
              </p>
            </div>
            <button
              onClick={() => toggle(r.assessmentId)}
              className="text-xs px-2 py-0.5 flex-shrink-0 select-none"
              style={{
                border: `1px solid ${on ? '#E8CFCF' : 'var(--ef-border)'}`,
                borderRadius: 2,
                background: on ? '#FBF3F3' : 'var(--ef-surface)',
                color: on ? 'var(--ef-danger)' : 'var(--ef-text-muted)',
                cursor: 'pointer',
              }}
              title={r.exclusive
                ? 'Only this institute sat this exam, so its results are of little use once they are gone.'
                : 'Other institutes sat this exam — deleting removes part of its history.'}
            >
              {on ? 'Delete results' : 'Keep results'}
            </button>
          </div>
        );
      })}
    </div>
  );
}