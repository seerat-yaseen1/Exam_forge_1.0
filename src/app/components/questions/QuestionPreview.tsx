import React, { useState } from 'react';
import { X, Check } from 'lucide-react';
import {
  type Question,
  type MCQOption,
  type MatchPair,
  type CorrectPair,
  type CodeSpec,
  type CodeTest,
  questionTypeLabel,
  questionTypeBadge,
  difficultyColor,
} from '../../../lib/questionBankService';
import {
  COMPARISON_LABEL,
  LANGUAGE_LABEL,
  defaultWeight,
  totalWeight,
  type AuthoringLanguage,
} from '../../../lib/codeAuthoring';
// The exam's own resolver, imported rather than reimplemented. A second copy
// of "what does the editor open into" is how the preview starts lying.
import { starterFor } from '../exam/codeAnswer';
import { RichText } from './RichText';

// ── Badges ────────────────────────────────────────────────────────────────────

function TypeBadge({ engine, variant }: Pick<Question, 'engine' | 'variant'>) {
  return (
    <span
      className="text-xs px-1.5 py-0.5 select-none inline-block"
      style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, letterSpacing: '0.04em', fontSize: 10 }}
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
        style={{ width: 32, height: 32, borderRadius: '50%', background: 'rgba(255,255,255,0.15)', color: 'var(--ef-surface)' }}
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
    return <p className="text-xs mt-3 italic" style={{ color: 'var(--ef-text-muted)' }}>No options defined.</p>;

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
              border: `1px solid ${isCorrect ? '#C3E8CE' : 'var(--ef-border)'}`,
              borderRadius: 2,
              background: isCorrect ? '#F0FBF4' : 'var(--ef-canvas-raised)',
            }}
          >
            <div className="flex items-start gap-2.5">
              {/* Letter / check */}
              <div
                className="flex-shrink-0 flex items-center justify-center text-xs select-none mt-0.5"
                style={{
                  width: 20, height: 20,
                  borderRadius: isMulti ? 2 : '50%',
                  border: `1.5px solid ${isCorrect ? 'var(--ef-success)' : 'var(--ef-border-muted)'}`,
                  background: isCorrect ? 'var(--ef-success)' : 'transparent',
                  fontSize: 10,
                }}
              >
                {isCorrect
                  ? <Check size={10} strokeWidth={2.5} style={{ color: 'var(--ef-surface)' }} />
                  : <span style={{ color: 'var(--ef-text-muted)' }}>{letters[idx]}</span>
                }
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <RichText
                    text={opt.text || ''}
                    className="text-xs"
                    style={{ color: isCorrect ? 'var(--ef-ink)' : 'var(--ef-text-subtle)', lineHeight: 1.6 }}
                  />
                  {!opt.text && <em className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>Empty option</em>}
                  {isCorrect && (
                    <span className="text-xs ml-auto select-none flex-shrink-0" style={{ color: 'var(--ef-success)', letterSpacing: '0.06em' }}>
                      CORRECT
                    </span>
                  )}
                </div>

                {opt.image && (
                  <img
                    src={opt.image}
                    alt={`Option ${letters[idx]}`}
                    className="mt-2 max-h-32 max-w-full object-contain cursor-zoom-in"
                    style={{ border: '1px solid var(--ef-border)', borderRadius: 2 }}
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
    return <p className="text-xs mt-3 italic" style={{ color: 'var(--ef-text-muted)' }}>No model answer provided.</p>;

  return (
    <div
      className="mt-3 px-4 py-3"
      style={{ background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)', borderRadius: 2 }}
    >
      <p className="text-xs mb-1.5" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>
        {variant === 'codereview' ? 'WHAT THE REVIEW SHOULD CATCH'
          : variant === 'long' ? 'RUBRIC / KEY POINTS'
          : 'EXPECTED ANSWER'}
      </p>
      <RichText text={modelAnswer} className="text-xs" style={{ color: 'var(--ef-text-subtle)', lineHeight: 1.7, display: 'block' }} />
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
    return <p className="text-xs mt-3 italic" style={{ color: 'var(--ef-text-muted)' }}>No pairs defined.</p>;

  const rightById = Object.fromEntries(pairs.map((p) => [p.rightId, p]));
  const pairMap   = Object.fromEntries(correctPairs.map((cp) => [cp.leftId, cp.rightId]));
  const letters   = 'ABCDEFGHIJ';

  return (
    <div className="mt-3">
      <div className="grid grid-cols-2 gap-2 mb-2 px-1">
        <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>COLUMN A</p>
        <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>
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
              <div className="px-3 py-2" style={{ background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
                <div className="flex items-start gap-2">
                  <span className="text-xs flex-shrink-0 select-none mt-0.5" style={{ color: 'var(--ef-text-muted)' }}>{idx + 1}.</span>
                  <div>
                    <RichText text={pair.leftText || ''} className="text-xs" style={{ color: 'var(--ef-ink)' }} />
                    {!pair.leftText && <em className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>Empty</em>}
                    {pair.leftImage && (
                      <img src={pair.leftImage} alt="" className="mt-1.5 max-h-20 max-w-full object-contain cursor-zoom-in"
                        style={{ border: '1px solid var(--ef-border)', borderRadius: 2 }} onClick={() => onImageClick(pair.leftImage!)} />
                    )}
                  </div>
                </div>
              </div>
              {/* Right */}
              <div
                className="px-3 py-2"
                style={showAnswers
                  ? { background: '#F0FBF4', border: '1px solid #C3E8CE', borderRadius: 2 }
                  : { background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border)', borderRadius: 2 }
                }
              >
                <div className="flex items-start gap-2">
                  {showAnswers && (
                    <span className="text-xs flex-shrink-0 select-none mt-0.5" style={{ color: 'var(--ef-text-muted)' }}>{letters[idx]}.</span>
                  )}
                  <div>
                    {showAnswers ? (
                      matchedRight ? (
                        <>
                          <RichText text={matchedRight.rightText || ''} className="text-xs" style={{ color: 'var(--ef-success)' }} />
                          {matchedRight.rightImage && (
                            <img src={matchedRight.rightImage} alt="" className="mt-1.5 max-h-20 max-w-full object-contain cursor-zoom-in"
                              style={{ border: '1px solid #C3E8CE', borderRadius: 2 }} onClick={() => onImageClick(matchedRight.rightImage!)} />
                          )}
                        </>
                      ) : <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>—</span>
                    ) : (
                      <>
                        <RichText text={pair.rightText || ''} className="text-xs" style={{ color: 'var(--ef-text-subtle)' }} />
                        {!pair.rightText && <em className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>Empty</em>}
                        {pair.rightImage && (
                          <img src={pair.rightImage} alt="" className="mt-1.5 max-h-20 max-w-full object-contain cursor-zoom-in"
                            style={{ border: '1px solid var(--ef-border)', borderRadius: 2 }} onClick={() => onImageClick(pair.rightImage!)} />
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

// ── Code ──────────────────────────────────────────────────────────────────────

/**
 * A coding question, as its author needs to check it.
 *
 * Everything here is invisible in the exam by design — the candidate sees a
 * language selector, a buffer and the visible tests, and never the suite that
 * marks them. So preview is the ONLY surface where an author can confirm that
 * the starter code they wrote is the starter code that ships, and that the
 * hidden tests carry the weight they intended.
 *
 * The split follows the storage split exactly. `codeSpec` is public and always
 * shown; `tests` is the answer key and is gated behind showAnswers with
 * correctIds and modelAnswer, so a preview rendered for a student audience
 * cannot leak expected outputs.
 */
function CodePreview({
  codeSpec, tests, showAnswers,
}: {
  codeSpec?: CodeSpec;
  tests?: CodeTest[];
  showAnswers: boolean;
}) {
  const languages = codeSpec?.languages ?? [];
  const starter   = codeSpec?.starterCode ?? {};
  const suite     = tests ?? [];
  const weight    = totalWeight(suite);
  const hidden    = suite.filter((t) => !t.visible).length;

  const box: React.CSSProperties = {
    background: 'var(--ef-canvas-raised)', border: '1px solid var(--ef-border)',
    borderRadius: 2, padding: '8px 10px',
  };
  const mono: React.CSSProperties = {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 11, whiteSpace: 'pre', overflowX: 'auto', display: 'block',
    color: 'var(--ef-ink)', lineHeight: 1.6,
  };
  const heading = (t: string) => (
    <p className="text-xs mb-1" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.08em' }}>{t}</p>
  );

  return (
    <div className="mt-3 space-y-3">
      {/* ── Languages ── */}
      <div>
        {heading('LANGUAGES')}
        <p className="text-xs" style={{ color: 'var(--ef-text-subtle)' }}>
          {languages.length === 0
            // Not a blank — an empty restriction means "any language the
            // platform runs", and an author who assumed the opposite has
            // written a much easier question than they think.
            ? 'Unrestricted — the candidate may answer in any language the platform runs.'
            : languages.map((l) => LANGUAGE_LABEL[l as AuthoringLanguage] ?? l).join(', ')}
        </p>
      </div>

      {/* ── Starter code ── */}
      {languages.length > 0 && (
        <div>
          {heading('STARTER CODE')}
          <div className="space-y-2">
            {languages.map((lang) => {
              // Through the SAME resolver the exam uses, not the raw field.
              // The preview exists so an author sees what is delivered; reading
              // starterCode directly would show "blank" for every language they
              // had not filled in, while the candidate opens the platform
              // template — which is the preview being wrong about the one thing
              // it is for.
              const body = starterFor(codeSpec, lang);
              const authored = typeof starter[lang] === 'string';
              return (
                <div key={lang}>
                  <p className="text-xs mb-0.5" style={{ color: 'var(--ef-text-muted)' }}>
                    {LANGUAGE_LABEL[lang as AuthoringLanguage] ?? lang}
                    {!authored && body.trim().length > 0 && (
                      <span style={{ marginLeft: 6, opacity: 0.7 }}>· platform template</span>
                    )}
                  </p>
                  {body.trim().length > 0
                    ? <div style={box}><code style={mono}>{body}</code></div>
                    : <em className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                        Empty — the candidate opens a blank editor.
                      </em>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Test suite ── */}
      {showAnswers && (
        <div>
          {heading('TEST CASES')}
          {suite.length === 0 ? (
            <em className="text-xs" style={{ color: 'var(--ef-danger)' }}>
              No test cases — this question cannot be marked.
            </em>
          ) : (
            <>
              <p className="text-xs mb-1.5" style={{ color: weight > 0 ? 'var(--ef-text-subtle)' : 'var(--ef-danger)' }}>
                Total weight {weight} across {hidden} hidden and {suite.length - hidden} visible
                {suite.length === 1 ? ' test' : ' tests'}
                {/* The one number that decides whether the question marks at
                    all. Visible tests default to zero weight, so a suite can
                    look full and still award nothing. */}
                {weight <= 0 && ' — no test carries weight, so this question cannot be marked.'}
              </p>
              <div className="space-y-1.5">
                {suite.map((t, i) => (
                  <div key={t.id} style={box}>
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{i + 1}.</span>
                      <span className="text-xs px-1.5 py-0.5" style={{
                        background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)',
                        borderRadius: 2, color: 'var(--ef-text-subtle)',
                      }}>
                        {t.visible ? 'Visible' : 'Hidden'}
                      </span>
                      <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                        weight {defaultWeight(t)} · {COMPARISON_LABEL[t.comparison ?? 'trimmed']}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <p className="text-xs mb-0.5" style={{ color: 'var(--ef-text-muted)' }}>Input</p>
                        <code style={mono}>{t.stdin || '(empty)'}</code>
                      </div>
                      <div>
                        <p className="text-xs mb-0.5" style={{ color: 'var(--ef-text-muted)' }}>Expected</p>
                        <code style={mono}>{t.expected || '(empty)'}</code>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
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
    codeSpec, tests,
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
        <p className="text-xs mb-2" style={{ color: 'var(--ef-text-muted)' }}>
          {questionTypeLabel(engine, variant)}
        </p>
      )}

      {/* ── Stem ── */}
      {stem
        ? <RichText text={stem} image={stemImage} className="text-sm" style={{ color: 'var(--ef-ink)', lineHeight: 1.7, display: 'block' }} onImageClick={setLightboxUrl} />
        : <em className="text-sm" style={{ color: 'var(--ef-text-muted)' }}>No question stem defined.</em>
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
      {engine === 'code' && (
        <CodePreview codeSpec={codeSpec} tests={tests} showAnswers={showAnswers} />
      )}

      {/* ── Explanation ── */}
      {effectiveShowExplanation && showAnswers && explanation && (
        <div className="mt-3 px-4 py-3" style={{ background: '#FFFBF0', border: '1px solid #F0DFA0', borderRadius: 2 }}>
          <p className="text-xs mb-1" style={{ color: 'var(--ef-warning-strong)', letterSpacing: '0.08em' }}>EXPLANATION</p>
          <RichText text={explanation} className="text-xs" style={{ color: 'var(--ef-text-subtle)', lineHeight: 1.7, display: 'block' }} />
        </div>
      )}

      {/* ── Meta footer ── */}
      {effectiveShowMeta && (
        <div className="mt-4 flex flex-wrap gap-2 items-center" style={{ borderTop: '1px solid var(--ef-border-subtle)', paddingTop: 12 }}>
          {subject && (
            <span className="text-xs px-2 py-0.5" style={{ background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)', borderRadius: 2, color: 'var(--ef-text-subtle)' }}>
              {subject}
            </span>
          )}
          {topic && <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>· {topic}</span>}
          {tags.map((tag) => (
            <span key={tag} className="text-xs px-2 py-0.5" style={{ background: 'var(--ef-border-subtle)', borderRadius: 2, color: 'var(--ef-text-muted)' }}>
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
