/**
 * Recovery: put the `role: 'webOwner'` custom claim back on an account.
 *
 * WHEN YOU NEED THIS
 * A Web Owner signs in, the password is accepted, the authenticator code is
 * accepted — and the login page comes straight back. No error is shown.
 *
 * That is what a missing role claim looks like. Custom claims are set at
 * account creation (createUserWithRole) or by migrate-webowners.ts, and NEVER
 * on sign-in, so an account that lost the claim — or never received it,
 * because it predates the Firebase Auth migration — can authenticate perfectly
 * and still fail every rule gated on isWebOwner(). AuthContext.loadProfile
 * reads webowners/{uid}, gets nothing, returns null, and the route guard sends
 * the user back to the login page. Hence the loop.
 *
 * CONFIRM BEFORE RUNNING. Open the browser console during the loop:
 *   • "Missing or insufficient permissions"  → the claim is missing. Run this.
 *   • no error at all                        → the claim is fine and the
 *     webowners/{uid} document is missing instead. This script reports that
 *     case explicitly rather than pretending to fix it.
 *
 * USAGE
 *   export GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
 *   cd functions
 *   npx ts-node scripts/grant-webowner-claim.ts owner@example.com
 *
 * Add --write to actually change anything. Without it this is a DRY RUN and
 * only reports what it would do — a script that hands out platform-owner
 * rights should not do so as a side effect of being run to look at something.
 *
 * AFTER RUNNING the user must sign out and back in: custom claims are baked
 * into the ID token, and the existing token will not carry the new claim until
 * it is reissued.
 */

import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const email = process.argv[2]?.toLowerCase().trim();
const doWrite = process.argv.includes('--write');

if (!email) {
  console.error('\n  Usage: npx ts-node scripts/grant-webowner-claim.ts <email> [--write]\n');
  process.exit(1);
}

initializeApp({ credential: applicationDefault() });

async function main() {
  const auth = getAuth();
  const db = getFirestore();

  let user;
  try {
    user = await auth.getUserByEmail(email);
  } catch {
    console.error(`\n  No Firebase Auth user with email ${email}.`);
    console.error('  Check the address, and the project the service account belongs to.\n');
    process.exit(1);
  }

  const claims = user.customClaims ?? {};
  console.log(`\n  uid          ${user.uid}`);
  console.log(`  email        ${user.email}`);
  console.log(`  claims now   ${JSON.stringify(claims)}`);

  // Refuse to convert another role's account. Overwriting a faculty or student
  // claim would not fix a lockout — it would hand platform-owner rights to a
  // tenant account and strip the ids their own gates depend on.
  const existingRole = claims.role as string | undefined;
  if (existingRole && existingRole !== 'webOwner') {
    console.error(`\n  REFUSING: this account is role='${existingRole}', not a Web Owner.`);
    console.error('  Granting webOwner here would escalate a tenant account, not repair one.\n');
    process.exit(1);
  }

  // The profile document is the other half of a working login. Report it
  // either way: if it is missing, the claim was never the problem and this
  // script will not fix the loop.
  const byUid = await db.collection('webowners').doc(user.uid).get();
  const byEmail = user.email
    ? await db.collection('webowners').doc(user.email.toLowerCase()).get()
    : null;

  console.log(`  webowners/{uid}    ${byUid.exists ? 'present' : 'MISSING'}`);
  console.log(`  webowners/{email}  ${byEmail?.exists ? 'present' : 'missing (fine if uid doc is present)'}`);

  if (!byUid.exists && !byEmail?.exists) {
    console.error('\n  The profile document does not exist under either key.');
    console.error('  The claim is not what is breaking this login — AuthContext.loadProfile');
    console.error('  returns null for a missing document just as it does for a denied read.');
    console.error('  Create webowners/' + user.uid + ' with { email, name } and try again.\n');
    process.exit(1);
  }

  if (existingRole === 'webOwner') {
    console.log('\n  The role claim is ALREADY set correctly — nothing to grant.');
    console.log('  If the loop persists, the token is stale: sign out fully and back in.');
    console.log('  Failing that, the cause is elsewhere; check the browser console.\n');
    return;
  }

  if (!doWrite) {
    console.log('\n  DRY RUN — would set { role: "webOwner" } on this account.');
    console.log('  Re-run with --write to apply.\n');
    return;
  }

  // Merge rather than replace: other claims on the account are not ours to drop.
  await auth.setCustomUserClaims(user.uid, { ...claims, role: 'webOwner' });
  const after = (await auth.getUser(user.uid)).customClaims;
  console.log(`\n  claims now   ${JSON.stringify(after)}`);
  console.log('\n  Done. Sign out and back in — the claim only reaches the app in a');
  console.log('  newly issued ID token, so the current session will not see it.\n');
}

main().catch((err) => {
  console.error('\n  Failed:', err);
  process.exit(1);
});
