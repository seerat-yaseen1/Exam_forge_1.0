import { useState } from 'react';
import { Pencil, FileText, Calendar, Users, Layers, Settings } from 'lucide-react';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '../../ui/dropdown-menu';
import { availablePanels, type PanelKey } from './useEditableFields';
import { DetailsPanel } from './DetailsPanel';
import { SchedulePanel } from './SchedulePanel';
import { AccessPanel } from './AccessPanel';
import { SectionsPanel } from './SectionsPanel';
import { BehaviourPanel } from './BehaviourPanel';
import type { Assessment } from '../../../../lib/assessmentService';

type Props = {
  assessment: Assessment;
  onPatched: (patch: Partial<Assessment>) => void;
  onOpenLegacyEditor: () => void;
};

const LABEL: Record<PanelKey, { label: string; Icon: any }> = {
  details:   { label: 'Details',           Icon: FileText },
  schedule:  { label: 'Schedule & attempts', Icon: Calendar },
  access:    { label: 'Access',            Icon: Users },
  sections:  { label: 'Sections & questions', Icon: Layers },
  behaviour: { label: 'Behaviour',         Icon: Settings },
};

export function EditMenu({ assessment, onPatched, onOpenLegacyEditor }: Props) {
  const [open, setOpen] = useState<PanelKey | null>(null);
  const panels = availablePanels(assessment.status);

  if (panels.length === 0) {
    return (
      <button
        title="Nothing to edit"
        disabled
        className="p-1.5 opacity-40 cursor-not-allowed"
        style={{ color: '#6B6B66' }}
      >
        <Pencil size={13} strokeWidth={1.5} />
      </button>
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            title="Edit"
            className="p-1.5 transition-opacity hover:opacity-60"
            style={{ color: '#6B6B66' }}
          >
            <Pencil size={13} strokeWidth={1.5} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[180px]">
          {panels.map((key) => {
            const { label, Icon } = LABEL[key];
            return (
              <DropdownMenuItem key={key} onClick={() => setOpen(key)}>
                <Icon size={12} strokeWidth={1.5} />
                <span>{label}</span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {open === 'details' && (
        <DetailsPanel
          assessment={assessment}
          open
          onOpenChange={(o) => !o && setOpen(null)}
          onSaved={onPatched}
        />
      )}
      {open === 'schedule' && (
        <SchedulePanel
          assessment={assessment}
          open
          onOpenChange={(o) => !o && setOpen(null)}
          onSaved={onPatched}
        />
      )}
      {open === 'access' && (
        <AccessPanel
          assessment={assessment}
          open
          onOpenChange={(o) => !o && setOpen(null)}
          onSaved={onPatched}
        />
      )}
      {open === 'sections' && (
        <SectionsPanel
          assessment={assessment}
          open
          onOpenChange={(o) => !o && setOpen(null)}
          onOpenLegacyEditor={onOpenLegacyEditor}
        />
      )}
      {open === 'behaviour' && (
        <BehaviourPanel
          assessment={assessment}
          open
          onOpenChange={(o) => !o && setOpen(null)}
          onSaved={onPatched}
        />
      )}
    </>
  );
}
