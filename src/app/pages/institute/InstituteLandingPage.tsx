/**
 * The institute admin's console home.
 *
 * ── WHAT IT REPLACED ──────────────────────────────────────────────
 * A tab bar. Four tabs and nothing above them, so the only way to learn
 * anything about your own institute was to open each tab and count by eye —
 * every visit, for an answer that was usually "nothing has changed". Two of
 * those tabs held near-identical hand-rolled tables (a 4-column faculty one
 * and a 5-column student one) that between them repeated the same status
 * pill, the same date cell and the same empty state twice.
 *
 * ── WHAT IT LEADS WITH ────────────────────────────────────────────
 * The census, then the exceptions, then the tabs — the same reading order as
 * the Web Owner's overview one level up, so moving between the two consoles
 * does not mean relearning where to look. `rosterSummary.ts` decides what
 * counts as an exception and in what order; this file only draws it.
 *
 * ── THE POLLING THAT IS GONE ──────────────────────────────────────
 * Both old tables re-read their entire collection every five seconds, behind
 * a pinging green dot and the line "Data refreshes automatically every 5
 * seconds". An institute roster changes when an admin adds someone — roughly
 * never, in five-second terms — so that was a per-minute cost in Firestore
 * reads to animate a dot. It now loads once, again when you come back to the
 * tab, and whenever you ask; the header says how fresh it is, which is the
 * thing the dot was pretending to tell you.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  CheckCircle2, ChevronRight, Clock, GraduationCap, Inbox, Lock,
  RefreshCw, School, UserCheck, Users,
} from 'lucide-react';
import { useInstituteAuth } from '../../context/InstituteAuthContext';
import {
  getFacultyByInstitute,
  getStudentsByInstitute,
  getInstitute,
  type Faculty,
  type Student,
  type QuestionRightsCeiling,
} from '../../../lib/firebaseService';
import { SchoolsTab } from '../../components/schools/SchoolsTab';
import { ApprovalsInbox } from '../../components/questions/ApprovalsInbox';
import { RIGHT_NAMES, grantableModes } from '../../../lib/questionRights';
import type { DeletionRightsCeiling } from '../../../lib/deletionRights';
import { grantableModes as grantableDeletionModes, instituteMode, DELETABLE_RESOURCES } from '../../../lib/deletionRights';
import { DeletionApprovalsInbox } from '../../components/DeletionApprovalsInbox';
import { TrashPanel } from '../../components/TrashPanel';
import { SubjectRequestsInbox } from '../../components/SubjectRequestsInbox';
import { getPendingDeletionRequestCount } from '../../../lib/deletionRequestService';
import { getPendingRequestCount } from '../../../lib/questionRequestService';
import { FacultyTab } from '../../components/faculty/FacultyTab';
import { StudentTab } from '../../components/student/StudentTab';
import { formatClock, formatDate } from '../../../lib/dateFormat';
import { daysUntilExpiry, NO_EXPIRY_LABEL } from '../../../lib/instituteValidity';
import {
  attentionItems, summariseRoster,
  type AttentionItem, type AttentionTone,
} from '../../../lib/rosterSummary';
import { fetchRosterSignIn } from '../../../lib/rosterSignIn';
import {
  Button, Chip, CopyChip, EmptyState, ErrorBanner, PageHeader, PageShell,
  SectionHeading, StatRow, StatTile,
} from '../../components/console/ui';
import { Avatar, DataTable, Tabs, TableSkeleton, type Column } from '../../components/console/data';

type Tab = 'faculties' | 'students' | 'schools' | 'approvals';

const TONE_COLOUR: Record<AttentionTone, string> = {
  danger: 'var(--ef-danger)',
  warning: 'var(--ef-warning)',
  accent: 'var(--ef-accent)',
};

// ══════════════════════════════════════════════════════════════════
// THE BAND OF THINGS WAITING ON YOU
// ══════════════════════════════════════════════════════════════════

function AttentionRow({ item, onOpen }: { item: AttentionItem; onOpen: () => void }) {
  const colour = TONE_COLOUR[item.tone];
  const actionable = item.tab !== null;

  const body = (
    <>
      <span
        className="ef-card-rail self-stretch"
        style={{
          background: colour,
          marginLeft: 'calc(var(--ef-pad-card) * -1)',
          marginBlock: 'calc(var(--ef-pad-card) * -1)',
        }}
      />
      {item.count !== undefined && (
        <span
          className="ef-display ef-nums flex-shrink-0 text-center"
          style={{ fontSize: 26, lineHeight: 1, color: colour, minWidth: 34 }}
        >
          {item.count}
        </span>
      )}
      <span className="flex-1 min-w-0">
        <span className="ef-t-md ef-ink block" style={{ fontWeight: 500 }}>
          {item.label}
        </span>
        <span className="ef-t-xs ef-muted block" style={{ marginTop: 3, lineHeight: 'var(--ef-leading-relaxed)' }}>
          {item.hint}
        </span>
      </span>
      {actionable && (
        <ChevronRight size={16} strokeWidth={1.7} style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }} />
      )}
    </>
  );

  const style = { padding: 'var(--ef-pad-card)' } as const;

  // A row that cannot be acted on here is not a button. Renewal is the Web
  // Owner's to do, and a chevron that goes nowhere is worse than no chevron.
  return actionable ? (
    <button
      type="button"
      onClick={onOpen}
      className="ef-card ef-card--interactive flex items-center gap-3.5 text-left w-full"
      style={style}
    >
      {body}
    </button>
  ) : (
    <div className="ef-card flex items-center gap-3.5" style={style}>
      {body}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// THE READ-ONLY ROSTERS
// ══════════════════════════════════════════════════════════════════

function StatusChip({ status }: { status: 'active' | 'disabled' }) {
  return (
    <Chip small tone={status === 'active' ? 'success' : 'muted'}>
      {status === 'active' ? 'Active' : 'Disabled'}
    </Chip>
  );
}

/** Name, email and avatar — the identity cell both rosters share. */
function PersonCell({ name, email }: { name: string; email: string }) {
  return (
    <span className="flex items-center gap-2.5 min-w-0">
      <Avatar name={name} size={30} muted />
      <span className="min-w-0">
        <span className="ef-t-sm ef-ink block truncate" style={{ fontWeight: 500 }}>
          {name}
        </span>
        <span className="ef-t-xs ef-muted block truncate">{email}</span>
      </span>
    </span>
  );
}

/**
 * `neverSignedIn` is tri-state on purpose: true, false, or undefined for "not
 * known yet". The badge renders only on true, so a roster that arrives before
 * the Auth lookup shows no badge rather than a wrong one — and, unlike the
 * profile flag this replaced, never claims someone HAS signed in.
 */
function JoinedCell({ createdAt, neverSignedIn }: { createdAt: string; neverSignedIn?: boolean }) {
  return (
    <span>
      <span className="ef-t-xs ef-muted block">{formatDate(createdAt)}</span>
      {neverSignedIn && (
        <span className="ef-t-2xs block" style={{ color: 'var(--ef-warning)', marginTop: 2 }}>
          Never signed in
        </span>
      )}
    </span>
  );
}

// Factories rather than constants, because the "never signed in" badge now
// depends on a set that arrives after the module does. The set is passed in
// rather than read from a context so these stay ordinary data — the tables
// below take columns, not providers.
const facultyColumns = (neverSignedIn: Set<string> | null): Column<Faculty>[] => [
  {
    key: 'name',
    header: 'Faculty',
    primary: true,
    cell: (f) => <PersonCell name={f.name} email={f.email} />,
  },
  { key: 'status', header: 'Status', width: 120, cell: (f) => <StatusChip status={f.status} /> },
  {
    key: 'added',
    header: 'Added',
    width: 160,
    cell: (f) => <JoinedCell createdAt={f.createdAt} neverSignedIn={neverSignedIn?.has(f.id)} />,
  },
];

const studentColumns = (neverSignedIn: Set<string> | null): Column<Student>[] => [
  {
    key: 'name',
    header: 'Student',
    primary: true,
    cell: (s) => <PersonCell name={s.name} email={s.email} />,
  },
  { key: 'status', header: 'Status', width: 120, cell: (s) => <StatusChip status={s.status} /> },
  {
    key: 'program',
    header: 'Programme',
    cell: (s) =>
      s.program?.length ? (
        <span className="flex flex-wrap gap-1">
          {s.program.map((p) => (
            <Chip key={p} small>
              {p}
            </Chip>
          ))}
        </span>
      ) : (
        <span className="ef-muted">—</span>
      ),
  },
  {
    key: 'added',
    header: 'Added',
    width: 160,
    cell: (s) => <JoinedCell createdAt={s.createdAt} neverSignedIn={neverSignedIn?.has(s.id)} />,
  },
];

/**
 * The view an admin gets when they may look but not touch.
 *
 * Whether it appears at all is the institute's `canAdminCreate*` flag, so the
 * empty state has to explain the shape of the world rather than offer an
 * "Add" button that would not work.
 */
function ReadOnlyRoster<T extends { id: string }>({
  rows,
  columns,
  loading,
  icon,
  emptyTitle,
  emptyBody,
}: {
  rows: T[];
  columns: Column<T>[];
  loading: boolean;
  icon: React.ReactNode;
  emptyTitle: string;
  emptyBody: string;
}) {
  if (loading) return <TableSkeleton rows={4} columns={columns.length} />;
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      empty={<EmptyState icon={icon} title={emptyTitle} body={emptyBody} />}
    />
  );
}

// ══════════════════════════════════════════════════════════════════
// PAGE
// ══════════════════════════════════════════════════════════════════

export function InstituteLandingPage() {
  const { session } = useInstituteAuth();
  const instituteId = session?.instituteId;

  const [activeTab, setActiveTab] = useState<Tab>('faculties');
  const tabsRef = useRef<HTMLDivElement>(null);

  // Live permissions — re-fetched on mount so they reflect Web Owner changes
  const [canManageSchools,     setCanManageSchools]     = useState(session?.schoolsManagementEnabled  ?? false);
  const [canCreateFaculty,     setCanCreateFaculty]     = useState(session?.canAdminCreateFaculty     ?? false);
  const [canCreateStudents,    setCanCreateStudents]    = useState(session?.canAdminCreateStudents    ?? false);
  const [facultyCanCreateStud, setFacultyCanCreateStud] = useState(session?.facultyCanCreateStudents  ?? false);
  const [questionCeiling, setQuestionCeiling] = useState<QuestionRightsCeiling | undefined>(undefined);
  // Feature #15 Phase 3 — drives the per-faculty deletion-rights editor.
  const [deletionCeiling, setDeletionCeiling] = useState<DeletionRightsCeiling | undefined>(undefined);
  const [permissionLoading, setPermissionLoading] = useState(true);

  const [pendingCount, setPendingCount] = useState(0);
  const [pendingDeletionCount, setPendingDeletionCount] = useState(0);

  // The approvals inbox is relevant only when the ceiling permits at least one
  // right to be granted to faculty in REQUEST mode.
  const requestModeEnabled = RIGHT_NAMES.some((r) => grantableModes(questionCeiling, r).includes('request'));
  // Feature #15 Phase 4b — the Approvals tab must also open when DELETION
  // requests are possible, which happens two ways: the institute may grant
  // faculty a request-mode right (requests arrive here), or the institute
  // itself acts in request mode (its own requests go up to the Web Owner
  // and it watches them here). Either alone justifies the tab.
  const deletionRequestModeEnabled = DELETABLE_RESOURCES.some(
    (r) => grantableDeletionModes(deletionCeiling, r).includes('request')
      || instituteMode(deletionCeiling, r) === 'request',
  );
  // Feature #15 Phase 6a — this tab is now ALWAYS available, because it also
  // holds the trash. Deleted records need a home regardless of whether any
  // request mode is configured; gating it on requests would make recovery
  // unreachable for exactly the institutes that delete directly.
  const hasApprovalSections = requestModeEnabled || deletionRequestModeEnabled;

  useEffect(() => {
    if (!instituteId) return;
    setPermissionLoading(true);
    getInstitute(instituteId)
      .then((inst) => {
        if (inst) {
          setCanManageSchools(inst.schoolsManagementEnabled   ?? false);
          setCanCreateFaculty(inst.canAdminCreateFaculty      ?? false);
          setCanCreateStudents(inst.canAdminCreateStudents    ?? false);
          setFacultyCanCreateStud(inst.facultyCanCreateStudents ?? false);
          setQuestionCeiling(inst.questionRightsCeiling);
          setDeletionCeiling(inst.deletionRightsCeiling);
        }
      })
      .finally(() => setPermissionLoading(false));
  }, [instituteId]);

  // ── The rosters ────────────────────────────────────────────────
  // Fetched here rather than inside each tab because the summary above the
  // tabs needs both of them, and because two components polling the same two
  // collections was the old design's whole problem.

  const [faculty, setFaculty] = useState<Faculty[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [rosterLoading, setRosterLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [rosterError, setRosterError] = useState('');
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  // Who has never signed in, from Firebase Auth rather than from a Firestore
  // flag nothing maintained. NULL UNTIL IT ANSWERS, and null is rendered as a
  // dash: the bug this replaces was a confident 0 under the words "everyone
  // has", so an unavailable answer must not look like a good one.
  const [facultySignIn, setFacultySignIn] = useState<Set<string> | null>(null);
  const [studentSignIn, setStudentSignIn] = useState<Set<string> | null>(null);

  const loadRosters = useCallback(
    async (isRefresh = false) => {
      if (!instituteId) return;
      if (isRefresh) setRefreshing(true);
      setRosterError('');
      try {
        const [f, s] = await Promise.all([
          getFacultyByInstitute(instituteId),
          getStudentsByInstitute(instituteId),
        ]);
        setFaculty(f);
        setStudents(s);
        setSyncedAt(Date.now());

        // Deliberately AFTER the rosters are on screen and deliberately not
        // awaited into the same Promise.all: this is an Auth lookup over the
        // whole roster, and making the page wait for it would slow the common
        // case to complete a single tile. fetchRosterSignIn never throws, so
        // a failure leaves both sets null and the tile shows a dash.
        void Promise.all([
          fetchRosterSignIn(instituteId, 'faculty'),
          fetchRosterSignIn(instituteId, 'student'),
        ]).then(([fac, stu]) => {
          setFacultySignIn(fac?.neverSignedIn ?? null);
          setStudentSignIn(stu?.neverSignedIn ?? null);
        });
      } catch (e: any) {
        setRosterError(e?.message || 'Could not load your institute’s people.');
      } finally {
        setRosterLoading(false);
        setRefreshing(false);
      }
    },
    [instituteId],
  );

  useEffect(() => {
    loadRosters();
  }, [loadRosters]);

  // Coming back to the tab is the moment the numbers are most likely to be
  // stale and most likely to be looked at, which is why it is the one
  // automatic refresh worth having.
  useEffect(() => {
    const onFocus = () => loadRosters(true);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadRosters]);

  // Pending-request count for the Approvals tab badge (only when relevant).
  useEffect(() => {
    if (!instituteId || !requestModeEnabled) { setPendingCount(0); return; }
    getPendingRequestCount(instituteId).then(setPendingCount).catch(() => {});
  }, [instituteId, requestModeEnabled]);

  // Pending DELETION requests for the same badge (Feature #15 Phase 4b).
  useEffect(() => {
    if (!instituteId || !deletionRequestModeEnabled) { setPendingDeletionCount(0); return; }
    getPendingDeletionRequestCount(instituteId).then(setPendingDeletionCount).catch(() => {});
  }, [instituteId, deletionRequestModeEnabled]);

  // ── What it all adds up to ─────────────────────────────────────

  const facultySummary  = useMemo(() => summariseRoster(faculty,  facultySignIn), [faculty, facultySignIn]);
  const studentSummary  = useMemo(() => summariseRoster(students, studentSignIn), [students, studentSignIn]);

  // Memoised so the tables are not handed a new column array on every render;
  // they rebuild only when the sign-in answer actually arrives.
  const facultyCols = useMemo(() => facultyColumns(facultySignIn), [facultySignIn]);
  const studentCols = useMemo(() => studentColumns(studentSignIn), [studentSignIn]);
  const daysLeft = useMemo(() => daysUntilExpiry(session?.activeUntil), [session?.activeUntil]);

  const needs = useMemo(
    () =>
      rosterLoading
        ? []
        : attentionItems({
            faculty: facultySummary,
            students: studentSummary,
            pendingQuestions: pendingCount,
            pendingDeletions: pendingDeletionCount,
            daysUntilExpiry: daysLeft,
          }),
    [rosterLoading, facultySummary, studentSummary, pendingCount, pendingDeletionCount, daysLeft],
  );

  const openTab = (tab: Tab) => {
    setActiveTab(tab);
    tabsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Null when either half has not answered — a partial total would be a
  // smaller wrong number, not a better one.
  const dormant = facultySummary.dormant === null || studentSummary.dormant === null
    ? null
    : facultySummary.dormant + studentSummary.dormant;
  const waiting = pendingCount + pendingDeletionCount;

  const tabs = [
    { key: 'faculties', label: 'Faculty',  icon: <Users size={13} strokeWidth={1.7} />,         count: rosterLoading ? undefined : facultySummary.total },
    { key: 'students',  label: 'Students', icon: <GraduationCap size={13} strokeWidth={1.7} />, count: rosterLoading ? undefined : studentSummary.total },
    { key: 'schools',   label: 'Schools',  icon: canManageSchools ? <School size={13} strokeWidth={1.7} /> : <Lock size={13} strokeWidth={1.7} /> },
    {
      key: 'approvals',
      label: hasApprovalSections ? 'Approvals & trash' : 'Trash',
      icon: <Inbox size={13} strokeWidth={1.7} />,
      count: waiting || undefined,
    },
  ];

  if (!instituteId) return null;

  return (
    <PageShell>
      <PageHeader
        eyebrow={
          <>
            <span className="ef-eyebrow-dot" />
            Institute admin
          </>
        }
        title={session?.instituteName ?? 'Your institute'}
        subtitle={
          rosterLoading
            ? 'Counting everyone at your institute…'
            : needs.length === 0
              ? `${facultySummary.total + studentSummary.total} ${facultySummary.total + studentSummary.total === 1 ? 'account' : 'accounts'} in good order. Nothing is waiting on you.`
              : `${needs.length} ${needs.length === 1 ? 'thing needs' : 'things need'} your attention.`
        }
        actions={
          <Button size="sm" onClick={() => loadRosters(true)} disabled={rosterLoading || refreshing}>
            <RefreshCw size={12} strokeWidth={1.7} className={refreshing ? 'animate-spin' : ''} />
            Refresh
          </Button>
        }
      >
        <div className="flex items-center gap-2 flex-wrap">
          <CopyChip value={session?.instituteCode ?? ''} label="Institute code" />
          <Chip
            small
            tone={daysLeft === null ? 'muted' : daysLeft <= 0 ? 'danger' : daysLeft <= 30 ? 'warning' : 'muted'}
            icon={<Clock size={11} strokeWidth={1.7} />}
            title={session?.activeUntil ? `Access until ${formatDate(session.activeUntil)}` : undefined}
          >
            {daysLeft === null
              ? NO_EXPIRY_LABEL
              : daysLeft <= 0
                ? 'Access expired'
                : `${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} of access left`}
          </Chip>
          {syncedAt && (
            <span className="ef-t-2xs ef-muted">Updated {formatClock(new Date(syncedAt).toISOString())}</span>
          )}
        </div>
      </PageHeader>

      {rosterError && (
        <div className="mb-6">
          <ErrorBanner message={rosterError} onRetry={() => loadRosters(true)} />
        </div>
      )}

      <div className="flex flex-col" style={{ gap: 30 }}>
        <section>
          <SectionHeading label="Your institute" />
          <StatRow>
            <StatTile
              label="Faculty"
              value={rosterLoading ? '—' : facultySummary.total}
              icon={<Users size={13} strokeWidth={1.7} />}
              sub={rosterLoading ? 'loading' : `${facultySummary.active} can sign in`}
              hint="Everyone with a faculty account at this institute."
            />
            <StatTile
              label="Students"
              value={rosterLoading ? '—' : studentSummary.total}
              icon={<GraduationCap size={13} strokeWidth={1.7} />}
              sub={rosterLoading ? 'loading' : `${studentSummary.active} can sign in`}
              hint="Everyone enrolled here, whatever their status."
            />
            {/* A dash, not a zero, until the Auth lookup answers. The tile
                this replaces was fed by a profile flag nothing ever set, so it
                read 0 / "everyone has" for every institute forever — a
                specific, confident, wrong answer to a question an admin acts
                on. An unavailable answer must not be able to look like a
                clean bill of health. */}
            <StatTile
              label="Never signed in"
              value={rosterLoading || dormant === null ? '—' : dormant}
              icon={<UserCheck size={13} strokeWidth={1.7} />}
              tone={dormant !== null && dormant > 0 ? 'warning' : undefined}
              sub={
                rosterLoading ? 'loading'
                  : dormant === null ? 'unavailable'
                    : dormant > 0 ? 'account never used' : 'everyone has'
              }
              hint="Accounts created but never used, from their Firebase sign-in record. Until someone signs in, their setup link is still the only thing on the account."
            />
            <StatTile
              label="Waiting on you"
              value={rosterLoading ? '—' : waiting}
              icon={<Inbox size={13} strokeWidth={1.7} />}
              tone={waiting > 0 ? 'warning' : undefined}
              sub={waiting > 0 ? 'needs a decision' : 'nothing pending'}
              hint="Question and deletion requests from your faculty."
            />
          </StatRow>
        </section>

        <section>
          <SectionHeading
            label="Needs a decision"
            count={rosterLoading ? undefined : needs.length || undefined}
            hint="Most urgent first."
          />
          {rosterLoading ? (
            <TableSkeleton rows={2} columns={2} />
          ) : needs.length === 0 ? (
            <EmptyState
              icon={<CheckCircle2 size={28} strokeWidth={1.1} />}
              title="Nothing needs you"
              body="Every account here has been signed into, none is disabled, and no requests are pending. This list fills itself when that changes."
            />
          ) : (
            <div className="flex flex-col" style={{ gap: 'var(--ef-gap)' }}>
              {needs.map((item, i) => (
                <motion.div
                  key={item.key}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.24, delay: Math.min(i, 5) * 0.04, ease: [0.16, 1, 0.3, 1] }}
                >
                  <AttentionRow item={item} onOpen={() => item.tab && openTab(item.tab)} />
                </motion.div>
              ))}
            </div>
          )}
        </section>

        <section ref={tabsRef} style={{ scrollMarginTop: 80 }}>
          <Tabs
            items={tabs}
            active={activeTab}
            onChange={(k) => setActiveTab(k as Tab)}
            label="Institute records"
          />

          <div style={{ marginTop: 'var(--ef-gap)' }}>
            <AnimatePresence mode="wait">
              <motion.div
                key={activeTab}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16 }}
              >
                {/* Faculty — the full editor when this institute may create
                    accounts, the read-only roster otherwise. */}
                {activeTab === 'faculties' &&
                  (canCreateFaculty ? (
                    <FacultyTab
                      instituteId={instituteId}
                      instituteName={session!.instituteName}
                      instituteSchoolsEnabled={canManageSchools}
                      instituteFacultyCreateStudentsEnabled={facultyCanCreateStud}
                      questionRightsCeiling={questionCeiling}
                      deletionRightsCeiling={deletionCeiling}
                    />
                  ) : (
                    <ReadOnlyRoster
                      rows={faculty}
                      columns={facultyCols}
                      loading={rosterLoading}
                      icon={<Users size={28} strokeWidth={1.1} />}
                      emptyTitle="No faculty yet"
                      emptyBody="Faculty accounts for this institute are created by the platform administrator. Once they exist they appear here."
                    />
                  ))}

                {activeTab === 'students' &&
                  (canCreateStudents ? (
                    <StudentTab instituteId={instituteId} instituteName={session!.instituteName} />
                  ) : (
                    <ReadOnlyRoster
                      rows={students}
                      columns={studentCols}
                      loading={rosterLoading}
                      icon={<GraduationCap size={28} strokeWidth={1.1} />}
                      emptyTitle="No students yet"
                      emptyBody="Student accounts for this institute are created by the platform administrator. Once they exist they appear here."
                    />
                  ))}

                {activeTab === 'schools' && (
                  <>
                    {!permissionLoading && !canManageSchools && (
                      <div
                        className="flex items-start gap-2.5 mb-5"
                        style={{
                          padding: '12px 14px',
                          background: 'var(--ef-warning-bg)',
                          border: '1px solid var(--ef-warning-border)',
                          borderRadius: 'var(--ef-radius-sm)',
                        }}
                      >
                        <Lock size={14} strokeWidth={1.7} style={{ color: 'var(--ef-warning)', flexShrink: 0, marginTop: 1 }} />
                        <p className="ef-t-sm" style={{ color: 'var(--ef-warning)', lineHeight: 'var(--ef-leading-relaxed)' }}>
                          <strong style={{ fontWeight: 600 }}>View only.</strong> Schools management is not
                          enabled for this institute — you can see the structure but not change it. Your
                          platform administrator can turn editing on.
                        </p>
                      </div>
                    )}
                    {permissionLoading ? (
                      <TableSkeleton rows={3} columns={3} />
                    ) : (
                      <SchoolsTab
                        instituteId={instituteId}
                        instituteName={session!.instituteName}
                        readOnly={!canManageSchools}
                      />
                    )}
                  </>
                )}

                {activeTab === 'approvals' && (
                  <div className="flex flex-col" style={{ gap: 28 }}>
                    {requestModeEnabled && (
                      <div>
                        <SectionHeading label="Question requests" count={pendingCount || undefined} />
                        <ApprovalsInbox instituteId={instituteId} onPendingCountChange={setPendingCount} />
                      </div>
                    )}

                    {/* Feature #15 Phase 4b — deletion requests share this tab
                        rather than getting a competing surface: an admin should
                        have one place to look for things awaiting them. */}
                    {deletionRequestModeEnabled && (
                      <div>
                        <SectionHeading label="Deletion requests" count={pendingDeletionCount || undefined} />
                        <DeletionApprovalsInbox
                          viewerRole="institute"
                          instituteId={instituteId}
                          onResolved={() => {
                            getPendingDeletionRequestCount(instituteId)
                              .then(setPendingDeletionCount).catch(() => {});
                          }}
                        />
                      </div>
                    )}

                    {/* Feature #15 Phase 6a — the institute's own trash.
                        Restore only: permanent deletion stays with the Web
                        Owner. */}
                    <div>
                      <SectionHeading
                        label="Recently deleted"
                        description="You can restore anything here. Permanent deletion stays with the platform administrator, so nothing is lost by mistake."
                      />
                      <TrashPanel instituteId={instituteId} />
                    </div>

                    {/* Feature #15 Phase 7b — this institute's access & erasure
                        requests. It is the controller for its own students, so
                        its requests land here even though the Web Owner
                        executes any erasure. */}
                    <div>
                      <SectionHeading label="Data requests" />
                      <SubjectRequestsInbox instituteId={instituteId} />
                    </div>
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </section>
      </div>
    </PageShell>
  );
}
