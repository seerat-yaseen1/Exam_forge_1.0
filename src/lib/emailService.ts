// ──────────────────────────────────────────────────────────────────
// EMAIL SERVICE  —  client-side via EmailJS (no server required)
//
// Setup (one-time):
//  1. Create a free account at https://www.emailjs.com
//  2. Add a Gmail service → copy the Service ID into EMAILJS_SERVICE_ID
//  3. Create one email template per type below → copy Template IDs
//  4. Copy your Public Key from Account → API Keys
//
// Each template receives the variables documented above it.
// ──────────────────────────────────────────────────────────────────

import emailjs from '@emailjs/browser';

// ── Credentials ────────────────────────────────────────────────────
// Replace these with your real EmailJS keys.
const EMAILJS_PUBLIC_KEY    = 'YOUR_EMAILJS_PUBLIC_KEY';
const EMAILJS_SERVICE_ID    = 'YOUR_EMAILJS_SERVICE_ID';

// Template IDs — one per email type
const TEMPLATE_INSTITUTE_WELCOME = 'template_inst_welcome';
const TEMPLATE_FACULTY_WELCOME   = 'template_faculty_welcome';
const TEMPLATE_STUDENT_WELCOME   = 'template_student_welcome';
const TEMPLATE_INSTITUTE_RESET   = 'template_inst_reset';
const TEMPLATE_FACULTY_RESET     = 'template_faculty_reset';
const TEMPLATE_STUDENT_RESET     = 'template_student_reset';
const TEMPLATE_WEBOWNER_RESET    = 'template_webowner_reset';
// ──────────────────────────────────────────────────────────────────

export interface EmailResult {
  ok: boolean;
  error?: string;
}

async function send(templateId: string, params: Record<string, string>): Promise<EmailResult> {
  // Skip silently when credentials are still placeholders
  if (
    EMAILJS_PUBLIC_KEY === 'YOUR_EMAILJS_PUBLIC_KEY' ||
    EMAILJS_SERVICE_ID === 'YOUR_EMAILJS_SERVICE_ID'
  ) {
    console.warn(
      '[emailService] EmailJS credentials not configured — skipping email dispatch.\n' +
      'Set EMAILJS_PUBLIC_KEY, EMAILJS_SERVICE_ID, and template IDs in /src/lib/emailService.ts'
    );
    return { ok: false, error: 'EmailJS credentials not configured.' };
  }

  try {
    await emailjs.send(EMAILJS_SERVICE_ID, templateId, params, {
      publicKey: EMAILJS_PUBLIC_KEY,
    });
    return { ok: true };
  } catch (err: any) {
    const msg = err?.text ?? err?.message ?? String(err);
    console.warn('[emailService] send failed:', msg);
    return { ok: false, error: msg };
  }
}

// ── Types (kept for compatibility with callers) ─────────────────────

export interface InstituteEmailPayload {
  id: string;
  name: string;
  code: string;
  adminName: string;
  adminEmail: string;
  status: string;
  validityType: string;
  activeUntil: string;
  firstLoginRequired: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FacultyEmailPayload {
  id: string;
  instituteId: string;
  name: string;
  email: string;
  role: 'Faculty';
  status: string;
  firstLoginRequired: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StudentEmailPayload {
  id: string;
  instituteId: string;
  name: string;
  email: string;
  role: 'Student';
  status: string;
  firstLoginRequired: boolean;
  group?: string[];
  section?: string[];
  specialisation?: string[];
  program?: string[];
  degreeLevel?: string[];
  school?: string[];
  createdAt: string;
  updatedAt: string;
}

// ── Institute welcome ──────────────────────────────────────────────
// Template variables: to_email, to_name, institute_name, institute_code,
//                     admin_email, active_until, temp_password

export async function sendInstituteWelcomeEmail(
  institute: InstituteEmailPayload,
  password: string,
): Promise<EmailResult> {
  const validUntil = new Date(institute.activeUntil).toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });
  return send(TEMPLATE_INSTITUTE_WELCOME, {
    to_email:       institute.adminEmail,
    to_name:        institute.adminName,
    institute_name: institute.name,
    institute_code: institute.code,
    admin_email:    institute.adminEmail,
    active_until:   validUntil,
    temp_password:  password,
  });
}

// ── Faculty welcome ────────────────────────────────────────────────
// Template variables: to_email, to_name, institute_name, temp_password

export async function sendFacultyWelcomeEmail(
  faculty: FacultyEmailPayload,
  instituteName: string,
  password: string,
): Promise<EmailResult> {
  return send(TEMPLATE_FACULTY_WELCOME, {
    to_email:       faculty.email,
    to_name:        faculty.name,
    institute_name: instituteName,
    temp_password:  password,
  });
}

// ── Student welcome ────────────────────────────────────────────────
// Template variables: to_email, to_name, institute_name, temp_password,
//                     program, degree_level, section

export async function sendStudentWelcomeEmail(
  student: StudentEmailPayload,
  instituteName: string,
  password: string,
): Promise<EmailResult> {
  return send(TEMPLATE_STUDENT_WELCOME, {
    to_email:       student.email,
    to_name:        student.name,
    institute_name: instituteName,
    temp_password:  password,
    program:        student.program?.join(', ')      ?? '',
    degree_level:   student.degreeLevel?.join(', ')  ?? '',
    section:        student.section?.join(', ')      ?? '',
  });
}

// ── Institute password reset ───────────────────────────────────────
// Template variables: to_email, to_name, institute_name, institute_code,
//                     new_password

export async function sendInstituteResetEmail(
  institute: InstituteEmailPayload,
  newPassword: string,
): Promise<EmailResult> {
  return send(TEMPLATE_INSTITUTE_RESET, {
    to_email:       institute.adminEmail,
    to_name:        institute.adminName,
    institute_name: institute.name,
    institute_code: institute.code,
    new_password:   newPassword,
  });
}

// ── Faculty password reset ─────────────────────────────────────────
// Template variables: to_email, to_name, institute_name, new_password

export async function sendFacultyResetEmail(
  faculty: FacultyEmailPayload,
  instituteName: string,
  newPassword: string,
): Promise<EmailResult> {
  return send(TEMPLATE_FACULTY_RESET, {
    to_email:       faculty.email,
    to_name:        faculty.name,
    institute_name: instituteName,
    new_password:   newPassword,
  });
}

// ── Student password reset ─────────────────────────────────────────
// Template variables: to_email, to_name, institute_name, new_password

export async function sendStudentResetEmail(
  student: StudentEmailPayload,
  instituteName: string,
  newPassword: string,
): Promise<EmailResult> {
  return send(TEMPLATE_STUDENT_RESET, {
    to_email:       student.email,
    to_name:        student.name,
    institute_name: instituteName,
    new_password:   newPassword,
  });
}

// ── Web Owner password reset ───────────────────────────────────────
// Template variables: to_email, to_name, reset_code

export async function sendWebOwnerResetEmail(
  name: string,
  email: string,
  code: string,
): Promise<EmailResult> {
  return send(TEMPLATE_WEBOWNER_RESET, {
    to_email:   email,
    to_name:    name,
    reset_code: code,
  });
}
