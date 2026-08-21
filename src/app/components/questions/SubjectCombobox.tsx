/**
 * SubjectCombobox — a fully-controlled combobox for subject selection.
 *
 * Behaviour:
 *   • Loads subject registry from Firestore on first open (cached via prop)
 *   • As user types, runs resolveSubject() against the registry
 *   • Shows exact / alias / fuzzy suggestions with clear labels
 *   • "Create new subject" option at the bottom when no exact match
 *   • Clicking away without selecting snaps back to last valid value
 *   • Emits the canonical subject name (never raw input) via onChange
 */

import React, {
  useState, useEffect, useRef, useCallback,
} from 'react';
import { ChevronDown, Plus, Check, Loader2, Tag, Search } from 'lucide-react';
import {
  type Subject,
  type ResolveResult,
  getAllSubjects,
  createSubject,
  resolveSubject,
  normalizeSubject,
} from '../../../lib/subjectService';

// ── Module-level cache (shared across all instances in the same page load) ─────
let _cachedSubjects: Subject[] | null = null;
let _fetchPromise: Promise<Subject[]> | null = null;

async function fetchSubjectsCached(): Promise<Subject[]> {
  if (_cachedSubjects) return _cachedSubjects;
  if (_fetchPromise) return _fetchPromise;
  _fetchPromise = getAllSubjects().then((s) => {
    _cachedSubjects = s;
    _fetchPromise   = null;
    return s;
  });
  return _fetchPromise;
}

/** Call this after a new subject is created to keep the cache consistent. */
export function invalidateSubjectCache() {
  _cachedSubjects = null;
  _fetchPromise   = null;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Suggestion =
  | { type: 'subject'; subject: Subject; matchKind: 'exact' | 'alias' | 'fuzzy'; matchedAlias?: string }
  | { type: 'create';  name: string };

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildSuggestions(input: string, subjects: Subject[]): Suggestion[] {
  const q = input.trim();
  if (!q) {
    // Show first 8 subjects sorted alphabetically
    return subjects.slice(0, 8).map((s) => ({ type: 'subject', subject: s, matchKind: 'exact' as const }));
  }

  const lq = q.toLowerCase();
  const scored: { suggestion: Suggestion; score: number }[] = [];

  for (const s of subjects) {
    const nameLc = s.name.toLowerCase();
    // Exact canonical
    if (nameLc === lq) {
      scored.push({ suggestion: { type: 'subject', subject: s, matchKind: 'exact' }, score: 100 });
      continue;
    }
    // Contains canonical
    if (nameLc.includes(lq)) {
      scored.push({ suggestion: { type: 'subject', subject: s, matchKind: 'exact' }, score: 80 + (1 - lq.length / nameLc.length) * 10 });
      continue;
    }
    // Alias match
    const aliasMatch = s.aliases.find((a) => a.toLowerCase().includes(lq));
    if (aliasMatch) {
      scored.push({ suggestion: { type: 'subject', subject: s, matchKind: 'alias', matchedAlias: aliasMatch }, score: 60 });
      continue;
    }
    // Fuzzy — Levenshtein-based similarity
    const sim = stringSimilarity(lq, nameLc);
    if (sim >= 0.55) {
      scored.push({ suggestion: { type: 'subject', subject: s, matchKind: 'fuzzy' }, score: sim * 50 });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const results: Suggestion[] = scored.slice(0, 6).map((s) => s.suggestion);

  // Check if exact match exists in results
  const hasExact = results.some(
    (r) => r.type === 'subject' && r.subject.name.toLowerCase() === lq
  );

  // Add "Create" option if the typed value doesn't exactly match an existing canonical name
  if (!hasExact && q.length >= 2) {
    results.push({ type: 'create', name: normalizeSubject(q) });
  }

  return results;
}

function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const maxLen = Math.max(a.length, b.length);
  if (!maxLen) return 1;
  let dist = 0;
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j-1], dp[i-1][j], dp[i][j-1]);
    }
  }
  dist = dp[m][n];
  return 1 - dist / maxLen;
}

function MatchKindBadge({ kind, alias }: { kind: 'exact' | 'alias' | 'fuzzy'; alias?: string }) {
  if (kind === 'exact')  return null;
  if (kind === 'alias')  return (
    <span className="text-xs ml-auto select-none flex-shrink-0" style={{ color: 'var(--ef-warning-strong)', fontSize: 12, letterSpacing: '0.06em' }}>
      alias: {alias}
    </span>
  );
  return (
    <span className="text-xs ml-auto select-none flex-shrink-0" style={{ color: 'var(--ef-text-muted)', fontSize: 12, letterSpacing: '0.06em' }}>
      suggested
    </span>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export interface SubjectComboboxProps {
  /** Current canonical subject name (controlled). */
  value: string;
  onChange: (canonical: string) => void;
  /** If provided, use this list instead of fetching. Useful in bulk upload context. */
  subjects?: Subject[];
  /** Called when a new subject is created via the combobox. */
  onSubjectCreated?: (subject: Subject) => void;
  placeholder?: string;
  error?: string;
  disabled?: boolean;
}

export function SubjectCombobox({
  value,
  onChange,
  subjects: subjectsProp,
  onSubjectCreated,
  placeholder = 'e.g. Mathematics',
  error,
  disabled = false,
}: SubjectComboboxProps) {
  const [open,         setOpen]         = useState(false);
  const [inputVal,     setInputVal]     = useState(value);
  const [subjects,     setSubjects]     = useState<Subject[]>(subjectsProp ?? []);
  const [loading,      setLoading]      = useState(!subjectsProp);
  const [creating,     setCreating]     = useState(false);
  const [suggestions,  setSuggestions]  = useState<Suggestion[]>([]);
  const [activeIdx,    setActiveIdx]    = useState(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef     = useRef<HTMLInputElement>(null);

  // Sync prop → input when value changes externally
  useEffect(() => { setInputVal(value); }, [value]);

  // Fetch subjects on mount (if not provided)
  useEffect(() => {
    if (subjectsProp) { setSubjects(subjectsProp); setLoading(false); return; }
    fetchSubjectsCached().then((s) => { setSubjects(s); setLoading(false); });
  }, [subjectsProp]);

  // Rebuild suggestions whenever input or subjects change
  useEffect(() => {
    setSuggestions(buildSuggestions(inputVal, subjects));
    setActiveIdx(-1);
  }, [inputVal, subjects]);

  // Click-outside to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        close(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const close = useCallback((commit: boolean) => {
    if (commit) {
      // snap to value if inputVal doesn't match a valid suggestion
      const exact = subjects.find((s) => s.name.toLowerCase() === inputVal.trim().toLowerCase());
      if (!exact) setInputVal(value); // revert
    } else {
      setInputVal(value); // always revert on dismiss without commit
    }
    setOpen(false);
  }, [value, inputVal, subjects]);

  const selectSubject = (canonical: string) => {
    setInputVal(canonical);
    onChange(canonical);
    setOpen(false);
  };

  const handleCreate = async (name: string) => {
    setCreating(true);
    try {
      const newSubj = await createSubject(name);
      invalidateSubjectCache();
      const updated = [...subjects, newSubj].sort((a, b) => a.name.localeCompare(b.name));
      setSubjects(updated);
      onSubjectCreated?.(newSubj);
      selectSubject(newSubj.name);
    } catch (err: any) {
      // Subject already exists (race condition) — resolve it
      const all = await fetchSubjectsCached();
      const existing = all.find((s) => s.name.toLowerCase() === name.toLowerCase());
      if (existing) selectSubject(existing.name);
    } finally {
      setCreating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter') { setOpen(true); return; }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIdx >= 0 && suggestions[activeIdx]) {
        const s = suggestions[activeIdx];
        if (s.type === 'subject') selectSubject(s.subject.name);
        else if (s.type === 'create') handleCreate(s.name);
      }
    } else if (e.key === 'Escape') {
      close(false);
    }
  };

  const isSelected = (canonical: string) => canonical.toLowerCase() === value.toLowerCase();

  return (
    <div ref={containerRef} className="relative" style={{ width: '100%' }}>
      {/* Input */}
      <div
        className="flex items-center gap-2"
        style={{
          border: `1px solid ${error ? 'var(--ef-danger-border)' : open ? 'var(--ef-ink)' : 'var(--ef-border)'}`,
          borderRadius: 2,
          background: disabled ? 'var(--ef-canvas)' : open ? 'var(--ef-surface)' : 'var(--ef-canvas-raised)',
          transition: 'border-color 0.15s, background 0.15s',
        }}
      >
        <Tag size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', marginLeft: 10, flexShrink: 0 }} />
        <input
          ref={inputRef}
          type="text"
          value={inputVal}
          disabled={disabled}
          placeholder={placeholder}
          onFocus={() => { if (!disabled) setOpen(true); }}
          onChange={(e) => { setInputVal(e.target.value); if (!open) setOpen(true); }}
          onKeyDown={handleKeyDown}
          className="flex-1 text-xs outline-none py-2.5 pr-2"
          style={{
            background: 'transparent',
            color: 'var(--ef-ink)',
            fontSize: 14,
            cursor: disabled ? 'not-allowed' : 'text',
          }}
        />
        {loading
          ? <Loader2 size={12} className="animate-spin mr-2.5 flex-shrink-0" style={{ color: 'var(--ef-text-muted)' }} />
          : <ChevronDown
              size={12} strokeWidth={1.5} className="mr-2.5 flex-shrink-0 transition-transform"
              style={{ color: 'var(--ef-text-muted)', transform: open ? 'rotate(180deg)' : 'none' }}
            />
        }
      </div>

      {/* Error */}
      {error && <p className="text-xs mt-1.5" style={{ color: 'var(--ef-danger)' }}>{error}</p>}

      {/* Dropdown */}
      {open && !disabled && (
        <div
          className="absolute left-0 right-0 z-50 mt-1 overflow-hidden"
          style={{
            background: 'var(--ef-surface)',
            border: '1px solid var(--ef-border)',
            borderRadius: 3,
            boxShadow: '0 6px 24px rgba(12,12,11,0.10)',
            maxHeight: 280,
            overflowY: 'auto',
          }}
        >
          {loading ? (
            <div className="flex items-center justify-center py-6 gap-2">
              <Loader2 size={13} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />
              <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>Loading subjects…</span>
            </div>
          ) : suggestions.length === 0 ? (
            <div className="px-4 py-6 text-center">
              <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>No subjects found.</p>
              {inputVal.trim().length >= 2 && (
                <button
                  type="button"
                  onClick={() => handleCreate(normalizeSubject(inputVal.trim()))}
                  disabled={creating}
                  className="mt-2 flex items-center gap-1.5 text-xs mx-auto transition-opacity hover:opacity-70"
                  style={{ color: 'var(--ef-ink)' }}
                >
                  {creating ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} strokeWidth={2} />}
                  Create "{normalizeSubject(inputVal.trim())}"
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Header hint */}
              {subjects.length > 0 && inputVal.trim() === '' && (
                <div className="px-3 pt-2 pb-1.5 flex items-center gap-1.5">
                  <Search size={10} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
                  <span className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.06em', fontSize: 12 }}>
                    ALL SUBJECTS — type to search
                  </span>
                </div>
              )}

              {suggestions.map((s, idx) => {
                const isActive = idx === activeIdx;

                if (s.type === 'create') {
                  return (
                    <button
                      key="create"
                      type="button"
                      onMouseDown={(e) => { e.preventDefault(); handleCreate(s.name); }}
                      onMouseEnter={() => setActiveIdx(idx)}
                      disabled={creating}
                      className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors"
                      style={{
                        borderTop: '1px solid var(--ef-border-subtle)',
                        background: isActive ? 'var(--ef-canvas)' : 'var(--ef-surface)',
                        color: 'var(--ef-ink)',
                        cursor: creating ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {creating
                        ? <Loader2 size={13} className="animate-spin flex-shrink-0" style={{ color: 'var(--ef-text-muted)' }} />
                        : <Plus size={13} strokeWidth={1.5} className="flex-shrink-0" style={{ color: 'var(--ef-text-muted)' }} />
                      }
                      <span className="text-xs">
                        Create <span style={{ color: 'var(--ef-ink)' }}>"{s.name}"</span>
                        <span style={{ color: 'var(--ef-text-muted)' }}> as new subject</span>
                      </span>
                    </button>
                  );
                }

                // type === 'subject'
                const selected = isSelected(s.subject.name);
                return (
                  <button
                    key={s.subject.id}
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); selectSubject(s.subject.name); }}
                    onMouseEnter={() => setActiveIdx(idx)}
                    className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors"
                    style={{ background: isActive ? 'var(--ef-canvas)' : 'var(--ef-surface)', cursor: 'pointer' }}
                  >
                    {/* Selected indicator */}
                    <div
                      className="flex-shrink-0 flex items-center justify-center"
                      style={{ width: 14, height: 14, borderRadius: '50%', background: selected ? 'var(--ef-ink)' : 'transparent' }}
                    >
                      {selected && <Check size={8} strokeWidth={3} style={{ color: 'var(--ef-surface)' }} />}
                    </div>

                    {/* Name + count */}
                    <span className="flex-1 text-xs" style={{ color: 'var(--ef-ink)' }}>
                      {s.subject.name}
                    </span>

                    {/* Question count pill */}
                    {s.subject.questionCount > 0 && (
                      <span
                        className="text-xs px-1.5 py-0.5 select-none flex-shrink-0"
                        style={{ background: 'var(--ef-border-subtle)', color: 'var(--ef-text-muted)', borderRadius: 2, fontSize: 12 }}
                      >
                        {s.subject.questionCount}
                      </span>
                    )}

                    {/* Match kind badge */}
                    <MatchKindBadge kind={s.matchKind} alias={s.matchedAlias} />
                  </button>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}
