import { useState, useEffect } from 'react';
import { useStudentAuth } from '../../context/StudentAuthContext';
import { getMappingsByStudent, type AcademicMapping, NODE_LEVEL_LABELS } from '../../../lib/firebaseService';
import { ChevronDown, ChevronRight, BookOpen, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// ── Academic Structure section ────────────────────────────────────

function AcademicStructure({ studentId }: { studentId: string }) {
  const [mappings, setMappings] = useState<AcademicMapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    getMappingsByStudent(studentId)
      .then(setMappings)
      .finally(() => setLoading(false));
  }, [studentId]);

  if (loading) {
    return (
      <div className="bg-white p-6 mt-6" style={{ border: '1px solid #E3E1DB', borderRadius: 2 }}>
        <p className="text-xs mb-4" style={{ color: '#6B6B66', letterSpacing: '0.08em' }}>ACADEMIC STRUCTURE</p>
        <div className="flex items-center gap-2">
          <Loader2 size={14} strokeWidth={1} className="animate-spin" style={{ color: '#6B6B66' }} />
          <span className="text-xs" style={{ color: '#6B6B66' }}>Loading assignments…</span>
        </div>
      </div>
    );
  }

  if (mappings.length === 0) return null;

  // Group by school name (top-level hierarchy grouping via breadcrumb prefix)
  const grouped = new Map<string, AcademicMapping[]>();
  mappings.forEach((m) => {
    const parts = m.breadcrumb.split(' › ');
    // parts[0] = instituteName, parts[1] = school name (if present)
    const schoolKey = parts[1] ?? 'Unclassified';
    if (!grouped.has(schoolKey)) grouped.set(schoolKey, []);
    grouped.get(schoolKey)!.push(m);
  });

  return (
    <div className="bg-white mt-6" style={{ border: '1px solid #E3E1DB', borderRadius: 2 }}>
      {/* Section header */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-6 py-4 select-none"
        style={{ borderBottom: expanded ? '1px solid #E3E1DB' : 'none' }}
      >
        <div className="flex items-center gap-2">
          <BookOpen size={13} strokeWidth={1.5} style={{ color: '#6B6B66' }} />
          <p className="text-xs" style={{ color: '#6B6B66', letterSpacing: '0.08em' }}>
            ACADEMIC STRUCTURE
          </p>
          <span className="text-xs px-1.5 py-0.5" style={{ background: '#F0EFEB', color: '#6B6B66', borderRadius: 10 }}>
            {mappings.length}
          </span>
        </div>
        {expanded
          ? <ChevronDown size={13} strokeWidth={1.5} style={{ color: '#6B6B66' }} />
          : <ChevronRight size={13} strokeWidth={1.5} style={{ color: '#6B6B66' }} />}
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            style={{ overflow: 'hidden' }}
          >
            <div className="px-6 py-4 space-y-5">
              {[...grouped.entries()].map(([schoolName, schoolMappings]) => (
                <div key={schoolName}>
                  <p className="text-xs mb-2" style={{ color: '#4A4A45', letterSpacing: '0.04em' }}>
                    {schoolName}
                  </p>
                  <div className="space-y-1.5 pl-3" style={{ borderLeft: '2px solid #F0EFEB' }}>
                    {schoolMappings.map((m) => (
                      <div key={m.id} className="flex items-start gap-2">
                        <span className="text-xs px-1.5 py-0.5 mt-0.5 flex-shrink-0"
                          style={{ background: '#F0EFEB', color: '#6B6B66', borderRadius: 2 }}>
                          {NODE_LEVEL_LABELS[m.nodeType]}
                        </span>
                        <div>
                          <p className="text-xs" style={{ color: '#0C0C0B' }}>{m.nodeName}</p>
                          <p className="text-xs mt-0.5 break-all" style={{ color: '#6B6B66' }}>{m.breadcrumb}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────

export function StudentProfilePage() {
  const { session } = useStudentAuth();

  if (!session) return null;

  return (
    <div className="max-w-4xl mx-auto px-4 py-8">
      <div className="mb-8">
        <p className="text-xs mb-2" style={{ color: '#6B6B66', letterSpacing: '0.08em' }}>
          PROFILE
        </p>
        <h1 className="text-2xl font-medium" style={{ color: '#0C0C0B' }}>
          {session.name}
        </h1>
        <p className="text-sm mt-1" style={{ color: '#6B6B66' }}>
          Student — {session.instituteName}
        </p>
      </div>

      {/* Basic information */}
      <div className="bg-white p-6 mb-6" style={{ border: '1px solid #E3E1DB', borderRadius: 2 }}>
        <p className="text-xs mb-4" style={{ color: '#6B6B66', letterSpacing: '0.08em' }}>
          BASIC INFORMATION
        </p>
        <div className="grid gap-4">
          <div>
            <p className="text-xs mb-1" style={{ color: '#6B6B66' }}>Full Name</p>
            <p className="text-sm" style={{ color: '#0C0C0B' }}>{session.name}</p>
          </div>
          <div>
            <p className="text-xs mb-1" style={{ color: '#6B6B66' }}>Email Address</p>
            <p className="text-sm" style={{ color: '#0C0C0B' }}>{session.email}</p>
          </div>
          <div>
            <p className="text-xs mb-1" style={{ color: '#6B6B66' }}>Account Status</p>
            <div className="inline-flex items-center gap-1.5 px-2 py-1" style={{
              background: session.status === 'active' ? '#F0F7F2' : '#F7F6F3',
              border: `1px solid ${session.status === 'active' ? '#C6DECE' : '#E3E1DB'}`,
              borderRadius: 2,
            }}>
              <div style={{
                width: 5, height: 5, borderRadius: '50%',
                background: session.status === 'active' ? '#2A6B3A' : '#6B6B66',
              }} />
              <span className="text-xs" style={{
                color: session.status === 'active' ? '#2A6B3A' : '#6B6B66',
                textTransform: 'capitalize',
              }}>
                {session.status}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Institute information */}
      <div className="bg-white p-6 mb-6" style={{ border: '1px solid #E3E1DB', borderRadius: 2 }}>
        <p className="text-xs mb-4" style={{ color: '#6B6B66', letterSpacing: '0.08em' }}>
          INSTITUTE INFORMATION
        </p>
        <div className="grid gap-4">
          <div>
            <p className="text-xs mb-1" style={{ color: '#6B6B66' }}>Institute Name</p>
            <p className="text-sm" style={{ color: '#0C0C0B' }}>{session.instituteName}</p>
          </div>
          <div>
            <p className="text-xs mb-1" style={{ color: '#6B6B66' }}>Institute Code</p>
            <p className="text-sm font-mono" style={{ color: '#4A4A45', letterSpacing: '0.12em' }}>
              {session.instituteCode}
            </p>
          </div>
        </div>
      </div>

      {/* Program metadata — only if any exists */}
      {(session.group?.length || session.section?.length || session.specialisation?.length ||
        session.program?.length || session.degreeLevel?.length || session.school?.length) && (
        <div className="bg-white p-6 mb-6" style={{ border: '1px solid #E3E1DB', borderRadius: 2 }}>
          <p className="text-xs mb-4" style={{ color: '#6B6B66', letterSpacing: '0.08em' }}>
            PROGRAM DETAILS
          </p>
          <div className="grid gap-4">
            {!!session.program?.length && (
              <div>
                <p className="text-xs mb-1" style={{ color: '#6B6B66' }}>Program</p>
                <p className="text-sm" style={{ color: '#0C0C0B' }}>{session.program.join(', ')}</p>
              </div>
            )}
            {!!session.degreeLevel?.length && (
              <div>
                <p className="text-xs mb-1" style={{ color: '#6B6B66' }}>Degree Level</p>
                <p className="text-sm" style={{ color: '#0C0C0B' }}>{session.degreeLevel.join(', ')}</p>
              </div>
            )}
            {!!session.school?.length && (
              <div>
                <p className="text-xs mb-1" style={{ color: '#6B6B66' }}>School</p>
                <p className="text-sm" style={{ color: '#0C0C0B' }}>{session.school.join(', ')}</p>
              </div>
            )}
            {!!session.specialisation?.length && (
              <div>
                <p className="text-xs mb-1" style={{ color: '#6B6B66' }}>Specialisation</p>
                <p className="text-sm" style={{ color: '#0C0C0B' }}>{session.specialisation.join(', ')}</p>
              </div>
            )}
            {!!session.section?.length && (
              <div>
                <p className="text-xs mb-1" style={{ color: '#6B6B66' }}>Section</p>
                <p className="text-sm" style={{ color: '#0C0C0B' }}>{session.section.join(', ')}</p>
              </div>
            )}
            {!!session.group?.length && (
              <div>
                <p className="text-xs mb-1" style={{ color: '#6B6B66' }}>Group</p>
                <p className="text-sm" style={{ color: '#0C0C0B' }}>{session.group.join(', ')}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Academic Structure — live hierarchy mappings */}
      <AcademicStructure studentId={session.studentId} />
    </div>
  );
}