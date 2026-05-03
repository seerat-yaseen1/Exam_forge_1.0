import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Users, UserMinus, UserPlus, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import {
  getMappingsByNode,
  deleteMapping,
  type NodeLevel,
  NODE_LEVEL_LABELS,
  type AcademicMapping,
} from '../../../lib/firebaseService';
import { StudentMappingDrawer } from './StudentMappingDrawer';

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
  const [mappings, setMappings]     = useState<AcademicMapping[]>([]);
  const [loading, setLoading]       = useState(false);
  const [collapsed, setCollapsed]   = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const levelLabel = NODE_LEVEL_LABELS[nodeType];

  // ── Fetch ─────────────────────────────────────────────────────────

  const fetch_ = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getMappingsByNode(nodeId);
      setMappings(data);
    } finally {
      setLoading(false);
    }
  }, [nodeId]);

  useEffect(() => { fetch_(); }, [fetch_]);

  // ── Remove mapping ────────────────────────────────────────────────

  const handleRemove = async (mappingId: string) => {
    setRemovingId(mappingId);
    try {
      await deleteMapping(mappingId);
      setMappings((prev) => prev.filter((m) => m.id !== mappingId));
    } finally {
      setRemovingId(null);
    }
  };

  // ── Drawer close → re-fetch ───────────────────────────────────────

  const handleDrawerClose = () => {
    setDrawerOpen(false);
    fetch_();
  };

  // In readOnly mode, hide the entire section if there are no students.
  if (readOnly && !loading && mappings.length === 0) return null;

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div className="mt-6">
      {/* Section header */}
      <div className="flex items-center justify-between mb-3">
        {/* Collapse toggle */}
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-2 select-none"
        >
          <span className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>
            STUDENTS AT THIS {levelLabel.toUpperCase()}
          </span>

          {!loading && mappings.length > 0 && (
            <span
              className="text-xs px-1.5 py-0.5"
              style={{ background: '#F0EFEB', color: '#9A9891', borderRadius: 10 }}
            >
              {mappings.length}
            </span>
          )}

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

              {/* Empty state */}
              {!loading && mappings.length === 0 && (
                <div className="flex flex-col items-center py-10">
                  <Users size={22} strokeWidth={1} style={{ color: '#DDDBD5' }} />
                  <p className="text-xs mt-3" style={{ color: '#C4C3BD' }}>
                    No students assigned directly to this {levelLabel.toLowerCase()}
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

              {/* Student rows */}
              {!loading &&
                mappings.map((m, index) => {
                  const isLast = index === mappings.length - 1;
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
                        <p className="text-sm" style={{ color: '#0C0C0B', lineHeight: 1.4 }}>
                          {m.studentName}
                        </p>
                        <p className="text-xs mt-0.5" style={{ color: '#9A9891' }}>
                          {m.studentEmail}
                        </p>
                      </div>

                      {/* Remove button — only when writable */}
                      {!readOnly && (
                        <button
                          onClick={() => handleRemove(m.id)}
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
