import {
  collection,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  getDocs,
  deleteDoc,
  query,
  orderBy,
  writeBatch,
} from 'firebase/firestore';
import { db } from './firebase';

// ══════════════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════════

export type Subject = {
  id: string;
  name: string;          // canonical, title-cased, always unique
  aliases: string[];     // normalised alternate names (never stored on questions)
  questionCount: number; // denormalized — updated on merge / manual refresh
  createdAt: string;
  updatedAt: string;
};

export type Topic = {
  id: string;            // slug — e.g. "prob-0001"
  name: string;          // free label, duplicates allowed across topics
  subjectId: string;     // parent subject slug
  questionCount: number;
  createdAt: string;
  updatedAt: string;
};

export type ResolveResult =
  | { kind: 'exact';   subject: Subject }
  | { kind: 'alias';   subject: Subject; matchedAlias: string }
  | { kind: 'fuzzy';   subject: Subject; score: number }
  | { kind: 'new';     normalised: string };

// ══════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ══════════════════════════════════════════════════════════════════

function newId(): string {
  return `subj_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function now(): string {
  return new Date().toISOString();
}

const COL = 'subjects';
const TOPIC_COL = 'topics';

// ── Slug ID validation ───────────────────────────────────────────
// Format: 1–4 lowercase letters + '-' + 1–4 digits, e.g. "prob-0001".
export const SLUG_ID_REGEX = /^[a-z]{1,4}-\d{1,4}$/;

export function isValidSlugId(id: string): boolean {
  return SLUG_ID_REGEX.test(id);
}

// ── Normalisation ─────────────────────────────────────────────────
// Trim → collapse whitespace → title-case each word.
// "  QUANTITATIVE aptitude  " → "Quantitative Aptitude"

export function normalizeSubject(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

// ── Levenshtein distance (for fuzzy matching) ─────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

// similarity ∈ [0, 1] — 1 means identical
function similarity(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return 1;
  const maxLen = Math.max(la.length, lb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(la, lb) / maxLen;
}

// ── Fuzzy threshold ───────────────────────────────────────────────
// Score must be ≥ this to be shown as a suggestion instead of "new".
const FUZZY_THRESHOLD = 0.65;

// ══════════════════════════════════════════════════════════════════
// CORE RESOLUTION (pure — no Firestore)
// ══════════════════════════════════════════════════════════════════

/**
 * Given raw text and the full subjects list, return the best match.
 *
 * Priority:
 *   1. Exact canonical name match (case-insensitive after normalisation)
 *   2. Exact alias match
 *   3. Fuzzy match (≥ FUZZY_THRESHOLD) — returns highest-scoring subject
 *   4. New — no match above threshold
 */
export function resolveSubject(raw: string, subjects: Subject[]): ResolveResult {
  const normalised = normalizeSubject(raw);
  const lc = normalised.toLowerCase();

  // 1 — exact canonical
  const exact = subjects.find((s) => s.name.toLowerCase() === lc);
  if (exact) return { kind: 'exact', subject: exact };

  // 2 — exact alias
  for (const s of subjects) {
    const aliasMatch = s.aliases.find((a) => a.toLowerCase() === lc);
    if (aliasMatch) return { kind: 'alias', subject: s, matchedAlias: aliasMatch };
  }

  // 3 — fuzzy (check name + all aliases)
  let bestScore = 0;
  let bestSubject: Subject | null = null;

  for (const s of subjects) {
    const candidates = [s.name, ...s.aliases];
    for (const c of candidates) {
      const score = similarity(normalised, c);
      if (score > bestScore) {
        bestScore = score;
        bestSubject = s;
      }
    }
  }

  if (bestSubject && bestScore >= FUZZY_THRESHOLD) {
    return { kind: 'fuzzy', subject: bestSubject, score: bestScore };
  }

  // 4 — new
  return { kind: 'new', normalised };
}

// ══════════════════════════════════════════════════════════════════
// FIRESTORE CRUD
// ══════════════════════════════════════════════════════════════════

/** Fetch all subjects, sorted alphabetically by name. */
export async function getAllSubjects(): Promise<Subject[]> {
  const snap = await getDocs(query(collection(db, COL), orderBy('name')));
  return snap.docs.map((d) => d.data() as Subject);
}

/** Fetch a single subject by id. */
export async function getSubject(id: string): Promise<Subject | null> {
  const snap = await getDoc(doc(db, COL, id));
  return snap.exists() ? (snap.data() as Subject) : null;
}

/**
 * Create a new subject.
 * Normalises name first; throws if a subject with the same name already exists.
 */
export async function createSubject(rawName: string): Promise<Subject> {
  const name = normalizeSubject(rawName);
  // Duplicate guard (client-side — fast enough for small lists)
  const all = await getAllSubjects();
  const collision = all.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (collision) throw new Error(`Subject "${collision.name}" already exists.`);

  const id = newId();
  const subject: Subject = {
    id,
    name,
    aliases: [],
    questionCount: 0,
    createdAt: now(),
    updatedAt: now(),
  };
  await setDoc(doc(db, COL, id), subject);
  console.log(`✅ [Subjects] createSubject → "${name}" (${id})`);
  return subject;
}

/**
 * Rename a subject.
 * • Normalises the new name.
 * • Checks for collisions with other subjects.
 * • Auto-adds the OLD name as an alias so future lookups still resolve.
 * • Does NOT update questions — the name stored on questions remains valid
 *   because resolveSubject checks aliases. Run a merge to actually rewrite questions.
 */
export async function renameSubject(subjectId: string, newRawName: string): Promise<Subject> {
  const newName = normalizeSubject(newRawName);
  const subj = await getSubject(subjectId);
  if (!subj) throw new Error(`Subject ${subjectId} not found.`);
  if (subj.name.toLowerCase() === newName.toLowerCase()) return subj; // no-op

  // Collision check
  const all = await getAllSubjects();
  const collision = all.find(
    (s) => s.id !== subjectId && s.name.toLowerCase() === newName.toLowerCase()
  );
  if (collision) throw new Error(`Subject "${newName}" already exists.`);

  const oldName = subj.name;
  // Add old name as alias (deduplicated, normalised)
  const normalOld = normalizeSubject(oldName);
  const aliasesSet = new Set([...subj.aliases.map(normalizeSubject), normalOld]);
  aliasesSet.delete(newName.toLowerCase()); // don't alias self

  const updated: Partial<Subject> = {
    name: newName,
    aliases: Array.from(aliasesSet),
    updatedAt: now(),
  };
  await updateDoc(doc(db, COL, subjectId), updated);
  console.log(`✅ [Subjects] renameSubject → "${oldName}" → "${newName}"`);
  return { ...subj, ...updated } as Subject;
}

/** Add an alias to a subject (normalised, deduplicated). */
export async function addAlias(subjectId: string, rawAlias: string): Promise<void> {
  const alias = normalizeSubject(rawAlias);
  const subj  = await getSubject(subjectId);
  if (!subj) throw new Error(`Subject ${subjectId} not found.`);
  if (subj.aliases.map((a) => a.toLowerCase()).includes(alias.toLowerCase())) return; // already there
  const updatedAliases = [...subj.aliases, alias];
  await updateDoc(doc(db, COL, subjectId), { aliases: updatedAliases, updatedAt: now() });
}

/** Remove an alias from a subject. */
export async function removeAlias(subjectId: string, alias: string): Promise<void> {
  const subj = await getSubject(subjectId);
  if (!subj) throw new Error(`Subject ${subjectId} not found.`);
  const updatedAliases = subj.aliases.filter(
    (a) => a.toLowerCase() !== alias.toLowerCase()
  );
  await updateDoc(doc(db, COL, subjectId), { aliases: updatedAliases, updatedAt: now() });
}

/**
 * Update the denormalized questionCount on a subject doc.
 * Called after bulk create, merge, or delete.
 */
export async function updateSubjectCount(subjectId: string, count: number): Promise<void> {
  await updateDoc(doc(db, COL, subjectId), { questionCount: count, updatedAt: now() });
}

// ══════════════════════════════════════════════════════════════════
// MERGE
// ══════════════════════════════════════════════════════════════════

export type MergeProgress = {
  total:   number;
  done:    number;
  phase:   'counting' | 'updating' | 'cleanup' | 'done';
};

/**
 * Merge sourceSubject → targetSubject.
 *
 * What happens:
 *   1. Fetch all non-deleted questions where subject === sourceName
 *   2. Update each question's subject field to targetName (sequential writes)
 *   3. Add sourceName (and all its aliases) to the target's aliases list
 *   4. Delete the source subject doc
 *
 * @param onProgress  Called at each step so the UI can show a progress bar.
 */
export async function mergeSubjects(
  sourceId: string,
  targetId: string,
  onProgress?: (p: MergeProgress) => void,
): Promise<{ updatedCount: number }> {
  if (sourceId === targetId) throw new Error('Source and target must be different.');

  const [source, target] = await Promise.all([getSubject(sourceId), getSubject(targetId)]);
  if (!source) throw new Error(`Source subject ${sourceId} not found.`);
  if (!target) throw new Error(`Target subject ${targetId} not found.`);

  onProgress?.({ total: 0, done: 0, phase: 'counting' });

  // 1 — find affected questions (import inline to avoid circular dep)
  const { getDocs: _getDocs, query: _query, collection: _col, where: _where } = await import('firebase/firestore');
  const qSnap = await _getDocs(
    _query(_col(db, 'questions'), _where('subject', '==', source.name), _where('isDeleted', '==', false))
  );
  const total = qSnap.docs.length;
  onProgress?.({ total, done: 0, phase: 'updating' });

  // 2 — update questions sequentially
  let done = 0;
  for (const qDoc of qSnap.docs) {
    await updateDoc(doc(db, 'questions', qDoc.id), {
      subject: target.name,
      updatedAt: new Date().toISOString(),
    });
    done++;
    onProgress?.({ total, done, phase: 'updating' });
  }

  // 3 — merge aliases: target gets sourceName + all source aliases (deduplicated)
  onProgress?.({ total, done, phase: 'cleanup' });
  const sourceAliases = [source.name, ...source.aliases].map(normalizeSubject);
  const existingAliases = target.aliases.map((a) => a.toLowerCase());
  const newAliases = [
    ...target.aliases,
    ...sourceAliases.filter(
      (a) => a.toLowerCase() !== target.name.toLowerCase() && !existingAliases.includes(a.toLowerCase())
    ),
  ];

  await updateDoc(doc(db, COL, targetId), {
    aliases:       newAliases,
    questionCount: (target.questionCount ?? 0) + total,
    updatedAt:     now(),
  });

  // 4 — delete source doc
  await deleteDoc(doc(db, COL, sourceId));

  onProgress?.({ total, done, phase: 'done' });
  console.log(`✅ [Subjects] mergeSubjects "${source.name}" → "${target.name}" (${total} questions updated)`);
  return { updatedCount: total };
}

// ══════════════════════════════════════════════════════════════════
// REFRESH QUESTION COUNTS
// ══════════════════════════════════════════════════════════════════

/**
 * Recount and sync questionCount for all subjects.
 * Runs on demand from the Subject Manager UI.
 */
export async function refreshAllSubjectCounts(): Promise<void> {
  const [subjects, qSnap] = await Promise.all([
    getAllSubjects(),
    getDocs(query(collection(db, 'questions'), ...[]))
  ]);

  // Build count map
  const counts: Record<string, number> = {};
  qSnap.docs.forEach((d) => {
    const q = d.data() as { subject: string; isDeleted: boolean };
    if (!q.isDeleted && q.subject) {
      counts[q.subject] = (counts[q.subject] ?? 0) + 1;
    }
  });

  // Batch update
  const batch = writeBatch(db);
  subjects.forEach((s) => {
    const count = counts[s.name] ?? 0;
    if (count !== s.questionCount) {
      batch.update(doc(db, COL, s.id), { questionCount: count, updatedAt: now() });
    }
  });
  await batch.commit();
  console.log('✅ [Subjects] refreshAllSubjectCounts complete');
}

// ══════════════════════════════════════════════════════════════════
// ENSURE SUBJECT EXISTS (used by bulk uploader)
// ══════════════════════════════════════════════════════════════════

/**
 * Given a raw subject name and the already-fetched subjects list,
 * either return the resolved canonical name (exact/alias/fuzzy match)
 * or create a new subject doc and return its name.
 *
 * Mutates `subjectsCache` in-place when a new subject is created so
 * subsequent calls in the same bulk session don't create duplicates.
 */
export async function ensureSubject(
  rawName: string,
  subjectsCache: Subject[],
): Promise<{ canonicalName: string; wasCreated: boolean }> {
  const result = resolveSubject(rawName, subjectsCache);

  if (result.kind === 'exact' || result.kind === 'alias' || result.kind === 'fuzzy') {
    return { canonicalName: result.subject.name, wasCreated: false };
  }

  // New subject — create it
  const name = result.normalised;
  // Guard against duplicates within the same batch session
  const inCache = subjectsCache.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (inCache) return { canonicalName: inCache.name, wasCreated: false };

  const id = newId();
  const newSubject: Subject = {
    id, name, aliases: [], questionCount: 0, createdAt: now(), updatedAt: now(),
  };
  await setDoc(doc(db, COL, id), newSubject);
  subjectsCache.push(newSubject); // mutate cache so next call in batch sees it
  console.log(`✅ [Subjects] ensureSubject created → "${name}"`);
  return { canonicalName: name, wasCreated: true };
}

// ══════════════════════════════════════════════════════════════════
// SLUG-BASED CREATE (Subjects Module — user types the ID)
// ══════════════════════════════════════════════════════════════════

/**
 * Create a subject using a user-supplied slug ID (e.g. "math-0001").
 * Name is NOT unique — duplicate names allowed because the ID is the key.
 */
export async function createSubjectWithSlug(slugId: string, rawName: string): Promise<Subject> {
  if (!isValidSlugId(slugId)) {
    throw new Error(`Invalid ID "${slugId}". Use 1–4 letters, a dash, and 1–4 digits (e.g. "math-0001").`);
  }
  const name = normalizeSubject(rawName);
  if (!name) throw new Error('Name is required.');

  const existing = await getDoc(doc(db, COL, slugId));
  if (existing.exists()) throw new Error(`Subject ID "${slugId}" is already in use.`);

  const subject: Subject = {
    id: slugId,
    name,
    aliases: [],
    questionCount: 0,
    createdAt: now(),
    updatedAt: now(),
  };
  await setDoc(doc(db, COL, slugId), subject);
  console.log(`✅ [Subjects] createSubjectWithSlug → ${slugId} "${name}"`);
  return subject;
}

// ══════════════════════════════════════════════════════════════════
// TOPICS — first-class entity, owned by exactly one subject
// ══════════════════════════════════════════════════════════════════

export async function getAllTopics(): Promise<Topic[]> {
  const snap = await getDocs(query(collection(db, TOPIC_COL), orderBy('name')));
  return snap.docs.map((d) => d.data() as Topic);
}

export async function getTopicsBySubject(subjectId: string): Promise<Topic[]> {
  const { where } = await import('firebase/firestore');
  const snap = await getDocs(
    query(collection(db, TOPIC_COL), where('subjectId', '==', subjectId), orderBy('name'))
  );
  return snap.docs.map((d) => d.data() as Topic);
}

export async function createTopicWithSlug(
  slugId: string,
  rawName: string,
  subjectId: string,
): Promise<Topic> {
  if (!isValidSlugId(slugId)) {
    throw new Error(`Invalid ID "${slugId}". Use 1–4 letters, a dash, and 1–4 digits (e.g. "prob-0001").`);
  }
  const name = normalizeSubject(rawName);
  if (!name) throw new Error('Name is required.');
  if (!subjectId) throw new Error('Subject is required.');

  const [parentSnap, existingSnap] = await Promise.all([
    getDoc(doc(db, COL, subjectId)),
    getDoc(doc(db, TOPIC_COL, slugId)),
  ]);
  if (!parentSnap.exists()) throw new Error(`Parent subject "${subjectId}" not found.`);
  if (existingSnap.exists()) throw new Error(`Topic ID "${slugId}" is already in use.`);

  const topic: Topic = {
    id: slugId,
    name,
    subjectId,
    questionCount: 0,
    createdAt: now(),
    updatedAt: now(),
  };
  await setDoc(doc(db, TOPIC_COL, slugId), topic);
  console.log(`✅ [Topics] createTopicWithSlug → ${slugId} "${name}" (subject ${subjectId})`);
  return topic;
}

export async function deleteTopic(topicId: string): Promise<void> {
  await deleteDoc(doc(db, TOPIC_COL, topicId));
  console.log(`✅ [Topics] deleteTopic → ${topicId}`);
}
