/**
 * list/AssessmentRow — one assessment card in the list, with its actions
 * (preview, roster, edit menu, duplicate, delete).
 * (Batch F1a: extracted verbatim from AssignmentsPage.tsx.)
 */
import { useState } from 'react';
import { Eye, Trash2, Calendar, ArrowRight, Users, Copy } from 'lucide-react';
import { describeAssignment, type Assessment } from '../../../../lib/assessmentService';
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
      {assessment.subject && <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{assessment.subject}</span>}
      <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
        · {assessment.questions.length} Q · {assessment.totalMarks} marks
      </span>
      {sectionCount && (
        <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
          · {sectionCount} section{sectionCount !== 1 ? 's' : ''}
        </span>
      )}
      <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>· {describeAssignment(assessment)}</span>
    </div>
  );

  const dateBlock = assessment.startDate || assessment.endDate ? (
    <div className="flex items-center gap-1.5 md:justify-end">
      <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{formatDateShort(assessment.startDate)}</span>
      {assessment.endDate && (
        <><ArrowRight size={10} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
        <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{formatDateShort(assessment.endDate)}</span></>
      )}
    </div>
  ) : <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>No date set</span>;

  const actions = (
    <div className="flex items-center gap-1 flex-shrink-0">
      {assessment.status !== 'draft' && (
        <button onClick={onRoster} title="Live Roster"
          className="flex items-center gap-1 text-xs px-2 py-1.5 transition-all"
          style={{ border: '1px solid var(--ef-border)', color: 'var(--ef-text-subtle)', borderRadius: 2, background: 'var(--ef-canvas-raised)' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--ef-ink)'; (e.currentTarget as HTMLElement).style.color = 'var(--ef-ink)'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = 'var(--ef-border)'; (e.currentTarget as HTMLElement).style.color = 'var(--ef-text-subtle)'; }}>
          <Users size={11} strokeWidth={1.5} /> Roster
        </button>
      )}
      <button onClick={onPreview} title="Preview" className="p-1.5 transition-opacity hover:opacity-60" style={{ color: 'var(--ef-text-muted)' }}><Eye size={13} strokeWidth={1.5} /></button>
      <EditMenu assessment={assessment} onPatched={onPatched} onOpenLegacyEditor={onOpenLegacyEditor} />
      <button onClick={onDuplicate} title="Duplicate" className="p-1.5 transition-opacity hover:opacity-60" style={{ color: 'var(--ef-text-muted)' }}><Copy size={13} strokeWidth={1.5} /></button>
      <button onClick={onDelete} title="Delete" className="p-1.5 transition-opacity hover:opacity-60" style={{ color: 'var(--ef-text-muted)' }}><Trash2 size={13} strokeWidth={1.5} /></button>
    </div>
  );

  return (
    <div
      className="px-4 py-4 md:px-5 md:py-3.5 transition-colors"
      style={{ borderBottom: '1px solid var(--ef-border-subtle)', background: hovered ? 'var(--ef-canvas-raised)' : 'var(--ef-surface)' }}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    >
      {/* Desktop: single row */}
      <div className="hidden md:flex items-center gap-4">
        <div className="flex-shrink-0"><StatusBadgeChip status={assessment.status} /></div>
        <div className="flex-1 min-w-0">
          <p className="text-xs" style={{ color: 'var(--ef-ink)', lineHeight: 1.5 }}>
            {truncate(assessment.title, 80) || <em style={{ color: 'var(--ef-text-muted)' }}>Untitled Assessment</em>}
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
            color: 'var(--ef-ink)',
            fontSize: 14,
            lineHeight: 1.4,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {assessment.title || <em style={{ color: 'var(--ef-text-muted)' }}>Untitled Assessment</em>}
        </p>

        {/* Pill strip: status + subject + target */}
        <div className="flex items-center gap-1.5 flex-wrap mb-3">
          <StatusBadgeChip status={assessment.status} />
          {assessment.subject && (
            <span
              className="text-xs px-2 py-0.5"
              style={{ background: 'var(--ef-canvas)', color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border-subtle)', borderRadius: 2 }}
            >
              {assessment.subject}
            </span>
          )}
          <span
            className="text-xs px-2 py-0.5"
            style={{ background: 'var(--ef-canvas)', color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border-subtle)', borderRadius: 2 }}
          >
            {describeAssignment(assessment)}
          </span>
        </div>

        {/* Stats line — numbers + units */}
        <div className="flex items-center gap-x-2 gap-y-1 flex-wrap text-xs mb-2.5">
          <span><span style={{ color: 'var(--ef-ink)' }}>{assessment.questions.length}</span> <span style={{ color: 'var(--ef-text-muted)' }}>Q</span></span>
          <span style={{ color: 'var(--ef-border-muted)' }}>·</span>
          <span><span style={{ color: 'var(--ef-ink)' }}>{assessment.totalMarks}</span> <span style={{ color: 'var(--ef-text-muted)' }}>marks</span></span>
          {sectionCount ? (
            <>
              <span style={{ color: 'var(--ef-border-muted)' }}>·</span>
              <span>
                <span style={{ color: 'var(--ef-ink)' }}>{sectionCount}</span>{' '}
                <span style={{ color: 'var(--ef-text-muted)' }}>section{sectionCount !== 1 ? 's' : ''}</span>
              </span>
            </>
          ) : null}
        </div>

        {/* Schedule */}
        <div className="flex items-center gap-1.5 flex-wrap text-xs mb-3" style={{ color: 'var(--ef-text-muted)' }}>
          <Calendar size={11} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
          {assessment.startDate || assessment.endDate ? (
            <>
              <span>{formatDateShort(assessment.startDate)}</span>
              {assessment.endDate && (
                <>
                  <ArrowRight size={10} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
                  <span>{formatDateShort(assessment.endDate)}</span>
                </>
              )}
            </>
          ) : (
            <span style={{ color: 'var(--ef-text-muted)' }}>No schedule set</span>
          )}
        </div>

        {/* Action bar */}
        <div className="flex items-center gap-2 pt-3" style={{ borderTop: '1px solid var(--ef-border-subtle)' }}>
          {assessment.status !== 'draft' ? (
            <button
              onClick={onRoster}
              className="flex items-center justify-center gap-1.5 text-xs flex-1 transition-opacity hover:opacity-80"
              style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, height: 36, letterSpacing: '0.02em' }}
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
            style={{ width: 36, height: 36, color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}
          >
            <Eye size={14} strokeWidth={1.5} />
          </button>
          <div
            className="flex items-center justify-center"
            style={{ width: 36, height: 36, border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}
          >
            <EditMenu assessment={assessment} onPatched={onPatched} onOpenLegacyEditor={onOpenLegacyEditor} />
          </div>
          <button
            onClick={onDelete}
            aria-label="Delete"
            className="flex items-center justify-center transition-opacity hover:opacity-60"
            style={{ width: 36, height: 36, color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}
          >
            <Trash2 size={14} strokeWidth={1.5} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────