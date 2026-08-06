import { ChevronRight } from 'lucide-react';
import { type NodeLevel } from '../../../lib/firebaseService';

export interface BreadcrumbNode {
  level: NodeLevel;
  id: string;
  name: string;
}

interface Props {
  stack: BreadcrumbNode[];
  onRoot: () => void;
  onCrumb: (index: number) => void;
}

export function HierarchyBreadcrumb({ stack, onRoot, onCrumb }: Props) {
  return (
    <div className="flex items-center flex-wrap gap-0.5 mb-5 select-none">
      <button
        onClick={onRoot}
        className="text-xs transition-colors px-1 py-0.5 rounded"
        style={{ color: stack.length === 0 ? 'var(--ef-ink)' : 'var(--ef-text-muted)', fontWeight: stack.length === 0 ? 500 : 400 }}
        onMouseEnter={(e) => { if (stack.length > 0) (e.currentTarget as HTMLElement).style.color = 'var(--ef-text-subtle)'; }}
        onMouseLeave={(e) => { if (stack.length > 0) (e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)'; }}
      >
        Schools
      </button>

      {stack.map((node, index) => {
        const isLast = index === stack.length - 1;
        return (
          <span key={node.id} className="flex items-center gap-0.5">
            <ChevronRight size={10} strokeWidth={1.5} style={{ color: '#D4D2CC' }} />
            <button
              onClick={() => { if (!isLast) onCrumb(index); }}
              className="text-xs px-1 py-0.5 rounded transition-colors"
              style={{
                color: isLast ? 'var(--ef-ink)' : 'var(--ef-text-muted)',
                fontWeight: isLast ? 500 : 400,
                cursor: isLast ? 'default' : 'pointer',
              }}
              onMouseEnter={(e) => { if (!isLast) (e.currentTarget as HTMLElement).style.color = 'var(--ef-text-subtle)'; }}
              onMouseLeave={(e) => { if (!isLast) (e.currentTarget as HTMLElement).style.color = 'var(--ef-text-muted)'; }}
            >
              {node.name}
            </button>
          </span>
        );
      })}
    </div>
  );
}
