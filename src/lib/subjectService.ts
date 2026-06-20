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
  increment,
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

/**
 * Best-effort adjustment of the denormalized questionCount on a subject and/or
 * topic when a question is added (+1) or removed (-1). Called from the question
 * write paths so counts stay live without a manual recount.
 *
 * Intentionally NEVER throws: a missing/renamed taxonomy doc must not break a
 * question save. Any drift is reconcilable via refreshAll*Counts().
 */
export async function bumpTaxonomyCounts(
  ref: { subjectId?: string | null; topicId?: string | null },
  delta: number,
): Promise<void> {
  if (delta === 0) return;
  const ops: Promise<unknown>[] = [];
  if (ref.subjectId) {
    ops.push(updateDoc(doc(db, COL, ref.subjectId), { questionCount: increment(delta), updatedAt: now() }).catch(() => {}));
  }
  if (ref.topicId) {
    ops.push(updateDoc(doc(db, TOPIC_COL, ref.topicId), { questionCount: increment(delta), updatedAt: now() }).catch(() => {}));
  }
  await Promise.all(ops);
}

/**
 * Recount and sync the denormalized questionCount for every topic.
 * Tallies live questions by topicId (skipping soft-deleted) and writes any
 * changed counts. Mirrors refreshAllSubjectCounts. Writes are chunked at 450
 * (Firestore write-batch cap is 500).
 */
export async function refreshAllTopicCounts(): Promise<void> {
  const [topics, qSnap] = await Promise.all([
    getAllTopics(),
    getDocs(collection(db, 'questions')),
  ]);

  // Tally by topicId (the preferred slug link).
  const counts: Record<string, number> = {};
  qSnap.docs.forEach((d) => {
    const q = d.data() as { topicId?: string; isDeleted?: boolean };
    if (!q.isDeleted && q.topicId) {
      counts[q.topicId] = (counts[q.topicId] ?? 0) + 1;
    }
  });

  const changed = topics.filter((t) => (counts[t.id] ?? 0) !== t.questionCount);
  const CHUNK = 450;
  for (let i = 0; i < changed.length; i += CHUNK) {
    const batch = writeBatch(db);
    for (const t of changed.slice(i, i + CHUNK)) {
      batch.update(doc(db, TOPIC_COL, t.id), { questionCount: counts[t.id] ?? 0, updatedAt: now() });
    }
    await batch.commit();
  }
  console.log(`✅ [Topics] refreshAllTopicCounts complete (${changed.length} updated)`);
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
    query(collection(db, TOPIC_COL), where('subjectId', '==', subjectId))
  );
  return snap.docs
    .map((d) => d.data() as Topic)
    .sort((a, b) => a.name.localeCompare(b.name));
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

/**
 * Move a topic to a different subject.
 * Updates topics/{id}.subjectId and also rewrites every question that points
 * at this topic so subjectId stays consistent.
 */
export async function moveTopic(topicId: string, newSubjectId: string): Promise<{ updatedQuestions: number }> {
  const { where } = await import('firebase/firestore');
  const [topicSnap, parentSnap] = await Promise.all([
    getDoc(doc(db, TOPIC_COL, topicId)),
    getDoc(doc(db, COL, newSubjectId)),
  ]);
  if (!topicSnap.exists()) throw new Error(`Topic "${topicId}" not found.`);
  if (!parentSnap.exists()) throw new Error(`Target subject "${newSubjectId}" not found.`);
  const topic = topicSnap.data() as Topic;
  if (topic.subjectId === newSubjectId) return { updatedQuestions: 0 };

  // Re-point every question tagged with this topicId
  const qSnap = await getDocs(query(collection(db, 'questions'), where('topicId', '==', topicId)));
  const batch = writeBatch(db);
  qSnap.docs.forEach((qDoc) => {
    batch.update(qDoc.ref, { subjectId: newSubjectId, updatedAt: now() });
  });
  batch.update(doc(db, TOPIC_COL, topicId), { subjectId: newSubjectId, updatedAt: now() });
  await batch.commit();

  console.log(`✅ [Topics] moveTopic ${topicId} → subject ${newSubjectId} (${qSnap.size} questions updated)`);
  return { updatedQuestions: qSnap.size };
}

/**
 * Update a subject's ID and/or name.
 * • Name-only change → single field update.
 * • ID change → copies the doc under the new ID, re-points every topic's subjectId
 *   and every question's subjectId, then deletes the old doc. All in one batch.
 */
export async function updateSubject(
  oldId: string,
  newId: string,
  newRawName: string,
): Promise<{ updatedTopics: number; updatedQuestions: number }> {
  const { where } = await import('firebase/firestore');
  const name = normalizeSubject(newRawName);
  if (!name) throw new Error('Name is required.');

  const oldSnap = await getDoc(doc(db, COL, oldId));
  if (!oldSnap.exists()) throw new Error(`Subject "${oldId}" not found.`);
  const oldSubj = oldSnap.data() as Subject;

  // Name-only path
  if (oldId === newId) {
    if (oldSubj.name === name) return { updatedTopics: 0, updatedQuestions: 0 };
    await updateDoc(doc(db, COL, oldId), { name, updatedAt: now() });
    return { updatedTopics: 0, updatedQuestions: 0 };
  }

  if (!isValidSlugId(newId)) {
    throw new Error(`Invalid ID "${newId}". Use 1–4 letters, a dash, and 1–4 digits.`);
  }
  const clash = await getDoc(doc(db, COL, newId));
  if (clash.exists()) throw new Error(`Subject ID "${newId}" is already in use.`);

  const [topicsSnap, qSnap] = await Promise.all([
    getDocs(query(collection(db, TOPIC_COL), where('subjectId', '==', oldId))),
    getDocs(query(collection(db, 'questions'),  where('subjectId', '==', oldId))),
  ]);

  const batch = writeBatch(db);
  batch.set(doc(db, COL, newId), { ...oldSubj, id: newId, name, updatedAt: now() });
  topicsSnap.docs.forEach((t) => batch.update(t.ref, { subjectId: newId, updatedAt: now() }));
  qSnap.docs.forEach((q) =>     batch.update(q.ref, { subjectId: newId, updatedAt: now() }));
  batch.delete(doc(db, COL, oldId));
  await batch.commit();

  console.log(`✅ [Subjects] updateSubject ${oldId} → ${newId} "${name}" (${topicsSnap.size} topics, ${qSnap.size} questions)`);
  return { updatedTopics: topicsSnap.size, updatedQuestions: qSnap.size };
}

/**
 * Update a topic's ID and/or name.
 * • Name-only change → single field update.
 * • ID change → copies the doc under the new ID, re-points every question's
 *   topicId, then deletes the old doc.
 */
export async function updateTopic(
  oldId: string,
  newId: string,
  newRawName: string,
): Promise<{ updatedQuestions: number }> {
  const { where } = await import('firebase/firestore');
  const name = normalizeSubject(newRawName);
  if (!name) throw new Error('Name is required.');

  const oldSnap = await getDoc(doc(db, TOPIC_COL, oldId));
  if (!oldSnap.exists()) throw new Error(`Topic "${oldId}" not found.`);
  const oldTopic = oldSnap.data() as Topic;

  if (oldId === newId) {
    if (oldTopic.name === name) return { updatedQuestions: 0 };
    await updateDoc(doc(db, TOPIC_COL, oldId), { name, updatedAt: now() });
    return { updatedQuestions: 0 };
  }

  if (!isValidSlugId(newId)) {
    throw new Error(`Invalid ID "${newId}". Use 1–4 letters, a dash, and 1–4 digits.`);
  }
  const clash = await getDoc(doc(db, TOPIC_COL, newId));
  if (clash.exists()) throw new Error(`Topic ID "${newId}" is already in use.`);

  const qSnap = await getDocs(query(collection(db, 'questions'), where('topicId', '==', oldId)));

  const batch = writeBatch(db);
  batch.set(doc(db, TOPIC_COL, newId), { ...oldTopic, id: newId, name, updatedAt: now() });
  qSnap.docs.forEach((q) => batch.update(q.ref, { topicId: newId, updatedAt: now() }));
  batch.delete(doc(db, TOPIC_COL, oldId));
  await batch.commit();

  console.log(`✅ [Topics] updateTopic ${oldId} → ${newId} "${name}" (${qSnap.size} questions)`);
  return { updatedQuestions: qSnap.size };
}

/**
 * Delete a subject. Refuses if any topic or question still references it —
 * the caller should reassign or delete those first.
 */
export async function deleteSubject(subjectId: string): Promise<void> {
  const { where } = await import('firebase/firestore');
  const [topicsSnap, qSnap] = await Promise.all([
    getDocs(query(collection(db, TOPIC_COL), where('subjectId', '==', subjectId))),
    getDocs(query(collection(db, 'questions'),  where('subjectId', '==', subjectId))),
  ]);
  if (topicsSnap.size > 0 || qSnap.size > 0) {
    throw new Error(
      `Cannot delete: ${topicsSnap.size} topic(s) and ${qSnap.size} question(s) still reference this subject. Reassign or delete them first.`
    );
  }
  await deleteDoc(doc(db, COL, subjectId));
  console.log(`✅ [Subjects] deleteSubject → ${subjectId}`);
}

export async function deleteTopic(topicId: string): Promise<void> {
  await deleteDoc(doc(db, TOPIC_COL, topicId));
  console.log(`✅ [Topics] deleteTopic → ${topicId}`);
}

/**
 * Merge one topic into another (e.g. fold "ages" into "age").
 * Re-points every question tagged with the source topicId onto the target
 * (topicId + canonical topic name + subjectId, plus the back-compat `subject`
 * name), folds the source's questions into the target's denormalized count,
 * then deletes the source topic. Mirrors mergeSubjects / moveTopic.
 *
 * Question writes are chunked at 450 (Firestore write-batch cap is 500).
 */
export async function mergeTopics(
  sourceId: string,
  targetId: string,
): Promise<{ updatedQuestions: number }> {
  if (sourceId === targetId) throw new Error('Source and target topics must be different.');
  const { where } = await import('firebase/firestore');

  const [sourceSnap, targetSnap] = await Promise.all([
    getDoc(doc(db, TOPIC_COL, sourceId)),
    getDoc(doc(db, TOPIC_COL, targetId)),
  ]);
  if (!sourceSnap.exists()) throw new Error(`Source topic "${sourceId}" not found.`);
  if (!targetSnap.exists()) throw new Error(`Target topic "${targetId}" not found.`);
  const target = targetSnap.data() as Topic;

  // Canonical subject name for the back-compat `subject` field on questions.
  const subjSnap = await getDoc(doc(db, COL, target.subjectId));
  const targetSubjectName = subjSnap.exists() ? (subjSnap.data() as Subject).name : undefined;

  // Re-point every question tagged with the source topicId.
  const qSnap = await getDocs(query(collection(db, 'questions'), where('topicId', '==', sourceId)));
  const docs = qSnap.docs;

  const CHUNK = 450; // leave headroom under the 500-op batch cap
  for (let i = 0; i < docs.length; i += CHUNK) {
    const batch = writeBatch(db);
    for (const qDoc of docs.slice(i, i + CHUNK)) {
      const patch: Record<string, unknown> = {
        topicId:   target.id,
        topic:     target.name,
        subjectId: target.subjectId,
        updatedAt: now(),
      };
      if (targetSubjectName) patch.subject = targetSubjectName; // never write undefined
      batch.update(qDoc.ref, patch);
    }
    await batch.commit();
  }

  // Fold counts into the target, then remove the source topic.
  await updateDoc(doc(db, TOPIC_COL, targetId), {
    questionCount: (target.questionCount ?? 0) + docs.length,
    updatedAt: now(),
  });
  await deleteDoc(doc(db, TOPIC_COL, sourceId));

  console.log(`✅ [Topics] mergeTopics "${sourceId}" → "${targetId}" (${docs.length} questions updated)`);
  return { updatedQuestions: docs.length };
}
