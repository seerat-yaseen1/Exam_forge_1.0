/**
 * One-time backfill for the allocation-display fix (July 2026).
 *
 * Run AFTER deploying the updated functions, any time:
 *
 *   cd functions && npx ts-node scripts/backfill-allocated-count.ts
 *
 * WHY IT EXISTS
 * Rule-allocated assessments (allocationMode === 'rules') carry a meaningless
 * `assignedTo` — the builder writes an empty students target as a side effect
 * of its ternary. Every STAFF surface used to read that field, so hierarchy
 * exams displayed "0 Students" and their rosters came back empty, even though
 * the students were correctly allocated and could sit the exam.
 *
 * The fix denormalizes the head-count onto the assessment doc as
 * `allocatedCount`, because `allocations` and `assessmentMembers` are
 * webOwner-only in firestore.rules — institute and faculty staff physically
 * cannot read them, so the count has to ride on the doc they already fetch.
 *
 * resolveAllocation now writes that field on every commit, but assessments
 * allocated BEFORE this change have no value. They degrade honestly (the UI
 * says "By hierarchy" with no number rather than claiming zero), and this
 * script fills in the real figure.
 *
 * WHAT IT DOES (idempotent — safe to re-run)
 * For every assessment with allocationMode === 'rules', counts its ACTIVE
 * assessmentMembers docs and writes `allocatedCount`. Counting the member
 * docs rather than trusting allocations.resolvedCount is deliberate: members
 * are the exam gate, so a divergence between the two means the counter is
 * the thing that is wrong. Any divergence found is reported.
 *
 * Writes nothing else. Never touches membership, never touches assignedTo.
 *
 * Uses applicationDefault() credentials like the other scripts (run from
 * Cloud Shell in the project context).
 */

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

async function main() {
  console.log('── Backfill: assessments.allocatedCount ──\n');

  const snap = await db
    .collection('assessments')
    .where('allocationMode', '==', 'rules')
    .get();

  if (snap.empty) {
    console.log('No rule-allocated assessments found. Nothing to do.');
    return;
  }

  console.log(`Found ${snap.size} rule-allocated assessment(s).\n`);

  let written = 0;
  let unchanged = 0;
  let divergent = 0;

  for (const doc of snap.docs) {
    const assessmentId = doc.id;
    const title = String(doc.get('title') ?? '(untitled)');

    // Count the ACTIVE member docs — the exam gate, and therefore the truth.
    const memberSnap = await db
      .collection('assessmentMembers')
      .where('assessmentId', '==', assessmentId)
      .where('active', '==', true)
      .get();
    const actual = memberSnap.size;

    const stored = doc.get('allocatedCount');
    const summary = await db.collection('allocations').doc(assessmentId).get();
    const summaryCount = summary.exists ? Number(summary.get('resolvedCount') ?? 0) : null;
    const manualCount = summary.exists ? Number(summary.get('manualCount') ?? 0) : 0;

    // resolvedCount counts rule-resolved members only; manual adds are tracked
    // separately. Their sum is what the member list should contain.
    if (summaryCount !== null && summaryCount + manualCount !== actual) {
      divergent++;
      console.log(
        `  ! ${assessmentId} "${title}"\n` +
        `      allocations says ${summaryCount} rules + ${manualCount} manual = ${summaryCount + manualCount}, ` +
        `but ${actual} active member doc(s) exist.\n` +
        `      Using ${actual} (members are the exam gate). Worth investigating.`,
      );
    }

    if (stored === actual) {
      unchanged++;
      continue;
    }

    await doc.ref.set({ allocatedCount: actual }, { merge: true });
    written++;
    console.log(
      `  ✓ ${assessmentId} "${title}" — allocatedCount ${
        stored === undefined ? '(unset)' : stored
      } → ${actual}`,
    );
  }

  console.log(
    `\nDone. ${written} updated, ${unchanged} already correct, ${divergent} divergence(s) reported.`,
  );
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});