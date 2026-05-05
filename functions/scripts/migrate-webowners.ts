/**
 * One-time migration: import existing Web Owner accounts from Firestore
 * (`webOwners` collection, plaintext password field) into Firebase Auth.
 *
 *   - Creates a Firebase Auth user per webOwner doc (password is hashed by
 *     Firebase on `createUser`, never stored plaintext again).
 *   - Sets custom claim `{ role: 'webOwner' }` on the new auth user.
 *   - Re-keys the Firestore profile doc by uid (copies the old email-keyed doc
 *     to a new uid-keyed doc, drops the `password` field, leaves the old doc
 *     in place so you can verify before deleting it manually).
 *
 * Run locally with a service account:
 *   export GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
 *   npx ts-node scripts/migrate-webowners.ts
 */

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

initializeApp({ credential: applicationDefault() });

const auth = getAuth();
const db = getFirestore();

interface LegacyWebOwner {
  email: string;
  name: string;
  password?: string;
  resetCode?: string;
  resetExpiry?: string;
  [key: string]: unknown;
}

async function migrate() {
  const snap = await db.collection('webowners').get();
  console.log(`Found ${snap.size} webOwner docs.`);

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const docSnap of snap.docs) {
    const data = docSnap.data() as LegacyWebOwner;
    const email = (data.email || '').toLowerCase().trim();

    if (!email || !data.password) {
      console.warn(`[skip] ${docSnap.id}: missing email or password`);
      skipped++;
      continue;
    }

    try {
      let uid: string;
      try {
        const userRecord = await auth.createUser({
          email,
          password: data.password,
          displayName: data.name,
          emailVerified: false,
        });
        uid = userRecord.uid;
        console.log(`[created] ${email} → ${uid}`);
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === 'auth/email-already-exists') {
          const existing = await auth.getUserByEmail(email);
          uid = existing.uid;
          await auth.updateUser(uid, { password: data.password });
          console.log(`[updated] ${email} → ${uid}`);
        } else {
          throw err;
        }
      }

      await auth.setCustomUserClaims(uid, { role: 'webOwner' });

      // password / resetCode / resetExpiry are stripped from the new doc
      const { password: _p, resetCode: _rc, resetExpiry: _re, ...profile } = data;
      await db.collection('webowners').doc(uid).set(
        {
          ...profile,
          email,
          uid,
          migratedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      created++;
    } catch (err) {
      console.error(`[fail] ${email}:`, err);
      failed++;
    }
  }

  console.log(`\nDone. created/updated=${created}  skipped=${skipped}  failed=${failed}`);
  console.log(
    'After verifying the new uid-keyed docs, you can manually delete the old email-keyed docs.'
  );
}

migrate().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
