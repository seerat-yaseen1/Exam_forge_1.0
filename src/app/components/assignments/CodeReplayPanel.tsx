/**
 * SESSION REPLAY — what a candidate did, for the people entitled to look
 *
 * The capture path, the append-only store, the erasure hooks and the
 * reconstruction algebra all shipped and were all tested. Nothing ever
 * displayed any of it: `attemptTelemetry` was written on every coding answer,
 * retained, purged on erasure, readable by staff — and read by no client code.
 * `codeReplay.ts` reconstructs a whole session and its only consumer was its
 * own unit test. This is the surface that was missing.
 *
 * ── WHAT THIS IS NOT ──────────────────────────────────────────────
 *
 * NOT EVIDENCE OF ANYTHING, AND NOT PART OF A MARK.
 *
 * Nothing in the grading path reads telemetry, deliberately: the moment
 * behaviour affects a score, a candidate is being marked on how they worked
 * rather than on what they produced. This panel keeps that separation visible
 * — it reports what happened and never what it means. "180 characters appeared
 * at once" is a fact. "Pasted" is an accusation, and a reviewer skimming
 * quickly should not be handed one.
 *
 * The same restraint governs the reconstruction. A replay is watched by
 * someone forming a judgement about a person, and every reconstruction failure
 * is silent by nature: an edit applied to the wrong base produces text, and
 * that text looks exactly as authoritative as a correct reconstruction. So
 * `codeReplay` tracks whether it still knows what it is doing, and this panel
 * SHOWS that state rather than quietly rendering fiction.
 *
 * ── LOADED ON DEMAND ──────────────────────────────────────────────
 *
 * A recording is hundreds of documents and a reviewer opens one for a tiny
 * fraction of the answers they read. Fetching it with the roster would make
 * every attempt drill-in pay for a feature almost nobody uses on that visit.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Play, Pause, AlertTriangle, Film } from 'lucide-react';
import {
  IDLE_GAP_MS,
  PASTE_MAX_CHARS_PER_SEC,
  PASTE_MIN_CHARS,
  summarise,
  type TelemetryEvent,
} from '../../../lib/codeTelemetry';
import {
  buildFrames,
  buildMarks,
  duration,
  frameAt,
  mergeChunks,
  type MarkKind,
} from '../../../lib/codeReplay';
import { getCodeTelemetry } from '../../../lib/submissionService';

/** Playback advances this much of recorded time per tick. */
const TICK_MS = 100;
const SPEEDS = [1, 4, 16] as const;

const MARK_COLOR: Record<MarkKind, string> = {
  paste: 'var(--ef-warning)',
  run:   '#1D4ED8',
  blur:  'var(--ef-text-muted)',
  lang:  '#4A1D96',
  idle:  'var(--ef-border)',
};

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function CodeReplayPanel({
  attemptId,
  questionId,
  instituteId,
}: {
  attemptId: string;
  questionId: string;
  /** The ATTEMPT's institute, which is what the chunks were written with. */
  instituteId: string | null;
}) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError]   = useState<string>('');
  const [events, setEvents] = useState<TelemetryEvent[]>([]);
  const [t, setT]           = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed]   = useState<(typeof SPEEDS)[number]>(4);

  const load = useCallback(async () => {
    setStatus('loading');
    setError('');
    try {
      const chunks = await getCodeTelemetry(attemptId, questionId, instituteId);
      // By seq, never by arrival — chunks come from separate calls and a query
      // gives no ordering this can rely on. Out of order, later edits apply
      // before earlier ones and the reconstruction is nonsense.
      setEvents(mergeChunks(chunks));
      setStatus('ready');
    } catch (e) {
      setError((e as Error)?.message || 'Could not load the recording.');
      setStatus('error');
    }
  }, [attemptId, questionId, instituteId]);

  const frames  = useMemo(() => buildFrames(events), [events]);
  const total   = useMemo(() => duration(frames), [frames]);
  const summary = useMemo(() => summarise(events), [events]);
  const marks   = useMemo(() => buildMarks(events, {
    pasteMinChars: PASTE_MIN_CHARS,
    pasteMaxCharsPerSec: PASTE_MAX_CHARS_PER_SEC,
    idleGapMs: IDLE_GAP_MS,
  }), [events]);

  const frame = useMemo(() => frameAt(frames, t), [frames, t]);

  // Playback. An interval rather than rAF: this advances RECORDED time, not
  // animation time, and at 16× a frame-rate loop would skip whole edits
  // between paints without being any smoother to watch.
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setT((prev) => {
        const next = prev + TICK_MS * speed;
        if (next >= total) { setPlaying(false); return total; }
        return next;
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [playing, speed, total]);

  // ── Not loaded yet ────────────────────────────────────────────
  if (status === 'idle') {
    return (
      <button
        onClick={() => void load()}
        className="flex items-center gap-1.5 text-xs px-2 py-1"
        style={{
          border: '1px solid var(--ef-border)', borderRadius: 2,
          background: 'var(--ef-surface)', color: 'var(--ef-ink)', cursor: 'pointer',
        }}>
        <Film size={11} strokeWidth={1.5} />
        Show how this was written
      </button>
    );
  }

  if (status === 'loading') {
    return (
      <div className="flex items-center gap-2">
        <Loader2 size={11} className="animate-spin" style={{ color: 'var(--ef-text-muted)' }} />
        <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>Loading the recording…</span>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <p className="text-xs" style={{ color: 'var(--ef-danger)' }}>{error}</p>
    );
  }

  // NOT AN ERROR. Practice tiers never record, an institution may switch
  // recording off at the proctored tiers, and a candidate who never opened the
  // question produced no events. Saying "no recording" is the whole truth.
  if (events.length === 0) {
    return (
      <p className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
        No recording was made for this answer.
      </p>
    );
  }

  const broken = frame && !frame.reliability.ok;

  return (
    <div className="flex flex-col gap-2">
      {/* What happened, in numbers. Every one descriptive. */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: 'var(--ef-text-muted)' }}>
        <span>Worked for {clock(summary.activeMs)} of {clock(summary.spanMs)}</span>
        <span>{summary.typedChars.toLocaleString()} characters typed</span>
        <span>{summary.runs} run{summary.runs === 1 ? '' : 's'}</span>
        {summary.blurs > 0 && <span>{summary.blurs} × left the editor</span>}
        {summary.languageSwitches > 0 && <span>{summary.languageSwitches} × changed language</span>}
        {summary.pasteShaped > 0 && (
          // Worded as an observation, and coloured as one. The largest insert
          // is included because "3 large insertions" means something different
          // at 130 characters than at 3,000, and a reviewer should not have to
          // scrub the timeline to find out which they are looking at.
          <span style={{ color: 'var(--ef-warning)' }}>
            {summary.pasteShaped} large insertion{summary.pasteShaped === 1 ? '' : 's'}
            {' '}(largest {summary.largestInsert.toLocaleString()} chars)
          </span>
        )}
      </div>

      {/* Transport */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            if (t >= total) setT(0);
            setPlaying((p) => !p);
          }}
          className="flex items-center justify-center"
          style={{
            width: 22, height: 22, border: '1px solid var(--ef-border)', borderRadius: 2,
            background: 'var(--ef-surface)', color: 'var(--ef-ink)', cursor: 'pointer',
          }}
          title={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause size={10} strokeWidth={1.5} /> : <Play size={10} strokeWidth={1.5} />}
        </button>

        <span className="text-xs tabular-nums" style={{ color: 'var(--ef-text-muted)', minWidth: 74 }}>
          {clock(t)} / {clock(total)}
        </span>

        <input
          type="range"
          min={0}
          max={Math.max(1, total)}
          value={Math.min(t, total)}
          onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }}
          className="flex-1"
          style={{ accentColor: 'var(--ef-ink)', cursor: 'pointer' }}
          aria-label="Scrub the recording"
        />

        {SPEEDS.map((s) => (
          <button
            key={s}
            onClick={() => setSpeed(s)}
            className="text-xs px-1.5"
            style={{
              border: `1px solid ${speed === s ? 'var(--ef-ink)' : 'var(--ef-border)'}`,
              borderRadius: 2, background: speed === s ? 'var(--ef-ink)' : 'var(--ef-surface)',
              color: speed === s ? 'var(--ef-surface)' : 'var(--ef-text-muted)', cursor: 'pointer',
            }}>
            {s}×
          </button>
        ))}
      </div>

      {/* The moments worth jumping to. Nobody watches forty minutes of typing;
          a replay is used by moving between the few instants that carry
          information, so they are surfaced rather than left to be found. */}
      {marks.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {marks.map((m, i) => (
            <button
              key={`${m.index}-${i}`}
              onClick={() => { setPlaying(false); setT(m.t); }}
              className="text-xs px-1.5 py-0.5"
              style={{
                border: `1px solid ${MARK_COLOR[m.kind]}`, borderRadius: 2,
                background: 'var(--ef-surface)', color: MARK_COLOR[m.kind], cursor: 'pointer',
              }}
              title={`${clock(m.t)} — ${m.label}`}>
              {clock(m.t)} · {m.label}
            </button>
          ))}
        </div>
      )}

      {/* RECONSTRUCTION FAILURE IS STATED, NEVER PAPERED OVER. An edit applied
          to the wrong base still produces text, and that text is
          indistinguishable from a correct reconstruction to the person
          watching. Saying so is the only honest option. */}
      {broken && (
        <div className="flex items-start gap-2 px-2 py-1.5"
          style={{ background: 'var(--ef-warning-bg, #FFFBF0)', border: '1px solid var(--ef-warning-border)', borderRadius: 2 }}>
          <AlertTriangle size={11} strokeWidth={1.5} style={{ color: 'var(--ef-warning)', flexShrink: 0, marginTop: 2 }} />
          <p className="text-xs" style={{ color: 'var(--ef-warning)', lineHeight: 1.5 }}>
            {frame!.reliability.ok ? null : frame!.reliability.reason === 'no-keyframe'
              ? 'The recording does not say what the editor started with, so the text below is incomplete rather than wrong.'
              : 'Events are missing from this point, so the text below is not what the candidate saw. It becomes accurate again at the next language change.'}
          </p>
        </div>
      )}

      {/* The document at this instant. */}
      <pre className="text-xs px-2.5 py-2"
        style={{
          background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)', borderRadius: 2,
          color: broken ? 'var(--ef-text-muted)' : 'var(--ef-ink)', lineHeight: 1.55, margin: 0,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          overflowX: 'auto', minHeight: 80, maxHeight: '40vh', overflowY: 'auto',
        }}>
        {frame ? frame.doc : ''}
      </pre>

      <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.5 }}>
        A record of how this answer was written. It is descriptive, it is not
        evidence of anything on its own, and nothing here affects the mark.
      </p>
    </div>
  );
}
