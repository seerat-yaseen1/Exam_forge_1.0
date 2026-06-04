import { motion } from 'motion/react';
import { X, ArrowLeftRight } from 'lucide-react';
import { type ParsedRow } from './bulkUploadParser';
import { type Question } from '../../../lib/questionBankService';
import { pct } from '../../../lib/duplicateDetection';

interface Props {
  row:   ParsedRow;
  pool:  Question[];
  onClose: () => void;
}

const REASON_LABEL: Record<string, string> = {
  exact_stem:        'Exact match — stems are identical',
  reordered_options: 'Same options (reordered) + same correct answer',
  fuzzy_stem:        'Stems are very similar',
  option_overlap:    'Options overlap significantly',
  none:              'No significant match',
};

export function DuplicateCompareModal({ row, pool, onClose }: Props) {
  const score = row.duplicateScore;
  const matchedId = score?.matchedQuestionId ?? null;
  const matched = matchedId ? pool.find((q) => q.id === matchedId) : null;

  // For the new draft, pull readable copies of stem, options, correct answers
  const draftStem    = row.draft.stem ?? '';
  const draftOptions = (row.draft.options ?? []).map((o: any) => o.text ?? '');
  const draftCorrect = (row.draft.correctIds ?? [])
    .map((cid: string) => (row.draft.options ?? []).find((o: any) => o.id === cid)?.text ?? '')
    .filter(Boolean);

  const matchedStem    = matched?.stem ?? '';
  const matchedOptions = (matched?.options ?? []).map((o: any) => o.text ?? '');
  const matchedCorrect = (matched?.correctIds ?? [])
    .map((cid: string) => (matched?.options ?? []).find((o: any) => o.id === cid)?.text ?? '')
    .filter(Boolean);

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
      style={{ background: 'rgba(12,12,11,0.42)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.97, opacity: 0, y: 6 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.97, opacity: 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="w-full flex flex-col"
        style={{ maxWidth: 920, maxHeight: '88vh', background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3 }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-3.5 sm:py-4 flex-shrink-0" style={{ borderBottom: '1px solid #E3E1DB' }}>
          <div>
            <p className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.1em' }}>DUPLICATE COMPARISON</p>
            <p className="text-sm mt-0.5" style={{ color: '#0C0C0B' }}>
              {score ? REASON_LABEL[score.matchedReason] : 'No match'}
            </p>
          </div>
          <button onClick={onClose} className="p-1 transition-opacity hover:opacity-60" style={{ color: '#9A9891' }}>
            <X size={15} strokeWidth={1.5} />
          </button>
        </div>

        {/* Score strip */}
        {score && (
          <div className="flex items-center gap-6 px-6 py-3 flex-shrink-0" style={{ background: '#FAFAF8', borderBottom: '1px solid #E3E1DB' }}>
            <ScorePill label="Stem similarity"    value={pct(score.stemSim)}    tone={toneFor(score.stemSim)} />
            <ScorePill label="Options similarity" value={pct(score.optionsSim)} tone={toneFor(score.optionsSim)} />
            <ScorePill label="Correct answer"     value={score.answerMatch ? 'Match' : 'Differs'} tone={score.answerMatch ? 'warn' : 'ok'} />
            <div style={{ flex: 1 }} />
            {matchedId && (
              <span className="text-xs" style={{ color: '#9A9891' }}>
                Matched ID: <code style={{ fontFamily: 'monospace', background: '#F0EFEB', padding: '1px 5px', borderRadius: 2 }}>{matchedId}</code>
              </span>
            )}
          </div>
        )}

        {/* Side-by-side */}
        <div className="flex-1 overflow-y-auto grid grid-cols-2 gap-0" style={{ background: '#F7F6F3' }}>
          {/* New (incoming row) */}
          <Side
            heading="NEW (from upload)"
            sheet={`${row.sheet} · row ${row.rowIndex}`}
            stem={draftStem}
            options={draftOptions}
            correct={draftCorrect}
            subject={row.draft.subject ?? ''}
            topic={row.draft.topic ?? ''}
            borderRight
          />

          {/* Matched (existing) */}
          {matched ? (
            <Side
              heading="EXISTING (in pool)"
              sheet={`id: ${matched.id}`}
              stem={matchedStem}
              options={matchedOptions}
              correct={matchedCorrect}
              subject={matched.subject ?? ''}
              topic={matched.topic ?? ''}
            />
          ) : (
            <div className="px-5 py-6">
              <p className="text-xs" style={{ color: '#9A9891' }}>Matched question not found in pool.</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 flex items-center gap-3 flex-shrink-0" style={{ borderTop: '1px solid #E3E1DB' }}>
          <div className="flex items-center gap-2" style={{ color: '#9A9891' }}>
            <ArrowLeftRight size={12} strokeWidth={1.5} />
            <span className="text-xs">Same subject + topic only — cross-subject duplicates are not flagged.</span>
          </div>
          <div style={{ flex: 1 }} />
          <button
            onClick={onClose}
            className="text-xs px-4 py-2"
            style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2 }}
          >
            Close
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────

function toneFor(v: number): 'ok' | 'note' | 'warn' {
  if (v >= 0.85) return 'warn';
  if (v >= 0.60) return 'note';
  return 'ok';
}

function ScorePill({ label, value, tone }: { label: string; value: string; tone: 'ok' | 'note' | 'warn' }) {
  const palette = {
    ok:   { bg: '#F0FBF4', border: '#C3E8CE', text: '#2A6B3A' },
    note: { bg: '#FFFBF0', border: '#F0DFA0', text: '#8B5E1A' },
    warn: { bg: '#FDF5F5', border: '#F2CECE', text: '#9B2828' },
  }[tone];
  return (
    <div className="flex flex-col">
      <span className="text-xs" style={{ color: '#B0AEA8', letterSpacing: '0.06em', fontSize: 10 }}>{label.toUpperCase()}</span>
      <span
        className="text-xs px-2 py-0.5 mt-1 self-start"
        style={{ background: palette.bg, border: `1px solid ${palette.border}`, color: palette.text, borderRadius: 2 }}
      >
        {value}
      </span>
    </div>
  );
}

function Side({
  heading, sheet, stem, options, correct, subject, topic, borderRight,
}: {
  heading: string;
  sheet:   string;
  stem:    string;
  options: string[];
  correct: string[];
  subject: string;
  topic:   string;
  borderRight?: boolean;
}) {
  return (
    <div
      className="px-5 py-5"
      style={{
        background: '#FFFFFF',
        borderRight: borderRight ? '1px solid #E3E1DB' : undefined,
      }}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.1em', fontSize: 10 }}>{heading}</span>
        <span className="text-xs" style={{ color: '#C4C3BD', fontSize: 10 }}>{sheet}</span>
      </div>

      <div className="flex items-center gap-2 mb-3 flex-wrap">
        {subject && (
          <span className="text-xs px-2 py-0.5" style={{ background: '#F0EFEB', borderRadius: 2, color: '#4A4A45', fontSize: 11 }}>
            {subject}
          </span>
        )}
        {topic && (
          <span className="text-xs px-2 py-0.5" style={{ background: '#F7F6F3', border: '1px solid #E3E1DB', borderRadius: 2, color: '#6B6B66', fontSize: 11 }}>
            {topic}
          </span>
        )}
      </div>

      <p className="text-xs mb-3" style={{ color: '#0C0C0B', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
        {stem || <em style={{ color: '#B0AEA8' }}>No stem</em>}
      </p>

      {options.length > 0 && (
        <div className="space-y-1.5 mb-3">
          {options.map((opt, i) => {
            const isCorrect = correct.includes(opt);
            return (
              <div
                key={i}
                className="flex items-start gap-2 px-2.5 py-1.5"
                style={{
                  background: isCorrect ? '#F0FBF4' : '#FAFAF8',
                  border: `1px solid ${isCorrect ? '#C3E8CE' : '#E3E1DB'}`,
                  borderRadius: 2,
                }}
              >
                <span className="text-xs" style={{ color: '#9A9891', fontSize: 10, minWidth: 14 }}>
                  {String.fromCharCode(65 + i)}.
                </span>
                <span className="text-xs flex-1" style={{ color: '#0C0C0B', lineHeight: 1.5 }}>
                  {opt}
                </span>
                {isCorrect && (
                  <span className="text-xs flex-shrink-0" style={{ color: '#2A6B3A', fontSize: 10, letterSpacing: '0.04em' }}>
                    ✓ CORRECT
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
