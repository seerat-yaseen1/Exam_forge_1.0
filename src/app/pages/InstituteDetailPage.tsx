/**
 * One institute, from the platform's side: its people, its schools, and the
 * gates that decide what it is allowed to do.
 *
 * ── THE PERMISSIONS TAB IS THE POINT ──────────────────────────────
 * It was a flat list of seven rows, each labelled in the schema's voice —
 * "Institute Admin — Create Students", "Faculty — Manage Exam Rosters" —
 * followed by two ceiling editors under shouted headings. Read top to
 * bottom it gave no sense of which switches were about the same person, and
 * two of the seven silently depend on another two: faculty cannot be allowed
 * to create students at an institute whose own admin cannot.
 *
 * They are now grouped by WHO the gate is about, in the order authority
 * flows — what the admin may do, then what they may pass down to faculty,
 * then the ceilings that bound both. The dependent switches say what would
 * unlock them instead of just going grey, which is otherwise read as a bug.
 *
 * The labels are sentences about the institute rather than field names. The
 * reader is deciding whether to trust a customer with a capability; "Add and
 * manage their own students" answers that, "Institute Admin — Create
 * Students" makes them translate first.
 */

import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import {
  BookOpen, ChevronLeft, ClipboardList, GraduationCap, School, Shield, ShieldCheck,
  UserPlus, Users,
} from 'lucide-react';
import {
  getInstitute, type Institute,
  setInstituteSchoolsPermission,
  setInstituteAdminCreateFacultyPermission,
  setInstituteAdminCreateStudentsPermission,
  setInstituteFacultyCreateStudentsPermission,
  setInstituteAdminCreateQuestionsPermission,
  setInstituteAdminManageRostersPermission,
  setInstituteFacultyManageRostersPermission,
} from '../../lib/firebaseService';
import { FacultyTab } from '../components/faculty/FacultyTab';
import { QuestionRightsCeilingEditor } from '../components/questions/QuestionRightsCeilingEditor';
import { DeletionRightsCeilingEditor } from '../components/questions/DeletionRightsCeilingEditor';
import { StudentTab } from '../components/student/StudentTab';
import { SchoolsTab } from '../components/schools/SchoolsTab';
import { TrashPanel } from '../components/TrashPanel';
import { daysUntilExpiry } from '../../lib/instituteValidity';
import { HEALTH_LABEL, HEALTH_TONE, expiryPhrase, healthOf } from '../../lib/fleetOverview';
import { formatDate } from '../../lib/dateFormat';
import {
  Card, Chip, CopyChip, ErrorBanner, LoadingBlock, PageHeader, PageShell,
  SectionHeading, Toggle,
} from '../components/console/ui';
import { Segmented, Tabs } from '../components/console/data';

type PrimaryTab = 'users' | 'schools' | 'permissions';
type UsersSubTab = 'faculty' | 'students' | 'trash';

/** One switch's whole definition, so the render below is a list and not a wall. */
type Gate = {
  key: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  value: boolean;
  set: (v: boolean) => void;
  save: (id: string, v: boolean) => Promise<void>;
  /** Named here rather than checked inline, so the reason is next to the rule. */
  requires?: { on: boolean; because: string };
};

export function InstituteDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [institute, setInstitute] = useState<Institute | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [primaryTab, setPrimaryTab] = useState<PrimaryTab>('users');
  const [usersSubTab, setUsersSubTab] = useState<UsersSubTab>('faculty');

  const [schools, setSchools] = useState(false);
  const [adminFaculty, setAdminFaculty] = useState(false);
  const [adminStudents, setAdminStudents] = useState(false);
  const [facultyStudents, setFacultyStudents] = useState(false);
  const [adminQuestions, setAdminQuestions] = useState(false);
  const [adminRosters, setAdminRosters] = useState(false);
  const [facultyRosters, setFacultyRosters] = useState(false);

  const [savingKey, setSavingKey] = useState<string | null>(null);

  const load = React.useCallback(() => {
    if (!id) return;
    setLoading(true);
    getInstitute(id)
      .then((found) => {
        if (!found) { setError('That institute does not exist, or has been deleted.'); return; }
        setInstitute(found);
        setSchools(found.schoolsManagementEnabled ?? false);
        setAdminFaculty(found.canAdminCreateFaculty ?? false);
        setAdminStudents(found.canAdminCreateStudents ?? false);
        setFacultyStudents(found.facultyCanCreateStudents ?? false);
        setAdminQuestions(found.canAdminCreateQuestions ?? false);
        setAdminRosters(found.canAdminManageExamRosters ?? false);
        setFacultyRosters(found.facultyCanManageExamRosters ?? false);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  const flip = async (gate: Gate) => {
    if (!institute) return;
    setSavingKey(gate.key);
    const next = !gate.value;
    gate.set(next); // optimistic
    try {
      await gate.save(institute.id, next);
    } catch {
      gate.set(!next); // revert on failure
    } finally {
      setSavingKey(null);
    }
  };

  if (loading) {
    return (
      <PageShell>
        <LoadingBlock label="Loading this institute…" rows={3} />
      </PageShell>
    );
  }

  if (error || !institute) {
    return (
      <PageShell>
        <PageHeader
          eyebrow={
            <button type="button" className="ef-crumb" onClick={() => navigate('/dashboard/user-management')}>
              <ChevronLeft size={12} strokeWidth={1.8} />
              Institutes
            </button>
          }
          title="Institute not found"
        />
        <ErrorBanner
          message={error || 'That institute does not exist, or has been deleted.'}
          onRetry={load}
        />
      </PageShell>
    );
  }

  const health = healthOf(institute);
  const days = daysUntilExpiry(institute.activeUntil);

  // ── The gates, grouped by who they are about ───────────────────

  const adminGates: Gate[] = [
    {
      key: 'adminFaculty',
      label: 'Add and manage their own faculty',
      description: 'Without this, faculty accounts for this institute can only be created here, by you.',
      icon: <UserPlus size={14} strokeWidth={1.7} />,
      value: adminFaculty,
      set: setAdminFaculty,
      save: setInstituteAdminCreateFacultyPermission,
    },
    {
      key: 'adminStudents',
      label: 'Add and manage their own students',
      description: 'Enrolment moves to them: bulk upload, edits, disabling accounts.',
      icon: <GraduationCap size={14} strokeWidth={1.7} />,
      value: adminStudents,
      set: setAdminStudents,
      save: setInstituteAdminCreateStudentsPermission,
    },
    {
      key: 'adminQuestions',
      label: 'Write their own questions',
      description: adminQuestions
        ? 'They keep a private pool, visible only inside this institute.'
        : 'Without this they can only use questions the platform has granted them.',
      icon: <BookOpen size={14} strokeWidth={1.7} />,
      value: adminQuestions,
      set: setAdminQuestions,
      save: setInstituteAdminCreateQuestionsPermission,
    },
    {
      key: 'schools',
      label: 'Organise themselves into schools',
      description: 'The Schools tab, where an institute divides itself into faculties, departments and programmes.',
      icon: schools ? <ShieldCheck size={14} strokeWidth={1.7} /> : <Shield size={14} strokeWidth={1.7} />,
      value: schools,
      set: setSchools,
      save: setInstituteSchoolsPermission,
    },
    {
      key: 'adminRosters',
      label: 'Watch and control live exams',
      description: 'See who is sitting, who has submitted, and freeze or release a session mid-exam.',
      icon: <ClipboardList size={14} strokeWidth={1.7} />,
      value: adminRosters,
      set: setAdminRosters,
      save: setInstituteAdminManageRostersPermission,
    },
  ];

  const facultyGates: Gate[] = [
    {
      key: 'facultyStudents',
      label: 'Faculty may create students',
      description: 'Only as far as the institute admin grants it, per person. This opens the door; they decide who walks through it.',
      icon: <GraduationCap size={14} strokeWidth={1.7} />,
      value: facultyStudents,
      set: setFacultyStudents,
      save: setInstituteFacultyCreateStudentsPermission,
      requires: {
        on: adminStudents,
        because: 'Allow the institute admin to manage students first — faculty cannot be granted more than the admin has.',
      },
    },
    {
      key: 'facultyRosters',
      label: 'Faculty may control their own live exams',
      description: 'For assessments they own. Again, per person, and only up to what the admin has been given.',
      icon: <ClipboardList size={14} strokeWidth={1.7} />,
      value: facultyRosters,
      set: setFacultyRosters,
      save: setInstituteFacultyManageRostersPermission,
      requires: {
        on: adminRosters,
        because: 'Allow the institute admin to control live exams first — faculty cannot be granted more than the admin has.',
      },
    },
  ];

  const renderGates = (gates: Gate[]) => (
    <Card padded={false}>
      {gates.map((g) => (
        <Toggle
          key={g.key}
          label={g.label}
          description={g.description}
          icon={g.icon}
          checked={g.value}
          busy={savingKey === g.key}
          lockedBecause={g.requires && !g.requires.on ? g.requires.because : undefined}
          onChange={() => flip(g)}
        />
      ))}
    </Card>
  );

  return (
    <PageShell>
      <PageHeader
        eyebrow={
          <button type="button" className="ef-crumb" onClick={() => navigate('/dashboard/user-management')}>
            <ChevronLeft size={12} strokeWidth={1.8} />
            Institutes
          </button>
        }
        title={institute.name}
        subtitle={
          <>
            Run by <span className="ef-ink">{institute.adminName}</span> · {institute.adminEmail}
          </>
        }
      >
        <div className="flex items-center gap-2 flex-wrap">
          <CopyChip value={institute.code} label="Institute code" />
          <Chip small tone={HEALTH_TONE[health]}>
            {HEALTH_LABEL[health]}
          </Chip>
          <span
            className="ef-t-xs"
            title={institute.activeUntil ? formatDate(institute.activeUntil) : undefined}
            style={{ color: days !== null && days < 0 ? 'var(--ef-danger)' : 'var(--ef-text-muted)' }}
          >
            {expiryPhrase(days)}
          </span>
        </div>
      </PageHeader>

      <Tabs
        items={[
          { key: 'users', label: 'Users', icon: <Users size={13} strokeWidth={1.7} /> },
          { key: 'schools', label: 'Schools', icon: <School size={13} strokeWidth={1.7} /> },
          { key: 'permissions', label: 'Permissions', icon: <Shield size={13} strokeWidth={1.7} /> },
        ]}
        active={primaryTab}
        onChange={(k) => setPrimaryTab(k as PrimaryTab)}
        label="Institute sections"
      />

      <div style={{ marginTop: 'var(--ef-gap)' }}>
        {primaryTab === 'users' && (
          <>
            <div style={{ marginBottom: 'var(--ef-gap)' }}>
              <Segmented<UsersSubTab>
                label="Which people"
                value={usersSubTab}
                onChange={setUsersSubTab}
                options={[
                  { value: 'faculty', label: 'Faculty' },
                  { value: 'students', label: 'Students' },
                  // Deleted faculty and students belong WITH the institute
                  // they came from. They used to be listed on the platform-
                  // level page, mixed across every tenant, which made "who did
                  // we remove from this institute" a question the UI could not
                  // answer.
                  { value: 'trash', label: 'Deleted' },
                ]}
              />
            </div>

            {usersSubTab === 'faculty' && (
              <FacultyTab
                instituteId={institute.id}
                instituteName={institute.name}
                instituteSchoolsEnabled={schools}
                instituteFacultyCreateStudentsEnabled={facultyStudents}
                instituteFacultyManageRostersEnabled={facultyRosters}
                questionRightsCeiling={institute.questionRightsCeiling}
                deletionRightsCeiling={institute.deletionRightsCeiling}
              />
            )}

            {usersSubTab === 'students' && (
              <StudentTab instituteId={institute.id} instituteName={institute.name} />
            )}

            {usersSubTab === 'trash' && (
              <>
                <SectionHeading
                  label="Deleted from this institute"
                  description={`Faculty and students removed from ${institute.name}. Restoring returns the account and its access; after the retention window the scheduled purge removes it for good.`}
                />
                {/* The SAME panel the institute admin uses, scoped the same
                    way — instituteId narrows the query to this tenant, so a
                    record from another institute cannot appear here. canPurge
                    because the Web Owner is the only role that may permanently
                    delete, exactly as before this moved. */}
                <TrashPanel instituteId={institute.id} canPurge />
              </>
            )}
          </>
        )}

        {primaryTab === 'schools' && (
          <SchoolsTab instituteId={institute.id} instituteName={institute.name} />
        )}

        {primaryTab === 'permissions' && (
          <div className="flex flex-col" style={{ gap: 30 }}>
            <section>
              <SectionHeading
                label="What this institute may do"
                description="Every switch here writes immediately, and takes effect for everyone at the institute on their next page load."
              />
              {renderGates(adminGates)}
            </section>

            <section>
              <SectionHeading
                label="What it may pass down to faculty"
                description="These open a door rather than walk through it: the institute admin still grants each right person by person, and can never grant more than they hold themselves."
              />
              {renderGates(facultyGates)}
            </section>

            <section>
              <SectionHeading
                label="Question rights ceiling"
                description="The most any faculty member here can be granted over questions — and whether each right acts directly or has to be approved."
              />
              <Card>
                <QuestionRightsCeilingEditor
                  instituteId={institute.id}
                  initial={institute.questionRightsCeiling}
                  onSaved={(ceiling) =>
                    setInstitute((prev) => (prev ? { ...prev, questionRightsCeiling: ceiling } : prev))
                  }
                />
              </Card>
            </section>

            <section>
              <SectionHeading
                label="Deletion rights ceiling"
                description="The same, for deleting records — and what happens to the content of somebody who is removed."
              />
              <Card>
                <DeletionRightsCeilingEditor
                  instituteId={institute.id}
                  initial={institute.deletionRightsCeiling}
                  initialTransfer={institute.contentTransferRight}
                  onSaved={(deletionRightsCeiling, contentTransferRight) =>
                    setInstitute((prev) =>
                      prev ? { ...prev, deletionRightsCeiling, contentTransferRight } : prev)
                  }
                />
              </Card>
            </section>
          </div>
        )}
      </div>
    </PageShell>
  );
}
