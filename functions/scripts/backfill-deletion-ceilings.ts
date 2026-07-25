/**
 * One-time backfill for Feature #15 Phase 3 (deletion-rights enforcement).
 *
 * ⚠️  RUN THIS **BEFORE** DEPLOYING THE PHASE 3 FUNCTIONS.
 *
 *   cd functions && npx ts-node scripts/backfill-deletion-ceilings.ts
 *
 * Add --dry to preview without writing:
 *   npx ts-node scripts/backfill-deletion-ceilings.ts --dry
 *
 * WHY THE ORDER MATTERS
 * Phase 3 adds a rights check to deleteAuthUser. The deletion-rights model is
 * secure-by-default: an institute with no ceiling document holds NOTHING. So
 * if the functions deploy lands first, every institute admin on the platform
 * instantly loses the ability to remove faculty and students — with no error
 * anyone can act on except "ask the Web Owner".
 *
 * This script writes an explicit ceiling to every institute that preserves
 * exactly what institute admins can do TODAY, so enforcement arrives as a
 * no-op for them. Run it first and the deploy changes nothing for institutes.
 *
 * WHAT IT WRITES (idempotent — safe to re-run)
 * For every institute that has no `deletionRightsCeiling` yet:
 *
 *   student  → allowed, selfMode 'direct', modes []   (institute may delete)
 *   faculty  → allowed, selfMode 'direct', modes []   (institute may delete)
 *   everything else → untouched (stays off)
 *
 * `modes: []` is the important part. It means the institute may exercise the
 * right ITSELF but may not delegate it to faculty — which is precisely the
 * locked decision: existing faculty get NO deletion rights and must be
 * granted them explicitly through the new model. This script is what CLOSES
 * bug (f) rather than grandfathering it.
 *
 * Institutes that ALREADY have a ceiling (because the Web Owner configured
 * one in the Phase 2 editor) are left completely alone — a deliberate choice
 * beats a default.
 *
 * Writes nothing else. Never touches faculty documents, never grants a
 * faculty member anything.
 *
 * Uses applicationDefault() credentials like the other scripts (run from
 * Cloud Shell in the project context).
 */

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const DRY = process.argv.includes('--dry');

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

/**
 * The ceiling that preserves today's institute-admin behaviour.
 *
 * Deliberately NOT a full ceiling: assessment, questionBank and subjectTopic
 * stay off because Phase 3 only enforces the deleteAuthUser callable, which
 * covers accounts. Those resources are still governed by firestore.rules
 * today, and switching them on here would imply an enforcement that does not
 * exist yet. They become meaningful when Phase 6 routes content deletion
 * through callables.
 */
function preserveTodayCeiling() {
  return {
    student:      { allowed: true, modes: [] as string[], selfMode: 'direct' },
    faculty:      { allowed: true, modes: [] as string[], selfMode: 'direct' },
    assessment:   { allowed: false, modes: [] as string[], selfMode: 'direct' },
    questionBank: { allowed: false, modes: [] as string[], selfMode: 'direct' },
    subjectTopic: { allowed: false, modes: [] as string[], selfMode: 'direct' },
    // attempt + institute are omitted entirely: they are Web-Owner-only and
    // the server forces them off regardless of what is stored. Writing them
    // as `allowed: false` would suggest they are merely switched off rather
    // than structurally unavailable.
  };
}

async function main() {
  console.log(DRY ? '── DRY RUN (no writes) ──' : '── BACKFILL (writing) ──');

  const snap = await db.collection('institutes').get();
  console.log(`institutes found: ${snap.size}`);

  let written = 0;
  let skippedExisting = 0;

  for (const doc of snap.docs) {
    const existing = doc.get('deletionRightsCeiling');

    if (existing) {
      skippedExisting++;
      console.log(`  SKIP  ${doc.id}  (${doc.get('name') ?? 'unnamed'}) — ceiling already set`);
      continue;
    }

    const ceiling = preserveTodayCeiling();

    if (DRY) {
      console.log(`  WOULD WRITE  ${doc.id}  (${doc.get('name') ?? 'unnamed'})`);
    } else {
      await doc.ref.update({
        deletionRightsCeiling: ceiling,
        updatedAt: new Date().toISOString(),
      });
      console.log(`  WROTE  ${doc.id}  (${doc.get('name') ?? 'unnamed'})`);
    }
    written++;
  }

  console.log('');
  console.log('── SUMMARY ──');
  console.log(`  ${DRY ? 'would write' : 'written'}: ${written}`);
  console.log(`  skipped (already configured): ${skippedExisting}`);
  console.log('');
  console.log('Institute admins keep exactly what they can do today.');
  console.log('No faculty member is granted anything — bug (f) is closed, not grandfathered.');
  if (DRY) console.log('\nRe-run without --dry to apply.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('BACKFILL FAILED:', err);
    process.exit(1);
  });