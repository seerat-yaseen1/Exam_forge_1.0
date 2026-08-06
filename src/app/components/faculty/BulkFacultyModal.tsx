import { useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  X, Download, Upload, AlertTriangle, Check, Loader2,
  CheckCircle2, XCircle, FileSpreadsheet, ArrowRight,
} from 'lucide-react';
import type { Faculty } from './AddFacultyDrawer';
import {
  generatePassword,
  getFaculty,
  type Faculty as FirebaseFaculty,
} from '../../../lib/firebaseService';
import { httpsCallable } from 'firebase/functions';
import { sendPasswordResetEmail } from 'firebase/auth';
import { auth, functions } from '../../../lib/firebase';

// ── Types ─────────────────────────────────────────────────────────

interface ParsedRow {
  index: number;
  name: string;
  email: string;
  valid: boolean;
  errors: string[];
}

interface BulkResult {
  email: string;
  name: string;
  success: boolean;
  error?: string;
  emailSent?: boolean;
}

type Step = 'upload' | 'preview' | 'creating' | 'results';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (faculties: Faculty[]) => void;
  instituteId: string;
  instituteName: string;
  existingEmails: Set<string>;
}

// ── Helpers ───────────────────────────────────────────────────────

function validateRows(rows: { name: string; email: string }[], existingEmails: Set<string>): ParsedRow[] {
  const seenInBatch = new Set<string>();
  return rows.map((row, i) => {
    const errors: string[] = [];
    const name = (row.name ?? '').trim();
    const email = (row.email ?? '').trim().toLowerCase();

    if (!name) errors.push('Name is required');
    if (!email) {
      errors.push('Email is required');
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push('Invalid email format');
    } else if (existingEmails.has(email)) {
      errors.push('Already registered in this institute');
    } else if (seenInBatch.has(email)) {
      errors.push('Duplicate in this upload');
    }

    if (email && !errors.find((e) => e.includes('email') || e.includes('Duplicate') || e.includes('registered'))) {
      seenInBatch.add(email);
    }

    return { index: i, name, email, valid: errors.length === 0, errors };
  });
}

// Lazy xlsx (Remediation plan Batch E / ext #19): the ~142 KB gzip sheet
// library loads on first actual use (template download / file parse /
// export), not with the page chunk that happens to render this component.
type XlsxModule = typeof import('xlsx');
let xlsxPromise: Promise<XlsxModule> | null = null;
const loadXlsx = () => (xlsxPromise ??= import('xlsx'));

async function downloadTemplate() {
  const XLSX = await loadXlsx();
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Name', 'Email'],
    ['Dr. Priya Sharma', 'priya.sharma@institute.edu'],
    ['Prof. Arjun Mehta', 'arjun.mehta@institute.edu'],
  ]);
  ws['!cols'] = [{ wch: 30 }, { wch: 36 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Faculty');
  XLSX.writeFile(wb, 'stratum_faculty_template.xlsx');
}

// ── Modal shell ───────────────────────────────────────────────────

export function BulkFacultyModal({
  open, onClose, onCreated, instituteId, instituteName, existingEmails,
}: Props) {
  const [step, setStep]           = useState<Step>('upload');
  const [rows, setRows]           = useState<ParsedRow[]>([]);
  const [fileName, setFileName]   = useState('');
  const [results, setResults]     = useState<BulkResult[]>([]);
  const [dragOver, setDragOver]   = useState(false);
  const [parseError, setParseError] = useState('');
  const [progress, setProgress]   = useState(0);
  const fileInputRef              = useRef<HTMLInputElement>(null);

  const reset = () => {
    setStep('upload'); setRows([]); setFileName('');
    setResults([]); setParseError(''); setProgress(0);
  };

  const handleClose = () => { reset(); onClose(); };

  const parseFile = useCallback(async (file: File) => {
    setParseError('');
    if (!file.name.match(/\.(csv|xlsx|xls)$/i)) {
      setParseError('Please upload a .csv or .xlsx file.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setParseError('File must be smaller than 5 MB.');
      return;
    }
    try {
      const buffer = await file.arrayBuffer();
      const XLSX = await loadXlsx();
      const wb = XLSX.read(buffer, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json<any>(ws, { defval: '' });

      if (raw.length === 0) { setParseError('The file contains no data rows.'); return; }
      if (raw.length > 500) { setParseError('Maximum 500 rows per upload.'); return; }

      const mapped = raw.map((r: any) => ({
        name: String(r.Name ?? r.name ?? r['Faculty Name'] ?? r['FACULTY NAME'] ?? ''),
        email: String(r.Email ?? r.email ?? r['Faculty Email'] ?? r['EMAIL'] ?? ''),
      }));

      const validated = validateRows(mapped, existingEmails);
      setRows(validated);
      setFileName(file.name);
      setStep('preview');
    } catch (err) {
      setParseError('Could not read file. Ensure it is a valid CSV or XLSX.');
    }
  }, [existingEmails]);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) parseFile(file);
    e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) parseFile(file);
  };

  const validRows = rows.filter((r) => r.valid);

  const handleCreate = async () => {
    if (validRows.length === 0) return;
    setStep('creating');
    setProgress(0);

    const bulkResults: BulkResult[] = [];
    const createdFaculties: Faculty[] = [];

    try {
      const progressIncrement = 100 / validRows.length;
      const createAuthUser = httpsCallable<
        { role: 'faculty'; password: string; instituteId: string; profile: Record<string, unknown> },
        { ok: boolean; uid: string }
      >(functions, 'createAuthUser');

      for (const row of validRows) {
        try {
          const tempPassword = generatePassword();
          const now = new Date().toISOString();

          const result = await createAuthUser({
            role: 'faculty',
            password: tempPassword,
            instituteId,
            profile: {
              email: row.email,
              name: row.name,
              instituteId,
              role: 'Faculty',
              status: 'active',
              firstLoginRequired: false,
              createdAt: now,
              updatedAt: now,
            },
          });

          let emailSent = false;
          try {
            await sendPasswordResetEmail(auth, row.email);
            emailSent = true;
          } catch (mailErr) {
            console.warn('[BulkFacultyModal] reset email failed for', row.email, ':', mailErr);
          }

          const created = (await getFaculty(result.data.uid)) as FirebaseFaculty | null;
          if (created) createdFaculties.push(created as Faculty);

          bulkResults.push({ email: row.email, name: row.name, success: true, emailSent });
          setProgress((prev) => Math.min(prev + progressIncrement, 100));
        } catch (error: any) {
          bulkResults.push({
            email: row.email,
            name: row.name,
            success: false,
            error: error?.message || 'Failed to create account',
          });
        }
      }

      setResults(bulkResults);
      setStep('results');

      if (createdFaculties.length > 0) {
        onCreated(createdFaculties);
      }
    } catch (err: any) {
      setResults([{ email: '—', name: '—', success: false, error: err.message }]);
      setStep('results');
    }
  };

  if (!open) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-60 flex items-center justify-center px-4"
        style={{ background: 'rgba(12,12,11,0.28)' }}
        onClick={handleClose}
      >
        <motion.div
          initial={{ scale: 0.97, opacity: 0, y: 8 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.97, opacity: 0, y: 8 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className="w-full flex flex-col"
          style={{
            maxWidth: step === 'preview' || step === 'results' ? 680 : 480,
            maxHeight: '88vh',
            background: 'var(--ef-surface)',
            border: '1px solid var(--ef-border)',
            borderRadius: 3,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* ── Header ── */}
          <div className="flex items-center justify-between px-6 py-4 flex-shrink-0"
            style={{ borderBottom: '1px solid var(--ef-border)' }}>
            <div>
              <p className="text-xs" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.1em' }}>
                {step === 'upload' && 'BULK ADD FACULTY'}
                {step === 'preview' && `PREVIEW — ${rows.length} ROW${rows.length !== 1 ? 'S' : ''} FOUND`}
                {step === 'creating' && 'CREATING ACCOUNTS'}
                {step === 'results' && 'RESULTS'}
              </p>
              <p className="text-sm mt-0.5" style={{ color: 'var(--ef-ink)' }}>{instituteName}</p>
            </div>
            <button onClick={handleClose} className="p-1 hover:opacity-60 transition-opacity" style={{ color: 'var(--ef-text-muted)' }}>
              <X size={14} strokeWidth={1.5} />
            </button>
          </div>

          {/* ── Step: Upload ── */}
          {step === 'upload' && (
            <div className="px-6 py-6 flex-1 overflow-y-auto">
              {/* Template download */}
              <div className="flex items-center justify-between mb-5 px-3 py-2.5"
                style={{ background: 'var(--ef-canvas)', border: '1px solid var(--ef-border)', borderRadius: 2 }}>
                <div className="flex items-center gap-2">
                  <FileSpreadsheet size={13} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)' }} />
                  <span className="text-xs" style={{ color: 'var(--ef-text-subtle)' }}>
                    Download the template before uploading
                  </span>
                </div>
                <button onClick={downloadTemplate}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 transition-colors"
                  style={{ border: '1px solid var(--ef-border)', color: 'var(--ef-text-subtle)', borderRadius: 2, background: 'var(--ef-surface)' }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.borderColor = 'var(--ef-ink)')}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.borderColor = 'var(--ef-border)')}>
                  <Download size={11} strokeWidth={1.5} />
                  Template
                </button>
              </div>

              {/* Drop zone */}
              <div
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                className="flex flex-col items-center justify-center py-14 cursor-pointer transition-all"
                style={{
                  border: `2px dashed ${dragOver ? 'var(--ef-ink)' : 'var(--ef-border)'}`,
                  background: dragOver ? 'var(--ef-canvas)' : 'var(--ef-canvas-raised)',
                  borderRadius: 3,
                }}
              >
                <Upload size={24} strokeWidth={1} style={{ color: dragOver ? 'var(--ef-ink)' : 'var(--ef-text-muted)', marginBottom: 12 }} />
                <p className="text-sm" style={{ color: dragOver ? 'var(--ef-ink)' : 'var(--ef-text-subtle)', fontWeight: dragOver ? 500 : 400 }}>
                  Drag & drop or click to upload
                </p>
                <p className="text-xs mt-1.5" style={{ color: 'var(--ef-text-muted)' }}>
                  CSV or XLSX · Max 500 rows · Max 5 MB
                </p>
              </div>
              <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={handleFileInput} />

              {parseError && (
                <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
                  className="flex items-start gap-2 mt-4 px-3 py-2.5"
                  style={{ background: 'var(--ef-danger-bg)', border: '1px solid var(--ef-danger-border)', borderRadius: 2 }}>
                  <AlertTriangle size={12} strokeWidth={1.5} style={{ color: 'var(--ef-danger)', marginTop: 1, flexShrink: 0 }} />
                  <p className="text-xs" style={{ color: 'var(--ef-danger)' }}>{parseError}</p>
                </motion.div>
              )}

              {/* Rules */}
              <div className="mt-5">
                <p className="text-xs mb-2" style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.06em' }}>REQUIREMENTS</p>
                {[
                  'Columns: Name, Email (case-insensitive headers)',
                  'Each row must have a unique email address',
                  'Emails already registered will be skipped',
                  'A password-setup link will be emailed to each member',
                ].map((r, i) => (
                  <div key={i} className="flex items-start gap-2 mb-1.5">
                    <div style={{ width: 4, height: 4, borderRadius: '50%', background: 'var(--ef-text-muted)', marginTop: 5, flexShrink: 0 }} />
                    <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>{r}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Step: Preview ── */}
          {step === 'preview' && (
            <>
              {/* Summary strip */}
              <div className="flex items-center gap-4 px-6 py-3 flex-shrink-0"
                style={{ background: 'var(--ef-canvas-raised)', borderBottom: '1px solid var(--ef-border)' }}>
                <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>File: <span style={{ color: 'var(--ef-text-subtle)' }}>{fileName}</span></span>
                <span style={{ color: 'var(--ef-border)' }}>·</span>
                <span className="text-xs" style={{ color: 'var(--ef-success)' }}>{validRows.length} valid</span>
                {rows.filter((r) => !r.valid).length > 0 && (
                  <>
                    <span style={{ color: 'var(--ef-border)' }}>·</span>
                    <span className="text-xs" style={{ color: 'var(--ef-danger)' }}>
                      {rows.filter((r) => !r.valid).length} will be skipped
                    </span>
                  </>
                )}
              </div>

              {/* Table */}
              <div className="flex-1 overflow-y-auto">
                <table className="w-full" style={{ borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: 'var(--ef-canvas-raised)', borderBottom: '1px solid var(--ef-border)' }}>
                      {['#', 'NAME', 'EMAIL', 'STATUS'].map((h, i) => (
                        <th key={i} className="text-left px-4 py-2.5 text-xs"
                          style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.07em', fontWeight: 400,
                            width: i === 0 ? '6%' : i === 1 ? '30%' : i === 2 ? '40%' : '24%' }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.index}
                        style={{
                          borderBottom: '1px solid var(--ef-border-subtle)',
                          background: row.valid ? 'transparent' : 'var(--ef-danger-bg)',
                        }}>
                        <td className="px-4 py-2.5">
                          <span className="text-xs" style={{ color: 'var(--ef-text-muted)' }}>{row.index + 1}</span>
                        </td>
                        <td className="px-4 py-2.5">
                          <p className="text-xs" style={{ color: row.valid ? 'var(--ef-ink)' : 'var(--ef-danger)' }}>
                            {row.name || <span style={{ color: 'var(--ef-text-muted)' }}>—</span>}
                          </p>
                        </td>
                        <td className="px-4 py-2.5">
                          <p className="text-xs" style={{
                            color: row.valid ? 'var(--ef-text-subtle)' : 'var(--ef-danger)',
                            fontFamily: row.valid ? 'monospace' : 'inherit',
                          }}>
                            {row.email || <span style={{ color: 'var(--ef-text-muted)' }}>—</span>}
                          </p>
                        </td>
                        <td className="px-4 py-2.5">
                          {row.valid ? (
                            <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--ef-success)' }}>
                              <CheckCircle2 size={11} strokeWidth={1.5} />
                              Valid
                            </span>
                          ) : (
                            <span className="text-xs" style={{ color: 'var(--ef-danger)' }}>
                              {row.errors[0]}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Footer */}
              <div className="flex items-center gap-3 px-6 py-4 flex-shrink-0"
                style={{ borderTop: '1px solid var(--ef-border)' }}>
                <button onClick={() => setStep('upload')}
                  className="text-xs px-4 py-2.5 transition-colors"
                  style={{ color: 'var(--ef-text-muted)', border: '1px solid var(--ef-border)', borderRadius: 2, background: 'var(--ef-surface)' }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--ef-canvas)')}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = 'var(--ef-surface)')}>
                  ← Back
                </button>
                {validRows.length > 0 && (
                  <button onClick={handleCreate}
                    className="flex items-center gap-1.5 text-xs px-4 py-2.5 transition-opacity"
                    style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2, letterSpacing: '0.03em' }}
                    onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.opacity = '0.85')}
                    onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.opacity = '1')}>
                    Grant access to {validRows.length} {validRows.length === 1 ? 'member' : 'members'}
                    <ArrowRight size={11} strokeWidth={1.5} />
                  </button>
                )}
                {validRows.length === 0 && (
                  <p className="text-xs" style={{ color: 'var(--ef-danger)' }}>
                    No valid rows to import. Fix the errors or upload a new file.
                  </p>
                )}
              </div>
            </>
          )}

          {/* ── Step: Creating ── */}
          {step === 'creating' && (
            <div className="flex flex-col items-center justify-center py-20 px-8 flex-1">
              <Loader2 size={28} strokeWidth={1} className="animate-spin mb-5" style={{ color: 'var(--ef-text-muted)' }} />
              <p className="text-sm" style={{ color: 'var(--ef-ink)' }}>
                Creating {validRows.length} faculty {validRows.length === 1 ? 'account' : 'accounts'}…
              </p>
              <p className="text-xs mt-1.5" style={{ color: 'var(--ef-text-muted)' }}>
                Emailing password-setup links. Please wait.
              </p>
              {/* Progress bar */}
              <div className="w-full mt-8" style={{ maxWidth: 280 }}>
                <div style={{ height: 2, background: 'var(--ef-border)', borderRadius: 1 }}>
                  <motion.div
                    style={{ height: 2, background: 'var(--ef-ink)', borderRadius: 1 }}
                    animate={{ width: `${progress}%` }}
                    transition={{ duration: 0.3 }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* ── Step: Results ── */}
          {step === 'results' && (
            <>
              {/* Summary */}
              <div className="flex items-center gap-4 px-6 py-3 flex-shrink-0"
                style={{ background: 'var(--ef-canvas-raised)', borderBottom: '1px solid var(--ef-border)' }}>
                {results.filter((r) => r.success).length > 0 && (
                  <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--ef-success)' }}>
                    <CheckCircle2 size={12} strokeWidth={1.5} />
                    {results.filter((r) => r.success).length} created
                  </span>
                )}
                {results.filter((r) => !r.success).length > 0 && (
                  <>
                    <span style={{ color: 'var(--ef-border)' }}>·</span>
                    <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--ef-danger)' }}>
                      <XCircle size={12} strokeWidth={1.5} />
                      {results.filter((r) => !r.success).length} failed
                    </span>
                  </>
                )}
              </div>

              {/* Results table */}
              <div className="flex-1 overflow-y-auto">
                <table className="w-full" style={{ borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: 'var(--ef-canvas-raised)', borderBottom: '1px solid var(--ef-border)' }}>
                      {['NAME', 'EMAIL', 'RESULT'].map((h, i) => (
                        <th key={i} className="text-left px-4 py-2.5 text-xs"
                          style={{ color: 'var(--ef-text-muted)', letterSpacing: '0.07em', fontWeight: 400,
                            width: i === 0 ? '30%' : i === 1 ? '40%' : '30%' }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((r, i) => (
                      <tr key={i}
                        style={{ borderBottom: '1px solid var(--ef-border-subtle)', background: r.success ? 'transparent' : 'var(--ef-danger-bg)' }}>
                        <td className="px-4 py-2.5">
                          <p className="text-xs" style={{ color: 'var(--ef-ink)' }}>{r.name}</p>
                        </td>
                        <td className="px-4 py-2.5">
                          <p className="text-xs" style={{ color: 'var(--ef-text-subtle)', fontFamily: 'monospace' }}>{r.email}</p>
                        </td>
                        <td className="px-4 py-2.5">
                          {r.success ? (
                            <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--ef-success)' }}>
                              <Check size={11} strokeWidth={2} />
                              Created
                            </span>
                          ) : (
                            <span className="text-xs" style={{ color: 'var(--ef-danger)' }}>{r.error ?? 'Failed'}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex justify-end px-6 py-4 flex-shrink-0"
                style={{ borderTop: '1px solid var(--ef-border)' }}>
                <button onClick={handleClose}
                  className="text-xs px-5 py-2.5 transition-opacity"
                  style={{ background: 'var(--ef-ink)', color: 'var(--ef-surface)', borderRadius: 2 }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.opacity = '0.85')}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.opacity = '1')}>
                  Done
                </button>
              </div>
            </>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}