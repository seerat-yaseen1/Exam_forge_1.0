import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Plus, BookOpen, Library, Share2, Upload, Download } from 'lucide-react';
import {
  getAllQuestions, getAllQuestionBanks, getAllBankGrants,
  type Question,
} from '../../lib/questionBankService';
import { getAllSubjects, type Subject } from '../../lib/subjectService';
import { BulkUploadModal } from '../components/questions/BulkUploadModal';
import { ExportModal } from '../components/questions/ExportModal';
import { SubjectManager } from '../components/questions/SubjectManager';
import { QuestionBankCore, type QuestionBankCoreHandle } from '../components/questions/QuestionBankCore';

// ── Stat pill ─────────────────────────────────────────────────────────────────

function StatPill({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div
      className="flex items-center gap-2 md:gap-3 px-3 py-3 md:px-5 md:py-4"
      style={{ border: '1px solid var(--ef-border)', borderRadius: 3, background: 'var(--ef-surface)' }}
    >
      <div
        className="flex items-center justify-center flex-shrink-0"
        style={{ width: 26, height: 26, borderRadius: 2, background: 'var(--ef-canvas)', border: '1px solid #EEECEA' }}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-xs truncate" style={{ color: 'var(--ef-text-muted)' }}>{label}</p>
        <p className="text-sm mt-0.5" style={{ color: 'var(--ef-ink)' }}>{value}</p>
      </div>
    </div>
  );
}

// ── Tab bar ───────────────────────────────────────────────────────────────────

type Tab = 'pool' | 'banks' | 'grants' | 'subjects';

function TabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  const tabs: { id: Tab; label: string }[] = [
    { id: 'pool',     label: 'Question Pool' },
    { id: 'banks',    label: 'Banks'         },
    { id: 'grants',   label: 'Grants'        },
    { id: 'subjects', label: 'Subjects'      },
  ];
  return (
    <div className="flex gap-0" style={{ borderBottom: '1px solid var(--ef-border)', marginBottom: 0 }}>
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className="text-xs px-4 py-2.5 transition-all relative"
          style={{
            color: active === t.id ? 'var(--ef-ink)' : 'var(--ef-text-muted)',
            borderBottom: active === t.id ? '2px solid var(--ef-ink)' : '2px solid transparent',
            letterSpacing: '0.02em',
            marginBottom: -1,
            background: 'transparent',
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ── Stub tab content ──────────────────────────────────────────────────────────

function StubTab({ label, step, description }: { label: string; step: string; description: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-20" style={{ color: 'var(--ef-text-muted)' }}>
      <div
        className="flex items-center justify-center text-xs mb-4 select-none"
        style={{ width: 28, height: 28, borderRadius: 2, background: '#EEECEA', color: 'var(--ef-text-muted)', letterSpacing: '0.04em' }}
      >
        {step}
      </div>
      <p className="text-xs" style={{ letterSpacing: '0.1em' }}>{label}</p>
      <p className="text-xs mt-2" style={{ color: 'var(--ef-text-muted)' }}>{description}</p>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function QuestionsPage() {
  // Page-level data for the stat pills + Export modal (the question list itself
  // lives inside QuestionBankCore, which loads its own copy).
  const [questions,  setQuestions]  = useState<Question[]>([]);
  const [subjects,   setSubjects]   = useState<Subject[]>([]);
  const [bankCount,  setBankCount]  = useState<number | null>(null);
  const [grantCount, setGrantCount] = useState<number | null>(null);
  const [loading,    setLoading]    = useState(true);

  const [activeTab,      setActiveTab]      = useState<Tab>('pool');
  const [bulkUploadOpen, setBulkUploadOpen] = useState(false);
  const [exportOpen,     setExportOpen]     = useState(false);

  const coreRef = useRef<QuestionBankCoreHandle>(null);

  const fetchAll = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [qs, banks, grants, subjs] = await Promise.all([
        getAllQuestions(),
        getAllQuestionBanks(),
        getAllBankGrants(),
        getAllSubjects(),
      ]);
      setQuestions(qs);
      setBankCount(banks.length);
      setGrantCount(grants.filter((g) => !g.isRevoked).length);
      setSubjects(subjs);
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const fmt = (v: number | null) => (v === null ? '…' : String(v));

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        className="px-4 py-6 md:px-8 md:py-10"
        style={{ maxWidth: 1120, margin: '0 auto' }}
      >
        {/* ── Page header ── */}
        <div
          className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between mb-8"
          style={{ borderBottom: '1px solid var(--ef-border)', paddingBottom: 20 }}
        >
          <div>
            <p className="text-xs mb-1" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>WEB OWNER</p>
            <h1 className="text-base" style={{ color: 'var(--ef-ink)' }}>Questions</h1>
            <p className="text-xs mt-1" style={{ color: 'var(--ef-text-muted)' }}>
              Global question pool — upload questions, organise into banks, grant access to institutes.
            </p>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 flex-wrap md:mt-1">
            <button
              onClick={() => setExportOpen(true)}
              className="flex items-center gap-1.5 text-xs px-3 py-2.5 transition-opacity hover:opacity-80"
              style={{ border: '1px solid var(--ef-border)', color: 'var(--ef-text-muted)', borderRadius: 2, background: 'var(--ef-surface)' }}
            >
              <Download size={12} strokeWidth={1.5} /> Export
            </button>

            <button
              onClick={() => setBulkUploadOpen(true)}
              className="flex items-center gap-1.5 text-xs px-3 py-2.5 transition-opacity hover:opacity-80"
              style={{ border: '1px solid var(--ef-border)', color: 'var(--ef-text-muted)', borderRadius: 2, background: 'var(--ef-surface)' }}
            >
              <Upload size={12} strokeWidth={1.5} /> Bulk Upload
            </button>

            <button
              onClick={() => coreRef.current?.openCreate()}
              className="flex items-center gap-1.5 text-xs px-4 py-2.5 transition-opacity hover:opacity-80"
              style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, letterSpacing: '0.03em' }}
            >
              <Plus size={12} strokeWidth={2} /> Add Question
            </button>
          </div>
        </div>

        {/* ── Stat pills ── */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-8">
          <StatPill icon={<BookOpen size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />} label="Total Questions" value={loading ? '…' : fmt(questions.length)} />
          <StatPill icon={<Library size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />} label="Question Banks" value={fmt(bankCount)} />
          <StatPill icon={<Share2 size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />} label="Active Grants" value={fmt(grantCount)} />
        </div>

        {/* ── Tabs ── */}
        <TabBar active={activeTab} onChange={setActiveTab} />

        {/* ── Tab content ── */}
        <div
          className="mt-0"
          style={{ background: 'var(--ef-surface)', border: '1px solid var(--ef-border)', borderTop: 'none', borderRadius: '0 0 3px 3px' }}
        >
          {/* ── QUESTION POOL ── */}
          {activeTab === 'pool' && (
            <QuestionBankCore ref={coreRef} onChanged={() => fetchAll(true)} />
          )}

          {/* ── BANKS (stub) ── */}
          {activeTab === 'banks' && (
            <StubTab label="BANKS — COMING IN STEP 4" step="4" description="Curate named question collections. Questions can belong to multiple banks." />
          )}

          {/* ── GRANTS (stub) ── */}
          {activeTab === 'grants' && (
            <StubTab label="GRANTS — COMING IN STEP 5" step="5" description="Grant bank or question access to institutes. Snapshots are frozen at grant time." />
          )}

          {/* ── SUBJECTS ── */}
          {activeTab === 'subjects' && (
            <div className="px-6 py-6">
              <p className="text-xs mb-1" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>SUBJECT REGISTRY</p>
              <p className="text-xs mb-5" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.7 }}>
                Canonical subject names used across all questions. Add aliases so that bulk uploads using alternate names (e.g. QUANT, Maths) automatically resolve to the correct subject. Use Merge to permanently consolidate two subjects.
              </p>
              <SubjectManager />
            </div>
          )}
        </div>
      </motion.div>

      {/* ── Bulk Upload modal ── */}
      <AnimatePresence>
        {bulkUploadOpen && (
          <BulkUploadModal
            onClose={() => setBulkUploadOpen(false)}
            onComplete={() => { setBulkUploadOpen(false); fetchAll(true); }}
          />
        )}
      </AnimatePresence>

      {/* ── Export modal ── */}
      <AnimatePresence>
        {exportOpen && (
          <ExportModal questions={questions} subjects={subjects} onClose={() => setExportOpen(false)} />
        )}
      </AnimatePresence>
    </>
  );
}
