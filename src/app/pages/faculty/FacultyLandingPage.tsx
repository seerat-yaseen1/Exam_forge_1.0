/**
 * The faculty console's home.
 *
 * ── WHAT CHANGED ──────────────────────────────────────────────────
 * It opened with a full screen of centred ceremony — a date, a large greeting,
 * a decorative rule, and the words "Your workspace is ready" — before any of
 * the person's actual work. Below that, the two things they came for sat in
 * small grey boxes.
 *
 * The greeting stays, because a console people open every morning should
 * acknowledge them, but it becomes a page header like every other page's
 * rather than a landing sequence. What it makes room for is the answer to the
 * question a faculty member actually arrives with: what am I allowed to do
 * here, and where do I start.
 *
 * ── WHY PERMISSIONS ARE THE HEADLINE ──────────────────────────────
 * Faculty permissions are set in two places — the institute enables a
 * capability, and the admin grants it to the individual — and BOTH must be
 * true. When they are not, the corresponding section simply is not in the
 * sidebar, which from the inside is indistinguishable from the product not
 * having the feature. So this page states each capability and which of the
 * two gates is closed. It is the only screen that can.
 */

import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  BookOpen, ClipboardList, GraduationCap, Lock, School, ShieldCheck,
} from 'lucide-react';
import { useFacultyAuth } from '../../context/FacultyAuthContext';
import { getInstitute, getFaculty } from '../../../lib/firebaseService';
import { SchoolsTab } from '../../components/schools/SchoolsTab';
import { StudentTab } from '../../components/student/StudentTab';
import {
  Card, Chip, PageHeader, PageShell, SectionHeading,
} from '../../components/console/ui';
import { Tabs, type TabItem } from '../../components/console/data';

type Tab = 'overview' | 'schools' | 'students';

function greeting(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * The first name, without the title.
 *
 * "Dr. Meera Iyer".split(' ')[0] is "Dr." — which is what this page greeted
 * people with. Titles are stripped so the greeting uses a name.
 */
const TITLES = new Set(['dr', 'dr.', 'prof', 'prof.', 'mr', 'mr.', 'mrs', 'mrs.', 'ms', 'ms.', 'mx', 'mx.']);

export function firstNameOf(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const first = parts.find((p) => !TITLES.has(p.toLowerCase()));
  return first ?? parts[0] ?? '';
}

// ── One capability, and why it is or is not available ─────────────

function Capability({
  icon,
  label,
  state,
  granted,
  onOpen,
}: {
  icon: React.ReactNode;
  label: string;
  /** The sentence that explains this state. */
  state: React.ReactNode;
  granted: 'full' | 'view' | 'none';
  onOpen?: () => void;
}) {
  const tone = granted === 'full' ? 'success' : granted === 'view' ? 'warning' : 'muted';
  const badge = granted === 'full' ? 'Available' : granted === 'view' ? 'View only' : 'Not enabled';

  return (
    <Card variant={granted === 'none' ? 'inset' : 'default'}>
      <div className="flex items-start gap-3">
        <span
          style={{
            color:
              granted === 'full'
                ? 'var(--ef-success)'
                : granted === 'view'
                  ? 'var(--ef-warning)'
                  : 'var(--ef-text-muted)',
            flexShrink: 0,
            marginTop: 2,
          }}
        >
          {granted === 'none' ? <Lock size={15} strokeWidth={1.7} /> : icon}
        </span>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="ef-t-md ef-ink" style={{ fontWeight: 500 }}>
              {label}
            </p>
            <Chip small tone={tone}>
              {badge}
            </Chip>
          </div>
          <p className="ef-t-sm ef-muted" style={{ marginTop: 6, lineHeight: 'var(--ef-leading-relaxed)' }}>
            {state}
          </p>
          {onOpen && granted !== 'none' && (
            <button
              type="button"
              onClick={onOpen}
              className="ef-btn ef-btn--secondary ef-btn--sm"
              style={{ marginTop: 12 }}
            >
              Open {label.toLowerCase()}
            </button>
          )}
        </div>
      </div>
    </Card>
  );
}

export function FacultyLandingPage() {
  const { session } = useFacultyAuth();

  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [instituteSME, setInstituteSME] = useState(false);
  const [facultySME, setFacultySME] = useState(false);
  const [canCreateStudents, setCanCreateStudents] = useState(session?.canCreateStudents ?? false);
  const [permLoading, setPermLoading] = useState(true);

  useEffect(() => {
    if (!session?.instituteId || !session?.facultyId) return;
    let cancelled = false;
    setPermLoading(true);

    Promise.all([getInstitute(session.instituteId), getFaculty(session.facultyId)])
      .then(([inst, fac]) => {
        if (cancelled) return;
        setInstituteSME(inst?.schoolsManagementEnabled ?? false);
        setFacultySME(fac?.schoolsManagementEnabled ?? false);
        // Both gates: the institute allows it AND this faculty member has it.
        setCanCreateStudents(
          (inst?.facultyCanCreateStudents ?? false) && (fac?.canCreateStudents ?? false),
        );
      })
      .catch((err) => {
        console.warn('[FacultyLandingPage] permission fetch failed:', err);
      })
      .finally(() => {
        if (!cancelled) setPermLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [session?.instituteId, session?.facultyId]);

  if (!session) return null;

  const schoolsAccess: 'full' | 'view' | 'none' =
    !instituteSME ? 'none' : facultySME ? 'full' : 'view';

  const tabs: TabItem[] = [
    { key: 'overview', label: 'Overview' },
    {
      key: 'schools',
      label: 'Schools',
      icon: <School size={13} strokeWidth={1.7} />,
    },
    ...(canCreateStudents
      ? [{ key: 'students', label: 'Students', icon: <GraduationCap size={13} strokeWidth={1.7} /> }]
      : []),
  ];

  return (
    <PageShell>
      <PageHeader
        eyebrow={
          <>
            <span className="ef-eyebrow-dot" />
            Faculty · {session.instituteName}
          </>
        }
        title={`${greeting(new Date().getHours())}, ${firstNameOf(session.name)}.`}
        subtitle={
          permLoading
            ? 'Checking what you have access to…'
            : 'Your question bank and, where granted, your institute’s hierarchy and students.'
        }
      >
        <div className="flex items-center gap-2 flex-wrap">
          <Chip tone="accent">Faculty</Chip>
          <Chip>{session.instituteName}</Chip>
          <span className="ef-t-xs ef-muted" style={{ fontFamily: 'ui-monospace, monospace', letterSpacing: '0.08em' }}>
            {session.instituteCode}
          </span>
        </div>
      </PageHeader>

      <div style={{ marginBottom: 'var(--ef-gap)' }}>
        <Tabs items={tabs} active={activeTab} onChange={(k) => setActiveTab(k as Tab)} label="Faculty sections" />
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          {activeTab === 'overview' && (
            <div className="flex flex-col" style={{ gap: 26 }}>
              <section>
                <SectionHeading
                  label="What you can do here"
                  hint="Set by your institute, then granted to you individually."
                />
                <div
                  className="grid gap-3"
                  style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(300px, 100%), 1fr))' }}
                >
                  <Capability
                    icon={<BookOpen size={15} strokeWidth={1.7} />}
                    label="Questions"
                    granted="full"
                    state="Write, review and organise questions for your subjects. Always available to faculty."
                  />

                  <Capability
                    icon={<ClipboardList size={15} strokeWidth={1.7} />}
                    label="Assignments"
                    granted={session.canManageExamRosters ? 'full' : 'none'}
                    state={
                      session.canManageExamRosters
                        ? 'Build assessments and watch live exam rosters as candidates sit them.'
                        : 'Your administrator has not granted you exam roster management. Ask them if you need it.'
                    }
                  />

                  <Capability
                    icon={<School size={15} strokeWidth={1.7} />}
                    label="Schools"
                    granted={permLoading ? 'none' : schoolsAccess}
                    onOpen={() => setActiveTab('schools')}
                    state={
                      permLoading
                        ? 'Checking…'
                        : schoolsAccess === 'full'
                          ? 'Create and manage the academic hierarchy — schools, programs, semesters, sections.'
                          : schoolsAccess === 'view'
                            ? 'You can see the hierarchy but not change it. Your administrator can grant full rights.'
                            : 'Schools management is switched off for this institute entirely, so nobody here has it.'
                    }
                  />

                  <Capability
                    icon={<GraduationCap size={15} strokeWidth={1.7} />}
                    label="Students"
                    granted={canCreateStudents ? 'full' : 'none'}
                    onOpen={() => setActiveTab('students')}
                    state={
                      canCreateStudents
                        ? 'Add students and map them into the hierarchy.'
                        : 'Adding students needs your institute to allow it and your administrator to grant it to you. One of those is missing.'
                    }
                  />
                </div>
              </section>

              <section>
                <SectionHeading label="Where you sit" />
                <Card variant="inset">
                  <div className="flex items-center gap-2 flex-wrap ef-t-sm">
                    <span className="ef-muted">Platform owner</span>
                    <span style={{ color: 'var(--ef-border-muted)' }}>→</span>
                    <span className="ef-muted">{session.instituteName}</span>
                    <span style={{ color: 'var(--ef-border-muted)' }}>→</span>
                    <Chip tone="accent">{session.name}</Chip>
                  </div>
                  <p className="ef-t-xs ef-muted" style={{ marginTop: 12, lineHeight: 'var(--ef-leading-relaxed)' }}>
                    Everything above is a boundary someone else set. A capability that is off here
                    cannot be switched on from inside this console — this is the chain to ask along.
                  </p>
                </Card>
              </section>
            </div>
          )}

          {activeTab === 'schools' &&
            (permLoading ? (
              <Card>
                <p className="ef-t-sm ef-muted">Checking your access…</p>
              </Card>
            ) : schoolsAccess === 'none' ? (
              <Card variant="inset">
                <div className="flex items-start gap-3">
                  <Lock size={16} strokeWidth={1.7} style={{ color: 'var(--ef-text-muted)', flexShrink: 0, marginTop: 1 }} />
                  <div>
                    <p className="ef-t-md ef-ink" style={{ fontWeight: 500 }}>
                      Not enabled for this institute
                    </p>
                    <p className="ef-t-sm ef-muted" style={{ marginTop: 6, lineHeight: 'var(--ef-leading-relaxed)' }}>
                      Schools management is switched off at the institute level, so it is unavailable
                      to every faculty member here — not only to you. Your administrator can ask the
                      platform owner to enable it.
                    </p>
                  </div>
                </div>
              </Card>
            ) : (
              <>
                {schoolsAccess === 'view' && (
                  <div
                    className="flex items-start gap-2.5 mb-4"
                    style={{
                      padding: '11px 14px',
                      background: 'var(--ef-warning-bg)',
                      border: '1px solid var(--ef-warning-border)',
                      borderRadius: 'var(--ef-radius-sm)',
                    }}
                  >
                    <ShieldCheck size={14} strokeWidth={1.7} style={{ color: 'var(--ef-warning)', flexShrink: 0, marginTop: 1 }} />
                    <p className="ef-t-sm" style={{ color: 'var(--ef-warning-strong)' }}>
                      View only — you can read this hierarchy but not change it.
                    </p>
                  </div>
                )}
                <SchoolsTab
                  instituteId={session.instituteId}
                  instituteName={session.instituteName}
                  readOnly={schoolsAccess !== 'full'}
                />
              </>
            ))}

          {activeTab === 'students' && canCreateStudents && (
            <StudentTab instituteId={session.instituteId} instituteName={session.instituteName} />
          )}
        </motion.div>
      </AnimatePresence>
    </PageShell>
  );
}
