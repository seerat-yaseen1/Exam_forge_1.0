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
import {
  getAssessmentsByOwner,
  statusColor,
  describeAssignment,
  type Assessment,
  type AssessmentStatus,
} from '../../../lib/assessmentService';

// ── Helpers ───────────────────────────────────────────────────────

function formatDate(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

function formatDateShort(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

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
        background: '#FFFFFF',
        border: '1px solid #E3E1DB',
        borderRadius: 3,
        padding: '18px 20px',
        transition: 'box-shadow 0.15s',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 16px rgba(0,0,0,0.06)';
        (e.currentTarget as HTMLElement).style.borderColor = '#6B6B66';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow = 'none';
        (e.currentTarget as HTMLElement).style.borderColor = '#E3E1DB';
      }}
    >
      {/* Row 1: title + status */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <p className="text-xs" style={{ color: '#0C0C0B', lineHeight: 1.5 }}>
            {assessment.title}
          </p>
          {assessment.subject && (
            <p className="text-xs mt-0.5" style={{ color: '#6B6B66' }}>
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
            <Layers size={10} strokeWidth={1.5} style={{ color: '#6B6B66' }} />
            <span className="text-xs" style={{ color: '#6B6B66' }}>
              {sectionCount} section{sectionCount !== 1 ? 's' : ''}
            </span>
          </div>
        )}
        {questionCount > 0 && (
          <div className="flex items-center gap-1">
            <BookOpen size={10} strokeWidth={1.5} style={{ color: '#6B6B66' }} />
            <span className="text-xs" style={{ color: '#6B6B66' }}>
              {questionCount} question{questionCount !== 1 ? 's' : ''}
            </span>
          </div>
        )}
        <div className="flex items-center gap-1">
          <Users size={10} strokeWidth={1.5} style={{ color: '#6B6B66' }} />
          <span className="text-xs" style={{ color: '#6B6B66' }}>
            {describeAssignment(assessment)}
          </span>
        </div>
        {assessment.totalMarks > 0 && (
          <div className="flex items-center gap-1">
            <span className="text-xs" style={{ color: '#6B6B66' }}>
              {assessment.totalMarks} marks
            </span>
          </div>
        )}
      </div>

      {/* Row 3: dates */}
      <div className="flex items-center justify-between mt-3 pt-3"
        style={{ borderTop: '1px solid #F0EFEB' }}>
        <div className="flex items-center gap-3">
          {assessment.startDate && (
            <div className="flex items-center gap-1">
              <Calendar size={10} strokeWidth={1.5} style={{ color: '#6B6B66' }} />
              <span className="text-xs" style={{ color: '#6B6B66' }}>
                {formatDateShort(assessment.startDate)}
              </span>
            </div>
          )}
          {assessment.endDate && (
            <div className="flex items-center gap-1">
              <Clock size={10} strokeWidth={1.5} style={{ color: '#6B6B66' }} />
              <span className="text-xs" style={{ color: '#6B6B66' }}>
                ends {formatDateShort(assessment.endDate)}
              </span>
            </div>
          )}
        </div>
        {assessment.status !== 'draft' && rosterAllowed ? (
          <div className="flex items-center gap-1" style={{ color: '#6B6B66' }}>
            <span className="text-xs">View roster</span>
            <ChevronRight size={11} strokeWidth={1.5} />
          </div>
        ) : assessment.status === 'draft' ? (
          <span className="text-xs" style={{ color: '#6B6B66' }}>Draft — no roster</span>
        ) : (
          <div className="flex items-center gap-1" style={{ color: '#6B6B66' }}>
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
    <div className="min-h-screen" style={{ background: '#F7F6F3' }}>
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '40px 24px' }}>

        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <p className="text-xs mb-1" style={{ color: '#6B6B66', letterSpacing: '0.1em' }}>
              ASSIGNMENTS
            </p>
            <h1 className="text-sm" style={{ color: '#0C0C0B' }}>
              My Assessments
            </h1>
          </div>
          <div className="flex items-center gap-1.5 text-xs px-3 py-1.5"
            style={{ background: '#F0EFEB', border: '1px solid #E3E1DB', borderRadius: 2, color: '#6B6B66' }}>
            <ClipboardList size={11} strokeWidth={1.5} />
            {assessments.length} total
          </div>
        </div>

        {/* Search + filter */}
        <div className="flex items-center gap-3 mb-6">
          <div className="flex items-center gap-2 flex-1 px-3 py-2"
            style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 2 }}>
            <Search size={12} strokeWidth={1.5} style={{ color: '#6B6B66', flexShrink: 0 }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search assessments…"
              className="flex-1 text-xs outline-none bg-transparent"
              style={{ color: '#0C0C0B' }}
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
                  background: filterStatus === tab.value ? '#0C0C0B' : 'transparent',
                  color: filterStatus === tab.value ? '#FFFFFF' : '#6B6B66',
                  border: filterStatus === tab.value ? '1px solid #0C0C0B' : '1px solid #E3E1DB',
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
            <Loader2 size={18} strokeWidth={1} className="animate-spin" style={{ color: '#6B6B66' }} />
            <p className="text-xs" style={{ color: '#6B6B66' }}>Loading assessments…</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <ClipboardList size={24} strokeWidth={1} style={{ color: '#6B6B66' }} />
            <p className="text-xs" style={{ color: '#6B6B66' }}>
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