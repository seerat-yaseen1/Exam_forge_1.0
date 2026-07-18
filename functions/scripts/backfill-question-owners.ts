/**
 * One-time backfill for permission-model Phase 0 (tenant fence).
 *
 * Run BEFORE deploying the tightened firestore.rules, AFTER pulling the
 * frontend that adds owner-scoped query filters:
 *
 *   cd functions && npx ts-node scripts/backfill-question-owners.ts
 *
 * What it does (idempotent — safe to re-run):
 *
 *   Pass 1 — OWNER STAMP: any `questions` or `questionAnswers` doc missing
 *   `ownerType` gets `ownerType: 'webOwner', ownerId: 'webOwner'`. Legacy
 *   docs predate the ownership model; the read rules already DEFAULT them
 *   to webOwner via .get(), but Firestore equality FILTERS exclude
 *   field-missing docs, so the new provable queries
 *   (where('ownerType','==','webOwner')) would silently hide legacy
 *   questions from grant browsing and review until this runs.
 *
 *   Pass 2 — TENANT STAMP: every institute- or faculty-authored question
 *   gets `instituteId` — the institute it was authored inside (for faculty,
 *   resolved via the faculty doc; for institutes, ownerId IS the
 *   institute). The tenant-fence read rule and the coming Phase-1
 *   institute-wide visibility both key off this field. webOwner content is
 *   never stamped (and the rules reject a stamp on it).
 *
 * Prints per-pass counts. Uses applicationDefault() credentials like the
 * other migrate-* scripts (run from Cloud Shell in the project context).
 */

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

const BATCH_LIMIT = 400; // stay under the 500-write batch cap

async function commitInChunks(
  updates: Array<{ ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }>,
  label: string,
): Promise<void> {
  for (let i = 0; i < updates.length; i += BATCH_LIMIT) {
    const chunk = updates.slice(i, i + BATCH_LIMIT);
    const batch = db.batch();
    chunk.forEach((u) => batch.update(u.ref, u.data));
    await batch.commit();
    console.log(`  ${label}: committed ${Math.min(i + BATCH_LIMIT, updates.length)}/${updates.length}`);
  }
}

async function pass1OwnerStamp(): Promise<void> {
  console.log('Pass 1 — owner stamp (legacy docs → webOwner/webOwner)');
  for (const col of ['questions', 'questionAnswers']) {
    const snap = await db.collection(col).get();
    const updates: Array<{ ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }> = [];
    snap.docs.forEach((d) => {
      const data = d.data();
      if (data.ownerType === undefined) {
        updates.push({ ref: d.ref, data: { ownerType: 'webOwner', ownerId: 'webOwner' } });
      }
    });
    console.log(`  ${col}: ${snap.size} docs scanned, ${updates.length} legacy docs to stamp`);
    await commitInChunks(updates, col);
  }
}

async function pass2TenantStamp(): Promise<void> {
  console.log('Pass 2 — tenant stamp (institute/faculty-authored → instituteId)');

  // faculty → institute map
  const facSnap = await db.collection('faculty').get();
  const facultyInstitute = new Map<string, string>();
  facSnap.docs.forEach((d) => {
    const data = d.data();
    if (typeof data.instituteId === 'string' && data.instituteId) {
      facultyInstitute.set(d.id, data.instituteId);
      if (typeof data.id === 'string' && data.id) facultyInstitute.set(data.id, data.instituteId);
    }
  });
  console.log(`  faculty map: ${facultyInstitute.size} entries`);

  const qSnap = await db.collection('questions').get();
  const updates: Array<{ ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }> = [];
  let unresolved = 0;
  qSnap.docs.forEach((d) => {
    const data = d.data();
    if (data.instituteId !== undefined) return; // already stamped
    if (data.ownerType === 'institute' && typeof data.ownerId === 'string') {
      updates.push({ ref: d.ref, data: { instituteId: data.ownerId } });
    } else if (data.ownerType === 'faculty' && typeof data.ownerId === 'string') {
      const inst = facultyInstitute.get(data.ownerId);
      if (inst) {
        updates.push({ ref: d.ref, data: { instituteId: inst } });
      } else {
        unresolved++;
        console.warn(`  ! question ${d.id}: faculty owner ${data.ownerId} has no institute mapping — left unstamped`);
      }
    }
    // webOwner / legacy (now webOwner via pass 1) — never stamped.
  });
  console.log(`  questions: ${updates.length} to stamp, ${unresolved} unresolved`);
  await commitInChunks(updates, 'questions');
}

async function main(): Promise<void> {
  await pass1OwnerStamp();
  await pass2TenantStamp();
  console.log('Backfill complete.');
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});