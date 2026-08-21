import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Users, Plus, Upload, Loader2, PauseCircle, PlayCircle,
  Trash2, AlertTriangle, X, Mail, MailX, Check, Shield, ShieldCheck,
  GraduationCap, SlidersHorizontal, Inbox, Search,
} from 'lucide-react';
import { AddFacultyDrawer, type Faculty } from './AddFacultyDrawer';
import { FacultyQuestionRightsEditor } from './FacultyQuestionRightsEditor';
import type { QuestionRightsCeiling } from '../../../lib/firebaseService';
import { instituteHasRight, RIGHT_NAMES } from '../../../lib/questionRights';
// NAME COLLISION (documented in deletionRights.ts): both modules export
// instituteHasRight. This file needs BOTH, so the deletion one is aliased.
// Never let these two resolve to the same identifier — they read different
// ceilings and would silently answer the wrong question.
import {
  instituteHasRight as instituteHasDeletionRight,
  grantableModes as grantableDeletionModes,
  DELETABLE_RESOURCES,
  type DeletionRightsCeiling,
} from '../../../lib/deletionRights';
import { FacultyDeletionRightsEditor } from './FacultyDeletionRightsEditor';
import { isRequiresApproval, submitDeletionRequest } from '../../../lib/deletionRequestService';
import { SuccessorPicker } from './SuccessorPicker';
import { BulkFacultyModal } from './BulkFacultyModal';
import {
  getFacultyByInstitute,
  getFaculty,
  setFacultySchoolsPermission,
  setFacultyCreateStudentsPermission,
  setFacultyManageRostersPermission,
} from '../../../lib/firebaseService';
import { setAccountStatus } from '../../../lib/accountAccess';
import { httpsCallable } from 'firebase/functions';
import { sendPasswordResetEmail } from 'firebase/auth';
import { auth, functions } from '../../../lib/firebase';
import { DeletionImpactPanel } from '../DeletionImpactPanel';
import { SubjectDataPanel } from '../SubjectDataPanel';
import { LogSubjectRequestButton } from '../LogSubjectRequestButton';
import { BulkDeleteBar } from '../BulkDeleteBar';
import { formatDate } from '../../../lib/dateFormat';


function SkeletonRow() {
  return (
    <tr style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}>
      {/* Placeholder for the selection column, so the skeleton lines up with
          the header while loading. */}
      <td className="px-5 py-4" style={{ width: 36 }} />
      {[32, 48, 16, 20, 0].map((w, i) => (
        <td key={i} className="px-5 py-4">
          {w > 0 && <div className="h-3 rounded mb-1" style={{ width: `${w * 4}px`, background: 'var(--ef-border-subtle)', animation: 'pulse 1.5s ease-in-out infinite' }} />}
          {i < 2 && <div className="h-2.5 w-20 rounded mt-1" style={{ background: 'var(--ef-border-subtle)', animation: 'pulse 1.5s ease-in-out infinite' }} />}
        </td>
      ))}
    </tr>
  );
}

interface Props {
  instituteId: string;
  instituteName: string;
  instituteSchoolsEnabled?: boolean;
  // New: if true, a "Can create students" toggle is shown per faculty row.
  // Only effective when the institute also has facultyCanCreateStudents = true.
  instituteFacultyCreateStudentsEnabled?: boolean;
  instituteFacultyManageRostersEnabled?: boolean;
  // Institute question-rights ceiling (permission-model Phase 2). When set
  // and any right is allowed, each faculty row gets an expandable question-
  // rights editor. Absent ⇒ no rights UI (institute has no ceiling yet).
  questionRightsCeiling?: QuestionRightsCeiling;
  // Institute deletion-rights ceiling (Feature #15, Phase 3). When set and
  // any resource is DELEGATABLE, the expanded panel also offers a deletion-
  // rights editor. Absent ⇒ no deletion UI.
  deletionRightsCeiling?: DeletionRightsCeiling;
}

export function FacultyTab({
  instituteId,
  instituteName,
  instituteSchoolsEnabled = false,
  instituteFacultyCreateStudentsEnabled = false,
  instituteFacultyManageRostersEnabled = false,
  questionRightsCeiling,
  deletionRightsCeiling,
}: Props) {
  const [faculties, setFaculties]     = useState<Faculty[]>([]);
  // Which faculty row has its question-rights editor expanded.
  const [rightsExpandedId, setRightsExpandedId] = useState<string | null>(null);
  // Whether the institute ceiling offers any right at all (gates the UI).
  const ceilingHasAnyRight = RIGHT_NAMES.some((r) => instituteHasRight(questionRightsCeiling, r));
  // Deletion rights are delegatable only when the institute both HOLDS the
  // resource and has a grantable mode for it — holding a right with modes:[]
  // means "institute may use it, may not delegate it".
  const ceilingHasAnyDeletionRight = DELETABLE_RESOURCES.some(
    (r) => instituteHasDeletionRight(deletionRightsCeiling, r)
      && grantableDeletionModes(deletionRightsCeiling, r).length > 0,
  );
  const showRightsPanel = ceilingHasAnyRight || ceilingHasAnyDeletionRight;
  const [loading, setLoading]         = useState(true);
  const [fetchError, setFetchError]   = useState('');
  const [lastSynced, setLastSynced]   = useState<Date | null>(null);
  const [syncDisplay, setSyncDisplay] = useState('');

  // Drawers / modals
  const [drawerOpen, setDrawerOpen]   = useState(false);
  const [bulkOpen, setBulkOpen]       = useState(false);

  // Per-row state
  const [deletingId, setDeletingId]         = useState<string | null>(null);

  // ── Selection (bulk delete) ──────────────────────────────────────
  // Ids only; the records are re-resolved from the live list at action time.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch]     = useState('');
  const [deleteLoading, setDeleteLoading]   = useState(false);
  // Feature #15 Phase 4b — surfaces request-submission outcomes.
  const [requestNotice, setRequestNotice] = useState<string | null>(null);
  // Feature #15 Phase 5a — who inherits the departing member's content.
  const [successorId, setSuccessorId] = useState<string | null>(null);
  // Set when the server reports live owned assessments; the second click confirms.
  const [liveOwnedCount, setLiveOwnedCount] = useState<number | null>(null);
  const [statusLoadingId, setStatusLoadingId] = useState<string | null>(null);
  // Switching an account off can now genuinely fail — the account is
  // soft-deleted, the institute has expired, the Auth user could not be
  // revoked — and those refusals are the point of the change. The old bare
  // updateDoc had nothing to report, so its catch block logged to the console
  // and the row simply stopped spinning.
  const [statusError, setStatusError] = useState('');
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [schoolsPermLoadingId, setSchoolsPermLoadingId] = useState<string | null>(null);
  const [createStudentsPermLoadingId, setCreateStudentsPermLoadingId] = useState<string | null>(null);
  const [manageRostersPermLoadingId, setManageRostersPermLoadingId] = useState<string | null>(null);

  // Email notice
  const [emailNotice, setEmailNotice] = useState<{ ok: boolean; message: string } | null>(null);

  // ── Fetch ────────────────────────────────────────────────────────

  const fetch_ = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const facultyList = await getFacultyByInstitute(instituteId);
      setFaculties(facultyList);
      setLastSynced(new Date());
      setFetchError('');
    } catch (e: any) {
      if (!silent) setFetchError(e.message || 'Failed to load faculty');
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
    const fmt = (d: Date) => {
      const s = Math.floor((Date.now() - d.getTime()) / 1000);
      if (s < 10) return 'just now';
      if (s < 60) return `${s}s ago`;
      return `${Math.floor(s / 60)}m ago`;
    };
    setSyncDisplay(fmt(lastSynced));
    const t = setInterval(() => setSyncDisplay(fmt(lastSynced)), 1000);
    return () => clearInterval(t);
  }, [lastSynced]);

  // ── Handlers ─────────────────────────────────────────────────────

  const handleCreated = (faculty: Faculty, emailSent: boolean) => {
    setFaculties((prev) => [faculty, ...prev]);
    setDrawerOpen(false);
    setLastSynced(new Date());
    setEmailNotice({
      ok: emailSent,
      message: emailSent
        ? `Credentials sent to ${faculty.email}`
        : `Account created — email delivery failed for ${faculty.email}`,
    });
    setTimeout(() => setEmailNotice(null), 6000);
  };

  const handleBulkCreated = (created: Faculty[]) => {
    setFaculties((prev) => {
      const ids = new Set(prev.map((f) => f.id));
      const newOnes = created.filter((f) => !ids.has(f.id));
      return [...newOnes, ...prev];
    });
    setLastSynced(new Date());
  };

  const handleToggleStatus = async (id: string) => {
    setStatusLoadingId(id);
    setStatusError('');
    try {
      const faculty = await getFaculty(id);
      if (!faculty) throw new Error('Faculty not found');

      const newStatus = faculty.status === 'active' ? 'disabled' : 'active';

      // Through the callable, NOT a direct write. `setFaculty` only ever moved
      // a Firestore field: it left the Firebase Auth account signed in and its
      // refresh tokens valid, and firestore.rules never read `status`, so a
      // disabled faculty member kept working sessions and full data access —
      // including over their institute's question banks and assessments — for
      // as long as they stayed signed in. setAccountStatus disables the Auth
      // user and revokes its tokens as well as writing the field, and the
      // rules now reject a client write that changes `status` at all.
      await setAccountStatus({ role: 'faculty', uid: id, status: newStatus });

      setFaculties((prev) => prev.map((f) => (
        f.id === id ? { ...f, status: newStatus, updatedAt: new Date().toISOString() } : f
      )));
      setLastSynced(new Date());
    } catch (e: any) {
      console.error('Toggle status failed:', e);
      setStatusError(e?.message ?? 'Could not change that faculty member’s status.');
    } finally {
      setStatusLoadingId(null);
    }
  };

  const handleResendCredentials = async (faculty: Faculty) => {
    setResendingId(faculty.id);
    try {
      await sendPasswordResetEmail(auth, faculty.email);
      setEmailNotice({ ok: true, message: `Password-setup link sent to ${faculty.email}.` });
    } catch (e: any) {
      setEmailNotice({ ok: false, message: e?.message ?? 'Failed to send email.' });
    } finally {
      setResendingId(null);
      setTimeout(() => setEmailNotice(null), 6000);
    }
  };

  const handleDelete = async () => {
    if (!deletingId) return;
    setDeleteLoading(true);
    try {
      const deleteAuthUser = httpsCallable<
        { role: string; uid: string; successorId?: string; confirmLiveOwnership?: boolean },
        { ok: boolean }
      >(
        functions,
        'deleteAuthUser'
      );
      await deleteAuthUser({
        role: 'faculty',
        uid: deletingId,
        successorId: successorId ?? undefined,
        confirmLiveOwnership: liveOwnedCount !== null,
      });
      setFaculties((prev) => prev.filter((f) => f.id !== deletingId));
      setDeletingId(null);
      setSuccessorId(null);
      setLiveOwnedCount(null);
      setLastSynced(new Date());
    } catch (e: any) {
      // Feature #15 Phase 4b — request mode is not a failure. Fall through to
      // submitting the request instead of swallowing it into console.error,
      // which is what happened here before and left the admin with a delete
      // button that silently did nothing.
      // Live-exam ownership: not a failure, a checkpoint. Surface the count
      // and let the same button confirm on the second click, rather than
      // making the admin hunt for a separate override.
      const liveMatch = /FACULTY_OWNS_LIVE_ASSESSMENTS:(\d+)/.exec(e?.message ?? '');
      if (liveMatch) {
        setLiveOwnedCount(Number(liveMatch[1]));
        setDeleteLoading(false);
        return;
      }
      if (isRequiresApproval(e)) {
        try {
          await submitDeletionRequest('faculty', deletingId);
          setDeletingId(null);
          setRequestNotice('Deletion request submitted for approval.');
        } catch (subErr: any) {
          setRequestNotice(subErr?.message ?? 'Could not submit the request.');
        }
        setTimeout(() => setRequestNotice(null), 6000);
        setDeleteLoading(false);
        return;
      }
      console.error('Delete failed:', e);
    } finally {
      setDeleteLoading(false);
    }
  };

  // ── Schools permission toggle ─────────────────────────────────

  const handleToggleSchoolsPerm = async (faculty: Faculty) => {
    if (!instituteSchoolsEnabled) return; // gate: institute must allow it first
    setSchoolsPermLoadingId(faculty.id);
    const next = !faculty.schoolsManagementEnabled;
    // Optimistic update
    setFaculties((prev) => prev.map((f) => f.id === faculty.id ? { ...f, schoolsManagementEnabled: next } : f));
    try {
      await setFacultySchoolsPermission(faculty.id, next);
    } catch {
      // Revert on failure
      setFaculties((prev) => prev.map((f) => f.id === faculty.id ? { ...f, schoolsManagementEnabled: !next } : f));
    } finally {
      setSchoolsPermLoadingId(null);
    }
  };

  // ── Can-create-students permission toggle ─────────────────────

  const handleToggleCreateStudentsPerm = async (faculty: Faculty) => {
    if (!instituteFacultyCreateStudentsEnabled) return;
    setCreateStudentsPermLoadingId(faculty.id);
    const next = !(faculty.canCreateStudents ?? false);
    setFaculties((prev) => prev.map((f) => f.id === faculty.id ? { ...f, canCreateStudents: next } : f));
    try {
      await setFacultyCreateStudentsPermission(faculty.id, next);
    } catch {
      setFaculties((prev) => prev.map((f) => f.id === faculty.id ? { ...f, canCreateStudents: !next } : f));
    } finally {
      setCreateStudentsPermLoadingId(null);
    }
  };

  // ── Can-manage-rosters permission toggle ──────────────────────

  const handleToggleManageRostersPerm = async (faculty: Faculty) => {
    if (!instituteFacultyManageRostersEnabled) return;
    setManageRostersPermLoadingId(faculty.id);
    const next = !(faculty.canManageExamRosters ?? false);
    setFaculties((prev) => prev.map((f) => f.id === faculty.id ? { ...f, canManageExamRosters: next } : f));
    try {
      await setFacultyManageRostersPermission(faculty.id, next);
    } catch {
      setFaculties((prev) => prev.map((f) => f.id === faculty.id ? { ...f, canManageExamRosters: !next } : f));
    } finally {
      setManageRostersPermLoadingId(null);
    }
  };

  // ── Derived ──────────────────────────────────────────────────────

  const total    = faculties.length;
  const active   = faculties.filter((f) => f.status === 'active').length;
  const disabled = faculties.filter((f) => f.status === 'disabled').length;
  const existingEmails = new Set(faculties.map((f) => f.email));

  // ── Filter + selection derivations ───────────────────────────────

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return faculties;
    return faculties.filter(
      (f) => f.name.toLowerCase().includes(q) || f.email.toLowerCase().includes(q),
    );
  }, [faculties, search]);

  /**
   * Select-all acts on what is ON SCREEN, never on the whole institute — a
   * checkbox that silently includes rows the filter is hiding is how someone
   * removes people they cannot see.
   */
  const visibleIds      = useMemo(() => visible.map((f) => f.id), [visible]);
  const selectedVisible = visibleIds.filter((id) => selected.has(id));
  const allVisibleSelected = visibleIds.length > 0 && selectedVisible.length === visibleIds.length;

  const toggleOne = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const toggleAllVisible = () => setSelected((prev) => {
    const next = new Set(prev);
    if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
    else visibleIds.forEach((id) => next.add(id));
    return next;
  });

  const selectedTargets = useMemo(
    () => faculties
      .filter((f) => selected.has(f.id))
      .map((f) => ({ id: f.id, label: f.name || f.email })),
    [faculties, selected],
  );

  // ── Render ───────────────────────────────────────────────────────

  return (
    <>
      {/* ── Sub-header ── */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-4">
          {!loading && total > 0 && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-3">
              <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                {total} {total === 1 ? 'member' : 'members'}
              </span>
              <span style={{ color: 'var(--ef-border)' }}>·</span>
              <span className="text-xs" style={{ color: 'var(--ef-success)' }}>{active} active</span>
              {disabled > 0 && (
                <>
                  <span style={{ color: 'var(--ef-border)' }}>·</span>
                  <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{disabled} disabled</span>
                </>
              )}
            </motion.div>
          )}
          {/* Live indicator */}
          {lastSynced && (
            <div className="flex items-center gap-1.5 select-none">
              <div className="relative w-2 h-2 flex items-center justify-center">
                <span className="absolute inline-flex w-2 h-2 rounded-full opacity-60"
                  style={{ background: 'var(--ef-success)', animation: 'ping 1.8s cubic-bezier(0,0,0.2,1) infinite' }} />
                <span className="relative inline-flex w-1.5 h-1.5 rounded-full" style={{ background: 'var(--ef-success)' }} />
              </div>
              <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{syncDisplay}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Narrowing the list is what makes select-all safe to offer. */}
          {(total > 0 || search) && (
            <div className="flex items-center gap-1.5 px-2.5 py-2"
              style={{ border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}>
              <Search size={11} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search name or email…"
                className="text-xs"
                style={{ background: 'transparent', border: 'none', outline: 'none', color: 'var(--ef-ink)', width: 160 }}
              />
              {search && (
                <button onClick={() => setSearch('')} style={{ color: 'var(--ef-text-muted)' }}>
                  <X size={10} strokeWidth={1.5} />
                </button>
              )}
            </div>
          )}
          <button onClick={() => setBulkOpen(true)}
            className="flex items-center gap-1.5 text-xs px-3 py-2 transition-colors"
            style={{ border: '1px solid var(--ef-border)', color: 'var(--ef-text-subtle)', borderRadius: 2, background: 'var(--ef-surface)' }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.borderColor = 'var(--ef-ink)')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.borderColor = 'var(--ef-border)')}>
            <Upload size={11} strokeWidth={1.5} />Add in Bulk
          </button>
          <button onClick={() => setDrawerOpen(true)}
            className="flex items-center gap-1.5 text-xs px-3 py-2 transition-opacity"
            style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, letterSpacing: '0.03em' }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.opacity = '0.85')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.opacity = '1')}>
            <Plus size={11} strokeWidth={2} />Add Single
          </button>
        </div>
      </div>

      {/* ── Email notice ── */}
      <AnimatePresence>
        {emailNotice && (
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2 }}
            className="flex items-center gap-2.5 px-4 py-2.5 mb-4"
            style={{
              background: emailNotice.ok ? 'var(--ef-success-bg-alt)' : 'var(--ef-danger-bg)',
              border: `1px solid ${emailNotice.ok ? 'var(--ef-success-border-alt)' : 'var(--ef-danger-border)'}`,
              borderRadius: 2,
            }}>
            {emailNotice.ok
              ? <Mail size={12} strokeWidth={1.5} style={{ color: 'var(--ef-success)', flexShrink: 0 }} />
              : <MailX size={12} strokeWidth={1.5} style={{ color: 'var(--ef-danger)', flexShrink: 0 }} />}
            <p className="text-xs flex-1" style={{ color: emailNotice.ok ? 'var(--ef-success)' : 'var(--ef-danger)' }}>
              {emailNotice.message}
            </p>
            <button onClick={() => setEmailNotice(null)} style={{ color: 'var(--ef-text-muted)' }}>
              <X size={11} strokeWidth={1.5} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Bulk selection → the existing deletion flow, once per record */}
      <BulkDeleteBar
        role="faculty"
        targets={selectedTargets}
        onClear={() => setSelected(new Set())}
        onDeleted={(ids) => {
          const gone = new Set(ids);
          setFaculties((prev) => prev.filter((f) => !gone.has(f.id)));
        }}
        onFinished={() => void fetch_(true)}
      />

      {/* ── Fetch error ── */}
      {requestNotice && (
        <div className="flex items-center gap-2 px-4 py-3 mb-4"
          style={{ background: 'var(--ef-success-bg)', border: '1px solid var(--ef-success-border)', borderRadius: 2 }}>
          <Inbox size={12} strokeWidth={1.5} style={{ color: 'var(--ef-success-strong)' }} />
          <p className="text-xs" style={{ color: 'var(--ef-success-strong)' }}>{requestNotice}</p>
        </div>
      )}

      {/* Status-change refusal. Dismissed rather than retried: the reasons this
          fails are states someone has to resolve elsewhere — a deleted account,
          a lapsed institute — not transient failures worth pressing again. */}
      {statusError && (
        <div className="flex items-center gap-2 px-4 py-3 mb-4" role="alert"
          style={{ background: 'var(--ef-danger-bg)', border: '1px solid var(--ef-danger-border)', borderRadius: 2 }}>
          <AlertTriangle size={12} strokeWidth={1.5} style={{ color: 'var(--ef-danger)' }} />
          <p className="text-xs flex-1" style={{ color: 'var(--ef-danger)' }}>{statusError}</p>
          <button onClick={() => setStatusError('')} style={{ color: 'var(--ef-text-muted)' }}
            aria-label="Dismiss">
            <X size={11} strokeWidth={1.5} />
          </button>
        </div>
      )}

      {fetchError && (
        <div className="flex items-center gap-2 px-4 py-3 mb-4"
          style={{ background: 'var(--ef-danger-bg)', border: '1px solid var(--ef-danger-border)', borderRadius: 2 }}>
          <AlertTriangle size={12} strokeWidth={1.5} style={{ color: 'var(--ef-danger)' }} />
          <p className="text-xs" style={{ color: 'var(--ef-danger)' }}>{fetchError}</p>
          <button onClick={() => fetch_()} className="ml-auto text-xs"
            style={{ color: 'var(--ef-danger)', textDecoration: 'underline' }}>Retry</button>
        </div>
      )}

      {/* ── Table ── */}
      <div style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3, overflow: 'hidden' }}>
        <table className="w-full" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'var(--ef-canvas-raised)', borderBottom: '1px solid var(--ef-border)' }}>
              <th className="px-5 py-3" style={{ width: 36 }}>
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  // Some-but-not-all reads as a dash rather than a tick, so the
                  // header never claims a wider selection than it has.
                  ref={(el) => {
                    if (el) el.indeterminate = selectedVisible.length > 0 && !allVisibleSelected;
                  }}
                  onChange={toggleAllVisible}
                  disabled={visibleIds.length === 0}
                  aria-label={allVisibleSelected ? 'Clear selection' : 'Select all shown'}
                  style={{ cursor: visibleIds.length === 0 ? 'default' : 'pointer' }}
                />
              </th>
              {['FACULTY', 'ROLE', 'STATUS', 'GRANTED', 'SCHOOLS', 'STU. CREATE', 'ROSTER', ''].map((col, i) => (
                <th key={i} className="text-left px-5 py-3 text-xs"
                  style={{
                    color: 'var(--ef-text-muted)', letterSpacing: '0.08em', fontWeight: 400,
                    width: i === 0 ? '24%' : i === 1 ? '9%' : i === 2 ? '9%' : i === 3 ? '10%' : i === 4 ? '9%' : i === 5 ? '10%' : i === 6 ? '9%' : '20%',
                  }}>
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && <><SkeletonRow /><SkeletonRow /><SkeletonRow /></>}

            {/* A search that matches nothing is not an empty institute, and
                must not offer "add your first faculty" as the way out. */}
            {!loading && faculties.length > 0 && visible.length === 0 && (
              <tr>
                <td colSpan={9}>
                  <div className="flex flex-col items-center py-16">
                    <Search size={24} strokeWidth={1} style={{ color: 'var(--ef-border-muted)' }} />
                    <p className="text-xs mt-4" style={{ color: 'var(--ef-text-muted)' }}>
                      No faculty match “{search}”
                    </p>
                    <button onClick={() => setSearch('')} className="text-xs mt-3"
                      style={{ color: 'var(--ef-text-subtle)', textDecoration: 'underline' }}>
                      Clear search
                    </button>
                  </div>
                </td>
              </tr>
            )}

            {!loading && faculties.length === 0 && !fetchError && (
              <tr>
                <td colSpan={9}>
                  <div className="flex flex-col items-center py-16">
                    <Users size={28} strokeWidth={1} style={{ color: 'var(--ef-border-muted)' }} />
                    <p className="text-xs mt-4" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.06em' }}>
                      No faculty registered
                    </p>
                    <p className="text-xs mt-1" style={{ color: 'var(--ef-border-muted)' }}>
                      Begin onboarding to grant access.
                    </p>
                    <div className="flex items-center gap-2 mt-6">
                      <button onClick={() => setDrawerOpen(true)}
                        className="flex items-center gap-1.5 text-xs px-3 py-2"
                        style={{ border: '1px solid var(--ef-border)', color: 'var(--ef-text-subtle)', borderRadius: 2, background: 'var(--ef-surface)' }}
                        onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.borderColor = 'var(--ef-ink)')}
                        onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.borderColor = 'var(--ef-border)')}>
                        <Plus size={11} strokeWidth={2} />Add Single
                      </button>
                      <button onClick={() => setBulkOpen(true)}
                        className="flex items-center gap-1.5 text-xs px-3 py-2"
                        style={{ border: '1px solid var(--ef-border)', color: 'var(--ef-text-subtle)', borderRadius: 2, background: 'var(--ef-surface)' }}
                        onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.borderColor = 'var(--ef-ink)')}
                        onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.borderColor = 'var(--ef-border)')}>
                        <Upload size={11} strokeWidth={1.5} />Add in Bulk
                      </button>
                    </div>
                  </div>
                </td>
              </tr>
            )}

            {!loading && visible.map((faculty) => {
              const isConfirmDelete = deletingId === faculty.id;
              const isSelected = selected.has(faculty.id);
              const isTogglingStatus = statusLoadingId === faculty.id;
              const isResending = resendingId === faculty.id;
              const isTogglingSchools = schoolsPermLoadingId === faculty.id;
              const isTogglingStudents = createStudentsPermLoadingId === faculty.id;
              const isTogglingRosters  = manageRostersPermLoadingId === faculty.id;
              const schoolsEnabled = faculty.schoolsManagementEnabled ?? false;
              const createStudentsEnabled = faculty.canCreateStudents ?? false;
              const manageRostersEnabled  = faculty.canManageExamRosters ?? false;
              const canToggleSchools = instituteSchoolsEnabled;
              const canToggleStudents = instituteFacultyCreateStudentsEnabled;
              const canToggleRosters  = instituteFacultyManageRostersEnabled;

              return (
                <motion.tr key={faculty.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                  style={{
                    borderBottom: '1px solid var(--ef-border-subtle)',
                    background: isConfirmDelete ? 'var(--ef-danger-bg)'
                      : isSelected ? 'var(--ef-canvas-raised)'
                      : 'transparent',
                    transition: 'background 0.15s',
                  }}>
                  {/* Selection */}
                  <td className="px-5 py-3.5">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleOne(faculty.id)}
                      aria-label={`Select ${faculty.name || faculty.email}`}
                      style={{ cursor: 'pointer' }}
                    />
                  </td>

                  {/* Faculty name + email */}
                  <td className="px-5 py-3.5">
                    <p className="text-sm" style={{ color: 'var(--ef-ink)', lineHeight: 1.4 }}>{faculty.name}</p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--ef-text-muted)' }}>{faculty.email}</p>
                  </td>

                  {/* Role badge */}
                  <td className="px-5 py-3.5">
                    <span className="inline-block text-xs px-2 py-0.5"
                      style={{ background: 'var(--ef-border-subtle)', color: 'var(--ef-text-subtle)', borderRadius: 2, letterSpacing: '0.03em' }}>
                      Faculty
                    </span>
                  </td>

                  {/* Status badge */}
                  <td className="px-5 py-3.5">
                    <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5"
                      style={faculty.status === 'active'
                        ? { background: 'var(--ef-success-bg-alt)', color: 'var(--ef-success)', border: '1px solid var(--ef-success-border-alt)', borderRadius: 2 }
                        : { background: 'var(--ef-canvas-raised)', color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
                      <span style={{
                        width: 5, height: 5, borderRadius: '50%',
                        background: faculty.status === 'active' ? 'var(--ef-success)' : 'var(--ef-text-muted)',
                        display: 'inline-block', flexShrink: 0,
                      }} />
                      {faculty.status === 'active' ? 'Active' : 'Disabled'}
                    </span>
                  </td>

                  {/* Created */}
                  <td className="px-5 py-3.5">
                    <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{formatDate(faculty.createdAt)}</p>
                  </td>

                  {/* Schools permission toggle */}
                  <td className="px-5 py-3.5">
                    <button
                      onClick={() => handleToggleSchoolsPerm(faculty)}
                      disabled={isTogglingSchools || !canToggleSchools}
                      title={
                        !canToggleSchools
                          ? 'Enable institute-level Schools access first'
                          : schoolsEnabled
                            ? 'Revoke Schools access'
                            : 'Grant Schools access'
                      }
                      className="flex items-center gap-1.5 text-xs transition-all"
                      style={{
                        opacity: !canToggleSchools ? 0.4 : 1,
                        cursor: !canToggleSchools ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {isTogglingSchools ? (
                        <Loader2 size={12} strokeWidth={1.5} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />
                      ) : schoolsEnabled ? (
                        <ShieldCheck size={13} strokeWidth={1.5} style={{ color: 'var(--ef-success)' }} />
                      ) : (
                        <Shield size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
                      )}
                      <span style={{ color: schoolsEnabled && canToggleSchools ? 'var(--ef-success)' : 'var(--ef-text-muted)' }}>
                        {schoolsEnabled ? 'On' : 'Off'}
                      </span>
                    </button>
                  </td>

                  {/* Can create students toggle */}
                  <td className="px-5 py-3.5">
                    <button
                      onClick={() => handleToggleCreateStudentsPerm(faculty)}
                      disabled={isTogglingStudents || !canToggleStudents}
                      title={
                        !canToggleStudents
                          ? 'Enable institute-level Faculty→Student creation first'
                          : createStudentsEnabled
                            ? 'Revoke student creation permission'
                            : 'Grant student creation permission'
                      }
                      className="flex items-center gap-1.5 text-xs transition-all"
                      style={{
                        opacity: !canToggleStudents ? 0.4 : 1,
                        cursor: !canToggleStudents ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {isTogglingStudents ? (
                        <Loader2 size={12} strokeWidth={1.5} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />
                      ) : createStudentsEnabled ? (
                        <GraduationCap size={13} strokeWidth={1.5} style={{ color: 'var(--ef-success)' }} />
                      ) : (
                        <GraduationCap size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
                      )}
                      <span style={{ color: createStudentsEnabled && canToggleStudents ? 'var(--ef-success)' : 'var(--ef-text-muted)' }}>
                        {createStudentsEnabled ? 'On' : 'Off'}
                      </span>
                    </button>
                  </td>

                  {/* Can manage rosters toggle */}
                  <td className="px-5 py-3.5">
                    <button
                      onClick={() => handleToggleManageRostersPerm(faculty)}
                      disabled={isTogglingRosters || !canToggleRosters}
                      title={
                        !canToggleRosters
                          ? 'Enable institute-level Faculty Roster access first'
                          : manageRostersEnabled
                            ? 'Revoke roster management permission'
                            : 'Grant roster management permission'
                      }
                      className="flex items-center gap-1.5 text-xs transition-all"
                      style={{
                        opacity: !canToggleRosters ? 0.4 : 1,
                        cursor: !canToggleRosters ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {isTogglingRosters ? (
                        <Loader2 size={12} strokeWidth={1.5} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />
                      ) : (
                        <Shield size={13} strokeWidth={1.5} style={{ color: manageRostersEnabled && canToggleRosters ? 'var(--ef-success)' : 'var(--ef-text-muted)' }} />
                      )}
                      <span style={{ color: manageRostersEnabled && canToggleRosters ? 'var(--ef-success)' : 'var(--ef-text-muted)' }}>
                        {manageRostersEnabled ? 'On' : 'Off'}
                      </span>
                    </button>
                  </td>

                  {/* Actions */}
                  <td className="px-5 py-3.5">
                    {isConfirmDelete ? (
                      <div className="flex flex-col items-end gap-2">
                        {/* Feature #15 Phase 1 — live dependency counts. For
                            faculty these are OWNED CONTENT counts (assessments,
                            questions, banks), which is what makes the Phase 5
                            succession decision necessary. Informational only. */}
                        <div style={{ minWidth: 260, textAlign: 'left', width: '100%' }}>
                          <DeletionImpactPanel entityType="faculty" entityId={faculty.id} />
                          {/* Feature #15 Phase 7a — what STRATUM holds
                              about this person. Read-only; sits here
                              because the moment you are about to remove
                              someone is when you are most likely to be
                              answering for what was kept. */}
                          <div className="mt-2">
                            <SubjectDataPanel role="faculty" uid={faculty.id} displayName={faculty.name} />
                            <div className="mt-2">
                              <LogSubjectRequestButton subjectRole="faculty" subjectId={faculty.id} />
                            </div>
                          </div>
                          {/* Feature #15 Phase 5a — succession. Optional by
                              design: leaving it on the default hands content
                              to the institute admin, which always works. */}
                          <div className="mt-2">
                            <SuccessorPicker
                              instituteId={instituteId}
                              excludeFacultyId={faculty.id}
                              value={successorId}
                              onChange={setSuccessorId}
                              disabled={deleteLoading}
                            />
                          </div>
                          {liveOwnedCount !== null && (
                            <div className="flex items-start gap-2 mt-2 px-2.5 py-2"
                              style={{ background: 'var(--ef-warning-bg)', border: '1px solid var(--ef-warning-border)', borderRadius: 2 }}>
                              <AlertTriangle size={12} style={{ marginTop: 1, flexShrink: 0, color: 'var(--ef-warning-strong)' }} />
                              <span className="text-xs" style={{ color: 'var(--ef-warning-strong)' }}>
                                This member owns {liveOwnedCount} active assessment
                                {liveOwnedCount === 1 ? '' : 's'}. Students may be
                                mid-attempt. Confirm again to proceed — ownership
                                transfers immediately.
                              </span>
                            </div>
                          )}
                        </div>
                        <div className="flex items-center justify-end gap-2">
                        <span className="text-xs" style={{ color: 'var(--ef-danger)' }}>Remove?</span>
                        <button onClick={handleDelete} disabled={deleteLoading}
                          className="flex items-center gap-1 text-xs px-2 py-1"
                          style={{ background: 'var(--ef-danger)', color: 'var(--ef-surface)', borderRadius: 2 }}>
                          {deleteLoading ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} strokeWidth={2} />}
                          Confirm
                        </button>
                        <button
                          onClick={() => { setDeletingId(null); setSuccessorId(null); setLiveOwnedCount(null); }}
                          disabled={deleteLoading}
                          className="text-xs px-2 py-1"
                          style={{ color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
                          Cancel
                        </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-end gap-0.5">
                        {/* Question-rights editor toggle (Phase 2) */}
                        {showRightsPanel && (
                          <button
                            onClick={() => setRightsExpandedId((prev) => (prev === faculty.id ? null : faculty.id))}
                            title="Question rights"
                            className="p-2 rounded transition-all"
                            style={{
                              color: rightsExpandedId === faculty.id ? 'var(--ef-success)' : 'var(--ef-text-muted)',
                              cursor: 'pointer',
                            }}
                          >
                            <SlidersHorizontal size={13} strokeWidth={1.5} />
                          </button>
                        )}
                        {/* Toggle status */}
                        <button
                          onClick={() => handleToggleStatus(faculty.id)}
                          disabled={isTogglingStatus}
                          title={faculty.status === 'active' ? 'Disable faculty' : 'Enable faculty'}
                          className="p-2 rounded transition-all"
                          style={{ color: 'var(--ef-text-muted)', cursor: isTogglingStatus ? 'not-allowed' : 'pointer' }}
                          onMouseEnter={(e) => { if (!isTogglingStatus) (e.currentTarget as HTMLElement).style.color = 'var(--ef-text-subtle)'; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)'; }}>
                          {isTogglingStatus
                            ? <Loader2 size={13} strokeWidth={1.5} className="animate-spin" />
                            : faculty.status === 'active'
                            ? <PauseCircle size={13} strokeWidth={1.5} />
                            : <PlayCircle size={13} strokeWidth={1.5} />}
                        </button>

                        {/* Resend password-setup link */}
                        <button
                          onClick={() => handleResendCredentials(faculty)}
                          disabled={isResending}
                          title="Resend password-setup link"
                          className="p-2 rounded transition-all"
                          style={{ color: 'var(--ef-text-muted)', cursor: isResending ? 'not-allowed' : 'pointer' }}
                          onMouseEnter={(e) => { if (!isResending) (e.currentTarget as HTMLElement).style.color = 'var(--ef-text-subtle)'; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)'; }}>
                          {isResending
                            ? <Loader2 size={13} strokeWidth={1.5} className="animate-spin" />
                            : <Mail size={13} strokeWidth={1.5} />}
                        </button>

                        {/* Delete */}
                        <button
                          onClick={() => setDeletingId(faculty.id)}
                          title="Remove faculty member"
                          className="p-2 rounded transition-all"
                          style={{ color: 'var(--ef-text-muted)' }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--ef-danger)'; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)'; }}>
                          <Trash2 size={13} strokeWidth={1.5} />
                        </button>
                      </div>
                    )}
                  </td>
                </motion.tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Expanded question-rights editor — rendered outside the table so it
          isn't constrained by cell layout; keyed to the selected faculty. */}
      {rightsExpandedId && showRightsPanel && (() => {
        const fac = faculties.find((f) => f.id === rightsExpandedId);
        if (!fac) return null;
        return (
          <div
            className="mt-3 px-4 py-4"
            style={{ background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border)', borderRadius: 3 }}
          >
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs" style={{ color: 'var(--ef-ink)' }}>
                Permissions — <span style={{ color: 'var(--ef-text-muted)' }}>{fac.name}</span>
              </p>
              <button onClick={() => setRightsExpandedId(null)} className="p-1" style={{ color: 'var(--ef-text-muted)' }}>
                <X size={13} strokeWidth={1.5} />
              </button>
            </div>
            {ceilingHasAnyRight && (
              <FacultyQuestionRightsEditor
                facultyId={fac.id}
                ceiling={questionRightsCeiling}
                initial={fac.questionRights}
                onSaved={(rights) =>
                  setFaculties((prev) => prev.map((f) => (f.id === fac.id ? { ...f, questionRights: rights } : f)))
                }
              />
            )}
            {ceilingHasAnyDeletionRight && (
              <FacultyDeletionRightsEditor
                facultyId={fac.id}
                ceiling={deletionRightsCeiling}
                initial={fac.deletionRights}
                onSaved={(rights) =>
                  setFaculties((prev) => prev.map((f) => (f.id === fac.id ? { ...f, deletionRights: rights } : f)))
                }
              />
            )}
          </div>
        );
      })()}

      {!loading && total > 0 && (
        <p className="text-xs mt-3" style={{ color: 'var(--ef-text-muted)' }}>
          Data refreshes automatically every 5 seconds.
        </p>
      )}

      {/* ── Drawers & Modals ── */}
      <AddFacultyDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onCreated={handleCreated}
        instituteId={instituteId}
        instituteName={instituteName}
      />
      <BulkFacultyModal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onCreated={handleBulkCreated}
        instituteId={instituteId}
        instituteName={instituteName}
        existingEmails={existingEmails}
      />
    </>
  );
}