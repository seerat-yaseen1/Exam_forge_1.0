import React, { useState, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Users, GraduationCap, School, Loader2, AlertTriangle, Lock } from 'lucide-react';
import { useInstituteAuth } from '../../context/InstituteAuthContext';
import {
  getFacultyByInstitute,
  getStudentsByInstitute,
  getInstitute,
  type Faculty,
  type Student,
} from '../../../lib/firebaseService';
import { SchoolsTab } from '../../components/schools/SchoolsTab';
import { FacultyTab } from '../../components/faculty/FacultyTab';
import { StudentTab } from '../../components/student/StudentTab';

// ── Types ─────────────────────────────────────────────────────────

type Tab = 'faculties' | 'students' | 'schools';

// ── Helpers ───────────────────────────────────────────────────────

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

function formatSyncAge(d: Date) {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

// ── Faculty list ──────────────────────────────────────────────────

function FacultyList({ instituteId }: { instituteId: string }) {
  const [faculties, setFaculties]     = useState<Faculty[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');
  const [lastSynced, setLastSynced]   = useState<Date | null>(null);
  const [syncDisplay, setSyncDisplay] = useState('');

  const fetch_ = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await getFacultyByInstitute(instituteId);
      setFaculties(data);
      setLastSynced(new Date());
      setError('');
    } catch (e: any) {
      if (!silent) setError(e.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [instituteId]);

  useEffect(() => {
    fetch_();
    const poll = setInterval(() => fetch_(true), 5000);
    return () => clearInterval(poll);
  }, [fetch_]);

  useEffect(() => {
    if (!lastSynced) return;
    setSyncDisplay(formatSyncAge(lastSynced));
    const t = setInterval(() => setSyncDisplay(formatSyncAge(lastSynced)), 1000);
    return () => clearInterval(t);
  }, [lastSynced]);

  const active   = faculties.filter((f) => f.status === 'active').length;
  const disabled = faculties.filter((f) => f.status === 'disabled').length;

  // ── Loading skeleton ──
  if (loading) {
    return (
      <div className="py-12 flex flex-col items-center gap-3">
        <Loader2 size={20} strokeWidth={1} className="animate-spin" style={{ color: '#C4C3BD' }} />
        <p className="text-xs" style={{ color: '#C4C3BD' }}>Loading faculty…</p>
      </div>
    );
  }

  // ── Error ──
  if (error) {
    return (
      <div className="mx-6 mt-6 flex items-center gap-2 px-4 py-3"
        style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2 }}>
        <AlertTriangle size={12} strokeWidth={1.5} style={{ color: '#9B2828' }} />
        <p className="text-xs" style={{ color: '#9B2828' }}>{error}</p>
        <button onClick={() => fetch_()} className="ml-auto text-xs"
          style={{ color: '#9B2828', textDecoration: 'underline' }}>
          Retry
        </button>
      </div>
    );
  }

  // ── Empty ──
  if (faculties.length === 0) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="flex flex-col items-center justify-center py-24"
      >
        <Users size={28} strokeWidth={1} style={{ color: '#DDDBD5' }} />
        <p className="text-xs mt-4" style={{ color: '#C4C3BD', letterSpacing: '0.06em' }}>
          No faculty registered
        </p>
        <p className="text-xs mt-1.5" style={{ color: '#DDDBD5', maxWidth: 260, textAlign: 'center', lineHeight: 1.6 }}>
          Faculty accounts are provisioned by the platform administrator.
        </p>
      </motion.div>
    );
  }

  // ── Table ──
  return (
    <div className="px-0">
      {/* Stats + sync strip */}
      <div className="flex items-center gap-3 px-5 py-3"
        style={{ borderBottom: '1px solid #F0EFEB', background: '#FAFAF8' }}>
        <span className="text-xs" style={{ color: '#9A9891' }}>
          {faculties.length} {faculties.length === 1 ? 'member' : 'members'}
        </span>
        <span style={{ color: '#E3E1DB' }}>·</span>
        <span className="text-xs" style={{ color: '#2A6B3A' }}>{active} active</span>
        {disabled > 0 && (
          <>
            <span style={{ color: '#E3E1DB' }}>·</span>
            <span className="text-xs" style={{ color: '#9A9891' }}>{disabled} disabled</span>
          </>
        )}
        {/* Live indicator */}
        {lastSynced && (
          <div className="flex items-center gap-1.5 ml-auto select-none">
            <div className="relative w-2 h-2 flex items-center justify-center">
              <span className="absolute inline-flex w-2 h-2 rounded-full opacity-60"
                style={{ background: '#2A6B3A', animation: 'ping 1.8s cubic-bezier(0,0,0.2,1) infinite' }} />
              <span className="relative inline-flex w-1.5 h-1.5 rounded-full" style={{ background: '#2A6B3A' }} />
            </div>
            <span className="text-xs" style={{ color: '#C4C3BD' }}>{syncDisplay}</span>
          </div>
        )}
      </div>

      <table className="w-full" style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #F0EFEB', background: '#FAFAF8' }}>
            {['FACULTY', 'ROLE', 'STATUS', 'REGISTERED'].map((col, i) => (
              <th key={i} className="text-left px-5 py-3 text-xs"
                style={{
                  color: '#9A9891', letterSpacing: '0.08em', fontWeight: 400,
                  width: i === 0 ? '40%' : i === 1 ? '16%' : i === 2 ? '16%' : '28%',
                }}>
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {faculties.map((faculty) => (
            <motion.tr key={faculty.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              style={{ borderBottom: '1px solid #F0EFEB' }}>
              {/* Name + email */}
              <td className="px-5 py-3.5">
                <p className="text-sm" style={{ color: '#0C0C0B', lineHeight: 1.4 }}>{faculty.name}</p>
                <p className="text-xs mt-0.5" style={{ color: '#9A9891' }}>{faculty.email}</p>
              </td>

              {/* Role */}
              <td className="px-5 py-3.5">
                <span className="inline-block text-xs px-2 py-0.5"
                  style={{ background: '#F0EFEB', color: '#4A4A45', borderRadius: 2, letterSpacing: '0.03em' }}>
                  Faculty
                </span>
              </td>

              {/* Status */}
              <td className="px-5 py-3.5">
                <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5"
                  style={faculty.status === 'active'
                    ? { background: '#F0F7F2', color: '#2A6B3A', border: '1px solid #C6DECE', borderRadius: 2 }
                    : { background: '#F5F5F3', color: '#9A9891', border: '1px solid #E3E1DB', borderRadius: 2 }}>
                  <span style={{
                    width: 5, height: 5, borderRadius: '50%', display: 'inline-block', flexShrink: 0,
                    background: faculty.status === 'active' ? '#2A6B3A' : '#C4C3BD',
                  }} />
                  {faculty.status === 'active' ? 'Active' : 'Disabled'}
                </span>
              </td>

              {/* Created date */}
              <td className="px-5 py-3.5">
                <p className="text-xs" style={{ color: '#9A9891' }}>{formatDate(faculty.createdAt)}</p>
                {faculty.firstLoginRequired && (
                  <p className="text-xs mt-0.5" style={{ color: '#B0AEA8', fontStyle: 'italic' }}>
                    Awaiting first login
                  </p>
                )}
              </td>
            </motion.tr>
          ))}
        </tbody>
      </table>

      <p className="text-xs px-5 py-3" style={{ color: '#C4C3BD', borderTop: '1px solid #F0EFEB' }}>
        Data refreshes automatically every 5 seconds.
      </p>
    </div>
  );
}

// ── Student list ──────────────────────────────────────────────────

function StudentList({ instituteId }: { instituteId: string }) {
  const [students, setStudents]       = useState<Student[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState('');
  const [lastSynced, setLastSynced]   = useState<Date | null>(null);
  const [syncDisplay, setSyncDisplay] = useState('');

  const fetch_ = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await getStudentsByInstitute(instituteId);
      setStudents(data);
      setLastSynced(new Date());
      setError('');
    } catch (e: any) {
      if (!silent) setError(e.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [instituteId]);

  useEffect(() => {
    fetch_();
    const poll = setInterval(() => fetch_(true), 5000);
    return () => clearInterval(poll);
  }, [fetch_]);

  useEffect(() => {
    if (!lastSynced) return;
    setSyncDisplay(formatSyncAge(lastSynced));
    const t = setInterval(() => setSyncDisplay(formatSyncAge(lastSynced)), 1000);
    return () => clearInterval(t);
  }, [lastSynced]);

  const active   = students.filter((s) => s.status === 'active').length;
  const disabled = students.filter((s) => s.status === 'disabled').length;

  if (loading) {
    return (
      <div className="py-12 flex flex-col items-center gap-3">
        <Loader2 size={20} strokeWidth={1} className="animate-spin" style={{ color: '#C4C3BD' }} />
        <p className="text-xs" style={{ color: '#C4C3BD' }}>Loading students…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-6 mt-6 flex items-center gap-2 px-4 py-3"
        style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2 }}>
        <AlertTriangle size={12} strokeWidth={1.5} style={{ color: '#9B2828' }} />
        <p className="text-xs" style={{ color: '#9B2828' }}>{error}</p>
        <button onClick={() => fetch_()} className="ml-auto text-xs"
          style={{ color: '#9B2828', textDecoration: 'underline' }}>Retry</button>
      </div>
    );
  }

  if (students.length === 0) {
    return (
      <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="flex flex-col items-center justify-center py-24">
        <GraduationCap size={28} strokeWidth={1} style={{ color: '#DDDBD5' }} />
        <p className="text-xs mt-4" style={{ color: '#C4C3BD', letterSpacing: '0.06em' }}>No students enrolled</p>
        <p className="text-xs mt-1.5" style={{ color: '#DDDBD5', maxWidth: 260, textAlign: 'center', lineHeight: 1.6 }}>
          Student accounts are provisioned by the platform administrator.
        </p>
      </motion.div>
    );
  }

  return (
    <div>
      {/* Stats + sync */}
      <div className="flex items-center gap-3 px-5 py-3"
        style={{ borderBottom: '1px solid #F0EFEB', background: '#FAFAF8' }}>
        <span className="text-xs" style={{ color: '#9A9891' }}>
          {students.length} {students.length === 1 ? 'student' : 'students'}
        </span>
        <span style={{ color: '#E3E1DB' }}>·</span>
        <span className="text-xs" style={{ color: '#2A6B3A' }}>{active} active</span>
        {disabled > 0 && (
          <>
            <span style={{ color: '#E3E1DB' }}>·</span>
            <span className="text-xs" style={{ color: '#9A9891' }}>{disabled} disabled</span>
          </>
        )}
        {lastSynced && (
          <div className="flex items-center gap-1.5 ml-auto select-none">
            <div className="relative w-2 h-2 flex items-center justify-center">
              <span className="absolute inline-flex w-2 h-2 rounded-full opacity-60"
                style={{ background: '#2A6B3A', animation: 'ping 1.8s cubic-bezier(0,0,0.2,1) infinite' }} />
              <span className="relative inline-flex w-1.5 h-1.5 rounded-full" style={{ background: '#2A6B3A' }} />
            </div>
            <span className="text-xs" style={{ color: '#C4C3BD' }}>{syncDisplay}</span>
          </div>
        )}
      </div>

      <table className="w-full" style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid #F0EFEB', background: '#FAFAF8' }}>
            {['STUDENT', 'ROLE', 'STATUS', 'PROGRAM', 'REGISTERED'].map((col, i) => (
              <th key={i} className="text-left px-5 py-3 text-xs"
                style={{ color: '#9A9891', letterSpacing: '0.08em', fontWeight: 400 }}>
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {students.map((student) => (
            <motion.tr key={student.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }}
              style={{ borderBottom: '1px solid #F0EFEB' }}>
              <td className="px-5 py-3.5">
                <p className="text-sm" style={{ color: '#0C0C0B', lineHeight: 1.4 }}>{student.name}</p>
                <p className="text-xs mt-0.5" style={{ color: '#9A9891' }}>{student.email}</p>
              </td>
              <td className="px-5 py-3.5">
                <span className="inline-block text-xs px-2 py-0.5"
                  style={{ background: '#F0EFEB', color: '#4A4A45', borderRadius: 2 }}>Student</span>
              </td>
              <td className="px-5 py-3.5">
                <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5"
                  style={student.status === 'active'
                    ? { background: '#F0F7F2', color: '#2A6B3A', border: '1px solid #C6DECE', borderRadius: 2 }
                    : { background: '#F5F5F3', color: '#9A9891', border: '1px solid #E3E1DB', borderRadius: 2 }}>
                  <span style={{
                    width: 5, height: 5, borderRadius: '50%', display: 'inline-block', flexShrink: 0,
                    background: student.status === 'active' ? '#2A6B3A' : '#C4C3BD',
                  }} />
                  {student.status === 'active' ? 'Active' : 'Disabled'}
                </span>
              </td>
              <td className="px-5 py-3.5">
                {student.program?.length ? (
                  <div className="flex flex-wrap gap-1">
                    {student.program.map((p, i) => (
                      <span key={i} className="text-xs px-1.5 py-0.5"
                        style={{ background: '#F0EFEB', color: '#4A4A45', borderRadius: 2 }}>{p}</span>
                    ))}
                  </div>
                ) : (
                  <span className="text-xs" style={{ color: '#C4C3BD' }}>—</span>
                )}
              </td>
              <td className="px-5 py-3.5">
                <p className="text-xs" style={{ color: '#9A9891' }}>{formatDate(student.createdAt)}</p>
                {student.firstLoginRequired && (
                  <p className="text-xs mt-0.5" style={{ color: '#B0AEA8', fontStyle: 'italic' }}>Awaiting first login</p>
                )}
              </td>
            </motion.tr>
          ))}
        </tbody>
      </table>

      <p className="text-xs px-5 py-3" style={{ color: '#C4C3BD', borderTop: '1px solid #F0EFEB' }}>
        Data refreshes automatically every 5 seconds.
      </p>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────

export function InstituteLandingPage() {
  const { session }   = useInstituteAuth();
  const [activeTab, setActiveTab] = useState<Tab>('faculties');

  // Live permissions — re-fetched on mount so they reflect Web Owner changes
  const [canManageSchools,     setCanManageSchools]     = useState(session?.schoolsManagementEnabled  ?? false);
  const [canCreateFaculty,     setCanCreateFaculty]     = useState(session?.canAdminCreateFaculty     ?? false);
  const [canCreateStudents,    setCanCreateStudents]    = useState(session?.canAdminCreateStudents    ?? false);
  const [facultyCanCreateStud, setFacultyCanCreateStud] = useState(session?.facultyCanCreateStudents  ?? false);
  const [canCreateQuestions,   setCanCreateQuestions]   = useState(session?.canAdminCreateQuestions   ?? false);
  const [permissionLoading, setPermissionLoading] = useState(false);

  useEffect(() => {
    if (!session?.instituteId) return;
    setPermissionLoading(true);
    getInstitute(session.instituteId)
      .then((inst) => {
        if (inst) {
          setCanManageSchools(inst.schoolsManagementEnabled   ?? false);
          setCanCreateFaculty(inst.canAdminCreateFaculty      ?? false);
          setCanCreateStudents(inst.canAdminCreateStudents    ?? false);
          setFacultyCanCreateStud(inst.facultyCanCreateStudents ?? false);
          setCanCreateQuestions(inst.canAdminCreateQuestions  ?? false);
        }
      })
      .finally(() => setPermissionLoading(false));
  }, [session?.instituteId]);

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: 'faculties', label: 'Faculty',  icon: <Users size={12} strokeWidth={1.5} /> },
    { key: 'students',  label: 'Students', icon: <GraduationCap size={12} strokeWidth={1.5} /> },
    { key: 'schools',   label: 'Schools',  icon: <School size={12} strokeWidth={1.5} /> },
  ];

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
        <p className="text-xs mb-1" style={{ color: '#9A9891', letterSpacing: '0.1em' }}>INSTITUTE ADMIN</p>
        <h1 className="text-base" style={{ color: '#0C0C0B' }}>{session?.instituteName}</h1>
        <p className="text-xs mt-1" style={{ color: '#B0AEA8' }}>
          Institute ID:&nbsp;
          <span style={{ fontFamily: 'monospace', letterSpacing: '0.1em', color: '#9A9891' }}>
            {session?.instituteCode}
          </span>
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-0" style={{ borderBottom: '1px solid #E3E1DB' }}>
        {tabs.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)}
              className="relative flex items-center gap-1.5 px-5 py-3 text-xs transition-colors select-none"
              style={{
                color: isActive ? '#0C0C0B' : '#9A9891',
                background: 'transparent', letterSpacing: '0.04em',
                fontWeight: isActive ? 500 : 400,
              }}
              onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.color = '#4A4A45'; }}
              onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.color = '#9A9891'; }}
            >
              <span style={{ color: isActive ? '#0C0C0B' : '#C4C3BD' }}>{tab.icon}</span>
              {tab.label}
              {/* Schools tab: show lock badge when view-only */}
              {tab.key === 'schools' && !permissionLoading && !canManageSchools && (
                <span className="ml-0.5" style={{ color: '#C4C3BD' }}>
                  <Lock size={9} strokeWidth={1.5} />
                </span>
              )}
              {isActive && (
                <motion.div layoutId="tab-underline"
                  className="absolute bottom-0 left-0 right-0"
                  style={{ height: 1.5, background: '#0C0C0B' }}
                  transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderTop: 'none', minHeight: 320 }}>
        <AnimatePresence mode="wait">

          {/* Faculty tab — if permitted, uses the full FacultyTab (with add/bulk).
              Otherwise shows the read-only FacultyList */}
          {activeTab === 'faculties' && session?.instituteId && (
            <motion.div key="faculties" className="p-5"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}>
              {canCreateFaculty ? (
                <FacultyTab
                  instituteId={session.instituteId}
                  instituteName={session.instituteName}
                  instituteSchoolsEnabled={canManageSchools}
                  instituteFacultyCreateStudentsEnabled={facultyCanCreateStud}
                />
              ) : (
                <FacultyList instituteId={session.instituteId} />
              )}
            </motion.div>
          )}

          {/* Students tab — if permitted, uses the full StudentTab (with add/bulk).
              Otherwise shows the read-only StudentList */}
          {activeTab === 'students' && session?.instituteId && (
            <motion.div key="students" className="p-5"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}>
              {canCreateStudents ? (
                <StudentTab
                  instituteId={session.instituteId}
                  instituteName={session.instituteName}
                />
              ) : (
                <StudentList instituteId={session.instituteId} />
              )}
            </motion.div>
          )}

          {activeTab === 'schools' && session?.instituteId && (
            <motion.div key="schools"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="px-6 py-6"
            >
              {/* Permission notice — shown when management is not enabled */}
              {!permissionLoading && !canManageSchools && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-start gap-2.5 px-4 py-3 mb-6"
                  style={{
                    background: '#FFFBF0',
                    border: '1px solid #F0D080',
                    borderRadius: 2,
                  }}
                >
                  <Lock size={12} strokeWidth={1.5} style={{ color: '#8B5E1A', flexShrink: 0, marginTop: 1 }} />
                  <div>
                    <p className="text-xs" style={{ color: '#8B5E1A', lineHeight: 1.6 }}>
                      <strong>View only.</strong> Schools management has not been enabled for this institute. 
                      Contact your platform administrator to enable editing.
                    </p>
                  </div>
                </motion.div>
              )}

              {permissionLoading ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 size={18} strokeWidth={1} className="animate-spin" style={{ color: '#C4C3BD' }} />
                </div>
              ) : (
                <SchoolsTab
                  instituteId={session.instituteId}
                  instituteName={session.instituteName}
                  readOnly={!canManageSchools}
                />
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}