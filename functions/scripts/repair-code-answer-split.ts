/**
 * Repair for the coding answer-key split.
 *
 *   cd functions && npx ts-node scripts/repair-code-answer-split.ts [--apply]
 *
 * ── WHAT WENT WRONG ───────────────────────────────────────────────
 *
 * `ANSWER_KEYS_S` in functions/src/index.ts is the server twin of `ANSWER_KEYS`
 * in src/lib/questionAnswerSplit.ts, and it was missing `'tests'`. Every
 * question written through the faculty / institute callables
 * (createQuestionAsRole, createQuestionsBulkAsRole, createQuestionGroupAsRole,
 * editQuestionAsRole, resolveQuestionRequest) therefore split wrongly, in both
 * directions at once:
 *
 *   • `tests` — the hidden suite, expected outputs included — was written to
 *     the PUBLIC `questions` document, which is the collection the answer key
 *     is specifically kept out of;
 *   • `questionAnswers/{id}.tests` was never written, so every grading path,
 *     which reads the suite from there, saw an EMPTY suite.
 *
 * The second half is what made coding questions unusable. With no tests:
 *   • runCodeSample returns `no_samples`, so the candidate is told the question
 *     has nothing to run and cannot execute their code at all;
 *   • buildCodeSubmission hands the judge zero tests, which comes back as
 *     `judge_unavailable`, retries five times, exhausts, and leaves the answer
 *     permanently in manual review — scoring nothing.
 *
 * The direct client write path (createQuestion, used by the Web Owner bank)
 * always split correctly, so only faculty- and institute-authored coding
 * questions are affected.
 *
 * ── WHAT THIS DOES ────────────────────────────────────────────────
 *
 * For every `questions` document carrying a non-empty `tests` array:
 *
 *   1. MOVE the suite to `questionAnswers/{id}.tests` — but only when that
 *      sibling has no usable suite already. A sibling that already holds tests
 *      is authoritative and is never overwritten: it was either written
 *      correctly by the client path or repaired by an earlier run.
 *   2. EMPTY `tests` on the public document, so the key stops sitting in the
 *      collection students' papers are assembled from.
 *
 * Idempotent, and safe to re-run: a second pass finds nothing to move because
 * step 2 removed the source.
 *
 * DRY RUN BY DEFAULT. Pass --apply to commit. Without it, the script reports
 * exactly what it would change and writes nothing.
 */

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

const APPLY = process.argv.includes('--apply');
const BATCH_LIMIT = 200; // two writes per question; stays under the 500 cap

interface Repair {
  id: string;
  engine: string;
  testCount: number;
  /** The sibling already had a suite — the public copy is only cleared. */
  siblingAlreadyHadTests: boolean;
}

function hasUsableSuite(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0;
}

async function main(): Promise<void> {
  console.log(APPLY ? 'MODE: apply (writes will be committed)' : 'MODE: dry run (no writes)');

  const snap = await db.collection('questions').get();
  const leaking = snap.docs.filter((d) => hasUsableSuite(d.get('tests')));

  console.log(`Scanned ${snap.size} questions; ${leaking.length} carry a suite on the public document.`);
  if (leaking.length === 0) {
    console.log('Nothing to repair.');
    return;
  }

  // Read the siblings first. A question whose answer doc already holds a suite
  // must not have it overwritten by the public copy, which may be older.
  const repairs: Repair[] = [];
  const writes: Array<{ ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown>; merge: boolean }> = [];
  const nowIso = new Date().toISOString();

  for (let i = 0; i < leaking.length; i += 300) {
    const chunk = leaking.slice(i, i + 300);
    const siblings = await db.getAll(
      ...chunk.map((d) => db.collection('questionAnswers').doc(d.id)),
    );
    chunk.forEach((qDoc, j) => {
      const sibling = siblings[j];
      const tests = qDoc.get('tests') as unknown[];
      const siblingAlreadyHadTests = hasUsableSuite(sibling.get('tests'));

      repairs.push({
        id: qDoc.id,
        engine: String(qDoc.get('engine') ?? '(none)'),
        testCount: tests.length,
        siblingAlreadyHadTests,
      });

      if (!siblingAlreadyHadTests) {
        writes.push({
          ref: db.collection('questionAnswers').doc(qDoc.id),
          // merge, so the sibling's correctIds / correctPairs / modelAnswer and
          // its owner stamps survive untouched.
          data: { tests, updatedAt: nowIso },
          merge: true,
        });
      }
      writes.push({
        ref: db.collection('questions').doc(qDoc.id),
        data: { tests: [], updatedAt: nowIso },
        merge: true,
      });
    });
  }

  const moved = repairs.filter((r) => !r.siblingAlreadyHadTests);
  const clearedOnly = repairs.filter((r) => r.siblingAlreadyHadTests);
  const nonCode = repairs.filter((r) => r.engine !== 'code');

  console.log(`  suites to MOVE to questionAnswers: ${moved.length}`);
  console.log(`  public copies to CLEAR only (sibling already correct): ${clearedOnly.length}`);
  if (nonCode.length > 0) {
    // Not expected — only the code engine writes tests. Worth naming rather
    // than repairing silently, because it means something else set the field.
    console.warn(`  WARNING: ${nonCode.length} are not engine 'code': ${nonCode.map((r) => `${r.id}(${r.engine})`).join(', ')}`);
  }
  repairs.slice(0, 20).forEach((r) => {
    console.log(`    ${r.id}  engine=${r.engine}  tests=${r.testCount}`
      + `  ${r.siblingAlreadyHadTests ? '→ clear public only' : '→ move + clear'}`);
  });
  if (repairs.length > 20) console.log(`    … and ${repairs.length - 20} more`);

  if (!APPLY) {
    console.log('\nDry run complete. Re-run with --apply to commit these changes.');
    return;
  }

  for (let i = 0; i < writes.length; i += BATCH_LIMIT) {
    const chunk = writes.slice(i, i + BATCH_LIMIT);
    const batch = db.batch();
    chunk.forEach((w) => batch.set(w.ref, w.data, { merge: w.merge }));
    await batch.commit();
    console.log(`  committed ${Math.min(i + BATCH_LIMIT, writes.length)}/${writes.length} writes`);
  }

  console.log('\nRepair complete.');
  console.log('Attempts already judged against the empty suite still hold a stale');
  console.log('verdict. Re-run grading for them with the regradeAttempts callable,');
  console.log('which re-scores from the repaired answer documents.');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
