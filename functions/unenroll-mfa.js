/**
 * BREAK-GLASS RECOVERY — remove TOTP 2FA from the webOwner account.
 *
 * Use ONLY if you lose access to your authenticator app and are locked out.
 * Run from Google Cloud Shell (which has admin credentials for the project).
 *
 *   cd ~/Exam_forge_1.0/functions
 *   node unenroll-mfa.js
 *
 * If it errors about "quota project" / credentials, use the service-account
 * variant (same pattern as the email-update script):
 *
 *   gcloud iam service-accounts keys create sa-key.json \
 *     --iam-account=firebase-adminsdk-fbsvc@exam-forge-1-40ba7.iam.gserviceaccount.com
 *   # then uncomment the cert() line below, run, and DELETE sa-key.json after:
 *   rm sa-key.json
 *
 * After running: sign in with email + password only (no code prompt), then
 * re-enroll 2FA from the Security page with a fresh authenticator.
 */
const admin = require('firebase-admin');

admin.initializeApp({
  // credential: admin.credential.cert(require('./sa-key.json')), // ← uncomment if needed
});

const UID = 'ZCXN2ftPZLdMzAv2akTP3Omvltv1'; // webOwner UID

admin.auth().getUser(UID)
  .then(async (user) => {
    const enrolled = user.multiFactor?.enrolledFactors ?? [];
    if (enrolled.length === 0) {
      console.log('ℹ️  No 2FA factors enrolled — nothing to remove.');
      process.exit(0);
    }
    console.log(`Found ${enrolled.length} enrolled factor(s). Removing…`);
    // Setting enrolledFactors to null clears ALL second factors for the user.
    await admin.auth().updateUser(UID, { multiFactor: { enrolledFactors: null } });
    console.log('✅ 2FA removed. Sign in with email + password, then re-enroll from Security.');
    process.exit(0);
  })
  .catch((e) => { console.error('❌', e.message); process.exit(1); });
