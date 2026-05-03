import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ChevronRight, Plus, Users, Archive, Pencil, Loader2,
  School, GraduationCap, BookOpen, Calendar, Hash,
  BookMarked, Layers, Group, AlertTriangle,
} from 'lucide-react';
import { type NodeLevel, NODE_LEVEL_LABELS } from '../../../lib/firebaseService';

export type HierarchyItem = {
  id: string;
  name: string;
  level: NodeLevel;
  subtitle?: string; // e.g. "Semester · 3"
  meta?: string;     // e.g. course code
};

const LEVEL_ICONS: Record<NodeLevel, React.ReactNode> = {
  school:          <School size={12} strokeWidth={1.5} />,
  academicLevel:   <GraduationCap size={12} strokeWidth={1.5} />,
  program:         <BookOpen size={12} strokeWidth={1.5} />,
  academicSession: <Calendar size={12} strokeWidth={1.5} />,
  academicYear:    <Hash size={12} strokeWidth={1.5} />,
  semester:        <Layers size={12} strokeWidth={1.5} />,
  course:          <BookMarked size={12} strokeWidth={1.5} />,
  section:         <Users size={12} strokeWidth={1.5} />,
  group:           <Group size={12} strokeWidth={1.5} />,
};

interface Props {
  level: NodeLevel;
  items: HierarchyItem[];
  loading: boolean;
  isLeaf?: boolean;
  sectionTitle?: string;
  addLabel?: string;
  readOnly?: boolean;
  onSelect?: (item: HierarchyItem) => void;
  onAdd: () => void;
  onEdit: (item: HierarchyItem) => void;
  onArchive: (id: string) => Promise<void>;
  onAssignStudents?: () => void;
}

function SkeletonRow() {
  return (
    <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid #F0EFEB' }}>
      <div className="flex items-center gap-3">
        <div className="w-3 h-3 rounded" style={{ background: '#EEECEA', animation: 'pulse 1.5s ease-in-out infinite' }} />
        <div className="h-3 w-36 rounded" style={{ background: '#EEECEA', animation: 'pulse 1.5s ease-in-out infinite' }} />
      </div>
      <div className="h-2.5 w-16 rounded" style={{ background: '#F3F2EF', animation: 'pulse 1.5s ease-in-out infinite' }} />
    </div>
  );
}

export function HierarchyPanel({
  level, items, loading, isLeaf = false,
  sectionTitle, addLabel,
  readOnly = false,
  onSelect, onAdd, onEdit, onArchive, onAssignStudents,
}: Props) {
  const [archiveConfirmId, setArchiveConfirmId] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);

  const label = sectionTitle ?? `${NODE_LEVEL_LABELS[level]}s`;
  const btnLabel = addLabel ?? `Add ${NODE_LEVEL_LABELS[level]}`;

  const handleArchive = async (id: string) => {
    setArchivingId(id);
    try {
      await onArchive(id);
    } finally {
      setArchivingId(null);
      setArchiveConfirmId(null);
    }
  };

  return (
    <div>
      {/* ── Section header ── */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.08em' }}>
            {label.toUpperCase()}
          </span>
          {!loading && items.length > 0 && (
            <span className="text-xs px-1.5 py-0.5" style={{ background: '#F0EFEB', color: '#9A9891', borderRadius: 10 }}>
              {items.length}
            </span>
          )}
        </div>
        {!readOnly && (
          <div className="flex items-center gap-2">
            {onAssignStudents && (
              <button
                onClick={onAssignStudents}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 transition-colors"
                style={{ border: '1px solid #E3E1DB', color: '#4A4A45', borderRadius: 2, background: '#FFFFFF' }}
                onMouseEnter={(e) => (e.currentTarget as HTMLElement).style.borderColor = '#0C0C0B'}
                onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.borderColor = '#E3E1DB'}
              >
                <Users size={10} strokeWidth={1.5} />Assign Students
              </button>
            )}
            <button
              onClick={onAdd}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 transition-opacity"
              style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2 }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.opacity = '0.8')}
              onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.opacity = '1')}
            >
              <Plus size={11} strokeWidth={2} />{btnLabel}
            </button>
          </div>
        )}
      </div>

      {/* ── Item list ── */}
      <div style={{ border: '1px solid #E3E1DB', borderRadius: 3, overflow: 'hidden', background: '#FFFFFF' }}>
        {loading && (
          <><SkeletonRow /><SkeletonRow /><SkeletonRow /></>
        )}

        {!loading && items.length === 0 && (
          <div className="flex flex-col items-center py-12">
            <div style={{ color: '#DDDBD5' }}>{LEVEL_ICONS[level]}</div>
            <p className="text-xs mt-3" style={{ color: '#C4C3BD', letterSpacing: '0.05em' }}>
              No {NODE_LEVEL_LABELS[level].toLowerCase()}s yet
            </p>
            {!readOnly && (
              <button
                onClick={onAdd}
                className="mt-4 flex items-center gap-1.5 text-xs px-3 py-2 transition-colors"
                style={{ border: '1px solid #E3E1DB', color: '#4A4A45', borderRadius: 2, background: '#FAFAF8' }}
                onMouseEnter={(e) => (e.currentTarget as HTMLElement).style.borderColor = '#0C0C0B'}
                onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.borderColor = '#E3E1DB'}
              >
                <Plus size={10} strokeWidth={2} />{btnLabel}
              </button>
            )}
          </div>
        )}

        <AnimatePresence initial={false}>
          {!loading && items.map((item, index) => {
            const isArchiveConfirm = archiveConfirmId === item.id;
            const isArchiving = archivingId === item.id;
            const isLast = index === items.length - 1;

            return (
              <motion.div
                key={item.id}
                layout
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className={`flex items-center justify-between px-4 ${!readOnly ? 'group' : ''}`}
                style={{
                  borderBottom: isLast ? 'none' : '1px solid #F0EFEB',
                  background: isArchiveConfirm ? '#FFFBF0' : 'transparent',
                  minHeight: 44,
                  transition: 'background 0.15s',
                }}
              >
                {/* ── Left: icon + name ── */}
                <button
                  onClick={() => !isLeaf && onSelect?.(item)}
                  disabled={isLeaf}
                  className="flex items-center gap-3 flex-1 text-left py-3"
                  style={{ cursor: isLeaf ? 'default' : 'pointer' }}
                >
                  <span style={{ color: '#C4C3BD', flexShrink: 0 }}>{LEVEL_ICONS[level]}</span>
                  <div className="min-w-0">
                    <span className="text-sm block truncate" style={{ color: '#0C0C0B' }}>
                      {item.name}
                    </span>
                    {(item.subtitle || item.meta) && (
                      <span className="text-xs" style={{ color: '#9A9891' }}>
                        {[item.subtitle, item.meta].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </div>
                </button>

                {/* ── Right: actions ── */}
                <div className="flex items-center gap-0.5 ml-4">
                  {readOnly ? (
                    /* Read-only: always-visible chevron to show the row is navigable */
                    !isLeaf && (
                      <span className="p-2" style={{ color: '#D4D2CC' }}>
                        <ChevronRight size={12} strokeWidth={1.5} />
                      </span>
                    )
                  ) : isArchiveConfirm ? (
                    <div className="flex items-center gap-2">
                      <AlertTriangle size={11} strokeWidth={1.5} style={{ color: '#8B5E1A' }} />
                      <span className="text-xs" style={{ color: '#8B5E1A' }}>Archive?</span>
                      <button
                        onClick={() => handleArchive(item.id)}
                        disabled={isArchiving}
                        className="flex items-center gap-1 text-xs px-2 py-1"
                        style={{ background: '#8B5E1A', color: '#FFFFFF', borderRadius: 2 }}
                      >
                        {isArchiving
                          ? <Loader2 size={9} className="animate-spin" />
                          : <Archive size={9} strokeWidth={2} />
                        }
                        Confirm
                      </button>
                      <button
                        onClick={() => setArchiveConfirmId(null)}
                        disabled={isArchiving}
                        className="text-xs px-2 py-1"
                        style={{ color: '#9A9891', border: '1px solid #E3E1DB', borderRadius: 2 }}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <>
                      {/* Edit */}
                      <button
                        onClick={() => onEdit(item)}
                        title="Edit"
                        className="p-2 opacity-0 group-hover:opacity-100 transition-all"
                        style={{ color: '#C4C3BD' }}
                        onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = '#4A4A45')}
                        onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = '#C4C3BD')}
                      >
                        <Pencil size={12} strokeWidth={1.5} />
                      </button>
                      {/* Archive */}
                      <button
                        onClick={() => setArchiveConfirmId(item.id)}
                        title="Archive"
                        className="p-2 opacity-0 group-hover:opacity-100 transition-all"
                        style={{ color: '#C4C3BD' }}
                        onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = '#8B5E1A')}
                        onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = '#C4C3BD')}
                      >
                        <Archive size={12} strokeWidth={1.5} />
                      </button>
                      {/* Chevron — only for non-leaf nodes */}
                      {!isLeaf && (
                        <span
                          className="p-2 opacity-0 group-hover:opacity-100 transition-all"
                          style={{ color: '#C4C3BD' }}
                        >
                          <ChevronRight size={12} strokeWidth={1.5} />
                        </span>
                      )}
                    </>
                  )}
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}