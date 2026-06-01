/**
 * One-time migration: promote free-text `subject` / `topic` strings on
 * `questions/{id}` into first-class `subjects/{slug}` and `topics/{slug}` docs.
 *
 *   - Scans all non-deleted questions and derives unique (subject, topic) pairs.
 *   - Generates slug IDs of the form `^[a-z]{1,4}-\d{1,4}$` (e.g. `math-0001`,
 *     `prob-0001`). Same name → same slug across questions.
 *   - Creates/updates `subjects/{slug}` (skips slugs already in use by an
 *     existing subject doc).
 *   - For topics, scopes uniqueness per subject — the SAME topic name under two
 *     different subjects intentionally gets two different IDs (e.g. `prob-0001`
 *     under math, `prob-0002` under stats).
 *   - Back-fills `subjectId` and `topicId` on every question.
 *
 * Existing inline `subject` / `topic` strings are left untouched so older code
 * paths keep working until you remove them in a follow-up.
 *
 * Idempotent — safe to re-run. Re-using an existing slug is a no-op.
 *
 * Usage (from the functions/ directory):
 *   npx tsx scripts/migrate-subjects-topics.ts
 *   GOOGLE_APPLICATION_CREDENTIALS=./sa.json npx tsx scripts/migrate-subjects-topics.ts
 */

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

const nowIso = () => new Date().toISOString();

// Normalise a name for matching (trim, collapse whitespace, lowercase).
const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

// Title-case for display.
const titleCase = (s: string) =>
  s.trim().replace(/\s+/g, ' ').split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');

// Derive an alpha prefix from a name: first 1–4 a-z chars.
function alphaPrefix(name: string): string {
  const letters = name.toLowerCase().replace(/[^a-z]/g, '');
  const p = letters.slice(0, 4);
  return p.length > 0 ? p : 'misc';
}

function pad4(n: number): string {
  return String(n).padStart(4, '0');
}

async function migrate() {
  // ── Load existing subject + topic docs so we don't collide with hand-created ones
  const [existingSubjectsSnap, existingTopicsSnap, questionsSnap] = await Promise.all([
    db.collection('subjects').get(),
    db.collection('topics').get(),
    db.collection('questions').get(),
  ]);

  const usedSubjectIds = new Set<string>(existingSubjectsSnap.docs.map((d) => d.id));
  const usedTopicIds   = new Set<string>(existingTopicsSnap.docs.map((d) => d.id));

  // name → slugId  (for re-use across questions sharing the same name)
  const subjectNameToId = new Map<string, string>();
  existingSubjectsSnap.docs.forEach((d) => {
    const name = (d.data().name as string) ?? '';
    if (name) subjectNameToId.set(norm(name), d.id);
  });

  // (subjectId, topicName) → topicSlugId
  const topicKeyToId = new Map<string, string>();
  existingTopicsSnap.docs.forEach((d) => {
    const data = d.data() as { name?: string; subjectId?: string };
    if (data.name && data.subjectId) {
      topicKeyToId.set(`${data.subjectId}::${norm(data.name)}`, d.id);
    }
  });

  console.log(`Loaded ${existingSubjectsSnap.size} subjects, ${existingTopicsSnap.size} topics, ${questionsSnap.size} questions.`);

  function nextSlug(prefix: string, used: Set<string>): string {
    for (let n = 1; n <= 9999; n++) {
      const candidate = `${prefix}-${pad4(n)}`;
      if (!used.has(candidate)) return candidate;
    }
    throw new Error(`Slug space exhausted for prefix "${prefix}".`);
  }

  let subjectsCreated = 0;
  let topicsCreated = 0;
  let questionsUpdated = 0;
  let failed = 0;

  for (const qDoc of questionsSnap.docs) {
    const q = qDoc.data() as {
      isDeleted?: boolean;
      subject?: string;
      topic?: string;
      subjectId?: string;
      topicId?: string;
    };

    if (q.isDeleted) continue;

    try {
      const rawSubject = (q.subject ?? '').trim();
      const rawTopic   = (q.topic ?? '').trim();
      if (!rawSubject) continue;

      const subjectKey = norm(rawSubject);
      let subjectId = subjectNameToId.get(subjectKey);
      if (!subjectId) {
        subjectId = nextSlug(alphaPrefix(rawSubject), usedSubjectIds);
        await db.collection('subjects').doc(subjectId).set({
          id: subjectId,
          name: titleCase(rawSubject),
          aliases: [],
          questionCount: 0,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });
        usedSubjectIds.add(subjectId);
        subjectNameToId.set(subjectKey, subjectId);
        subjectsCreated++;
      }

      let topicId: string | undefined;
      if (rawTopic) {
        const tKey = `${subjectId}::${norm(rawTopic)}`;
        topicId = topicKeyToId.get(tKey);
        if (!topicId) {
          topicId = nextSlug(alphaPrefix(rawTopic), usedTopicIds);
          await db.collection('topics').doc(topicId).set({
            id: topicId,
            name: titleCase(rawTopic),
            subjectId,
            questionCount: 0,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          });
          usedTopicIds.add(topicId);
          topicKeyToId.set(tKey, topicId);
          topicsCreated++;
        }
      }

      const needsUpdate = q.subjectId !== subjectId || (topicId && q.topicId !== topicId);
      if (needsUpdate) {
        await qDoc.ref.update({
          subjectId,
          ...(topicId ? { topicId } : {}),
          updatedAt: nowIso(),
        });
        questionsUpdated++;
      }
    } catch (err) {
      console.error(`[fail] question ${qDoc.id}:`, err);
      failed++;
    }
  }

  // Recount denormalized questionCount on subjects + topics.
  const subjectCounts: Record<string, number> = {};
  const topicCounts:   Record<string, number> = {};
  questionsSnap.docs.forEach((d) => {
    const q = d.data() as { isDeleted?: boolean; subjectId?: string; topicId?: string };
    if (q.isDeleted) return;
    if (q.subjectId) subjectCounts[q.subjectId] = (subjectCounts[q.subjectId] ?? 0) + 1;
    if (q.topicId)   topicCounts[q.topicId]     = (topicCounts[q.topicId]     ?? 0) + 1;
  });

  const batch = db.batch();
  for (const [id, count] of Object.entries(subjectCounts)) {
    batch.update(db.collection('subjects').doc(id), { questionCount: count, updatedAt: nowIso() });
  }
  for (const [id, count] of Object.entries(topicCounts)) {
    batch.update(db.collection('topics').doc(id), { questionCount: count, updatedAt: nowIso() });
  }
  await batch.commit();

  console.log('────────────────────────────────────────');
  console.log(`subjects created:    ${subjectsCreated}`);
  console.log(`topics created:      ${topicsCreated}`);
  console.log(`questions updated:   ${questionsUpdated}`);
  console.log(`failures:            ${failed}`);
}

migrate()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
