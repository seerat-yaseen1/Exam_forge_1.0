import React, { useState, useCallback, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Users, Plus, Upload, Loader2, PauseCircle, PlayCircle,
  Trash2, AlertTriangle, X, Mail, MailX, Check, Shield, ShieldCheck,
  GraduationCap,
} from 'lucide-react';
import { AddFacultyDrawer, type Faculty } from './AddFacultyDrawer';
import { BulkFacultyModal } from './BulkFacultyModal';
import {
  getFacultyByInstitute,
  getFaculty,
  setFaculty,
  setFacultySchoolsPermission,
  setFacultyCreateStudentsPermission,
  setFacultyManageRostersPermission,
} from '../../../lib/firebaseService';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../../../lib/firebase';

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function SkeletonRow() {
  return (
    <tr style={{ borderBottom: '1px solid #F0EFEB' }}>
      {[32, 48, 16, 20, 0].map((w, i) => (
        <td key={i} className="px-5 py-4">
          {w > 0 && <div className="h-3 rounded mb-1" style={{ width: `${w * 4}px`, background: '#EEECEA', animation: 'pulse 1.5s ease-in-out infinite' }} />}
          {i < 2 && <div className="h-2.5 w-20 rounded mt-1" style={{ background: '#F3F2EF', animation: 'pulse 1.5s ease-in-out infinite' }} />}
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
}

export function FacultyTab({
  instituteId,
  instituteName,
  instituteSchoolsEnabled = false,
  instituteFacultyCreateStudentsEnabled = false,
  instituteFacultyManageRostersEnabled = false,
}: Props) {
  const [faculties, setFaculties]     = useState<Faculty[]>([]);
  const [loading, setLoading]         = useState(true);
  const [fetchError, setFetchError]   = useState('');
  const [lastSynced, setLastSynced]   = useState<Date | null>(null);
  const [syncDisplay, setSyncDisplay] = useState('');

  // Drawers / modals
  const [drawerOpen, setDrawerOpen]   = useState(false);
  const [bulkOpen, setBulkOpen]       = useState(false);

  // Per-row state
  const [deletingId, setDeletingId]         = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading]   = useState(false);
  const [statusLoadingId, setStatusLoadingId] = useState<string | null>(null);
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
    try {
      const faculty = await getFaculty(id);
      if (!faculty) throw new Error('Faculty not found');
      
      const newStatus = faculty.status === 'active' ? 'disabled' : 'active';
      const updated: Faculty = {
        ...faculty,
        status: newStatus,
        updatedAt: new Date().toISOString(),
      };
      
      await setFaculty(id, updated);
      setFaculties((prev) => prev.map((f) => f.id === id ? updated : f));
      setLastSynced(new Date());
    } catch (e: any) { 
      console.error('Toggle status failed:', e);
    } finally { 
      setStatusLoadingId(null);
    }
  };

  const handleDelete = async () => {
    if (!deletingId) return;
    setDeleteLoading(true);
    try {
      const deleteAuthUser = httpsCallable<{ role: string; uid: string }, { ok: boolean }>(
        functions,
        'deleteAuthUser'
      );
      await deleteAuthUser({ role: 'faculty', uid: deletingId });
      setFaculties((prev) => prev.filter((f) => f.id !== deletingId));
      setDeletingId(null);
      setLastSynced(new Date());
    } catch (e: any) {
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

  // ── Render ───────────────────────────────────────────────────────

  return (
    <>
      {/* ── Sub-header ── */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-4">
          {!loading && total > 0 && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex items-center gap-3">
              <span className="text-xs" style={{ color: '#9A9891' }}>
                {total} {total === 1 ? 'member' : 'members'}
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
          {/* Live indicator */}
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

      {/* ── Email notice ── */}
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

      {/* ── Fetch error ── */}
      {fetchError && (
        <div className="flex items-center gap-2 px-4 py-3 mb-4"
          style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2 }}>
          <AlertTriangle size={12} strokeWidth={1.5} style={{ color: '#9B2828' }} />
          <p className="text-xs" style={{ color: '#9B2828' }}>{fetchError}</p>
          <button onClick={() => fetch_()} className="ml-auto text-xs"
            style={{ color: '#9B2828', textDecoration: 'underline' }}>Retry</button>
        </div>
      )}

      {/* ── Table ── */}
      <div style={{ background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3, overflow: 'hidden' }}>
        <table className="w-full" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#FAFAF8', borderBottom: '1px solid #E3E1DB' }}>
              {['FACULTY', 'ROLE', 'STATUS', 'GRANTED', 'SCHOOLS', 'STU. CREATE', 'ROSTER', ''].map((col, i) => (
                <th key={i} className="text-left px-5 py-3 text-xs"
                  style={{
                    color: '#9A9891', letterSpacing: '0.08em', fontWeight: 400,
                    width: i === 0 ? '24%' : i === 1 ? '9%' : i === 2 ? '9%' : i === 3 ? '10%' : i === 4 ? '9%' : i === 5 ? '10%' : i === 6 ? '9%' : '20%',
                  }}>
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && <><SkeletonRow /><SkeletonRow /><SkeletonRow /></>}

            {!loading && faculties.length === 0 && !fetchError && (
              <tr>
                <td colSpan={6}>
                  <div className="flex flex-col items-center py-16">
                    <Users size={28} strokeWidth={1} style={{ color: '#DDDBD5' }} />
                    <p className="text-xs mt-4" style={{ color: '#C4C3BD', letterSpacing: '0.06em' }}>
                      No faculty registered
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

            {!loading && faculties.map((faculty) => {
              const isConfirmDelete = deletingId === faculty.id;
              const isTogglingStatus = statusLoadingId === faculty.id;
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
                    borderBottom: '1px solid #F0EFEB',
                    background: isConfirmDelete ? '#FDF5F5' : 'transparent',
                    transition: 'background 0.15s',
                  }}>
                  {/* Faculty name + email */}
                  <td className="px-5 py-3.5">
                    <p className="text-sm" style={{ color: '#0C0C0B', lineHeight: 1.4 }}>{faculty.name}</p>
                    <p className="text-xs mt-0.5" style={{ color: '#9A9891' }}>{faculty.email}</p>
                  </td>

                  {/* Role badge */}
                  <td className="px-5 py-3.5">
                    <span className="inline-block text-xs px-2 py-0.5"
                      style={{ background: '#F0EFEB', color: '#4A4A45', borderRadius: 2, letterSpacing: '0.03em' }}>
                      Faculty
                    </span>
                  </td>

                  {/* Status badge */}
                  <td className="px-5 py-3.5">
                    <span className="inline-flex items-center gap-1.5 text-xs px-2 py-0.5"
                      style={faculty.status === 'active'
                        ? { background: '#F0F7F2', color: '#2A6B3A', border: '1px solid #C6DECE', borderRadius: 2 }
                        : { background: '#F5F5F3', color: '#9A9891', border: '1px solid #E3E1DB', borderRadius: 2 }}>
                      <span style={{
                        width: 5, height: 5, borderRadius: '50%',
                        background: faculty.status === 'active' ? '#2A6B3A' : '#C4C3BD',
                        display: 'inline-block', flexShrink: 0,
                      }} />
                      {faculty.status === 'active' ? 'Active' : 'Disabled'}
                    </span>
                  </td>

                  {/* Created */}
                  <td className="px-5 py-3.5">
                    <p className="text-xs" style={{ color: '#9A9891' }}>{formatDate(faculty.createdAt)}</p>
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
                        <Loader2 size={12} strokeWidth={1.5} className="animate-spin" style={{ color: '#C4C3BD' }} />
                      ) : schoolsEnabled ? (
                        <ShieldCheck size={13} strokeWidth={1.5} style={{ color: '#2A6B3A' }} />
                      ) : (
                        <Shield size={13} strokeWidth={1.5} style={{ color: '#C4C3BD' }} />
                      )}
                      <span style={{ color: schoolsEnabled && canToggleSchools ? '#2A6B3A' : '#C4C3BD' }}>
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
                        <Loader2 size={12} strokeWidth={1.5} className="animate-spin" style={{ color: '#C4C3BD' }} />
                      ) : createStudentsEnabled ? (
                        <GraduationCap size={13} strokeWidth={1.5} style={{ color: '#2A6B3A' }} />
                      ) : (
                        <GraduationCap size={13} strokeWidth={1.5} style={{ color: '#C4C3BD' }} />
                      )}
                      <span style={{ color: createStudentsEnabled && canToggleStudents ? '#2A6B3A' : '#C4C3BD' }}>
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
                        <Loader2 size={12} strokeWidth={1.5} className="animate-spin" style={{ color: '#C4C3BD' }} />
                      ) : (
                        <Shield size={13} strokeWidth={1.5} style={{ color: manageRostersEnabled && canToggleRosters ? '#2A6B3A' : '#C4C3BD' }} />
                      )}
                      <span style={{ color: manageRostersEnabled && canToggleRosters ? '#2A6B3A' : '#C4C3BD' }}>
                        {manageRostersEnabled ? 'On' : 'Off'}
                      </span>
                    </button>
                  </td>

                  {/* Actions */}
                  <td className="px-5 py-3.5">
                    {isConfirmDelete ? (
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
                    ) : (
                      <div className="flex items-center justify-end gap-0.5">
                        {/* Toggle status */}
                        <button
                          onClick={() => handleToggleStatus(faculty.id)}
                          disabled={isTogglingStatus}
                          title={faculty.status === 'active' ? 'Disable faculty' : 'Enable faculty'}
                          className="p-2 rounded transition-all"
                          style={{ color: '#C4C3BD', cursor: isTogglingStatus ? 'not-allowed' : 'pointer' }}
                          onMouseEnter={(e) => { if (!isTogglingStatus) (e.currentTarget as HTMLElement).style.color = '#4A4A45'; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#C4C3BD'; }}>
                          {isTogglingStatus
                            ? <Loader2 size={13} strokeWidth={1.5} className="animate-spin" />
                            : faculty.status === 'active'
                            ? <PauseCircle size={13} strokeWidth={1.5} />
                            : <PlayCircle size={13} strokeWidth={1.5} />}
                        </button>

                        {/* Delete */}
                        <button
                          onClick={() => setDeletingId(faculty.id)}
                          title="Remove faculty member"
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