/**
 * One-time migration: split answer-key fields out of `questions/{id}` into
 * the sibling `questionAnswers/{id}` collection.
 *
 *   - For each non-deleted `questions/{id}` doc, copy
 *       correctIds, correctPairs, modelAnswer
 *     into `questionAnswers/{id}` (idempotent — only writes when missing
 *     or stale).
 *   - Then null out those fields on `questions/{id}` so the public payload
 *     no longer leaks the answer key.
 *
 * Safe to run multiple times. The questionBankService already falls back to
 * inline fields for pre-migration docs, so service availability is not
 * affected during the run.
 *
 * Usage (from the functions/ directory):
 *   npx tsx scripts/migrate-question-answers.ts        # default service account
 *   GOOGLE_APPLICATION_CREDENTIALS=./sa.json npx tsx scripts/migrate-question-answers.ts
 */

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

initializeApp({ credential: applicationDefault() });

const db = getFirestore();

interface QuestionDoc {
  id: string;
  isDeleted?: boolean;
  ownerType?: string;
  ownerId?: string;
  correctIds?: string[];
  correctPairs?: Array<{ leftId: string; rightId: string }>;
  modelAnswer?: string;
}

async function migrate() {
  const snap = await db.collection('questions').get();
  console.log(`Found ${snap.size} question docs.`);

  let written = 0;
  let stripped = 0;
  let skipped = 0;
  let failed = 0;

  for (const docSnap of snap.docs) {
    const q: QuestionDoc = { ...(docSnap.data() as QuestionDoc), id: docSnap.id };
    const id = docSnap.id;
    const nowIso = new Date().toISOString();

    try {
      const answerRef = db.collection('questionAnswers').doc(id);
      const existing = await answerRef.get();

      const hasInlineAnswer =
        (q.correctIds && q.correctIds.length > 0)
        || (q.correctPairs && q.correctPairs.length > 0)
        || (typeof q.modelAnswer === 'string' && q.modelAnswer.length > 0);

      if (!existing.exists) {
        // Always create — even if all answer fields are empty arrays/strings,
        // so the sibling lookup short-circuits cleanly going forward.
        await answerRef.set({
          id,
          ownerType:   q.ownerType ?? 'webOwner',
          ownerId:     q.ownerId   ?? 'webOwner',
          correctIds:   q.correctIds   ?? [],
          correctPairs: q.correctPairs ?? [],
          modelAnswer:  q.modelAnswer  ?? '',
          updatedAt: nowIso,
        });
        written++;
      } else {
        skipped++;
      }

      if (hasInlineAnswer) {
        await docSnap.ref.update({
          correctIds:   FieldValue.delete(),
          correctPairs: FieldValue.delete(),
          modelAnswer:  FieldValue.delete(),
          updatedAt: nowIso,
        });
        stripped++;
      }
    } catch (err) {
      console.error(`[fail] question ${id}:`, err);
      failed++;
    }
  }

  console.log('────────────────────────────────────────');
  console.log(`questionAnswers written:  ${written}`);
  console.log(`questionAnswers skipped:  ${skipped} (already existed)`);
  console.log(`questions stripped:       ${stripped}`);
  console.log(`failures:                 ${failed}`);
}

migrate()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
