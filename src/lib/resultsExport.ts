/**
 * resultsExport — builds and downloads the roster's results export.
 *
 * Pure data → workbook logic, no React. The UI lives in
 * components/assignments/ResultsExportModal.tsx; this module is deliberately
 * separate so the export shape is testable and reusable (e.g. a future
 * scheduled export or per-institute bulk export can call the same builder).
 *
 * ATTEMPT SCOPE (chosen at export time in the modal):
 *   'best'   → one row per student: their best finalized attempt.
 *              "Best" = highest scores.percentage among finalized attempts
 *              (submitted / auto_submitted), tie broken by most recent.
 *              Terminated attempts are only considered when a student has NO
 *              clean finalized attempt — a termination shouldn't outrank an
 *              honest submission, but if it's all they have, it's shown.
 *              Students with no finalized attempt fall back to their latest
 *              attempt (shown with its live status, no score).
 *   'latest' → one row per student: most recently started attempt, whatever
 *              its status.
 *   'all'    → every (non-soft-deleted) attempt gets a row, oldest first,
 *              with a "Counted" column marking the one 'best' would pick —
 *              this is the "check the multiple attempts and see which score
 *              is kept" view.
 *
 * SHEETS
 *   Summary   — one row per student (or per attempt in 'all' mode); students
 *               who never attempted appear as "Not attempted" so the export
 *               is always a complete roster picture.
 *   Sections  — per-section marks for each exported attempt.
 *   Integrity — full violation counters + termination flags per attempt.
 *
 * FORMAT
 *   'xlsx' → one workbook, three sheets.
 *   'csv'  → three separate .csv files (CSV has no sheet concept), suffixed
 *            _summary / _sections / _integrity, downloads staggered ~200 ms
 *            apart so the browser doesn't swallow them.
 */

import type { Assessment } from './assessmentService';
import type { Student } from './firebaseService';
import type { Attempt, AttemptStatus } from './submissionService';

// Lazy xlsx (Remediation plan Batch E / ext #19): the ~142 KB gzip sheet
// library loads on first actual use (template download / file parse /
// export), not with the page chunk that happens to render this component.
type XlsxModule = typeof import('xlsx');
type WorkSheetT = import('xlsx').WorkSheet;
let xlsxPromise: Promise<XlsxModule> | null = null;
const loadXlsx = () => (xlsxPromise ??= import('xlsx'));

// ── Options ───────────────────────────────────────────────────────

export type ExportAttemptScope = 'best' | 'latest' | 'all';
export type ExportFormat = 'xlsx' | 'csv';

export type ResultsExportOptions = {
  scope: ExportAttemptScope;
  format: ExportFormat;
};

// ── Internal row shapes ───────────────────────────────────────────

type ExportedAttempt = {
  student: Student;
  attempt: Attempt;
  attemptNumber: number;   // 1-based, by startedAt order within the student
  counted: boolean;        // true on the attempt 'best' scope would pick
};

// ── Helpers ───────────────────────────────────────────────────────

const FINALIZED: AttemptStatus[] = ['submitted', 'auto_submitted'];

function byStartedAtAsc(a: Attempt, b: Attempt): number {
  return (a.startedAt ?? '').localeCompare(b.startedAt ?? '');
}

/** Pick the attempt the 'best' scope keeps. See module header for the rule. */
function pickBest(attempts: Attempt[]): Attempt | null {
  if (attempts.length === 0) return null;

  const scored = (list: Attempt[]) =>
    list
      .filter((a) => a.scores)
      .sort((a, b) =>
        (b.scores!.percentage - a.scores!.percentage)
        || byStartedAtAsc(b, a)   // tie → most recent wins
      )[0] ?? null;

  const clean = scored(attempts.filter((a) => FINALIZED.includes(a.status)));
  if (clean) return clean;

  const terminated = scored(attempts.filter((a) => a.status === 'terminated'));
  if (terminated) return terminated;

  // No finalized attempt at all — latest whatever-it-is (in_progress / frozen).
  return [...attempts].sort(byStartedAtAsc).at(-1) ?? null;
}

function statusLabel(a: Attempt): string {
  if (a.frozenAt) return 'Frozen';
  const map: Record<string, string> = {
    in_progress: 'In progress',
    submitted: 'Submitted',
    auto_submitted: 'Auto-submitted',
    terminated: 'Terminated',
    frozen: 'Frozen',
  };
  return map[a.status] ?? a.status;
}

function totalTimeUsedMinutes(a: Attempt): number {
  const secs = Object.values(a.sectionTimings ?? {}).reduce(
    (sum, t) => sum + (t?.timeUsedSeconds ?? 0), 0
  );
  return Math.round((secs / 60) * 10) / 10;
}

function fmtIso(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function sanitizeFilename(s: string): string {
  return s.replace(/[^\p{L}\p{N}\-_ ]/gu, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'assessment';
}

// ── Row selection ─────────────────────────────────────────────────

/**
 * Groups attempts per student, numbers them by start order, and applies the
 * scope. Returns exported attempts plus the students who never attempted.
 */
export function selectExportRows(
  students: Student[],
  attempts: Attempt[],
  scope: ExportAttemptScope
): { exported: ExportedAttempt[]; notAttempted: Student[] } {
  const byStudent = new Map<string, Attempt[]>();
  for (const a of attempts) {
    const list = byStudent.get(a.studentId) ?? [];
    list.push(a);
    byStudent.set(a.studentId, list);
  }

  const exported: ExportedAttempt[] = [];
  const notAttempted: Student[] = [];

  for (const student of students) {
    const list = (byStudent.get(student.id) ?? []).sort(byStartedAtAsc);
    if (list.length === 0) {
      notAttempted.push(student);
      continue;
    }

    const numberOf = new Map(list.map((a, i) => [a.id, i + 1]));
    const best = pickBest(list);

    const keep: Attempt[] =
      scope === 'all'    ? list
      : scope === 'latest' ? [list[list.length - 1]]
      : best ? [best] : [];

    for (const attempt of keep) {
      exported.push({
        student,
        attempt,
        attemptNumber: numberOf.get(attempt.id) ?? 1,
        counted: best !== null && attempt.id === best.id,
      });
    }
  }

  return { exported, notAttempted };
}

// ── Sheet builders ────────────────────────────────────────────────

function buildSummaryRows(
  exported: ExportedAttempt[],
  notAttempted: Student[],
  blockedStudentIds: Set<string>,
  scope: ExportAttemptScope
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = exported.map(({ student, attempt, attemptNumber, counted }) => {
    const s = attempt.scores;
    return {
      'Student Name': student.name,
      'Email': student.email,
      'Student ID': student.id,
      'Status': statusLabel(attempt),
      'Attempt #': attemptNumber,
      ...(scope === 'all' ? { 'Counted': counted ? 'Yes' : '' } : {}),
      'Marks': s ? round2(s.total) : '',
      'Out Of': s ? round2(s.available) : '',
      'Percentage': s ? round2(s.percentage) : '',
      // G-02: three states. An empty cell means "no score"; "Pending" means the
      // paper is scored but not finished being marked. Collapsing the second
      // into "No" would export a fail verdict nobody reached.
      'Passed': s ? (s.passed === true ? 'Yes' : s.passed === false ? 'No' : 'Pending') : '',
      'Needs Manual Review': s?.requiresManualReview ? 'Yes' : '',
      'Time Used (min)': totalTimeUsedMinutes(attempt),
      'Violations': attempt.integrityLog?.totalViolations ?? 0,
      'Started At': fmtIso(attempt.startedAt),
      'Submitted At': fmtIso(attempt.submittedAt),
      'Blocked': blockedStudentIds.has(student.id) ? 'Yes' : '',
    };
  });

  for (const student of notAttempted) {
    rows.push({
      'Student Name': student.name,
      'Email': student.email,
      'Student ID': student.id,
      'Status': 'Not attempted',
      'Attempt #': '',
      ...(scope === 'all' ? { 'Counted': '' } : {}),
      'Marks': '', 'Out Of': '', 'Percentage': '', 'Passed': '',
      'Needs Manual Review': '',
      'Time Used (min)': '',
      'Violations': '',
      'Started At': '', 'Submitted At': '',
      'Blocked': blockedStudentIds.has(student.id) ? 'Yes' : '',
    });
  }

  return rows;
}

function buildSectionRows(exported: ExportedAttempt[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const { student, attempt, attemptNumber } of exported) {
    for (const sec of attempt.scores?.bySection ?? []) {
      rows.push({
        'Student Name': student.name,
        'Student ID': student.id,
        'Attempt #': attemptNumber,
        'Section': sec.sectionName,
        'Answered': sec.answeredQuestions,
        'Total Questions': sec.totalQuestions,
        'Marks': round2(sec.marksAwarded),
        'Out Of': round2(sec.marksAvailable),
        'Percentage': sec.marksAvailable > 0
          ? round2((sec.marksAwarded / sec.marksAvailable) * 100)
          : '',
      });
    }
  }
  return rows;
}

function buildIntegrityRows(exported: ExportedAttempt[]): Record<string, unknown>[] {
  return exported.map(({ student, attempt, attemptNumber }) => {
    const il = attempt.integrityLog ?? ({} as Attempt['integrityLog']);
    return {
      'Student Name': student.name,
      'Student ID': student.id,
      'Attempt #': attemptNumber,
      'Status': statusLabel(attempt),
      'Total Violations': il.totalViolations ?? 0,
      'Tab Switches': il.tabSwitches ?? 0,
      'Focus Losses': il.focusLosses ?? 0,
      'Fullscreen Exits': il.fullscreenExits ?? 0,
      'Copy Attempts': il.copyAttempts ?? 0,
      'Paste Attempts': il.pasteAttempts ?? 0,
      'Right Clicks': il.rightClickAttempts ?? 0,
      'Multi-Person Events': il.multiPersonEvents ?? 0,
      'Face Absence Events': il.faceAbsenceEvents ?? 0,
      'DevTools Events': il.devtoolsEvents ?? 0,
      'Keyboard Blocks': il.keyboardBlockEvents ?? 0,
      'Extension Events': il.extensionEvents ?? 0,
      'Auto-Terminated': il.autoTerminated ? 'Yes' : '',
      'Termination Reason': il.terminatedReason ?? '',
      'Finalized While Frozen': il.finalizedWhileFrozen ? 'Yes' : '',
      'Session Conflict': attempt.sessionConflictAt ? 'Yes' : '',
      'Device': attempt.deviceClass ?? '',
      'Camera Declined': attempt.cameraDeclined ? 'Yes' : '',
    };
  });
}

// ── CSV formula-injection guard (external review #3) ──────────────
// A CSV cell whose text begins with = + - @ (or a leading tab/CR) is
// evaluated as a formula when the file is opened in Excel / Sheets /
// LibreOffice — so a hostile staff-entered value (e.g. a student "name" of
// =HYPERLINK(...)) would execute on whichever staff machine opens the
// export. Neutralize by prefixing a single apostrophe, the OWASP-
// recommended escape: spreadsheet apps then treat the cell as literal text.
//
// CSV path ONLY, by design: the .xlsx branch writes typed string cells,
// which Excel never evaluates, and prefixing there would corrupt clean
// data. Numeric cells (type 'n') are untouched, so scores, percentages and
// negative numbers survive exactly as written.
function sanitizeSheetForCsv(ws: WorkSheetT): void {
  for (const addr of Object.keys(ws)) {
    if (addr.startsWith('!')) continue; // sheet metadata (!ref, !cols, …)
    const cell = (ws as Record<string, { t?: string; v?: unknown }>)[addr];
    if (cell && cell.t === 's' && typeof cell.v === 'string' && /^[=+\-@\t\r]/.test(cell.v)) {
      cell.v = `'${cell.v}`;
    }
  }
}

// ── Download helpers ──────────────────────────────────────────────

function downloadBlob(content: BlobPart, filename: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke on a delay — immediate revoke can cancel the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ── Public entry point ────────────────────────────────────────────

/**
 * Builds the export from data the roster already holds and triggers the
 * download(s). `attempts` should be the roster's non-soft-deleted attempt
 * list (soft-deleted attempts are removed records and stay out of exports,
 * matching the live roster).
 *
 * Returns the number of exported attempt rows (for the toast).
 */
export async function downloadResultsExport(params: {
  assessment: Assessment;
  students: Student[];
  attempts: Attempt[];
  blockedStudentIds: Set<string>;
  options: ResultsExportOptions;
}): Promise<number> {
  const { assessment, students, attempts, blockedStudentIds, options } = params;

  const XLSX = await loadXlsx();
  const { exported, notAttempted } = selectExportRows(students, attempts, options.scope);

  const summaryRows   = buildSummaryRows(exported, notAttempted, blockedStudentIds, options.scope);
  const sectionRows   = buildSectionRows(exported);
  const integrityRows = buildIntegrityRows(exported);

  const summarySheet   = XLSX.utils.json_to_sheet(summaryRows);
  const sectionSheet   = XLSX.utils.json_to_sheet(sectionRows.length ? sectionRows : [{ Note: 'No scored attempts in this export.' }]);
  const integritySheet = XLSX.utils.json_to_sheet(integrityRows.length ? integrityRows : [{ Note: 'No attempts in this export.' }]);

  const date = new Date().toISOString().slice(0, 10);
  const base = `${sanitizeFilename(assessment.title)}_results_${date}`;

  if (options.format === 'xlsx') {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, summarySheet,   'Summary');
    XLSX.utils.book_append_sheet(wb, sectionSheet,   'Sections');
    XLSX.utils.book_append_sheet(wb, integritySheet, 'Integrity');
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    downloadBlob(out, `${base}.xlsx`,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  } else {
    // CSV — three files, staggered so the browser fires all downloads.
    // Each sheet is neutralized against formula injection first (CSV only —
    // see sanitizeSheetForCsv; the xlsx branch above is safe as-is).
    const parts: Array<[WorkSheetT, string]> = [
      [summarySheet,   `${base}_summary.csv`],
      [sectionSheet,   `${base}_sections.csv`],
      [integritySheet, `${base}_integrity.csv`],
    ];
    parts.forEach(([sheet]) => sanitizeSheetForCsv(sheet));
    parts.forEach(([sheet, name], i) => {
      setTimeout(() => {
        downloadBlob('\uFEFF' + XLSX.utils.sheet_to_csv(sheet), name, 'text/csv;charset=utf-8');
      }, i * 200);
    });
  }

  return exported.length;
}