import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  School, Lock, Loader2, ShieldCheck, Shield, AlertTriangle,
  GraduationCap,
} from 'lucide-react';
import { useFacultyAuth } from '../../context/FacultyAuthContext';
import {
  getInstitute,
  getFaculty,
} from '../../../lib/firebaseService';
import { SchoolsTab } from '../../components/schools/SchoolsTab';
import { StudentTab } from '../../components/student/StudentTab';

// ── Types ──────────────────────────────────────────────────────────

type Tab = 'overview' | 'schools' | 'students';

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

// ── Overview tab ─────────────────────────���────────────────────────

function OverviewTab({
  session,
  instituteSME,
  facultySME,
  permLoading,
  onGoToSchools,
}: {
  session: NonNullable<ReturnType<typeof useFacultyAuth>['session']>;
  instituteSME: boolean;
  facultySME: boolean;
  permLoading: boolean;
  onGoToSchools: () => void;
}) {
  const firstName = session.name.split(' ')[0];

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
    >
      {/* Greeting block */}
      <div className="flex flex-col items-center py-14" style={{ borderBottom: '1px solid var(--ef-border)' }}>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.1, duration: 0.4 }}
          className="flex items-center gap-2 mb-8"
        >
          <div style={{ width: 4, height: 4, borderRadius: '50%', background: 'var(--ef-success)' }} />
          <span className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.12em' }}>
            FACULTY · {session.instituteName.toUpperCase()}
          </span>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="text-center"
        >
          <p className="text-xs mb-3" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.06em' }}>
            {formatDate()}
          </p>
          <h1 className="text-2xl font-light mb-3" style={{ color: 'var(--ef-ink)', letterSpacing: '0.02em' }}>
            {getGreeting()}, {firstName}.
          </h1>
          <p className="text-sm" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.7 }}>
            Your workspace is ready.
          </p>
        </motion.div>

        <motion.div
          initial={{ scaleX: 0, opacity: 0 }}
          animate={{ scaleX: 1, opacity: 1 }}
          transition={{ delay: 0.3, duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          style={{ width: 48, height: 1, background: 'var(--ef-border-muted)', margin: '32px 0' }}
        />

        {/* Meta row */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4, duration: 0.4 }}
          className="flex items-center gap-4"
        >
          <span className="inline-block text-xs px-2.5 py-1"
            style={{ background: 'var(--ef-border-subtle)', color: 'var(--ef-text-subtle)', borderRadius: 2, letterSpacing: '0.04em' }}>
            Faculty
          </span>
          <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
            Code:{' '}
            <span style={{ fontFamily: 'monospace', letterSpacing: '0.12em', color: 'var(--ef-text-muted)' }}>
              {session.instituteCode}
            </span>
          </span>
        </motion.div>
      </div>

      {/* Access cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-6">
        {/* Authority chain */}
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.5, duration: 0.35 }}
          className="px-5 py-5"
          style={{ background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border)', borderRadius: 3 }}
        >
          <p className="text-xs mb-4" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>
            AUTHORITY HIERARCHY
          </p>
          <div className="flex items-center gap-0 flex-wrap">
            {[
              { label: 'Web Owner', active: false },
              { label: session.instituteName, active: false },
              { label: session.name, active: true },
            ].map((item, i, arr) => (
              <div key={i} className="flex items-center">
                <span className="text-xs px-2.5 py-1"
                  style={{
                    color: item.active ? 'var(--ef-ink)' : 'var(--ef-text-muted)',
                    background: item.active ? 'var(--ef-border-subtle)' : 'transparent',
                    borderRadius: 2, fontWeight: item.active ? 500 : 400,
                  }}>
                  {item.label}
                </span>
                {i < arr.length - 1 && (
                  <span className="mx-1.5 text-xs" style={{ color: 'var(--ef-border-muted)' }}>→</span>
                )}
              </div>
            ))}
          </div>
          <p className="text-xs mt-3" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
            You operate within the boundaries defined by your institute.
          </p>
        </motion.div>

        {/* Schools access card */}
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.58, duration: 0.35 }}
          className="px-5 py-5"
          style={{ background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border)', borderRadius: 3 }}
        >
          <p className="text-xs mb-4" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>
            SCHOOLS ACCESS
          </p>

          {permLoading ? (
            <div className="flex items-center gap-2">
              <Loader2 size={13} strokeWidth={1} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />
              <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>Checking permissions…</span>
            </div>
          ) : !instituteSME ? (
            <div className="flex items-start gap-2.5">
              <Lock size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0, marginTop: 1 }} />
              <div>
                <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
                  Schools access has not been enabled for this institute. Contact your administrator.
                </p>
                <span className="inline-flex items-center gap-1 text-xs mt-2 px-2 py-0.5"
                  style={{ background: 'var(--ef-border-subtle)', color: 'var(--ef-text-muted)', borderRadius: 2 }}>
                  <Shield size={9} strokeWidth={1.5} /> Locked
                </span>
              </div>
            </div>
          ) : !facultySME ? (
            <div className="flex items-start gap-2.5">
              <Lock size={12} strokeWidth={1.5} style={{ color: 'var(--ef-warning-strong)', flexShrink: 0, marginTop: 1 }} />
              <div>
                <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
                  You have view-only access to the Schools hierarchy. Your administrator can grant full management rights.
                </p>
                <button
                  onClick={onGoToSchools}
                  className="inline-flex items-center gap-1.5 text-xs mt-2 px-2.5 py-1 transition-colors"
                  style={{ background: 'var(--ef-border-subtle)', color: 'var(--ef-text-subtle)', borderRadius: 2, border: '1px solid var(--ef-border)' }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.borderColor = 'var(--ef-ink)')}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.borderColor = 'var(--ef-border)')}
                >
                  <School size={10} strokeWidth={1.5} /> View Schools →
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2.5">
              <ShieldCheck size={12} strokeWidth={1.5} style={{ color: 'var(--ef-success)', flexShrink: 0, marginTop: 1 }} />
              <div>
                <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
                  Full Schools management access granted. You can create, edit, and manage the academic hierarchy.
                </p>
                <button
                  onClick={onGoToSchools}
                  className="inline-flex items-center gap-1.5 text-xs mt-2 px-2.5 py-1 transition-opacity"
                  style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2 }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.opacity = '0.8')}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.opacity = '1')}
                >
                  <School size={10} strokeWidth={1.5} /> Open Schools →
                </button>
              </div>
            </div>
          )}
        </motion.div>
      </div>
    </motion.div>
  );
}

// ── Main page ─────────────────────────────────────────────────────

export function FacultyLandingPage() {
  const { session } = useFacultyAuth();

  const [activeTab, setActiveTab] = useState<Tab>('overview');

  // Live permission flags
  const [instituteSME, setInstituteSME] = useState(false);
  const [facultySME, setFacultySME]     = useState(false);
  const [canCreateStudents, setCanCreateStudents] = useState(
    session?.canCreateStudents ?? false
  );
  const [permLoading, setPermLoading]   = useState(true);

  useEffect(() => {
    if (!session?.instituteId || !session?.facultyId) return;

    let cancelled = false;
    setPermLoading(true);

    Promise.all([
      getInstitute(session.instituteId),
      getFaculty(session.facultyId),
    ]).then(([inst, fac]) => {
      if (cancelled) return;
      setInstituteSME(inst?.schoolsManagementEnabled ?? false);
      setFacultySME(fac?.schoolsManagementEnabled ?? false);
      // Both gates: institute allows it AND this faculty member is granted it
      setCanCreateStudents(
        (inst?.facultyCanCreateStudents ?? false) &&
        (fac?.canCreateStudents ?? false)
      );
    }).catch((err) => {
      console.warn('[FacultyLandingPage] permission fetch failed:', err);
    }).finally(() => {
      if (!cancelled) setPermLoading(false);
    });

    return () => { cancelled = true; };
  }, [session?.instituteId, session?.facultyId]);

  if (!session) return null;

  const canManage = !permLoading && instituteSME && facultySME;
  const canView   = !permLoading && instituteSME;

  const tabs: { key: Tab; label: string; icon: React.ReactNode; locked?: boolean }[] = [
    { key: 'overview',  label: 'Overview',  icon: null },
    {
      key: 'schools',
      label: 'Schools',
      icon: <School size={11} strokeWidth={1.5} />,
      locked: !canView && !permLoading,
    },
    ...(canCreateStudents
      ? [{ key: 'students' as Tab, label: 'Students', icon: <GraduationCap size={11} strokeWidth={1.5} /> }]
      : []),
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
      <div className="mb-8" style={{ borderBottom: '1px solid var(--ef-border)', paddingBottom: 20 }}>
        <p className="text-xs mb-1" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>FACULTY</p>
        <h1 className="text-base" style={{ color: 'var(--ef-ink)' }}>{session.name}</h1>
        <p className="text-xs mt-1" style={{ color: 'var(--ef-text-muted)' }}>
          {session.instituteName} ·{' '}
          <span style={{ fontFamily: 'monospace', letterSpacing: '0.1em', color: 'var(--ef-text-muted)' }}>
            {session.instituteCode}
          </span>
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex items-center gap-0" style={{ borderBottom: '1px solid var(--ef-border)' }}>
        {tabs.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className="relative flex items-center gap-1.5 px-5 py-3 text-xs transition-colors select-none"
              style={{
                color: isActive ? 'var(--ef-ink)' : 'var(--ef-text-muted)',
                background: 'transparent',
                letterSpacing: '0.04em',
                fontWeight: isActive ? 500 : 400,
              }}
              onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.color = 'var(--ef-text-subtle)'; }}
              onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)'; }}
            >
              {tab.icon && (
                <span style={{ color: isActive ? 'var(--ef-ink)' : 'var(--ef-text-muted)' }}>{tab.icon}</span>
              )}
              {tab.label}

              {/* Schools tab: contextual status indicator */}
              {tab.key === 'schools' && !permLoading && (
                <span className="ml-0.5" style={{ color: 'var(--ef-text-muted)' }}>
                  {canManage
                    ? <ShieldCheck size={9} strokeWidth={1.5} style={{ color: 'var(--ef-success)' }} />
                    : canView
                      ? <AlertTriangle size={9} strokeWidth={1.5} style={{ color: 'var(--ef-warning)' }} />
                      : <Lock size={9} strokeWidth={1.5} />}
                </span>
              )}

              {isActive && (
                <motion.div
                  layoutId="faculty-tab-underline"
                  className="absolute bottom-0 left-0 right-0"
                  style={{ height: 1.5, background: 'var(--ef-ink)' }}
                  transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderTop: 'none', minHeight: 320 }}>
        <AnimatePresence mode="wait">
          {activeTab === 'overview' && (
            <motion.div key="overview"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}>
              <OverviewTab
                session={session}
                instituteSME={instituteSME}
                facultySME={facultySME}
                permLoading={permLoading}
                onGoToSchools={() => setActiveTab('schools')}
              />
            </motion.div>
          )}

          {activeTab === 'schools' && (
            <motion.div key="schools"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="px-6 py-6">
              {!canView && !permLoading && (
                <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
                  className="flex items-start gap-2.5 px-4 py-3 mb-6"
                  style={{ background: 'var(--ef-warning-bg)', border: '1px solid var(--ef-warning-border)', borderRadius: 2 }}>
                  <Lock size={12} strokeWidth={1.5} style={{ color: 'var(--ef-warning-strong)', flexShrink: 0, marginTop: 1 }} />
                  <p className="text-xs" style={{ color: 'var(--ef-warning-strong)', lineHeight: 1.6 }}>
                    <strong>View only.</strong> Schools management has not been enabled for this institute.
                  </p>
                </motion.div>
              )}
              {permLoading ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 size={18} strokeWidth={1} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />
                </div>
              ) : (
                <SchoolsTab
                  instituteId={session.instituteId}
                  instituteName={session.instituteName}
                  readOnly={!canManage}
                />
              )}
            </motion.div>
          )}

          {activeTab === 'students' && canCreateStudents && (
            <motion.div key="students"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="p-5">
              <StudentTab
                instituteId={session.instituteId}
                instituteName={session.instituteName}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}