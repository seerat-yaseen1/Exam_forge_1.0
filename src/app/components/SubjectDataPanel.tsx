// ── SubjectDataPanel (Feature #15, Phase 7a) ──────────────────────
// Answers "what does STRATUM hold about this person?" — the access request.
//
// Read-only. Nothing here destroys or changes anything, which is why it can
// ship with no policy configured and no legal precondition.
//
// TWO THINGS IT REFUSES TO DO QUIETLY
//   • It never renders an unreadable collection as empty. If a section could
//     not be read, it says so, and the export is labelled partial.
//   • It never shows credentials. The server strips them; this is only the
//     second line of that.

import { useState } from 'react';
import { Loader2, Download, FileSearch, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import {
  getSubjectData,
  buildExportBlob,
  exportFilename,
  meaningfulSections,
  totalRecords,
  collectionLabel,
  type SubjectData,
  type SubjectRole,
} from '../../lib/subjectDataService';

type Props = {
  role: SubjectRole;
  uid: string;
  displayName?: string | null;
};

export function SubjectDataPanel({ role, uid, displayName }: Props) {
  const [data, setData] = useState<SubjectData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      setData(await getSubjectData(role, uid));
    } catch (err) {
      console.error('[subject data] failed', err);
      setError((err as { message?: string })?.message || 'Could not load the record.');
    } finally {
      setLoading(false);
    }
  };

  const download = () => {
    if (!data) return;
    const url = URL.createObjectURL(buildExportBlob(data));
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFilename(data);
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!data) {
    return (
      <div className="flex flex-col gap-2">
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 self-start"
          style={{
            border: '1px solid #E3E1DB', borderRadius: 2,
            background: '#FFFFFF', color: '#6B6862',
            cursor: loading ? 'not-allowed' : 'pointer',
          }}
        >
          {loading ? <Loader2 size={11} className="animate-spin" /> : <FileSearch size={11} strokeWidth={1.5} />}
          {loading ? 'Gathering…' : 'View data held'}
        </button>
        {error && (
          <div className="flex items-start gap-2 text-xs px-2.5 py-2"
            style={{ background: '#FBF3F3', border: '1px solid #E8CFCF', borderRadius: 2, color: '#9B2828' }}>
            <AlertTriangle size={12} style={{ marginTop: 1, flexShrink: 0 }} />
            <span>{error}</span>
          </div>
        )}
      </div>
    );
  }

  const sections = meaningfulSections(data);
  const partial = data.unreadable.length > 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs" style={{ color: '#6B6862' }}>
          {totalRecords(data).toLocaleString()} record
          {totalRecords(data) === 1 ? '' : 's'} across {sections.length} area
          {sections.length === 1 ? '' : 's'}
          {displayName ? ` for ${displayName}` : ''}
        </p>
        <button
          onClick={download}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1 flex-shrink-0"
          style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF', color: '#6B6862' }}
        >
          <Download size={11} strokeWidth={1.5} /> Export JSON
        </button>
      </div>

      {/* A partial export must announce itself. Handing someone an incomplete
          answer they believe is complete is the failure this guards against. */}
      {partial && (
        <div className="flex items-start gap-2 text-xs px-2.5 py-2"
          style={{ background: '#FDF6E7', border: '1px solid #E8D9B0', borderRadius: 2, color: '#7A5B12' }}>
          <AlertTriangle size={12} style={{ marginTop: 1, flexShrink: 0 }} />
          <span>
            This record is incomplete — {data.unreadable.join(', ')} could not be
            read. The export is marked partial.
          </span>
        </div>
      )}

      <div style={{ border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}>
        {sections.map((s) => {
          const open = expanded === s.collection;
          const unreadable = s.records === null;
          return (
            <div key={s.collection} style={{ borderTop: '1px solid #F0EEE9' }}>
              <button
                onClick={() => setExpanded(open ? null : s.collection)}
                className="flex items-center justify-between gap-3 w-full px-2.5 py-2 text-left"
                style={{ background: 'transparent', cursor: 'pointer' }}
              >
                <span className="flex items-center gap-1.5 text-xs" style={{ color: '#0C0C0B' }}>
                  {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                  {collectionLabel(s.collection)}
                </span>
                <span className="text-xs" style={{ color: unreadable ? '#7A5B12' : '#6B6B66' }}>
                  {unreadable ? 'unreadable' : `${s.records!.length}`}
                </span>
              </button>
              {open && (
                <div className="px-2.5 pb-2">
                  {s.note && (
                    <p className="text-xs mb-1.5" style={{ color: '#6B6B66' }}>{s.note}</p>
                  )}
                  {unreadable ? (
                    <p className="text-xs" style={{ color: '#7A5B12' }}>
                      This area could not be read, so its contents are unknown.
                    </p>
                  ) : (
                    <pre className="text-xs overflow-x-auto"
                      style={{
                        background: '#F7F6F3', border: '1px solid #EDEBE5',
                        borderRadius: 2, padding: 8, maxHeight: 240,
                        color: '#3A3833', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                      }}>
                      {JSON.stringify(s.records, null, 2)}
                    </pre>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-xs" style={{ color: '#6B6B66', lineHeight: 1.5 }}>
        {data.note} Credentials and session tokens are excluded. Face detection
        during exams runs in the browser only — no images or biometric data are
        stored.
      </p>
    </div>
  );
}