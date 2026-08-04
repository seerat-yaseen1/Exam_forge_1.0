import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  GraduationCap, Loader2, School, BookOpen, BookMarked, Calendar,
  Hash, Layers, Users, Group, ChevronRight, RefreshCw, AlertTriangle,
} from 'lucide-react';
import { useStudentAuth } from '../../context/StudentAuthContext';
import {
  getMappingsByStudent,
  type AcademicMapping,
  type NodeLevel,
} from '../../../lib/firebaseService';

// ── Helpers ────────────────────────────────────────────────────────

function getGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function formatDate(): string {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });
}

function formatShortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

// ── Node level metadata ────────────────────────────────────────────

const LEVEL_CONFIG: Record<NodeLevel, { label: string; icon: React.ReactNode; color: string; bg: string; border: string }> = {
  school:          { label: 'School',          icon: <School size={12} strokeWidth={1.5} />,      color: '#4A6FA5', bg: '#EEF3FB', border: '#C8D8F0' },
  academicLevel:   { label: 'Level',           icon: <GraduationCap size={12} strokeWidth={1.5} />, color: '#6B4A9B', bg: '#F3EEFB', border: '#D8C8F0' },
  program:         { label: 'Program',         icon: <BookOpen size={12} strokeWidth={1.5} />,    color: '#2A6B3A', bg: '#F0F7F2', border: '#C6DECE' },
  academicSession: { label: 'Session',         icon: <Calendar size={12} strokeWidth={1.5} />,    color: '#7A5A2A', bg: '#FAF5EE', border: '#E8D8B8' },
  academicYear:    { label: 'Year',            icon: <Hash size={12} strokeWidth={1.5} />,        color: '#5A7A2A', bg: '#F2F7EE', border: '#CCDAB8' },
  semester:        { label: 'Semester',        icon: <Layers size={12} strokeWidth={1.5} />,      color: '#2A6A7A', bg: '#EEF6F8', border: '#B8D8DE' },
  course:          { label: 'Course',          icon: <BookMarked size={12} strokeWidth={1.5} />,  color: '#6A2A3A', bg: '#F8EEF1', border: '#E0B8C4' },
  section:         { label: 'Section',         icon: <Users size={12} strokeWidth={1.5} />,       color: '#4A4A45', bg: '#F3F2EF', border: '#DDDBD5' },
  group:           { label: 'Group',           icon: <Group size={12} strokeWidth={1.5} />,       color: '#2A6B3A', bg: '#F0F7F2', border: '#C6DECE' },
};

// ── Assignment card ────────────────────────────────────────────────

function AssignmentCard({ mapping, index }: { mapping: AcademicMapping; index: number }) {
  const cfg = LEVEL_CONFIG[mapping.nodeType];

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: index * 0.04 }}
      className="p-4"
      style={{
        background: '#FFFFFF',
        border: '1px solid #E3E1DB',
        borderRadius: 3,
      }}
    >
      {/* Level badge + name */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <span
            className="inline-flex items-center gap-1 text-xs px-2 py-0.5"
            style={{ background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}`, borderRadius: 2 }}
          >
            {cfg.icon}
            {cfg.label}
          </span>
        </div>
        <span className="text-xs" style={{ color: '#6B6B66', flexShrink: 0 }}>
          {formatShortDate(mapping.createdAt)}
        </span>
      </div>

      <p className="text-sm" style={{ color: '#0C0C0B', lineHeight: 1.5, marginBottom: 8 }}>
        {mapping.nodeName}
      </p>

      {/* Breadcrumb trail */}
      <div className="flex items-center flex-wrap gap-0.5">
        {mapping.breadcrumb.split(' › ').map((crumb, i, arr) => (
          <span key={i} className="flex items-center gap-0.5">
            <span
              className="text-xs"
              style={{
                color: i === arr.length - 1 ? '#4A4A45' : '#6B6B66',
                fontWeight: i === arr.length - 1 ? 500 : 400,
              }}
            >
              {crumb}
            </span>
            {i < arr.length - 1 && (
              <ChevronRight size={10} strokeWidth={1.5} style={{ color: '#DDDBD5', flexShrink: 0 }} />
            )}
          </span>
        ))}
      </div>
    </motion.div>
  );
}

// ── Main page ──────────────────────────────────────────────────────

export function StudentLandingPage() {
  const { session } = useStudentAuth();

  const [mappings, setMappings]   = useState<AcademicMapping[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [syncAge, setSyncAge]     = useState('');

  const fetchMappings = useCallback(async () => {
    if (!session?.studentId) return;
    setLoading(true);
    setError('');
    try {
      const data = await getMappingsByStudent(session.studentId);
      // Sort by creation date descending
      data.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setMappings(data);
      setLastSynced(new Date());
    } catch (e: any) {
      setError(e.message || 'Failed to load assignments.');
    } finally {
      setLoading(false);
    }
  }, [session?.studentId]);

  useEffect(() => { fetchMappings(); }, [fetchMappings]);

  // Sync age ticker
  useEffect(() => {
    if (!lastSynced) return;
    const fmt = (d: Date) => {
      const s = Math.floor((Date.now() - d.getTime()) / 1000);
      if (s < 10) return 'just now';
      if (s < 60) return `${s}s ago`;
      return `${Math.floor(s / 60)}m ago`;
    };
    setSyncAge(fmt(lastSynced));
    const t = setInterval(() => setSyncAge(fmt(lastSynced)), 1000);
    return () => clearInterval(t);
  }, [lastSynced]);

  if (!session) return null;

  const firstName = session.name.split(' ')[0];

  // Group mappings by level
  const grouped = mappings.reduce<Record<string, AcademicMapping[]>>((acc, m) => {
    const label = LEVEL_CONFIG[m.nodeType]?.label ?? m.nodeType;
    if (!acc[label]) acc[label] = [];
    acc[label].push(m);
    return acc;
  }, {});

  // Preferred display order
  const LEVEL_ORDER: NodeLevel[] = [
    'school', 'academicLevel', 'program', 'academicSession',
    'academicYear', 'semester', 'course', 'section', 'group',
  ];

  const orderedGroups = LEVEL_ORDER
    .map((nl) => ({ nodeType: nl, label: LEVEL_CONFIG[nl].label, items: grouped[LEVEL_CONFIG[nl].label] ?? [] }))
    .filter((g) => g.items.length > 0);

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="px-8 py-10"
      style={{ maxWidth: 960, margin: '0 auto' }}
    >
      {/* Page header */}
      <div className="mb-8" style={{ borderBottom: '1px solid #E3E1DB', paddingBottom: 20 }}>
        <div className="flex items-center gap-2 mb-2">
          <div style={{ width: 4, height: 4, borderRadius: '50%', background: '#2A6B3A' }} />
          <p className="text-xs" style={{ color: '#6B6B66', letterSpacing: '0.1em' }}>
            STUDENT · {session.instituteName.toUpperCase()}
          </p>
        </div>
        <p className="text-xs mb-2" style={{ color: '#6B6B66', letterSpacing: '0.06em' }}>
          {formatDate()}
        </p>
        <h1 className="text-2xl font-light" style={{ color: '#0C0C0B', letterSpacing: '0.02em' }}>
          {getGreeting()}, {firstName}.
        </h1>
        <div className="flex items-center gap-3 mt-2">
          <span className="inline-block text-xs px-2 py-0.5"
            style={{ background: '#F0EFEB', color: '#4A4A45', borderRadius: 2 }}>
            Student
          </span>
          <span className="text-xs" style={{ color: '#6B6B66' }}>
            <span style={{ fontFamily: 'monospace', letterSpacing: '0.08em', color: '#6B6B66' }}>
              {session.email}
            </span>
          </span>
          <span style={{ color: '#E3E1DB' }}>·</span>
          <span className="inline-flex items-center gap-1.5 text-xs"
            style={session.status === 'active'
              ? { color: '#2A6B3A' }
              : { color: '#6B6B66' }}>
            <span style={{
              width: 5, height: 5, borderRadius: '50%', display: 'inline-block',
              background: session.status === 'active' ? '#2A6B3A' : '#6B6B66',
            }} />
            {session.status === 'active' ? 'Active' : 'Disabled'}
          </span>
        </div>
      </div>

      {/* Assignments section */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <span className="text-xs" style={{ color: '#6B6B66', letterSpacing: '0.08em' }}>
            ACADEMIC ASSIGNMENTS
          </span>
          {!loading && mappings.length > 0 && (
            <span className="text-xs px-1.5 py-0.5"
              style={{ background: '#F0EFEB', color: '#6B6B66', borderRadius: 10 }}>
              {mappings.length}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3">
          {/* Live indicator */}
          {lastSynced && !loading && (
            <div className="flex items-center gap-1.5 select-none">
              <div className="relative w-2 h-2 flex items-center justify-center">
                <span className="absolute inline-flex w-2 h-2 rounded-full opacity-60"
                  style={{ background: '#2A6B3A', animation: 'ping 1.8s cubic-bezier(0,0,0.2,1) infinite' }} />
                <span className="relative inline-flex w-1.5 h-1.5 rounded-full" style={{ background: '#2A6B3A' }} />
              </div>
              <span className="text-xs" style={{ color: '#6B6B66' }}>{syncAge}</span>
            </div>
          )}
          <button
            onClick={fetchMappings}
            disabled={loading}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 transition-colors"
            style={{ border: '1px solid #E3E1DB', color: '#4A4A45', borderRadius: 2, background: '#FFFFFF' }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.borderColor = '#0C0C0B')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.borderColor = '#E3E1DB')}
          >
            <RefreshCw size={10} strokeWidth={1.5} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {/* Content */}
      <AnimatePresence mode="wait">
        {loading && (
          <motion.div key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="flex flex-col items-center py-20">
              <Loader2 size={20} strokeWidth={1} className="animate-spin" style={{ color: '#6B6B66' }} />
              <p className="text-xs mt-4" style={{ color: '#6B6B66' }}>Loading assignments…</p>
            </div>
          </motion.div>
        )}

        {!loading && error && (
          <motion.div key="error" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="flex items-center gap-2.5 px-4 py-3"
              style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2 }}>
              <AlertTriangle size={12} strokeWidth={1.5} style={{ color: '#9B2828', flexShrink: 0 }} />
              <p className="text-xs flex-1" style={{ color: '#9B2828' }}>{error}</p>
              <button onClick={fetchMappings} className="text-xs"
                style={{ color: '#9B2828', textDecoration: 'underline' }}>Retry</button>
            </div>
          </motion.div>
        )}

        {!loading && !error && mappings.length === 0 && (
          <motion.div key="empty" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }} transition={{ duration: 0.25 }}>
            <div className="flex flex-col items-center py-24"
              style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3 }}>
              <GraduationCap size={32} strokeWidth={1} style={{ color: '#DDDBD5' }} />
              <p className="text-xs mt-4" style={{ color: '#6B6B66', letterSpacing: '0.06em' }}>
                No assignments yet
              </p>
              <p className="text-xs mt-2" style={{ color: '#DDDBD5', maxWidth: 280, textAlign: 'center', lineHeight: 1.7 }}>
                You haven't been assigned to any courses, sections, or groups. Your institute administrator will set this up.
              </p>
            </div>
          </motion.div>
        )}

        {!loading && !error && mappings.length > 0 && (
          <motion.div key="content" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {/* Grouped by level */}
            {orderedGroups.length > 0 ? (
              <div className="space-y-8">
                {orderedGroups.map(({ nodeType, label, items }) => {
                  const cfg = LEVEL_CONFIG[nodeType];
                  return (
                    <div key={nodeType}>
                      {/* Group header */}
                      <div className="flex items-center gap-2 mb-3">
                        <span className="text-xs" style={{ color: '#6B6B66', letterSpacing: '0.08em' }}>
                          {label.toUpperCase()}S
                        </span>
                        <span className="text-xs px-1.5 py-0.5"
                          style={{ background: cfg.bg, color: cfg.color, borderRadius: 10 }}>
                          {items.length}
                        </span>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {items.map((m, i) => (
                          <AssignmentCard key={m.id} mapping={m} index={i} />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              // Flat list fallback (ungrouped)
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {mappings.map((m, i) => (
                  <AssignmentCard key={m.id} mapping={m} index={i} />
                ))}
              </div>
            )}

            {/* Footer note */}
            <p className="text-xs mt-6" style={{ color: '#6B6B66', textAlign: 'center' }}>
              Your assignments are managed by your institute administrator.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
