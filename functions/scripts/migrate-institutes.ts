/**
 * One-time migration: import existing Institute Admin accounts.
 *
 *   - For each `institutes/{id}` doc, read matching `instituteCredentials/{id}`.
 *   - Create a Firebase Auth user with adminEmail + plaintext password.
 *   - Set custom claims { role: 'institute', instituteId }.
 *   - Write authUid back onto the institute doc; strip the password field
 *     from the credentials doc (keep firstLoginRequired flag).
 *
 *   export GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
 *   npx ts-node scripts/migrate-institutes.ts
 */

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

initializeApp({ credential: applicationDefault() });

const auth = getAuth();
const db = getFirestore();

interface Institute {
  id: string;
  adminEmail: string;
  adminName: string;
  name: string;
  authUid?: string;
  [key: string]: unknown;
}

interface InstituteCredentials {
  password?: string;
  firstLoginRequired?: boolean;
}

async function migrate() {
  const instSnap = await db.collection('institutes').get();
  console.log(`Found ${instSnap.size} institute docs.`);

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const docSnap of instSnap.docs) {
    const inst: Institute = { ...(docSnap.data() as Institute), id: docSnap.id };
    const email = (inst.adminEmail || '').toLowerCase().trim();

    if (!email) {
      console.warn(`[skip] institute ${inst.id}: missing adminEmail`);
      skipped++;
      continue;
    }

    try {
      const credSnap = await db.collection('instituteCredentials').doc(inst.id).get();
      if (!credSnap.exists) {
        console.warn(`[skip] institute ${inst.id}: no credentials doc`);
        skipped++;
        continue;
      }
      const creds = credSnap.data() as InstituteCredentials;
      if (!creds.password) {
        console.warn(`[skip] institute ${inst.id}: missing password`);
        skipped++;
        continue;
      }

      let uid: string;
      try {
        const userRecord = await auth.createUser({
          email,
          password: creds.password,
          displayName: inst.adminName,
          emailVerified: false,
        });
        uid = userRecord.uid;
        console.log(`[created] ${email} → ${uid}`);
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === 'auth/email-already-exists') {
          const existing = await auth.getUserByEmail(email);
          uid = existing.uid;
          await auth.updateUser(uid, { password: creds.password });
          console.log(`[updated] ${email} → ${uid}`);
        } else {
          throw err;
        }
      }

      await auth.setCustomUserClaims(uid, {
        role: 'institute',
        instituteId: inst.id,
      });

      await db.collection('institutes').doc(inst.id).update({
        authUid: uid,
        migratedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      // Strip plaintext password; keep firstLoginRequired so UI can still gate
      await db.collection('instituteCredentials').doc(inst.id).set(
        {
          firstLoginRequired: creds.firstLoginRequired ?? false,
          password: FieldValue.delete(),
          migratedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      created++;
    } catch (err) {
      console.error(`[fail] institute ${inst.id} (${email}):`, err);
      failed++;
    }
  }

  console.log(`\nDone. created/updated=${created}  skipped=${skipped}  failed=${failed}`);
}

migrate().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
