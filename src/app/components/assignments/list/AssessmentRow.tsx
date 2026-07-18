/**
 * list/AssessmentRow — one assessment card in the list, with its actions
 * (preview, roster, edit menu, duplicate, delete).
 * (Batch F1a: extracted verbatim from AssignmentsPage.tsx.)
 */
import { useState } from 'react';
import { Eye, Trash2, Calendar, ArrowRight, Users, Copy } from 'lucide-react';
import { formatAssignmentTarget, type Assessment } from '../../../../lib/assessmentService';
import { EditMenu } from '../edit/EditMenu';
import { formatDateShort, truncate } from '../builder/shared';
import { StatusBadgeChip } from './ListChrome';

export function AssessmentRow({ assessment, onPreview, onPatched, onOpenLegacyEditor, onDelete, onDuplicate, onRoster }: {
  assessment: Assessment;
  onPreview: () => void;
  onPatched: (patch: Partial<Assessment>) => void;
  onOpenLegacyEditor: () => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onRoster: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const sectionCount = assessment.sections?.length;

  const meta = (
    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
      {assessment.subject && <span className="text-xs" style={{ color: '#9A9891' }}>{assessment.subject}</span>}
      <span className="text-xs" style={{ color: '#C4C3BD' }}>
        · {assessment.questions.length} Q · {assessment.totalMarks} marks
      </span>
      {sectionCount && (
        <span className="text-xs" style={{ color: '#C4C3BD' }}>
          · {sectionCount} section{sectionCount !== 1 ? 's' : ''}
        </span>
      )}
      <span className="text-xs" style={{ color: '#C4C3BD' }}>· {formatAssignmentTarget(assessment.assignedTo)}</span>
    </div>
  );

  const dateBlock = assessment.startDate || assessment.endDate ? (
    <div className="flex items-center gap-1.5 md:justify-end">
      <span className="text-xs" style={{ color: '#9A9891' }}>{formatDateShort(assessment.startDate)}</span>
      {assessment.endDate && (
        <><ArrowRight size={10} strokeWidth={1.5} style={{ color: '#C4C3BD' }} />
        <span className="text-xs" style={{ color: '#9A9891' }}>{formatDateShort(assessment.endDate)}</span></>
      )}
    </div>
  ) : <span className="text-xs" style={{ color: '#C4C3BD' }}>No date set</span>;

  const actions = (
    <div className="flex items-center gap-1 flex-shrink-0">
      {assessment.status !== 'draft' && (
        <button onClick={onRoster} title="Live Roster"
          className="flex items-center gap-1 text-xs px-2 py-1.5 transition-all"
          style={{ border: '1px solid #E3E1DB', color: '#4A4A45', borderRadius: 2, background: '#FAFAF8' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#0C0C0B'; (e.currentTarget as HTMLElement).style.color = '#0C0C0B'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#E3E1DB'; (e.currentTarget as HTMLElement).style.color = '#4A4A45'; }}>
          <Users size={11} strokeWidth={1.5} /> Roster
        </button>
      )}
      <button onClick={onPreview} title="Preview" className="p-1.5 transition-opacity hover:opacity-60" style={{ color: '#9A9891' }}><Eye size={13} strokeWidth={1.5} /></button>
      <EditMenu assessment={assessment} onPatched={onPatched} onOpenLegacyEditor={onOpenLegacyEditor} />
      <button onClick={onDuplicate} title="Duplicate" className="p-1.5 transition-opacity hover:opacity-60" style={{ color: '#9A9891' }}><Copy size={13} strokeWidth={1.5} /></button>
      <button onClick={onDelete} title="Delete" className="p-1.5 transition-opacity hover:opacity-60" style={{ color: '#C4C3BD' }}><Trash2 size={13} strokeWidth={1.5} /></button>
    </div>
  );

  return (
    <div
      className="px-4 py-4 md:px-5 md:py-3.5 transition-colors"
      style={{ borderBottom: '1px solid #F0EFEB', background: hovered ? '#FAFAF8' : '#FFFFFF' }}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    >
      {/* Desktop: single row */}
      <div className="hidden md:flex items-center gap-4">
        <div className="flex-shrink-0"><StatusBadgeChip status={assessment.status} /></div>
        <div className="flex-1 min-w-0">
          <p className="text-xs" style={{ color: '#0C0C0B', lineHeight: 1.5 }}>
            {truncate(assessment.title, 80) || <em style={{ color: '#B0AEA8' }}>Untitled Assessment</em>}
          </p>
          {meta}
        </div>
        <div className="flex-shrink-0 text-right" style={{ minWidth: 148 }}>{dateBlock}</div>
        {actions}
      </div>

      {/* Phone: redesigned card */}
      <div className="md:hidden flex flex-col">
        {/* Title — 2-line clamp, primary type */}
        <p
          className="mb-2.5"
          style={{
            color: '#0C0C0B',
            fontSize: 14,
            lineHeight: 1.4,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {assessment.title || <em style={{ color: '#B0AEA8' }}>Untitled Assessment</em>}
        </p>

        {/* Pill strip: status + subject + target */}
        <div className="flex items-center gap-1.5 flex-wrap mb-3">
          <StatusBadgeChip status={assessment.status} />
          {assessment.subject && (
            <span
              className="text-xs px-2 py-0.5"
              style={{ background: '#F7F6F3', color: '#6B6B66', border: '1px solid #EEECEA', borderRadius: 2 }}
            >
              {assessment.subject}
            </span>
          )}
          <span
            className="text-xs px-2 py-0.5"
            style={{ background: '#F7F6F3', color: '#9A9891', border: '1px solid #EEECEA', borderRadius: 2 }}
          >
            {formatAssignmentTarget(assessment.assignedTo)}
          </span>
        </div>

        {/* Stats line — numbers + units */}
        <div className="flex items-center gap-x-2 gap-y-1 flex-wrap text-xs mb-2.5">
          <span><span style={{ color: '#0C0C0B' }}>{assessment.questions.length}</span> <span style={{ color: '#9A9891' }}>Q</span></span>
          <span style={{ color: '#DDDBD5' }}>·</span>
          <span><span style={{ color: '#0C0C0B' }}>{assessment.totalMarks}</span> <span style={{ color: '#9A9891' }}>marks</span></span>
          {sectionCount ? (
            <>
              <span style={{ color: '#DDDBD5' }}>·</span>
              <span>
                <span style={{ color: '#0C0C0B' }}>{sectionCount}</span>{' '}
                <span style={{ color: '#9A9891' }}>section{sectionCount !== 1 ? 's' : ''}</span>
              </span>
            </>
          ) : null}
        </div>

        {/* Schedule */}
        <div className="flex items-center gap-1.5 flex-wrap text-xs mb-3" style={{ color: '#9A9891' }}>
          <Calendar size={11} strokeWidth={1.5} style={{ color: '#C4C3BD', flexShrink: 0 }} />
          {assessment.startDate || assessment.endDate ? (
            <>
              <span>{formatDateShort(assessment.startDate)}</span>
              {assessment.endDate && (
                <>
                  <ArrowRight size={10} strokeWidth={1.5} style={{ color: '#C4C3BD' }} />
                  <span>{formatDateShort(assessment.endDate)}</span>
                </>
              )}
            </>
          ) : (
            <span style={{ color: '#C4C3BD' }}>No schedule set</span>
          )}
        </div>

        {/* Action bar */}
        <div className="flex items-center gap-2 pt-3" style={{ borderTop: '1px solid #F0EFEB' }}>
          {assessment.status !== 'draft' ? (
            <button
              onClick={onRoster}
              className="flex items-center justify-center gap-1.5 text-xs flex-1 transition-opacity hover:opacity-80"
              style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, height: 36, letterSpacing: '0.02em' }}
            >
              <Users size={12} strokeWidth={1.5} /> Live Roster
            </button>
          ) : (
            <div className="flex-1" />
          )}
          <button
            onClick={onPreview}
            aria-label="Preview"
            className="flex items-center justify-center transition-opacity hover:opacity-60"
            style={{ width: 36, height: 36, color: '#6B6B66', border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}
          >
            <Eye size={14} strokeWidth={1.5} />
          </button>
          <div
            className="flex items-center justify-center"
            style={{ width: 36, height: 36, border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}
          >
            <EditMenu assessment={assessment} onPatched={onPatched} onOpenLegacyEditor={onOpenLegacyEditor} />
          </div>
          <button
            onClick={onDelete}
            aria-label="Delete"
            className="flex items-center justify-center transition-opacity hover:opacity-60"
            style={{ width: 36, height: 36, color: '#9A9891', border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}
          >
            <Trash2 size={14} strokeWidth={1.5} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────