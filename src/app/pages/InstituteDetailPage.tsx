import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router';
import { motion, AnimatePresence } from 'motion/react';
import {
  ChevronLeft, AlertTriangle, Loader2, Users, School, Shield, ShieldCheck,
  UserPlus, GraduationCap, BookOpen,
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
import { daysUntilExpiry, NO_EXPIRY_LABEL } from '../../lib/instituteValidity';
import { formatDateLong as formatDate } from '../../lib/dateFormat';


function validityInfo(activeUntil: string) {
  const days = daysUntilExpiry(activeUntil);
  // Checked FIRST — this header used to read "Until Invalid Date" for any
  // institute that simply has no expiry.
  if (days === null) return { label: NO_EXPIRY_LABEL, color: 'var(--ef-text-muted)' };
  if (days < 0) return { label: 'Expired', color: 'var(--ef-danger)' };
  if (days === 0) return { label: 'Expires today', color: 'var(--ef-warning-strong)' };
  if (days <= 7) return { label: `${days}d remaining`, color: 'var(--ef-warning-strong)' };
  return { label: `Until ${formatDate(activeUntil)}`, color: 'var(--ef-text-muted)' };
}

type PrimaryTab = 'users' | 'schools' | 'permissions';
type UsersSubTab = 'faculty' | 'students' | 'trash';

// ── Permission toggle ─────────────────────────────────────────────

function PermToggle({
  label, sublabel, enabled, saving, onToggle, icon, disabled: isDisabled, disabledReason,
}: {
  label: string;
  sublabel: string;
  enabled: boolean;
  saving: boolean;
  onToggle: () => void;
  icon: React.ReactNode;
  disabled?: boolean;
  disabledReason?: string;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 px-3 py-3 md:px-4 mb-2"
      style={{
        background: isDisabled ? 'var(--ef-canvas-raised)' : 'var(--ef-canvas)',
        border: '1px solid var(--ef-border)',
        borderRadius: 2,
        opacity: isDisabled ? 0.6 : 1,
      }}
    >
      <div className="flex items-center gap-2.5 min-w-0 flex-1">
        <span style={{ color: enabled ? 'var(--ef-success)' : 'var(--ef-text-muted)' }}>{icon}</span>
        <div className="min-w-0">
          <p className="text-xs" style={{ color: 'var(--ef-ink)' }}>{label}</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--ef-text-muted)' }}>
            {isDisabled && disabledReason ? disabledReason : sublabel}
          </p>
        </div>
      </div>
      <button
        onClick={onToggle}
        disabled={saving || isDisabled}
        className="flex items-center gap-2 text-xs px-3 py-1.5 transition-all select-none flex-shrink-0"
        style={{
          border: `1px solid ${enabled ? 'var(--ef-success-border-alt)' : 'var(--ef-border)'}`,
          borderRadius: 2,
          background: enabled ? 'var(--ef-success-bg-alt)' : 'var(--ef-surface)',
          color: enabled ? 'var(--ef-success)' : 'var(--ef-text-muted)',
          cursor: saving || isDisabled ? 'not-allowed' : 'pointer',
          opacity: saving ? 0.6 : 1,
        }}
      >
        {saving ? <Loader2 size={10} className="animate-spin" /> : (
          <span style={{
            display: 'inline-flex', width: 28, height: 16, borderRadius: 8,
            background: enabled ? 'var(--ef-success)' : 'var(--ef-track)',
            alignItems: 'center', padding: '0 2px', transition: 'background 0.2s',
          }}>
            <span style={{
              display: 'inline-block', width: 12, height: 12, borderRadius: '50%',
              background: 'var(--ef-surface)',
              transform: enabled ? 'translateX(12px)' : 'translateX(0)',
              transition: 'transform 0.2s',
            }} />
          </span>
        )}
        {enabled ? 'Allowed' : 'Restricted'}
      </button>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────

export function InstituteDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [institute, setInstitute] = useState<Institute | null>(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');

  const [primaryTab, setPrimaryTab]   = useState<PrimaryTab>('users');
  const [usersSubTab, setUsersSubTab] = useState<UsersSubTab>('faculty');

  // ── Permission states ──────────────────────────────────────────
  const [schoolsPerm,              setSchoolsPerm]              = useState(false);
  const [adminCreateFacultyPerm,   setAdminCreateFacultyPerm]   = useState(false);
  const [adminCreateStudentsPerm,  setAdminCreateStudentsPerm]  = useState(false);
  const [facultyCreateStudentsPerm, setFacultyCreateStudentsPerm] = useState(false);
  const [adminCreateQuestionsPerm, setAdminCreateQuestionsPerm] = useState(false);
  const [adminManageRostersPerm,   setAdminManageRostersPerm]   = useState(false);
  const [facultyManageRostersPerm, setFacultyManageRostersPerm] = useState(false);

  const [savingPerm, setSavingPerm] = useState<string | null>(null);

  // ── Fetch institute ────────────────────────────────────────────

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    getInstitute(id)
      .then((found) => {
        if (!found) { setError('Institute not found.'); return; }
        setInstitute(found);
        setSchoolsPerm(found.schoolsManagementEnabled ?? false);
        setAdminCreateFacultyPerm(found.canAdminCreateFaculty ?? false);
        setAdminCreateStudentsPerm(found.canAdminCreateStudents ?? false);
        setFacultyCreateStudentsPerm(found.facultyCanCreateStudents ?? false);
        setAdminCreateQuestionsPerm(found.canAdminCreateQuestions ?? false);
        setAdminManageRostersPerm(found.canAdminManageExamRosters ?? false);
        setFacultyManageRostersPerm(found.facultyCanManageExamRosters ?? false);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  // ── Permission toggle handlers ─────────────────────────────────

  const togglePerm = async (
    key: string,
    current: boolean,
    setter: (v: boolean) => void,
    saveFn: (id: string, v: boolean) => Promise<void>,
  ) => {
    if (!institute) return;
    setSavingPerm(key);
    const next = !current;
    setter(next); // optimistic
    try { await saveFn(institute.id, next); }
    catch { setter(!next); } // revert on failure
    finally { setSavingPerm(null); }
  };

  const handleToggleSchoolsPerm = () => togglePerm(
    'schoolsPerm',
    schoolsPerm,
    setSchoolsPerm,
    setInstituteSchoolsPermission,
  );

  const handleToggleAdminCreateFacultyPerm = () => togglePerm(
    'adminCreateFacultyPerm',
    adminCreateFacultyPerm,
    setAdminCreateFacultyPerm,
    setInstituteAdminCreateFacultyPermission,
  );

  const handleToggleAdminCreateStudentsPerm = () => togglePerm(
    'adminCreateStudentsPerm',
    adminCreateStudentsPerm,
    setAdminCreateStudentsPerm,
    setInstituteAdminCreateStudentsPermission,
  );

  const handleToggleFacultyCreateStudentsPerm = () => togglePerm(
    'facultyCreateStudentsPerm',
    facultyCreateStudentsPerm,
    setFacultyCreateStudentsPerm,
    setInstituteFacultyCreateStudentsPermission,
  );

  const handleToggleAdminCreateQuestionsPerm = () => togglePerm(
    'adminCreateQuestionsPerm',
    adminCreateQuestionsPerm,
    setAdminCreateQuestionsPerm,
    setInstituteAdminCreateQuestionsPermission,
  );

  const handleToggleAdminManageRostersPerm = () => togglePerm(
    'adminManageRostersPerm',
    adminManageRostersPerm,
    setAdminManageRostersPerm,
    setInstituteAdminManageRostersPermission,
  );

  const handleToggleFacultyManageRostersPerm = () => togglePerm(
    'facultyManageRostersPerm',
    facultyManageRostersPerm,
    setFacultyManageRostersPerm,
    setInstituteFacultyManageRostersPermission,
  );

  // ── Loading ────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 size={20} strokeWidth={1} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />
      </div>
    );
  }

  if (error || !institute) {
    return (
      <div className="px-4 py-6 md:px-8 md:py-10" style={{ maxWidth: 1120, margin: '0 auto' }}>
        <button onClick={() => navigate('/dashboard/user-management')}
          className="flex items-center gap-1.5 text-xs mb-8 transition-colors"
          style={{ color: 'var(--ef-text-muted)' }}
          onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--ef-ink)')}
          onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)')}>
          <ChevronLeft size={13} strokeWidth={1.5} />User Management
        </button>
        <div className="flex items-center gap-2 px-4 py-3"
          style={{ background: 'var(--ef-danger-bg)', border: '1px solid var(--ef-danger-border)', borderRadius: 2 }}>
          <AlertTriangle size={13} strokeWidth={1.5} style={{ color: 'var(--ef-danger)' }} />
          <p className="text-xs" style={{ color: 'var(--ef-danger)' }}>{error || 'Institute not found.'}</p>
        </div>
      </div>
    );
  }

  const validity = validityInfo(institute.activeUntil);

  const PRIMARY_TABS: { key: PrimaryTab; icon: React.ReactNode; label: string }[] = [
    { key: 'users',       icon: <Users size={12} strokeWidth={1.5} />,     label: 'Users' },
    { key: 'schools',     icon: <School size={12} strokeWidth={1.5} />,    label: 'Schools' },
    { key: 'permissions', icon: <Shield size={12} strokeWidth={1.5} />,    label: 'Permissions' },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="px-4 py-6 md:px-8 md:py-10"
      style={{ maxWidth: 1120, margin: '0 auto' }}
    >
      {/* ── Breadcrumb ── */}
      <button
        onClick={() => navigate('/dashboard/user-management')}
        className="flex items-center gap-1.5 text-xs mb-6 transition-colors select-none"
        style={{ color: 'var(--ef-text-muted)' }}
        onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--ef-ink)')}
        onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)')}
      >
        <ChevronLeft size={12} strokeWidth={1.5} />
        User Management
      </button>

      {/* ── Institute header ── */}
      <div
        className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between mb-6 pb-5"
        style={{ borderBottom: '1px solid var(--ef-border)' }}
      >
        <div>
          <p className="text-xs mb-1" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>WEB OWNER · INSTITUTE</p>
          <h1 className="text-lg font-medium mb-1" style={{ color: 'var(--ef-ink)', letterSpacing: '-0.01em' }}>
            {institute.name}
          </h1>
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            <span className="text-xs px-2 py-0.5"
              style={{ fontFamily: 'monospace', letterSpacing: '0.12em', color: 'var(--ef-text-subtle)', background: 'var(--ef-border-subtle)', borderRadius: 2 }}>
              {institute.code}
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5"
              style={institute.status === 'active'
                ? { background: 'var(--ef-success-bg-alt)', color: 'var(--ef-success)', border: '1px solid var(--ef-success-border-alt)', borderRadius: 2 }
                : { background: 'var(--ef-canvas-raised)', color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
              <span style={{
                width: 5, height: 5, borderRadius: '50%', display: 'inline-block',
                background: institute.status === 'active' ? 'var(--ef-success)' : 'var(--ef-text-muted)',
              }} />
              {institute.status === 'active' ? 'Active' : 'Disabled'}
            </span>
            <span className="text-xs" style={{ color: validity.color }}>{validity.label}</span>
          </div>
        </div>

        {/* Admin info */}
        <div className="md:text-right">
          <p className="text-xs mb-0.5" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.06em' }}>ADMINISTRATOR</p>
          <p className="text-xs" style={{ color: 'var(--ef-ink)' }}>{institute.adminName}</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--ef-text-muted)' }}>{institute.adminEmail}</p>
        </div>
      </div>

      {/* ── Primary tab bar ── */}
      <div className="flex items-center gap-0 mb-0 overflow-x-auto" style={{ borderBottom: '1px solid var(--ef-border)' }}>
        {PRIMARY_TABS.map((tab) => {
          const isActive = primaryTab === tab.key;
          return (
            <button key={tab.key}
              onClick={() => setPrimaryTab(tab.key)}
              className="relative flex items-center gap-1.5 px-4 py-2.5 text-xs select-none transition-colors"
              style={{
                color: isActive ? 'var(--ef-ink)' : 'var(--ef-text-muted)',
                fontWeight: isActive ? 500 : 400,
                letterSpacing: '0.03em',
              }}
              onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.color = 'var(--ef-text-subtle)'; }}
              onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)'; }}
            >
              {tab.icon}{tab.label}
              {isActive && (
                <motion.div layoutId="primary-tab-underline"
                  className="absolute bottom-0 left-0 right-0"
                  style={{ height: 1.5, background: 'var(--ef-ink)' }}
                  transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* ── Tab content ── */}
      <AnimatePresence mode="wait">

        {/* Users tab */}
        {primaryTab === 'users' && (
          <motion.div key="users-panel"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="pt-6"
          >
            {/* Users sub-tab bar */}
            <div className="flex items-center gap-0 mb-6" style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}>
              {([
                { key: 'faculty' as UsersSubTab, label: 'Faculty' },
                { key: 'students' as UsersSubTab, label: 'Students' },
                // Deleted faculty and students belong WITH the institute they
                // came from. They used to be listed on the platform-level
                // User Management page, mixed across every tenant, which made
                // "who did we remove from this institute" a question the UI
                // could not answer.
                { key: 'trash' as UsersSubTab, label: 'Trash' },
              ]).map((sub) => {
                const isActive = usersSubTab === sub.key;
                return (
                  <button key={sub.key} onClick={() => setUsersSubTab(sub.key)}
                    className="relative px-4 py-2.5 text-xs transition-colors select-none"
                    style={{
                      color: isActive ? 'var(--ef-ink)' : 'var(--ef-text-muted)',
                      fontWeight: isActive ? 500 : 400,
                      letterSpacing: '0.03em',
                    }}
                    onMouseEnter={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.color = 'var(--ef-text-subtle)'; }}
                    onMouseLeave={(e) => { if (!isActive) (e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)'; }}
                  >
                    {sub.label}
                    {isActive && (
                      <motion.div layoutId="users-sub-underline"
                        className="absolute bottom-0 left-0 right-0"
                        style={{ height: 1.5, background: 'var(--ef-ink)' }}
                        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                      />
                    )}
                  </button>
                );
              })}
            </div>

            <AnimatePresence mode="wait">
              {usersSubTab === 'faculty' && (
                <motion.div key="faculty-tab"
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}>
                  <FacultyTab
                    instituteId={institute.id}
                    instituteName={institute.name}
                    instituteSchoolsEnabled={schoolsPerm}
                    instituteFacultyCreateStudentsEnabled={facultyCreateStudentsPerm}
                    instituteFacultyManageRostersEnabled={facultyManageRostersPerm}
                    questionRightsCeiling={institute.questionRightsCeiling}
                    deletionRightsCeiling={institute.deletionRightsCeiling}
                  />
                </motion.div>
              )}
              {usersSubTab === 'students' && (
                <motion.div key="students-tab"
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}>
                  <StudentTab instituteId={institute.id} instituteName={institute.name} />
                </motion.div>
              )}
              {usersSubTab === 'trash' && (
                <motion.div key="trash-tab"
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}>
                  <p className="text-xs mb-3" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
                    Faculty and students deleted from {institute.name}. Restoring
                    returns the account and its access; after the retention window
                    the scheduled purge removes it for good.
                  </p>
                  {/* The SAME panel the Institute Admin uses, scoped the same
                      way — instituteId narrows the query to this tenant, so a
                      record from another institute cannot appear here.
                      canPurge because the Web Owner is the only role that may
                      permanently delete, exactly as before this moved. */}
                  <TrashPanel instituteId={institute.id} canPurge />
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}

        {/* Schools tab */}
        {primaryTab === 'schools' && (
          <motion.div key="schools-panel"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="pt-6"
          >
            <SchoolsTab instituteId={institute.id} instituteName={institute.name} />
          </motion.div>
        )}

        {/* Permissions tab */}
        {primaryTab === 'permissions' && (
          <motion.div key="permissions-panel"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="pt-6"
          >
            <p className="text-xs mb-1" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>PERMISSION GATES</p>
            <p className="text-xs mb-5" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.7 }}>
              Control what this institute's admin and faculty members are allowed to do on the platform.
              Changes take effect immediately.
            </p>

            <div className="space-y-0">
              <PermToggle
                label="Institute Admin — Schools Management"
                sublabel={schoolsPerm ? 'Institute Admin can manage the Schools tab.' : 'Institute Admin cannot access the Schools tab.'}
                enabled={schoolsPerm}
                saving={savingPerm === 'schoolsPerm'}
                onToggle={() => togglePerm('schoolsPerm', schoolsPerm, setSchoolsPerm, setInstituteSchoolsPermission)}
                icon={schoolsPerm ? <ShieldCheck size={13} strokeWidth={1.5} /> : <Shield size={13} strokeWidth={1.5} />}
              />

              <PermToggle
                label="Institute Admin — Create Faculty"
                sublabel="Institute Admin can add, edit, and manage faculty members."
                enabled={adminCreateFacultyPerm}
                saving={savingPerm === 'adminCreateFacultyPerm'}
                onToggle={handleToggleAdminCreateFacultyPerm}
                icon={<UserPlus size={13} strokeWidth={1.5} />}
              />

              <PermToggle
                label="Institute Admin — Create Students"
                sublabel="Institute Admin can add, edit, and manage students."
                enabled={adminCreateStudentsPerm}
                saving={savingPerm === 'adminCreateStudentsPerm'}
                onToggle={handleToggleAdminCreateStudentsPerm}
                icon={<GraduationCap size={13} strokeWidth={1.5} />}
              />

              <PermToggle
                label="Faculty — Create Students"
                sublabel="Faculty members (when individually granted) can create students. Requires Institute Admin to also grant this per faculty member."
                enabled={facultyCreateStudentsPerm}
                saving={savingPerm === 'facultyCreateStudentsPerm'}
                onToggle={handleToggleFacultyCreateStudentsPerm}
                icon={<GraduationCap size={13} strokeWidth={1.5} />}
                disabled={!adminCreateStudentsPerm}
                disabledReason="Enable 'Institute Admin — Create Students' first to unlock this."
              />

              <PermToggle
                label="Institute Admin — Create Questions"
                sublabel={adminCreateQuestionsPerm
                  ? 'Institute Admin can create and manage their own private question pool.'
                  : 'Institute Admin cannot create questions. Only Web Owner-granted questions are accessible.'}
                enabled={adminCreateQuestionsPerm}
                saving={savingPerm === 'adminCreateQuestionsPerm'}
                onToggle={handleToggleAdminCreateQuestionsPerm}
                icon={<BookOpen size={13} strokeWidth={1.5} />}
              />

              <PermToggle
                label="Institute Admin — Manage Exam Rosters"
                sublabel="Institute Admin can view live exam rosters, see student attempt status, and freeze/unfreeze sessions."
                enabled={adminManageRostersPerm}
                saving={savingPerm === 'adminManageRostersPerm'}
                onToggle={handleToggleAdminManageRostersPerm}
                icon={<Shield size={13} strokeWidth={1.5} />}
              />

              <PermToggle
                label="Faculty — Manage Exam Rosters"
                sublabel="Faculty members (when individually granted) can manage rosters for their own assessments. Requires Institute Admin gate above."
                enabled={facultyManageRostersPerm}
                saving={savingPerm === 'facultyManageRostersPerm'}
                onToggle={handleToggleFacultyManageRostersPerm}
                icon={<Shield size={13} strokeWidth={1.5} />}
                disabled={!adminManageRostersPerm}
                disabledReason="Enable 'Institute Admin — Manage Exam Rosters' first to unlock this."
              />

              {/* ── Question rights ceiling (permission-model Phase 2) ── */}
              <div className="mt-6 pt-5" style={{ borderTop: '1px solid var(--ef-border)' }}>
                <p className="text-xs mb-3" style={{ color: 'var(--ef-ink)', letterSpacing: '0.06em' }}>
                  QUESTION RIGHTS CEILING
                </p>
                {institute && (
                  <QuestionRightsCeilingEditor
                    instituteId={institute.id}
                    initial={institute.questionRightsCeiling}
                    onSaved={(ceiling) =>
                      setInstitute((prev) => (prev ? { ...prev, questionRightsCeiling: ceiling } : prev))
                    }
                  />
                )}
              </div>

              {/* ── Deletion rights ceiling (Feature #15, Phase 2) ── */}
              <div className="mt-6 pt-5" style={{ borderTop: '1px solid var(--ef-border)' }}>
                <p className="text-xs mb-3" style={{ color: 'var(--ef-ink)', letterSpacing: '0.06em' }}>
                  DELETION RIGHTS CEILING
                </p>
                {institute && (
                  <DeletionRightsCeilingEditor
                    instituteId={institute.id}
                    initial={institute.deletionRightsCeiling}
                    initialTransfer={institute.contentTransferRight}
                    onSaved={(deletionRightsCeiling, contentTransferRight) =>
                      setInstitute((prev) =>
                        prev ? { ...prev, deletionRightsCeiling, contentTransferRight } : prev)
                    }
                  />
                )}
              </div>
            </div>
          </motion.div>
        )}

      </AnimatePresence>
    </motion.div>
  );
}