/**
 * One-time migration: import existing Student accounts.
 *
 *   - For each `students/{id}` doc, read matching `studentCredentials/{id}`.
 *   - Create a Firebase Auth user with email + plaintext password.
 *   - Set custom claims { role: 'student', instituteId, studentId }.
 *   - Write authUid back; strip plaintext password.
 *
 * Note: Firebase Auth caps createUser at ~10/sec. For large rosters this
 * script will pace itself naturally — just be patient. If you have >10k
 * students consider running in batches by institute.
 */

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

initializeApp({ credential: applicationDefault() });

const auth = getAuth();
const db = getFirestore();

interface Student {
  id: string;
  email: string;
  name: string;
  instituteId: string;
  authUid?: string;
  [key: string]: unknown;
}

interface StudentCredentials {
  password?: string;
  firstLoginRequired?: boolean;
}

async function migrate() {
  const stuSnap = await db.collection('students').get();
  console.log(`Found ${stuSnap.size} student docs.`);

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const docSnap of stuSnap.docs) {
    const stu: Student = { ...(docSnap.data() as Student), id: docSnap.id };
    const email = (stu.email || '').toLowerCase().trim();

    if (!email) {
      console.warn(`[skip] student ${stu.id}: missing email`);
      skipped++;
      continue;
    }
    if (!stu.instituteId) {
      console.warn(`[skip] student ${stu.id}: missing instituteId`);
      skipped++;
      continue;
    }

    try {
      const credSnap = await db.collection('studentCredentials').doc(stu.id).get();
      if (!credSnap.exists) {
        console.warn(`[skip] student ${stu.id}: no credentials doc`);
        skipped++;
        continue;
      }
      const creds = credSnap.data() as StudentCredentials;
      if (!creds.password) {
        console.warn(`[skip] student ${stu.id}: missing password`);
        skipped++;
        continue;
      }

      let uid: string;
      try {
        const userRecord = await auth.createUser({
          email,
          password: creds.password,
          displayName: stu.name,
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
        role: 'student',
        instituteId: stu.instituteId,
        studentId: stu.id,
      });

      await db.collection('students').doc(stu.id).update({
        authUid: uid,
        migratedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      await db.collection('studentCredentials').doc(stu.id).set(
        {
          firstLoginRequired: creds.firstLoginRequired ?? false,
          password: FieldValue.delete(),
          migratedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      created++;
    } catch (err) {
      console.error(`[fail] student ${stu.id} (${email}):`, err);
      failed++;
    }
  }

  console.log(`\nDone. created/updated=${created}  skipped=${skipped}  failed=${failed}`);
}

migrate().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
