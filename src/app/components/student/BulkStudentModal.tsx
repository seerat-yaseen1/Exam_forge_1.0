import { useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import * as XLSX from 'xlsx';
import {
  X, Download, Upload, AlertTriangle, Check, Loader2,
  CheckCircle2, XCircle, FileSpreadsheet, ArrowRight,
} from 'lucide-react';
import type { Student } from './AddStudentDrawer';
import {
  setStudent,
  setStudentCredentials,
  generatePassword,
  type Student as FirebaseStudent,
  type StudentCredentials
} from '../../../lib/firebaseService';
import { sendStudentWelcomeEmail } from '../../../lib/emailService';

// ── Types ─────────────────────────────────────────────────────────

interface ParsedRow {
  index: number;
  name: string;
  email: string;
  group?: string;
  section?: string;
  specialisation?: string;
  program?: string;
  degreeLevel?: string;
  school?: string;
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
  onCreated: (students: Student[]) => void;
  instituteId: string;
  instituteName: string;
  existingEmails: Set<string>;
}

// ── Helpers ───────────────────────────────────────────────────────

function validateRows(rows: Record<string, any>[], existingEmails: Set<string>): ParsedRow[] {
  const seenInBatch = new Set<string>();
  return rows.map((row, i) => {
    const errors: string[] = [];
    const name  = (row.Name ?? row.name ?? row['Student Name'] ?? '').toString().trim();
    const email = (row.Email ?? row.email ?? row['Student Email'] ?? '').toString().trim().toLowerCase();

    if (!name)  errors.push('Name is required');
    if (!email) {
      errors.push('Email is required');
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push('Invalid email format');
    } else if (existingEmails.has(email)) {
      errors.push('Already registered in this institute');
    } else if (seenInBatch.has(email)) {
      errors.push('Duplicate in this upload');
    }

    if (email && errors.length === 0) seenInBatch.add(email);

    const str = (key: string) => {
      const v = (row[key] ?? '').toString().trim();
      return v || undefined;
    };

    return {
      index: i, name, email, valid: errors.length === 0, errors,
      group:          str('Group'),
      section:        str('Section'),
      specialisation: str('Specialisation'),
      program:        str('Program'),
      degreeLevel:    str('Degree Level'),
      school:         str('School'),
    };
  });
}

function downloadTemplate() {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['Name', 'Email', 'Program', 'Degree Level', 'School', 'Group', 'Section', 'Specialisation'],
    ['Arjun Mehta',    'arjun.mehta@student.edu',    'Computer Science', 'Undergraduate', 'School of Engineering', 'Group A', 'Section 1', 'Data Science'],
    ['Priya Kapoor',   'priya.kapoor@student.edu',   'Business Admin',   'Postgraduate',  'School of Management',  'Group B', 'Section 2', 'Finance'],
  ]);
  ws['!cols'] = [
    { wch: 26 }, { wch: 34 }, { wch: 22 }, { wch: 18 },
    { wch: 26 }, { wch: 14 }, { wch: 14 }, { wch: 20 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Students');
  XLSX.writeFile(wb, 'stratum_student_template.xlsx');
}

// ── Modal ─────────────────────────────────────────────────────────

export function BulkStudentModal({ open, onClose, onCreated, instituteId, instituteName, existingEmails }: Props) {
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
      const wb = XLSX.read(buffer, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const raw = XLSX.utils.sheet_to_json<any>(ws, { defval: '' });
      if (raw.length === 0) { setParseError('The file contains no data rows.'); return; }
      if (raw.length > 500) { setParseError('Maximum 500 rows per upload.'); return; }
      const validated = validateRows(raw, existingEmails);
      setRows(validated);
      setFileName(file.name);
      setStep('preview');
    } catch {
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
    setStep('creating'); setProgress(0);

    const bulkResults: BulkResult[] = [];
    const createdStudents: Student[] = [];

    try {
      const progressIncrement = 100 / validRows.length;

      for (const row of validRows) {
        try {
          const studentId = `std_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          const password = generatePassword();
          const now = new Date().toISOString();

          // Parse metadata into arrays (split by comma if present)
          const parseMetadata = (val?: string): string[] | undefined => {
            if (!val) return undefined;
            const items = val.split(',').map((s) => s.trim()).filter(Boolean);
            return items.length > 0 ? items : undefined;
          };

          const student: FirebaseStudent = {
            id: studentId,
            instituteId,
            name: row.name,
            email: row.email,
            role: 'Student',
            status: 'active',
            firstLoginRequired: true,
            ...(parseMetadata(row.group) && { group: parseMetadata(row.group) }),
            ...(parseMetadata(row.section) && { section: parseMetadata(row.section) }),
            ...(parseMetadata(row.specialisation) && { specialisation: parseMetadata(row.specialisation) }),
            ...(parseMetadata(row.program) && { program: parseMetadata(row.program) }),
            ...(parseMetadata(row.degreeLevel) && { degreeLevel: parseMetadata(row.degreeLevel) }),
            ...(parseMetadata(row.school) && { school: parseMetadata(row.school) }),
            createdAt: now,
            updatedAt: now,
          };

          const credentials: StudentCredentials = {
            studentId,
            email: row.email,
            password,
            firstLoginRequired: true,
          };

          await setStudent(studentId, student);
          await setStudentCredentials(studentId, credentials);

          // Send welcome email with credentials
          const emailResult = await sendStudentWelcomeEmail(student, instituteName, password);
          if (!emailResult.ok) console.warn('[BulkStudentModal] email failed for', row.email, ':', emailResult.error);

          bulkResults.push({
            email: row.email,
            name: row.name,
            success: true,
            emailSent: emailResult.ok,
          });

          createdStudents.push(student);
          setProgress((prev) => Math.min(prev + progressIncrement, 100));
        } catch (error: any) {
          bulkResults.push({
            email: row.email,
            name: row.name,
            success: false,
            error: error.message || 'Failed to create account',
          });
        }
      }

      setResults(bulkResults);
      setStep('results');

      if (createdStudents.length > 0) {
        onCreated(createdStudents);
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
            maxWidth: step === 'preview' || step === 'results' ? 720 : 480,
            maxHeight: '88vh',
            background: '#FFFFFF', border: '1px solid #E3E1DB', borderRadius: 3,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 flex-shrink-0"
            style={{ borderBottom: '1px solid #E3E1DB' }}>
            <div>
              <p className="text-xs" style={{ color: '#9A9891', letterSpacing: '0.1em' }}>
                {step === 'upload'   && 'BULK ADD STUDENTS'}
                {step === 'preview'  && `PREVIEW — ${rows.length} ROW${rows.length !== 1 ? 'S' : ''} FOUND`}
                {step === 'creating' && 'CREATING ACCOUNTS'}
                {step === 'results'  && 'RESULTS'}
              </p>
              <p className="text-sm mt-0.5" style={{ color: '#0C0C0B' }}>{instituteName}</p>
            </div>
            <button onClick={handleClose} className="p-1 hover:opacity-60 transition-opacity" style={{ color: '#9A9891' }}>
              <X size={14} strokeWidth={1.5} />
            </button>
          </div>

          {/* ── Upload ── */}
          {step === 'upload' && (
            <div className="px-6 py-6 flex-1 overflow-y-auto">
              {/* Template download */}
              <div className="flex items-center justify-between mb-5 px-3 py-2.5"
                style={{ background: '#F7F6F3', border: '1px solid #E3E1DB', borderRadius: 2 }}>
                <div className="flex items-center gap-2">
                  <FileSpreadsheet size={13} strokeWidth={1.5} style={{ color: '#9A9891' }} />
                  <span className="text-xs" style={{ color: '#4A4A45' }}>Download the student template before uploading</span>
                </div>
                <button onClick={downloadTemplate}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 transition-colors"
                  style={{ border: '1px solid #E3E1DB', color: '#4A4A45', borderRadius: 2, background: '#FFFFFF' }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.borderColor = '#0C0C0B')}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.borderColor = '#E3E1DB')}>
                  <Download size={11} strokeWidth={1.5} />Template
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
                  border: `2px dashed ${dragOver ? '#0C0C0B' : '#E3E1DB'}`,
                  background: dragOver ? '#F7F6F3' : '#FAFAF8', borderRadius: 3,
                }}>
                <Upload size={24} strokeWidth={1} style={{ color: dragOver ? '#0C0C0B' : '#C4C3BD', marginBottom: 12 }} />
                <p className="text-sm" style={{ color: dragOver ? '#0C0C0B' : '#4A4A45' }}>
                  Drag & drop or click to upload
                </p>
                <p className="text-xs mt-1.5" style={{ color: '#B0AEA8' }}>CSV or XLSX · Max 500 rows · Max 5 MB</p>
              </div>
              <input ref={fileInputRef} type="file" accept=".csv,.xlsx,.xls" className="hidden" onChange={handleFileInput} />

              {parseError && (
                <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
                  className="flex items-start gap-2 mt-4 px-3 py-2.5"
                  style={{ background: '#FDF5F5', border: '1px solid #F2CECE', borderRadius: 2 }}>
                  <AlertTriangle size={12} strokeWidth={1.5} style={{ color: '#9B2828', marginTop: 1, flexShrink: 0 }} />
                  <p className="text-xs" style={{ color: '#9B2828' }}>{parseError}</p>
                </motion.div>
              )}

              <div className="mt-5">
                <p className="text-xs mb-2" style={{ color: '#9A9891', letterSpacing: '0.06em' }}>REQUIRED COLUMNS</p>
                {['Name, Email (mandatory)', 'Program, Degree Level, School, Group, Section, Specialisation (all optional)'].map((r, i) => (
                  <div key={i} className="flex items-start gap-2 mb-1.5">
                    <div style={{ width: 4, height: 4, borderRadius: '50%', background: '#C4C3BD', marginTop: 5, flexShrink: 0 }} />
                    <p className="text-xs" style={{ color: '#9A9891', lineHeight: 1.6 }}>{r}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Preview ── */}
          {step === 'preview' && (
            <>
              <div className="flex items-center gap-4 px-6 py-3 flex-shrink-0"
                style={{ background: '#FAFAF8', borderBottom: '1px solid #E3E1DB' }}>
                <span className="text-xs" style={{ color: '#9A9891' }}>File: <span style={{ color: '#4A4A45' }}>{fileName}</span></span>
                <span style={{ color: '#E3E1DB' }}>·</span>
                <span className="text-xs" style={{ color: '#2A6B3A' }}>{validRows.length} valid</span>
                {rows.filter((r) => !r.valid).length > 0 && (
                  <>
                    <span style={{ color: '#E3E1DB' }}>·</span>
                    <span className="text-xs" style={{ color: '#9B2828' }}>
                      {rows.filter((r) => !r.valid).length} will be skipped
                    </span>
                  </>
                )}
              </div>

              <div className="flex-1 overflow-y-auto">
                <table className="w-full" style={{ borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#FAFAF8', borderBottom: '1px solid #E3E1DB' }}>
                      {['#', 'NAME', 'EMAIL', 'PROGRAM', 'DEGREE', 'STATUS'].map((h, i) => (
                        <th key={i} className="text-left px-4 py-2.5 text-xs"
                          style={{ color: '#9A9891', letterSpacing: '0.07em', fontWeight: 400 }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.index}
                        style={{ borderBottom: '1px solid #F0EFEB', background: row.valid ? 'transparent' : '#FDF5F5' }}>
                        <td className="px-4 py-2.5">
                          <span className="text-xs" style={{ color: '#C4C3BD' }}>{row.index + 1}</span>
                        </td>
                        <td className="px-4 py-2.5">
                          <p className="text-xs" style={{ color: row.valid ? '#0C0C0B' : '#9B2828' }}>
                            {row.name || '—'}
                          </p>
                        </td>
                        <td className="px-4 py-2.5">
                          <p className="text-xs" style={{
                            color: row.valid ? '#4A4A45' : '#9B2828',
                            fontFamily: row.valid ? 'monospace' : 'inherit',
                          }}>
                            {row.email || '—'}
                          </p>
                        </td>
                        <td className="px-4 py-2.5">
                          <p className="text-xs" style={{ color: '#9A9891' }}>{row.program || '—'}</p>
                        </td>
                        <td className="px-4 py-2.5">
                          <p className="text-xs" style={{ color: '#9A9891' }}>{row.degreeLevel || '—'}</p>
                        </td>
                        <td className="px-4 py-2.5">
                          {row.valid ? (
                            <span className="flex items-center gap-1 text-xs" style={{ color: '#2A6B3A' }}>
                              <CheckCircle2 size={11} strokeWidth={1.5} />Valid
                            </span>
                          ) : (
                            <span className="text-xs" style={{ color: '#9B2828' }}>{row.errors[0]}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center gap-3 px-6 py-4 flex-shrink-0"
                style={{ borderTop: '1px solid #E3E1DB' }}>
                <button onClick={() => setStep('upload')}
                  className="text-xs px-4 py-2.5 transition-colors"
                  style={{ color: '#9A9891', border: '1px solid #E3E1DB', borderRadius: 2, background: '#FFFFFF' }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = '#F7F6F3')}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = '#FFFFFF')}>
                  ← Back
                </button>
                {validRows.length > 0 ? (
                  <button onClick={handleCreate}
                    className="flex items-center gap-1.5 text-xs px-4 py-2.5 transition-opacity"
                    style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2, letterSpacing: '0.03em' }}
                    onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.opacity = '0.85')}
                    onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.opacity = '1')}>
                    Grant access to {validRows.length} {validRows.length === 1 ? 'student' : 'students'}
                    <ArrowRight size={11} strokeWidth={1.5} />
                  </button>
                ) : (
                  <p className="text-xs" style={{ color: '#9B2828' }}>
                    No valid rows to import. Fix the errors or upload a new file.
                  </p>
                )}
              </div>
            </>
          )}

          {/* ── Creating ── */}
          {step === 'creating' && (
            <div className="flex flex-col items-center justify-center py-20 px-8 flex-1">
              <Loader2 size={28} strokeWidth={1} className="animate-spin mb-5" style={{ color: '#9A9891' }} />
              <p className="text-sm" style={{ color: '#0C0C0B' }}>
                Creating {validRows.length} student {validRows.length === 1 ? 'account' : 'accounts'}…
              </p>
              <p className="text-xs mt-1.5" style={{ color: '#B0AEA8' }}>
                Sending credentials by email. Please wait.
              </p>
              <div className="w-full mt-8" style={{ maxWidth: 280 }}>
                <div style={{ height: 2, background: '#E3E1DB', borderRadius: 1 }}>
                  <motion.div
                    style={{ height: 2, background: '#0C0C0B', borderRadius: 1 }}
                    animate={{ width: `${progress}%` }}
                    transition={{ duration: 0.3 }}
                  />
                </div>
              </div>
            </div>
          )}

          {/* ── Results ── */}
          {step === 'results' && (
            <>
              <div className="flex items-center gap-4 px-6 py-3 flex-shrink-0"
                style={{ background: '#FAFAF8', borderBottom: '1px solid #E3E1DB' }}>
                {results.filter((r) => r.success).length > 0 && (
                  <span className="flex items-center gap-1.5 text-xs" style={{ color: '#2A6B3A' }}>
                    <CheckCircle2 size={12} strokeWidth={1.5} />{results.filter((r) => r.success).length} created
                  </span>
                )}
                {results.filter((r) => !r.success).length > 0 && (
                  <>
                    <span style={{ color: '#E3E1DB' }}>·</span>
                    <span className="flex items-center gap-1.5 text-xs" style={{ color: '#9B2828' }}>
                      <XCircle size={12} strokeWidth={1.5} />{results.filter((r) => !r.success).length} failed
                    </span>
                  </>
                )}
              </div>
              <div className="flex-1 overflow-y-auto">
                <table className="w-full" style={{ borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#FAFAF8', borderBottom: '1px solid #E3E1DB' }}>
                      {['NAME', 'EMAIL', 'RESULT'].map((h, i) => (
                        <th key={i} className="text-left px-4 py-2.5 text-xs"
                          style={{ color: '#9A9891', letterSpacing: '0.07em', fontWeight: 400,
                            width: i === 0 ? '30%' : i === 1 ? '42%' : '28%' }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((r, i) => (
                      <tr key={i}
                        style={{ borderBottom: '1px solid #F0EFEB', background: r.success ? 'transparent' : '#FDF5F5' }}>
                        <td className="px-4 py-2.5">
                          <p className="text-xs" style={{ color: '#0C0C0B' }}>{r.name}</p>
                        </td>
                        <td className="px-4 py-2.5">
                          <p className="text-xs" style={{ color: '#4A4A45', fontFamily: 'monospace' }}>{r.email}</p>
                        </td>
                        <td className="px-4 py-2.5">
                          {r.success ? (
                            <span className="flex items-center gap-1 text-xs" style={{ color: '#2A6B3A' }}>
                              <Check size={11} strokeWidth={2} />Created
                            </span>
                          ) : (
                            <span className="text-xs" style={{ color: '#9B2828' }}>{r.error ?? 'Failed'}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex justify-end px-6 py-4 flex-shrink-0"
                style={{ borderTop: '1px solid #E3E1DB' }}>
                <button onClick={handleClose}
                  className="text-xs px-5 py-2.5 transition-opacity"
                  style={{ background: '#0C0C0B', color: '#FFFFFF', borderRadius: 2 }}
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