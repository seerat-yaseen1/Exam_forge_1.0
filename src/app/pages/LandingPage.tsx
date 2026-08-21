/**
 * The Web Owner's overview.
 *
 * ── WHAT IT REPLACED ──────────────────────────────────────────────
 * An empty panel reading "Modules will appear here", under a comment calling
 * it "a system at rest is a system in control". It is the first screen the
 * person responsible for every institute on the platform sees, and it told
 * them nothing — so the first thing anyone did was leave it and go count
 * things by eye in the user-management table.
 *
 * ── WHAT IT LEADS WITH, AND WHY ───────────────────────────────────
 * Exceptions. An overview that gives equal weight to what is fine and what is
 * broken is one nobody reads twice, because the reader has to do the sorting
 * themselves every time. So: the fleet's headline numbers, then a list of
 * exactly the institutes that need a decision — expired first, then lapsing,
 * then disabled — and nothing else.
 *
 * When nothing needs attention the list is not an empty table. It says so, in
 * as many words, because "everything is fine" is the most useful thing this
 * page can ever tell someone and it should not look like a failure to load.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { motion } from 'motion/react';
import {
  Building2, CheckCircle2, ChevronRight, CircleSlash, Clock, Plus, RefreshCw,
  ShieldCheck, TrendingUp,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getAllInstitutes, type Institute } from '../../lib/firebaseService';
import {
  HEALTH_LABEL, HEALTH_TONE, expiryPhrase, summariseFleet,
} from '../../lib/fleetOverview';
import { formatDate } from '../../lib/dateFormat';
import {
  Button, Card, Chip, EmptyState, ErrorBanner, PageHeader, PageShell, SectionHeading,
  StatRow, StatTile,
} from '../components/console/ui';
import { Avatar, TableSkeleton } from '../components/console/data';

function greeting(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export function LandingPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [institutes, setInstitutes] = useState<Institute[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      setInstitutes(await getAllInstitutes());
    } catch (e: any) {
      console.error('[LandingPage] load error:', e);
      setError(e?.message || 'Could not load institutes.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const now = useMemo(() => Date.now(), [institutes]);
  const fleet = useMemo(() => summariseFleet(institutes, now), [institutes, now]);

  const firstName = user?.name?.split(' ')[0] ?? 'there';

  return (
    <PageShell>
      <PageHeader
        eyebrow={
          <>
            <span className="ef-eyebrow-dot" />
            {formatDate(new Date().toISOString())}
          </>
        }
        title={`${greeting(new Date().getHours())}, ${firstName}.`}
        subtitle={
          loading
            ? 'Checking every institute on the platform…'
            : fleet.needsAttention.length === 0
              ? `All ${fleet.total} institute${fleet.total === 1 ? '' : 's'} are in good standing.`
              : `${fleet.needsAttention.length} of ${fleet.total} institute${fleet.total === 1 ? '' : 's'} need${fleet.needsAttention.length === 1 ? 's' : ''} a decision.`
        }
        actions={
          <>
            <Button size="sm" onClick={() => load(true)} disabled={loading || refreshing}>
              <RefreshCw size={12} strokeWidth={1.7} className={refreshing ? 'animate-spin' : ''} />
              Refresh
            </Button>
            <Button size="sm" variant="primary" onClick={() => navigate('/dashboard/user-management')}>
              <Plus size={12} strokeWidth={1.9} />
              New institute
            </Button>
          </>
        }
      />

      {error && (
        <div className="mb-6">
          <ErrorBanner message={error} onRetry={() => load(true)} />
        </div>
      )}

      <div
        className="flex flex-col"
        style={{ gap: 30, opacity: refreshing ? 0.6 : 1, transition: 'opacity 200ms ease' }}
      >
        <section>
          <SectionHeading label="The platform" />
          <StatRow>
            <StatTile
              label="Institutes"
              value={loading ? '—' : fleet.total}
              icon={<Building2 size={13} strokeWidth={1.7} />}
              sub={loading ? 'loading' : `${fleet.operational} usable today`}
              hint="Every institute on the platform, whatever its state."
            />
            <StatTile
              label="Access lapsed"
              value={loading ? '—' : fleet.expired}
              icon={<CircleSlash size={13} strokeWidth={1.7} />}
              tone={fleet.expired > 0 ? 'danger' : undefined}
              sub={fleet.expired > 0 ? 'cannot sign in' : 'none'}
              hint="Their validity date has passed, so nobody at these institutes can sign in."
            />
            <StatTile
              label="Renewing soon"
              value={loading ? '—' : fleet.lapsing}
              icon={<Clock size={13} strokeWidth={1.7} />}
              tone={fleet.lapsing > 0 ? 'warning' : undefined}
              sub={fleet.lapsing > 0 ? 'within 30 days' : 'nothing due'}
              hint="Still working today. Far enough out that a renewal conversation can be unhurried."
            />
            <StatTile
              label="Disabled"
              value={loading ? '—' : fleet.disabled}
              icon={<ShieldCheck size={13} strokeWidth={1.7} />}
              sub={fleet.disabled > 0 ? 'switched off by an owner' : 'none'}
              hint="Turned off deliberately. Their validity date is not the reason and is not shown."
            />
          </StatRow>
        </section>

        <section>
          <SectionHeading
            label="Needs a decision"
            count={loading ? undefined : fleet.needsAttention.length || undefined}
            hint="Lapsed first, then renewing soonest."
            action={
              <Button size="sm" variant="ghost" onClick={() => navigate('/dashboard/user-management')}>
                All institutes
                <ChevronRight size={12} strokeWidth={1.7} />
              </Button>
            }
          />

          {loading ? (
            <TableSkeleton rows={3} columns={3} />
          ) : fleet.needsAttention.length === 0 ? (
            <EmptyState
              icon={<CheckCircle2 size={28} strokeWidth={1.1} />}
              title="Nothing needs you"
              body="Every institute is active and none is inside its renewal window. This list fills itself when that changes — there is nothing to check."
            />
          ) : (
            <div className="flex flex-col" style={{ gap: 'var(--ef-gap)' }}>
              {fleet.needsAttention.map(({ institute, health, days }, i) => (
                <motion.button
                  key={institute.id}
                  type="button"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.24, delay: Math.min(i, 6) * 0.04, ease: [0.16, 1, 0.3, 1] }}
                  onClick={() => navigate(`/dashboard/user-management/${institute.id}`)}
                  className="ef-card ef-card--interactive flex items-center gap-4 text-left"
                  style={{ padding: 'var(--ef-pad-card)' }}
                >
                  <span
                    className="ef-card-rail self-stretch"
                    style={{
                      background:
                        health === 'expired'
                          ? 'var(--ef-danger)'
                          : health === 'lapsing'
                            ? 'var(--ef-warning)'
                            : 'var(--ef-border-muted)',
                      marginLeft: 'calc(var(--ef-pad-card) * -1)',
                      marginBlock: 'calc(var(--ef-pad-card) * -1)',
                    }}
                  />
                  <Avatar name={institute.name} size={38} muted />

                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-2 flex-wrap">
                      <span className="ef-t-md ef-ink truncate" style={{ fontWeight: 500 }}>
                        {institute.name}
                      </span>
                      <Chip small tone={HEALTH_TONE[health]}>
                        {HEALTH_LABEL[health]}
                      </Chip>
                    </span>
                    <span className="ef-t-xs ef-muted block truncate" style={{ marginTop: 3 }}>
                      {institute.adminName} · {institute.adminEmail}
                    </span>

                    {/* On a phone the deadline moves INSIDE the card rather
                        than disappearing with the column that held it. It is
                        the reason the row is in this list at all — dropping
                        it at 390px would leave four cards that all look
                        equally urgent. */}
                    <span
                      className="ef-t-xs sm:hidden block"
                      style={{
                        marginTop: 5,
                        color: health === 'expired' ? 'var(--ef-danger)' : 'var(--ef-text-muted)',
                      }}
                    >
                      {health === 'disabled' ? 'Switched off' : expiryPhrase(days)}
                    </span>
                  </span>

                  {/* Wide screens get it as its own column, with the exact
                      date one hover away. */}
                  <span
                    className="ef-t-sm hidden sm:block flex-shrink-0"
                    style={{ color: health === 'expired' ? 'var(--ef-danger)' : 'var(--ef-text-muted)' }}
                    title={institute.activeUntil ? formatDate(institute.activeUntil) : undefined}
                  >
                    {health === 'disabled' ? 'Switched off' : expiryPhrase(days)}
                  </span>

                  <ChevronRight
                    size={16}
                    strokeWidth={1.7}
                    style={{ color: 'var(--ef-text-muted)', flexShrink: 0 }}
                  />
                </motion.button>
              ))}
            </div>
          )}
        </section>

        {!loading && fleet.total > 0 && (
          <p className="ef-t-xs ef-muted flex items-center justify-center gap-1.5 text-center">
            <TrendingUp size={12} strokeWidth={1.7} />
            {fleet.operational} of {fleet.total} institutes can be used right now
            {fleet.unbounded > 0 && ` · ${fleet.unbounded} with no expiry set`}
          </p>
        )}
      </div>
    </PageShell>
  );
}
