/**
 * The platform-wide question pool.
 *
 * The list itself is QuestionBankCore, which loads its own copy; this page is
 * the frame around it — the counts, the tabs, and the two modals that act on
 * the whole pool.
 *
 * ── THE TWO TABS THAT ARE NOT BUILT YET ───────────────────────────
 * Banks and Grants have data (both are counted above) and no interface. They
 * used to render "BANKS — COMING IN STEP 4" over a numbered square, which
 * published this project's internal build order to the person paying for the
 * product. They are still here — hiding them would leave two counts of
 * things you cannot look at — but they now say what the feature is and that
 * it is not ready, in the words someone outside the project would use.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { BookOpen, Download, Library, Plus, Share2, Upload } from 'lucide-react';
import {
  getAllQuestions, getAllQuestionBanks, getAllBankGrants,
  type Question,
} from '../../lib/questionBankService';
import { getAllSubjects, type Subject } from '../../lib/subjectService';
import { BulkUploadModal } from '../components/questions/BulkUploadModal';
import { ExportModal } from '../components/questions/ExportModal';
import { SubjectManager } from '../components/questions/SubjectManager';
import { QuestionBankCore, type QuestionBankCoreHandle } from '../components/questions/QuestionBankCore';
import {
  Button, Card, PageHeader, PageShell, SectionHeading, StatRow, StatTile,
} from '../components/console/ui';
import { Tabs } from '../components/console/data';

type Tab = 'pool' | 'banks' | 'grants' | 'subjects';

/** A feature with data behind it and no screen yet. */
function NotBuiltYet({ title, body }: { title: string; body: string }) {
  return (
    <Card variant="inset" className="text-center" style={{ padding: '56px 24px' }}>
      <p className="ef-eyebrow" style={{ justifyContent: 'center' }}>
        Not built yet
      </p>
      <p className="ef-display ef-ink" style={{ fontSize: 16, marginTop: 12 }}>
        {title}
      </p>
      <p
        className="ef-t-sm ef-muted"
        style={{ marginTop: 8, lineHeight: 'var(--ef-leading-relaxed)', maxWidth: 420, marginInline: 'auto' }}
      >
        {body}
      </p>
    </Card>
  );
}

export function QuestionsPage() {
  // Page-level data for the stat tiles + Export modal (the question list
  // itself lives inside QuestionBankCore, which loads its own copy).
  const [questions, setQuestions] = useState<Question[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [bankCount, setBankCount] = useState<number | null>(null);
  const [grantCount, setGrantCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const [tab, setTab] = useState<Tab>('pool');
  const [bulkUploadOpen, setBulkUploadOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

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

  const num = (v: number | null) => (v === null ? '—' : v);

  return (
    <PageShell>
      <PageHeader
        eyebrow={
          <>
            <span className="ef-eyebrow-dot" />
            Web owner
          </>
        }
        title="Questions"
        subtitle="The platform's own pool. Write questions here, gather them into banks, and grant institutes access to them."
        actions={
          <>
            <Button size="sm" onClick={() => setExportOpen(true)}>
              <Download size={12} strokeWidth={1.7} />
              Export
            </Button>
            <Button size="sm" onClick={() => setBulkUploadOpen(true)}>
              <Upload size={12} strokeWidth={1.7} />
              Bulk upload
            </Button>
            <Button size="sm" variant="primary" onClick={() => coreRef.current?.openCreate()}>
              <Plus size={12} strokeWidth={1.9} />
              Add question
            </Button>
          </>
        }
      />

      <div style={{ marginBottom: 26 }}>
        <StatRow>
          <StatTile
            label="Questions"
            value={loading ? '—' : questions.length}
            icon={<BookOpen size={13} strokeWidth={1.7} />}
            sub="in the platform pool"
            hint="Written by the platform, not by any institute."
          />
          <StatTile
            label="Banks"
            value={num(bankCount)}
            icon={<Library size={13} strokeWidth={1.7} />}
            sub="named collections"
            hint="A question can sit in more than one bank."
          />
          <StatTile
            label="Active grants"
            value={num(grantCount)}
            icon={<Share2 size={13} strokeWidth={1.7} />}
            sub="institutes with access"
            hint="Each grant is frozen at the moment it was made — later edits do not reach it."
          />
        </StatRow>
      </div>

      <Tabs
        items={[
          { key: 'pool', label: 'Question pool', count: loading ? undefined : questions.length },
          { key: 'banks', label: 'Banks' },
          { key: 'grants', label: 'Grants' },
          { key: 'subjects', label: 'Subjects', count: loading ? undefined : subjects.length },
        ]}
        active={tab}
        onChange={(k) => setTab(k as Tab)}
        label="Question bank sections"
      />

      <div style={{ marginTop: 'var(--ef-gap)' }}>
        {tab === 'pool' && <QuestionBankCore ref={coreRef} onChanged={() => fetchAll(true)} />}

        {tab === 'banks' && (
          <NotBuiltYet
            title="Question banks"
            body="A bank is a named collection you can grant as a unit — a syllabus, a mock paper, a year's worth of practice. The data exists; the screen for curating them does not yet."
          />
        )}

        {tab === 'grants' && (
          <NotBuiltYet
            title="Access grants"
            body="A grant gives one institute access to a bank or a set of questions, frozen at the moment you make it, so later edits never change an exam somebody has already built."
          />
        )}

        {tab === 'subjects' && (
          <>
            <SectionHeading
              label="Subject registry"
              description="The canonical names every question is tagged with. Aliases let a bulk upload that says QUANT or Maths resolve to the right subject on its own; Merge permanently consolidates two subjects that turned out to be one."
            />
            <SubjectManager />
          </>
        )}
      </div>

      {bulkUploadOpen && (
        <BulkUploadModal
          onClose={() => setBulkUploadOpen(false)}
          onComplete={() => { setBulkUploadOpen(false); fetchAll(true); }}
        />
      )}

      {exportOpen && (
        <ExportModal questions={questions} subjects={subjects} onClose={() => setExportOpen(false)} />
      )}
    </PageShell>
  );
}
