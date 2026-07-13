import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Users, UserMinus, UserPlus, ChevronDown, ChevronUp, Loader2, CornerDownRight } from 'lucide-react';
import {
  getStudentsAtOrBelowNode,
  deleteMapping,
  type NodeLevel,
  NODE_LEVEL_LABELS,
  type RosterMember,
} from '../../../lib/firebaseService';
import { StudentMappingDrawer } from './StudentMappingDrawer';

// Levels at/below section load their roster eagerly (small lists). Year and
// above are lazy — count + list load only when the admin expands, so opening a
// Program/School node never triggers a heavy descendant walk unprompted.
const EAGER_LEVELS: NodeLevel[] = ['section', 'group'];

// ── Types ───────────────────────────────────────────────────────────

interface Props {
  nodeId: string;
  nodeName: string;
  nodeType: NodeLevel;
  breadcrumb: string;
  instituteId: string;
  readOnly?: boolean;
}

// ── Component ───────────────────────────────────────────────────────

export function NodeStudentRoster({
  nodeId,
  nodeName,
  nodeType,
  breadcrumb,
  instituteId,
  readOnly = false,
}: Props) {
  const [members, setMembers]       = useState<RosterMember[]>([]);
  const [loading, setLoading]       = useState(false);
  const [loaded, setLoaded]         = useState(false);
  const [collapsed, setCollapsed]   = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [inheritedNotice, setInheritedNotice] = useState<string | null>(null);

  const levelLabel = NODE_LEVEL_LABELS[nodeType];
  const isEager = EAGER_LEVELS.includes(nodeType);

  const directCount = members.filter((m) => m.membership === 'direct').length;
  const inheritedMembers = members.filter((m) => m.membership === 'inherited');

  // ── Fetch (direct + inherited via descendant walk) ────────────────

  const fetch_ = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getStudentsAtOrBelowNode(nodeId, nodeType);
      setMembers(data);
      setLoaded(true);
    } finally {
      setLoading(false);
    }
  }, [nodeId, nodeType]);

  // Eager levels load on mount; lazy levels wait for an explicit expand.
  useEffect(() => {
    setMembers([]);
    setLoaded(false);
    if (isEager) fetch_();
  }, [fetch_, isEager]);

  const ensureLoaded = () => { if (!loaded && !loading) fetch_(); };

  // ── Remove mapping ────────────────────────────────────────────────

  const handleRemove = async (member: RosterMember) => {
    if (member.membership !== 'direct') {
      // Inherited membership lives at a descendant node — direct the admin there.
      setInheritedNotice(
        `${member.studentName} is here via ${member.breadcrumb.split(' › ').slice(-1)[0] || 'a lower node'}. Remove them at that node.`,
      );
      setTimeout(() => setInheritedNotice(null), 4000);
      return;
    }
    setRemovingId(member.id);
    try {
      await deleteMapping(member.id);
      setMembers((prev) => prev.filter((m) => m.id !== member.id));
    } finally {
      setRemovingId(null);
    }
  };

  // ── Drawer close → re-fetch ───────────────────────────────────────

  const handleDrawerClose = () => {
    setDrawerOpen(false);
    fetch_();
  };

  // In readOnly mode on an EAGER level with no students, hide entirely.
  // (Lazy levels can't know their count without loading, so they always show.)
  if (readOnly && isEager && loaded && members.length === 0) return null;

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      if (!next) ensureLoaded(); // expanding a lazy level triggers the walk
      return next;
    });
  };

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div className="mt-6">
      {/* Section header */}
      <div className="flex items-center justify-between mb-3">
        {/* Collapse toggle */}
        <button
          onClick={toggleCollapsed}
          className="flex items-center gap-2 select-none"
        >
          <span className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>
            STUDENTS AT OR BELOW THIS {levelLabel.toUpperCase()}
          </span>

          {loaded && !loading && members.length > 0 && (
            <span
              className="text-xs px-1.5 py-0.5"
              style={{ background: '#F0EFEB', color: '#9A9891', borderRadius: 10 }}
              title={`${directCount} directly assigned · ${inheritedMembers.length} inherited from below`}
            >
              {members.length}
            </span>
          )}
          {!loaded && !loading && !isEager && (
            <span className="text-xs" style={{ color: '#C4C3BD' }}>— tap to load</span>
          )}
          {loading && <Loader2 size={11} className="animate-spin" style={{ color: '#C4C3BD' }} />}

          <span style={{ color: '#C4C3BD' }}>
            {collapsed
              ? <ChevronDown size={12} strokeWidth={1.5} />
              : <ChevronUp size={12} strokeWidth={1.5} />}
          </span>
        </button>

        {/* Manage button — only when writable */}
        {!readOnly && (
          <button
            onClick={() => setDrawerOpen(true)}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 transition-colors"
            style={{ border: '1px solid #E3E1DB', color: '#4A4A45', borderRadius: 2, background: '#FFFFFF' }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.borderColor = '#0C0C0B')}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.borderColor = '#E3E1DB')}
          >
            <UserPlus size={10} strokeWidth={1.5} />
            Manage Assignments
          </button>
        )}
      </div>

      {/* Collapsible body */}
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            key="roster-body"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            style={{ overflow: 'hidden' }}
          >
            <div
              style={{
                border: '1px solid #E3E1DB',
                borderRadius: 3,
                overflow: 'hidden',
                background: '#FFFFFF',
              }}
            >
              {/* Loading */}
              {loading && (
                <div className="flex items-center justify-center py-8">
                  <Loader2
                    size={16}
                    strokeWidth={1}
                    className="animate-spin"
                    style={{ color: '#C4C3BD' }}
                  />
                </div>
              )}

              {/* Lazy level, expanded but not yet loaded */}
              {!loading && !loaded && !isEager && (
                <button onClick={ensureLoaded}
                  className="w-full flex items-center justify-center gap-1.5 py-8 text-xs transition-colors hover:bg-[#FAFAF8]"
                  style={{ color: '#9A9891' }}>
                  <Users size={13} strokeWidth={1.5} />
                  Load students at or below this {levelLabel.toLowerCase()}
                </button>
              )}

              {/* Inherited-remove notice */}
              {inheritedNotice && (
                <div className="px-4 py-2 text-xs" style={{ background: '#FBF7EC', color: '#7A6420', borderBottom: '1px solid #F0EFEB' }}>
                  {inheritedNotice}
                </div>
              )}

              {/* Empty state */}
              {loaded && !loading && members.length === 0 && (
                <div className="flex flex-col items-center py-10">
                  <Users size={22} strokeWidth={1} style={{ color: '#DDDBD5' }} />
                  <p className="text-xs mt-3" style={{ color: '#C4C3BD' }}>
                    No students at or below this {levelLabel.toLowerCase()}
                  </p>
                  {!readOnly && (
                    <button
                      onClick={() => setDrawerOpen(true)}
                      className="mt-3 flex items-center gap-1.5 text-xs px-3 py-1.5 transition-colors"
                      style={{
                        border: '1px solid #E3E1DB',
                        color: '#4A4A45',
                        borderRadius: 2,
                        background: '#FAFAF8',
                      }}
                      onMouseEnter={(e) =>
                        ((e.currentTarget as HTMLElement).style.borderColor = '#0C0C0B')
                      }
                      onMouseLeave={(e) =>
                        ((e.currentTarget as HTMLElement).style.borderColor = '#E3E1DB')
                      }
                    >
                      <UserPlus size={10} strokeWidth={1.5} />
                      Assign students
                    </button>
                  )}
                </div>
              )}

              {/* Student rows — direct first, then inherited (read-only) */}
              {!loading &&
                members.map((m, index) => {
                  const isLast = index === members.length - 1;
                  const inherited = m.membership === 'inherited';
                  const via = m.breadcrumb.split(' › ').slice(-1)[0] || '';
                  return (
                    <motion.div
                      key={m.id}
                      layout
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.12 }}
                      className="flex items-center justify-between px-4 py-3"
                      style={{ borderBottom: isLast ? 'none' : '1px solid #F0EFEB' }}
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-sm flex items-center gap-1.5" style={{ color: '#0C0C0B', lineHeight: 1.4 }}>
                          {m.studentName}
                          {inherited && (
                            <span className="inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5"
                              style={{ background: '#F4F3EF', color: '#9A9891', borderRadius: 3 }}
                              title={m.breadcrumb}>
                              <CornerDownRight size={9} strokeWidth={1.5} /> via {via}
                            </span>
                          )}
                        </p>
                        <p className="text-xs mt-0.5" style={{ color: '#9A9891' }}>
                          {m.studentEmail}
                        </p>
                      </div>

                      {/* Remove — direct rows only; inherited rows redirect to their node */}
                      {!readOnly && !inherited && (
                        <button
                          onClick={() => handleRemove(m)}
                          disabled={removingId === m.id}
                          title="Remove assignment"
                          className="ml-3 p-1.5 transition-colors flex-shrink-0"
                          style={{ color: '#C4C3BD' }}
                          onMouseEnter={(e) =>
                            ((e.currentTarget as HTMLElement).style.color = '#9B2828')
                          }
                          onMouseLeave={(e) =>
                            ((e.currentTarget as HTMLElement).style.color = '#C4C3BD')
                          }
                        >
                          {removingId === m.id ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <UserMinus size={12} strokeWidth={1.5} />
                          )}
                        </button>
                      )}
                    </motion.div>
                  );
                })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* StudentMappingDrawer — managed internally */}
      {!readOnly && (
        <StudentMappingDrawer
          open={drawerOpen}
          nodeId={nodeId}
          nodeType={nodeType}
          nodeName={nodeName}
          breadcrumb={breadcrumb}
          instituteId={instituteId}
          onClose={handleDrawerClose}
        />
      )}
    </div>
  );
}