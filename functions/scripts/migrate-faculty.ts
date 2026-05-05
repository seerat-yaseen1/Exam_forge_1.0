/**
 * One-time migration: import existing Faculty accounts.
 *
 *   - For each `faculty/{id}` doc, read matching `facultyCredentials/{id}`.
 *   - Create a Firebase Auth user with email + plaintext password.
 *   - Set custom claims { role: 'faculty', instituteId, facultyId }.
 *   - Write authUid back onto the faculty doc; strip the password field
 *     from the credentials doc (keep firstLoginRequired flag).
 */

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

initializeApp({ credential: applicationDefault() });

const auth = getAuth();
const db = getFirestore();

interface Faculty {
  id: string;
  email: string;
  name: string;
  instituteId: string;
  authUid?: string;
  [key: string]: unknown;
}

interface FacultyCredentials {
  password?: string;
  firstLoginRequired?: boolean;
}

async function migrate() {
  const facSnap = await db.collection('faculty').get();
  console.log(`Found ${facSnap.size} faculty docs.`);

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const docSnap of facSnap.docs) {
    const fac: Faculty = { ...(docSnap.data() as Faculty), id: docSnap.id };
    const email = (fac.email || '').toLowerCase().trim();

    if (!email) {
      console.warn(`[skip] faculty ${fac.id}: missing email`);
      skipped++;
      continue;
    }
    if (!fac.instituteId) {
      console.warn(`[skip] faculty ${fac.id}: missing instituteId`);
      skipped++;
      continue;
    }

    try {
      const credSnap = await db.collection('facultyCredentials').doc(fac.id).get();
      if (!credSnap.exists) {
        console.warn(`[skip] faculty ${fac.id}: no credentials doc`);
        skipped++;
        continue;
      }
      const creds = credSnap.data() as FacultyCredentials;
      if (!creds.password) {
        console.warn(`[skip] faculty ${fac.id}: missing password`);
        skipped++;
        continue;
      }

      let uid: string;
      try {
        const userRecord = await auth.createUser({
          email,
          password: creds.password,
          displayName: fac.name,
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
        role: 'faculty',
        instituteId: fac.instituteId,
        facultyId: fac.id,
      });

      await db.collection('faculty').doc(fac.id).update({
        authUid: uid,
        migratedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      await db.collection('facultyCredentials').doc(fac.id).set(
        {
          firstLoginRequired: creds.firstLoginRequired ?? false,
          password: FieldValue.delete(),
          migratedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      created++;
    } catch (err) {
      console.error(`[fail] faculty ${fac.id} (${email}):`, err);
      failed++;
    }
  }

  console.log(`\nDone. created/updated=${created}  skipped=${skipped}  failed=${failed}`);
}

migrate().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
