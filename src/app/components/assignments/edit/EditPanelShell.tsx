import { ReactNode, useEffect, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '../../ui/sheet';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '../../ui/alert-dialog';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  dirty: boolean;
  saving: boolean;
  canSave: boolean;
  onSave: () => Promise<void> | void;
  children: ReactNode;
};

/** Shared right-side drawer for every focused edit panel.
 *  Handles dirty-state guard, save button, and consistent header/footer. */
export function EditPanelShell({
  open, onOpenChange, title, description, dirty, saving, canSave, onSave, children,
}: Props) {
  const [askDiscard, setAskDiscard] = useState(false);

  // Reset confirm state whenever the sheet closes externally
  useEffect(() => { if (!open) setAskDiscard(false); }, [open]);

  const requestClose = () => {
    if (dirty) setAskDiscard(true);
    else onOpenChange(false);
  };

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={(next) => { if (next) onOpenChange(true); else requestClose(); }}
      >
        <SheetContent side="right" className="w-full sm:max-w-[480px] flex flex-col p-0">
          <SheetHeader className="px-4 sm:px-6 pt-5 sm:pt-6 pb-4 pr-12" style={{ borderBottom: '1px solid var(--ef-border-subtle)' }}>
            <SheetTitle className="text-base break-words" style={{ color: 'var(--ef-ink)' }}>{title}</SheetTitle>
            {description && (
              <SheetDescription className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>
                {description}
              </SheetDescription>
            )}
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-5">{children}</div>

          <div
            className="flex items-center justify-end gap-2 px-4 sm:px-6 py-3 sm:py-4"
            style={{ borderTop: '1px solid var(--ef-border-subtle)', background: 'var(--ef-canvas-raised)' }}
          >
            <button
              onClick={requestClose}
              disabled={saving}
              className="text-xs px-3 py-1.5 transition-opacity hover:opacity-70 disabled:opacity-40"
              style={{ color: 'var(--ef-text-subtle)', border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}
            >
              Cancel
            </button>
            <button
              onClick={onSave}
              disabled={saving || !canSave || !dirty}
              className="text-xs px-4 py-1.5 transition-opacity hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2 }}
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog open={askDiscard} onOpenChange={setAskDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes?</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes in this panel. Closing will discard them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { setAskDiscard(false); onOpenChange(false); }}
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Small labelled section wrapper used inside panels. */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="mb-5">
      <label className="block text-xs mb-1.5" style={{ color: 'var(--ef-text-subtle)' }}>{label}</label>
      {children}
      {hint && <p className="text-xs mt-1" style={{ color: 'var(--ef-text-muted)' }}>{hint}</p>}
    </div>
  );
}
