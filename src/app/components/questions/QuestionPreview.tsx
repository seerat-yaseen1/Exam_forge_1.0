import React, { useState } from 'react';
import { X, Check } from 'lucide-react';
import {
  type Question,
  type MCQOption,
  type MatchPair,
  type CorrectPair,
  questionTypeLabel,
  questionTypeBadge,
  difficultyColor,
} from '../../../lib/questionBankService';
import { RichText } from './RichText';

// ── Badges ────────────────────────────────────────────────────────────────────

function TypeBadge({ engine, variant }: Pick<Question, 'engine' | 'variant'>) {
  return (
    <span
      className="text-xs px-1.5 py-0.5 select-none inline-block"
      style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, letterSpacing: '0.04em', fontSize: 10 }}
    >
      {questionTypeBadge(engine, variant)}
    </span>
  );
}

function DiffBadge({ difficulty }: Pick<Question, 'difficulty'>) {
  const { bg, text, border } = difficultyColor(difficulty);
  return (
    <span
      className="text-xs px-2 py-0.5 capitalize select-none inline-block"
      style={{ background: bg, color: text, border: `1px solid ${border}`, borderRadius: 2 }}
    >
      {difficulty}
    </span>
  );
}

// ── Lightbox ──────────────────────────────────────────────────────────────────

function Lightbox({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center"
      style={{ background: 'rgba(12,12,11,0.72)' }}
      onClick={onClose}
    >
      <button
        className="absolute top-4 right-4 flex items-center justify-center"
        style={{ width: 32, height: 32, borderRadius: '50%', background: 'rgba(255,255,255,0.15)', color: '#FFFFFF' }}
        onClick={onClose}
      >
        <X size={16} strokeWidth={1.5} />
      </button>
      <img
        src={url}
        alt="Full size"
        className="max-w-[90vw] max-h-[85vh] object-contain rounded"
        style={{ boxShadow: '0 16px 48px rgba(0,0,0,0.4)' }}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}

// ── MCQ Preview ───────────────────────────────────────────────────────────────

function MCQPreview({
  options, correctIds, variant, showAnswers, onImageClick,
}: {
  options:       MCQOption[];
  correctIds:    string[];
  variant:       Question['variant'];
  showAnswers:   boolean;
  onImageClick:  (url: string) => void;
}) {
  if (!options.length)
    return <p className="text-xs mt-3 italic" style={{ color: '#6B6B66' }}>No options defined.</p>;

  const isMulti  = variant === 'multi';
  const letters  = 'ABCDEFGHIJ';

  return (
    <div className="space-y-2 mt-3">
      {options.map((opt, idx) => {
        const isCorrect = showAnswers && correctIds.includes(opt.id);
        return (
          <div
            key={opt.id}
            className="px-3 py-2.5"
            style={{
              border: `1px solid ${isCorrect ? '#C3E8CE' : '#E3E1DB'}`,
              borderRadius: 2,
              background: isCorrect ? '#F0FBF4' : '#FAFAF8',
            }}
          >
            <div className="flex items-start gap-2.5">
              {/* Letter / check */}
              <div
                className="flex-shrink-0 flex items-center justify-center text-xs select-none mt-0.5"
                style={{
                  width: 20, height: 20,
                  borderRadius: isMulti ? 2 : '50%',
                  border: `1.5px solid ${isCorrect ? '#2A6B3A' : '#DDDBD5'}`,
                  background: isCorrect ? '#2A6B3A' : 'transparent',
                  fontSize: 10,
                }}
              >
                {isCorrect
                  ? <Check size={10} strokeWidth={2.5} style={{ color: '#FFFFFF' }} />
                  : <span style={{ color: '#6B6B66' }}>{letters[idx]}</span>
                }
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <RichText
                    text={opt.text || ''}
                    className="text-xs"
                    style={{ color: isCorrect ? '#0C0C0B' : '#4A4A45', lineHeight: 1.6 }}
                  />
                  {!opt.text && <em className="text-xs" style={{ color: '#6B6B66' }}>Empty option</em>}
                  {isCorrect && (
                    <span className="text-xs ml-auto select-none flex-shrink-0" style={{ color: '#2A6B3A', letterSpacing: '0.06em' }}>
                      CORRECT
                    </span>
                  )}
                </div>

                {opt.image && (
                  <img
                    src={opt.image}
                    alt={`Option ${letters[idx]}`}
                    className="mt-2 max-h-32 max-w-full object-contain cursor-zoom-in"
                    style={{ border: '1px solid #E3E1DB', borderRadius: 2 }}
                    onClick={() => onImageClick(opt.image!)}
                  />
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Text Preview ──────────────────────────────────────────────────────────────

function TextPreview({ modelAnswer, variant }: { modelAnswer: string; variant: Question['variant'] }) {
  if (!modelAnswer)
    return <p className="text-xs mt-3 italic" style={{ color: '#6B6B66' }}>No model answer provided.</p>;

  return (
    <div
      className="mt-3 px-4 py-3"
      style={{ background: '#F7F6F3', border: '1px solid #E3E1DB', borderRadius: 2 }}
    >
      <p className="text-xs mb-1.5" style={{ color: '#6B6B66', letterSpacing: '0.08em' }}>
        {variant === 'long' ? 'RUBRIC / KEY POINTS' : 'EXPECTED ANSWER'}
      </p>
      <RichText text={modelAnswer} className="text-xs" style={{ color: '#4A4A45', lineHeight: 1.7, display: 'block' }} />
    </div>
  );
}

// ── Match Preview ─────────────────────────────────────────────────────────────

function MatchPreview({
  pairs, correctPairs, showAnswers, onImageClick,
}: {
  pairs:        MatchPair[];
  correctPairs: CorrectPair[];
  showAnswers:  boolean;
  onImageClick: (url: string) => void;
}) {
  if (!pairs.length)
    return <p className="text-xs mt-3 italic" style={{ color: '#6B6B66' }}>No pairs defined.</p>;

  const rightById = Object.fromEntries(pairs.map((p) => [p.rightId, p]));
  const pairMap   = Object.fromEntries(correctPairs.map((cp) => [cp.leftId, cp.rightId]));
  const letters   = 'ABCDEFGHIJ';

  return (
    <div className="mt-3">
      <div className="grid grid-cols-2 gap-2 mb-2 px-1">
        <p className="text-xs" style={{ color: '#6B6B66', letterSpacing: '0.08em' }}>COLUMN A</p>
        <p className="text-xs" style={{ color: '#6B6B66', letterSpacing: '0.08em' }}>
          {showAnswers ? 'COLUMN B (ANSWER KEY)' : 'COLUMN B'}
        </p>
      </div>
      <div className="space-y-1.5">
        {pairs.map((pair, idx) => {
          const matchedRightId = pairMap[pair.leftId];
          const matchedRight   = matchedRightId ? rightById[matchedRightId] : null;
          return (
            <div key={pair.leftId} className="grid grid-cols-2 gap-2">
              {/* Left */}
              <div className="px-3 py-2" style={{ background: '#FAFAF8', border: '1px solid #E3E1DB', borderRadius: 2 }}>
                <div className="flex items-start gap-2">
                  <span className="text-xs flex-shrink-0 select-none mt-0.5" style={{ color: '#6B6B66' }}>{idx + 1}.</span>
                  <div>
                    <RichText text={pair.leftText || ''} className="text-xs" style={{ color: '#0C0C0B' }} />
                    {!pair.leftText && <em className="text-xs" style={{ color: '#6B6B66' }}>Empty</em>}
                    {pair.leftImage && (
                      <img src={pair.leftImage} alt="" className="mt-1.5 max-h-20 max-w-full object-contain cursor-zoom-in"
                        style={{ border: '1px solid #E3E1DB', borderRadius: 2 }} onClick={() => onImageClick(pair.leftImage!)} />
                    )}
                  </div>
                </div>
              </div>
              {/* Right */}
              <div
                className="px-3 py-2"
                style={showAnswers
                  ? { background: '#F0FBF4', border: '1px solid #C3E8CE', borderRadius: 2 }
                  : { background: '#FAFAF8', border: '1px solid #E3E1DB', borderRadius: 2 }
                }
              >
                <div className="flex items-start gap-2">
                  {showAnswers && (
                    <span className="text-xs flex-shrink-0 select-none mt-0.5" style={{ color: '#6B6B66' }}>{letters[idx]}.</span>
                  )}
                  <div>
                    {showAnswers ? (
                      matchedRight ? (
                        <>
                          <RichText text={matchedRight.rightText || ''} className="text-xs" style={{ color: '#2A6B3A' }} />
                          {matchedRight.rightImage && (
                            <img src={matchedRight.rightImage} alt="" className="mt-1.5 max-h-20 max-w-full object-contain cursor-zoom-in"
                              style={{ border: '1px solid #C3E8CE', borderRadius: 2 }} onClick={() => onImageClick(matchedRight.rightImage!)} />
                          )}
                        </>
                      ) : <span className="text-xs" style={{ color: '#6B6B66' }}>—</span>
                    ) : (
                      <>
                        <RichText text={pair.rightText || ''} className="text-xs" style={{ color: '#4A4A45' }} />
                        {!pair.rightText && <em className="text-xs" style={{ color: '#6B6B66' }}>Empty</em>}
                        {pair.rightImage && (
                          <img src={pair.rightImage} alt="" className="mt-1.5 max-h-20 max-w-full object-contain cursor-zoom-in"
                            style={{ border: '1px solid #E3E1DB', borderRadius: 2 }} onClick={() => onImageClick(pair.rightImage!)} />
                        )}
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface QuestionPreviewProps {
  question: Question;
  showAnswers?:    boolean;
  showMeta?:       boolean;
  showExplanation?: boolean;
  compact?:        boolean;
}

export function QuestionPreview({
  question,
  showAnswers     = true,
  showMeta        = true,
  showExplanation = true,
  compact         = false,
}: QuestionPreviewProps) {
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const {
    engine, variant, stem, stemImage,
    options, correctIds,
    modelAnswer,
    pairs, correctPairs,
    subject, topic, tags, difficulty, explanation,
  } = question;

  const effectiveShowMeta        = showMeta && !compact;
  const effectiveShowExplanation = showExplanation && !compact;

  return (
    <>
      {/* ── Header ── */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <TypeBadge engine={engine} variant={variant} />
        {effectiveShowMeta && <DiffBadge difficulty={difficulty} />}
      </div>

      {/* ── Type label ── */}
      {effectiveShowMeta && (
        <p className="text-xs mb-2" style={{ color: '#6B6B66' }}>
          {questionTypeLabel(engine, variant)}
        </p>
      )}

      {/* ── Stem ── */}
      {stem
        ? <RichText text={stem} image={stemImage} className="text-sm" style={{ color: '#0C0C0B', lineHeight: 1.7, display: 'block' }} onImageClick={setLightboxUrl} />
        : <em className="text-sm" style={{ color: '#6B6B66' }}>No question stem defined.</em>
      }

      {/* ── Engine-specific ── */}
      {engine === 'mcq' && (
        <MCQPreview options={options} correctIds={correctIds} variant={variant} showAnswers={showAnswers} onImageClick={setLightboxUrl} />
      )}
      {engine === 'text' && showAnswers && (
        <TextPreview modelAnswer={modelAnswer} variant={variant} />
      )}
      {engine === 'match' && (
        <MatchPreview pairs={pairs} correctPairs={correctPairs} showAnswers={showAnswers} onImageClick={setLightboxUrl} />
      )}

      {/* ── Explanation ── */}
      {effectiveShowExplanation && showAnswers && explanation && (
        <div className="mt-3 px-4 py-3" style={{ background: '#FFFBF0', border: '1px solid #F0DFA0', borderRadius: 2 }}>
          <p className="text-xs mb-1" style={{ color: '#8B5E1A', letterSpacing: '0.08em' }}>EXPLANATION</p>
          <RichText text={explanation} className="text-xs" style={{ color: '#4A4A45', lineHeight: 1.7, display: 'block' }} />
        </div>
      )}

      {/* ── Meta footer ── */}
      {effectiveShowMeta && (
        <div className="mt-4 flex flex-wrap gap-2 items-center" style={{ borderTop: '1px solid #F0EFEB', paddingTop: 12 }}>
          {subject && (
            <span className="text-xs px-2 py-0.5" style={{ background: '#F7F6F3', border: '1px solid #E3E1DB', borderRadius: 2, color: '#4A4A45' }}>
              {subject}
            </span>
          )}
          {topic && <span className="text-xs" style={{ color: '#6B6B66' }}>· {topic}</span>}
          {tags.map((tag) => (
            <span key={tag} className="text-xs px-2 py-0.5" style={{ background: '#F0EFEB', borderRadius: 2, color: '#6B6B66' }}>
              #{tag}
            </span>
          ))}
        </div>
      )}

      {/* ── Lightbox ── */}
      {lightboxUrl && <Lightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} />}
    </>
  );
}
