import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  GraduationCap, Plus, Upload, Loader2, PauseCircle, PlayCircle,
  Trash2, AlertTriangle, X, Mail, MailX, Check, Search,
} from 'lucide-react';
import { BulkDeleteBar } from '../BulkDeleteBar';
import { AddStudentDrawer, type Student } from './AddStudentDrawer';
import { BulkStudentModal } from './BulkStudentModal';
import {
  getStudentsByInstitute,
  getStudent,
} from '../../../lib/firebaseService';
import { setAccountStatus } from '../../../lib/accountAccess';
import { httpsCallable } from 'firebase/functions';
import { sendPasswordResetEmail } from 'firebase/auth';
import { auth, functions } from '../../../lib/firebase';
import { DeletionImpactPanel } from '../DeletionImpactPanel';
import { SubjectDataPanel } from '../SubjectDataPanel';
import { LogSubjectRequestButton } from '../LogSubjectRequestButton';
import { isRequiresApproval, submitDeletionRequest } from '../../../lib/deletionRequestService';
import { UNKNOWN_DATE_LABEL, formatDate as formatIsoDate } from '../../../lib/dateFormat';

/**
 * A local wrapper, not a fourth copy: this column receives EITHER a Firestore
 * Timestamp or an ISO string, and lib/dateFormat takes strings. The isNaN
 * guard also has to stay — `toISOString()` THROWS on an Invalid Date, so
 * removing it would turn a bad value from an em dash into a crash.
 */
function formatDate(value: unknown): string {
  if (!value) return UNKNOWN_DATE_LABEL;
  const d =
    typeof value === 'object' && value !== null && 'toDate' in value
      ? (value as { toDate: () => Date }).toDate()
      : new Date(value as string);
  return isNaN(d.getTime()) ? UNKNOWN_DATE_LABEL : formatIsoDate(d.toISOString());
}
function formatSyncAge(d: Date) {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

// Multi-value metadata pills
function MetaPills({ values }: { values?: string[] }) {
  if (!values?.length) return <span style={{ color: 'var(--ef-text-muted)' }}>—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {values.map((v, i) => (
        <span key={i} className="text-xs px-1.5 py-0.5"
          style={{ background: 'var(--ef-border-subtle)', color: 'var(--ef-text-subtle)', borderRadius: 2 }}>
          {v}
        </span>
      ))}
    </div>
  );
}

function SkeletonRow() {
  return (
    <tr style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}>
      {/* Placeholder for the selection column, so the skeleton lines up with
          the header while loading. */}
      <td className="px-5 py-4" style={{ width: 36 }} />
      {[32, 14, 16, 24, 0].map((w, i) => (
        <td key={i} className="px-5 py-4">
          {w > 0 && <div className="h-3 rounded mb-1" style={{ width: `${w * 4}px`, background: 'var(--ef-track)', animation: 'pulse 1.5s ease-in-out infinite' }} />}
          {i < 2 && <div className="h-2.5 w-16 rounded mt-1" style={{ background: 'var(--ef-border-subtle)', animation: 'pulse 1.5s ease-in-out infinite' }} />}
        </td>
      ))}
    </tr>
  );
}

interface Props {
  instituteId: string;
  instituteName: string;
}

export function StudentTab({ instituteId, instituteName }: Props) {
  const [students, setStudents]       = useState<Student[]>([]);
  const [loading, setLoading]         = useState(true);
  const [fetchError, setFetchError]   = useState('');
  const [lastSynced, setLastSynced]   = useState<Date | null>(null);
  const [syncDisplay, setSyncDisplay] = useState('');

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [bulkOpen, setBulkOpen]     = useState(false);

  const [deletingId, setDeletingId]         = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading]   = useState(false);
  const [statusLoadingId, setStatusLoadingId] = useState<string | null>(null);
  // Switching an account off can now genuinely fail — the account is
  // soft-deleted, the institute has expired, the Auth user could not be
  // revoked — and those refusals are the point of the change. The old bare
  // updateDoc had nothing to report, so its catch block logged to the console
  // and the row simply stopped spinning.
  const [statusError, setStatusError]       = useState('');
  const [resendingId, setResendingId]       = useState<string | null>(null);

  const [emailNotice, setEmailNotice] = useState<{ ok: boolean; message: string } | null>(null);

  // ── Selection (bulk delete) ──────────────────────────────────────
  // Ids only. Holding the records themselves would mean the selection and the
  // table could disagree after the 5s poll refreshes one and not the other.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch]     = useState('');

  // ── Fetch ────────────────────────────────────────────────────────

  const fetch_ = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const studentList = await getStudentsByInstitute(instituteId);
      // Deduplicate by ID — guards against any KV-layer duplicates
      const seen = new Set<string>();
      const unique = studentList.filter((s) => {
        if (seen.has(s.id)) return false;
        seen.add(s.id);
        return true;
      });
      setStudents(unique);
      setLastSynced(new Date());
      setFetchError('');
    } catch (e: any) {
      if (!silent) setFetchError(e.message || 'Failed to load students');
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

  // ── Handlers ─────────────────────────────────────────────────────

  const handleCreated = (student: Student, emailSent: boolean) => {
    // Guard: don't prepend if this ID already exists (e.g. from a concurrent poll)
    setStudents((prev) => {
      if (prev.some((s) => s.id === student.id)) return prev;
      return [student, ...prev];
    });
    setDrawerOpen(false);
    setLastSynced(new Date());
    setEmailNotice({
      ok: emailSent,
      message: emailSent
        ? `Credentials sent to ${student.email}`
        : `Account created — email delivery failed for ${student.email}`,
    });
    setTimeout(() => setEmailNotice(null), 6000);
  };

  const handleBulkCreated = (created: Student[]) => {
    setStudents((prev) => {
      const ids = new Set(prev.map((s) => s.id));
      return [...created.filter((s) => !ids.has(s.id)), ...prev];
    });
    setLastSynced(new Date());
  };

  const handleToggleStatus = async (id: string) => {
    setStatusLoadingId(id);
    setStatusError('');
    try {
      const data = await getStudent(id);
      // getStudent returns Student | null. The null case was unhandled, so a
      // student deleted (or made unreadable) between the list render and this
      // click threw a TypeError on `data.status` — swallowed by the catch below
      // as a console error, leaving the row spinner to just stop with no
      // explanation. Returning early keeps the list truthful instead.
      if (!data) throw new Error('Student profile not found.');
      // `as const` keeps the union narrow; without it the ternary widens to
      // `string` and no longer satisfies Student['status'].
      const next = (data.status === 'active' ? 'disabled' : 'active') as 'active' | 'disabled';

      // Through the callable, NOT a direct write. `setStudent` only ever moved
      // a Firestore field: it left the Firebase Auth account signed in and its
      // refresh tokens valid, and firestore.rules never read `status`, so a
      // disabled student kept working sessions and full data access for as
      // long as they stayed signed in. setAccountStatus disables the Auth user
      // and revokes its tokens as well as writing the field, and the rules now
      // reject a client write that changes `status` at all — so this path is
      // the only one, and the two halves cannot drift apart again.
      await setAccountStatus({ role: 'student', uid: id, status: next });

      setStudents((prev) => prev.map((s) => s.id === id ? { ...s, status: next } : s));
      setLastSynced(new Date());
    } catch (e: any) {
      console.error(e);
      setStatusError(e?.message ?? 'Could not change that student’s status.');
    }
    finally { setStatusLoadingId(null); }
  };

  const handleDelete = async () => {
    if (!deletingId) return;
    setDeleteLoading(true);
    try {
      const deleteAuthUser = httpsCallable<{ role: 'student'; uid: string }, { ok: boolean }>(
        functions,
        'deleteAuthUser',
      );
      await deleteAuthUser({ role: 'student', uid: deletingId });
      setStudents((prev) => prev.filter((s) => s.id !== deletingId));
      setDeletingId(null);
      setLastSynced(new Date());
    } catch (e: any) {
      // Feature #15 Phase 4b — the caller holds this right, but only in
      // REQUEST mode. That is not a failure, so it must not read as one:
      // fall through to submitting the request rather than showing an error
      // the person can do nothing about. Branching on the error CODE, not
      // on prose, so copy changes never break the flow.
      if (isRequiresApproval(e)) {
        try {
          await submitDeletionRequest('student', deletingId);
          setDeletingId(null);
          setEmailNotice({
            ok: true,
            message: 'Deletion request submitted for approval.',
          });
        } catch (subErr: any) {
          setEmailNotice({
            ok: false,
            message: subErr?.message ?? 'Could not submit the request.',
          });
        }
        setTimeout(() => setEmailNotice(null), 6000);
        setDeleteLoading(false);
        return;
      }
      console.error(e);
      setEmailNotice({ ok: false, message: e?.message ?? 'Failed to delete student.' });
      setTimeout(() => setEmailNotice(null), 6000);
    }
    finally { setDeleteLoading(false); }
  };

  const handleResendCredentials = async (student: Student) => {
    setResendingId(student.id);
    try {
      await sendPasswordResetEmail(auth, student.email);
      setEmailNotice({ ok: true, message: `Password-setup link sent to ${student.email}.` });
    } catch (e: any) {
      setEmailNotice({ ok: false, message: e?.message ?? 'Failed to send email.' });
    } finally {
      setResendingId(null);
      setTimeout(() => setEmailNotice(null), 6000);
    }
  };

  // ── Derived ──────────────────────────────────────────────────────

  const total    = students.length;
  const active   = students.filter((s) => s.status === 'active').length;
  const disabled = students.filter((s) => s.status === 'disabled').length;
  const existingEmails = new Set(students.map((s) => s.email));

  // ── Filter + selection derivations ───────────────────────────────

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return students;
    return students.filter(
      (s) => s.name.toLowerCase().includes(q) || s.email.toLowerCase().includes(q),
    );
  }, [students, search]);

  /**
   * Select-all acts on what is ON SCREEN, never on the whole institute.
   * A checkbox that silently includes rows the filter is hiding is how someone
   * deletes three hundred people they cannot see.
   */
  const visibleIds     = useMemo(() => visible.map((s) => s.id), [visible]);
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

  /**
   * Targets for the bar, resolved from ids to {id, label} against the CURRENT
   * list. Ids that no longer exist are dropped — a row removed by the poll
   * between selection and confirmation is not a record to act on.
   */
  const selectedTargets = useMemo(
    () => students
      .filter((s) => selected.has(s.id))
      .map((s) => ({ id: s.id, label: s.name || s.email })),
    [students, selected],
  );

  // ── Render ───────────────────────────────────────────────────────

  return (
    <>
      {/* Sub-header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-4">
          {!loading && total > 0 && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-3">
              <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                {total} {total === 1 ? 'student' : 'students'}
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

      {/* Email notice */}
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
        role="student"
        targets={selectedTargets}
        onClear={() => setSelected(new Set())}
        onDeleted={(ids) => {
          const gone = new Set(ids);
          setStudents((prev) => prev.filter((s) => !gone.has(s.id)));
        }}
        onFinished={() => void fetch_(true)}
      />

      {/* Fetch error */}
      {fetchError && (
        <div className="flex items-center gap-2 px-4 py-3 mb-4"
          style={{ background: 'var(--ef-danger-bg)', border: '1px solid var(--ef-danger-border)', borderRadius: 2 }}>
          <AlertTriangle size={12} strokeWidth={1.5} style={{ color: 'var(--ef-danger)' }} />
          <p className="text-xs" style={{ color: 'var(--ef-danger)' }}>{fetchError}</p>
          <button onClick={() => fetch_()} className="ml-auto text-xs"
            style={{ color: 'var(--ef-danger)', textDecoration: 'underline' }}>Retry</button>
        </div>
      )}

      {/* Status-change refusal. Same shape as the fetch error, dismissed
          rather than retried: the reasons this fails are states someone has to
          resolve elsewhere, not transient failures worth pressing again. */}
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

      {/* Table */}
      <div style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderRadius: 3, overflow: 'hidden' }}>
        <table className="w-full" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'var(--ef-canvas-raised)', borderBottom: '1px solid var(--ef-border)' }}>
              <th className="px-5 py-3" style={{ width: 36 }}>
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  // Some-but-not-all reads as a dash rather than as a tick, so
                  // the header never claims a selection wider than it is.
                  ref={(el) => {
                    if (el) el.indeterminate = selectedVisible.length > 0 && !allVisibleSelected;
                  }}
                  onChange={toggleAllVisible}
                  disabled={visibleIds.length === 0}
                  aria-label={allVisibleSelected ? 'Clear selection' : 'Select all shown'}
                  style={{ cursor: visibleIds.length === 0 ? 'default' : 'pointer' }}
                />
              </th>
              {['STUDENT', 'ROLE', 'STATUS', 'PROGRAM / GROUP', 'ENROLLED', ''].map((col, i) => (
                <th key={i} className="text-left px-5 py-3 text-xs"
                  style={{
                    color: 'var(--ef-text-muted)', letterSpacing: '0.08em', fontWeight: 400,
                    width: i === 0 ? '26%' : i === 1 ? '10%' : i === 2 ? '12%' : i === 3 ? '20%' : i === 4 ? '14%' : '14%',
                  }}>
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Keyed skeleton rows to avoid React key warnings */}
            {loading && [0, 1, 2].map((i) => <SkeletonRow key={i} />)}

            {/* A search that matches nothing is not an empty institute, and
                must not offer "add your first student" as the way out. */}
            {!loading && students.length > 0 && visible.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <div className="flex flex-col items-center py-16">
                    <Search size={24} strokeWidth={1} style={{ color: 'var(--ef-border-muted)' }} />
                    <p className="text-xs mt-4" style={{ color: 'var(--ef-text-muted)' }}>
                      No students match “{search}”
                    </p>
                    <button onClick={() => setSearch('')} className="text-xs mt-3"
                      style={{ color: 'var(--ef-text-subtle)', textDecoration: 'underline' }}>
                      Clear search
                    </button>
                  </div>
                </td>
              </tr>
            )}

            {!loading && students.length === 0 && !fetchError && (
              <tr>
                <td colSpan={7}>
                  <div className="flex flex-col items-center py-16">
                    <GraduationCap size={28} strokeWidth={1} style={{ color: 'var(--ef-border-muted)' }} />
                    <p className="text-xs mt-4" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.06em' }}>
                      No students enrolled
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

            {!loading && visible.map((student) => {
              const isConfirmDelete   = deletingId === student.id;
              const isTogglingStatus  = statusLoadingId === student.id;
              const isSelected        = selected.has(student.id);
              return (
                <motion.tr key={student.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }}
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
                      onChange={() => toggleOne(student.id)}
                      aria-label={`Select ${student.name || student.email}`}
                      style={{ cursor: 'pointer' }}
                    />
                  </td>

                  {/* Name + email */}
                  <td className="px-5 py-3.5">
                    <p className="text-sm" style={{ color: 'var(--ef-ink)', lineHeight: 1.4 }}>{student.name}</p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--ef-text-muted)' }}>{student.email}</p>
                  </td>

                  {/* Role */}
                  <td className="px-5 py-3.5">
                    <span className="inline-block text-xs px-2 py-0.5"
                      style={{ background: 'var(--ef-border-subtle)', color: 'var(--ef-text-subtle)', borderRadius: 2, letterSpacing: '0.03em' }}>
                      Student
                    </span>
                  </td>

                  {/* Status */}
                  <td className="px-5 py-3.5">
                    <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5"
                      style={student.status === 'active'
                        ? { background: 'var(--ef-success-bg-alt)', color: 'var(--ef-success)', border: '1px solid var(--ef-success-border-alt)', borderRadius: 2 }
                        : { background: 'var(--ef-track)', color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
                      <span style={{
                        width: 5, height: 5, borderRadius: '50%', display: 'inline-block', flexShrink: 0,
                        background: student.status === 'active' ? 'var(--ef-success)' : 'var(--ef-text-muted)',
                      }} />
                      {student.status === 'active' ? 'Active' : 'Disabled'}
                    </span>
                  </td>

                  {/* Program / Group metadata */}
                  <td className="px-5 py-3.5">
                    <div className="flex flex-col gap-1">
                      {(student.program?.length ?? 0) > 0 && (
                        <MetaPills values={student.program} />
                      )}
                      {(student.group?.length ?? 0) > 0 && (
                        <MetaPills values={student.group} />
                      )}
                      {!(student.program?.length ?? 0) && !(student.group?.length ?? 0) && (
                        <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>—</span>
                      )}
                    </div>
                  </td>

                  {/* Enrolled date */}
                  <td className="px-5 py-3.5">
                    <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{formatDate(student.createdAt)}</p>
                    {student.firstLoginRequired && (
                      <p className="text-xs mt-0.5" style={{ color: 'var(--ef-text-muted)', fontStyle: 'italic' }}>Awaiting login</p>
                    )}
                  </td>

                  {/* Actions */}
                  <td className="px-5 py-3.5">
                    {isConfirmDelete ? (
                      <div className="flex flex-col items-end gap-2">
                        {/* Feature #15 Phase 1 — live dependency counts before
                            a destructive click. Informational only: the panel
                            never disables Confirm, so the rights model (Phase
                            3) stays the single place that decides permission. */}
                        <div style={{ minWidth: 260, textAlign: 'left', width: '100%' }}>
                          <DeletionImpactPanel entityType="student" entityId={student.id} />
                          {/* Feature #15 Phase 7a — what STRATUM holds
                              about this person. Read-only; sits here
                              because the moment you are about to remove
                              someone is when you are most likely to be
                              answering for what was kept. */}
                          <div className="mt-2">
                            <SubjectDataPanel role="student" uid={student.id} displayName={student.name} />
                            <div className="mt-2">
                              <LogSubjectRequestButton subjectRole="student" subjectId={student.id} />
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center justify-end gap-2">
                        <span className="text-xs" style={{ color: 'var(--ef-danger)' }}>Remove?</span>
                        <button onClick={handleDelete} disabled={deleteLoading}
                          className="flex items-center gap-1 text-xs px-2 py-1"
                          style={{ background: 'var(--ef-danger)', color: 'var(--ef-surface)', borderRadius: 2 }}>
                          {deleteLoading ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} strokeWidth={2} />}
                          Confirm
                        </button>
                        <button onClick={() => setDeletingId(null)} disabled={deleteLoading}
                          className="text-xs px-2 py-1"
                          style={{ color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
                          Cancel
                        </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-end gap-0.5">
                        <button
                          onClick={() => handleResendCredentials(student)}
                          disabled={resendingId === student.id}
                          title="Resend password-setup link"
                          className="p-2 rounded transition-all"
                          style={{ color: 'var(--ef-text-muted)', cursor: resendingId === student.id ? 'not-allowed' : 'pointer' }}
                          onMouseEnter={(e) => { if (resendingId !== student.id) (e.currentTarget as HTMLElement).style.color = 'var(--ef-text-subtle)'; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)'; }}>
                          {resendingId === student.id
                            ? <Loader2 size={13} strokeWidth={1.5} className="animate-spin" />
                            : <Mail size={13} strokeWidth={1.5} />}
                        </button>
                        <button
                          onClick={() => handleToggleStatus(student.id)}
                          disabled={isTogglingStatus}
                          title={student.status === 'active' ? 'Disable student' : 'Enable student'}
                          className="p-2 rounded transition-all"
                          style={{ color: 'var(--ef-text-muted)', cursor: isTogglingStatus ? 'not-allowed' : 'pointer' }}
                          onMouseEnter={(e) => { if (!isTogglingStatus) (e.currentTarget as HTMLElement).style.color = 'var(--ef-text-subtle)'; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)'; }}>
                          {isTogglingStatus
                            ? <Loader2 size={13} strokeWidth={1.5} className="animate-spin" />
                            : student.status === 'active'
                            ? <PauseCircle size={13} strokeWidth={1.5} />
                            : <PlayCircle size={13} strokeWidth={1.5} />}
                        </button>
                        <button
                          onClick={() => setDeletingId(student.id)}
                          title="Remove student"
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

      {!loading && total > 0 && (
        <p className="text-xs mt-3" style={{ color: 'var(--ef-text-muted)' }}>
          Data refreshes automatically every 5 seconds.
        </p>
      )}

      <AddStudentDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onCreated={handleCreated}
        instituteId={instituteId}
        instituteName={instituteName}
      />
      <BulkStudentModal
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