import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  GraduationCap, Plus, Upload, Loader2, PauseCircle, PlayCircle,
  Trash2, AlertTriangle, X, Mail, MailX, Check,
} from 'lucide-react';
import { AddStudentDrawer, type Student } from './AddStudentDrawer';
import { BulkStudentModal } from './BulkStudentModal';
import {
  getStudentsByInstitute,
  getStudent,
  setStudent
} from '../../../lib/firebaseService';
import { httpsCallable } from 'firebase/functions';
import { sendPasswordResetEmail } from 'firebase/auth';
import { auth, functions } from '../../../lib/firebase';
import { DeletionImpactPanel } from '../DeletionImpactPanel';
import { SubjectDataPanel } from '../SubjectDataPanel';
import { LogSubjectRequestButton } from '../LogSubjectRequestButton';
import { isRequiresApproval, submitDeletionRequest } from '../../../lib/deletionRequestService';

function formatDate(value: unknown): string {
  if (!value) return '—';
  const d =
    typeof value === 'object' && value !== null && 'toDate' in value
      ? (value as { toDate: () => Date }).toDate()
      : new Date(value as string);
  return isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function formatSyncAge(d: Date) {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

// Multi-value metadata pills
function MetaPills({ values }: { values?: string[] }) {
  if (!values?.length) return <span style={{ color: '#C4C3BD' }}>—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {values.map((v, i) => (
        <span key={i} className="text-xs px-1.5 py-0.5"
          style={{ background: '#F0EFEB', color: '#4A4A45', borderRadius: 2 }}>
          {v}
        </span>
      ))}
    </div>
  );
}

function SkeletonRow() {
  return (
    <tr style={{ borderBottom: '1px solid #F0EFEB' }}>
      {[32, 14, 16, 24, 0].map((w, i) => (
        <td key={i} className="px-5 py-4">
          {w > 0 && <div className="h-3 rounded mb-1" style={{ width: `${w * 4}px`, background: '#EEECEA', animation: 'pulse 1.5s ease-in-out infinite' }} />}
          {i < 2 && <div className="h-2.5 w-16 rounded mt-1" style={{ background: '#F3F2EF', animation: 'pulse 1.5s ease-in-out infinite' }} />}
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
  const [resendingId, setResendingId]       = useState<string | null>(null);

  const [emailNotice, setEmailNotice] = useState<{ ok: boolean; message: string } | null>(null);

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
    try {
      const data = await getStudent(id);
      const updatedStudent = { ...data, status: data.status === 'active' ? 'disabled' : 'active' };
      await setStudent(id, updatedStudent);
      setStudents((prev) => prev.map((s) => s.id === id ? updatedStudent : s));
      setLastSynced(new Date());
    } catch (e: any) { console.error(e); }
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

  // ── Render ───────────────────────────────────────────────────────

  return (
    <>
      {/* Sub-header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-4">
          {!loading && total > 0 && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-3">
              <span className="text-xs" style={{ color: '#9A9891' }}>
                {total} {total === 1 ? 'student' : 'students'}
              </span>
              <span style={{ color: '#E3E1DB' }}>·</span>
              <span className="text-xs" style={{ color: '#2A6B3A' }}>{active} active</span>
              {disabled > 0 && (
                <>
                  <span style={{ color: '#E3E1DB' }}>·</span>
                  <span className="text-xs" style={{ color: '#9A9891' }}>{disabled} disabled</span>
                </>
              )}
            </motion.div>
          )}
          {lastSynced && (
            <div className="flex items-center gap-1.5 select-none">
              <div className="relative w-2 h-2 flex items-center justify-center">
                <span className="absolute inline-flex w-2 h-2 rounded-full opacity-60"
                  style={{ background: '#2A6B3A', animation: 'ping 1.8s cubic-bezier(0,0,0.2,1) infinite' }} />
                <span className="relative inline-flex w-1.5 h-1.5 rounded-full" style={{ background: '#2A6B3A' }} />
              </div>
              <span className="text-xs" style={{ color: '#C4C3BD' }}>{syncDisplay}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button onClick={() => setBulkOpen(true)}
            className="flex items-center gap-1.5 text-xs px-3 py-2 transition-colors"
            style={{ border: '1px solid #E3E1DB', color: '#4A4A45', borderRadius: 2, background: '#FFFFFF' }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.borderColor = '#0C0C0B')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.borderColor = '#E3E1DB')}>
            <Upload size={11} strokeWidth={1.5} />Add in Bulk
          </button>
          <button onClick={() => setDrawerOpen(true)}
            className="flex items-center gap-1.5 text-xs px-3 py-2 transition-opacity"
            style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, letterSpacing: '0.03em' }}
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
              background: emailNotice.ok ? '#F0F7F2' : '#FDF5F5',
              border: `1px solid ${emailNotice.ok ? '#C6DECE' : '#F2CECE'}`,
              borderRadius: 2,
            }}>
            {emailNotice.ok
              ? <Mail size={12} strokeWidth={1.5} style={{ color: '#2A6B3A', flexShrink: 0 }} />
              : <MailX size={12} strokeWidth={1.5} style={{ color: '#9B2828', flexShrink: 0 }} />}
            <p className="text-xs flex-1" style={{ color: emailNotice.ok ? '#2A6B3A' : '#9B2828' }}>
              {emailNotice.message}
            </p>
            <button onClick={() => setEmailNotice(null)} style={{ color: '#C4C3BD' }}>
              <X size={11} strokeWidth={1.5} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Fetch error */}
      {fetchError && (
        <div className="flex items-center gap-2 px-4 py-3 mb-4"
          style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2 }}>
          <AlertTriangle size={12} strokeWidth={1.5} style={{ color: '#9B2828' }} />
          <p className="text-xs" style={{ color: '#9B2828' }}>{fetchError}</p>
          <button onClick={() => fetch_()} className="ml-auto text-xs"
            style={{ color: '#9B2828', textDecoration: 'underline' }}>Retry</button>
        </div>
      )}

      {/* Table */}
      <div style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3, overflow: 'hidden' }}>
        <table className="w-full" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#FAFAF8', borderBottom: '1px solid #E3E1DB' }}>
              {['STUDENT', 'ROLE', 'STATUS', 'PROGRAM / GROUP', 'ENROLLED', ''].map((col, i) => (
                <th key={i} className="text-left px-5 py-3 text-xs"
                  style={{
                    color: '#9A9891', letterSpacing: '0.08em', fontWeight: 400,
                    width: i === 0 ? '28%' : i === 1 ? '10%' : i === 2 ? '12%' : i === 3 ? '22%' : i === 4 ? '14%' : '14%',
                  }}>
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Keyed skeleton rows to avoid React key warnings */}
            {loading && [0, 1, 2].map((i) => <SkeletonRow key={i} />)}

            {!loading && students.length === 0 && !fetchError && (
              <tr>
                <td colSpan={6}>
                  <div className="flex flex-col items-center py-16">
                    <GraduationCap size={28} strokeWidth={1} style={{ color: '#DDDBD5' }} />
                    <p className="text-xs mt-4" style={{ color: '#C4C3BD', letterSpacing: '0.06em' }}>
                      No students enrolled
                    </p>
                    <p className="text-xs mt-1" style={{ color: '#DDDBD5' }}>
                      Begin onboarding to grant access.
                    </p>
                    <div className="flex items-center gap-2 mt-6">
                      <button onClick={() => setDrawerOpen(true)}
                        className="flex items-center gap-1.5 text-xs px-3 py-2"
                        style={{ border: '1px solid #E3E1DB', color: '#4A4A45', borderRadius: 2, background: '#FFFFFF' }}
                        onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.borderColor = '#0C0C0B')}
                        onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.borderColor = '#E3E1DB')}>
                        <Plus size={11} strokeWidth={2} />Add Single
                      </button>
                      <button onClick={() => setBulkOpen(true)}
                        className="flex items-center gap-1.5 text-xs px-3 py-2"
                        style={{ border: '1px solid #E3E1DB', color: '#4A4A45', borderRadius: 2, background: '#FFFFFF' }}
                        onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.borderColor = '#0C0C0B')}
                        onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.borderColor = '#E3E1DB')}>
                        <Upload size={11} strokeWidth={1.5} />Add in Bulk
                      </button>
                    </div>
                  </div>
                </td>
              </tr>
            )}

            {!loading && students.map((student) => {
              const isConfirmDelete   = deletingId === student.id;
              const isTogglingStatus  = statusLoadingId === student.id;
              return (
                <motion.tr key={student.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                  style={{
                    borderBottom: '1px solid #F0EFEB',
                    background: isConfirmDelete ? '#FDF5F5' : 'transparent',
                    transition: 'background 0.15s',
                  }}>

                  {/* Name + email */}
                  <td className="px-5 py-3.5">
                    <p className="text-sm" style={{ color: '#0C0C0B', lineHeight: 1.4 }}>{student.name}</p>
                    <p className="text-xs mt-0.5" style={{ color: '#9A9891' }}>{student.email}</p>
                  </td>

                  {/* Role */}
                  <td className="px-5 py-3.5">
                    <span className="inline-block text-xs px-2 py-0.5"
                      style={{ background: '#F0EFEB', color: '#4A4A45', borderRadius: 2, letterSpacing: '0.03em' }}>
                      Student
                    </span>
                  </td>

                  {/* Status */}
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
                        <span className="text-xs" style={{ color: '#C4C3BD' }}>—</span>
                      )}
                    </div>
                  </td>

                  {/* Enrolled date */}
                  <td className="px-5 py-3.5">
                    <p className="text-xs" style={{ color: '#9A9891' }}>{formatDate(student.createdAt)}</p>
                    {student.firstLoginRequired && (
                      <p className="text-xs mt-0.5" style={{ color: '#B0AEA8', fontStyle: 'italic' }}>Awaiting login</p>
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
                        <span className="text-xs" style={{ color: '#9B2828' }}>Remove?</span>
                        <button onClick={handleDelete} disabled={deleteLoading}
                          className="flex items-center gap-1 text-xs px-2 py-1"
                          style={{ background: '#9B2828', color: '#FFFFFF', borderRadius: 2 }}>
                          {deleteLoading ? <Loader2 size={10} className="animate-spin" /> : <Check size={10} strokeWidth={2} />}
                          Confirm
                        </button>
                        <button onClick={() => setDeletingId(null)} disabled={deleteLoading}
                          className="text-xs px-2 py-1"
                          style={{ color: '#9A9891', border: '1px solid #E3E1DB', borderRadius: 2 }}>
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
                          style={{ color: '#C4C3BD', cursor: resendingId === student.id ? 'not-allowed' : 'pointer' }}
                          onMouseEnter={(e) => { if (resendingId !== student.id) (e.currentTarget as HTMLElement).style.color = '#4A4A45'; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#C4C3BD'; }}>
                          {resendingId === student.id
                            ? <Loader2 size={13} strokeWidth={1.5} className="animate-spin" />
                            : <Mail size={13} strokeWidth={1.5} />}
                        </button>
                        <button
                          onClick={() => handleToggleStatus(student.id)}
                          disabled={isTogglingStatus}
                          title={student.status === 'active' ? 'Disable student' : 'Enable student'}
                          className="p-2 rounded transition-all"
                          style={{ color: '#C4C3BD', cursor: isTogglingStatus ? 'not-allowed' : 'pointer' }}
                          onMouseEnter={(e) => { if (!isTogglingStatus) (e.currentTarget as HTMLElement).style.color = '#4A4A45'; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#C4C3BD'; }}>
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
                          style={{ color: '#C4C3BD' }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#9B2828'; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#C4C3BD'; }}>
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
        <p className="text-xs mt-3" style={{ color: '#C4C3BD' }}>
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