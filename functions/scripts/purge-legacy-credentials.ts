/**
 * One-time cleanup: remove legacy plaintext `password` fields from the
 * credential collections.
 *
 *   cd functions && npx ts-node scripts/purge-legacy-credentials.ts --dry
 *   cd functions && npx ts-node scripts/purge-legacy-credentials.ts
 *
 * Optional, see §3:
 *   npx ts-node scripts/purge-legacy-credentials.ts --force-reset
 *
 * ─────────────────────────────────────────────────────────────────────
 * 1. WHAT THIS IS
 *
 * Accounts provisioned before the plaintext-password fix have credential
 * documents shaped like:
 *
 *   { studentId, email, password: '<plaintext>', firstLoginRequired }
 *
 * `createAuthUser` no longer writes these — it strips the password and writes
 * only the profile doc, with the real credential living in Firebase Auth. But
 * a code fix does not clean up documents that already exist, so the old ones
 * are still sitting there with real, working-or-formerly-working passwords in
 * them.
 *
 * ─────────────────────────────────────────────────────────────────────
 * 2. WHY IT STRIPS THE FIELD RATHER THAN DELETING THE DOCUMENT
 *
 * These documents are STILL IN USE. All four auth contexts read them at login
 * to decide `firstLoginRequired`, and the fallback when the document is
 * missing is `false`:
 *
 *   const firstLoginRequired = credSnap.exists()
 *     ? Boolean(credSnap.data().firstLoginRequired)
 *     : false;
 *
 * So deleting the documents would silently stop forcing password changes —
 * on precisely the accounts whose passwords were exposed, since those are the
 * ones still carrying `firstLoginRequired: true`. The secret goes; the
 * document and its flag stay.
 *
 * ─────────────────────────────────────────────────────────────────────
 * 3. --force-reset (OPT-IN, THINK BEFORE USING)
 *
 * A password that sat readable in a database should be treated as compromised
 * even if nobody read it. `--force-reset` sets `firstLoginRequired: true` on
 * every account whose password field it strips, so each of them must choose a
 * new password at next sign-in.
 *
 * It is off by default because it is user-visible: everyone affected gets an
 * unexpected password-change prompt, with no explanation unless you send one.
 * For a small user base that is a reasonable afternoon; for a large one, plan
 * the message first.
 *
 * Idempotent either way — safe to re-run, and a second run finds nothing.
 */

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const DRY = process.argv.includes('--dry');
const FORCE_RESET = process.argv.includes('--force-reset');

initializeApp({ credential: applicationDefault() });
const db = getFirestore();

const COLLECTIONS = [
  'studentCredentials',
  'facultyCredentials',
  'instituteCredentials',
] as const;

async function cleanCollection(name: string) {
  let scanned = 0;
  let stripped = 0;
  let alreadyClean = 0;

  let snap;
  try {
    snap = await db.collection(name).get();
  } catch (err) {
    console.error(`  ERROR reading ${name}:`, err);
    return { scanned: 0, stripped: 0, alreadyClean: 0, failed: true };
  }

  console.log(`\n── ${name} — ${snap.size} document${snap.size === 1 ? '' : 's'} ──`);

  let batch = db.batch();
  let pending = 0;

  for (const doc of snap.docs) {
    scanned++;
    const data = doc.data() as Record<string, unknown>;

    // Only touch documents that actually carry a secret. An empty-string
    // password counts: it is still a field that should not exist.
    if (!('password' in data)) {
      alreadyClean++;
      continue;
    }

    const patch: Record<string, unknown> = {
      password: FieldValue.delete(),
    };
    if (FORCE_RESET) patch.firstLoginRequired = true;

    if (DRY) {
      console.log(`  WOULD STRIP  ${doc.id}`
        + (FORCE_RESET ? '  + force password change' : ''));
    } else {
      batch.update(doc.ref, patch);
      pending++;
      if (pending >= 400) {
        await batch.commit();
        batch = db.batch();
        pending = 0;
      }
      console.log(`  STRIPPED  ${doc.id}`
        + (FORCE_RESET ? '  + force password change' : ''));
    }
    stripped++;
  }

  if (!DRY && pending > 0) await batch.commit();

  return { scanned, stripped, alreadyClean, failed: false };
}

async function main() {
  console.log(DRY ? '── DRY RUN (no writes) ──' : '── CLEANUP (writing) ──');
  if (FORCE_RESET) {
    console.log('── --force-reset: affected accounts will be required to');
    console.log('   choose a new password at next sign-in ──');
  }

  let totalScanned = 0;
  let totalStripped = 0;
  let totalClean = 0;
  let anyFailed = false;

  for (const name of COLLECTIONS) {
    const r = await cleanCollection(name);
    totalScanned += r.scanned;
    totalStripped += r.stripped;
    totalClean += r.alreadyClean;
    if (r.failed) anyFailed = true;
  }

  console.log('\n── SUMMARY ──');
  console.log(`  documents scanned:            ${totalScanned}`);
  console.log(`  ${DRY ? 'would strip' : 'passwords removed'}:${DRY ? '            ' : '      '}${totalStripped}`);
  console.log(`  already clean:                ${totalClean}`);
  if (anyFailed) console.log('  ⚠ one or more collections could not be read — see errors above');

  if (DRY) {
    console.log('\nRe-run without --dry to apply.');
  } else if (totalStripped > 0) {
    console.log('\nDone. The documents remain (login reads firstLoginRequired');
    console.log('from them); only the plaintext password field is gone.');
    if (!FORCE_RESET) {
      console.log('\nThose passwords were readable, so consider them compromised.');
      console.log('Re-run with --force-reset to require a password change at');
      console.log('next sign-in, or reset the affected accounts manually.');
    }
  } else {
    console.log('\nNothing to clean — no plaintext passwords found.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('CLEANUP FAILED:', err);
    process.exit(1);
  });