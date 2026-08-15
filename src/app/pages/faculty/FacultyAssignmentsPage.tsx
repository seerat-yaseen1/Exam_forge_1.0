/**
 * FacultyAssignmentsPage
 *
 * Lists all assessments created by this faculty member.
 * Clicking an assessment opens the live student roster.
 */

import { useState, useEffect } from 'react';
import { useNavigate, Navigate } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import {
  ClipboardList, ChevronRight, Loader2, Calendar, Clock,
  Users, BookOpen, Layers, AlertTriangle, Plus, Search, Lock,
} from 'lucide-react';
import { useFacultyAuth } from '../../context/FacultyAuthContext';
import { formatDayMonth as formatDateShort, formatDate } from '../../../lib/dateFormat';
import {
  getAssessmentsByOwner,
  statusColor,
  describeAssignment,
  type Assessment,
  type AssessmentStatus,
} from '../../../lib/assessmentService';

// ── Helpers ───────────────────────────────────────────────────────

function statusLabel(s: AssessmentStatus): string {
  return s === 'draft' ? 'Draft' : s === 'active' ? 'Active' : 'Closed';
}

// ── Assessment card ───────────────────────────────────────────────

function AssessmentCard({
  assessment,
  onClick,
  rosterAllowed,
}: {
  assessment: Assessment;
  onClick: () => void;
  rosterAllowed: boolean;
}) {
  const sc = statusColor(assessment.status);
  const sectionCount = assessment.sections?.length ?? 0;
  const questionCount = assessment.sections
    ? assessment.sections.reduce((s, sec) => s + sec.questions.length, 0)
    : assessment.questions.length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -1 }}
      onClick={onClick}
      className="cursor-pointer"
      style={{
        background: 'var(--ef-surface)',
        border: '1px solid var(--ef-border)',
        borderRadius: 3,
        padding: '18px 20px',
        transition: 'box-shadow 0.15s',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 16px rgba(0,0,0,0.06)';
        (e.currentTarget as HTMLElement).style.borderColor = 'var(--ef-text-muted)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow = 'none';
        (e.currentTarget as HTMLElement).style.borderColor = 'var(--ef-border)';
      }}
    >
      {/* Row 1: title + status */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <p className="text-xs" style={{ color: 'var(--ef-ink)', lineHeight: 1.5 }}>
            {assessment.title}
          </p>
          {assessment.subject && (
            <p className="text-xs mt-0.5" style={{ color: 'var(--ef-text-muted)' }}>
              {assessment.subject}
            </p>
          )}
        </div>
        <span
          className="text-xs px-2 py-0.5 flex-shrink-0"
          style={{
            background: sc.bg, color: sc.text,
            border: `1px solid ${sc.border}`, borderRadius: 2,
          }}
        >
          {statusLabel(assessment.status)}
        </span>
      </div>

      {/* Row 2: meta pills */}
      <div className="flex items-center gap-3 flex-wrap">
        {sectionCount > 0 && (
          <div className="flex items-center gap-1">
            <Layers size={10} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
            <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
              {sectionCount} section{sectionCount !== 1 ? 's' : ''}
            </span>
          </div>
        )}
        {questionCount > 0 && (
          <div className="flex items-center gap-1">
            <BookOpen size={10} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
            <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
              {questionCount} question{questionCount !== 1 ? 's' : ''}
            </span>
          </div>
        )}
        <div className="flex items-center gap-1">
          <Users size={10} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
          <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
            {describeAssignment(assessment)}
          </span>
        </div>
        {assessment.totalMarks > 0 && (
          <div className="flex items-center gap-1">
            <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
              {assessment.totalMarks} marks
            </span>
          </div>
        )}
      </div>

      {/* Row 3: dates */}
      <div className="flex items-center justify-between mt-3 pt-3"
        style={{ borderTop: '1px solid var(--ef-border-subtle)' }}>
        <div className="flex items-center gap-3">
          {assessment.startDate && (
            <div className="flex items-center gap-1">
              <Calendar size={10} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
              <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                {formatDateShort(assessment.startDate)}
              </span>
            </div>
          )}
          {assessment.endDate && (
            <div className="flex items-center gap-1">
              <Clock size={10} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
              <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                ends {formatDateShort(assessment.endDate)}
              </span>
            </div>
          )}
        </div>
        {assessment.status !== 'draft' && rosterAllowed ? (
          <div className="flex items-center gap-1" style={{ color: 'var(--ef-text-muted)' }}>
            <span className="text-xs">View roster</span>
            <ChevronRight size={11} strokeWidth={1.5} />
          </div>
        ) : assessment.status === 'draft' ? (
          <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>Draft — no roster</span>
        ) : (
          <div className="flex items-center gap-1" style={{ color: 'var(--ef-text-muted)' }}>
            <Lock size={10} strokeWidth={1.5} />
            <span className="text-xs">Roster access restricted</span>
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ── Main page ─────────────────────────────────────────────────────

export function FacultyAssignmentsPage() {
  const navigate = useNavigate();
  const { session } = useFacultyAuth();

  // Permission gate — redirect if neither gate is open
  if (!session?.canManageExamRosters) {
    return <Navigate to="/faculty/dashboard" replace />;
  }

  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [loading, setLoading]         = useState(true);
  const [search, setSearch]           = useState('');
  const [filterStatus, setFilterStatus] = useState<AssessmentStatus | 'all'>('all');

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    getAssessmentsByOwner('faculty', session.facultyId)
      .then((list) => {
        list.sort((a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        setAssessments(list);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [session]);

  const filtered = assessments.filter((a) => {
    const matchSearch =
      !search ||
      a.title.toLowerCase().includes(search.toLowerCase()) ||
      (a.subject ?? '').toLowerCase().includes(search.toLowerCase());
    const matchStatus = filterStatus === 'all' || a.status === filterStatus;
    return matchSearch && matchStatus && !a.isDeleted;
  });

  const statusTabs: Array<{ value: AssessmentStatus | 'all'; label: string }> = [
    { value: 'all', label: 'All' },
    { value: 'active', label: 'Active' },
    { value: 'draft', label: 'Draft' },
    { value: 'closed', label: 'Closed' },
  ];

  return (
    <div className="min-h-screen" style={{ background: 'var(--ef-canvas)' }}>
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '40px 24px' }}>

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <p className="text-xs mb-1" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>
              ASSIGNMENTS
            </p>
            <h1 className="text-sm" style={{ color: 'var(--ef-ink)' }}>
              My Assessments
            </h1>
          </div>
          <div className="flex items-center gap-1.5 text-xs px-3 py-1.5"
            style={{ background: 'var(--ef-border-subtle)', border: '1px solid var(--ef-border)', borderRadius: 2, color: 'var(--ef-text-muted)' }}>
            <ClipboardList size={11} strokeWidth={1.5} />
            {assessments.length} total
          </div>
        </div>

        {/* Search + filter */}
        <div className="flex items-center gap-3 mb-6">
          <div className="flex items-center gap-2 flex-1 px-3 py-2"
            style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
            <Search size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search assessments…"
              className="flex-1 text-xs outline-none bg-transparent"
              style={{ color: 'var(--ef-ink)' }}
            />
          </div>
          <div className="flex items-center gap-1">
            {statusTabs.map((tab) => (
              <button
                key={tab.value}
                onClick={() => setFilterStatus(tab.value)}
                className="text-xs px-3 py-1.5 transition-colors"
                style={{
                  borderRadius: 2,
                  background: filterStatus === tab.value ? 'var(--ef-ink)' : 'transparent',
                  color: filterStatus === tab.value ? 'var(--ef-surface)' : 'var(--ef-text-muted)',
                  border: filterStatus === tab.value ? '1px solid var(--ef-ink)' : '1px solid var(--ef-border)',
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Content */}
        {loading ? (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <Loader2 size={18} strokeWidth={1} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />
            <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>Loading assessments…</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <ClipboardList size={24} strokeWidth={1} style={{ color: 'var(--ef-text-muted)' }} />
            <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
              {search || filterStatus !== 'all' ? 'No assessments match your filters.' : 'No assessments created yet.'}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <AnimatePresence>
              {filtered.map((a) => (
                <AssessmentCard
                  key={a.id}
                  assessment={a}
                  rosterAllowed={session.canManageExamRosters}
                  onClick={() => {
                    if (a.status !== 'draft' && session.canManageExamRosters) {
                      navigate(`/faculty/assignments/${a.id}/roster`);
                    }
                  }}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}