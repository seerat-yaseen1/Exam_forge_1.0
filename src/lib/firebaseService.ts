import {
  collection,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  query,
  where,
  getDocs,
  updateDoc,
  QueryConstraint,
} from 'firebase/firestore';
import { db } from './firebase';

// ──────────────────────────────────────────────────────────────────
// TYPE DEFINITIONS
// ──────────────────────────────────────────────────────────────────

export type WebOwner = {
  email: string;
  name: string;
  password: string;
  resetCode?: string;
  resetExpiry?: string;
};

export type Institute = {
  id: string;
  name: string;
  code: string;
  adminName: string;
  adminEmail: string;
  status: 'active' | 'disabled';
  validityType: 'monthly' | 'yearly' | 'custom';
  activeUntil: string;
  firstLoginRequired: boolean;
  // ── Permission gates (set by Web Owner per institute) ──────────────
  schoolsManagementEnabled?: boolean;
  canAdminCreateFaculty?: boolean;
  canAdminCreateStudents?: boolean;
  facultyCanCreateStudents?: boolean;
  canAdminCreateQuestions?: boolean;
  // ── Exam Roster gates ──────────────────────────────────────────────
  canAdminManageExamRosters?: boolean;      // Institute Admin can access live exam rosters
  facultyCanManageExamRosters?: boolean;    // Faculty (if individually granted) can manage rosters
  // ── Question-rights ceiling (permission-model Phase 2) ─────────────
  // Set by Web Owner. The CEILING: the maximum rights this institute may
  // hold, and — per right — the maximum modes it may grant onward to
  // faculty. Absent ⇒ everything off (secure-by-default). Enforced
  // server-side in the question callables; the UI mirrors it.
  questionRightsCeiling?: QuestionRightsCeiling;
  createdAt: string;
  updatedAt: string;
}

// One right in the ceiling: whether the institute has it at all, and the
// set of modes it may pass to faculty. 'direct' = faculty acts immediately;
// 'request' = faculty raises a request the admin approves (Phase 3). An
// empty modes array with allowed:true means the institute may USE the right
// itself but may not grant it onward.
export type QuestionRightMode = 'direct' | 'request';
export type CeilingRight = {
  allowed: boolean;
  modes: QuestionRightMode[];   // subset the institute may grant to faculty
};
export type QuestionRightName = 'create' | 'edit' | 'share' | 'delete';
export type QuestionRightsCeiling = {
  create: CeilingRight;
  edit:   CeilingRight;
  share:  CeilingRight;
  delete: CeilingRight;
};

export type InstituteCredentials = {
  instituteId: string;
  email: string;
  password: string;
  firstLoginRequired: boolean;
};

export type InstituteLogo = {
  instituteId: string;
  logoUrl: string;
};

export type InstituteConfig = {
  instituteId: string;
  boundaryCreatedAt: string | null;
  facultyCount: number;
  studentCount: number;
};

export type Faculty = {
  id: string;
  instituteId: string;
  name: string;
  email: string;
  role: 'Faculty';
  status: 'active' | 'disabled';
  firstLoginRequired: boolean;
  schoolsManagementEnabled?: boolean;
  canCreateStudents?: boolean;
  canManageExamRosters?: boolean;  // Individual faculty gate (effective only when institute also has facultyCanManageExamRosters = true)
  // ── Per-faculty question rights (permission-model Phase 2) ─────────
  // Set by the Institute Admin, always at/below the institute ceiling.
  // Per right: whether this faculty has it, and in which mode. Absent /
  // granted:false ⇒ the faculty cannot perform that action. Enforced
  // server-side in the question callables. In Phase 2 only 'direct' mode
  // takes effect; 'request' is stored but its workflow lands in Phase 3.
  questionRights?: FacultyQuestionRights;
  createdAt: string;
  updatedAt: string;
}

// One granted right for a faculty member.
export type FacultyRight = {
  granted: boolean;
  mode: QuestionRightMode;
};
export type FacultyQuestionRights = {
  create: FacultyRight;
  edit:   FacultyRight;
  share:  FacultyRight;
  delete: FacultyRight;
};

export type FacultyCredentials = {
  facultyId: string;
  email: string;
  password: string;
  firstLoginRequired: boolean;
};

export type Student = {
  id: string;
  instituteId: string;
  name: string;
  email: string;
  role: 'Student';
  status: 'active' | 'disabled';
  firstLoginRequired: boolean;
  group?: string[];
  section?: string[];
  specialisation?: string[];
  program?: string[];
  degreeLevel?: string[];
  school?: string[];
  createdAt: string;
  updatedAt: string;
};

export type StudentCredentials = {
  studentId: string;
  email: string;
  password: string;
  firstLoginRequired: boolean;
};

// ──────────────────────────────────────────────────────────────────
// HELPER: REMOVE UNDEFINED VALUES
// ──────────────────────────────────────────────────────────────────

// Firestore doesn't accept undefined values. This helper removes them.
function removeUndefined<T extends Record<string, any>>(obj: T): T {
  const cleaned: any = {};
  for (const key in obj) {
    if (obj[key] !== undefined) {
      cleaned[key] = obj[key];
    }
  }
  return cleaned as T;
}

// ──────────────────────────────────────────────────────────────────
// FIRESTORE PRIMITIVES
// ──────────────────────────────────────────────────────────────────

export async function firestoreGet<T>(collectionName: string, docId: string): Promise<T | null> {
  try {
    const docRef = doc(db, collectionName, docId);
    const docSnap = await getDoc(docRef);
    return docSnap.exists() ? (docSnap.data() as T) : null;
  } catch (err) {
    console.error(`Error getting document ${docId} from ${collectionName}:`, err);
    return null;
  }
}

export async function firestoreSet<T>(
  collectionName: string,
  docId: string,
  data: T
): Promise<void> {
  try {
    console.log(`🔵 FIRESTORE SET - Collection: ${collectionName}, DocID: ${docId}`, data);
    const docRef = doc(db, collectionName, docId);
    // Remove undefined values before saving to Firestore
    const cleanedData = removeUndefined(data as Record<string, any>);
    await setDoc(docRef, cleanedData);
    console.log(`✅ FIRESTORE SET SUCCESS - Collection: ${collectionName}, DocID: ${docId}`);
  } catch (err) {
    console.error(`❌ FIRESTORE SET ERROR - Collection: ${collectionName}, DocID: ${docId}:`, err);
    throw err;
  }
}

export async function firestoreUpdate<T>(
  collectionName: string,
  docId: string,
  data: Partial<T>
): Promise<void> {
  try {
    const docRef = doc(db, collectionName, docId);
    await updateDoc(docRef, data as any);
  } catch (err) {
    console.error(`Error updating document ${docId} in ${collectionName}:`, err);
    throw err;
  }
}

export async function firestoreDelete(collectionName: string, docId: string): Promise<void> {
  try {
    const docRef = doc(db, collectionName, docId);
    await deleteDoc(docRef);
  } catch (err) {
    console.error(`Error deleting document ${docId} from ${collectionName}:`, err);
    throw err;
  }
}

export async function firestoreQuery<T>(
  collectionName: string,
  field: string,
  operator: any,
  value: any
): Promise<T[]> {
  try {
    const q = query(collection(db, collectionName), where(field, operator, value));
    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id }) as T);
  } catch (err) {
    console.error(`Error querying ${collectionName}:`, err);
    return [];
  }
}

export async function firestoreGetAll<T>(collectionName: string): Promise<T[]> {
  try {
    const querySnapshot = await getDocs(collection(db, collectionName));
    return querySnapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id }) as T);
  } catch (err) {
    console.error(`Error getting all documents from ${collectionName}:`, err);
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────
// WEB OWNER OPERATIONS
// ──────────────────────────────────────────────────────────────────

export async function getWebOwnerByEmail(email: string): Promise<WebOwner | null> {
  return firestoreGet<WebOwner>('webowners', email);
}

export async function setWebOwner(email: string, data: WebOwner): Promise<void> {
  return firestoreSet<WebOwner>('webowners', email, data);
}

export async function updateWebOwner(email: string, data: Partial<WebOwner>): Promise<void> {
  return firestoreUpdate<WebOwner>('webowners', email, data);
}

// ──────────────────────────────────────────────────────────────────
// INSTITUTE OPERATIONS
// ──────────────────────────────────────────────────────────────────

export async function getAllInstitutes(): Promise<Institute[]> {
  return firestoreGetAll<Institute>('institutes');
}

export async function getInstitute(id: string): Promise<Institute | null> {
  return firestoreGet<Institute>('institutes', id);
}

export async function setInstitute(id: string, data: Institute): Promise<void> {
  return firestoreSet<Institute>('institutes', id, data);
}

export async function updateInstitute(id: string, data: Partial<Institute>): Promise<void> {
  return firestoreUpdate<Institute>('institutes', id, data);
}

export async function deleteInstitute(id: string): Promise<void> {
  return firestoreDelete('institutes', id);
}

export async function getInstituteByEmail(email: string): Promise<Institute | null> {
  const results = await firestoreQuery<Institute>('institutes', 'adminEmail', '==', email);
  return results.length > 0 ? results[0] : null;
}

export async function getInstituteByCode(code: string): Promise<Institute | null> {
  const results = await firestoreQuery<Institute>('institutes', 'code', '==', code);
  return results.length > 0 ? results[0] : null;
}

// ──────────────────────────────────────────────────────────────────
// INSTITUTE CREDENTIALS
// ──────────────────────────────────────────────────────────────────

export async function getInstituteCredentials(
  instituteId: string
): Promise<InstituteCredentials | null> {
  return firestoreGet<InstituteCredentials>('instituteCredentials', instituteId);
}

export async function setInstituteCredentials(
  instituteId: string,
  data: InstituteCredentials
): Promise<void> {
  return firestoreSet<InstituteCredentials>('instituteCredentials', instituteId, data);
}

export async function updateInstituteCredentials(
  instituteId: string,
  data: Partial<InstituteCredentials>
): Promise<void> {
  return firestoreUpdate<InstituteCredentials>('instituteCredentials', instituteId, data);
}

// ──────────────────────────────────────────────────────────────────
// INSTITUTE LOGO
// ──────────────────────────────────────────────────────────────────

export async function getInstituteLogo(instituteId: string): Promise<InstituteLogo | null> {
  return firestoreGet<InstituteLogo>('instituteLogos', instituteId);
}

export async function setInstituteLogo(instituteId: string, data: InstituteLogo): Promise<void> {
  return firestoreSet<InstituteLogo>('instituteLogos', instituteId, data);
}

// ──────────────────────────────────────────────────────────────────
// INSTITUTE CONFIG
// ──────────────────────────────────────────────────────────────────

export async function getInstituteConfig(instituteId: string): Promise<InstituteConfig | null> {
  return firestoreGet<InstituteConfig>('instituteConfigs', instituteId);
}

export async function setInstituteConfig(
  instituteId: string,
  data: InstituteConfig
): Promise<void> {
  return firestoreSet<InstituteConfig>('instituteConfigs', instituteId, data);
}

export async function updateInstituteConfig(
  instituteId: string,
  data: Partial<InstituteConfig>
): Promise<void> {
  return firestoreUpdate<InstituteConfig>('instituteConfigs', instituteId, data);
}

// ──────────────────────────────────────────────────────────────────
// FACULTY OPERATIONS
// ──────────────────────────────────────────────────────────────────

export async function getFaculty(facultyId: string): Promise<Faculty | null> {
  return firestoreGet<Faculty>('faculty', facultyId);
}

export async function setFaculty(facultyId: string, data: Faculty): Promise<void> {
  return firestoreSet<Faculty>('faculty', facultyId, data);
}

export async function deleteFaculty(facultyId: string): Promise<void> {
  return firestoreDelete('faculty', facultyId);
}

export async function getFacultyByInstitute(instituteId: string): Promise<Faculty[]> {
  return firestoreQuery<Faculty>('faculty', 'instituteId', '==', instituteId);
}

export async function getFacultyByEmail(email: string): Promise<Faculty | null> {
  const results = await firestoreQuery<Faculty>('faculty', 'email', '==', email);
  return results.length > 0 ? results[0] : null;
}

// ──────────────────────────────────────────────────────────────────
// FACULTY CREDENTIALS
// ──────────────────────────────────────────────────────────────────

export async function getFacultyCredentials(
  facultyId: string
): Promise<FacultyCredentials | null> {
  return firestoreGet<FacultyCredentials>('facultyCredentials', facultyId);
}

export async function setFacultyCredentials(
  facultyId: string,
  data: FacultyCredentials
): Promise<void> {
  return firestoreSet<FacultyCredentials>('facultyCredentials', facultyId, data);
}

export async function updateFacultyCredentials(
  facultyId: string,
  data: Partial<FacultyCredentials>
): Promise<void> {
  return firestoreUpdate<FacultyCredentials>('facultyCredentials', facultyId, data);
}

export async function deleteFacultyCredentials(facultyId: string): Promise<void> {
  return firestoreDelete('facultyCredentials', facultyId);
}

// ──────────────────────────────────────────────────────────────────
// STUDENT OPERATIONS
// ──────────────────────────────────────────────────────────────────

export async function getStudent(studentId: string): Promise<Student | null> {
  return firestoreGet<Student>('students', studentId);
}

export async function setStudent(studentId: string, data: Student): Promise<void> {
  return firestoreSet<Student>('students', studentId, data);
}

export async function deleteStudent(studentId: string): Promise<void> {
  return firestoreDelete('students', studentId);
}

export async function getStudentsByInstitute(instituteId: string): Promise<Student[]> {
  return firestoreQuery<Student>('students', 'instituteId', '==', instituteId);
}

export async function getAllStudents(): Promise<Student[]> {
  const snap = await getDocs(collection(db, 'students'));
  return snap.docs.map((d) => d.data() as Student);
}

export async function getStudentByEmail(email: string): Promise<Student | null> {
  const results = await firestoreQuery<Student>('students', 'email', '==', email);
  return results.length > 0 ? results[0] : null;
}

// ──────────────────────────────────────────────────────────────────
// STUDENT CREDENTIALS
// ──────────────────────────────────────────────────────────────────

export async function getStudentCredentials(studentId: string): Promise<StudentCredentials | null> {
  return firestoreGet<StudentCredentials>('studentCredentials', studentId);
}

export async function setStudentCredentials(
  studentId: string,
  data: StudentCredentials
): Promise<void> {
  return firestoreSet<StudentCredentials>('studentCredentials', studentId, data);
}

export async function updateStudentCredentials(
  studentId: string,
  data: Partial<StudentCredentials>
): Promise<void> {
  return firestoreUpdate<StudentCredentials>('studentCredentials', studentId, data);
}

export async function deleteStudentCredentials(studentId: string): Promise<void> {
  return firestoreDelete('studentCredentials', studentId);
}

// ──────────────────────────────────────────────────────────────────
// MULTI-CONDITION QUERY PRIMITIVE
// ──────────────────────────────────────────────────────────────────

export async function firestoreMultiQuery<T>(
  collectionName: string,
  conditions: Array<{ field: string; operator: any; value: any }>
): Promise<T[]> {
  try {
    const constraints: QueryConstraint[] = conditions.map((c) =>
      where(c.field, c.operator, c.value)
    );
    const q = query(collection(db, collectionName), ...constraints);
    const snapshot = await getDocs(q);
    return snapshot.docs.map((d) => d.data() as T);
  } catch (err) {
    console.error(`Error in multi-query on ${collectionName}:`, err);
    return [];
  }
}

// ──────────────────────────────────────────────────────────────────
// UTILITY — ID GENERATION
// ──────────────────────────────────────────────────────────────────

export function generateId(): string {
  return crypto.randomUUID();
}

// ──────────────────────────────────────────────────────────────────
// UTILITY FUNCTIONS
// ──────────────────────────────────────────────────────────────────

export function generateInstituteCode(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const array = new Uint8Array(6);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => chars[b % chars.length]).join('');
}

export function generatePassword(): string {
  const upper = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const all = upper + lower + digits;
  const array = new Uint8Array(10);
  crypto.getRandomValues(array);
  const chars: string[] = [
    upper[array[0] % upper.length],
    lower[array[1] % lower.length],
    digits[array[2] % digits.length],
    ...Array.from(array.slice(3), (b) => all[b % all.length]),
  ];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = array[i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export function computeActiveUntil(validityType: string, customDate?: string): string {
  if (validityType === 'custom' && customDate) return customDate;
  const d = new Date();
  if (validityType === 'yearly') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d.toISOString().split('T')[0];
}

// ══════════════════════════════════════════════════════════════════
// ACADEMIC HIERARCHY — TYPES
// ══════════════════════════════════════════════════════════════════

// The nine node-level identifiers used throughout the hierarchy.
// These are also the legal values for AcademicMapping.nodeType.
export type NodeLevel =
  | 'school'
  | 'academicLevel'
  | 'program'
  | 'academicSession'
  | 'academicYear'
  | 'semester'
  | 'course'
  | 'section'
  | 'group';

export const NODE_LEVEL_LABELS: Record<NodeLevel, string> = {
  school: 'School',
  academicLevel: 'Level',
  program: 'Program',
  academicSession: 'Batch',
  academicYear: 'Year',
  semester: 'Semester',
  course: 'Course',
  section: 'Section',
  group: 'Group',
};

// Child node type for each level — drives "+ Add" button labels and drawer routing.
export const NODE_CHILD_LEVEL: Partial<Record<NodeLevel, NodeLevel>> = {
  school: 'academicLevel',
  academicLevel: 'program',
  program: 'academicSession',
  academicSession: 'academicYear',
  academicYear: 'semester',   // or 'section' directly when the year has no semesters
  // B-2: sections hang off the semester (or year), NOT off a course. Course is
  // an offering shown in a side panel, never a drill-through parent.
  semester: 'section',
  section: 'group',
  // course removed from the primary child chain — it's a side-panel offering.
  // group has no children — only student mappings
};

// ── School ────────────────────────────────────────────────────────

export type School = {
  id: string;
  instituteId: string;
  name: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
};

// ── Academic Level (UG / PG / Diploma …) ─────────────────────────

export type AcademicLevel = {
  id: string;
  instituteId: string;
  schoolId: string;
  name: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
};

// ── Program (B.Tech / MBA / B.Sc …) ──────────────────────────────

export type Program = {
  id: string;
  instituteId: string;
  schoolId: string;
  levelId: string;
  name: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
};

// ── Academic Session (2024-25 / 2025-26 …) ───────────────────────

export type AcademicSession = {
  id: string;
  instituteId: string;
  schoolId: string;
  levelId: string;
  programId: string;
  name: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
};

// ── Academic Year (Year 1 / Year 2 …) ────────────────────────────

export type AcademicYear = {
  id: string;
  instituteId: string;
  schoolId: string;
  levelId: string;
  programId: string;
  sessionId: string;
  name: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
};

// ── Semester / Trimester ──────────────────────────────────────────
// Optional layer — a Year may have zero or many semesters.
// When a year has no semesters, Courses attach directly to the Year.

export type Semester = {
  id: string;
  instituteId: string;
  schoolId: string;
  levelId: string;
  programId: string;
  sessionId: string;
  yearId: string;
  name: string;
  type: 'Semester' | 'Trimester';
  number: number;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
};

// ── Course (Mathematics / Data Structures …) ─────────────────────
// semesterId is null when the course belongs directly to a Year.

export type Course = {
  id: string;
  instituteId: string;
  schoolId: string;
  levelId: string;
  programId: string;
  sessionId: string;
  yearId: string;
  semesterId: string | null;
  // B-2: course is now an OFFERING attached beside the spine. Placement is
  // inferred (Option A): sectionId set → section-level (this section only);
  // else semesterId set → whole-semester; else yearId → whole-year.
  sectionId?: string | null;
  name: string;
  code: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
};

// ── Section (Section A / Section B …) ────────────────────────────

export type Section = {
  id: string;
  instituteId: string;
  schoolId: string;
  levelId: string;
  programId: string;
  sessionId: string;
  yearId: string;
  semesterId: string | null;
  // B-2: course left the spine — a section's parent is its semester (or year
  // when annual). courseId is now optional legacy metadata, not a parent link.
  courseId?: string;
  name: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
};

// ── Group (Group 1 / Group 2 …) ───────────────────────────────────

export type Group = {
  id: string;
  instituteId: string;
  schoolId: string;
  levelId: string;
  programId: string;
  sessionId: string;
  yearId: string;
  semesterId: string | null;
  courseId?: string;   // B-2: optional legacy metadata (parent is sectionId)
  sectionId: string;
  name: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
};

// ── Academic Mapping ──────────────────────────────────────────────
// One document per (student, node) pair.
// A student can have many mappings — multi-mapping is by design.

export type AcademicMapping = {
  id: string;
  instituteId: string;
  studentId: string;
  studentName: string;
  studentEmail: string;
  nodeType: NodeLevel;
  nodeId: string;
  nodeName: string;
  // Full breadcrumb string for display in student profile, e.g.
  // "School of Engineering › UG › B.Tech › 2024-25 › Year 2 › Sem 3 › Data Structures › Sec A › Group 1"
  breadcrumb: string;
  createdAt: string;
};

// ══════════════════════════════════════════════════════════════════
// ACADEMIC HIERARCHY — SHARED HELPERS
// ══════════════════════════════════════════════════════════════════

// Generic: fetch active children of a parent node.
// Uses client-side status filter to avoid needing composite Firestore indexes.
async function getActiveChildren<T extends { status: string }>(
  col: string,
  parentField: string,
  parentId: string
): Promise<T[]> {
  const all = await firestoreQuery<T>(col, parentField, '==', parentId);
  return all.filter((n) => n.status === 'active');
}

// Soft-delete helper: sets status to 'archived' and updates updatedAt.
async function archiveNode(col: string, id: string): Promise<void> {
  await firestoreUpdate(col, id, {
    status: 'archived',
    updatedAt: new Date().toISOString(),
  });
}

// ══════════════════════════════════════════════════════════════════
// ACADEMIC HIERARCHY — SCHOOL
// ══════════════════════════════════════════════════════════════════

export async function getSchool(id: string): Promise<School | null> {
  return firestoreGet<School>('schools', id);
}

export async function getSchoolsByInstitute(instituteId: string): Promise<School[]> {
  return getActiveChildren<School>('schools', 'instituteId', instituteId);
}

export async function createSchool(data: School): Promise<void> {
  return firestoreSet<School>('schools', data.id, data);
}

export async function updateSchool(id: string, data: Partial<School>): Promise<void> {
  return firestoreUpdate<School>('schools', id, {
    ...data,
    updatedAt: new Date().toISOString(),
  });
}

export async function archiveSchool(id: string): Promise<void> {
  return archiveNode('schools', id);
}

// ══════════════════════════════════════════════════════════════════
// ACADEMIC HIERARCHY — ACADEMIC LEVEL
// ══════════════════════════════════════════════════════════════════

export async function getAcademicLevel(id: string): Promise<AcademicLevel | null> {
  return firestoreGet<AcademicLevel>('academicLevels', id);
}

export async function getLevelsBySchool(schoolId: string): Promise<AcademicLevel[]> {
  return getActiveChildren<AcademicLevel>('academicLevels', 'schoolId', schoolId);
}

export async function createAcademicLevel(data: AcademicLevel): Promise<void> {
  return firestoreSet<AcademicLevel>('academicLevels', data.id, data);
}

export async function updateAcademicLevel(
  id: string,
  data: Partial<AcademicLevel>
): Promise<void> {
  return firestoreUpdate<AcademicLevel>('academicLevels', id, {
    ...data,
    updatedAt: new Date().toISOString(),
  });
}

export async function archiveAcademicLevel(id: string): Promise<void> {
  return archiveNode('academicLevels', id);
}

// ══════════════════════════════════════════════════════════════════
// ACADEMIC HIERARCHY — PROGRAM
// ══════════════════════════════════════════════════════════════════

export async function getProgram(id: string): Promise<Program | null> {
  return firestoreGet<Program>('programs', id);
}

export async function getProgramsByLevel(levelId: string): Promise<Program[]> {
  return getActiveChildren<Program>('programs', 'levelId', levelId);
}

export async function createProgram(data: Program): Promise<void> {
  return firestoreSet<Program>('programs', data.id, data);
}

export async function updateProgram(id: string, data: Partial<Program>): Promise<void> {
  return firestoreUpdate<Program>('programs', id, {
    ...data,
    updatedAt: new Date().toISOString(),
  });
}

export async function archiveProgram(id: string): Promise<void> {
  return archiveNode('programs', id);
}

// ══════════════════════════════════════════════════════════════════
// ACADEMIC HIERARCHY — ACADEMIC SESSION
// ══════════════════════════════════════════════════════════════════

export async function getAcademicSession(id: string): Promise<AcademicSession | null> {
  return firestoreGet<AcademicSession>('academicSessions', id);
}

export async function getSessionsByProgram(programId: string): Promise<AcademicSession[]> {
  return getActiveChildren<AcademicSession>('academicSessions', 'programId', programId);
}

export async function createAcademicSession(data: AcademicSession): Promise<void> {
  return firestoreSet<AcademicSession>('academicSessions', data.id, data);
}

export async function updateAcademicSession(
  id: string,
  data: Partial<AcademicSession>
): Promise<void> {
  return firestoreUpdate<AcademicSession>('academicSessions', id, {
    ...data,
    updatedAt: new Date().toISOString(),
  });
}

export async function archiveAcademicSession(id: string): Promise<void> {
  return archiveNode('academicSessions', id);
}

// ══════════════════════════════════════════════════════════════════
// ACADEMIC HIERARCHY — ACADEMIC YEAR
// ═════════════════════════════════════════════════════════════════

export async function getAcademicYear(id: string): Promise<AcademicYear | null> {
  return firestoreGet<AcademicYear>('academicYears', id);
}

export async function getYearsBySession(sessionId: string): Promise<AcademicYear[]> {
  return getActiveChildren<AcademicYear>('academicYears', 'sessionId', sessionId);
}

export async function createAcademicYear(data: AcademicYear): Promise<void> {
  return firestoreSet<AcademicYear>('academicYears', data.id, data);
}

export async function updateAcademicYear(
  id: string,
  data: Partial<AcademicYear>
): Promise<void> {
  return firestoreUpdate<AcademicYear>('academicYears', id, {
    ...data,
    updatedAt: new Date().toISOString(),
  });
}

export async function archiveAcademicYear(id: string): Promise<void> {
  return archiveNode('academicYears', id);
}

// ══════════════════════════════════════════════════════════════════
// ACADEMIC HIERARCHY — SEMESTER / TRIMESTER
// ══════════════════════════════════════════════════════════════════

export async function getSemester(id: string): Promise<Semester | null> {
  return firestoreGet<Semester>('semesters', id);
}

export async function getSemestersByYear(yearId: string): Promise<Semester[]> {
  const all = await getActiveChildren<Semester>('semesters', 'yearId', yearId);
  // Return sorted by number
  return all.sort((a, b) => a.number - b.number);
}

export async function createSemester(data: Semester): Promise<void> {
  return firestoreSet<Semester>('semesters', data.id, data);
}

export async function updateSemester(id: string, data: Partial<Semester>): Promise<void> {
  return firestoreUpdate<Semester>('semesters', id, {
    ...data,
    updatedAt: new Date().toISOString(),
  });
}

export async function archiveSemester(id: string): Promise<void> {
  return archiveNode('semesters', id);
}

// ══════════════════════════════════════════════════════════════════
// ACADEMIC HIERARCHY — COURSE
// ══════════════════════════════════════════════════════════════════

export async function getCourse(id: string): Promise<Course | null> {
  return firestoreGet<Course>('courses', id);
}

// Courses that belong directly to a Year (semesterId is null in stored form;
// we filter client-side because Firestore can't query for null with ==).
export async function getCoursesByYear(yearId: string): Promise<Course[]> {
  const all = await getActiveChildren<Course>('courses', 'yearId', yearId);
  return all.filter((c) => !c.semesterId);
}

export async function getCoursesBySemester(semesterId: string): Promise<Course[]> {
  return getActiveChildren<Course>('courses', 'semesterId', semesterId);
}

export async function createCourse(data: Course): Promise<void> {
  return firestoreSet<Course>('courses', data.id, data);
}

export async function updateCourse(id: string, data: Partial<Course>): Promise<void> {
  return firestoreUpdate<Course>('courses', id, {
    ...data,
    updatedAt: new Date().toISOString(),
  });
}

export async function archiveCourse(id: string): Promise<void> {
  return archiveNode('courses', id);
}

// ══════════════════════════════════════════════════════════════════
// ACADEMIC HIERARCHY — SECTION
// ══════════════════════════════════════════════════════════════════

export async function getSection(id: string): Promise<Section | null> {
  return firestoreGet<Section>('sections', id);
}

export async function getSectionsByCourse(courseId: string): Promise<Section[]> {
  return getActiveChildren<Section>('sections', 'courseId', courseId);
}

// ── B-2: parent-based section fetchers (section's real parent is semester/year) ──

// Sections directly under a semester (semesterized programs).
export async function getSectionsBySemester(semesterId: string): Promise<Section[]> {
  return getActiveChildren<Section>('sections', 'semesterId', semesterId);
}

// Sections directly under a year with NO semester (annual programs).
// Firestore can't query "semesterId == null" via getActiveChildren's ==, so we
// fetch by year and filter the null-semester ones client-side.
export async function getSectionsByYearDirect(yearId: string): Promise<Section[]> {
  const all = await getActiveChildren<Section>('sections', 'yearId', yearId);
  return all.filter((s) => s.semesterId == null);
}

// Section-level courses (offerings attached to one section).
export async function getCoursesBySection(sectionId: string): Promise<Course[]> {
  return getActiveChildren<Course>('courses', 'sectionId', sectionId);
}

export async function createSection(data: Section): Promise<void> {
  return firestoreSet<Section>('sections', data.id, data);
}

export async function updateSection(id: string, data: Partial<Section>): Promise<void> {
  return firestoreUpdate<Section>('sections', id, {
    ...data,
    updatedAt: new Date().toISOString(),
  });
}

export async function archiveSection(id: string): Promise<void> {
  return archiveNode('sections', id);
}

// ══════════════════════════════════════════════════════════════════
// ACADEMIC HIERARCHY — GROUP
// ══════════════════════════════════════════════════════════════════

export async function getGroup(id: string): Promise<Group | null> {
  return firestoreGet<Group>('groups', id);
}

export async function getGroupsBySection(sectionId: string): Promise<Group[]> {
  return getActiveChildren<Group>('groups', 'sectionId', sectionId);
}

export async function createGroup(data: Group): Promise<void> {
  return firestoreSet<Group>('groups', data.id, data);
}

export async function updateGroup(id: string, data: Partial<Group>): Promise<void> {
  return firestoreUpdate<Group>('groups', id, {
    ...data,
    updatedAt: new Date().toISOString(),
  });
}

export async function archiveGroup(id: string): Promise<void> {
  return archiveNode('groups', id);
}

// ══════════════════════════════════════════════════════════════════
// ACADEMIC MAPPINGS — STUDENT ↔ NODE
// ══════════════════════════════════════════════════════════════════

export async function getMapping(id: string): Promise<AcademicMapping | null> {
  return firestoreGet<AcademicMapping>('academicMappings', id);
}

// All mappings for a given node — used to list students inside a hierarchy node.
export async function getMappingsByNode(nodeId: string): Promise<AcademicMapping[]> {
  return firestoreQuery<AcademicMapping>('academicMappings', 'nodeId', '==', nodeId);
}

// ── Descendant-aware roster (user management) ──────────────────────
// A student mapped to a Group is a member of that group's Section, Semester,
// Year, Batch, Program, Level and School too — but each mapping doc lives only
// at the LEAF the admin picked. getMappingsByNode returns just the direct
// mappings; this returns direct PLUS every mapping at a descendant node, so a
// node roster shows everyone who belongs at or below it.
//
// Descendants are resolved from the hierarchy collections (which carry
// ancestor ids); mappings themselves only store nodeId/nodeType, so we first
// collect the descendant node-ids, then fetch mappings for that id set. This
// is the same downward walk the allocation resolver uses — reused read-side.

// Collection name for each node level.
const NODE_COLLECTION: Record<NodeLevel, string> = {
  school: 'schools',
  academicLevel: 'academicLevels',
  program: 'programs',
  academicSession: 'academicSessions',
  academicYear: 'academicYears',
  semester: 'semesters',
  course: 'courses',
  section: 'sections',
  group: 'groups',
};

// The ancestor-id field a descendant collection carries for a given level.
const NODE_ANCESTOR_FIELD: Record<Exclude<NodeLevel, 'group'>, string> = {
  school: 'schoolId',
  academicLevel: 'levelId',
  program: 'programId',
  academicSession: 'sessionId',
  academicYear: 'yearId',
  semester: 'semesterId',
  course: 'courseId',
  section: 'sectionId',
};

// B-2: `course` is NOT part of the spine — a section's parent is its semester
// (or year). A course is an offering attached beside the spine, so it is never
// walked *through* to reach sections. Course rosters resolve via their sections.
const NODE_ORDER: NodeLevel[] = [
  'school', 'academicLevel', 'program', 'academicSession',
  'academicYear', 'semester', 'section', 'group',
];

// One mapping tagged with whether it sits AT the target node (removable here)
// or below it (inherited — read-only at this level; remove at its own node).
export type RosterMember = AcademicMapping & {
  membership: 'direct' | 'inherited';
};

// Collect all descendant node-ids of the given node (across every lower level).
// Uses the denormalized ancestor field on each collection — one query per level.
async function collectDescendantNodeIds(nodeId: string, nodeType: NodeLevel): Promise<string[]> {
  if (nodeType === 'group') return []; // leaf — no descendants

  // B-2: a course is an offering beside the spine. Its "descendants" are the
  // section(s) it's attached to (and their groups), resolved sideways:
  //   sectionId set → that section; semesterId set → the semester's sections;
  //   else → sections directly under the year (annual programs).
  if (nodeType === 'course') {
    const course = await firestoreGet<Course>('courses', nodeId);
    if (!course) return [];
    let sections: Section[] = [];
    if (course.sectionId) {
      const one = await firestoreGet<Section>('sections', course.sectionId);
      sections = one && one.status !== 'archived' ? [one] : [];
    } else if (course.semesterId) {
      sections = await getSectionsBySemester(course.semesterId);
    } else {
      sections = await getSectionsByYearDirect(course.yearId);
    }
    const ids = sections.map((s) => s.id);
    const groupLists = await Promise.all(ids.map((sid) => getGroupsBySection(sid)));
    groupLists.forEach((gs) => gs.forEach((g) => ids.push(g.id)));
    return ids;
  }

  const field = NODE_ANCESTOR_FIELD[nodeType as Exclude<NodeLevel, 'group'>];
  const below = NODE_ORDER.slice(NODE_ORDER.indexOf(nodeType) + 1);
  const ids: string[] = [];
  await Promise.all(below.map(async (lvl) => {
    const rows = await firestoreQuery<{ id: string; status?: string }>(NODE_COLLECTION[lvl], field, '==', nodeId);
    rows.forEach((r) => { if (r.status !== 'archived') ids.push(r.id); });
  }));
  return ids;
}

// Fetch mappings for a set of node-ids, chunked into 'in' queries (limit 30).
async function mappingsForNodeIds(nodeIds: string[]): Promise<AcademicMapping[]> {
  if (nodeIds.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < nodeIds.length; i += 30) chunks.push(nodeIds.slice(i, i + 30));
  const results = await Promise.all(
    chunks.map((c) =>
      getDocs(query(collection(db, 'academicMappings'), where('nodeId', 'in', c)))
        .then((snap) => snap.docs.map((d) => ({ ...d.data(), id: d.id }) as AcademicMapping))
        .catch(() => [] as AcademicMapping[]),
    ),
  );
  return results.flat();
}

// Direct + inherited members for a node. Deduped by studentId: a student who is
// mapped BOTH directly here and via a descendant shows once, as 'direct'.
export async function getStudentsAtOrBelowNode(
  nodeId: string,
  nodeType: NodeLevel,
): Promise<RosterMember[]> {
  const [direct, descendantIds] = await Promise.all([
    getMappingsByNode(nodeId),
    collectDescendantNodeIds(nodeId, nodeType),
  ]);
  const inherited = await mappingsForNodeIds(descendantIds);

  const byStudent = new Map<string, RosterMember>();
  // Inherited first, so a direct mapping overwrites and wins the 'direct' tag.
  inherited.forEach((m) => {
    if (!byStudent.has(m.studentId)) byStudent.set(m.studentId, { ...m, membership: 'inherited' });
  });
  direct.forEach((m) => byStudent.set(m.studentId, { ...m, membership: 'direct' }));

  return [...byStudent.values()].sort((a, b) =>
    (a.studentName || '').localeCompare(b.studentName || ''));
}

// Count only — for lazy levels we still call the same walk, but callers may
// prefer to defer it. Kept as a thin wrapper so intent reads clearly.
export async function countStudentsAtOrBelowNode(
  nodeId: string,
  nodeType: NodeLevel,
): Promise<number> {
  return (await getStudentsAtOrBelowNode(nodeId, nodeType)).length;
}

// All mappings for a given student — used in the student profile view.
export async function getMappingsByStudent(studentId: string): Promise<AcademicMapping[]> {
  return firestoreQuery<AcademicMapping>('academicMappings', 'studentId', '==', studentId);
}

// Check whether a specific student-node pair already exists.
// Returns all matching mappings (should be 0 or 1; the caller shows a warning if > 0).
export async function getExistingMappings(
  studentId: string,
  nodeId: string
): Promise<AcademicMapping[]> {
  const all = await getMappingsByStudent(studentId);
  return all.filter((m) => m.nodeId === nodeId);
}

export async function createMapping(data: AcademicMapping): Promise<void> {
  return firestoreSet<AcademicMapping>('academicMappings', data.id, data);
}

// Remove a specific mapping document (un-assign a student from a node).
export async function deleteMapping(id: string): Promise<void> {
  return firestoreDelete('academicMappings', id);
}

// Remove ALL mappings for a student inside an institute.
// Used when a student is deleted from the institute.
export async function deleteMappingsByStudent(
  studentId: string,
  instituteId: string
): Promise<void> {
  const mappings = await firestoreMultiQuery<AcademicMapping>('academicMappings', [
    { field: 'studentId', operator: '==', value: studentId },
    { field: 'instituteId', operator: '==', value: instituteId },
  ]);
  await Promise.all(mappings.map((m) => deleteMapping(m.id)));
}

// ══════════════════════════════════════════════════════════════════
// PERMISSION HELPERS
// ══════════════════════════════════════════════════════════════════

// Web Owner: toggle whether an institute's admin can manage Schools.
export async function setInstituteSchoolsPermission(
  instituteId: string,
  enabled: boolean
): Promise<void> {
  return firestoreUpdate<Institute>('institutes', instituteId, {
    schoolsManagementEnabled: enabled,
    updatedAt: new Date().toISOString(),
  } as Partial<Institute>);
}

// Institute Admin: toggle whether a faculty member can manage Schools.
export async function setFacultySchoolsPermission(
  facultyId: string,
  enabled: boolean
): Promise<void> {
  return firestoreUpdate<Faculty>('faculty', facultyId, {
    schoolsManagementEnabled: enabled,
    updatedAt: new Date().toISOString(),
  } as Partial<Faculty>);
}

// ── NEW: Three-tier delegation permissions ─────────────────────────

/** Web Owner: set whether Institute Admin can create/manage Faculty. */
export async function setInstituteAdminCreateFacultyPermission(
  instituteId: string,
  enabled: boolean
): Promise<void> {
  return firestoreUpdate<Institute>('institutes', instituteId, {
    canAdminCreateFaculty: enabled,
    updatedAt: new Date().toISOString(),
  } as Partial<Institute>);
}

/** Web Owner: set whether Institute Admin can create/manage Students. */
export async function setInstituteAdminCreateStudentsPermission(
  instituteId: string,
  enabled: boolean
): Promise<void> {
  return firestoreUpdate<Institute>('institutes', instituteId, {
    canAdminCreateStudents: enabled,
    updatedAt: new Date().toISOString(),
  } as Partial<Institute>);
}

/**
 * Web Owner: set whether Faculty members (when also individually granted)
 * can create Students for this institute.
 */
export async function setInstituteFacultyCreateStudentsPermission(
  instituteId: string,
  enabled: boolean
): Promise<void> {
  return firestoreUpdate<Institute>('institutes', instituteId, {
    facultyCanCreateStudents: enabled,
    updatedAt: new Date().toISOString(),
  } as Partial<Institute>);
}

/**
 * Institute Admin: grant or revoke a specific faculty member's ability to
 * create Students. Only effective when the institute also has
 * facultyCanCreateStudents = true (set by Web Owner).
 */
export async function setFacultyCreateStudentsPermission(
  facultyId: string,
  enabled: boolean
): Promise<void> {
  return firestoreUpdate<Faculty>('faculty', facultyId, {
    canCreateStudents: enabled,
    updatedAt: new Date().toISOString(),
  } as Partial<Faculty>);
}

/** Web Owner: set whether Institute Admin can create their own private questions. */
export async function setInstituteAdminCreateQuestionsPermission(
  instituteId: string,
  enabled: boolean
): Promise<void> {
  return firestoreUpdate<Institute>('institutes', instituteId, {
    canAdminCreateQuestions: enabled,
    updatedAt: new Date().toISOString(),
  } as Partial<Institute>);
}

/** Web Owner: Gate 1 — Institute Admin can access live exam rosters. */
export async function setInstituteAdminManageRostersPermission(
  instituteId: string,
  enabled: boolean
): Promise<void> {
  return firestoreUpdate<Institute>('institutes', instituteId, {
    canAdminManageExamRosters: enabled,
    updatedAt: new Date().toISOString(),
  } as Partial<Institute>);
}

/**
 * Web Owner: Gate 2 — Faculty (when also individually granted by Institute Admin)
 * can access live exam rosters.
 */
export async function setInstituteFacultyManageRostersPermission(
  instituteId: string,
  enabled: boolean
): Promise<void> {
  return firestoreUpdate<Institute>('institutes', instituteId, {
    facultyCanManageExamRosters: enabled,
    updatedAt: new Date().toISOString(),
  } as Partial<Institute>);
}

/**
 * Institute Admin: Grant/revoke a specific faculty member's ability to manage
 * exam rosters. Only effective when institute also has
 * facultyCanManageExamRosters = true (set by Web Owner).
 */
export async function setFacultyManageRostersPermission(
  facultyId: string,
  enabled: boolean
): Promise<void> {
  return firestoreUpdate<Faculty>('faculty', facultyId, {
    canManageExamRosters: enabled,
    updatedAt: new Date().toISOString(),
  } as Partial<Faculty>);
}
// ── Question-rights setters (permission-model Phase 2) ─────────────
// These persist the config docs; ENFORCEMENT lives in the question
// callables (createQuestionAsRole / editQuestionAsRole / deleteQuestionAsRole),
// which re-read and re-validate server-side. The setters themselves are
// gated by the existing owner-scoped Firestore rules on institutes/faculty.

/** Web Owner: set an institute's question-rights ceiling. */
export async function setInstituteQuestionRightsCeiling(
  instituteId: string,
  ceiling: QuestionRightsCeiling,
): Promise<void> {
  return firestoreUpdate<Institute>('institutes', instituteId, {
    questionRightsCeiling: ceiling,
    updatedAt: new Date().toISOString(),
  } as Partial<Institute>);
}

/**
 * Institute Admin: set a faculty member's question rights. Callers should
 * clampRightsToCeiling() first; the server clamps again regardless, so a
 * tampered client cannot exceed the ceiling.
 */
export async function setFacultyQuestionRights(
  facultyId: string,
  rights: FacultyQuestionRights,
): Promise<void> {
  return firestoreUpdate<Faculty>('faculty', facultyId, {
    questionRights: rights,
    updatedAt: new Date().toISOString(),
  } as Partial<Faculty>);
}