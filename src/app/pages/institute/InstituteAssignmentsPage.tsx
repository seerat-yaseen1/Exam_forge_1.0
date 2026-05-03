/**
 * InstituteAssignmentsPage
 *
 * Institute Admin view: shows all non-draft assessments assigned to their
 * institute (or all students). Gated by canAdminManageExamRosters.
 */

import { useState, useEffect } from 'react';
import { useNavigate, Navigate } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import {
  ClipboardList, ChevronRight, Loader2, Calendar, Clock,
  Users, BookOpen, Layers, Search, Users2,
} from 'lucide-react';
import { useInstituteAuth } from '../../context/InstituteAuthContext';
import {
  getAllAssessments,
  statusColor,
  formatAssignmentTarget,
  type Assessment,
  type AssessmentStatus,
} from '../../../lib/assessmentService';

// ── Helpers ───────────────────────────────────────────────────────

function formatDateShort(iso?: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function statusLabel(s: AssessmentStatus): string {
  return s === 'draft' ? 'Draft' : s === 'active' ? 'Active' : 'Closed';
}

// ── Assessment card ───────────────────────────────────────────────

function AssessmentCard({
  assessment, onClick,
}: {
  assessment: Assessment;
  onClick: () => void;
}) {
  const sc = statusColor(assessment.status);
  const sectionCount = assessment.sections?.length ?? 0;
  const questionCount = assessment.sections
    ? assessment.sections.reduce((s, sec) => s + sec.questions.length, 0)
    : assessment.questions.length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -1 }}
      onClick={onClick}
      className="cursor-pointer"
      style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3, padding: '18px 20px' }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 16px rgba(0,0,0,0.06)';
        (e.currentTarget as HTMLElement).style.borderColor = '#C4C3BD';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.boxShadow = 'none';
        (e.currentTarget as HTMLElement).style.borderColor = '#E3E1DB';
      }}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <p className="text-xs" style={{ color: '#0C0C0B', lineHeight: 1.5 }}>{assessment.title}</p>
          {assessment.subject && (
            <p className="text-xs mt-0.5" style={{ color: '#9A9891' }}>{assessment.subject}</p>
          )}
        </div>
        <span className="text-xs px-2 py-0.5 flex-shrink-0"
          style={{ background: sc.bg, color: sc.text, border: `1px solid ${sc.border}`, borderRadius: 2 }}>
          {statusLabel(assessment.status)}
        </span>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        {sectionCount > 0 && (
          <div className="flex items-center gap-1">
            <Layers size={10} strokeWidth={1.5} style={{ color: '#C4C3BD' }} />
            <span className="text-xs" style={{ color: '#9A9891' }}>{sectionCount} section{sectionCount !== 1 ? 's' : ''}</span>
          </div>
        )}
        {questionCount > 0 && (
          <div className="flex items-center gap-1">
            <BookOpen size={10} strokeWidth={1.5} style={{ color: '#C4C3BD' }} />
            <span className="text-xs" style={{ color: '#9A9891' }}>{questionCount} question{questionCount !== 1 ? 's' : ''}</span>
          </div>
        )}
        <div className="flex items-center gap-1">
          <Users size={10} strokeWidth={1.5} style={{ color: '#C4C3BD' }} />
          <span className="text-xs" style={{ color: '#9A9891' }}>{formatAssignmentTarget(assessment.assignedTo)}</span>
        </div>
      </div>

      <div className="flex items-center justify-between mt-3 pt-3" style={{ borderTop: '1px solid #F0EFEB' }}>
        <div className="flex items-center gap-3">
          {assessment.startDate && (
            <div className="flex items-center gap-1">
              <Calendar size={10} strokeWidth={1.5} style={{ color: '#C4C3BD' }} />
              <span className="text-xs" style={{ color: '#9A9891' }}>{formatDateShort(assessment.startDate)}</span>
            </div>
          )}
          {assessment.endDate && (
            <div className="flex items-center gap-1">
              <Clock size={10} strokeWidth={1.5} style={{ color: '#C4C3BD' }} />
              <span className="text-xs" style={{ color: '#9A9891' }}>ends {formatDateShort(assessment.endDate)}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-1" style={{ color: '#C4C3BD' }}>
          <span className="text-xs">View roster</span>
          <ChevronRight size={11} strokeWidth={1.5} />
        </div>
      </div>
    </motion.div>
  );
}

// ── Main page ─────────────────────────────────────────────────────

export function InstituteAssignmentsPage() {
  const navigate = useNavigate();
  const { session } = useInstituteAuth();

  // Permission gate
  if (!session?.canAdminManageExamRosters) {
    return <Navigate to="/institute/dashboard" replace />;
  }

  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [loading, setLoading]         = useState(true);
  const [search, setSearch]           = useState('');
  const [filterStatus, setFilterStatus] = useState<AssessmentStatus | 'all'>('active');

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    getAllAssessments()
      .then((all) => {
        // Show assessments targeting this institute or all students (not faculty-private ones)
        const relevant = all.filter((a) => {
          if (a.status === 'draft') return false; // hide drafts from admin view
          const t = a.assignedTo;
          if (t.type === 'all') return true;
          if (t.type === 'institutes') return t.instituteIds.includes(session.instituteId);
          // 'students' type: include if any student is from this institute (simplified: include all)
          return true;
        });
        relevant.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        setAssessments(relevant);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [session]);

  const filtered = assessments.filter((a) => {
    const matchSearch = !search ||
      a.title.toLowerCase().includes(search.toLowerCase()) ||
      (a.subject ?? '').toLowerCase().includes(search.toLowerCase());
    const matchStatus = filterStatus === 'all' || a.status === filterStatus;
    return matchSearch && matchStatus;
  });

  const statusTabs: Array<{ value: AssessmentStatus | 'all'; label: string }> = [
    { value: 'active', label: 'Active' },
    { value: 'all',    label: 'All' },
    { value: 'closed', label: 'Closed' },
  ];

  return (
    <div className="min-h-screen" style={{ background: '#F7F6F3' }}>
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '40px 24px' }}>

        <div className="flex items-center justify-between mb-8">
          <div>
            <p className="text-xs mb-1" style={{ color: '#9A9891', letterSpacing: '0.1em' }}>INSTITUTE ADMIN · ASSIGNMENTS</p>
            <h1 className="text-sm" style={{ color: '#0C0C0B' }}>Exam Rosters</h1>
            <p className="text-xs mt-1" style={{ color: '#B0AEA8' }}>
              Monitor live student sessions and manage exam access for your institute.
            </p>
          </div>
          <div className="flex items-center gap-1.5 text-xs px-3 py-1.5"
            style={{ background: '#F0EFEB', border: '1px solid #E3E1DB', borderRadius: 2, color: '#9A9891' }}>
            <Users2 size={11} strokeWidth={1.5} />
            {assessments.length} assessments
          </div>
        </div>

        {/* Search + filter */}
        <div className="flex items-center gap-3 mb-6">
          <div className="flex items-center gap-2 flex-1 px-3 py-2"
            style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 2 }}>
            <Search size={12} strokeWidth={1.5} style={{ color: '#C4C3BD', flexShrink: 0 }} />
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search assessments…" className="flex-1 text-xs outline-none bg-transparent"
              style={{ color: '#0C0C0B' }} />
          </div>
          <div className="flex items-center gap-1">
            {statusTabs.map((tab) => (
              <button key={tab.value} onClick={() => setFilterStatus(tab.value)}
                className="text-xs px-3 py-1.5 transition-colors"
                style={{
                  borderRadius: 2,
                  background: filterStatus === tab.value ? '#0C0C0B' : 'transparent',
                  color: filterStatus === tab.value ? '#FFFFFF' : '#9A9891',
                  border: filterStatus === tab.value ? '1px solid #0C0C0B' : '1px solid #E3E1DB',
                  cursor: 'pointer',
                }}>
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* List */}
        {loading ? (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <Loader2 size={18} strokeWidth={1} className="animate-spin" style={{ color: '#C4C3BD' }} />
            <p className="text-xs" style={{ color: '#C4C3BD' }}>Loading…</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-3">
            <ClipboardList size={24} strokeWidth={1} style={{ color: '#C4C3BD' }} />
            <p className="text-xs" style={{ color: '#C4C3BD' }}>
              {search || filterStatus !== 'all' ? 'No assessments match your filters.' : 'No active assessments assigned to your institute.'}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <AnimatePresence>
              {filtered.map((a) => (
                <AssessmentCard
                  key={a.id}
                  assessment={a}
                  onClick={() => navigate(`/institute/assignments/${a.id}/roster`)}
                />
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
}
