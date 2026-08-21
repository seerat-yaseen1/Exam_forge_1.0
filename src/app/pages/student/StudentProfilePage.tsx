import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useNavigate } from 'react-router';
import {
  BookOpen, Check, ChevronDown, ChevronRight, Copy, KeyRound, Loader2, Palette,
} from 'lucide-react';
import { useStudentAuth } from '../../context/StudentAuthContext';
import { useAppearance } from '../../context/AppearanceContext';
import {
  getMappingsByStudent, type AcademicMapping, NODE_LEVEL_LABELS,
} from '../../../lib/firebaseService';
import { formatDate } from '../../../lib/dateFormat';
import {
  Button, Card, Chip, PageHeader, PageShell, SectionHeading,
} from '../../components/console/ui';

// ── A labelled fact ───────────────────────────────────────────────

function Detail({
  label,
  value,
  mono = false,
  copyable = false,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  copyable?: string | false;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = async () => {
    if (!copyable) return;
    try {
      await navigator.clipboard.writeText(copyable);
      setCopied(true);
    } catch {
      /* Clipboard blocked (insecure context, or a permission the user denied).
         The value is on screen and selectable, so there is nothing to recover
         from and nothing worth interrupting them about. */
    }
  };

  return (
    <div>
      <p style={{ fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--ef-text-muted)' }}>
        {label}
      </p>
      <div className="flex items-center gap-2 mt-1.5">
        <span
          className="min-w-0 break-words"
          style={{
            fontSize: 14,
            color: 'var(--ef-ink)',
            fontFamily: mono ? 'ui-monospace, monospace' : undefined,
            letterSpacing: mono ? '0.1em' : undefined,
          }}
        >
          {value}
        </span>
        {copyable && (
          <button
            type="button"
            onClick={copy}
            className="ef-icon-btn"
            style={{ width: 24, height: 24 }}
            aria-label={copied ? 'Copied' : `Copy ${label.toLowerCase()}`}
            title={copied ? 'Copied' : 'Copy'}
          >
            {copied
              ? <Check size={12} strokeWidth={2.2} style={{ color: 'var(--ef-success)' }} />
              : <Copy size={12} strokeWidth={1.7} />}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Academic Structure section ────────────────────────────────────

function AcademicStructure({ studentId }: { studentId: string }) {
  const [mappings, setMappings] = useState<AcademicMapping[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getMappingsByStudent(studentId)
      .then((m) => { if (!cancelled) setMappings(m); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [studentId]);

  // Group by school name (top-level hierarchy grouping via breadcrumb prefix)
  const grouped = useMemo(() => {
    const map = new Map<string, AcademicMapping[]>();
    for (const m of mappings) {
      const parts = m.breadcrumb.split(' › ');
      // parts[0] = instituteName, parts[1] = school name (if present)
      const key = parts[1] ?? 'Unclassified';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(m);
    }
    return [...map.entries()];
  }, [mappings]);

  if (loading) {
    return (
      <Card>
        <span className="flex items-center gap-2" style={{ fontSize: 13, color: 'var(--ef-text-muted)' }}>
          <Loader2 size={13} strokeWidth={1.6} className="animate-spin" />
          Loading your academic structure…
        </span>
      </Card>
    );
  }

  if (mappings.length === 0) return null;

  return (
    <Card padded={false}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between select-none"
        style={{
          padding: 'var(--ef-pad-card)',
          background: 'transparent',
          border: 0,
          cursor: 'pointer',
          borderBottom: expanded ? '1px solid var(--ef-border-subtle)' : 'none',
        }}
        aria-expanded={expanded}
      >
        <span className="flex items-center gap-2.5">
          <BookOpen size={13} strokeWidth={1.6} style={{ color: 'var(--ef-text-muted)' }} />
          <span className="ef-eyebrow">Academic structure</span>
          <span className="ef-chip ef-chip--sm">{mappings.length}</span>
        </span>
        {expanded
          ? <ChevronDown size={14} strokeWidth={1.6} style={{ color: 'var(--ef-text-muted)' }} />
          : <ChevronRight size={14} strokeWidth={1.6} style={{ color: 'var(--ef-text-muted)' }} />}
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            style={{ overflow: 'hidden' }}
          >
            <div style={{ padding: 'var(--ef-pad-card)' }} className="flex flex-col gap-5">
              {grouped.map(([schoolName, schoolMappings]) => (
                <div key={schoolName}>
                  <p className="mb-2.5" style={{ fontSize: 13, color: 'var(--ef-text-subtle)', fontWeight: 500 }}>
                    {schoolName}
                  </p>
                  <div className="flex flex-col gap-2 pl-3.5" style={{ borderLeft: '2px solid var(--ef-border-subtle)' }}>
                    {schoolMappings.map((m) => (
                      <div key={m.id} className="flex items-start gap-2.5">
                        <Chip small>{NODE_LEVEL_LABELS[m.nodeType]}</Chip>
                        <div className="min-w-0">
                          <p style={{ fontSize: 13, color: 'var(--ef-ink)' }}>{m.nodeName}</p>
                          <p className="mt-0.5 break-all" style={{ fontSize: 12, color: 'var(--ef-text-muted)' }}>
                            {m.breadcrumb}
                          </p>
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
    </Card>
  );
}

// ── Main page ─────────────────────────────────────────────────────

export function StudentProfilePage() {
  const { session } = useStudentAuth();
  const { theme } = useAppearance();
  const navigate = useNavigate();

  if (!session) return null;

  const initials = session.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  const programTags: Array<[string, string[] | undefined]> = [
    ['Program', session.program],
    ['Degree level', session.degreeLevel],
    ['School', session.school],
    ['Specialisation', session.specialisation],
    ['Section', session.section],
    ['Group', session.group],
  ];
  const hasProgramTags = programTags.some(([, v]) => v?.length);

  return (
    <PageShell narrow>
      <PageHeader
        eyebrow={
          <>
            <span className="ef-eyebrow-dot" />
            Profile
          </>
        }
        title={session.name}
        subtitle={`Student at ${session.instituteName}`}
        actions={
          <>
            <Button size="sm" onClick={() => navigate('/student/appearance')}>
              <Palette size={11} strokeWidth={1.6} />
              {theme.label}
            </Button>
            <Button size="sm" onClick={() => navigate('/student/security')}>
              <KeyRound size={11} strokeWidth={1.6} />
              Password
            </Button>
          </>
        }
      >
        <div className="flex items-center gap-3">
          <span
            className="flex items-center justify-center flex-shrink-0"
            style={{
              width: 44, height: 44, borderRadius: '50%',
              background: 'var(--ef-accent)', color: 'var(--ef-accent-text)',
              fontSize: 15, fontWeight: 500, letterSpacing: '0.04em',
            }}
            aria-hidden="true"
          >
            {initials}
          </span>
          <div className="flex items-center gap-2 flex-wrap">
            <Chip tone={session.status === 'active' ? 'success' : 'muted'}>
              {session.status === 'active' ? 'Active' : 'Disabled'}
            </Chip>
            {session.createdAt && <Chip>Joined {formatDate(session.createdAt)}</Chip>}
          </div>
        </div>
      </PageHeader>

      <div className="flex flex-col" style={{ gap: 24 }}>
        <section>
          <SectionHeading label="Account" />
          <Card>
            <div className="grid gap-5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
              <Detail label="Full name" value={session.name} />
              <Detail label="Email address" value={session.email} copyable={session.email} />
              <Detail label="Institute" value={session.instituteName} />
              <Detail label="Institute code" value={session.instituteCode} mono copyable={session.instituteCode} />
            </div>
          </Card>
        </section>

        {/* Program metadata — only if any exists */}
        {hasProgramTags && (
          <section>
            <SectionHeading label="Program details" />
            <Card>
              <div className="flex flex-col" style={{ gap: 14 }}>
                {programTags.map(([label, values]) =>
                  values?.length ? (
                    <div key={label} className="flex items-start gap-3 flex-wrap">
                      <span
                        className="flex-shrink-0"
                        style={{
                          fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase',
                          color: 'var(--ef-text-muted)', width: 118, paddingTop: 3,
                        }}
                      >
                        {label}
                      </span>
                      <span className="flex items-center gap-1.5 flex-wrap flex-1" style={{ minWidth: 180 }}>
                        {values.map((v) => <Chip key={v}>{v}</Chip>)}
                      </span>
                    </div>
                  ) : null,
                )}
              </div>
            </Card>
          </section>
        )}

        {/* Academic Structure — live hierarchy mappings */}
        <section>
          <AcademicStructure studentId={session.studentId} />
        </section>

        <p style={{ fontSize: 13, color: 'var(--ef-text-muted)', lineHeight: 1.7 }}>
          Your name, email and placement are maintained by your institute — ask your administrator if
          any of it is wrong. Your password and the way this console looks are yours to change.
        </p>
      </div>
    </PageShell>
  );
}
