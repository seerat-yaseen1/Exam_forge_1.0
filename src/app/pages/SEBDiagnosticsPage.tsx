import { useState } from 'react';
import { Loader2, ShieldCheck, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { sebDiagnostics } from '../../lib/assessmentService';

// ══════════════════════════════════════════════════════════════════
// SEB Diagnostics (Phase 3, Stage 1) — webOwner only.
// Runs the sebDiagnostics callable from THIS browser. Open it inside Safe
// Exam Browser to discover whether SEB injects its ConfigKeyHash header into
// our callables, and which URL reconstruction reproduces the hash. Those
// facts pin the Stage 2 verification. Not a permanent feature — remove once
// enforcement is calibrated.
// ══════════════════════════════════════════════════════════════════

type Result = Awaited<ReturnType<typeof sebDiagnostics>>;

// Same-origin echo (Vercel /api/seb-echo). The cross-origin diagnostic proved
// SEB does not inject its header into calls to cloudfunctions.net; this checks
// whether it injects into a fetch() to our OWN origin, which is where Stage 2
// enforcement will have to live.
type EchoResult = {
  ok: true;
  where: string;
  sawAnySebHeader: boolean;
  sebHeaders: Record<string, string>;
  receivedConfigKeyHash: string | null;
  urlCandidates: Record<string, string>;
  matches: Record<string, boolean>;
  raw: Record<string, unknown>;
  userAgent: string | null;
};

export function SEBDiagnosticsPage() {
  const [key, setKey] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [echo, setEcho] = useState<EchoResult | null>(null);
  const [echoPost, setEchoPost] = useState<EchoResult | null>(null);
  const [echoRunning, setEchoRunning] = useState(false);
  const [echoError, setEchoError] = useState<string | null>(null);

  // Runs BOTH a GET and a POST. We proved SEB injects its header on a
  // same-origin GET; enforcement will use POST (constant URL → constant hash
  // target, and the attempt id travels in the body rather than the query
  // string). That the header also arrives on POST must be MEASURED, not
  // assumed — assuming is exactly what the cross-origin attempt got wrong.
  const runEcho = async () => {
    setEchoRunning(true);
    setEchoError(null);
    setEcho(null);
    setEchoPost(null);
    try {
      const qs = key.trim() ? `?candidateKey=${encodeURIComponent(key.trim())}` : '';
      const [g, p] = await Promise.all([
        fetch(`/api/seb-echo${qs}`, { cache: 'no-store' }),
        fetch(`/api/seb-echo${qs}`, {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ probe: 'post' }),
        }),
      ]);
      if (!g.ok) throw new Error(`GET failed: HTTP ${g.status} — is /api/seb-echo deployed?`);
      setEcho(await g.json());
      if (p.ok) setEchoPost(await p.json());
      else setEchoError(`POST returned HTTP ${p.status}`);
    } catch (e) {
      setEchoError((e as { message?: string })?.message ?? 'Same-origin check failed.');
    } finally {
      setEchoRunning(false);
    }
  };

  const run = async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const r = await sebDiagnostics(key.trim() || undefined);
      setResult(r);
    } catch (e) {
      setError((e as { message?: string })?.message ?? 'Failed to run diagnostic.');
    } finally {
      setRunning(false);
    }
  };

  const matchedForm = result
    ? Object.entries(result.matches).find(([, v]) => v)?.[0]
    : undefined;

  return (
    <div className="p-8" style={{ maxWidth: 820 }}>
      <div className="flex items-center gap-2 mb-1">
        <ShieldCheck size={18} strokeWidth={1.5} style={{ color: '#0C0C0B' }} />
        <h1 className="text-lg" style={{ color: '#0C0C0B' }}>SEB Diagnostics</h1>
      </div>
      <p className="text-xs mb-6" style={{ color: '#6B6B66', lineHeight: 1.7, maxWidth: 620 }}>
        Open this page <strong>inside Safe Exam Browser</strong> (via your <code>.seb</code> config
        file), paste the Config Key from the SEB Config Tool, and run the check. It reports what the
        server actually received, so enforcement can be built against reality rather than guesswork.
      </p>

      <label className="text-xs block mb-1.5" style={{ color: '#6B6B66' }}>
        Config Key (64 hex chars — optional, but needed for the match test)
      </label>
      <div className="flex items-center gap-2 mb-5">
        <input
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="e.g. 81aad4ab9dfd447cc479e6a4a7c9a544e2cafc7f3adeb68b2a21efad68eca4dc"
          className="flex-1 text-xs px-3 py-2 outline-none"
          style={{ border: '1px solid #E3E1DB', borderRadius: 2, color: '#0C0C0B', fontFamily: 'monospace' }}
        />
        <button
          onClick={run}
          disabled={running}
          className="flex items-center gap-1.5 text-xs px-4 py-2 flex-shrink-0"
          style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, cursor: running ? 'default' : 'pointer', opacity: running ? 0.5 : 1 }}
        >
          {running ? <><Loader2 size={12} className="animate-spin" /> Running…</> : 'Run SEB check'}
        </button>
        <button
          onClick={runEcho}
          disabled={echoRunning}
          className="flex items-center gap-1.5 text-xs px-4 py-2 flex-shrink-0"
          style={{ border: '1px solid #0C0C0B', color: '#0C0C0B', borderRadius: 2, cursor: echoRunning ? 'default' : 'pointer', opacity: echoRunning ? 0.5 : 1 }}
        >
          {echoRunning ? <><Loader2 size={12} className="animate-spin" /> Checking…</> : 'Same-origin check'}
        </button>
      </div>

      {/* Same-origin result — this is the one that matters now */}
      {echoError && (
        <div className="flex items-start gap-2 px-3 py-2.5 mb-4" style={{ background: '#FBF3F3', border: '1px solid #E3C9C9', borderRadius: 2 }}>
          <AlertTriangle size={13} strokeWidth={1.5} style={{ color: '#9B2828', marginTop: 1 }} />
          <span className="text-xs" style={{ color: '#9B2828' }}>{echoError}</span>
        </div>
      )}
      {echo && (
        <div className="mb-5">
          <div className="flex items-start gap-2 px-4 py-3 mb-2"
            style={{
              background: echo.sawAnySebHeader ? '#F0F9F4' : '#FEF9EC',
              border: `1px solid ${echo.sawAnySebHeader ? '#B8E6C8' : '#F5DFA0'}`,
              borderRadius: 2,
            }}>
            {echo.sawAnySebHeader
              ? <CheckCircle2 size={15} strokeWidth={1.5} style={{ color: '#1E7B3C', marginTop: 1 }} />
              : <AlertTriangle size={15} strokeWidth={1.5} style={{ color: '#92680A', marginTop: 1 }} />}
            <div>
              <p className="text-xs" style={{ color: echo.sawAnySebHeader ? '#1E7B3C' : '#92680A', fontWeight: 500 }}>
                SAME-ORIGIN GET (/api/seb-echo): {echo.sawAnySebHeader
                  ? 'SEB headers received.'
                  : 'No SEB headers.'}
              </p>
              {echoPost && (
                <p className="text-xs mt-1" style={{ color: echoPost.sawAnySebHeader ? '#1E7B3C' : '#9B2828', fontWeight: 500 }}>
                  SAME-ORIGIN POST: {echoPost.sawAnySebHeader
                    ? 'SEB headers received — POST is safe to build on.'
                    : 'NO headers on POST — enforcement must use GET.'}
                </p>
              )}
              {Object.entries(echo.matches).some(([, v]) => v) && (
                <p className="text-xs mt-1" style={{ color: '#1E7B3C' }}>
                  Hash reproduced by URL form: <strong>{Object.entries(echo.matches).find(([, v]) => v)?.[0]}</strong>
                </p>
              )}
            </div>
          </div>
          <p className="text-xs mb-1" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>GET RESULT</p>
          <pre className="text-xs p-3 overflow-auto mb-3"
            style={{ background: '#0C0C0B', color: '#E8E6E0', borderRadius: 2, maxHeight: 260, fontFamily: 'monospace', lineHeight: 1.5 }}>
            {JSON.stringify(echo, null, 2)}
          </pre>
          {echoPost && (
            <>
              <p className="text-xs mb-1" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>POST RESULT</p>
              <pre className="text-xs p-3 overflow-auto"
                style={{ background: '#0C0C0B', color: '#E8E6E0', borderRadius: 2, maxHeight: 260, fontFamily: 'monospace', lineHeight: 1.5 }}>
                {JSON.stringify(echoPost, null, 2)}
              </pre>
            </>
          )}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 px-3 py-2.5 mb-4" style={{ background: '#FBF3F3', border: '1px solid #E3C9C9', borderRadius: 2 }}>
          <AlertTriangle size={13} strokeWidth={1.5} style={{ color: '#9B2828', marginTop: 1 }} />
          <span className="text-xs" style={{ color: '#9B2828' }}>{error}</span>
        </div>
      )}

      {result && (
        <div className="flex flex-col gap-4">
          {/* Headline verdict */}
          <div className="flex items-start gap-2 px-4 py-3"
            style={{
              background: result.sawAnySebHeader ? '#F0F9F4' : '#FEF9EC',
              border: `1px solid ${result.sawAnySebHeader ? '#B8E6C8' : '#F5DFA0'}`,
              borderRadius: 2,
            }}>
            {result.sawAnySebHeader
              ? <CheckCircle2 size={15} strokeWidth={1.5} style={{ color: '#1E7B3C', marginTop: 1 }} />
              : <AlertTriangle size={15} strokeWidth={1.5} style={{ color: '#92680A', marginTop: 1 }} />}
            <div>
              <p className="text-xs" style={{ color: result.sawAnySebHeader ? '#1E7B3C' : '#92680A', fontWeight: 500 }}>
                {result.sawAnySebHeader
                  ? 'SEB headers received — header-based enforcement is viable.'
                  : 'No SEB headers received on this callable.'}
              </p>
              {!result.sawAnySebHeader && (
                <p className="text-xs mt-1" style={{ color: '#92680A', lineHeight: 1.6 }}>
                  Either this browser is not SEB, "Use Browser & Config Keys (send in HTTP header)"
                  is off in the config, or SEB does not inject headers into cross-origin callables.
                  If you ARE in SEB with the setting on, Stage 2 must verify at the app origin instead.
                </p>
              )}
              {matchedForm && (
                <p className="text-xs mt-1" style={{ color: '#1E7B3C', lineHeight: 1.6 }}>
                  Hash reproduced by URL form: <strong>{matchedForm}</strong> — this is what Stage 2 will hash.
                </p>
              )}
              {result.sawAnySebHeader && key && !matchedForm && (
                <p className="text-xs mt-1" style={{ color: '#92680A', lineHeight: 1.6 }}>
                  Header present but no URL form reproduced the hash with this key. Double-check the
                  Config Key, or the URL reconstruction needs another variant.
                </p>
              )}
            </div>
          </div>

          {/* Raw JSON — copy this back */}
          <div>
            <p className="text-xs mb-1.5" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>FULL RESULT (copy all of this)</p>
            <pre className="text-xs p-3 overflow-auto"
              style={{ background: '#0C0C0B', color: '#E8E6E0', borderRadius: 2, maxHeight: 460, fontFamily: 'monospace', lineHeight: 1.5 }}>
              {JSON.stringify(result, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}