/**
 * STRATUM Cloud Functions
 *
 * createAuthUser — admin-only callable that provisions a Firebase Auth user
 * and writes the matching profile document into the role's Firestore
 * collection.
 *
 * Caller authorisation:
 *   • Web Owner   → can create any role.
 *   • Institute   → can create faculty or student in own institute only.
 *   • Faculty     → can create student in own institute only.
 *   • Student     → cannot call this endpoint.
 *
 * Custom claims set on the new user:
 *   webOwner  → { role }
 *   institute → { role, instituteId: uid }
 *   faculty   → { role, instituteId, facultyId: uid }
 *   student   → { role, instituteId, studentId: uid }
 *
 * The doc id of the new profile document equals the Firebase Auth uid.
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { defineSecret, defineString } from 'firebase-functions/params';

// ── Timing core (master plan Phase 3a/3b) ─────────────────────────
// The single implementation of every deadline in this module. Phase 3b points
// computeAttemptLocks at it so the number the write gate enforces and the
// number the resolver reasons about cannot drift — every timing defect in this
// module has been two expressions of the same rule disagreeing.
import {
  sectionDeadlineMs,
  overallDeadlineMs,
  creditForAnchor,
  penaltyForClock,
  computeFreezeCredits,
  computeDeadlines,
  // D-14's "one number, consumed by BOTH sides". index.ts previously declared
  // its own section/overall defaults and hardcoded the question one as a bare
  // `5` in two places (F13) — so a per-assessment questionGraceSeconds was
  // honoured by the resolver and ignored by the two functions that flag a late
  // answer. Imported, not redeclared.
  DEFAULT_QUESTION_GRACE_SECONDS,
  effectiveNowMs,
  openFreezeStartedMs,
  openSectionId,
  // A-07: the window bound is parsed with the SAME reader every other timestamp
  // in the module uses, so an unreadable endDate yields null ("unbounded")
  // rather than epoch 0 ("expired in 1970").
  toMs as toTimingMs,
  type CorePenalty,
  resolve as resolveTiming,
  checkInvariants as checkTimingInvariants,
  type CoreAssessment,
  type CoreAttempt,
} from './examTimingCore';

// Phase 3 — shared with Vercel's /api/seb-verify. Declared at module top so
// every callable that lists it in `secrets` can reference it (const, not hoisted).
const SEB_SIGNING_SECRET = defineSecret('SEB_SIGNING_SECRET');

// ── Judge0 (self-hosted) ──────────────────────────────────────────
// The cluster's private address, and the token every request carries. Both
// empty by default, which resolves to NullJudgeAdapter — see getJudgeAdapter.
// Deployment: infra/judge0/README.md.
const JUDGE0_BASE_URL = defineString('JUDGE0_BASE_URL', { default: '' });
const JUDGE0_AUTH_TOKEN = defineSecret('JUDGE0_AUTH_TOKEN');

// ── Coding sweep capacity (audit R-1) ─────────────────────────────
//
// Three numbers that must be reasoned about TOGETHER, which is why they are
// declared together rather than inline at the sweep.
//
//   CONCURRENCY  how many papers are in flight at once. Default 4, matching
//                the cluster's `replicas: 4` in infra/judge0/docker-compose.yml
//                — described there as "the real concurrency ceiling of the
//                whole platform". Past it, requests only queue inside Judge0
//                and the sweep loses its ability to stop cleanly at the
//                deadline. RAISE THIS WITH THE REPLICA COUNT, not on its own.
//
//   BUDGET       wall-clock seconds after which the sweep stops STARTING new
//                papers. TWO ceilings bound it, and the tighter one is not the
//                obvious one:
//                  · timeoutSeconds (540) — work in flight must finish and
//                    commit; a run killed by the platform loses what it held.
//                  · THE SCHEDULE INTERVAL (300) — Cloud Scheduler does not
//                    wait for the previous run. A budget above the interval
//                    means two sweeps overlap, both see the same
//                    codeJudgePending papers, and a paper gets judged twice —
//                    spending two of its five attempts for one result.
//                240 leaves a minute of margin for the last papers in flight
//                to land before the next run starts. RAISE THE SCHEDULE FIRST
//                if this ever needs to grow.
//
//   MAX_PAPERS   the query cap. With a time budget this is a memory bound and
//                a backlog probe rather than a throughput limit, which is why
//                it can be far larger than the old 50 without risking a
//                run that overshoots.
//
// Read from process.env so they can be re-sized in functions/.env.<project>
// alongside a cluster change, without a code deploy.
function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}
const JUDGE_SWEEP_CONCURRENCY = envInt('JUDGE_SWEEP_CONCURRENCY', 4);
const JUDGE_SWEEP_BUDGET_SECONDS = envInt('JUDGE_SWEEP_BUDGET_SECONDS', 240);
const JUDGE_SWEEP_MAX_PAPERS = envInt('JUDGE_SWEEP_MAX_PAPERS', 400);

// ══════════════════════════════════════════════════════════════════
// APP CHECK — the attestation the client already pays for
// ══════════════════════════════════════════════════════════════════
//
// The web app initialises App Check with a reCAPTCHA v3 provider
// (src/lib/firebase.ts), so every callable request from a real browser already
// carries an App Check token and every user already pays the reCAPTCHA
// round-trip. Nothing consumed it: `enforceAppCheck` defaults to FALSE in
// firebase-functions v2, so a request arriving with NO token — curl, a script,
// a replayed ID token from outside the app — was served exactly like one from
// the app. The attestation was bought and not spent.
//
// WHY A FLAG AND NOT JUST `true`.
// Turning enforcement on is a one-way door for any client that cannot produce a
// token, and the population that cannot is not knowable from this repository:
// it depends on whether the reCAPTCHA site key is registered for every domain
// the app is served from, whether debug tokens are allowlisted for the
// environments QA uses, and whether App Check is already reporting full
// coverage in the console. Getting that wrong locks students out of live
// exams. The flag makes the flip a CONFIG change, reversible in a redeploy,
// rather than a code change that has to go through review while a cohort waits.
//
// HOW TO ROLL IT OUT (each step is verifiable before the next):
//   1. Firebase console → App Check → register the reCAPTCHA v3 provider for
//      every domain, and set Cloud Functions to MONITOR (not enforce).
//   2. Watch the "verified vs unverified" split for a full exam cycle. It must
//      reach ~100% verified. Anything less is a client that will be locked out.
//   3. Set APP_CHECK_ENFORCED=true in functions/.env.<project> and deploy.
//      The startup log line below states the resolved value, so the deploy can
//      be confirmed from `firebase functions:log` rather than assumed.
//   4. Roll back by setting it to false and redeploying — no code change.
//
// SCOPE: applied to EXAM_HOT_PATH, which is the ten functions a candidate's
// browser calls during a sitting and therefore the ones worth attesting. The
// staff-driven callables are deliberately not covered yet; add
// `enforceAppCheck: APP_CHECK_ENFORCED` to their options once step 2 has been
// observed for staff surfaces too, which is a different population of clients
// and deserves its own soak.
const APP_CHECK_ENFORCED = process.env.APP_CHECK_ENFORCED === 'true';

// Stated at cold start, not left to be inferred. Every other silent-degradation
// trap in this codebase (the null judge adapter, the missing SEB secret) earned
// its log line the hard way; a security control that is off is exactly as
// worth saying out loud as a judge that is not marking.
console.log(
  `[appcheck] enforced=${APP_CHECK_ENFORCED}`
  + (APP_CHECK_ENFORCED ? '' : ' — set APP_CHECK_ENFORCED=true in functions/.env.<project> to enforce'),
);

/**
 * Capacity settings for the SIX functions a whole cohort hits at once
 * (audit P-01 / 10k scale target).
 *
 * Nothing in this file previously set maxInstances, minInstances or
 * concurrency, so every function ran on pure Gen2 defaults: 100 instances x 80
 * concurrent requests. Capacity is measured in requests IN FLIGHT, not
 * requests served — in-flight is arrival rate x handler duration — so the
 * default 8,000 is ample for a 10,000-student opening spread over a minute,
 * and still fine for one compressed into a second at normal ~300ms handlers.
 *
 * The failure mode is not steady-state throughput, it's the cold-start
 * thundering herd: minInstances defaults to 0, so the first burst of an exam
 * window meets zero warm instances, every request pays a multi-second cold
 * start, slow handlers inflate the in-flight count, and THAT is what walks
 * into the ceiling. It is self-reinforcing — the burst causes cold starts,
 * cold starts slow handlers, slow handlers trigger more instances.
 *
 * maxInstances 200 is the CEILING THIS PROJECT ALLOWS, not a free choice.
 * Cloud Run validates maxScale x CPU against the CpuAllocPerProjectRegion
 * quota, which is 200 CPU in us-central1 here; at 1 CPU per instance that caps
 * maxScale at 200. A first attempt at 400 was rejected outright with
 * "Max instances must be set to 200 or fewer to set the requested total CPU"
 * — the deploy fails, it does not silently clamp. Raising this requires a
 * quota increase request in the Cloud Console first.
 *
 * 200 is still double the Gen2 default and gives 16,000 in-flight capacity,
 * comfortably past the 10,000-student target — remember in-flight is arrival
 * rate x handler duration, so 10,000 starts over even ten seconds at ~300ms
 * handlers is only ~300 in flight. The headroom is for the cold-start
 * pathological case, not the steady state. It costs nothing when unused: this
 * is a ceiling, not a reservation.
 *
 * minInstances is deliberately left at the default 0 here, because warm
 * instances bill continuously whether or not an exam is running. Set it to 2-3
 * on startExam and getExamQuestions before a large scheduled sitting to remove
 * the cold-start cliff, and back to 0 afterwards. Applied ONLY to these six —
 * the other 34 are staff-driven and will never see a cohort-sized burst.
 */
/**
 * Every callable that is NOT on the exam hot path.
 *
 * Carries the same App Check flag (audit F-3). The original change scoped
 * enforcement to the ten hot-path functions and said the staff callables were
 * "a different client population and deserve their own soak" — that was the
 * right caution with no data, and the data now exists: the project's App Check
 * console reports Cloud Firestore at 100% verified / 0% unverified, and staff
 * surfaces read and write Firestore constantly. The population is the same
 * registered web app, so splitting the rollout would only mean flipping two
 * switches instead of one.
 *
 * Still governed by the single APP_CHECK_ENFORCED variable, so this widens
 * WHAT the flag covers without changing whether it is on.
 */
const CALLABLE_BASE = {
  region: 'us-central1' as const,
  enforceAppCheck: APP_CHECK_ENFORCED,
};

const EXAM_HOT_PATH = {
  region: 'us-central1',
  secrets: [SEB_SIGNING_SECRET],
  maxInstances: 200,
  concurrency: 80,
  // See the APP_CHECK block above. Off by default, so this changes nothing
  // until the console reports full attestation coverage and the env var is set.
  enforceAppCheck: APP_CHECK_ENFORCED,
};

/**
 * Reaching the judge.
 *
 * The Judge0 cluster has no public address by design — it binds the host's
 * INTERNAL address (10.128.0.2:2358) on a VM with no external IP — so the only
 * route to it is a Serverless VPC connector into the project's network.
 *
 * Not loopback, and that distinction cost a debugging cycle: a connector does
 * not arrive on 127.0.0.1. It arrives from its own range on the host's internal
 * interface, so a loopback publish refuses the connection while the connector,
 * the firewall, the secret and the base URL all look correct. See the comment
 * on the `ports:` entry in infra/judge0/docker-compose.yml, which carries the
 * curl that tells the two apart.
 *
 * Egress is PRIVATE_RANGES_ONLY deliberately. ALL_TRAFFIC would push Firestore
 * and every other Google API call through the connector as well, costing
 * latency and throughput for no benefit: only the 10.x address of the judge
 * needs it.
 *
 * The connector is shared rather than judge-specific, which is why it is named
 * exam-forge-connector. Connectors bill continuously per instance, so one is
 * reused instead of one created per consumer.
 *
 * Named here rather than written inline so the connector appears exactly once.
 * BOTH judge functions must carry it. Either one missing it fails as
 * judge_unavailable against a perfectly healthy cluster, which reads like an
 * outage rather than the config gap it is.
 */
const JUDGE_ACCESS = {
  vpcConnector: 'exam-forge-connector',
  vpcConnectorEgressSettings: 'PRIVATE_RANGES_ONLY' as const,
};
import { initializeApp } from 'firebase-admin/app';
import {
  ANCESTOR_FIELD,
  AUDIT_DELTA_ID_CAP,
  COLLECTION_OF,
  chunk,
  resolveCore,
  typesBelow,
  type AllocNodeType,
  type CoreDescendant,
  type CoreInput,
  type CoreMapping,
  type CoreSelectedNode,
  type SubNodeType,
} from './allocationCore';
import {
  JudgeAdapter,
  JudgeAttemptState,
  JudgeLimits,
  JudgeSubmission,
  JudgeTest,
  JudgeVerdict,
  MAX_JUDGE_ATTEMPTS,
  NullJudgeAdapter,
  advanceState as advanceJudgeState,
  clampLimits,
  isExhausted as judgeExhausted,
  isJudgeLanguage,
  outcomeFor as codeOutcomeFor,
  SampleRunConfig,
  SampleRunState,
  advanceRunState,
  checkSampleRun,
  redactForCandidate,
  resolveSampleRunConfig,
  sampleRunSubmission,
  shouldJudgeNow,
} from './judgeCore';
import { Judge0Adapter } from './judge0Adapter';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

initializeApp();

type Role = 'webOwner' | 'institute' | 'faculty' | 'student';

const COLLECTION_BY_ROLE: Record<Role, string> = {
  webOwner: 'webowners',
  institute: 'institutes',
  faculty: 'faculty',
  student: 'students',
};

interface CreateAuthUserData {
  role: Role;
  password: string;
  profile: Record<string, unknown> & { email: string; name: string };
  // Required when role === 'faculty' | 'student'.
  // For role === 'institute' the new institute's id IS the uid; ignored.
  // For role === 'webOwner'  ignored.
  instituteId?: string;
}

function authorizeCaller(
  callerRole: Role | undefined,
  callerInstituteId: string | undefined,
  targetRole: Role,
  targetInstituteId: string | undefined
): void {
  if (callerRole === 'webOwner') return;

  if (callerRole === 'institute') {
    if (targetRole !== 'faculty' && targetRole !== 'student') {
      throw new HttpsError('permission-denied', 'Institute admins may only create faculty or students.');
    }
    if (!callerInstituteId || callerInstituteId !== targetInstituteId) {
      throw new HttpsError('permission-denied', 'instituteId must match caller.');
    }
    return;
  }

  if (callerRole === 'faculty') {
    if (targetRole !== 'student') {
      throw new HttpsError('permission-denied', 'Faculty may only create students.');
    }
    if (!callerInstituteId || callerInstituteId !== targetInstituteId) {
      throw new HttpsError('permission-denied', 'instituteId must match caller.');
    }
    return;
  }

  throw new HttpsError('permission-denied', 'Insufficient permissions.');
}

export const createAuthUser = onCall<CreateAuthUserData>(
  CALLABLE_BASE,
  async (request) => {
    // ── 1. AuthN
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign-in required.');
    }
    const callerRole         = request.auth.token.role         as Role   | undefined;
    const callerInstituteId  = request.auth.token.instituteId  as string | undefined;

    // ── 2. Validate input
    const { role, password, profile, instituteId: providedInstituteId } =
      request.data || ({} as CreateAuthUserData);

    if (!role || !COLLECTION_BY_ROLE[role]) {
      throw new HttpsError('invalid-argument', 'Invalid role.');
    }
    if (typeof password !== 'string' || password.length < 8) {
      throw new HttpsError('invalid-argument', 'Password must be at least 8 characters.');
    }
    if (!profile?.email || !profile?.name) {
      throw new HttpsError('invalid-argument', 'Profile must include email and name.');
    }
    // ext #16 (server half, identity paths): the bulk student/faculty upload
    // modals validate rows client-side only — anything reaching this endpoint
    // is re-validated here so a crafted call can't create malformed accounts.
    // (Question bulk-upload validation is a separate rules-side design.)
    {
      const emailStr = String(profile.email).trim();
      const nameStr  = String(profile.name).trim();
      if (emailStr.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailStr)) {
        throw new HttpsError('invalid-argument', 'Invalid email address.');
      }
      if (nameStr.length < 1 || nameStr.length > 120) {
        throw new HttpsError('invalid-argument', 'Name must be between 1 and 120 characters.');
      }
      if (password.length > 128) {
        throw new HttpsError('invalid-argument', 'Password must be at most 128 characters.');
      }
    }

    // For faculty / student, instituteId must be supplied explicitly.
    if ((role === 'faculty' || role === 'student') && !providedInstituteId) {
      throw new HttpsError('invalid-argument', 'instituteId is required for faculty / student creation.');
    }

    // ── 3. AuthZ
    const targetInstituteId =
      role === 'institute'
        ? undefined // resolved to uid after creation
        : role === 'webOwner'
          ? undefined
          : providedInstituteId;

    authorizeCaller(callerRole, callerInstituteId, role, targetInstituteId);

    // ── 3b. Faculty per-member gate (Audit 2026-07-17, N4) ────────
    // canCreateStudents was previously enforced only in the UI, which made
    // the institute admin's toggle decorative — any faculty account could
    // call this endpoint directly. The flag on the caller's own faculty doc
    // is now the server-side source of truth. Institute admins and the Web
    // Owner are not gated by it.
    if (callerRole === 'faculty') {
      const callerFacultyId = request.auth.token.facultyId as string | undefined;
      const facultySnap = callerFacultyId
        ? await getFirestore().collection('faculty').doc(callerFacultyId).get()
        : null;
      if (!facultySnap?.exists || facultySnap.get('canCreateStudents') !== true) {
        throw new HttpsError(
          'permission-denied',
          'Student creation is not enabled for your account. Ask your institute admin to enable it.',
        );
      }
    }

    const email = String(profile.email).toLowerCase().trim();

    // ── 4. Create Firebase Auth user
    const auth = getAuth();
    let uid: string;
    // The drawers offer an "Initial status" of active or disabled, and that
    // choice has to reach Firebase Auth or it is decorative — a student
    // created as disabled used to get a fully working Auth account, because
    // `status` is a Firestore field and nothing read it when minting the user.
    // Same rule as setAccountStatus below: the profile field and the Auth
    // account say the same thing, always.
    const createDisabled = String(profile.status ?? 'active') === 'disabled';
    try {
      const userRecord = await auth.createUser({
        email,
        password,
        displayName: String(profile.name),
        emailVerified: false,
        disabled: createDisabled,
      });
      uid = userRecord.uid;
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'auth/email-already-exists') {
        throw new HttpsError('already-exists', 'An account with this email already exists.');
      }
      throw new HttpsError('internal', 'Failed to create auth user.', code);
    }

    // ── 5. Set custom claims
    const claims: Record<string, unknown> = { role };
    if (role === 'institute') {
      claims.instituteId = uid;
    } else if (role === 'faculty') {
      claims.instituteId = providedInstituteId;
      claims.facultyId   = uid;
    } else if (role === 'student') {
      claims.instituteId = providedInstituteId;
      claims.studentId   = uid;
    }
    await auth.setCustomUserClaims(uid, claims);

    // ── 6. Write profile doc (never store plaintext password)
    const db = getFirestore();
    const collection = COLLECTION_BY_ROLE[role];
    const { password: _ignored, ...profileSansPassword } = profile as Record<string, unknown>;

    const docData: Record<string, unknown> = {
      ...profileSansPassword,
      email,
      uid,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Stamp the canonical id field expected by the rest of the app.
    if (role === 'institute') {
      docData.id = uid;
    } else if (role === 'faculty' || role === 'student') {
      docData.id          = uid;
      docData.instituteId = providedInstituteId;
    }

    await db.collection(collection).doc(uid).set(docData);

    return { ok: true, uid };
  }
);

interface DeleteAuthUserData {
  role: Role;
  uid: string;
  /**
   * Faculty only (Feature #15, Phase 5a). Another active faculty member in the
   * same institute to inherit this person's questions, banks and assessments.
   * Omitted ⇒ the institute admin inherits, which is the safe default and the
   * only target guaranteed to exist.
   */
  successorId?: string;
  /** Set once the admin has acknowledged live-exam ownership. */
  confirmLiveOwnership?: boolean;
  /**
   * Institute only (Feature #15, Phase 5b). WebOwner-owned assessments whose
   * attempts by this institute's students should ALSO be deleted. Absent ⇒
   * none, which is the safe default: a cascade that destroys the Web Owner's
   * own exam history by omission is the worst failure mode available here.
   */
  deleteAttemptsOnWebOwnerAssessments?: string[];
}

const CREDENTIALS_BY_ROLE: Partial<Record<Role, string>> = {
  institute: 'instituteCredentials',
  faculty: 'facultyCredentials',
  student: 'studentCredentials',
};

// ── Deletion rights enforcement (Feature #15, Phase 3) ────────────
// Server twin of src/lib/deletionRights.ts. THIS IS THE GATE — the client
// mirrors this logic to shape its UI, but this copy is what decides.
// KEEP IN SYNC with the client module.
//
// Closes bug (f): until now deleteAuthUser had ROLE gating (institute may
// delete faculty/students, faculty may delete students, tenant-matched) but
// no RIGHTS check at all. Any faculty member could delete any student in
// their institute, ungoverned — the widest blast radius on the platform with
// the least oversight.

type DeletionModeS = 'direct' | 'request';
type DeletableResourceS =
  | 'institute' | 'faculty' | 'student' | 'assessment' | 'questionBank' | 'subjectTopic' | 'attempt';

type DeletionCeilingRightS = { allowed?: boolean; modes?: DeletionModeS[]; selfMode?: DeletionModeS };
type DeletionCeilingS = Partial<Record<DeletableResourceS, DeletionCeilingRightS>>;
type FacultyDeletionRightsS = Partial<Record<DeletableResourceS, { granted?: boolean; mode?: DeletionModeS }>>;

/**
 * Resources no institute may ever hold, whatever a stored ceiling says.
 * Twin of WEBOWNER_ONLY_RESOURCES in the client module.
 *
 *   attempt   — attempts are the audit trail; a tenant that can delete them
 *               can delete the evidence of what happened in an exam.
 *   institute — a tenant deleting tenants is a containment breach, including
 *               deleting itself (which would strand every user under it).
 */
const WEBOWNER_ONLY_S: DeletableResourceS[] = ['attempt', 'institute'];

/**
 * The institute lifecycle gate (C1, audit 2026-08-06), applied server-side.
 *
 * `status: 'disabled'` and an elapsed `activeUntil` are the two ways a Web
 * Owner switches a tenant off. Before this, NEITHER was enforced anywhere on
 * the server: `activeUntil` did not appear in this file at all, and
 * firestore.rules referenced it only in a comment. The entire gate was three
 * client-side checks (InstituteAuthContext:88, FacultyAuthContext:106,
 * StudentAuthContext:143), and those run only while a session is being built.
 *
 * Two holes that left, both real once the rules clause was the only thing
 * standing:
 *
 *   A session established BEFORE the tenant was switched off keeps working.
 *   Nothing re-checks until the next sign-in, and disabling an institute does
 *   not disable the Auth user or revoke its refresh tokens
 *   (UserManagementPage:598 is a bare updateDoc), so the token stays valid.
 *
 *   Anything that is not the browser app is ungated entirely. The client
 *   check is a UI behaviour, not a boundary; a direct callable invocation
 *   never passed through it.
 *
 * SCOPE IS DELIBERATE. This takes a snapshot the caller has ALREADY fetched
 * rather than reading the doc itself, so it is wired only into paths that
 * were fetching institutes/{id} anyway — the question-rights gate and the
 * three deletion-rights gates. Those are the privileged administrative paths,
 * and there the check costs nothing. It is deliberately NOT on the exam
 * transition callables: those read the attempt and the assessment, not the
 * institute, and adding a Firestore read to every answer submission to
 * re-litigate a tenant-level fact would tax the one subsystem least in need
 * of new failure modes. A student mid-sitting when their institute expires
 * finishes their exam, which is also the humane outcome.
 *
 * Fails closed on a missing document: no institute, no rights.
 */
function assertInstituteActiveS(snap: FirebaseFirestore.DocumentSnapshot): void {
  if (!snap.exists) {
    throw new HttpsError('permission-denied', 'Institute not found.');
  }
  if (snap.get('status') === 'disabled') {
    throw new HttpsError(
      'permission-denied',
      'This institute account is disabled. Contact your platform administrator.',
    );
  }
  if (snap.get('lifecycleState') === 'softDeleted') {
    throw new HttpsError(
      'permission-denied',
      'This institute account has been deleted. Contact your platform administrator.',
    );
  }
  if (hasExpiredS(snap.get('activeUntil'))) {
    throw new HttpsError(
      'permission-denied',
      "This institute's access period has expired. Contact your platform administrator.",
    );
  }
}

/**
 * Server twin of `expiryInstant` in src/lib/instituteValidity.ts.
 * KEEP IN SYNC — the two decide the same fact for the same tenant, and a
 * divergence means the login screen and the enforcement sweep disagree about
 * whether an institute is still paid up.
 *
 * ── THE DATE-ONLY SHAPE IS THE ONE THAT MATTERS ───────────────────
 *
 * `computeActiveUntil` ends with `.toISOString().split('T')[0]`, so what is
 * actually stored on these documents is a bare `YYYY-MM-DD`. Date.parse reads
 * that as UTC midnight at the START of the named day, so the check here — and
 * the identical one on the client — treated the tenant as expired for the
 * whole of the date the Web Owner had picked. An institute sold access "until
 * 21 September" could not sign in on 21 September.
 *
 * A date-only bound therefore means the END of that day. Values carrying an
 * explicit time are a precise instant and are left exactly as they were.
 *
 * Absent, empty and unparseable all mean NO expiry rather than an expired one
 * — keeping institutes provisioned before the field existed working, and
 * refusing to lock a tenant out over a malformed string.
 */
const DATE_ONLY_S = /^\d{4}-\d{2}-\d{2}$/;

function expiryInstantS(activeUntil: unknown): number | null {
  const trimmed = String(activeUntil ?? '').trim();
  if (trimmed === '') return null;
  // An impossible date ('2026-13-45') matches the pattern and still parses to
  // NaN, landing on the same "no expiry" answer as any other unparseable value.
  const t = DATE_ONLY_S.test(trimmed)
    ? Date.parse(`${trimmed}T23:59:59.999Z`)
    : Date.parse(trimmed);
  return Number.isFinite(t) ? t : null;
}

function hasExpiredS(activeUntil: unknown, now: number = Date.now()): boolean {
  const t = expiryInstantS(activeUntil);
  return t !== null && t < now;
}

/**
 * The effective deletion mode for an actor on a resource: 'direct' (do it
 * now), 'request' (needs approval — Phase 4), or 'none' (not permitted).
 *
 * Fails closed on every missing input: no ceiling, no grant, or a grant whose
 * mode the ceiling no longer permits all yield 'none'.
 */
function resolveDeletionModeS(
  callerRole: string | undefined,
  resource: DeletableResourceS,
  ceiling: DeletionCeilingS | undefined,
  facultyRights: FacultyDeletionRightsS | undefined,
): DeletionModeS | 'none' {
  if (callerRole === 'webOwner') return 'direct';

  // Forced off regardless of what the ceiling document contains.
  if (WEBOWNER_ONLY_S.includes(resource)) return 'none';

  const c = ceiling?.[resource];
  if (!c?.allowed) return 'none';

  if (callerRole === 'institute') {
    // Absent selfMode reads as 'direct' — matches the client default and the
    // questionRights shape, which has no equivalent field.
    return c.selfMode === 'request' ? 'request' : 'direct';
  }

  if (callerRole === 'faculty') {
    const fr = facultyRights?.[resource];
    if (!fr?.granted || !fr.mode) return 'none';
    // A ceiling narrowed AFTER the grant must bite immediately, without
    // needing every faculty document to be rewritten.
    if (!(c.modes ?? []).includes(fr.mode)) return 'none';
    return fr.mode;
  }

  return 'none';
}

// ── Ownership succession (Feature #15, Phase 5a) ──────────────────
//
// When a faculty member is removed, their content must go somewhere. Left
// alone it becomes UNWRITABLE BY EVERYONE: canWriteOwned in firestore.rules
// grants write/delete to whoever matches ownerId, so a question owned by a
// deleted uid can be read (the tenant stamp survives) but never edited or
// removed again. Stranded, maintainable by nobody.
//
// DEFAULT SUCCESSOR = THE INSTITUTE ADMIN. It is the one target that always
// exists as long as the institute does, so it can never fail and needs nobody
// to choose anything — which is what makes it safe for bulk deletes and for
// cascades where no human is present.
//
// ONE HOP, ALWAYS. If A's content passed to B and B now leaves, B's content
// (including A's) goes to the institute admin — never onward to whoever B
// once named. Chains are unreadable and make restore ambiguous.
//
// The previous owner is recorded on the AUDIT ROW, not on the content: the
// content doc only carries its CURRENT owner, so once succession rewrites
// ownerId the original is gone from it. The row is the only record, and is
// what will let Phase 6 reverse a succession on restore.

type SuccessionOutcomeS = {
  toOwnerType: 'institute' | 'faculty';
  toOwnerId: string;
  reason: 'chosen' | 'defaulted' | 'fallback';
  counts: Record<string, number>;
};

/** Rewrite ownerType/ownerId across one collection, in batches. */
async function reassignOwned(
  db: FirebaseFirestore.Firestore,
  collection: string,
  fromOwnerId: string,
  to: { ownerType: string; ownerId: string },
): Promise<number> {
  let moved = 0;
  try {
    const snap = await db.collection(collection)
      .where('ownerType', '==', 'faculty')
      .where('ownerId', '==', fromOwnerId)
      .get();
    let batch = db.batch();
    let n = 0;
    for (const d of snap.docs) {
      const patch: Record<string, unknown> = {
        ownerType: to.ownerType,
        ownerId: to.ownerId,
        updatedAt: new Date().toISOString(),
      };
      // Preserve authorship. "Who controls this now" changes; "who wrote it"
      // must not. Only stamped if absent, so a second succession never
      // overwrites the true original author with an intermediate holder.
      if (d.get('originalOwnerId') === undefined) {
        patch.originalOwnerType = 'faculty';
        patch.originalOwnerId = fromOwnerId;
      }
      batch.update(d.ref, patch);
      moved++;
      if (++n >= 400) { await batch.commit(); batch = db.batch(); n = 0; }
    }
    if (n > 0) await batch.commit();
  } catch (err) {
    console.error('reassignOwned failed', collection, fromOwnerId, err);
  }
  return moved;
}

/**
 * Move a departing faculty member's content to a successor.
 *
 * The chosen successor is validated HERE, at execution time — not when it was
 * picked. A request can sit in an approval inbox for days; a colleague chosen
 * on Monday may be archived or deleted by Thursday. Trusting a selection-time
 * check would transfer content to a dead account.
 */
async function performFacultySuccession(
  db: FirebaseFirestore.Firestore,
  facultyId: string,
  instituteId: string,
  chosenSuccessorId?: string | null,
): Promise<SuccessionOutcomeS> {
  let to: { ownerType: 'institute' | 'faculty'; ownerId: string } =
    { ownerType: 'institute', ownerId: instituteId };
  let reason: SuccessionOutcomeS['reason'] = 'defaulted';

  if (chosenSuccessorId && chosenSuccessorId !== facultyId) {
    const sucSnap = await db.collection('faculty').doc(chosenSuccessorId).get();
    const valid = sucSnap.exists
      && sucSnap.get('instituteId') === instituteId
      && sucSnap.get('status') !== 'disabled'
      && sucSnap.get('lifecycleState') !== 'softDeleted'
      && sucSnap.get('lifecycleState') !== 'archived';
    if (valid) {
      to = { ownerType: 'faculty', ownerId: chosenSuccessorId };
      reason = 'chosen';
    } else {
      // An intent existed and could not be honoured — distinct from nobody
      // having chosen, and worth surfacing to whoever chose.
      reason = 'fallback';
    }
  }

  const [questions, questionBanks, assessments] = await Promise.all([
    reassignOwned(db, 'questions', facultyId, to),
    reassignOwned(db, 'questionBanks', facultyId, to),
    reassignOwned(db, 'assessments', facultyId, to),
  ]);

  return {
    toOwnerType: to.ownerType,
    toOwnerId: to.ownerId,
    reason,
    counts: { questions, questionBanks, assessments },
  };
}

/**
 * Does this faculty member own assessments that are LIVE right now?
 *
 * Deleting the owner of a running exam is the one case succession does not
 * make safe: students may be mid-attempt, and an ownership change during a
 * sitting is a variable nobody wants in an exam-integrity story. The caller
 * blocks and asks for reassignment first.
 */
async function countLiveOwnedAssessments(
  db: FirebaseFirestore.Firestore,
  facultyId: string,
): Promise<number> {
  try {
    const snap = await db.collection('assessments')
      .where('ownerType', '==', 'faculty')
      .where('ownerId', '==', facultyId)
      .where('status', '==', 'active')
      .count().get();
    return snap.data().count;
  } catch (err) {
    console.error('countLiveOwnedAssessments failed', facultyId, err);
    // Fail CLOSED: if we cannot prove nothing is live, treat it as live.
    return 1;
  }
}

// ── Institute cascade (Feature #15, Phase 5b) ─────────────────────
//
// CLOSES BUG (a). Until now, deleting an institute removed only its own
// profile, credentials and logo. Its faculty, students, assessments,
// questions, banks, attempts and mappings were left behind — still stamped
// with the id of a tenant that no longer existed, invisible to everyone but
// the Web Owner, and impossible to clean up through any UI.
//
// LOCKED DECISION (D4): "institute goes so goes with their data". The chain
// is purge institute → purge its students → purge their attempts. This is the
// ONE path permitted to destroy attempt data outside the Phase 7 erasure
// flow, and it is permitted only because the students themselves are going.
//
// THE ONE EXCEPTION, and it is the Web Owner's call:
// A WEBOWNER-OWNED assessment survives the wipe — ownership was never the
// institute's, and who sat the exam does not determine who owns it. But the
// attempts on it by this institute's students are a genuine judgement call:
//   • if that assessment was ONLY ever sat by this institute's students, its
//     results are worthless once they are gone — deleting is reasonable
//   • if it spans several institutes, deleting would silently gut a
//     cross-institute exam's results and analytics with no record of why
// So the caller passes an explicit list of webOwner assessment ids whose
// attempts should ALSO go. Absent ⇒ none of them, which is the safe default:
// a cascade that destroys the Web Owner's own exam history by omission would
// be the worst possible failure mode here.

/** Delete every doc matching one equality filter, in batches. Returns the count. */
/**
 * Delete the per-attempt records that hang off an attempt but are not keyed by
 * the student.
 *
 * attemptVerdicts, attemptTelemetry and attemptManualMarks are keyed by
 * attemptId, so the studentId-based purge that erases everything else never
 * sees them. Without this they survive the erasure of the person they describe
 * — orphaned, still readable by staff, and still containing that person's
 * program output, a keystroke-level record of them writing it, and an
 * examiner's written remarks about their work.
 *
 * TELEMETRY GOES IN BOTH MODES, VERDICTS AND MANUAL MARKS ONLY ON DELETE.
 *
 * An anonymised attempt is kept because the institute needs the academic
 * record, and a verdict is part of that record — it is the justification for
 * the mark on the row, and a retained mark nobody can explain is worse than no
 * row at all. A manual mark is the same argument with a person at the end of
 * it instead of a judge: it is the reason there is a number on an essay, and
 * it is also a scoring INPUT, so deleting it while keeping the row would make
 * the next regrade quietly drop marks off an anonymised transcript.
 *
 * Telemetry has no such claim. It is not an academic record; it is material
 * about how somebody worked, kept for review and research, and none of that
 * survives a person exercising erasure. It is also the most identifying thing
 * here: a score is not a fingerprint, and the rhythm of someone typing under
 * pressure comes closer to being one.
 *
 * WHAT ANONYMISE DOES TO A RETAINED MARK: severs its studentId, exactly as
 * anonymizeAttempts severs the attempt's. The record is kept for the same
 * reason the attempt row is kept, and the link to the person is cut for the
 * same reason too — leaving the original studentId on a child record would
 * make the parent's anonymisation cosmetic, since the two are joinable.
 */
export async function purgeAttemptChildRecords(
  db: FirebaseFirestore.Firestore,
  attemptIds: string[],
  opts: { includeVerdicts: boolean },
): Promise<{ telemetryDeleted: number; verdictsDeleted: number; marksTouched: number }> {
  let telemetryDeleted = 0;
  let verdictsDeleted = 0;
  let marksTouched = 0;
  for (const attemptId of attemptIds) {
    telemetryDeleted += await purgeWhere(db, 'attemptTelemetry', 'attemptId', attemptId);
    if (opts.includeVerdicts) {
      verdictsDeleted += await purgeWhere(db, 'attemptVerdicts', 'attemptId', attemptId);
      marksTouched    += await purgeWhere(db, 'attemptManualMarks', 'attemptId', attemptId);
    } else {
      marksTouched += await severStudentOnManualMarks(db, attemptId);
    }
  }
  return { telemetryDeleted, verdictsDeleted, marksTouched };
}

/**
 * Cut the link from a retained grading record back to the erased person.
 *
 * The mirror of anonymizeAttempts, and it has to exist for the same reason:
 * `erased:<attemptId>` is not a remapping anyone can reverse, which is what
 * separates erasure from pseudonymisation. The award survives — it is the
 * scoring input behind a number on a transcript the institute keeps — and
 * nothing that points at a person does.
 */
async function severStudentOnManualMarks(
  db: FirebaseFirestore.Firestore,
  attemptId: string,
): Promise<number> {
  let touched = 0;
  try {
    const snap = await db.collection('attemptManualMarks')
      .where('attemptId', '==', attemptId).get();
    let batch = db.batch();
    let n = 0;
    for (const d of snap.docs) {
      batch.update(d.ref, { studentId: `erased:${attemptId}` });
      touched++;
      if (++n >= 400) { await batch.commit(); batch = db.batch(); n = 0; }
    }
    if (n > 0) await batch.commit();
  } catch (err) {
    console.error('severStudentOnManualMarks failed', attemptId, err);
  }
  return touched;
}

/** Attempt ids belonging to one student. Read BEFORE the attempts are removed. */
export async function attemptIdsForStudent(
  db: FirebaseFirestore.Firestore,
  studentId: string,
): Promise<string[]> {
  try {
    const snap = await db.collection('attempts').where('studentId', '==', studentId).get();
    return snap.docs.map((d) => d.id);
  } catch (err) {
    console.error('attemptIdsForStudent failed', studentId, err);
    return [];
  }
}

async function purgeWhere(
  db: FirebaseFirestore.Firestore,
  collection: string,
  field: string,
  value: string,
): Promise<number> {
  let removed = 0;
  try {
    const snap = await db.collection(collection).where(field, '==', value).get();
    let batch = db.batch();
    let n = 0;
    for (const d of snap.docs) {
      batch.delete(d.ref);
      removed++;
      if (++n >= 400) { await batch.commit(); batch = db.batch(); n = 0; }
    }
    if (n > 0) await batch.commit();
  } catch (err) {
    console.error('purgeWhere failed', collection, field, value, err);
  }
  return removed;
}

/**
 * Remove an assessment's materialized membership and its allocation doc.
 *
 * Fixes a long-parked orphan: deleteAssessment never cleaned up
 * assessmentMembers or the allocations doc, so soft-deleted assessments left
 * member rows behind indefinitely. Harmless in isolation (the student query
 * joins against live assessment docs) but it accumulates, and at institute
 * purge it would leave rows pointing at assessments that no longer exist.
 */
async function purgeAssessmentSatellites(
  db: FirebaseFirestore.Firestore,
  assessmentId: string,
): Promise<{ members: number; allocations: number }> {
  const members = await purgeWhere(db, 'assessmentMembers', 'assessmentId', assessmentId);
  let allocations = 0;
  try {
    await db.collection('allocations').doc(assessmentId).delete();
    allocations = 1;
  } catch {
    // No allocation doc — normal for legacy-targeted assessments.
  }
  return { members, allocations };
}

/**
 * Purge everything belonging to an institute.
 *
 * Ordered leaves-first: satellites before their parents, content before the
 * accounts that own it, accounts before the institute itself. If the run dies
 * partway, what remains is still reachable from the institute doc — the
 * opposite order would strand orphans with nothing pointing at them.
 *
 * Auth users are removed alongside their profiles; a profile deleted without
 * its Auth user leaves a credential that can still sign in.
 */
async function performInstituteCascade(
  db: FirebaseFirestore.Firestore,
  instituteId: string,
  opts: { deleteAttemptsOnWebOwnerAssessments?: string[] } = {},
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};

  // 1. Assessments owned by this institute (and their satellites).
  let memberRows = 0;
  let allocationRows = 0;
  const ownAssessments = await db.collection('assessments')
    .where('ownerType', '==', 'institute')
    .where('ownerId', '==', instituteId)
    .get()
    .catch(() => null);

  if (ownAssessments) {
    for (const a of ownAssessments.docs) {
      const sat = await purgeAssessmentSatellites(db, a.id);
      memberRows += sat.members;
      allocationRows += sat.allocations;
      // Attempts on the institute's OWN assessments go unconditionally —
      // both the exam and the people who sat it are being destroyed.
      counts.attempts = (counts.attempts ?? 0)
        + await purgeWhere(db, 'attempts', 'assessmentId', a.id);
      await a.ref.delete().catch(() => undefined);
    }
    counts.assessments = ownAssessments.size;
  }

  // 2. Attempts on WEBOWNER-owned assessments — only where the Web Owner
  //    explicitly said so. Default is to keep them.
  for (const assessmentId of opts.deleteAttemptsOnWebOwnerAssessments ?? []) {
    const snap = await db.collection('attempts')
      .where('assessmentId', '==', assessmentId)
      .where('instituteId', '==', instituteId)
      .get()
      .catch(() => null);
    if (!snap) continue;
    let batch = db.batch();
    let n = 0;
    for (const d of snap.docs) {
      batch.delete(d.ref);
      counts.attempts = (counts.attempts ?? 0) + 1;
      if (++n >= 400) { await batch.commit(); batch = db.batch(); n = 0; }
    }
    if (n > 0) await batch.commit();
    // Their membership rows go with them; the assessment itself stays.
    memberRows += await purgeWhere(db, 'assessmentMembers', 'assessmentId', assessmentId);
  }

  counts.assessmentMembers = memberRows;
  counts.allocations = allocationRows;

  // 3. Content owned by the institute or its faculty.
  counts.questions = await purgeWhere(db, 'questions', 'instituteId', instituteId);
  counts.questionBanks = await purgeWhere(db, 'questionBanks', 'instituteId', instituteId);
  counts.questionShares = await purgeWhere(db, 'questionShares', 'instituteId', instituteId);
  counts.questionReports = await purgeWhere(db, 'questionReports', 'instituteId', instituteId);

  // Per-attempt records that hang off attempts but are keyed by attemptId, so
  // the studentId and assessmentId purges below never see them. All three
  // carry instituteId precisely so they can be swept here — otherwise
  // destroying an institute would leave behind its candidates' program output,
  // a keystroke record of them writing it, and an examiner's written remarks
  // about their work, readable by nobody and deletable by nothing, because the
  // attempts they pointed at are gone.
  counts.attemptVerdicts    = await purgeWhere(db, 'attemptVerdicts',    'instituteId', instituteId);
  counts.attemptTelemetry   = await purgeWhere(db, 'attemptTelemetry',   'instituteId', instituteId);
  counts.attemptManualMarks = await purgeWhere(db, 'attemptManualMarks', 'instituteId', instituteId);

  // 4. Academic hierarchy + mappings.
  counts.academicMappings = await purgeWhere(db, 'academicMappings', 'instituteId', instituteId);
  for (const c of HIERARCHY_COLLECTIONS) {
    counts[c] = await purgeWhere(db, c, 'instituteId', instituteId);
  }

  // 5. People — Auth user first, then profile and credentials. Any remaining
  //    attempts belonging to these students go with them (D4).
  for (const [col, credCol] of [
    ['students', 'studentCredentials'],
    ['faculty', 'facultyCredentials'],
  ] as const) {
    const snap = await db.collection(col).where('instituteId', '==', instituteId).get()
      .catch(() => null);
    if (!snap) continue;
    for (const d of snap.docs) {
      if (col === 'students') {
        counts.attempts = (counts.attempts ?? 0)
          + await purgeWhere(db, 'attempts', 'studentId', d.id);
        // Also by studentId, not only by instituteId above: QuestionReport
        // types instituteId as OPTIONAL, so any report written before that
        // field existed would otherwise survive its own institute's purge as
        // an unreachable orphan. Current code always sets it; this covers the
        // legacy tail. purgeWhere is idempotent, so the overlap is harmless.
        counts.questionReports = (counts.questionReports ?? 0)
          + await purgeWhere(db, 'questionReports', 'studentId', d.id);
      }
      try {
        await getAuth().deleteUser(d.id);
      } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code !== 'auth/user-not-found') {
          console.error('cascade: auth delete failed', d.id, err);
        }
      }
      await db.collection(credCol).doc(d.id).delete().catch(() => undefined);
      await d.ref.delete().catch(() => undefined);
    }
    counts[col] = snap.size;
  }

  // 6. Requests and grants referencing this tenant.
  counts.deletionRequests = await purgeWhere(db, 'deletionRequests', 'instituteId', instituteId);
  counts.questionRequests = await purgeWhere(db, 'questionRequests', 'instituteId', instituteId);

  return counts;
}

/**
 * Classify the WEBOWNER-owned assessments this institute's students have sat,
 * so the Web Owner can decide per assessment whether the attempts go too.
 *
 * EXCLUSIVE — every attempt on it came from this institute. Its results become
 *             meaningless once they are gone, so deleting is reasonable.
 * SHARED     — other institutes sat it too. Deleting would silently remove a
 *             slice of a cross-institute exam's history.
 *
 * Read-only; safe to call whenever.
 */
export const getInstitutePurgePreview = onCall<{ instituteId: string }>(
  CALLABLE_BASE,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    if ((request.auth.token.role as string) !== 'webOwner') {
      throw new HttpsError('permission-denied', 'Only the Web Owner may inspect an institute purge.');
    }
    const { instituteId } = request.data || ({} as never);
    if (!instituteId) throw new HttpsError('invalid-argument', 'instituteId is required.');

    const db = getFirestore();

    // Every assessment this tenant's students have attempted.
    const attemptSnap = await db.collection('attempts')
      .where('instituteId', '==', instituteId)
      .select('assessmentId')
      .get();
    const assessmentIds = Array.from(
      new Set(attemptSnap.docs.map((d) => d.get('assessmentId') as string).filter(Boolean)),
    );

    const rows: Array<{
      assessmentId: string;
      title: string | null;
      ownAttempts: number;
      otherInstituteAttempts: number | null;
      exclusive: boolean;
    }> = [];

    for (const id of assessmentIds) {
      const aSnap = await db.collection('assessments').doc(id).get();
      // Only webOwner-owned assessments are a question at all — the
      // institute's own go unconditionally, and there is nothing to decide.
      if (!aSnap.exists || aSnap.get('ownerType') !== 'webOwner') continue;

      const own = attemptSnap.docs.filter((d) => d.get('assessmentId') === id).length;
      let total: number | null = null;
      try {
        const totalSnap = await db.collection('attempts')
          .where('assessmentId', '==', id).count().get();
        total = totalSnap.data().count;
      } catch (err) {
        console.error('purge preview: total count failed', id, err);
      }

      rows.push({
        assessmentId: id,
        title: (aSnap.get('title') as string) ?? null,
        ownAttempts: own,
        otherInstituteAttempts: total === null ? null : Math.max(0, total - own),
        // Unknown totals are treated as SHARED — the conservative reading,
        // since wrongly marking something exclusive invites its deletion.
        exclusive: total !== null && total - own <= 0,
      });
    }

    return { ok: true as const, instituteId, assessments: rows };
  },
);

// ── Soft delete + restore (Feature #15, Phase 6a) ─────────────────
//
// CLOSES BUG (b). Until now every account removal was immediate and
// irreversible — one misclick destroyed a person's record with no undo.
// Deletion now enters a recoverable state first; destruction happens only at
// PURGE, after the retention window or by explicit Web Owner action.
//
// THE AUTH USER IS DISABLED, NOT DELETED.
// Disabling is the only option that makes restore real: the account comes
// back instantly and the person keeps their password. Deleting the Auth user
// would mean restore had to recreate it and reissue credentials, which is a
// different feature wearing the word "restore".
//
// The tradeoff, stated plainly: a disabled Auth user still CLAIMS its email,
// so the same address cannot be re-registered until the record is purged.
// That is the correct trade for a reversibility feature — an email freed
// early is an email that can be re-registered while the original owner is
// still restorable, which would make restore fail in a far more confusing way.

/** Server twin of RETENTION_DAYS in src/lib/lifecycle.ts. KEEP IN SYNC. */
const RETENTION_DAYS_S: Record<string, number> = {
  student: 30,
  faculty: 30,
  institute: 180,
  assessment: 90,
  question: 90,
  questionBank: 90,
  subjectTopic: 90,
  hierarchyNode: 90,
};

function computePurgeAfterS(entity: string, from: Date = new Date()): string | null {
  const days = RETENTION_DAYS_S[entity];
  if (days == null) return null;
  const d = new Date(from.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

/**
 * Move an account into the recoverable soft-deleted state.
 *
 * Destroys NOTHING. No cascade runs here — for an institute in particular,
 * its faculty, students and content stay exactly where they are, because the
 * whole point is that the tenant can come back intact. The cascade moves to
 * purge, where it belongs.
 */
async function performAccountSoftDelete(
  db: FirebaseFirestore.Firestore,
  params: {
    role: Role;
    uid: string;
    profileRef: FirebaseFirestore.DocumentReference;
    auditLabel: string | null;
    auditFromState: LifecycleStateS;
    targetInstituteId: string | null;
    actorUid: string;
    actorRole: string;
    reason?: string | null;
    requestId?: string | null;
    /**
     * Faculty only. Captured NOW but applied at PURGE, because succession is
     * irreversible and soft delete is not. The admin who knew this person is
     * the one qualified to choose, and they are here today — asking again
     * months later, of whoever happens to run the purge, would get a worse
     * answer. Re-validated at execution regardless.
     */
    pendingSuccessorId?: string | null;
  },
): Promise<void> {
  const now = new Date();

  // Access is revoked FIRST. If the profile were flagged first and this then
  // failed, a person marked deleted would still be able to sign in.
  try {
    await getAuth().updateUser(params.uid, { disabled: true });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code !== 'auth/user-not-found') {
      console.error('softDelete: could not disable auth user', params.uid, err);
      throw new HttpsError('internal', 'Could not revoke sign-in for this account.');
    }
  }

  await params.profileRef.update({
    lifecycleState: 'softDeleted',
    deletedAt: now.toISOString(),
    deletedBy: params.actorUid,
    deletedByRole: params.actorRole,
    lifecycleReason: params.reason ?? null,
    purgeAfter: computePurgeAfterS(params.role, now),
    pendingSuccessorId: params.pendingSuccessorId ?? null,
    updatedAt: now.toISOString(),
  });

  await writeAuditRow(db, {
    action: 'softDelete',
    entityType: params.role,
    entityId: params.uid,
    entityLabel: params.auditLabel,
    fromState: params.auditFromState,
    toState: 'softDeleted',
    actorUid: params.actorUid,
    actorRole: params.actorRole,
    instituteId: params.targetInstituteId,
    reason: params.reason ?? null,
    requestId: params.requestId ?? null,
  });
}

/**
 * Bring a soft-deleted account back.
 *
 * Clears every marker set on the way out — including purgeAfter, which must
 * not survive: a restored record with a live purgeAfter would be silently
 * destroyed later by the scheduled job.
 */
export const restoreEntity = onCall<{
  role: Role;
  uid: string;
  reason?: string;
}>(CALLABLE_BASE, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const { role, uid, reason } = request.data || ({} as never);
  if (!role || !COLLECTION_BY_ROLE[role]) throw new HttpsError('invalid-argument', 'Invalid role.');
  if (!uid) throw new HttpsError('invalid-argument', 'uid is required.');

  const db = getFirestore();
  const actor = actorFrom(request);
  const ref = db.collection(COLLECTION_BY_ROLE[role]).doc(uid);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Record not found.');

  const data = snap.data() as Record<string, unknown>;
  const targetInstituteId =
    role === 'institute' ? uid : (data.instituteId as string | undefined) ?? null;

  // Restoring is a lower bar than deleting — it is non-destructive — but it
  // is still scoped: an institute may only restore inside its own tenant, and
  // only the Web Owner may restore an institute.
  if (actor.actorRole !== 'webOwner') {
    if (actor.actorRole !== 'institute' || role === 'institute') {
      throw new HttpsError('permission-denied', 'Insufficient permissions.');
    }
    if (!actor.instituteId || actor.instituteId !== targetInstituteId) {
      throw new HttpsError('permission-denied', 'Different institute.');
    }
  }

  const current: LifecycleStateS =
    (data.lifecycleState as LifecycleStateS) ??
    (data.isDeleted === true ? 'softDeleted' : 'active');
  if (current !== 'softDeleted' && current !== 'archived') {
    throw new HttpsError('failed-precondition', 'This record is not deleted or archived.');
  }

  try {
    await getAuth().updateUser(uid, { disabled: false });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code !== 'auth/user-not-found') {
      console.error('restore: could not re-enable auth user', uid, err);
      throw new HttpsError('internal', 'Could not restore sign-in for this account.');
    }
  }

  const nowIso = new Date().toISOString();
  await ref.update({
    lifecycleState: 'active',
    // Cleared absolutely. A stale purgeAfter on a restored record is a
    // scheduled deletion nobody asked for.
    purgeAfter: null,
    deletedAt: null,
    deletedBy: null,
    deletedByRole: null,
    archivedAt: null,
    archivedBy: null,
    archivedByRole: null,
    lifecycleReason: null,
    pendingSuccessorId: null,
    status: 'active',
    updatedAt: nowIso,
  });

  await writeAuditRow(db, {
    action: 'restore',
    entityType: role,
    entityId: uid,
    entityLabel: (data.name as string) || (data.email as string) || null,
    fromState: current,
    toState: 'active',
    actorUid: actor.actorUid,
    actorRole: actor.actorRole,
    instituteId: targetInstituteId,
    reason: reason ?? null,
  });

  return { ok: true as const, restored: role, uid };
});

/**
 * Destroy a soft-deleted record for good. Web Owner only.
 *
 * This is where the Phase 5b cascade now lives. It moved off the delete path
 * deliberately: deletion is recoverable and must destroy nothing, so a
 * cascade there would have made "soft" a lie.
 */
export const purgeEntity = onCall<{
  role: Role;
  uid: string;
  deleteAttemptsOnWebOwnerAssessments?: string[];
  /** Faculty only — who inherits their content, validated at execution. */
  successorId?: string;
  reason?: string;
}>(CALLABLE_BASE, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const actor = actorFrom(request);
  if (actor.actorRole !== 'webOwner') {
    throw new HttpsError('permission-denied', 'Only the Web Owner may permanently delete.');
  }

  const { role, uid, deleteAttemptsOnWebOwnerAssessments, successorId, reason } =
    request.data || ({} as never);
  if (!role || !COLLECTION_BY_ROLE[role]) throw new HttpsError('invalid-argument', 'Invalid role.');
  if (!uid) throw new HttpsError('invalid-argument', 'uid is required.');

  const db = getFirestore();
  const profileRef = db.collection(COLLECTION_BY_ROLE[role]).doc(uid);
  const snap = await profileRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Record not found.');

  const data = snap.data() as Record<string, unknown>;
  const state: LifecycleStateS =
    (data.lifecycleState as LifecycleStateS) ??
    (data.isDeleted === true ? 'softDeleted' : 'active');

  // Purge is reachable only from the recoverable state. Without this, a
  // single call could destroy a live tenant with no soft-delete step and no
  // window in which anyone could have noticed.
  if (state !== 'softDeleted') {
    throw new HttpsError(
      'failed-precondition',
      'Only a deleted record can be permanently removed. Delete it first.',
    );
  }

  const targetInstituteId =
    role === 'institute' ? uid : (data.instituteId as string | undefined) ?? null;

  let cascadeCounts: Record<string, number> | null = null;
  if (role === 'institute') {
    cascadeCounts = await performInstituteCascade(db, uid, {
      deleteAttemptsOnWebOwnerAssessments,
    });
  }

  await performAccountDeletion(db, {
    role,
    uid,
    profileRef,
    auditLabel: (data.name as string) || (data.email as string) || null,
    auditFromState: 'softDeleted',
    targetInstituteId,
    actorUid: actor.actorUid,
    actorRole: actor.actorRole,
    reason: reason ?? null,
    impact: cascadeCounts,
    // An explicit choice at purge wins; otherwise honour what the admin
    // picked when they removed the account.
    successorId: successorId ?? (data.pendingSuccessorId as string | null) ?? null,
  });

  return { ok: true as const, purged: role, uid, counts: cascadeCounts };
});

// ── Scheduled purge (Feature #15, Phase 6b) ───────────────────────
//
// Destroys soft-deleted records whose retention window has expired.
//
// THIS IS THE MOST DANGEROUS CODE IN THE FEATURE. A timer that hard-deletes
// tenants, unattended, with nobody watching. So it is built to be timid:
//
//   • DRY RUN BY DEFAULT. It logs exactly what it WOULD purge and changes
//     nothing. Flipping it on is a deliberate act — set the platform flag
//     platformSettings/lifecycle.purgeEnabled to true — not something that
//     happens because the code shipped.
//   • FAILS CLOSED on every uncertainty. Missing purgeAfter, unparseable
//     purgeAfter, a record that is not softDeleted, or a lifecycleState the
//     job does not recognise: all skipped. A record is destroyed only when
//     the evidence positively says it is due.
//   • CAPPED PER RUN. A bug that made everything look eligible can damage at
//     most PURGE_BATCH_LIMIT records before someone sees the logs.
//   • INSTITUTES ARE NEVER AUTO-PURGED. Their blast radius is a whole tenant
//     — every faculty member, student, assessment and attempt. That decision
//     stays with a human. The job reports them as due and leaves them alone.
//
// Everything it does route through the same performInstituteCascade /
// performAccountDeletion used by the manual path, so there is no second
// implementation of destruction to keep in sync.

const PURGE_BATCH_LIMIT = 50;

/** Roles the scheduled job may purge on its own. Institutes deliberately absent. */
const AUTO_PURGEABLE_ROLES: Role[] = ['faculty', 'student'];

async function isPurgeEnabled(db: FirebaseFirestore.Firestore): Promise<boolean> {
  try {
    const snap = await db.collection('platformSettings').doc('lifecycle').get();
    return snap.exists && snap.get('purgeEnabled') === true;
  } catch (err) {
    // Unreadable flag ⇒ stay in dry run. The safe reading of "I don't know".
    console.error('purge: could not read platformSettings/lifecycle', err);
    return false;
  }
}

/** Is this record positively due for purge? Fails closed on every doubt. */
function isDueForPurge(data: Record<string, unknown>, now: Date): boolean {
  if (data.lifecycleState !== 'softDeleted') return false;
  const after = data.purgeAfter;
  if (typeof after !== 'string' || !after) return false;
  const t = Date.parse(after);
  if (Number.isNaN(t)) return false;
  return now.getTime() >= t;
}

/**
 * Close attempts whose writable window has expired (audit 2026-07-28).
 *
 * The rule change stops a late student WRITING, but on its own it leaves the
 * attempt sitting in_progress forever. That matters for three reasons: the
 * attempt is never graded, so the student has no result; it occupies one of
 * their attempt slots indefinitely, since evaluateStudentAttempts counts
 * in_progress as live and returns it instead of allowing a fresh start; and
 * abandoned attempts accumulate without bound, which at a 10,000-student scale
 * is a real pile.
 *
 * It is also the only thing that covers attempts created BEFORE
 * answersLockedAfter existed. Those have no lock field, the rule deliberately
 * lets them through rather than freezing every exam in flight at deploy, and
 * this sweep is what actually closes them.
 *
 * Marks them auto_submitted rather than deleting anything — the answers the
 * student did record stand, exactly as they would if the client had hit its
 * own timer. Grading is left to the existing gradeAttempt path rather than
 * duplicated here, so there is one scoring implementation, not two that can
 * drift.
 *
 * Hourly, not by-the-minute: this is a backstop for abandonment, and the rule
 * above is what enforces the deadline precisely. A student who walks away is
 * closed out within the hour; a student still at the keyboard is stopped at
 * the exact second by the rule.
 */
/**
 * How long a frozen attempt may sit unresolved before the sweep closes it.
 *
 * Doctrine D8: an automatic freeze (extension check) is entered without a
 * human, so it must be exitable without one. An invigilator queue nobody is
 * watching must never become an indefinite hold on a student's exam.
 *
 * Six hours is deliberately generous — long enough that it never fires during
 * a supervised sitting, short enough that a forgotten freeze resolves the same
 * day. Closing GRANTS the full frozen interval, so a student is never punished
 * for an unattended queue.
 */
// Retired in Phase 4.4 (D-30). A freeze no longer expires on a timer: it ends
// when a human ends it, or when the availability window closes. Left as a
// named tombstone rather than deleted silently, so anyone looking for the
// six-hour behaviour finds out where it went.
// const STALE_FREEZE_HOURS = 6;

/**
 * How long an attempt may sit untouched before the sweep closes it even
 * though the resolver says the student still has somewhere to go.
 *
 * Needed because of D-24 below: once the sweep stops closing everything past
 * `answersLockedAfter`, an abandoned attempt on an exam with no overall limit
 * and no window would otherwise stay open forever. Six hours is long enough
 * that it can never fire on a supervised sitting or a break, short enough that
 * an abandoned attempt resolves the same day.
 */
const STALE_ATTEMPT_HOURS = 6;

export const scheduledCloseExpiredAttempts = onSchedule(
  {
    schedule: 'every 60 minutes',
    timeZone: 'Etc/UTC',
    region: 'us-central1',
    // Grading is real work now (see below), so the 60s Gen2 default is no
    // longer enough headroom for a large batch. Memory is raised for the same
    // reason: gradedAnswers for a few hundred long papers is not small.
    timeoutSeconds: 540,
    memory: '512MiB',
  },
  async () => {
    const db = getFirestore();
    const now = Timestamp.now();
    const nowMs = now.toMillis();
    const nowIso = new Date(nowMs).toISOString();

    // ── (A) in_progress attempts past their lock ──────────────────
    // Firestore range queries skip documents missing the field entirely, which
    // is exactly right — a legacy or genuinely untimed attempt has no deadline
    // to be past. Uses the existing (status, answersLockedAfter) index.
    const expiredSnap = await db.collection('attempts')
      .where('status', '==', 'in_progress')
      .where('answersLockedAfter', '<', now)
      .limit(500)
      .get();

    // ── (B) frozen attempts (D-02, master plan Phase 1) ───────────
    // A frozen attempt was invisible to this sweep, because the query above
    // filters on in_progress. Combined with firestore.rules (which require
    // in_progress on both sides of a student write) and gradeAttempt's
    // finalised guard, status:'frozen' was a state with an entrance and no
    // exit: blocked from answering, clock draining, unable to submit, unable
    // to be closed.
    //
    // A SEPARATE equality-only query rather than `status in [...]` on the
    // query above: a single-field filter needs no composite index, so this
    // ships with the functions deploy and cannot fail on a missing index in
    // production. Frozen attempts are a small set by nature.
    //
    // Two reasons to close a frozen attempt, both evaluated in memory:
    //   1. its answer window has already passed — the trap case;
    //   2. (retired, D-30) it had been frozen longer than six hours. A freeze
    //      is owned by a human and does not time out — see the note below.
    const frozenSnap = await db.collection('attempts')
      .where('status', '==', 'frozen')
      .limit(300)
      .get();

    type Closing = {
      doc: FirebaseFirestore.QueryDocumentSnapshot;
      // 'stale_freeze_sweep' retired with D-30 — nothing produces it now.
      reason: string;
      /** Frozen seconds to credit on close (stale freezes are granted in full). */
      grantFrozenSeconds: number;
      wasFrozen: boolean;
    };

    const candidates: Closing[] = expiredSnap.docs.map((doc) => ({
      doc,
      reason: 'deadline_expired_sweep',
      grantFrozenSeconds: 0,
      wasFrozen: false,
    }));

    // ── D-30: the stale-freeze auto-close is GONE; the window close stays ──
    //
    // Half of this branch was removed and half deliberately kept, and the
    // distinction matters.
    //
    // REMOVED — frozenTooLong. A freeze older than STALE_FREEZE_HOURS used to
    // close itself and grant the whole pause. That was doctrine D8: an
    // automatic state needs an automatic exit. But A2 settles that a freeze is
    // NOT an ownerless automatic state — a named human paused this sitting and
    // owes a decision on the paused time. Closing it on a timer, six hours
    // later, with a grant nobody chose, is the system inventing an
    // authority's decision for them. "Never unfrozen" is a legitimate ending
    // (A10), not a failure to be swept up.
    //
    // KEPT — windowGone. A10 row 1 is closed: the availability window closing
    // while a student is frozen DOES finalise the attempt, and it is "the only
    // automatic ending, and what stops provisional running forever". Deleting
    // this branch wholesale — which is what "remove the sweep's frozen-attempt
    // handling" says if read literally — would remove the sole enforcement of
    // a decision already made.
    //
    // The window is the institution's outer wall, not one of the student's
    // clocks. Same reason resolve() evaluates it against real time while every
    // other deadline pauses (4.3).
    if (candidates.length === 0 && frozenSnap.empty) {
      console.log('[closeExpiredAttempts] nothing to consider');
      return;
    }

    // ── Per-assessment cache ──────────────────────────────────────
    // Expired attempts cluster hard by assessment — a whole cohort abandoning
    // one exam is the common case — so the paper is loaded once, not once per
    // student. Without this a 500-attempt sweep would re-read every question
    // and answer document 500 times.
    type Paper = {
      /** The LIVE document. Per-attempt contracts are merged onto it below. */
      assessment: GradingAssessmentDoc;
      questionMap: Awaited<ReturnType<typeof loadQuestionAndAnswerMaps>>['questionMap'];
      answerMap: Awaited<ReturnType<typeof loadQuestionAndAnswerMaps>>['answerMap'];
      exposeKeysToStudent: boolean;
    };
    const papers = new Map<string, Paper | null>();

    async function loadPaper(assessmentId: string): Promise<Paper | null> {
      if (papers.has(assessmentId)) return papers.get(assessmentId) ?? null;
      try {
        const aSnap = await db.collection('assessments').doc(assessmentId).get();
        if (!aSnap.exists) { papers.set(assessmentId, null); return null; }
        const assessment = aSnap.data() as GradingAssessmentDoc;
        const sections = normalizeSections(assessment);
        const qIds = Array.from(new Set(
          sections.flatMap((s) => s.questions.map((q) => q.questionId)),
        ));
        const { questionMap, answerMap } = await loadQuestionAndAnswerMaps(db, qIds);
        const paper: Paper = {
          assessment,
          questionMap,
          answerMap,
          exposeKeysToStudent: reviewAudienceAllows(assessment, 'students'),
        };
        papers.set(assessmentId, paper);
        return paper;
      } catch (e) {
        console.error('[closeExpiredAttempts] paper load failed', assessmentId, e);
        papers.set(assessmentId, null);
        return null;
      }
    }

    // ── Per-attempt contract (A-05 / A-06) ────────────────────────
    //
    // `sections` and the resolver's view were cached PER ASSESSMENT, which was
    // right while every attempt of an exam was marked against one live paper.
    // They are per attempt now: each carries the paper and the clocks it was
    // actually given, so two students of the same exam can legitimately differ
    // (a shuffle, or a staff edit between their start times).
    //
    // The question/answer MAPS stay cached per assessment — they are keyed by
    // question id, and re-reading them 500 times is the cost this cache exists
    // to avoid. A frozen paper can name an id the live document no longer
    // lists, so anything missing is topped up once and folded into the same
    // cache. On the common path (no edit since publish) nothing is missing and
    // this reads nothing.
    async function contractFor(paper: Paper, attemptRaw: Record<string, unknown>) {
      const live = paper.assessment as unknown as Record<string, unknown>;
      const contract = examContractFor(attemptRaw, live) ?? live;
      const sections = normalizeSections(contract as GradingAssessmentDoc);
      const missing = Array.from(new Set(
        sections.flatMap((s) => s.questions.map((q) => q.questionId)),
      )).filter((qid) => !paper.questionMap.has(qid));
      if (missing.length > 0) {
        const extra = await loadQuestionAndAnswerMaps(db, missing);
        for (const [k, v] of extra.questionMap) paper.questionMap.set(k, v);
        for (const [k, v] of extra.answerMap) paper.answerMap.set(k, v);
      }
      return { sections, coreAssessment: toCoreAssessment(contract) };
    }

    // ── The frozen branch, asking the RESOLVER (F9) ───────────────
    //
    // This used to gate on attemptWindowClosed(), which despite its name reads
    // `answersLockedAfter` — the SECTION/OVERALL lock, not the availability
    // window. Those are the clocks a freeze is supposed to hold, and a paused
    // attempt necessarily carries a stale one, so the branch fired on exactly
    // the state it was meant to protect: a seven-hour pause was auto-submitted
    // and graded because its pre-freeze section lock had passed.
    //
    // A10 row 1 says the AVAILABILITY WINDOW closing during a freeze finalises
    // the attempt, and nothing else does. resolve() is the one place that
    // knows the difference — it evaluates the window against real time while
    // every other deadline pauses (4.3) — so the sweep asks it rather than
    // approximating it. Placed here, after loadPaper exists, because it needs
    // the paper to answer at all.
    for (const doc of frozenSnap.docs) {
      const d = doc.data() as { assessmentId?: string };
      const paper = d.assessmentId ? await loadPaper(d.assessmentId) : null;
      if (!paper) continue;          // cannot prove the sitting over; leave it
      let endedReason: string | null = null;
      try {
        const verdict = resolveTiming(
          toCoreAttempt(doc.data() as Record<string, unknown>),
          (await contractFor(paper, doc.data() as Record<string, unknown>)).coreAssessment,
          nowMs,
        );
        // ANY 'ended', not only window_closed (widened 2026-08-03). While a
        // freeze is open the resolver pins every student clock at the freeze
        // instant, so 'ended' here means one of exactly two things: the
        // availability window shut in real time (A10 row 1), or the sitting
        // was ALREADY over before the pause began — someone froze an attempt
        // whose overall clock had run out. The second kind was invisible to
        // both sweep queries: status 'frozen' excluded it from query (A), and
        // the window test here excluded it too, so with no endDate it would
        // simply never close. An attempt the resolver calls over is over;
        // which wall ended it does not change that.
        endedReason = verdict.kind === 'ended' ? verdict.reason : null;
      } catch (e) {
        console.warn('[closeExpiredAttempts] frozen verdict failed; leaving open', doc.id, e);
        continue;
      }
      if (endedReason === null || endedReason === 'not_open_yet') continue;

      candidates.push({
        doc,
        reason: `sweep_${endedReason}`,
        // No grant on this path. FREEZE_CREDIT_EXTENDS_WINDOW is false, so
        // credit cannot move the wall that is ending this attempt — handing
        // out time here would be arithmetic that changes nothing, recorded as
        // though it were a decision. The paused time stays unadjudicated,
        // which is the truth: nobody adjudicated it.
        grantFrozenSeconds: 0,
        wasFrozen: true,
      });
    }

    let closed = 0;
    let graded = 0;
    let ungraded = 0;

    // ── Close, GRADING each one (D-04, master plan Phase 1) ───────
    // The sweep used to set status:'auto_submitted' and stop — no scores, no
    // gradedAnswers. The roster then rendered the attempt as complete with no
    // mark, and it stayed that way until somebody noticed and ran a manual
    // regrade. A student whose laptop died was left with a finished, unscored
    // exam. Invariant INV-10: a terminal attempt has both scores and
    // gradedAnswers.
    //
    // Grading uses the SAME primitives as gradeAttempt — normalizeSections,
    // loadQuestionAndAnswerMaps, scoreAttemptAnswers — rather than a private
    // reimplementation, so the sweep and the live path cannot reach different
    // marks for the same answers.
    //
    // A grading failure never blocks the close. An attempt stuck in_progress
    // forever is strictly worse than one closed without a score, and the
    // latter is repairable with regradeAttempts.
    const writes: Array<{ ref: FirebaseFirestore.DocumentReference; data: Record<string, unknown> }> = [];

    let skipped = 0;

    for (const item of candidates) {
      const att = item.doc.data() as {
        assessmentId?: string;
        answers?: Record<string, AttemptAnswerDoc & { answeredAt?: string }>;
        gradingConfig?: AssessmentGradingConfigS;
        updatedAt?: string;
        freezes?: FreezeLedgerEntry[];
      };

      const paperEarly = att.assessmentId ? await loadPaper(att.assessmentId) : null;

      // ── D-24: the sweep must not END what should merely ADVANCE ────
      //
      // This closed anything whose `answersLockedAfter` had passed. That field
      // is min(section, overall), so it fired for a student who had simply run
      // out of SECTION time and should have moved to the next section — which
      // is exactly the bug Phase 0 fixed on the client ("section expiry ends
      // the whole sitting"), still alive here on the server.
      //
      // The sharpest case is a BREAK. The break path never recomputes the
      // lock, so a student waiting out a twenty-minute break still carries the
      // previous section's deadline, already passed. An hourly sweep landing
      // in that window auto-submitted their exam while they sat waiting to
      // continue.
      //
      // The resolver decides now, so the swept path and the live path reach
      // the same conclusion from the same function — which is the whole point
      // of the resolver existing. A verdict of anything other than 'ended'
      // means the student still has somewhere to go, and the sweep leaves them
      // alone.
      //
      // The staleness fallback below is what stops that leaking: an attempt
      // nobody has touched for STALE_ATTEMPT_HOURS is closed regardless,
      // because an exam with no overall limit and no window would otherwise
      // never resolve.
      let closeReason: string = item.reason;
      if (paperEarly && !item.wasFrozen) {
        try {
          const core = toCoreAttempt(att as unknown as Record<string, unknown>);
          const verdict = resolveTiming(
            core,
            (await contractFor(paperEarly, att as unknown as Record<string, unknown>)).coreAssessment,
            nowMs,
          );
          if (verdict.kind !== 'ended') {
            // ── D-30, restored (F8) ─────────────────────────────────
            //
            // STALE_FREEZE_HOURS was commented out for D-30 — "a freeze is
            // owned by a human and does not time out" — and the generic
            // staleness fallback below re-implemented it at the same six
            // hours, from the other side. A paused attempt keeps its stale
            // pre-freeze answersLockedAfter, so query (A) picks it up; the
            // resolver correctly answers "not ended" because the clocks are
            // held; and this branch then closed it anyway as
            // 'abandoned_sweep', grading it with no credit and without even
            // the finalizedWhileFrozen flag.
            //
            // An open pause is the one state where "nobody has touched this"
            // is expected rather than evidence of abandonment. The student
            // cannot touch it — that is what the pause means. The window
            // branch above is still the automatic ending (A10); this one is
            // for attempts nobody is holding.
            const paused = openFreezeStartedMs(core) !== null;
            const touched = att.updatedAt ? Date.parse(att.updatedAt) : NaN;
            const stale = !paused
              && (!Number.isFinite(touched)
                || touched <= nowMs - STALE_ATTEMPT_HOURS * 3_600_000);
            if (!stale) {
              skipped++;
              console.log(`[closeExpiredAttempts] leaving ${item.doc.id} open — ` +
                `verdict=${verdict.kind} (student still has somewhere to go)`);
              continue;
            }
            closeReason = 'abandoned_sweep';
          } else {
            // Carry the resolver's reason so the record says WHY, not just
            // that a deadline somewhere had passed.
            closeReason = `sweep_${verdict.reason}`;
          }
        } catch (e) {
          // A resolver fault must never leave an attempt stuck open. Fall back
          // to the previous behaviour, which errs toward closing.
          console.warn('[closeExpiredAttempts] verdict failed; closing anyway', item.doc.id, e);
        }
      }

      const data: Record<string, unknown> = {
        status: 'auto_submitted',
        submittedAt: nowIso,
        autoSubmitReason: closeReason,
        updatedAt: nowIso,
      };

      if (item.wasFrozen) {
        // Detective flag, matching gradeAttempt's behaviour for the same case.
        data['integrityLog.finalizedWhileFrozen'] = true;
        data.freezeState = { frozen: false, clearedBy: 'sweep', since: nowIso };
        data.resumeRequiresVerification = false;
        if (item.grantFrozenSeconds > 0) {
          data.totalFrozenSeconds = FieldValue.increment(item.grantFrozenSeconds);
        }
        // ── A terminal attempt carries no live freeze state (2026-08-03) ─
        //
        // Same cleanup gradeAttempt does at finalisation, for the same
        // reason: deriveRosterStatus reads frozenAt BEFORE the terminal
        // status, so leaving it behind showed a closed sitting as "frozen"
        // in the roster forever. The ledger entry is CLOSED with a zero
        // grant, not deleted — the pause happened, and the record says so.
        data.frozenAt = FieldValue.delete();
        data.frozenBy = FieldValue.delete();
        data.frozenReason = FieldValue.delete();
        if (Array.isArray(att.freezes) && att.freezes.some((f) => !f.endedAt)) {
          data.freezes = att.freezes.map((f) => {
            if (f.endedAt) return f;
            const startMsF = Date.parse(f.startedAt);
            return {
              ...f,
              endedAt: nowIso,
              elapsedMs: Number.isFinite(startMsF)
                ? Math.max(0, nowMs - startMsF) : 0,
              grantedMs: 0,
              decidedBy: null,
              decidedAt: nowIso,
              note: `closed by sweep (${closeReason})`,
            };
          });
        }
      }

      const paper = paperEarly;
      if (paper) {
        try {
          // A-05: mark against the paper THIS attempt sat.
          const { sections: attemptSections } =
            await contractFor(paper, att as unknown as Record<string, unknown>);
          const { scores, gradedAnswers } = scoreAttemptAnswers({
            sections: attemptSections,
            questionMap: paper.questionMap,
            answerMap: paper.answerMap,
            codeVerdicts: await loadCodeVerdicts(db, item.doc.id, paper.questionMap),
            // A sweep-closed attempt has normally never been marked by hand,
            // but "normally" is not a guarantee: an attempt can be reopened,
            // and the sweep must never be the path that quietly drops a mark.
            manualMarks: await loadManualMarks(db, item.doc.id, paper.questionMap),
            answers: att.answers,
            passingScore: paper.assessment.passingScore,
            exposeKeysToStudent: paper.exposeKeysToStudent,
            // Frozen policy first, live assessment as the legacy fallback —
            // identical precedence to gradeAttempt.
            gradingConfig: att.gradingConfig ?? paper.assessment.gradingConfig,
          });
          data.scores = scores;
          data.gradedAnswers = gradedAnswers;
          graded++;
        } catch (e) {
          console.error('[closeExpiredAttempts] grading failed', item.doc.id, e);
          data.gradeError = 'sweep_grading_failed';
          ungraded++;
        }
      } else {
        data.gradeError = 'assessment_unavailable';
        ungraded++;
      }

      writes.push({ ref: item.doc.ref, data });
    }

    // Chunked to stay under the 500-write batch ceiling.
    for (let i = 0; i < writes.length; i += 400) {
      const batch = db.batch();
      for (const w of writes.slice(i, i + 400)) {
        batch.update(w.ref, w.data);
        closed++;
      }
      await batch.commit();
    }

    console.log(
      `[closeExpiredAttempts] closed ${closed} (graded ${graded}, ungraded ${ungraded}),`
      + ` left open ${skipped}; expired=${expiredSnap.size} frozenScanned=${frozenSnap.size}`,
    );
  },
);

export const scheduledPurge = onSchedule(
  { schedule: 'every day 03:00', timeZone: 'Etc/UTC', region: 'us-central1' },
  async () => {
    const db = getFirestore();
    const now = new Date();
    const live = await isPurgeEnabled(db);

    console.log(`[scheduledPurge] start — mode=${live ? 'LIVE' : 'DRY RUN'}`);

    let examined = 0;
    let purged = 0;
    const skipped: string[] = [];

    for (const role of AUTO_PURGEABLE_ROLES) {
      const col = COLLECTION_BY_ROLE[role];
      let snap;
      try {
        snap = await db.collection(col)
          .where('lifecycleState', '==', 'softDeleted')
          .limit(PURGE_BATCH_LIMIT)
          .get();
      } catch (err) {
        console.error(`[scheduledPurge] query failed for ${col}`, err);
        continue;
      }

      for (const doc of snap.docs) {
        examined++;
        const data = doc.data() as Record<string, unknown>;

        if (!isDueForPurge(data, now)) {
          skipped.push(`${role}/${doc.id} (not due)`);
          continue;
        }
        if (purged >= PURGE_BATCH_LIMIT) {
          console.warn('[scheduledPurge] batch limit reached — remainder deferred to next run');
          break;
        }

        const label = (data.name as string) || (data.email as string) || null;

        if (!live) {
          console.log(`[scheduledPurge] WOULD PURGE ${role}/${doc.id} (${label ?? 'unnamed'}) — purgeAfter ${data.purgeAfter}`);
          purged++;
          continue;
        }

        try {
          await performAccountDeletion(db, {
            role,
            uid: doc.id,
            profileRef: doc.ref,
            auditLabel: label,
            auditFromState: 'softDeleted',
            targetInstituteId: (data.instituteId as string) ?? null,
            actorUid: 'system:scheduledPurge',
            actorRole: 'system',
            reason: 'Retention window expired',
            successorId: (data.pendingSuccessorId as string | null) ?? null,
          });
          purged++;
          console.log(`[scheduledPurge] purged ${role}/${doc.id}`);
        } catch (err) {
          console.error(`[scheduledPurge] FAILED on ${role}/${doc.id}`, err);
        }
      }
    }

    // Institutes are reported, never acted on — a human decides.
    try {
      const instSnap = await db.collection('institutes')
        .where('lifecycleState', '==', 'softDeleted')
        .limit(PURGE_BATCH_LIMIT)
        .get();
      for (const d of instSnap.docs) {
        if (isDueForPurge(d.data() as Record<string, unknown>, now)) {
          console.warn(`[scheduledPurge] institute ${d.id} is past its retention window — awaiting manual purge (never automatic)`);
        }
      }
    } catch (err) {
      console.error('[scheduledPurge] institute survey failed', err);
    }

    console.log(`[scheduledPurge] done — examined=${examined} ${live ? 'purged' : 'would purge'}=${purged} skipped=${skipped.length}`);
    if (skipped.length) console.log('[scheduledPurge] skipped:', skipped.join(', '));
  },
);

/**
 * Perform an account deletion. THE ONE PLACE THIS HAPPENS.
 *
 * Extracted in Phase 4 so that a deletion executed by an APPROVER
 * (resolveDeletionRequest) and one executed DIRECTLY (deleteAuthUser) run
 * byte-identical logic. Duplicating a destructive path is how two paths
 * silently diverge — one gains a cascade fix or an audit field the other
 * never gets.
 *
 * Assumes authorization has ALREADY been decided by the caller. This function
 * enforces nothing; it only executes.
 *
 * `requestId` is set when the deletion came from an approved request, so the
 * audit row links back to it and the trail reads as one story.
 */
async function performAccountDeletion(
  db: FirebaseFirestore.Firestore,
  params: {
    role: Role;
    uid: string;
    profileRef: FirebaseFirestore.DocumentReference;
    auditLabel: string | null;
    auditFromState: LifecycleStateS;
    targetInstituteId: string | null;
    actorUid: string;
    actorRole: string;
    requestId?: string | null;
    reason?: string | null;
    /** Faculty only — successor chosen by the admin, validated at execution. */
    successorId?: string | null;
    /** Institute only — what the cascade actually removed, for the audit row. */
    impact?: Record<string, number> | null;
  },
): Promise<void> {
  const { role, uid, profileRef } = params;

  // ── Succession BEFORE destruction (Feature #15, Phase 5a) ────────
  // Runs first, deliberately. If the profile were deleted first and the
  // reassignment then failed, the content would be orphaned with no owner
  // and no way to work out who it belonged to.
  let succession: SuccessionOutcomeS | null = null;
  if (role === 'faculty' && params.targetInstituteId) {
    succession = await performFacultySuccession(
      db, uid, params.targetInstituteId, params.successorId,
    );
  }

  try {
    await getAuth().deleteUser(uid);
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code !== 'auth/user-not-found') {
      console.error('Failed to delete auth user', uid, err);
      throw new HttpsError('internal', 'Failed to delete auth user.', code);
    }
  }

  await profileRef.delete();
  const credCol = CREDENTIALS_BY_ROLE[role];
  if (credCol) await db.collection(credCol).doc(uid).delete().catch(() => undefined);
  if (role === 'institute') {
    await db.collection('instituteLogos').doc(uid).delete().catch(() => undefined);
  }
  // Cascade: academic-hierarchy mappings for a deleted student are pure
  // orphans — remove them so node rosters don't render ghosts. Attempts and
  // questionReports are DELIBERATELY kept: they are the institute's exam
  // records / audit trail.
  //
  // STUDENTS ONLY, AND THAT IS CORRECT. The original spec listed "no faculty
  // mapping cleanup" as a bug (d), and Phase 5a duly added a facultyId query
  // here — but AcademicMapping has no facultyId field. It carries studentId /
  // studentName / studentEmail and is student-only by design ("a student can
  // have many mappings"), so faculty never had mappings to leak. That query
  // matched nothing on every faculty deletion. Removed rather than left in:
  // dead code that looks like a safety net is worse than no safety net.
  if (role === 'student') {
    const mapField = 'studentId';
    try {
      const mapSnap = await db.collection('academicMappings')
        .where(mapField, '==', uid).get();
      let batch = db.batch();
      let n = 0;
      for (const d of mapSnap.docs) {
        batch.delete(d.ref);
        if (++n >= 400) { await batch.commit(); batch = db.batch(); n = 0; }
      }
      if (n > 0) await batch.commit();
    } catch (err) {
      console.error('performAccountDeletion: mapping cascade failed for', uid, err);
    }
  }

  // Lifecycle audit. Still a HARD delete — Phase 6 routes accounts through
  // soft-delete + retention. What Phase 1 changed is that the action stopped
  // being invisible.
  //
  // Written LAST, deliberately. The row asserts the deletion happened, so it
  // must not precede it. writeAuditRow never throws, so a logging failure
  // cannot roll back a completed removal — it logs loudly instead.
  await writeAuditRow(db, {
    action: 'purge',
    entityType: role,
    entityId: uid,
    entityLabel: params.auditLabel,
    fromState: params.auditFromState,
    toState: 'purged',
    actorUid: params.actorUid,
    actorRole: params.actorRole,
    instituteId: params.targetInstituteId,
    requestId: params.requestId ?? null,
    reason: params.reason ?? null,
    impact: params.impact ?? null,
    succession: succession
      ? {
          fromOwnerType: 'faculty',
          fromOwnerId: uid,
          toOwnerType: succession.toOwnerType,
          toOwnerId: succession.toOwnerId,
          reason: succession.reason,
          counts: succession.counts,
        }
      : null,
  });
}

export const deleteAuthUser = onCall<DeleteAuthUserData>(
  CALLABLE_BASE,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const callerRole = request.auth.token.role as Role | undefined;
    const callerInstituteId = request.auth.token.instituteId as string | undefined;

    // NOTE (found by enabling noUnusedLocals, 2026-08-03): the payload also
    // carries `deleteAttemptsOnWebOwnerAssessments`, and purgeStudentData
    // accepts an option of that name — but this callable destructured it and
    // never forwarded it, so the option has never had any effect. Left
    // unforwarded here deliberately: wiring it up CHANGES WHAT GETS DELETED,
    // which is not a decision a timer audit should make on the way past. It
    // needs its own change, with its own review.
    const { role, uid, successorId, confirmLiveOwnership } =
      request.data || ({} as DeleteAuthUserData);
    if (!role || !COLLECTION_BY_ROLE[role]) throw new HttpsError('invalid-argument', 'Invalid role.');
    if (!uid) throw new HttpsError('invalid-argument', 'uid is required.');

    const db = getFirestore();
    const profileRef = db.collection(COLLECTION_BY_ROLE[role]).doc(uid);
    const profileSnap = await profileRef.get();
    if (!profileSnap.exists) {
      throw new HttpsError('not-found', 'Profile document not found.');
    }
    const profile = profileSnap.data() as Record<string, unknown>;
    const targetInstituteId =
      role === 'institute' ? uid : (profile.instituteId as string | undefined);

    // Captured BEFORE the delete — after it, the document is gone and these
    // are unrecoverable. The label is what keeps the audit trail legible once
    // the target no longer exists to look up.
    const auditLabel =
      (profile.name as string) || (profile.email as string) || null;
    const auditFromState: LifecycleStateS =
      (profile.lifecycleState as LifecycleStateS) ??
      (profile.isDeleted === true ? 'softDeleted' : 'active');

    if (callerRole !== 'webOwner') {
      if (callerRole === 'institute') {
        if (role !== 'faculty' && role !== 'student') {
          throw new HttpsError('permission-denied', 'Institute admins may only delete faculty or students.');
        }
        if (!callerInstituteId || callerInstituteId !== targetInstituteId) {
          throw new HttpsError('permission-denied', 'instituteId must match caller.');
        }
      } else if (callerRole === 'faculty') {
        if (role !== 'student') {
          throw new HttpsError('permission-denied', 'Faculty may only delete students.');
        }
        if (!callerInstituteId || callerInstituteId !== targetInstituteId) {
          throw new HttpsError('permission-denied', 'instituteId must match caller.');
        }
      } else {
        throw new HttpsError('permission-denied', 'Insufficient permissions.');
      }

      // ── Deletion-rights gate (Feature #15, Phase 3) ────────────────
      // The role checks above establish WHO may act on WHOM. This
      // establishes whether they hold the RIGHT to do so at all — the
      // check that did not exist before, and the closure of bug (f).
      //
      // Runs for institute and faculty callers only; the Web Owner short-
      // circuits above. Reads the ceiling from the tenant's institute doc
      // and, for faculty, the grant from their own profile.
      const ceilingSnap = await db.collection('institutes').doc(callerInstituteId).get();
      // C1: a disabled or expired tenant deletes nothing. Free here — the
      // document is already in hand for the ceiling read below.
      assertInstituteActiveS(ceilingSnap);
      const ceiling = ceilingSnap.exists
        ? (ceilingSnap.get('deletionRightsCeiling') as DeletionCeilingS | undefined)
        : undefined;

      let facultyRights: FacultyDeletionRightsS | undefined;
      if (callerRole === 'faculty') {
        const callerSnap = await db.collection('faculty').doc(request.auth.uid).get();
        facultyRights = callerSnap.exists
          ? (callerSnap.get('deletionRights') as FacultyDeletionRightsS | undefined)
          : undefined;
      }

      const resource = role as DeletableResourceS;
      const mode = resolveDeletionModeS(callerRole, resource, ceiling, facultyRights);

      if (mode === 'request') {
        // Held, but not directly exercisable. The client calls
        // submitDeletionRequest instead; this is a distinct error CODE so the
        // UI can branch on it rather than parsing prose.
        throw new HttpsError(
          'failed-precondition',
          'DELETION_REQUIRES_APPROVAL',
        );
      }
      if (mode !== 'direct') {
        throw new HttpsError(
          'permission-denied',
          callerRole === 'faculty'
            ? 'You have not been granted permission to delete this. Ask your institute administrator.'
            : 'This institute has not been granted permission to delete this. Ask the Web Owner.',
        );
      }
    }

    // ── Live-exam guard (Feature #15, Phase 5a) ────────────────────
    // Succession makes most faculty deletion safe, but not this case: an
    // ACTIVE assessment may have students mid-attempt, and changing its owner
    // during a sitting is a variable nobody wants in an exam-integrity story.
    // Surfaced as a distinct code so the UI can offer reassignment rather
    // than showing a dead end.
    if (role === 'faculty' && !confirmLiveOwnership) {
      const live = await countLiveOwnedAssessments(db, uid);
      if (live > 0) {
        throw new HttpsError(
          'failed-precondition',
          `FACULTY_OWNS_LIVE_ASSESSMENTS:${live}`,
        );
      }
    }

    // ── SOFT delete (Feature #15, Phase 6a) ────────────────────────
    // This path no longer destroys anything. The record enters the
    // recoverable state and the Auth user is disabled; the cascade and the
    // actual removal moved to purgeEntity, where they belong. Closes bug (b).
    //
    // NOTE ON SUCCESSION: ownership transfer deliberately does NOT run here.
    // Soft delete is reversible, so moving a departing faculty member's
    // content now would mean a restore left their questions belonging to
    // someone else. Succession runs at PURGE, when the departure is final —
    // which is exactly what the locked design says.
    await performAccountSoftDelete(db, {
      role,
      uid,
      profileRef,
      auditLabel,
      auditFromState,
      targetInstituteId: targetInstituteId ?? null,
      actorUid: actorFrom(request).actorUid,
      actorRole: actorFrom(request).actorRole,
      pendingSuccessorId: successorId ?? null,
    });

    return { ok: true };
  }
);

// ═══════════════════════════════════════════════════════════════════
// ENTITY LIFECYCLE — audit writer + hierarchy unarchive
// (Feature #15, Phase 0b)
//
// This section adds the SERVER half of the lifecycle foundation. It is
// deliberately inert with respect to existing behaviour: writeAuditRow is a
// helper nothing calls yet (Phase 1 wires it into the existing delete paths),
// and setHierarchyNodeLifecycle closes a real pre-existing gap — archived
// hierarchy nodes had no unarchive path at all, making archive a one-way door.
//
// WHY THE AUDIT WRITER LIVES SERVER-SIDE
// firestore.rules denies every client write to deletionAudit, including the
// Web Owner's. Two reasons: a client-writable trail can be forged, and a trail
// written by a separate call from the action it records can silently go
// missing when that second call fails — exactly the case the trail exists to
// cover. So rows are written here, and Phase 1 onward writes them inside the
// same operation as the transition they describe.
// ═══════════════════════════════════════════════════════════════════

type LifecycleStateS = 'active' | 'archived' | 'softDeleted' | 'purged';

type AuditActionS =
  | 'archive'
  | 'softDelete'
  | 'restore'
  | 'purge'
  | 'requestSubmitted'
  | 'requestApproved'
  | 'requestRejected'
  | 'erasure'
  // Phase 4: a freeze takes time away from a student and a grant gives it
  // back. Both are authority decisions about someone's exam, so both leave a
  // record — the same standard already applied to deletion.
  | 'attemptFrozen'
  | 'attemptUnfrozen'
  // Phase 4.4: a provisional grade is a staff action on a live sitting, and
  // it is visible to staff before the student's exam is over. Same standard.
  | 'attemptGradedProvisional'
  | 'attemptRewritten'
  // Re-arming a coding submission the platform gave up on. An authority
  // decision that can change a student's mark, so it leaves a record for the
  // same reason a freeze does.
  | 'attemptCodingRejudged';

type SuccessionS = {
  fromOwnerType: 'webOwner' | 'institute' | 'faculty';
  fromOwnerId: string;
  toOwnerType: 'webOwner' | 'institute' | 'faculty';
  toOwnerId: string;
  reason: 'chosen' | 'defaulted' | 'fallback';
  counts?: Record<string, number> | null;
};

type AuditRowInput = {
  action: AuditActionS;
  entityType: string;
  entityId: string;
  entityLabel?: string | null;
  fromState?: LifecycleStateS | null;
  toState?: LifecycleStateS | null;
  actorUid: string;
  actorRole: string;
  actorName?: string | null;
  instituteId?: string | null;
  reason?: string | null;
  requestId?: string | null;
  impact?: Record<string, number> | null;
  succession?: SuccessionS | null;
};

/**
 * Server twin of buildAuditRow in src/lib/deletionAudit.ts.
 * KEEP IN SYNC — the client reads these rows and expects this exact shape.
 *
 * Every optional field is written as an explicit null rather than being
 * omitted: Firestore drops undefined, which would make "no reason given"
 * indistinguishable from "this build predates the reason field".
 */
function buildAuditRowS(input: AuditRowInput): Record<string, unknown> {
  return {
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    entityLabel: input.entityLabel ?? null,
    fromState: input.fromState ?? null,
    toState: input.toState ?? null,
    actorUid: input.actorUid,
    actorRole: input.actorRole,
    actorName: input.actorName ?? null,
    instituteId: input.instituteId ?? null,
    reason: input.reason ?? null,
    requestId: input.requestId ?? null,
    impact: input.impact ?? null,
    succession: input.succession ?? null,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Append one audit row.
 *
 * Pass `txn` when the caller is already inside a transaction or batch so the
 * row and the state change commit together — that atomicity is the whole
 * point, and Phase 1 onward must use it. The standalone form exists for
 * callers with nothing to bind to.
 *
 * NEVER THROWS. A failure to record an action must not roll back the action
 * itself when the caller is not transactional: losing the row is bad, but
 * leaving a half-completed deletion is worse. Failures are logged loudly so
 * they surface in Cloud Logging rather than vanishing.
 */
async function writeAuditRow(
  db: FirebaseFirestore.Firestore,
  input: AuditRowInput,
  txn?: FirebaseFirestore.Transaction | FirebaseFirestore.WriteBatch,
): Promise<void> {
  try {
    const ref = db.collection('deletionAudit').doc();
    const row = buildAuditRowS(input);
    if (!txn) {
      await ref.set(row);
      return;
    }
    // Transaction.set and WriteBatch.set have structurally different overload
    // sets, so TypeScript refuses to call the union directly. Both accept
    // (ref, data) identically at runtime; narrow explicitly rather than
    // casting the whole union away, so a genuinely wrong third argument
    // would still be caught.
    if (txn instanceof Object && 'commit' in txn && !('get' in txn)) {
      (txn as FirebaseFirestore.WriteBatch).set(ref, row);
    } else {
      (txn as FirebaseFirestore.Transaction).set(ref, row);
    }
  } catch (err) {
    console.error(
      'writeAuditRow FAILED',
      input.action,
      input.entityType,
      input.entityId,
      err,
    );
  }
}

/** Actor identity for an audit row, pulled from the callable's auth context. */
function actorFrom(request: {
  auth?: { uid?: string; token?: Record<string, unknown> } | null;
}): {
  actorUid: string;
  actorRole: string;
  instituteId: string | null;
  facultyId: string | null;
} {
  const token = (request.auth?.token ?? {}) as Record<string, unknown>;
  return {
    actorUid: request.auth?.uid ?? 'unknown',
    actorRole: (token.role as string) ?? 'unknown',
    instituteId: (token.instituteId as string) ?? null,
    // Additive (audit F-4). NOT interchangeable with actorUid: firestore.rules
    // records that migrated faculty carry claim.facultyId == the LEGACY doc id
    // while newer ones carry the uid, so a per-faculty grant keyed on the uid
    // would silently miss every pre-migration account — denying a right they
    // hold, which reads as a permissions bug rather than the id mismatch it is.
    facultyId: (token.facultyId as string) ?? null,
  };
}

// ── Hierarchy node lifecycle ──────────────────────────────────────
// Closes a real gap found during the Feature #15 baseline read: the nine
// academic-hierarchy collections have archiveNode() (status -> 'archived')
// but NO unarchive path anywhere in the codebase, so archiving a school or
// program was irreversible through the UI.
//
// Kept as a callable rather than a client write because it must produce an
// audit row, and clients cannot write deletionAudit.

const HIERARCHY_COLLECTIONS = [
  'schools',
  'academicLevels',
  'programs',
  'academicSessions',
  'academicYears',
  'semesters',
  'courses',
  'sections',
  'groups',
] as const;

type HierarchyCollection = (typeof HIERARCHY_COLLECTIONS)[number];

export const setHierarchyNodeLifecycle = onCall<{
  collection: HierarchyCollection;
  nodeId: string;
  action: 'archive' | 'restore';
  reason?: string;
}>(CALLABLE_BASE, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const { collection, nodeId, action, reason } = request.data || ({} as never);

  if (!collection || !HIERARCHY_COLLECTIONS.includes(collection)) {
    throw new HttpsError('invalid-argument', 'Unknown hierarchy collection.');
  }
  if (!nodeId) throw new HttpsError('invalid-argument', 'nodeId is required.');
  if (action !== 'archive' && action !== 'restore') {
    throw new HttpsError('invalid-argument', 'action must be archive or restore.');
  }

  const db = getFirestore();
  const ref = db.collection(collection).doc(nodeId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Node not found.');

  const data = snap.data() as Record<string, unknown>;
  const nodeInstituteId = (data.instituteId as string) ?? null;

  // ── Authorisation ────────────────────────────────────────────────
  //
  // This used to read "Faculty are excluded — hierarchy shape is an admin
  // concern, and Feature #15 does not widen it." That was a coherent policy
  // and it was not the product's. SchoolsTab renders on FacultyLandingPage
  // behind a `canManage` gate, so archiving hierarchy nodes is a shipped,
  // permission-gated faculty capability; the callable refusing them is why
  // nothing ever called it and why every archive in production has been going
  // through a direct Firestore write with no audit row (audit F-4).
  //
  // The gate is now the SAME ONE THE UI USES, which is a two-tier grant and
  // not a role check:
  //   webOwner  → always.
  //   institute → own tenant, AND institutes/{id}.schoolsManagementEnabled.
  //   faculty   → own tenant, AND *both* that institute flag and their own
  //               faculty/{id}.schoolsManagementEnabled.
  // FacultyLandingPage computes exactly this as `instituteSME && facultySME`,
  // and InstituteLandingPage as `session.schoolsManagementEnabled` — see the
  // permission effect in each.
  //
  // Checking the flags here is a TIGHTENING as well as a widening, and the
  // tightening is the more important half. `canWriteAcademic` in
  // firestore.rules gates on role and tenant only; it has never known about
  // schoolsManagementEnabled. So the schools permission was decorative for
  // anyone willing to open DevTools — revoking it hid the buttons and stopped
  // nothing. Same shape as the question-rights gap closed in S-02, same
  // remedy: put the real check in a callable and make the callable the only
  // way in (see the hierarchy lifecycle guard in firestore.rules).
  const actor = actorFrom(request);
  if (actor.actorRole !== 'webOwner') {
    const role = actor.actorRole;
    if ((role !== 'institute' && role !== 'faculty')
        || !actor.instituteId
        || !nodeInstituteId
        || actor.instituteId !== nodeInstituteId) {
      throw new HttpsError('permission-denied', 'Not permitted for this node.');
    }

    // Institute-level switch. Absent reads as false — the UI's `?? false`, so
    // an institute that never enabled the feature cannot reach it by any door.
    const instSnap = await db.collection('institutes').doc(actor.instituteId).get();
    if (instSnap.get('schoolsManagementEnabled') !== true) {
      throw new HttpsError(
        'permission-denied',
        'School management is not enabled for this institute.',
      );
    }

    // Second tier, faculty only. Keyed by facultyId from the CLAIM, never from
    // the payload — actorFrom reads the token, so a faculty member cannot
    // present someone else's grant.
    if (role === 'faculty') {
      if (!actor.facultyId) {
        throw new HttpsError('permission-denied', 'Not permitted for this node.');
      }
      const facSnap = await db.collection('faculty').doc(actor.facultyId).get();
      if (facSnap.get('schoolsManagementEnabled') !== true) {
        throw new HttpsError(
          'permission-denied',
          'You have not been granted school management for this institute.',
        );
      }
    }
  }

  const currentStatus = (data.status as string) ?? 'active';
  const fromState: LifecycleStateS = currentStatus === 'archived' ? 'archived' : 'active';
  const toState: LifecycleStateS = action === 'archive' ? 'archived' : 'active';

  // Reject no-op transitions rather than writing a misleading audit row that
  // claims a change occurred. Matches canTransition() in the client module.
  if (fromState === toState) {
    throw new HttpsError(
      'failed-precondition',
      action === 'archive' ? 'Node is already archived.' : 'Node is already active.',
    );
  }

  const nowIso = new Date().toISOString();

  // Legacy `status` stays authoritative (Option 2 — derive, do not migrate);
  // the lifecycleState envelope is written ALONGSIDE it so new readers get
  // the unified vocabulary and old readers keep working untouched.
  const batch = db.batch();
  batch.update(ref, {
    status: toState === 'archived' ? 'archived' : 'active',
    lifecycleState: toState,
    archivedAt: toState === 'archived' ? nowIso : null,
    archivedBy: toState === 'archived' ? actor.actorUid : null,
    archivedByRole: toState === 'archived' ? actor.actorRole : null,
    lifecycleReason: reason ?? null,
    updatedAt: nowIso,
  });

  await writeAuditRow(db, {
    action: action === 'archive' ? 'archive' : 'restore',
    entityType: 'hierarchyNode',
    entityId: nodeId,
    entityLabel: (data.name as string) ?? null,
    fromState,
    toState,
    actorUid: actor.actorUid,
    actorRole: actor.actorRole,
    instituteId: nodeInstituteId,
    reason: reason ?? null,
  }, batch);

  await batch.commit();

  return { ok: true as const, fromState, toState };
});

// ═══════════════════════════════════════════════════════════════════
// DELETION REQUESTS — the approval workflow (Feature #15, Phase 4)
//
// TWO HOPS, ONE MECHANISM
//   faculty  (mode 'request') → institute admin approves
//   institute(selfMode 'request') → Web Owner approves
// Same collection, same callables, same inbox component — the approver is
// derived from the requester's role, never passed in by the client.
//
// THE APPROVER'S RIGHTS DECIDE, AND THEY ARE CHECKED AT EXECUTION TIME.
// Not the requester's, and not at submission time. A request can sit in an
// inbox for days: the ceiling may narrow, the approver may lose the right,
// the target may already be gone. So resolveDeletionRequest re-resolves
// everything from scratch before it executes. This mirrors how
// resolveQuestionRequest already works.
// ═══════════════════════════════════════════════════════════════════

type DeletionRequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

/** Who must approve a request raised by this role? */
function approverRoleFor(requesterRole: string): 'institute' | 'webOwner' | null {
  if (requesterRole === 'faculty') return 'institute';
  if (requesterRole === 'institute') return 'webOwner';
  return null;   // webOwner answers to nobody
}

export const submitDeletionRequest = onCall<{
  entityType: 'student' | 'faculty';
  entityId: string;
  reason?: string;
}>(CALLABLE_BASE, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const { entityType, entityId, reason } = request.data || ({} as never);
  if (entityType !== 'student' && entityType !== 'faculty') {
    throw new HttpsError('invalid-argument', 'Unsupported entityType.');
  }
  if (!entityId) throw new HttpsError('invalid-argument', 'entityId is required.');

  const db = getFirestore();
  const actor = actorFrom(request);
  const approver = approverRoleFor(actor.actorRole);
  if (!approver) {
    throw new HttpsError('failed-precondition', 'The Web Owner does not raise requests.');
  }
  if (!actor.instituteId) {
    throw new HttpsError('permission-denied', 'Missing tenant claim.');
  }

  // The target must exist and be inside the requester's tenant. Checked here
  // so an impossible request never reaches an approver's inbox.
  const targetRef = db.collection(entityType === 'student' ? 'students' : 'faculty').doc(entityId);
  const targetSnap = await targetRef.get();
  if (!targetSnap.exists) throw new HttpsError('not-found', 'Target not found.');
  const targetInstituteId = targetSnap.get('instituteId') as string | undefined;
  if (targetInstituteId !== actor.instituteId) {
    throw new HttpsError('permission-denied', 'Different institute.');
  }

  // Faculty may only request student deletion — the same role boundary
  // deleteAuthUser enforces. A request must never be a way around it.
  if (actor.actorRole === 'faculty' && entityType !== 'student') {
    throw new HttpsError('permission-denied', 'Faculty may only request student deletion.');
  }

  // The requester must actually HOLD the right in request mode. Without this,
  // anyone could flood an inbox with requests for rights they were never
  // granted, and an approving admin would have no way to tell.
  const instSnap = await db.collection('institutes').doc(actor.instituteId).get();
  // C1: a disabled or expired tenant raises no requests either.
  assertInstituteActiveS(instSnap);
  const ceiling = instSnap.exists
    ? (instSnap.get('deletionRightsCeiling') as DeletionCeilingS | undefined)
    : undefined;

  let facultyRights: FacultyDeletionRightsS | undefined;
  if (actor.actorRole === 'faculty') {
    const meSnap = await db.collection('faculty').doc(request.auth.uid).get();
    facultyRights = meSnap.exists
      ? (meSnap.get('deletionRights') as FacultyDeletionRightsS | undefined)
      : undefined;
  }

  const mode = resolveDeletionModeS(
    actor.actorRole, entityType as DeletableResourceS, ceiling, facultyRights,
  );
  if (mode !== 'request') {
    throw new HttpsError(
      'failed-precondition',
      mode === 'direct'
        ? 'You can perform this deletion directly — no request needed.'
        : 'You have not been granted this right, so it cannot be requested.',
    );
  }

  // One pending request per target. Without this a faculty member can submit
  // the same deletion twenty times and the approver sees twenty rows for one
  // decision.
  const dupe = await db.collection('deletionRequests')
    .where('entityId', '==', entityId)
    .where('status', '==', 'pending')
    .limit(1)
    .get();
  if (!dupe.empty) {
    throw new HttpsError('already-exists', 'A pending request for this already exists.');
  }

  const nowIso = new Date().toISOString();
  const ref = db.collection('deletionRequests').doc();
  await ref.set({
    id: ref.id,
    status: 'pending' as DeletionRequestStatus,
    entityType,
    entityId,
    // Captured at submission so the inbox reads legibly even if the target is
    // renamed — or removed by some other path — before anyone looks.
    entityLabel: (targetSnap.get('name') as string) || (targetSnap.get('email') as string) || null,
    requesterUid: request.auth.uid,
    requesterRole: actor.actorRole,
    requesterName: null,
    approverRole: approver,
    instituteId: actor.instituteId,
    reason: reason ?? null,
    reviewedBy: null,
    reviewedAt: null,
    reviewNote: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  await writeAuditRow(db, {
    action: 'requestSubmitted',
    entityType,
    entityId,
    entityLabel: (targetSnap.get('name') as string) ?? null,
    actorUid: actor.actorUid,
    actorRole: actor.actorRole,
    instituteId: actor.instituteId,
    reason: reason ?? null,
    requestId: ref.id,
  });

  return { ok: true as const, id: ref.id };
});

export const resolveDeletionRequest = onCall<{
  requestId: string;
  decision: 'approve' | 'reject';
  reviewNote?: string;
}>(CALLABLE_BASE, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const { requestId, decision, reviewNote } = request.data || ({} as never);
  if (!requestId) throw new HttpsError('invalid-argument', 'requestId is required.');
  if (decision !== 'approve' && decision !== 'reject') {
    throw new HttpsError('invalid-argument', 'decision must be approve or reject.');
  }

  const db = getFirestore();
  const actor = actorFrom(request);

  const reqRef = db.collection('deletionRequests').doc(requestId);
  const reqSnap = await reqRef.get();
  if (!reqSnap.exists) throw new HttpsError('not-found', 'Request not found.');
  const req = reqSnap.data() as Record<string, unknown>;

  if (req.status !== 'pending') {
    throw new HttpsError('failed-precondition', 'This request has already been resolved.');
  }

  // Only the designated approver may resolve, and only inside the right
  // tenant. approverRole was written at submission from the requester's role,
  // so a client cannot choose its own approver.
  const approverRole = req.approverRole as string;
  if (actor.actorRole !== approverRole) {
    throw new HttpsError('permission-denied', 'You are not the approver for this request.');
  }
  if (approverRole === 'institute'
      && (!actor.instituteId || actor.instituteId !== req.instituteId)) {
    throw new HttpsError('permission-denied', 'Different institute.');
  }

  const nowIso = new Date().toISOString();
  const entityType = req.entityType as 'student' | 'faculty';
  const entityId = req.entityId as string;

  if (decision === 'reject') {
    await reqRef.update({
      status: 'rejected' as DeletionRequestStatus,
      reviewedBy: actor.actorUid,
      reviewedAt: nowIso,
      reviewNote: reviewNote ?? null,
      updatedAt: nowIso,
    });
    await writeAuditRow(db, {
      action: 'requestRejected',
      entityType,
      entityId,
      entityLabel: (req.entityLabel as string) ?? null,
      actorUid: actor.actorUid,
      actorRole: actor.actorRole,
      instituteId: (req.instituteId as string) ?? null,
      reason: reviewNote ?? null,
      requestId,
    });
    return { ok: true as const, status: 'rejected' as const };
  }

  // ── APPROVE: re-check everything, then execute ──────────────────
  // The APPROVER's rights are what matter, resolved NOW. A request may have
  // sat here for days while the ceiling narrowed or the approver's own rights
  // changed. Nothing about the submission is trusted.
  if (actor.actorRole !== 'webOwner') {
    if (!actor.instituteId) throw new HttpsError('permission-denied', 'Missing tenant claim.');
    const instSnap = await db.collection('institutes').doc(actor.instituteId).get();
    // C1: the approver's tenant must still be live. A request may have sat
    // pending while the institute was switched off underneath it.
    assertInstituteActiveS(instSnap);
    const ceiling = instSnap.exists
      ? (instSnap.get('deletionRightsCeiling') as DeletionCeilingS | undefined)
      : undefined;
    const approverMode = resolveDeletionModeS(
      actor.actorRole, entityType as DeletableResourceS, ceiling, undefined,
    );
    if (approverMode !== 'direct') {
      throw new HttpsError(
        'permission-denied',
        'You can no longer perform this deletion yourself, so it cannot be approved.',
      );
    }
  }

  // The target may have been removed by another path while this sat pending.
  const targetRef = db.collection(entityType === 'student' ? 'students' : 'faculty').doc(entityId);
  const targetSnap = await targetRef.get();
  if (!targetSnap.exists) {
    await reqRef.update({
      status: 'cancelled' as DeletionRequestStatus,
      reviewedBy: actor.actorUid,
      reviewedAt: nowIso,
      reviewNote: 'Target no longer exists.',
      updatedAt: nowIso,
    });
    throw new HttpsError('not-found', 'The target no longer exists; the request was cancelled.');
  }

  const profile = targetSnap.data() as Record<string, unknown>;
  const auditFromState: LifecycleStateS =
    (profile.lifecycleState as LifecycleStateS) ??
    (profile.isDeleted === true ? 'softDeleted' : 'active');

  await performAccountDeletion(db, {
    role: entityType as Role,
    uid: entityId,
    profileRef: targetRef,
    auditLabel: (profile.name as string) || (profile.email as string) || null,
    auditFromState,
    targetInstituteId: (profile.instituteId as string) ?? null,
    actorUid: actor.actorUid,
    actorRole: actor.actorRole,
    requestId,
    reason: reviewNote ?? (req.reason as string) ?? null,
  });

  await reqRef.update({
    status: 'approved' as DeletionRequestStatus,
    reviewedBy: actor.actorUid,
    reviewedAt: nowIso,
    reviewNote: reviewNote ?? null,
    updatedAt: nowIso,
  });

  await writeAuditRow(db, {
    action: 'requestApproved',
    entityType,
    entityId,
    entityLabel: (req.entityLabel as string) ?? null,
    actorUid: actor.actorUid,
    actorRole: actor.actorRole,
    instituteId: (req.instituteId as string) ?? null,
    reason: reviewNote ?? null,
    requestId,
  });

  return { ok: true as const, status: 'approved' as const };
});

// ═══════════════════════════════════════════════════════════════════
// ERASURE EXECUTION (Feature #15, Phase 7c)
//
// THE MOST DESTRUCTIVE CODE IN THE PLATFORM. It is the only path besides
// institute purge permitted to touch attempt data, and unlike everything else
// in Feature #15 it is deliberately irreversible — it bypasses the retention
// window entirely, because a person exercising an erasure right should not
// have their data sit recoverable for another 30 days.
//
// SHIPS INERT. platformSettings/erasure holds two values:
//
//   retentionYears : how long exam records must be kept
//   mode           : 'delete' | 'anonymize'
//
// UNSET MEANS REFUSE. Until a human writes both, every erasure is rejected
// with "Retention policy not configured." Those two values are legal answers,
// not engineering ones, so the code declines to guess at them — the same
// fail-closed posture as scheduledPurge's dry-run default.
//
// FIVE GATES, IN ORDER (§6.1 of the spec)
//   1. Web Owner only. Not delegable — no ceiling entry exists for erasure.
//   2. An OPEN erasure request must exist. No ad-hoc destruction.
//   3. Policy configured, else refuse.
//   4. Retention window: if the subject has attempts inside it, refuse BY
//      DEFAULT. Overridable only with an explicit acknowledgement, which is
//      recorded in the decision text.
//   5. Typed confirmation of the subject's name.
//
// THE AUDIT PARADOX
// Erasing someone while logging "webOwner erased <name>" creates a fresh
// record of the person just erased. So the surviving audit row keeps a
// reference, a date and an entity type — NO name, no email, no label — and
// the subjectRequests row is redacted the same way. This is the ONE place in
// Feature #15 where the trail is deliberately made less complete. It is not a
// bug and must not be "fixed".
// ═══════════════════════════════════════════════════════════════════

type ErasureMode = 'delete' | 'anonymize';

type ErasurePolicy = {
  retentionYears?: number;
  mode?: ErasureMode;
  configuredBy?: string;
  configuredAt?: string;
};

async function readErasurePolicy(
  db: FirebaseFirestore.Firestore,
): Promise<ErasurePolicy | null> {
  try {
    const snap = await db.collection('platformSettings').doc('erasure').get();
    return snap.exists ? (snap.data() as ErasurePolicy) : null;
  } catch (err) {
    // Unreadable policy ⇒ treated as unconfigured. The safe reading of
    // "I don't know what the rules are" is "do not destroy anything".
    console.error('readErasurePolicy failed', err);
    return null;
  }
}

function policyIsConfigured(p: ErasurePolicy | null): boolean {
  return !!p
    && typeof p.retentionYears === 'number'
    && p.retentionYears >= 0
    && (p.mode === 'delete' || p.mode === 'anonymize');
}

/**
 * The subject's most recent attempt, or null if they have none / it cannot be
 * determined. Fails CLOSED: an unreadable query returns a sentinel that keeps
 * the record inside the retention window, so uncertainty blocks erasure
 * rather than permitting it.
 */
async function latestAttemptAt(
  db: FirebaseFirestore.Firestore,
  studentId: string,
): Promise<{ iso: string | null; unknown: boolean }> {
  try {
    const snap = await db.collection('attempts')
      .where('studentId', '==', studentId)
      .select('startedAt')
      .get();
    if (snap.empty) return { iso: null, unknown: false };
    let latest = '';
    for (const d of snap.docs) {
      const v = (d.get('startedAt') as string) ?? '';
      if (v > latest) latest = v;
    }
    return { iso: latest || null, unknown: false };
  } catch (err) {
    console.error('latestAttemptAt failed', studentId, err);
    return { iso: null, unknown: true };
  }
}

/** Strip identity from a subject's attempts, keeping them as statistical rows. */
async function anonymizeAttempts(
  db: FirebaseFirestore.Firestore,
  studentId: string,
): Promise<number> {
  let touched = 0;
  try {
    const snap = await db.collection('attempts').where('studentId', '==', studentId).get();
    let batch = db.batch();
    let n = 0;
    for (const d of snap.docs) {
      batch.update(d.ref, {
        // The link is SEVERED, not remapped. Keeping any mapping back to the
        // person would make this pseudonymisation, which does not satisfy an
        // erasure right.
        studentId: `erased:${d.id}`,
        studentName: 'Erased',
        anonymizedAt: new Date().toISOString(),
      });
      touched++;
      if (++n >= 400) { await batch.commit(); batch = db.batch(); n = 0; }
    }
    if (n > 0) await batch.commit();
  } catch (err) {
    console.error('anonymizeAttempts failed', studentId, err);
  }
  return touched;
}

export const executeErasure = onCall<{
  requestId: string;
  /** Must exactly match the subject's stored name. */
  confirmName: string;
  /** Required to proceed when attempts sit inside the retention window. */
  acknowledgeRetentionOverride?: boolean;
  /** Recorded verbatim on the request before it is redacted. */
  decision?: string;
}>(CALLABLE_BASE, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const actor = actorFrom(request);
  // GATE 1 — Web Owner only, and deliberately not delegable.
  if (actor.actorRole !== 'webOwner') {
    throw new HttpsError('permission-denied', 'Only the Web Owner may carry out an erasure.');
  }

  const { requestId, confirmName, acknowledgeRetentionOverride, decision } =
    request.data || ({} as never);
  if (!requestId) throw new HttpsError('invalid-argument', 'requestId is required.');

  const db = getFirestore();

  // GATE 2 — an open erasure request must exist. No ad-hoc destruction.
  const reqRef = db.collection('subjectRequests').doc(requestId);
  const reqSnap = await reqRef.get();
  if (!reqSnap.exists) throw new HttpsError('not-found', 'Request not found.');
  const req = reqSnap.data() as Record<string, unknown>;
  if (req.type !== 'erasure') {
    throw new HttpsError('failed-precondition', 'That request is not an erasure request.');
  }
  if (req.status !== 'open') {
    throw new HttpsError('failed-precondition', 'This request has already been decided.');
  }

  // GATE 3 — policy configured, else refuse.
  const policy = await readErasurePolicy(db);
  if (!policyIsConfigured(policy)) {
    throw new HttpsError(
      'failed-precondition',
      'ERASURE_POLICY_NOT_CONFIGURED',
    );
  }
  const mode = policy!.mode as ErasureMode;
  const retentionYears = policy!.retentionYears as number;

  const subjectRole = req.subjectRole as Role;
  const subjectId = req.subjectId as string;
  const profileRef = db.collection(COLLECTION_BY_ROLE[subjectRole]).doc(subjectId);
  const profileSnap = await profileRef.get();
  if (!profileSnap.exists) throw new HttpsError('not-found', 'Subject no longer exists.');
  const profile = profileSnap.data() as Record<string, unknown>;

  // GATE 5 — typed confirmation. Checked before the retention gate so a
  // mistyped name never reaches the override path.
  const storedName = ((profile.name as string) || '').trim();
  if (!confirmName || confirmName.trim() !== storedName) {
    throw new HttpsError('invalid-argument', 'The typed name does not match this person.');
  }

  // GATE 4 — retention window. Refuse by default; override must be explicit
  // and is recorded.
  let retentionNote = '';
  if (subjectRole === 'student' && retentionYears > 0) {
    const { iso, unknown } = await latestAttemptAt(db, subjectId);
    const cutoff = new Date();
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - retentionYears);

    const insideWindow = unknown || (iso !== null && Date.parse(iso) >= cutoff.getTime());
    if (insideWindow && !acknowledgeRetentionOverride) {
      throw new HttpsError(
        'failed-precondition',
        unknown
          ? 'RETENTION_UNKNOWN'
          : `RETENTION_WINDOW_ACTIVE:${iso}`,
      );
    }
    if (insideWindow) {
      retentionNote = unknown
        ? ' [retention status could not be determined; override acknowledged]'
        : ` [within ${retentionYears}-year retention window; override acknowledged]`;
    }
  }

  const nowIso = new Date().toISOString();
  const counts: Record<string, number> = {};

  // ── Attempts: the one thing ordinary deletion never touches ──────
  if (subjectRole === 'student') {
    // Collected FIRST. attemptVerdicts, attemptTelemetry and
    // attemptManualMarks are keyed by attemptId, so once the attempts are gone
    // there is nothing left to find them by and they would survive as orphans.
    const attemptIds = await attemptIdsForStudent(db, subjectId);

    if (mode === 'anonymize') {
      counts.attemptsAnonymized = await anonymizeAttempts(db, subjectId);
    } else {
      counts.attemptsDeleted = await purgeWhere(db, 'attempts', 'studentId', subjectId);
    }

    const child = await purgeAttemptChildRecords(db, attemptIds, {
      // Delete mode removes the record entirely, so the verdict goes with it.
      // Anonymise keeps the row for the institute's academic record, and the
      // verdict is what justifies the mark on it.
      includeVerdicts: mode !== 'anonymize',
    });
    counts.telemetryDeleted = child.telemetryDeleted;
    if (child.verdictsDeleted > 0) counts.verdictsDeleted = child.verdictsDeleted;
    // Named for what actually happened to them, which differs by mode: deleted
    // outright alongside the row, or kept with their link to the person cut.
    if (child.marksTouched > 0) {
      counts[mode === 'anonymize' ? 'manualMarksAnonymized' : 'manualMarksDeleted'] =
        child.marksTouched;
    }
    counts.questionReports = await purgeWhere(db, 'questionReports', 'studentId', subjectId);
    counts.assessmentMembers = await purgeWhere(db, 'assessmentMembers', 'studentId', subjectId);
  }

  // ── The account itself, via the one place deletion happens ───────
  await performAccountDeletion(db, {
    role: subjectRole,
    uid: subjectId,
    profileRef,
    // NO LABEL. This is the audit paradox resolution: the surviving row must
    // not name the person it records the erasure of.
    auditLabel: null,
    auditFromState:
      (profile.lifecycleState as LifecycleStateS) ??
      (profile.isDeleted === true ? 'softDeleted' : 'active'),
    targetInstituteId: (profile.instituteId as string) ?? null,
    actorUid: actor.actorUid,
    actorRole: actor.actorRole,
    reason: `Erasure request ${requestId}${retentionNote}`,
    requestId,
    impact: counts,
  });

  // ── Redact the request row ───────────────────────────────────────
  // Keeps enough to prove the request was received and honoured — id, dates,
  // who decided, and the reason — and drops everything that identifies who it
  // concerned. Deliberately less complete than every other record in this
  // feature.
  await reqRef.update({
    status: 'erased',
    subjectId: FieldValue.delete(),
    subjectLabel: FieldValue.delete(),
    basis: FieldValue.delete(),
    redacted: true,
    decision: `${(decision ?? 'Erased under data-subject request').trim()}${retentionNote}`,
    decidedBy: actor.actorUid,
    decidedAt: nowIso,
    updatedAt: nowIso,
  });

  return { ok: true as const, mode, counts };
});

// ═══════════════════════════════════════════════════════════════════
// SUBJECT REQUESTS — access & erasure requests (Feature #15, Phase 7b)
//
// RECORDS DECISIONS. DESTROYS NOTHING. No policy configuration required.
//
// WHY REFUSAL IS FIRST-CLASS HERE
// If examination records carry a mandatory retention period, then erasure
// requests received inside that window are lawfully refusable — that is the
// ordinary operation of the legal-compliance exception, not a loophole. But
// refusing is not the same as ignoring: a dated, reasoned refusal IS the
// compliance artifact, because it shows the request was received, considered
// and answered. Before this there was nowhere to record one at all.
//
// So for a platform with real retention obligations, the refusal path is the
// one that runs most of the time, and it is built to be as first-class as
// fulfilment rather than an afterthought bolted onto an erasure button.
//
// SPLIT CONTROLLERSHIP (locked): institutes are controllers for their own
// students, the Web Owner for platform-level data. But attempts are
// Web-Owner-only, so an institute carrying the legal duty cannot discharge it
// alone. Institutes RAISE; the Web Owner EXECUTES erasure. Access requests an
// institute can fulfil itself, since getSubjectData is already scoped to
// their own members.
//
// NOTE ON TIMEFRAMES: `receivedAt` is deliberately separate from `createdAt`.
// Compliance clocks run from when the PERSON asked, not from when somebody
// got round to logging it. An institute's deadline can therefore already be
// part-spent when the request reaches this system.
// ═══════════════════════════════════════════════════════════════════

type SubjectRequestType = 'access' | 'erasure';
type SubjectRequestStatus = 'open' | 'fulfilled' | 'refused' | 'erased';

export const submitSubjectRequest = onCall<{
  type: SubjectRequestType;
  subjectRole: 'student' | 'faculty';
  subjectId: string;
  /** What the person asked for, in their words. Free text. */
  basis?: string;
  /** When the PERSON asked — ISO date. Defaults to now if omitted. */
  receivedAt?: string;
}>(CALLABLE_BASE, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const { type, subjectRole, subjectId, basis, receivedAt } = request.data || ({} as never);
  if (type !== 'access' && type !== 'erasure') {
    throw new HttpsError('invalid-argument', 'type must be access or erasure.');
  }
  if (subjectRole !== 'student' && subjectRole !== 'faculty') {
    throw new HttpsError('invalid-argument', 'subjectRole must be student or faculty.');
  }
  if (!subjectId) throw new HttpsError('invalid-argument', 'subjectId is required.');

  const db = getFirestore();
  const actor = actorFrom(request);
  if (actor.actorRole !== 'webOwner' && actor.actorRole !== 'institute') {
    throw new HttpsError('permission-denied', 'Only staff may log a subject request.');
  }

  const col = subjectRole === 'student' ? 'students' : 'faculty';
  const snap = await db.collection(col).doc(subjectId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Subject not found.');
  const subjectInstituteId = (snap.get('instituteId') as string) ?? null;

  if (actor.actorRole === 'institute') {
    if (!actor.instituteId || actor.instituteId !== subjectInstituteId) {
      throw new HttpsError('permission-denied', 'Different institute.');
    }
  }

  // One open request per subject per type. A person asking twice is one
  // request; two rows would mean two decisions to make and two chances to
  // give inconsistent answers.
  const dupe = await db.collection('subjectRequests')
    .where('subjectId', '==', subjectId)
    .where('type', '==', type)
    .where('status', '==', 'open')
    .limit(1)
    .get();
  if (!dupe.empty) {
    throw new HttpsError('already-exists', 'An open request of this type already exists for this person.');
  }

  const nowIso = new Date().toISOString();
  const ref = db.collection('subjectRequests').doc();
  await ref.set({
    id: ref.id,
    type,
    status: 'open' as SubjectRequestStatus,
    subjectRole,
    subjectId,
    subjectLabel: (snap.get('name') as string) || (snap.get('email') as string) || null,
    requestedBy: actor.actorUid,
    requestedByRole: actor.actorRole,
    instituteId: subjectInstituteId,
    basis: basis ?? null,
    receivedAt: receivedAt || nowIso,
    decision: null,
    decidedBy: null,
    decidedAt: null,
    exportGeneratedAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  return { ok: true as const, id: ref.id };
});

export const decideSubjectRequest = onCall<{
  requestId: string;
  outcome: 'fulfilled' | 'refused';
  /** Required on refusal. Recorded verbatim — this is the artifact. */
  decision?: string;
  /** Set when an access export was produced for the person. */
  exportGenerated?: boolean;
}>(CALLABLE_BASE, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const { requestId, outcome, decision, exportGenerated } = request.data || ({} as never);
  if (!requestId) throw new HttpsError('invalid-argument', 'requestId is required.');
  if (outcome !== 'fulfilled' && outcome !== 'refused') {
    throw new HttpsError('invalid-argument', 'outcome must be fulfilled or refused.');
  }

  // A refusal without a reason is indistinguishable from ignoring the
  // request, which is the thing this record exists to disprove.
  if (outcome === 'refused' && (!decision || !decision.trim())) {
    throw new HttpsError('invalid-argument', 'A refusal must record a reason.');
  }

  const db = getFirestore();
  const actor = actorFrom(request);
  const ref = db.collection('subjectRequests').doc(requestId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Request not found.');
  const req = snap.data() as Record<string, unknown>;

  if (req.status !== 'open') {
    throw new HttpsError('failed-precondition', 'This request has already been decided.');
  }

  if (actor.actorRole !== 'webOwner') {
    if (actor.actorRole !== 'institute'
        || !actor.instituteId
        || actor.instituteId !== req.instituteId) {
      throw new HttpsError('permission-denied', 'Insufficient permissions.');
    }
    // An institute may fulfil an ACCESS request itself — getSubjectData is
    // already scoped to its own members. It may also refuse either type,
    // since refusing destroys nothing. What it cannot do is fulfil an
    // ERASURE request: that requires touching attempts, which is
    // Web-Owner-only, and 7c is where it actually happens.
    if (req.type === 'erasure' && outcome === 'fulfilled') {
      throw new HttpsError(
        'permission-denied',
        'Erasure is carried out by the Web Owner. Leave this open for them, or refuse it with a reason.',
      );
    }
  }

  // Guard against a fulfilled erasure before 7c exists. Marking one fulfilled
  // when nothing was destroyed would make the record claim something untrue —
  // worse than having no record.
  if (req.type === 'erasure' && outcome === 'fulfilled') {
    throw new HttpsError(
      'failed-precondition',
      'Erasure execution is not yet available. Refuse with a reason, or leave the request open.',
    );
  }

  const nowIso = new Date().toISOString();
  await ref.update({
    status: outcome as SubjectRequestStatus,
    decision: decision?.trim() || null,
    decidedBy: actor.actorUid,
    decidedAt: nowIso,
    exportGeneratedAt: exportGenerated ? nowIso : (req.exportGeneratedAt ?? null),
    updatedAt: nowIso,
  });

  return { ok: true as const, status: outcome };
});

// ═══════════════════════════════════════════════════════════════════
// SUBJECT DATA — everything held about one person (Feature #15, Phase 7a)
//
// DESTROYS NOTHING. Read-only, no legal precondition, safe to call any time.
//
// WHY THIS EXISTS BEFORE ERASURE
// The right of ACCESS precedes the right of erasure in essentially every
// regime, and it is the request far more likely to actually arrive. Without
// this, answering "what do you hold about me?" means hand-querying Firestore.
// It is also the foundation for erasure: you cannot honestly decide a request
// without seeing what would be destroyed.
//
// THE UNREADABLE CONTRACT — same discipline as getDeletionImpact
// A collection that cannot be read is reported as `null`, never as an empty
// array. This export gets handed to a person as a complete answer; one that
// silently omits a collection is worse than no export at all.
//
// SECRETS ARE NEVER EXPORTED
// studentCredentials / facultyCredentials carry a `password` field. It is
// stripped here unconditionally. An access export is handed to whoever asked
// for it, frequently over email — putting a working credential in it would
// turn a compliance feature into a credential-disclosure channel.
// ═══════════════════════════════════════════════════════════════════

type SubjectSection = {
  collection: string;
  /** null ⇒ could not be read. Distinct from [] which means "none". */
  records: Record<string, unknown>[] | null;
  note?: string;
};

/** Fields never included in an export, whatever collection they appear on. */
const NEVER_EXPORT = ['password', 'passwordHash', 'sebToken', 'activeSessionId'];

function scrub(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (NEVER_EXPORT.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Read one collection by equality filter. Returns null if unreadable. */
async function collectSection(
  db: FirebaseFirestore.Firestore,
  collection: string,
  field: string,
  value: string,
  note?: string,
): Promise<SubjectSection> {
  try {
    const snap = await db.collection(collection).where(field, '==', value).get();
    return {
      collection,
      records: snap.docs.map((d) => ({ id: d.id, ...scrub(d.data() as Record<string, unknown>) })),
      note,
    };
  } catch (err) {
    console.error('collectSection failed', collection, field, value, err);
    return { collection, records: null, note: 'Could not be read.' };
  }
}

/** Read one document by id. Returns null records if unreadable. */
async function collectDoc(
  db: FirebaseFirestore.Firestore,
  collection: string,
  id: string,
  note?: string,
): Promise<SubjectSection> {
  try {
    const snap = await db.collection(collection).doc(id).get();
    return {
      collection,
      records: snap.exists
        ? [{ id: snap.id, ...scrub(snap.data() as Record<string, unknown>) }]
        : [],
      note,
    };
  } catch (err) {
    console.error('collectDoc failed', collection, id, err);
    return { collection, records: null, note: 'Could not be read.' };
  }
}

export const getSubjectData = onCall<{
  role: 'student' | 'faculty';
  uid: string;
}>(CALLABLE_BASE, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const { role, uid } = request.data || ({} as never);
  if (role !== 'student' && role !== 'faculty') {
    throw new HttpsError('invalid-argument', 'role must be student or faculty.');
  }
  if (!uid) throw new HttpsError('invalid-argument', 'uid is required.');

  const db = getFirestore();
  const actor = actorFrom(request);

  const profileCol = role === 'student' ? 'students' : 'faculty';
  const credCol = role === 'student' ? 'studentCredentials' : 'facultyCredentials';

  const profileSnap = await db.collection(profileCol).doc(uid).get();
  if (!profileSnap.exists) throw new HttpsError('not-found', 'Subject not found.');
  const subjectInstituteId = (profileSnap.get('instituteId') as string) ?? null;

  // Web Owner sees anyone; an institute admin only its own members. Faculty
  // and students cannot run this on anyone, including themselves — a
  // self-service export is a separate feature with its own identity checks.
  if (actor.actorRole !== 'webOwner') {
    if (actor.actorRole !== 'institute'
        || !actor.instituteId
        || actor.instituteId !== subjectInstituteId) {
      throw new HttpsError('permission-denied', 'Insufficient permissions.');
    }
  }

  const sections: SubjectSection[] = [];

  sections.push(await collectDoc(db, profileCol, uid, 'Profile record.'));
  sections.push(await collectDoc(db, credCol, uid,
    'Account provisioning state. Credentials themselves are never exported.'));

  if (role === 'student') {
    sections.push(await collectSection(db, 'attempts', 'studentId', uid,
      'Exam sittings, including answers, timings, scores and integrity events.'));
    sections.push(await collectSection(db, 'academicMappings', 'studentId', uid,
      'Placement in the academic hierarchy.'));
    sections.push(await collectSection(db, 'assessmentMembers', 'studentId', uid,
      'Exams this person was allocated to.'));
    sections.push(await collectSection(db, 'questionReports', 'studentId', uid,
      'Question issues this person reported during an exam.'));
  } else {
    sections.push(await collectSection(db, 'questions', 'ownerId', uid,
      'Questions authored by this person.'));
    sections.push(await collectSection(db, 'questionBanks', 'ownerId', uid,
      'Question banks owned by this person.'));
    sections.push(await collectSection(db, 'assessments', 'ownerId', uid,
      'Assessments owned by this person.'));
    sections.push(await collectSection(db, 'questionShares', 'ownerId', uid,
      'Content this person shared.'));
  }

  // Audit + request surfaces name the subject regardless of role.
  sections.push(await collectSection(db, 'deletionAudit', 'entityId', uid,
    'Lifecycle actions recorded against this person.'));
  sections.push(await collectSection(db, 'deletionRequests', 'entityId', uid,
    'Deletion requests naming this person.'));

  const unreadable = sections.filter((s) => s.records === null).map((s) => s.collection);

  return {
    ok: true as const,
    generatedAt: new Date().toISOString(),
    generatedBy: actor.actorUid,
    generatedByRole: actor.actorRole,
    subject: {
      role,
      uid,
      name: (profileSnap.get('name') as string) ?? null,
      email: (profileSnap.get('email') as string) ?? null,
      instituteId: subjectInstituteId,
    },
    sections,
    // Surfaced at the top level so the UI cannot present a partial export as
    // complete without saying so.
    unreadable,
    note: 'Firebase Authentication holds this account\'s email, password hash '
      + 'and sign-in timestamps; those are not included here.',
  };
});

// ═══════════════════════════════════════════════════════════════════
// DELETION IMPACT — dependency counts before a destructive action
// (Feature #15, Phase 1)
//
// WHY SERVER-SIDE
// The counts are the whole point of the confirmation dialog, and they must be
// TRUE. Counting client-side would mean either fetching every dependent doc
// (thousands of reads to render one dialog — an institute with 1,200 students
// and 48,000 attempts would be unusable) or trusting a stale denormalized
// number. count() aggregation queries run in the datastore and return a single
// number per collection, so the dialog costs a handful of aggregations
// regardless of tenant size.
//
// It also sidesteps a rules problem: a faculty member may be permitted to
// delete a student without being permitted to read every collection that
// student appears in. The server can count what the caller cannot see.
//
// FAIL-LOUD, NOT FAIL-QUIET
// If a count cannot be computed it is returned as null, and the UI must render
// that as "unknown", never as zero. A dialog that silently shows 0 attempts for
// a student who has 40 is worse than no dialog at all — it actively invites
// the destructive click it was built to prevent.
// ═══════════════════════════════════════════════════════════════════

type ImpactCounts = Record<string, number | null>;

/**
 * Count documents matching one equality filter, using an aggregation query.
 * Returns null on failure so the caller can distinguish "none" from "unknown".
 */
async function countWhere(
  db: FirebaseFirestore.Firestore,
  collection: string,
  field: string,
  value: string,
  extra?: { field: string; value: unknown },
): Promise<number | null> {
  try {
    let q: FirebaseFirestore.Query = db.collection(collection).where(field, '==', value);
    if (extra) q = q.where(extra.field, '==', extra.value);
    const snap = await q.count().get();
    return snap.data().count;
  } catch (err) {
    console.error('countWhere failed', collection, field, value, err);
    return null;
  }
}

/**
 * What would be affected by removing this entity?
 *
 * Counts only — nothing is written, nothing is validated, and calling this has
 * no side effects. It is safe to call on every dialog open.
 *
 * The dependency table mirrors Section 7 of the feature spec, mapped onto the
 * real collections rather than assumed ones.
 */
export const getDeletionImpact = onCall<{
  entityType: 'institute' | 'faculty' | 'student' | 'assessment';
  entityId: string;
}>(CALLABLE_BASE, async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

  const { entityType, entityId } = request.data || ({} as never);
  if (!entityType || !entityId) {
    throw new HttpsError('invalid-argument', 'entityType and entityId are required.');
  }

  const db = getFirestore();
  const actor = actorFrom(request);

  // Authorisation: a caller may only inspect an entity they could plausibly
  // act on. This is a READ of counts, so the bar is tenant membership rather
  // than a deletion right — Phase 3 gates the action itself.
  const requireTenant = async (): Promise<string | null> => {
    if (actor.actorRole === 'webOwner') return null;
    if (actor.actorRole !== 'institute' && actor.actorRole !== 'faculty') {
      throw new HttpsError('permission-denied', 'Insufficient permissions.');
    }
    if (!actor.instituteId) {
      throw new HttpsError('permission-denied', 'Missing tenant claim.');
    }
    return actor.instituteId;
  };

  const callerInstitute = await requireTenant();

  const counts: ImpactCounts = {};
  let label: string | null = null;
  let ownerInstituteId: string | null = null;

  if (entityType === 'institute') {
    // Only the Web Owner may inspect an institute — its dependents span the
    // whole tenant, and no tenant-level actor should enumerate another's.
    if (actor.actorRole !== 'webOwner') {
      throw new HttpsError('permission-denied', 'Only the Web Owner may inspect an institute.');
    }
    const snap = await db.collection('institutes').doc(entityId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Institute not found.');
    label = (snap.get('name') as string) ?? null;
    ownerInstituteId = entityId;

    const [faculty, students, assessments, attempts, reports, schools, programs, courses] =
      await Promise.all([
        countWhere(db, 'faculty', 'instituteId', entityId),
        countWhere(db, 'students', 'instituteId', entityId),
        countWhere(db, 'assessments', 'ownerId', entityId),
        countWhere(db, 'attempts', 'instituteId', entityId),
        countWhere(db, 'questionReports', 'instituteId', entityId),
        countWhere(db, 'schools', 'instituteId', entityId),
        countWhere(db, 'programs', 'instituteId', entityId),
        countWhere(db, 'courses', 'instituteId', entityId),
      ]);
    Object.assign(counts, {
      faculty, students, assessments, attempts, reports, schools, programs, courses,
    });
  } else if (entityType === 'faculty') {
    const snap = await db.collection('faculty').doc(entityId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Faculty not found.');
    ownerInstituteId = (snap.get('instituteId') as string) ?? null;
    label = (snap.get('name') as string) ?? null;
    if (callerInstitute && callerInstitute !== ownerInstituteId) {
      throw new HttpsError('permission-denied', 'Different institute.');
    }

    // Owned content is what makes faculty deletion consequential — these are
    // the counts that drive the succession decision in Phase 5.
    // No academicMappings row here: that collection is student-only (see the
    // note in performAccountDeletion). Counting it for faculty would query a
    // field that does not exist and render a permanent, meaningless "0".
    // questionGroups is counted SEPARATELY from questions, not folded into it.
    // The `questions` count already includes group children — they are
    // ordinary question documents — so a faculty member with 12 DI sets of 5
    // shows 60 questions either way. What the number of SETS adds is the shape
    // of that content: 60 loose questions and 12 sets are very different
    // things to reassign to a successor, and the succession decision is what
    // this impact panel exists to inform.
    const [assessments, questions, banks, groups] = await Promise.all([
      countWhere(db, 'assessments', 'ownerId', entityId),
      countWhere(db, 'questions', 'ownerId', entityId),
      countWhere(db, 'questionBanks', 'ownerId', entityId),
      countWhere(db, 'questionGroups', 'ownerId', entityId),
    ]);
    Object.assign(counts, { assessments, questions, questionBanks: banks, questionGroups: groups });
  } else if (entityType === 'student') {
    const snap = await db.collection('students').doc(entityId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Student not found.');
    ownerInstituteId = (snap.get('instituteId') as string) ?? null;
    label = (snap.get('name') as string) ?? null;
    if (callerInstitute && callerInstitute !== ownerInstituteId) {
      throw new HttpsError('permission-denied', 'Different institute.');
    }

    const [attempts, mappings, reports, memberships] = await Promise.all([
      countWhere(db, 'attempts', 'studentId', entityId),
      countWhere(db, 'academicMappings', 'studentId', entityId),
      countWhere(db, 'questionReports', 'studentId', entityId),
      countWhere(db, 'assessmentMembers', 'studentId', entityId),
    ]);
    Object.assign(counts, { attempts, mappings, reports, memberships });
  } else if (entityType === 'assessment') {
    const snap = await db.collection('assessments').doc(entityId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Assessment not found.');
    label = (snap.get('title') as string) ?? null;
    const ownerType = snap.get('ownerType') as string | undefined;
    const ownerId = snap.get('ownerId') as string | undefined;
    ownerInstituteId = ownerType === 'institute' ? (ownerId ?? null) : null;
    if (callerInstitute && ownerInstituteId && callerInstitute !== ownerInstituteId) {
      throw new HttpsError('permission-denied', 'Different institute.');
    }

    const [attempts, members] = await Promise.all([
      countWhere(db, 'attempts', 'assessmentId', entityId),
      countWhere(db, 'assessmentMembers', 'assessmentId', entityId),
    ]);
    Object.assign(counts, { attempts, members });
  } else {
    throw new HttpsError('invalid-argument', 'Unsupported entityType.');
  }

  // Anything that would be PRESERVED rather than destroyed is called out
  // separately, so the dialog can say so explicitly. The locked guarantee is
  // that account deletion never touches attempts or reports, and a dialog
  // that lists them beside faculty and students without that distinction
  // reads as "all of this will be destroyed" — the opposite of the truth.
  const preserved: string[] =
    entityType === 'student' ? ['attempts', 'reports']
    : entityType === 'faculty' ? ['attempts', 'reports']
    : [];

  return {
    ok: true as const,
    entityType,
    entityId,
    label,
    instituteId: ownerInstituteId,
    counts,
    preserved,
  };
});

// ═══════════════════════════════════════════════════════════════════
// gradeAttempt — server-side scoring
//
// Replaces the previous client-side calculateScores + submitAttempt /
// autoTerminate path. Reads answer-key fields from questionAnswers
// (which students cannot read directly), computes scores, and writes
// status + scores + per-question gradedAnswers back to the attempt doc.
//
// reason maps to status:
//   manual          → submitted
//   time_expired    → auto_submitted
//   window_closed   → auto_submitted
//   violation_limit → auto_submitted
//   terminated      → terminated  (also stamps integrityLog fields)
// ═══════════════════════════════════════════════════════════════════

type GradeReason =
  | 'manual'
  | 'time_expired'
  | 'window_closed'
  | 'violation_limit'
  | 'terminated';

interface GradeAttemptData {
  attemptId: string;
  sebToken?: string;
  reason: GradeReason;
  terminateReason?: string;
  lastSectionId?: string;
  lastSectionTimeUsed?: number;
}

type CorrectPair = { leftId: string; rightId: string };
type MCQOption   = { id: string; text: string };

interface QuestionDoc {
  id: string;
  engine: 'mcq' | 'text' | 'match' | 'code';
  variant: string | null;
  options: MCQOption[];
  difficulty?: 'easy' | 'medium' | 'hard';   // server-read; used for per-row grading policy
  /**
   * Coding delivery settings. Safe to keep on the question document — unlike
   * the test suite, none of this is the answer key: the candidate is shown the
   * languages and needs to know the limits their program runs under.
   */
  codeSpec?: {
    languages?: string[];
    limits?: Partial<JudgeLimits>;
    starterCode?: Record<string, string>;
  };
}

// ── Grading policy (server twin of resolveGradingPolicy in assessmentService) ──
// Negative marking + blank handling, resolved per question through the chain
// exam → section → difficulty-row with the exam master switch as a hard gate.
// Frozen onto the attempt at start so a mid-flight edit can't regrade. Keep in
// EXACT sync with src/lib/assessmentService.ts.
type PenaltyTypeS = 'fixed' | 'percent';
interface GradingPolicyS {
  negativeMarking?: boolean;
  penaltyType?: PenaltyTypeS;
  penaltyValue?: number;
  blankScore?: number;
}
interface SectionGradingPolicyS {
  section?: GradingPolicyS;
  byDifficulty?: Partial<Record<'easy' | 'medium' | 'hard', GradingPolicyS>>;
}
interface AssessmentGradingConfigS {
  exam?: GradingPolicyS;
  sections?: Record<string, SectionGradingPolicyS>;
}
interface ResolvedGradingPolicyS {
  negativeMarking: boolean;
  penaltyType: PenaltyTypeS;
  penaltyValue: number;
  blankScore: number;
}

function resolveGradingPolicyS(
  config: AssessmentGradingConfigS | undefined,
  sectionId: string,
  difficulty: 'easy' | 'medium' | 'hard',
  isCoding = false,
): ResolvedGradingPolicyS {
  const exam = config?.exam;
  const gateOpen = exam?.negativeMarking === true;
  const sectionPol = config?.sections?.[sectionId];
  const rowPol = sectionPol?.byDifficulty?.[difficulty];
  const pick = <K extends keyof GradingPolicyS>(k: K): GradingPolicyS[K] | undefined =>
    rowPol?.[k] ?? sectionPol?.section?.[k] ?? exam?.[k];

  const blankScore = pick('blankScore') ?? 0;
  if (!gateOpen) {
    return { negativeMarking: false, penaltyType: 'fixed', penaltyValue: 0, blankScore };
  }
  // CODING INHERITS NOTHING; IT OPTS IN.
  //
  // Every other engine takes the exam-level switch as its default: a teacher
  // who turned negative marking on at the exam meant it for the paper. Coding's
  // settled policy is the reverse — default off, enabled per coding section by
  // an institution that asks for it.
  //
  // So coding resolves the flag from the SECTION AND ROW ONLY, deliberately
  // skipping the exam level that `pick` would otherwise supply. Note that a
  // `pick(...) ?? false` would not do this: the gate above already requires
  // exam.negativeMarking === true, so pick can never return undefined here and
  // any fallback after it is dead code.
  //
  // The consequence is intended and worth surfacing in the builder: one exam
  // can penalise its MCQ sections by inheritance while its coding section does
  // not, until someone sets the flag on that section.
  const negOn = isCoding
    ? (rowPol?.negativeMarking ?? sectionPol?.section?.negativeMarking ?? false)
    : (pick('negativeMarking') ?? true);
  if (!negOn) {
    return { negativeMarking: false, penaltyType: 'fixed', penaltyValue: 0, blankScore };
  }
  return {
    negativeMarking: true,
    penaltyType: pick('penaltyType') ?? 'fixed',
    penaltyValue: Math.max(0, pick('penaltyValue') ?? 0),
    blankScore,
  };
}

/**
 * Marks for one answered question, penalty included. THE single expression of
 * "Option A" — the rule both engines are graded by.
 *
 *   any positive score        -> that score, untouched
 *   nothing right at all      -> minus the configured penalty
 *   right and wrong cancelling-> ZERO. Not a penalty. (A-08.)
 *
 * The third line is the fix. Both call sites used to read
 * `multiplier > 0 ? multiplier * marks : -penalty`, directly under a comment
 * promising "negative marking applies ONLY to a FULLY wrong answer… any
 * correct/partial content keeps its positive award untouched". For multi-select
 * that is not what `multiplier === 0` means: the multiplier is
 * max(0, (hits − wrongs) / |correct|), so a student who picked one of two
 * correct options and one wrong one lands on exactly 0 and took the full
 * penalty — the identical mark given to a student who picked only wrong
 * options, and worse than the zero given to one who left it blank.
 *
 * Expressed once now rather than duplicated per engine, because the divergence
 * this fixes was two copies of one rule drifting from the sentence above them.
 */
function awardFor(
  outcome: { multiplier: number; anyCorrect: boolean },
  policy: ResolvedGradingPolicyS,
  questionMarks: number,
): number {
  if (outcome.multiplier > 0) return outcome.multiplier * questionMarks;
  if (outcome.anyCorrect) return 0;
  return -penaltyFor(policy, questionMarks);
}

// Compute the penalty (a POSITIVE number to subtract) for a fully-wrong answer
// under a resolved policy, given the question's own marks.
function penaltyFor(policy: ResolvedGradingPolicyS, questionMarks: number): number {
  if (!policy.negativeMarking || policy.penaltyValue <= 0) return 0;
  if (policy.penaltyType === 'percent') {
    return Math.max(0, (policy.penaltyValue / 100) * questionMarks);
  }
  return Math.max(0, policy.penaltyValue);
}

interface QuestionAnswerDoc {
  id: string;
  correctIds: string[];
  correctPairs: CorrectPair[];
  modelAnswer: string;
  /**
   * The test suite for a coding question — hidden cases included.
   *
   * Lives here, beside correctIds, for exactly the same reason: this is the
   * one collection a student cannot read (firestore.rules restricts it to the
   * owner and webOwner). Putting the suite on the question document instead
   * would ship the entire answer key to the browser inside the exam payload.
   */
  tests?: JudgeTest[];
}

interface AttemptAnswerDoc {
  type: 'mcq' | 'text' | 'match' | 'code';
  // 'code' answers are { language, source }, which the existing
  // Record<string, string> arm already admits — the value union does not widen.
  value: string | string[] | Record<string, string>;
}

/**
 * Scoring outcome for one answer.
 *
 * `anyCorrect` is separate from `multiplier > 0` and that separation is the
 * whole point (A-08). A multi-select answer with one right and one wrong
 * selection scores a multiplier of exactly 0 — indistinguishable, by that
 * number alone, from an answer with nothing right at all. Negative marking is
 * documented to apply ONLY to a fully wrong answer, so it needs to know which
 * of the two it is looking at, and the multiplier cannot tell it.
 */
type ScoreOutcome = { multiplier: number; isCorrect: boolean; anyCorrect: boolean };

function scoreMCQMultiplier(
  q: QuestionDoc,
  ans: QuestionAnswerDoc,
  value: AttemptAnswerDoc['value'],
): ScoreOutcome {
  // MULTI IS THE SPECIAL CASE; EVERY OTHER MCQ VARIANT IS ONE SELECTION.
  //
  // This used to be the other way round — an allow-list of 'single' |
  // 'truefalse' | 'fillblank', with anything else falling through to a
  // multiplier of 0. That is the worst possible default: add an mcq variant
  // (as 'outputpred' just was) and forget this function, and every candidate
  // who answers it CORRECTLY is silently marked zero. Nothing surfaces —
  // not a crash, not a warning, just a paper full of wrong marks.
  //
  // Inverted, a forgotten variant is scored as the single-selection question
  // that every mcq variant except 'multi' actually is. That is right for any
  // future keyed one-of-N variant and merely wrong-shaped for anything else,
  // which is a far better failure than confidently wrong marks.
  //
  // This file cannot import the client's MCQVariant union, so a runtime
  // default is the only lever available here; the client side gets its
  // exhaustiveness from the registry's binding tables instead.
  if (q.variant === 'multi') {
    const selected = Array.isArray(value) ? value : [];
    const correct = new Set(ans.correctIds);
    let hits = 0;
    let wrongs = 0;
    for (const id of selected) {
      if (correct.has(id)) hits++;
      else wrongs++;
    }
    const raw = correct.size > 0 ? (hits - wrongs) / correct.size : 0;
    const mult = Math.max(0, raw);
    // A-08: hits, not the multiplier. A student who found one of two correct
    // options and added one wrong one nets to zero — they knew something, and
    // the penalty is reserved for knowing nothing.
    return { multiplier: mult, isCorrect: mult === 1, anyCorrect: hits > 0 };
  }

  // Single selection — 'single', 'truefalse', 'fillblank', 'outputpred', and
  // any keyed one-of-N variant added later.
  const selected = typeof value === 'string' ? value : '';
  const isCorrect = ans.correctIds.includes(selected);
  // One selection: "any correct content" and "correct" are the same question.
  return { multiplier: isCorrect ? 1 : 0, isCorrect, anyCorrect: isCorrect };
}

function scoreMatchMultiplier(
  ans: QuestionAnswerDoc,
  value: AttemptAnswerDoc['value'],
): ScoreOutcome {
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { multiplier: 0, isCorrect: false, anyCorrect: false };
  }
  const m = value as Record<string, string>;
  if (ans.correctPairs.length === 0) {
    return { multiplier: 0, isCorrect: false, anyCorrect: false };
  }
  let correct = 0;
  for (const pair of ans.correctPairs) {
    if (m[pair.leftId] === pair.rightId) correct++;
  }
  const mult = correct / ans.correctPairs.length;
  // Match never had the multi-select problem — correct/total is zero only when
  // nothing matched — but it states the rule the same way so the two engines
  // cannot drift into applying one policy differently.
  return { multiplier: mult, isCorrect: mult === 1, anyCorrect: correct > 0 };
}

// ══════════════════════════════════════════════════════════════════
// SHARED GRADING HELPERS — single source of truth for scoring.
// Used by gradeAttempt (finalise) AND regradeAttempts (post-fix regrade)
// so the two paths can never drift apart.
// ══════════════════════════════════════════════════════════════════

interface GradingAssessmentDoc {
  sections?: Array<{
    id: string;
    name: string;
    questions?: Array<{ questionId: string; marks: number }>;
    // Phase 2.5 Stage 3 — seconds per question (linear/adaptive); undefined = off
    questionTimeLimit?: number;
  }>;
  questions?: Array<{ questionId: string; marks: number }>;
  passingScore?: number;
  allowReview?: boolean;
  // N5 final form (2026-07-17) — audience-scoped visibility. When present,
  // these arrays are authoritative; when absent (legacy docs), the old
  // booleans govern (see reviewAudienceAllows).
  allowReviewTo?: unknown;
  showResultsTo?: unknown;
  gradingConfig?: AssessmentGradingConfigS;   // negative marking + blank policy
}

// ── Visibility audiences (N5 final form) ──────────────────────────
// Owner-controlled, per-assessment: who may see correct answers.
//   allowReviewTo present → the array is authoritative per audience.
//   allowReviewTo absent  → legacy: the allowReview boolean governs
//     EVERYONE. Staff key access mirrors student access (staff ≤ students
//     symmetry) — this deliberately closes audit N5 for legacy docs too:
//     an allowReview:false exam exposes keys to no one, instead of to every
//     assigned institute's staff while live. Keys students already hold
//     (written into their attempts when they may review) are the floor;
//     granting staff less than students is only enforceable at the key
//     endpoint, not inside student-readable attempt docs.
type VisibilityAudience = 'students' | 'institute' | 'faculty';

function reviewAudienceAllows(
  assessment: { allowReview?: boolean; allowReviewTo?: unknown },
  audience: VisibilityAudience,
): boolean {
  const list = Array.isArray(assessment.allowReviewTo)
    ? (assessment.allowReviewTo as unknown[]).filter((x): x is string => typeof x === 'string')
    : null;
  if (list) return list.includes(audience);
  return assessment.allowReview === true;
}

type EffectiveSection = {
  id: string;
  name: string;
  // `order` is present on stored AssessmentQuestion entries and is what
  // startExam sorts by when building questionOrder. Grading ignores it, which
  // is why it was previously undeclared — the data always carried it.
  questions: Array<{ questionId: string; marks: number; order?: number }>;
  questionTimeLimit?: number;
};

// Effective sections — MUST mirror buildEffectiveSections in ExamShell.tsx
// exactly, or grading diverges from what the student saw.
//   Case 1: at least one section carries resolved questions → use those
//           sections (dropping empty ones).
//   Case 2: sections exist but none has questions (legacy / flat shape) →
//           distribute the flat assessment.questions list across the named
//           sections equally (Math.ceil chunks), same as the shell.
//   Case 3: no sections at all → one synthetic 'main_section' wrapping the
//           flat list (same id the shell uses, so bySection keys line up
//           with attempt.questionOrder).
function normalizeSections(assessment: GradingAssessmentDoc): EffectiveSection[] {
  const rawSections = assessment.sections ?? [];
  const hasResolved = rawSections.some((s) => (s.questions?.length ?? 0) > 0);
  if (hasResolved) {
    return rawSections
      .filter((s) => (s.questions?.length ?? 0) > 0)
      .map((s) => ({
        id: s.id,
        name: s.name,
        questions: s.questions!,
        questionTimeLimit: s.questionTimeLimit,
      }));
  }
  if ((assessment.questions?.length ?? 0) > 0) {
    const flat = assessment.questions!;
    if (rawSections.length > 0) {
      const perSection = Math.ceil(flat.length / rawSections.length);
      return rawSections
        .map((sec, i) => ({
          id: sec.id,
          name: sec.name,
          questions: flat.slice(i * perSection, (i + 1) * perSection),
          questionTimeLimit: sec.questionTimeLimit,
        }))
        .filter((s) => s.questions.length > 0);
    }
    return [{ id: 'main_section', name: 'Questions', questions: flat }];
  }
  return [];
}

// Batch-load question + answer docs, chunked at 300 refs per getAll call so
// very large papers can't blow a single BatchGetDocuments RPC. Pre-migration
// questions still carrying inline answer fields are honoured as a fallback.
async function loadQuestionAndAnswerMaps(
  db: FirebaseFirestore.Firestore,
  qIds: string[],
): Promise<{ questionMap: Map<string, QuestionDoc>; answerMap: Map<string, QuestionAnswerDoc> }> {
  const chunkedGetAll = async (col: string, ids: string[]) => {
    const out: FirebaseFirestore.DocumentSnapshot[] = [];
    for (let i = 0; i < ids.length; i += 300) {
      const refs = ids.slice(i, i + 300).map((id) => db.collection(col).doc(id));
      out.push(...await db.getAll(...refs));
    }
    return out;
  };
  const [questionSnaps, answerSnaps] = await Promise.all([
    chunkedGetAll('questions', qIds),
    chunkedGetAll('questionAnswers', qIds),
  ]);

  const questionMap = new Map<string, QuestionDoc>();
  questionSnaps.forEach((snap) => {
    if (snap.exists) {
      questionMap.set(snap.id, snap.data() as QuestionDoc);
    }
  });
  const answerMap = new Map<string, QuestionAnswerDoc>();
  answerSnaps.forEach((snap) => {
    if (snap.exists) {
      answerMap.set(snap.id, snap.data() as QuestionAnswerDoc);
    } else {
      // Backwards-compat: pre-migration questions still carry answers inline
      const q = questionMap.get(snap.id) as unknown as QuestionAnswerDoc & QuestionDoc;
      if (q) {
        answerMap.set(snap.id, {
          id: snap.id,
          correctIds:   (q as any).correctIds   ?? [],
          correctPairs: (q as any).correctPairs ?? [],
          modelAnswer:  (q as any).modelAnswer  ?? '',
        });
      }
    }
  });
  return { questionMap, answerMap };
}

/**
 * Deterministic id for one attempt's verdict on one question.
 *
 * A composite doc id rather than a query, so the load is a `getAll` on known
 * refs — the same pattern as the question/answer maps, and it keeps the read
 * cost proportional to the paper rather than to the collection.
 */
export function codeVerdictDocId(attemptId: string, questionId: string): string {
  return `${attemptId}__${questionId}`;
}

/**
 * Load the judge verdicts for one attempt.
 *
 * WHY THESE ARE NOT ON THE ATTEMPT DOCUMENT: firestore.rules lets a student
 * read their own attempt. A verdict carries hidden-test output, and even the
 * per-test pass/fail list is an oracle — run, see which hidden test flipped,
 * and the suite can be reconstructed by bisection without its text ever being
 * shown. So verdicts live in their own collection, readable by staff only,
 * for exactly the reason `questionAnswers` is a separate collection from
 * `questions`.
 *
 * A missing verdict is NOT an error and NOT a zero: it means the judge has not
 * finished (or has not run). The grading pass reads that absence as manual
 * review, and a later regrade picks up the verdict once it lands.
 */
async function loadCodeVerdicts(
  db: FirebaseFirestore.Firestore,
  attemptId: string,
  questionMap: Map<string, QuestionDoc>,
): Promise<Map<string, JudgeVerdict>> {
  const out = new Map<string, JudgeVerdict>();
  // Only coding questions can have a verdict, and a paper with none must cost
  // nothing extra — this is on the path every attempt in the platform takes.
  const qIds: string[] = [];
  questionMap.forEach((q, id) => { if (q.engine === 'code') qIds.push(id); });
  if (qIds.length === 0) return out;

  const byDocId = new Map(qIds.map((qid) => [codeVerdictDocId(attemptId, qid), qid]));
  const ids = Array.from(byDocId.keys());
  for (let i = 0; i < ids.length; i += 300) {
    const refs = ids.slice(i, i + 300).map((id) => db.collection('attemptVerdicts').doc(id));
    const snaps = await db.getAll(...refs);
    snaps.forEach((snap) => {
      if (!snap.exists) return;
      const qid = byDocId.get(snap.id);
      const data = snap.data() as { verdict?: JudgeVerdict } | undefined;
      if (qid && data?.verdict) out.set(qid, data.verdict);
    });
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════
// MANUAL MARKING — the human half of the scorer
// ══════════════════════════════════════════════════════════════════
//
// A machine cannot mark an essay, so scoreAttemptAnswers sets
// requiresManualReview and awards nothing for the text engine. That was the
// whole story until now: the flag was written, surfaced in four places, and
// never cleared by anything, so a paper carrying one essay question could be
// sat and scored but never finished (audit G-01, recorded as a known gap).
//
// This is the missing half. A grader awards marks per (attempt, question); the
// award is stored here and read back by the SAME scorer every other path uses,
// which is the property that matters: a regrade, a late judge verdict, or the
// expiry sweep re-runs scoring and the human's mark survives, because it is an
// input to scoring rather than a patch applied after it.
//
// WHY ITS OWN COLLECTION, NOT THE ATTEMPT DOCUMENT: a student may read their
// own attempt. The mark itself must reach them — that is the point — and it
// does, through gradedAnswers and the totals. What must not is the grader's
// identity and the internal note trail, for the same reason attemptVerdicts
// and provisionalGrades are separate collections. Feedback written FOR the
// student is copied into gradedAnswers under the review-audience gate; every
// other field stays here, staff-only.

interface ManualMarkDoc {
  attemptId: string;
  questionId: string;
  assessmentId: string;
  instituteId: string | null;
  studentId: string | null;
  /** Marks awarded by the human. Clamped to [0, question marks] on write. */
  marksAwarded: number;
  /** Grader's note. Reaches the student only when review is allowed. */
  feedback?: string;
  gradedBy: string;          // auth uid
  gradedByRole: string;      // role claim at time of marking
  gradedAt: string;          // ISO — last award
  firstGradedAt: string;     // ISO — first award, kept across re-marks
  /** How many times this answer has been re-marked. Audit signal, not a lock. */
  revision: number;
}

/** Composite id, same shape and same reasoning as codeVerdictDocId. */
export function manualMarkDocId(attemptId: string, questionId: string): string {
  return `${attemptId}__${questionId}`;
}

/** Longest grader note we will store. Generous for prose, bounded for a doc. */
const MAX_FEEDBACK_CHARS = 4000;

/**
 * A human's award, made safe for arithmetic.
 *
 * Bounded to [0, the question's marks]. The floor is zero even where the
 * grading policy allows negative marking: a penalty is a rule the machine
 * applies to a wrong answer it recognised, and extending it to "a person
 * thought this essay was bad" is a different thing that nobody asked for. A
 * grader who wants to award nothing awards nothing.
 *
 * Rounded to two decimals because the result is compared against a passing
 * score, and 7.333333333 in a total is a float artefact reaching a transcript.
 */
function clampManualAward(raw: number, maxMarks: number): number {
  if (!Number.isFinite(raw)) return 0;
  const rounded = Math.round(raw * 100) / 100;
  return Math.min(Math.max(rounded, 0), Math.max(0, maxMarks));
}

/**
 * Which engines a human is allowed to mark by hand.
 *
 * Text always: nothing else can mark it. Code ONLY as a fallback, and the
 * caller decides — see setManualMark, which permits it only once the judge has
 * given up. A hand mark that could silently outrank a live judge verdict would
 * make two sources of truth for the same number.
 */
function isManuallyMarkable(engine: string | undefined): boolean {
  return engine === 'text' || engine === 'code';
}

/**
 * Load the human marks for one attempt.
 *
 * Absence means "not marked yet" — never zero — exactly as with verdicts. A
 * paper with nothing manually markable costs no reads at all.
 */
async function loadManualMarks(
  db: FirebaseFirestore.Firestore,
  attemptId: string,
  questionMap: Map<string, QuestionDoc>,
): Promise<Map<string, ManualMarkDoc>> {
  const out = new Map<string, ManualMarkDoc>();
  const qIds: string[] = [];
  questionMap.forEach((q, id) => { if (isManuallyMarkable(q.engine)) qIds.push(id); });
  if (qIds.length === 0) return out;

  const byDocId = new Map(qIds.map((qid) => [manualMarkDocId(attemptId, qid), qid]));
  const ids = Array.from(byDocId.keys());
  for (let i = 0; i < ids.length; i += 300) {
    const refs = ids.slice(i, i + 300).map((id) => db.collection('attemptManualMarks').doc(id));
    const snaps = await db.getAll(...refs);
    snaps.forEach((snap) => {
      if (!snap.exists) return;
      const qid = byDocId.get(snap.id);
      const data = snap.data() as ManualMarkDoc | undefined;
      if (qid && data && typeof data.marksAwarded === 'number') out.set(qid, data);
    });
  }
  return out;
}

/**
 * An answer the candidate emptied, or never really made.
 *
 * The editor writes { language, source: '' } when the buffer is still the
 * starter or has been cleared, because the renderer's answer channel has no
 * "no answer" arm. Both sides read that the same way, and this is the server
 * half: an empty source is a BLANK, not a submission. Without it a candidate
 * who deleted their code would queue a judge run that cannot run and land the
 * paper in manual review for a question they did not attempt.
 */
function isEmptyCodeAnswer(q: QuestionDoc, ans: AttemptAnswerDoc): boolean {
  if (q.engine !== 'code') return false;
  const v = ans.value as Record<string, string> | undefined;
  const source = v && typeof v === 'object' && !Array.isArray(v) ? v.source : undefined;
  return typeof source !== 'string' || source.trim().length === 0;
}

/** Does this paper contain a coding answer that will need a judge? */
function attemptHasCodingAnswer(
  answers: Record<string, AttemptAnswerDoc> | undefined,
  questionMap: Map<string, QuestionDoc>,
): boolean {
  if (!answers) return false;
  return Object.entries(answers).some(([qid, a]) => {
    const q = questionMap.get(qid);
    return q?.engine === 'code' && !isEmptyCodeAnswer(q, a);
  });
}

/**
 * THE COMPOSITION ROOT — the one place that decides which judge runs code.
 *
 * Returns NullJudgeAdapter today, which is a deliberate shipping state rather
 * than a stub: the entire pipeline runs against it, and every submission
 * becomes a paper awaiting review instead of a zero. Selecting a real provider
 * is a change to this function and nothing else — that is the whole point of
 * JudgeAdapter, and the reason the provider comparison never blocked this work.
 */
let judgeAdapterInstance: JudgeAdapter | null = null;
function getJudgeAdapter(): JudgeAdapter {
  if (judgeAdapterInstance) return judgeAdapterInstance;

  const baseUrl = JUDGE0_BASE_URL.value();
  if (!baseUrl) {
    // Unconfigured is a SAFE state, not a broken one: every submission becomes
    // a paper awaiting review rather than a zero. Deploying the pipeline before
    // the judge cluster exists is therefore fine, and so is losing the config.
    //
    // C-10: safe is not the same as silent. This branch used to say nothing at
    // all, so "is the judge wired?" could only be answered by reading a verdict
    // document — and a deploy from a machine without functions/.env.<project>
    // degrades to exactly here, with no error, because JUDGE0_BASE_URL defaults
    // to ''. One line at selection makes that visible in the log.
    console.warn('[judge] adapter=null reason=JUDGE0_BASE_URL is not set; submissions will go to manual review.');
    judgeAdapterInstance = new NullJudgeAdapter();
    return judgeAdapterInstance;
  }

  const authToken = JUDGE0_AUTH_TOKEN.value();
  if (!authToken) {
    // A Judge0 with no token is a Judge0 anyone who finds it can run code on.
    // Refusing to use it is deliberate — an unauthenticated judge is worse than
    // no judge, and the failure is loud in logs while staying safe for students.
    console.error('[judge] adapter=null reason=JUDGE0_BASE_URL is set but JUDGE0_AUTH_TOKEN is empty; refusing to use an unauthenticated judge.');
    judgeAdapterInstance = new NullJudgeAdapter();
    return judgeAdapterInstance;
  }

  // Logged so a healthy selection is as visible as a failed one. Without this
  // the two states are indistinguishable in the log, which is how a whole
  // afternoon goes into checking a connector that was never the problem. The
  // base URL is a private 10.x address, not a secret; the token is never
  // logged.
  console.info(`[judge] adapter=judge0 baseUrl=${baseUrl}`);
  judgeAdapterInstance = new Judge0Adapter({ baseUrl, authToken });
  return judgeAdapterInstance;
}

/**
 * Install the adapter. This is the seam a provider is selected through — by
 * configuration when one exists, and by the headless suites, which need a
 * judge whose verdicts they control in order to prove the pipeline settles a
 * paper and rewrites its marks. Passing null restores the default.
 */
export function setJudgeAdapter(adapter: JudgeAdapter | null): void {
  judgeAdapterInstance = adapter;
}

/** Assemble the submission for one coding answer, clamping the author's limits. */
function buildCodeSubmission(
  q: QuestionDoc,
  ans: QuestionAnswerDoc,
  value: AttemptAnswerDoc['value'],
  ref: string,
): JudgeSubmission | null {
  const v = (value ?? {}) as Record<string, string>;
  const language = v.language;
  const source = v.source;
  // A submission we cannot even form is not a judging failure — there is
  // nothing to run. Returning null leaves it unjudged and therefore in manual
  // review, which is where an answer nobody can execute belongs.
  if (!isJudgeLanguage(language) || typeof source !== 'string' || source.length === 0) return null;
  return {
    language,
    source,
    tests: ans.tests ?? [],
    limits: clampLimits(q.codeSpec?.limits),
    ref,
  };
}

interface GradedAnswerOut {
  isCorrect: boolean | null;
  marksAwarded: number;
  /** G-04: the question document no longer exists; excluded from the paper. */
  unavailable?: boolean;
  correctIds?: string[];
  correctPairs?: CorrectPair[];
  modelAnswer?: string;
  /**
   * The grader's note on a hand-marked answer.
   *
   * Written under the same review gate as modelAnswer, and for the same
   * reason: gradedAnswers lands on the attempt document, which the student
   * reads directly. An exam whose review audience excludes students shows
   * them the mark (through marksAwarded and the totals) but not the prose.
   */
  feedback?: string;
  /** True when this mark came from a human rather than the scorer. */
  manuallyMarked?: boolean;
}

interface ScoresOut {
  total: number;
  available: number;
  percentage: number;
  /**
   * Pass verdict, or NULL while the paper is not finished being marked (G-02).
   *
   * `false` used to be returned for a paper carrying unmarked essay questions,
   * because `percentage` counts them as zero. A student who answered every
   * machine-markable question correctly was told "✗ Failed" next to a badge
   * saying the paper still needed manual review — two statements that cannot
   * both be true, on the screen that matters most to them.
   *
   * Null is the honest third state, and it is set HERE rather than left for
   * each UI to infer from requiresManualReview: making it structural is the
   * same reasoning that put provisional grades in their own collection instead
   * of trusting every reader to remember.
   */
  passed: boolean | null;
  bySection: Array<{
    sectionId: string;
    sectionName: string;
    totalQuestions: number;
    answeredQuestions: number;
    marksAwarded: number;
    marksAvailable: number;
  }>;
  requiresManualReview: boolean;
}

// Core scoring pass over one attempt's answers.
//   • Answer-key fields are exposed in gradedAnswers ONLY when the assessment
//     allows review — gradedAnswers is written into the attempt doc, which
//     the student can read directly, so unconditional exposure leaks the key
//     regardless of showResults/allowReview (and enables key-harvesting on
//     multi-attempt exams, since the paper is frozen at publish time).
//   • invalidatedQuestionIds (regrade flow): those questions award FULL marks
//     to every attempt, isCorrect stays null ("correctness" is undefined for
//     an invalidated question). This replaces the old client-side flat bonus
//     — same totals, but bySection now stays consistent with the total.
function scoreAttemptAnswers(params: {
  sections: EffectiveSection[];
  questionMap: Map<string, QuestionDoc>;
  answerMap: Map<string, QuestionAnswerDoc>;
  answers: Record<string, AttemptAnswerDoc> | undefined;
  passingScore: number | undefined;
  exposeKeysToStudent: boolean;
  invalidatedQuestionIds?: Set<string>;
  // Frozen grading policy (negative marking + blank handling). Absent = legacy
  // scoring (no penalty, blank = 0), so existing exams are unaffected.
  gradingConfig?: AssessmentGradingConfigS;
  /**
   * Judge verdicts for this attempt's coding answers, keyed by question id.
   *
   * OPTIONAL, AND ABSENT MEANS "NOT JUDGED YET" — never "scored zero". A
   * caller that does not load verdicts (any of the non-finalising score paths)
   * therefore sends coding questions to manual review rather than marking them
   * wrong, which is the same safe direction the judge outage takes.
   */
  codeVerdicts?: Map<string, JudgeVerdict>;
  /**
   * Human marks for this attempt, keyed by question id.
   *
   * OPTIONAL, AND ABSENT MEANS "NOT MARKED YET" — the same contract as
   * codeVerdicts, for the same reason. Every finalising path must pass these:
   * a scorer that cannot see the human's mark would re-derive the paper
   * without it and silently erase work a person did, which is the one failure
   * mode this whole mechanism exists to make impossible.
   */
  manualMarks?: Map<string, ManualMarkDoc>;
}): { scores: ScoresOut; gradedAnswers: Record<string, GradedAnswerOut> } {
  const { sections, questionMap, answerMap, answers, passingScore, exposeKeysToStudent } = params;
  const codeVerdicts = params.codeVerdicts ?? new Map<string, JudgeVerdict>();
  const manualMarks = params.manualMarks ?? new Map<string, ManualMarkDoc>();
  const invalidated = params.invalidatedQuestionIds ?? new Set<string>();
  const gradingConfig = params.gradingConfig;

  let totalAwarded   = 0;
  let totalAvailable = 0;
  let requiresManualReview = false;
  const bySection: ScoresOut['bySection'] = [];
  const gradedAnswers: Record<string, GradedAnswerOut> = {};

  const exposeKeys = exposeKeysToStudent;

  for (const sec of sections) {
    let sectionAwarded = 0;
    let sectionAvailable = 0;
    let answered = 0;

    for (const aq of sec.questions) {
      const q   = questionMap.get(aq.questionId);
      const ans = answerMap.get(aq.questionId);
      const studentAnswer = answers?.[aq.questionId];

      // ── G-04: the question document is gone ───────────────────────
      //
      // Questions are soft-deletable and purgeable, so a paper can outlive one
      // of its own questions. The marks used to be added to the denominator
      // regardless, and the answered branch then could not run — so a student
      // who had answered it lost those marks silently, with nothing anywhere
      // saying why. Measured at 10 of 20 marks on a two-question paper.
      //
      // A mark nobody can award is not a mark the student failed to earn. It
      // leaves the denominator entirely, and the paper is flagged so a human
      // sees that it shrank rather than discovering it from a suspiciously
      // round percentage.
      if (!q) {
        requiresManualReview = true;
        gradedAnswers[aq.questionId] = {
          isCorrect: null,
          marksAwarded: 0,
          unavailable: true,
        };
        continue;
      }

      sectionAvailable += aq.marks;
      totalAvailable   += aq.marks;

      // Resolve the grading policy for THIS question (exam → section → row).
      // Difficulty is read from the server-fetched question doc (trustworthy),
      // defaulting to 'medium' when absent. No config → NO_PENALTY equivalent.
      const difficulty = (q?.difficulty === 'easy' || q?.difficulty === 'hard') ? q.difficulty : 'medium';
      const policy = resolveGradingPolicyS(gradingConfig, sec.id, difficulty, q?.engine === 'code');

      const exposed: GradedAnswerOut = {
        isCorrect: null,
        marksAwarded: 0,
      };
      if (exposeKeys && q && ans) {
        if (q.engine === 'mcq')   exposed.correctIds   = ans.correctIds   ?? [];
        if (q.engine === 'match') exposed.correctPairs = ans.correctPairs ?? [];
        if (q.engine === 'text')  exposed.modelAnswer  = ans.modelAnswer  ?? '';
      }

      /**
       * Apply a human's mark to this question, if one has been given.
       *
       * Returns whether it did, so each caller can fall through to manual
       * review when it did not. `isCorrect` is set to a BOOLEAN rather than
       * left null on purpose: null is what the readers use to mean "nobody has
       * marked this", and every existing reader already buckets a boolean plus
       * marksAwarded into correct / partial / wrong. A hand-marked essay
       * therefore renders as an ordinary marked question everywhere, with no
       * reader needing to learn about manual marking at all.
       */
      const applyManualMark = (): boolean => {
        const mark = manualMarks.get(aq.questionId);
        if (!mark) return false;
        const award = clampManualAward(mark.marksAwarded, aq.marks);
        sectionAwarded += award;
        totalAwarded   += award;
        exposed.marksAwarded   = award;
        exposed.isCorrect      = award >= aq.marks;
        exposed.manuallyMarked = true;
        if (exposeKeys && mark.feedback) exposed.feedback = mark.feedback;
        return true;
      };

      if (invalidated.has(aq.questionId)) {
        // Invalidated question — full marks for everyone, regardless of
        // whether it was answered (matches the old flat-bonus semantics).
        if (studentAnswer) answered++;
        sectionAwarded += aq.marks;
        totalAwarded   += aq.marks;
        exposed.marksAwarded = aq.marks;
        exposed.isCorrect    = null;
      } else if (studentAnswer && q && ans && !isEmptyCodeAnswer(q, studentAnswer)) {
        answered++;
        if (q.engine === 'mcq') {
          const outcome = scoreMCQMultiplier(q, ans, studentAnswer.value);
          const award = awardFor(outcome, policy, aq.marks);
          sectionAwarded += award;
          totalAwarded   += award;
          exposed.marksAwarded = award;
          exposed.isCorrect    = outcome.isCorrect;
        } else if (q.engine === 'match') {
          const outcome = scoreMatchMultiplier(ans, studentAnswer.value);
          const award = awardFor(outcome, policy, aq.marks);
          sectionAwarded += award;
          totalAwarded   += award;
          exposed.marksAwarded = award;
          exposed.isCorrect    = outcome.isCorrect;
        } else if (q.engine === 'code') {
          // ── Coding: graded from a judge verdict, or not at all ──────
          //
          // Three outcomes, and only one of them awards marks:
          //
          //   • a real verdict over a gradable suite → partial credit from the
          //     pass rate, through the SAME awardFor the other engines use;
          //   • no verdict yet (async judge still running, or this call path
          //     never loaded them) → manual review;
          //   • a verdict that is not a verdict — judge unreachable, adapter
          //     malfunction, or an authoring mistake that left the suite with
          //     no weight → manual review.
          //
          // The last two are why codeOutcomeFor returns null rather than a
          // zero-multiplier outcome. Falling through to `awardFor` with a
          // manufactured zero would mark a candidate wrong for an outage, and
          // would do it silently: every number downstream stays well-formed.
          //
          // Note what is NOT written to `exposed`: no per-test detail of any
          // kind. gradedAnswers lands on the attempt document, which a student
          // can read directly, and a hidden test's pass/fail list is an oracle
          // that reconstructs the suite by bisection. Staff read the full
          // verdict from its own collection instead.
          const verdict = codeVerdicts.get(aq.questionId);
          const outcome = verdict ? codeOutcomeFor(verdict, ans.tests ?? []) : null;
          if (outcome) {
            const award = awardFor(outcome, policy, aq.marks);
            sectionAwarded += award;
            totalAwarded   += award;
            exposed.marksAwarded = award;
            exposed.isCorrect    = outcome.isCorrect;
          } else if (!applyManualMark()) {
            // No verdict and no human mark. Still the judge's to answer, or —
            // once it has exhausted its retries — a grader's, through the same
            // hand-marking path an essay uses.
            requiresManualReview = true;
          }
        } else if (!applyManualMark()) {
          // text engine — no machine can mark this, and no human has yet
          requiresManualReview = true;
        }
      } else {
        // BLANK / unanswered — apply the policy's blankScore (default 0), NEVER
        // the wrong-answer penalty. A student can't lose marks for a question
        // they never attempted. Left out of `answered`.
        if (policy.blankScore !== 0) {
          sectionAwarded += policy.blankScore;
          totalAwarded   += policy.blankScore;
          exposed.marksAwarded = policy.blankScore;
        }
      }

      gradedAnswers[aq.questionId] = exposed;
    }

    bySection.push({
      sectionId: sec.id,
      sectionName: sec.name,
      totalQuestions: sec.questions.length,
      answeredQuestions: answered,
      marksAwarded: sectionAwarded,
      marksAvailable: sectionAvailable,
    });
  }

  // Assessment-level floor: the headline total can never go below zero, even
  // if penalties exceeded earned marks. Sections are NOT floored — a section
  // may be internally net-negative (visible to staff as a diagnostic); only
  // the aggregate the student sees is clamped. (Seerat's decision.)
  const flooredTotal = Math.max(0, totalAwarded);

  const percentage = totalAvailable > 0
    ? Math.round((flooredTotal / totalAvailable) * 100 * 10) / 10
    : 0;
  // G-02: no verdict until every mark that CAN be awarded has been.
  // requiresManualReview means a human still owes this paper marks, so any
  // pass/fail statement now is a statement about marking that has not happened.
  const passed = requiresManualReview
    ? null
    : passingScore !== undefined
      ? percentage >= passingScore
      : true;

  return {
    scores: {
      total: flooredTotal,
      available: totalAvailable,
      percentage,
      passed,
      bySection,
      requiresManualReview,
    },
    gradedAnswers,
  };
}

export const gradeAttempt = onCall<GradeAttemptData>(
  { ...CALLABLE_BASE, secrets: [SEB_SIGNING_SECRET] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

    const callerRole        = request.auth.token.role        as Role   | undefined;
    const callerStudentId   = request.auth.token.studentId   as string | undefined;
    const callerInstituteId = request.auth.token.instituteId as string | undefined;

    const { attemptId, reason, terminateReason, lastSectionId, lastSectionTimeUsed } =
      request.data || ({} as GradeAttemptData);

    if (!attemptId) throw new HttpsError('invalid-argument', 'attemptId is required.');
    const validReasons: GradeReason[] = [
      'manual', 'time_expired', 'window_closed', 'violation_limit', 'terminated',
    ];
    if (!validReasons.includes(reason)) {
      throw new HttpsError('invalid-argument', 'Invalid reason.');
    }

    const db = getFirestore();

    const attemptRef = db.collection('attempts').doc(attemptId);
    const attemptSnap = await attemptRef.get();
    if (!attemptSnap.exists) throw new HttpsError('not-found', 'Attempt not found.');
    const attempt = attemptSnap.data() as {
      assessmentId: string;
      studentId: string;
      instituteId: string;
      status: string;
      answers: Record<string, AttemptAnswerDoc & { answeredAt?: string }>;
      lastHeartbeatAt?: string | null;
      heartbeatGaps?: { count?: number; maxSeconds?: number } | null;
      fingerprintDrift?: { count?: number; changes?: string[] } | null;
      // Counters read for the integrity-threshold gate below, alongside the
      // event array the heartbeat analysis already used.
      integrityLog?: {
        violations?: Array<{ timestamp?: string }>;
        tabSwitches?: number;
        focusLosses?: number;
        fullscreenExits?: number;
        autoTerminated?: boolean;
      } | null;
      createdAt?: string;
      freezeState?: { frozen?: boolean } | null;
      freezes?: FreezeLedgerEntry[];
      securityConfig?: { tier?: string; requireSEB?: boolean } | null;
      gradingConfig?: AssessmentGradingConfigS;   // frozen at startExam
      // A-09: the played section set, used to reject a caller-named
      // `lastSectionId` that is not part of this attempt.
      sectionIds?: string[];
      // Read for the trapped-frozen escape hatch below. Loose shape: a
      // Firestore Timestamp over the wire, an ISO string on legacy attempts,
      // absent on attempts that predate the field.
      answersLockedAfter?: unknown;
    };

    // AuthZ — student owner OR grader in same institute OR web owner
    const isStudentOwner =
      callerRole === 'student' && callerStudentId === attempt.studentId;
    const isGrader =
      callerRole === 'webOwner'
      || ((callerRole === 'institute' || callerRole === 'faculty')
          && callerInstituteId === attempt.instituteId);
    if (!isStudentOwner && !isGrader) {
      throw new HttpsError('permission-denied', 'Not authorized to grade this attempt.');
    }

    // Phase 3 — SEB binds the EXAM-TAKER, not staff. A grader finalising or
    // re-grading an attempt works from a normal browser; requiring SEB of them
    // would make submitted high-stake attempts ungradeable.
    if (isStudentOwner) {
      assertSEB(request.data?.sebToken, request.auth.uid, attempt.securityConfig?.requireSEB, attempt.assessmentId);
    }

    // Idempotency — a non-grader may never re-finalise a finished attempt.
    // (Audit 2026-07-17, N9: the previous `reason !== 'terminated'` exception
    // let a student flip their own SUBMITTED attempt to 'terminated' with
    // attacker-chosen reason text. The exception existed for the race where
    // the shell's terminate call lands after an auto-submit already graded
    // the attempt — that race is now an idempotent no-op instead of a
    // status rewrite. Graders keep manual regrade rights.)
    // ── Escape hatch for a trapped frozen attempt (D-02, Phase 1) ──
    //
    // status:'frozen' had an entrance and no exit. firestore.rules require
    // status=='in_progress' on both sides of a student update, so a frozen
    // student cannot save an answer; the hourly sweep queried in_progress
    // only, so it never saw them; and this guard refused their finalise. A
    // student whose antivirus tripped the extension check was blocked from
    // answering, watched their clock drain, and could neither submit nor be
    // closed — stuck until a human noticed.
    //
    // Gated on the deadline having ALREADY passed, which is what keeps this
    // from becoming an escape from invigilation: while there is still time on
    // the clock a frozen student must wait for the freeze to be cleared, and
    // only once their window is provably over may they close their own
    // sitting. Whatever they answered before the freeze stands.
    //
    // Doctrine D8: every automatic state a student can be put into must have
    // an automatic exit, on a bounded timer, in the student's favour.
    //
    // Loaded BEFORE the freeze/idempotency guards (moved 2026-08-03): the
    // trapped-frozen decision below is now the RESOLVER's, and the resolver
    // needs the assessment. One extra read on the idempotent no-op path is
    // the cost; a guard that reasons from the same clock the rest of the
    // system runs on is what it buys.
    const assessmentSnap = await db.collection('assessments').doc(attempt.assessmentId).get();
    if (!assessmentSnap.exists) throw new HttpsError('not-found', 'Assessment not found.');
    // A-05 / A-06: the paper and clocks THIS attempt was given, not whatever
    // the assessment says now. Legacy attempts carry no snapshot and fall
    // through to the live document, exactly as before.
    const assessment = examContractFor(
      attempt as unknown as Record<string, unknown>,
      assessmentSnap.data() as Record<string, unknown>,
    ) as GradingAssessmentDoc;

    // ── Is this sitting actually OVER? Ask the resolver ────────────
    //
    // The old test was attemptWindowClosed(), which reads answersLockedAfter —
    // the section/overall lock, NOT the availability window. Those are
    // precisely the clocks an open freeze HOLDS (4.3), so "lock instant has
    // passed while frozen" no longer means the sitting is over; it means the
    // pause is old. Deciding the escape hatch on it would reopen the hole F5
    // closed, through the guard built to be its one exception.
    //
    // resolve() knows the difference: while a freeze is open it pins every
    // student clock at the freeze instant and races only the availability
    // window against real time (A10). 'ended' therefore means one of exactly
    // two things — the window shut, or the sitting was already over before
    // the pause began — and both are states where finalising is right.
    //
    // Fails soft to the previous lock-based reading: a resolver fault must
    // never leave a genuinely trapped student with no exit (D8).
    let sittingOver: boolean;
    try {
      const v = resolveTiming(
        toCoreAttempt(attempt as unknown as Record<string, unknown>),
        toCoreAssessment(assessment as unknown as Record<string, unknown>),
        Date.now(),
      );
      sittingOver = v.kind === 'ended';
    } catch {
      sittingOver = attemptWindowClosed(attempt);
    }
    const isTrappedFrozen = attempt.status === 'frozen' && sittingOver;

    // ── A paused student may not end their own sitting (F5) ────────
    //
    // The guard below tests `status !== 'in_progress'`, and a freeze now puts
    // the attempt in 'frozen', so this is mostly closed by construction. It is
    // stated explicitly anyway because the ONE exception — a sitting the
    // resolver says is OVER — must stay scoped to the case that justifies it.
    // While there is still held time on the clock, a paused student waits for
    // the human who paused them; once the sitting is provably over, refusing
    // their finalise would strand them (D8). A grader is unaffected either
    // way; ending a paused sitting is a legitimate staff action.
    const openFreeze = (attempt.freezes ?? []).find((f) => !f.endedAt);
    if (openFreeze && !isGrader && !sittingOver) {
      throw new HttpsError('failed-precondition',
        'ATTEMPT_PAUSED: this sitting has been paused by an invigilator and ' +
        'cannot be submitted until it is resumed.');
    }

    if (attempt.status !== 'in_progress' && !isGrader && !isTrappedFrozen) {
      if (reason === 'terminated') {
        return { ok: true, alreadyFinalized: true, status: attempt.status };
      }
      throw new HttpsError('failed-precondition', 'Attempt already finalised.');
    }

    const sections = normalizeSections(assessment);

    // Collect all question IDs referenced by the assessment
    const qIds = Array.from(new Set(
      sections.flatMap((s) => s.questions.map((q) => q.questionId))
    ));

    const { questionMap, answerMap } = await loadQuestionAndAnswerMaps(db, qIds);
    const codeVerdicts = await loadCodeVerdicts(db, attemptId, questionMap);

    const { scores, gradedAnswers } = scoreAttemptAnswers({
      sections,
      questionMap,
      answerMap,
      codeVerdicts,
      // Normally empty on a first finalisation — an answer cannot have been
      // marked before it was submitted. Loaded anyway because gradeAttempt is
      // also the re-finalise path, and a scorer that forgets the human's mark
      // is how one gets erased.
      manualMarks: await loadManualMarks(db, attemptId, questionMap),
      answers: attempt.answers,
      passingScore: assessment.passingScore,
      // Keys land in the student's own attempt only when STUDENTS are in
      // the review audience (N5 final form).
      exposeKeysToStudent: reviewAudienceAllows(assessment, 'students'),
      // Grade under the policy FROZEN on the attempt at start; fall back to the
      // live assessment for attempts that predate the freeze (older in-progress).
      gradingConfig: attempt.gradingConfig ?? assessment.gradingConfig,
    });

    const nowIso = new Date().toISOString();

    // ══════════════════════════════════════════════════════════════
    // INTEGRITY THRESHOLD — the server decides what "clean" means
    // ══════════════════════════════════════════════════════════════
    //
    // Termination used to be decided entirely in the browser: the shell
    // counted warnings in React state and called this function with
    // reason:'terminated' when it reached three. This function believed it,
    // and — the actual hole — believed reason:'manual' just as readily.
    //
    // So a client that never sent the terminate call got a clean submission.
    // Not only by tampering: `warningCount` is component state, so a reload
    // reset the tally, and until the fix in this same change a fullscreen exit
    // could not trigger termination at all. In every one of those cases the
    // TRUE count was sitting in integrityLog — written by logViolation under
    // the Admin SDK, unreachable from any client — and nothing read it at the
    // one moment it decided the outcome.
    //
    // ── WHY IT RE-LABELS RATHER THAN REFUSES ──────────────────────
    //
    // The obvious move is to throw. That would be wrong: this is the call the
    // student pressed Submit on, and refusing it leaves a real paper unsaved
    // and ungraded in a browser that has nowhere else to put it. The answers
    // are already scored above; what the threshold changes is the VERDICT, not
    // whether the work is kept. So the attempt closes, the marks stand, and it
    // closes as `terminated` with the reason recorded.
    //
    // ── WHY ONLY THE STUDENT'S OWN CALL ───────────────────────────
    //
    // A grader finalising or re-grading an attempt is a human who can see the
    // integrity log and is deciding in spite of it. Overriding them would make
    // a reviewed, deliberately-accepted paper flip back to terminated on every
    // regrade, and would take a judgement call away from the only party
    // qualified to make it.
    //
    // ── WHY PRACTICE IS EXEMPT ────────────────────────────────────
    //
    // 'mock' already skips the heartbeat and code telemetry because rehearsal
    // is not assessed. Termination is the same argument. A student practising
    // on a phone — which mock exists to permit — blurs the window every time
    // the on-screen keyboard opens, and three of those finalised their
    // practice paper as `terminated`.
    //
    // The counters still fill and the violations are still stored, so the
    // rehearsal still shows the student (and the faculty member who set it)
    // exactly what would have happened. Only the verdict is withheld. Read
    // from the attempt's FROZEN securityConfig, like every other decision at
    // grade time, so re-tiering the assessment afterwards cannot retroactively
    // terminate a paper that was sat as practice.
    const isPractice = (attempt.securityConfig as { tier?: string } | undefined)?.tier === 'mock';
    const integrityWarnings = countIntegrityWarnings(attempt.integrityLog);
    const overIntegrityThreshold =
      isStudentOwner
      && !isGrader
      && !isPractice
      && reason !== 'terminated'
      && integrityWarnings >= MAX_INTEGRITY_WARNINGS_S;

    const effectiveReason: GradeReason = overIntegrityThreshold ? 'terminated' : reason;

    const status =
      effectiveReason === 'manual'     ? 'submitted'
      : effectiveReason === 'terminated' ? 'terminated'
      : 'auto_submitted';

    const updates: Record<string, unknown> = {
      status,
      submittedAt: nowIso,
      updatedAt: nowIso,
      scores,
      gradedAnswers,
    };

    if (overIntegrityThreshold) {
      // Distinguishable in the record from a shell-driven termination: this one
      // says the client never asked. A reviewer seeing it knows the count was
      // reached without the browser acting on it, which is itself worth
      // knowing — it is the signature of a patched client, a reload-reset
      // tally, or a detector the shell failed to act on.
      updates['integrityLog.thresholdEnforcedServerSide'] = true;
      console.warn(
        '[gradeAttempt] integrity threshold enforced server-side',
        attemptId, `requested=${reason}`, `warnings=${integrityWarnings}`,
      );
    }

    // ── Queue the paper's coding answers for judging ──────────────
    //
    // Judging cannot happen here. A judge is slow, remote and allowed to be
    // down, and this callable is what a student presses "Submit" on — blocking
    // it on a sandbox would mean a judge outage prevents finishing an exam.
    // So finalisation records that judging is owed and returns; the sweep does
    // the work and a regrade turns the verdicts into marks.
    //
    // The flag is set from the ANSWERS rather than from requiresManualReview,
    // which is also true of a paper full of essays and would have the sweep
    // picking up work it can never do.
    if (attemptHasCodingAnswer(attempt.answers, questionMap)) {
      updates.codeJudgePending = true;
    }

    // effectiveReason, not reason: an attempt re-labelled by the threshold gate
    // above must carry the same terminal bookkeeping as one the shell asked to
    // terminate, or it would land in `terminated` status with no autoTerminated
    // flag and no stated reason — the exact half-written record that makes an
    // examiner distrust the whole log.
    if (effectiveReason === 'terminated') {
      updates['integrityLog.autoTerminated'] = true;
      const statedReason = terminateReason
        ?? (overIntegrityThreshold
          ? `Exam terminated: ${integrityWarnings} integrity violations recorded (limit ${MAX_INTEGRITY_WARNINGS_S}).`
          : undefined);
      if (statedReason) updates['integrityLog.terminatedReason'] = statedReason;
    }
    // ── Closing timings for the section the student was in (A-09) ──
    //
    // `lastSectionId` is caller-supplied and was written as a dot-path with no
    // membership check, so `lastSectionId: 'NOT_A_SECTION'` produced a
    // sectionTimings row for a section that does not exist. Cosmetic — the
    // attempt is terminal and nothing reads unknown keys — but it is
    // unvalidated caller input shaping stored state, and it pollutes any later
    // analytics over sectionTimings.
    //
    // Ignored rather than rejected: this is the tail of a finalise that has
    // already graded the paper, and throwing here would fail a submission over
    // a bookkeeping field. A bad id is dropped and logged; the attempt still
    // closes, which is the outcome that matters to the student.
    if (lastSectionId && typeof lastSectionTimeUsed === 'number') {
      const known = Array.isArray(attempt.sectionIds) ? attempt.sectionIds : [];
      if (known.includes(lastSectionId)) {
        updates[`sectionTimings.${lastSectionId}.submittedAt`]     = nowIso;
        updates[`sectionTimings.${lastSectionId}.timeUsedSeconds`] =
          Math.max(0, Math.floor(lastSectionTimeUsed));
      } else {
        console.warn('[gradeAttempt] ignoring lastSectionId outside the attempt',
          attemptId, lastSectionId);
      }
    }

    // ── Freeze flag (Phase 1c) ────────────────────────────────────
    // Record if this attempt was finalized while still paused. Detective flag
    // for the reviewer — not blocking.
    //
    // The ledger is checked as well as freezeState (F5). freezeState is only
    // written by the extension path, so an attempt finalised during an
    // INVIGILATOR pause — the case a reviewer most needs to see — carried no
    // flag at all and closed looking like an ordinary manual submit.
    if (attempt.freezeState?.frozen === true || openFreeze) {
      updates['integrityLog.finalizedWhileFrozen'] = true;
    }

    // ── A terminal attempt carries no live freeze state (2026-08-03) ─
    //
    // Nothing that finalised an attempt ever cleared these, and the roster's
    // deriveRosterStatus checks `frozenAt` BEFORE the terminal status — so a
    // sitting finalised while paused (grader action, trapped-frozen escape,
    // or the sweep) showed as "frozen" in the roster forever, over a status
    // of submitted. The pause is over by definition: the sitting it paused no
    // longer exists.
    //
    // The ledger entry is CLOSED, not deleted — it is the record that the
    // pause happened. grantedMs 0: finalisation grants nothing, because
    // there is no remaining sitting for credit to extend, and inventing a
    // grant here would be the sweep's retired stale-freeze mistake again.
    if (openFreeze || attempt.freezeState?.frozen === true) {
      updates.frozenAt = FieldValue.delete();
      updates.frozenBy = FieldValue.delete();
      updates.frozenReason = FieldValue.delete();
      updates.freezeState = { frozen: false, clearedBy: 'finalize', since: nowIso };
      updates.resumeRequiresVerification = false;
      if (openFreeze) {
        const startMsF = Date.parse(openFreeze.startedAt);
        updates.freezes = (attempt.freezes ?? []).map((f) => f.endedAt ? f : ({
          ...f,
          endedAt: nowIso,
          elapsedMs: Number.isFinite(startMsF)
            ? Math.max(0, Date.parse(nowIso) - startMsF) : 0,
          grantedMs: 0,
          decidedBy: isGrader ? request.auth!.uid : null,
          decidedAt: nowIso,
          note: `closed at finalisation (${reason ?? 'auto'})`,
        }));
      }
    }

    // ── Timing analytics (Phase 1b) ───────────────────────────────
    // Detective signal only — recorded for the reviewer, never auto-actioned.
    // Uses answeredAt (already stored per answer) + lastHeartbeatAt (Phase 1a).
    const answerTimes = Object.values(attempt.answers ?? {})
      .map((ans) => (ans.answeredAt ? Date.parse(ans.answeredAt) : NaN))
      .filter((t) => !isNaN(t))
      .sort((x, y) => x - y);
    const submitMs = Date.parse(nowIso);
    const totalAnswers = answerTimes.length;
    const burstLast30s = answerTimes.filter((t) => submitMs - t <= 30_000).length;
    let minGapSeconds: number | null = null;
    for (let i = 1; i < answerTimes.length; i++) {
      const gap = (answerTimes[i] - answerTimes[i - 1]) / 1000;
      if (minGapSeconds === null || gap < minGapSeconds) minGapSeconds = gap;
    }
    // Mid-session silences, recorded by examHeartbeat as they happened. Before
    // that existed this pair could only ever describe the FINAL gap, because
    // lastHeartbeatAt is overwritten by each beat — so a student offline for
    // ten minutes mid-exam and back before the end scored zero here. Seeding
    // from the recorded gaps and then folding in the final one keeps a single
    // meaning for the field: every silence over the threshold, wherever it
    // fell. Absent on attempts that predate the recording, which then behave
    // exactly as before.
    let heartbeatGaps = attempt.heartbeatGaps?.count ?? 0;
    let maxHeartbeatGapSeconds = attempt.heartbeatGaps?.maxSeconds ?? 0;
    if (attempt.lastHeartbeatAt) {
      const gapToSubmit = (submitMs - Date.parse(attempt.lastHeartbeatAt)) / 1000;
      if (gapToSubmit > 60) {
        heartbeatGaps += 1;
        maxHeartbeatGapSeconds = Math.max(maxHeartbeatGapSeconds, Math.round(gapToSubmit));
      }
    }
    // ── Violation clustering ──────────────────────────────────────
    //
    // A total says how many times something happened; it cannot say whether
    // they happened together. Fifteen tab switches spread over a two-hour
    // paper is a student with a notification problem. Fifteen inside one
    // minute is a student doing something, and the two are indistinguishable
    // in the counters an examiner currently reads.
    //
    // Measured as the largest number of events falling inside any one-minute
    // window, over a sorted list — a sliding pair of indices rather than a
    // window per event, because a busy sitting can carry hundreds and this
    // runs inside grading.
    const violationTimes = (attempt.integrityLog?.violations ?? [])
      .map((v) => Date.parse((v as { timestamp?: string })?.timestamp ?? ''))
      .filter((t) => !isNaN(t))
      .sort((x, y) => x - y);
    let maxViolationsInMinute = 0;
    for (let lo = 0, hi = 0; hi < violationTimes.length; hi++) {
      while (violationTimes[hi] - violationTimes[lo] > 60_000) lo++;
      maxViolationsInMinute = Math.max(maxViolationsInMinute, hi - lo + 1);
    }

    // ── Risk score ────────────────────────────────────────────────
    //
    // DETECTIVE ONLY. Nothing auto-actions on this — it exists so a reviewer
    // opening a flagged paper starts from the evidence rather than from a
    // wall of counters. That is also why the factors are STORED rather than
    // just summed: a bare "78" tells a reviewer to be suspicious without
    // telling them of what, and a number nobody can interrogate is a number
    // that gets deferred to. Each row names itself and carries its own detail.
    const riskFactors: Array<{ code: string; points: number; detail: string }> = [];
    const addFactor = (code: string, points: number, detail: string) =>
      riskFactors.push({ code, points, detail });

    if (totalAnswers > 0 && burstLast30s / totalAnswers > 0.5) {
      addFactor('answer_burst', 40,
        `${burstLast30s} of ${totalAnswers} answers landed in the final 30 seconds`);
    }
    if (minGapSeconds !== null && minGapSeconds < 1.5 && totalAnswers > 3) {
      addFactor('answer_cadence', 30,
        `fastest gap between answers was ${minGapSeconds.toFixed(2)}s`);
    }
    if (heartbeatGaps > 0) {
      addFactor('heartbeat_gap', 30,
        `${heartbeatGaps} silence${heartbeatGaps === 1 ? '' : 's'} over 60s, longest ${maxHeartbeatGapSeconds}s`);
    }
    if (maxViolationsInMinute >= 5) {
      addFactor('violation_cluster', 25,
        `${maxViolationsInMinute} integrity events inside one minute`);
    }
    // The heaviest single factor, and deliberately so. Every other row here
    // describes behaviour that an honest student could produce on a bad day —
    // a flaky network, a fast typist, a laptop that slept. A machine that
    // changes mid-sitting is not a version of the same sitting going badly; a
    // browser session cannot move between computers. See the note on
    // sanitiseFingerprint for what still limits it.
    const drift = attempt.fingerprintDrift;
    if (drift?.count) {
      addFactor('device_drift', 50,
        `machine changed during the sitting (${(drift.changes ?? []).join('; ') || 'details unavailable'})`);
    }

    // Clamped, because the factors are independent and their weights were
    // chosen to rank papers against each other, not to sum to a probability.
    const anomalyScore = Math.min(100, riskFactors.reduce((s, f) => s + f.points, 0));

    updates.timingAnalysis = {
      totalAnswers,
      burstLast30s,
      minGapSeconds,
      heartbeatGaps,
      maxHeartbeatGapSeconds,
      maxViolationsInMinute,
      anomalyScore,
      riskFactors,
      computedAt: nowIso,
    };

    await attemptRef.update(updates);

    return { ok: true, scores };
  }
);

// ══════════════════════════════════════════════════════════════════
// regradeAttempts — server-side bulk regrade
//
// Replaces the client-side regradeAssessmentAttempts path. Runs after a
// reviewer fixes or invalidates a question: re-scores every FINISHED
// attempt of the assessment against the CURRENT answer keys, using the
// exact same scoring code as gradeAttempt (no client duplicate to drift).
//
// Reading answer keys moved server-side here is what allows the
// questionAnswers rules to be locked down to owners only.
//
// AuthZ: webOwner regrades everything; institute/faculty regrade only
// attempts in their own institute (attempts query is scoped by claim).
// Status, submittedAt, and integrity fields are preserved — only scores,
// gradedAnswers, and updatedAt change.
// ══════════════════════════════════════════════════════════════════

interface RegradeAttemptsData {
  assessmentId: string;
  invalidatedQuestionIds?: string[];
}

export const regradeAttempts = onCall<RegradeAttemptsData>(
  CALLABLE_BASE,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

    const callerRole        = request.auth.token.role        as Role   | undefined;
    const callerInstituteId = request.auth.token.instituteId as string | undefined;

    const isWebOwnerCaller = callerRole === 'webOwner';
    const isInstituteScoped =
      (callerRole === 'institute' || callerRole === 'faculty') && !!callerInstituteId;
    if (!isWebOwnerCaller && !isInstituteScoped) {
      throw new HttpsError('permission-denied', 'Only graders may regrade attempts.');
    }

    const { assessmentId, invalidatedQuestionIds } = request.data || ({} as RegradeAttemptsData);
    if (!assessmentId) throw new HttpsError('invalid-argument', 'assessmentId is required.');
    if (invalidatedQuestionIds !== undefined
        && (!Array.isArray(invalidatedQuestionIds)
            || invalidatedQuestionIds.some((id) => typeof id !== 'string'))) {
      throw new HttpsError('invalid-argument', 'invalidatedQuestionIds must be an array of strings.');
    }

    const db = getFirestore();

    const aSnap = await db.collection('assessments').doc(assessmentId).get();
    if (!aSnap.exists) throw new HttpsError('not-found', 'Assessment not found.');
    const assessment = aSnap.data() as GradingAssessmentDoc;

    // ── B-02: each attempt is regraded against the paper IT sat ─────
    //
    // Sections were resolved ONCE from the live document and applied to every
    // attempt. That is the A-05 defect surviving in the regrade path: the fix
    // reached gradeAttempt, gradeProvisional and the sweep, and the commit that
    // made it even named regradeAttempts as part of the problem — but this
    // function was left reading live. A regrade after any paper edit therefore
    // re-scored finished sittings against questions their students never saw,
    // silently, across a whole cohort at once.
    //
    // The live paper still seeds the question/answer maps: those are keyed by
    // question id, and loading them once is the cost this shape exists to
    // avoid. Ids that only a frozen paper names are topped up on demand below,
    // so the common case (no edit since publish) reads nothing extra.
    const liveSections = normalizeSections(assessment);
    const questionMap = new Map<string, QuestionDoc>();
    const answerMap = new Map<string, QuestionAnswerDoc>();
    {
      const qIds = Array.from(new Set(
        liveSections.flatMap((s) => s.questions.map((q) => q.questionId))
      ));
      const loaded = await loadQuestionAndAnswerMaps(db, qIds);
      for (const [k, v] of loaded.questionMap) questionMap.set(k, v);
      for (const [k, v] of loaded.answerMap) answerMap.set(k, v);
    }

    const invalidated = new Set(invalidatedQuestionIds ?? []);

    // Attempts to regrade — institute/faculty callers are hard-scoped to
    // their own institute regardless of what they ask for.
    let attemptsQuery: FirebaseFirestore.Query = db
      .collection('attempts')
      .where('assessmentId', '==', assessmentId);
    if (!isWebOwnerCaller) {
      attemptsQuery = attemptsQuery.where('instituteId', '==', callerInstituteId);
    }
    const attemptsSnap = await attemptsQuery.get();

    const FINISHED = new Set(['submitted', 'auto_submitted', 'terminated']);
    const nowIso = new Date().toISOString();

    let updated = 0;
    let batch = db.batch();
    let batchSize = 0;

    for (const docSnap of attemptsSnap.docs) {
      const att = docSnap.data() as {
        status?: string;
        isDeleted?: boolean;
        answers?: Record<string, AttemptAnswerDoc>;
        gradingConfig?: AssessmentGradingConfigS;   // frozen policy for this attempt
        examSnapshot?: { sections?: unknown };      // B-02: frozen paper
      };
      if (!att.status || !FINISHED.has(att.status)) continue;
      if (att.isDeleted) continue;

      // B-02: this attempt's own paper, falling through to the live document
      // when it predates examSnapshot.
      const attemptPaper = examContractFor(
        att as unknown as Record<string, unknown>,
        assessment as unknown as Record<string, unknown>,
      ) as GradingAssessmentDoc;
      const sections = normalizeSections(attemptPaper);
      const missing = Array.from(new Set(
        sections.flatMap((sec) => sec.questions.map((q) => q.questionId))
      )).filter((qid) => !questionMap.has(qid));
      if (missing.length > 0) {
        const extra = await loadQuestionAndAnswerMaps(db, missing);
        for (const [k, v] of extra.questionMap) questionMap.set(k, v);
        for (const [k, v] of extra.answerMap) answerMap.set(k, v);
      }

      // Scope the verdict load to THIS attempt's paper. questionMap is shared
      // across the whole regrade loop, so passing it whole would look up
      // verdicts for coding questions that are on other students' papers.
      const attemptQMap = new Map<string, QuestionDoc>();
      for (const sec of sections) {
        for (const sq of sec.questions) {
          const qd = questionMap.get(sq.questionId);
          if (qd) attemptQMap.set(sq.questionId, qd);
        }
      }

      const { scores, gradedAnswers } = scoreAttemptAnswers({
        sections,
        questionMap,
        answerMap,
        // A regrade is how a coding mark ARRIVES: the judge is asynchronous, so
        // the paper is finalised into manual review first and the verdict lands
        // afterwards. Re-reading verdicts here is what turns it into a mark.
        codeVerdicts: await loadCodeVerdicts(db, docSnap.id, attemptQMap),
        // THE REASON THIS PARAMETER IS NOT OPTIONAL IN PRACTICE. A regrade
        // re-derives every finished attempt from scratch; without the human's
        // marks it would re-run the scorer as though nobody had ever marked
        // anything, silently deleting a cohort's worth of hand marking and
        // pushing every essay paper back into review.
        manualMarks: await loadManualMarks(db, docSnap.id, attemptQMap),
        answers: att.answers,
        passingScore: assessment.passingScore,
        exposeKeysToStudent: reviewAudienceAllows(assessment, 'students'),
        invalidatedQuestionIds: invalidated,
        // Regrade under each attempt's OWN frozen policy (fall back to live).
        gradingConfig: att.gradingConfig ?? assessment.gradingConfig,
      });

      batch.update(docSnap.ref, { scores, gradedAnswers, updatedAt: nowIso });
      updated++;
      batchSize++;
      if (batchSize >= 400) { // Firestore batch cap is 500 writes
        await batch.commit();
        batch = db.batch();
        batchSize = 0;
      }
    }
    if (batchSize > 0) await batch.commit();

    return { ok: true, updated };
  }
);

// ══════════════════════════════════════════════════════════════════
// setManualMark — a human awards marks on one answer
//
// The other half of audit G-01. The scorer flags what it cannot mark; this is
// the only path that marks it, and the only path that can clear the flag.
//
// Four properties this is built to hold:
//
//   1. THE MARK IS AN INPUT, NOT A PATCH. It is stored, then the whole attempt
//      is re-scored through scoreAttemptAnswers — the same function gradeAttempt
//      and regradeAttempts use. Nothing here computes a total by hand, so a
//      hand-marked paper cannot drift from a machine-marked one, and a later
//      regrade re-reads the mark instead of erasing it.
//
//   2. THE PAPER IS THE ATTEMPT'S OWN. examContractFor, exactly as B-02
//      established for the regrade path: a grader marking against a paper the
//      student never sat is the same defect wearing a different hat.
//
//   3. A JUDGED CODING ANSWER IS NOT HAND-MARKABLE. Text has no other marker,
//      so it is always open. Code is open only while no usable verdict exists —
//      the judge is down, or has given up. Once a verdict lands, the judge owns
//      that number; two authorities over one mark is how they silently diverge.
//
//   4. FINISHED ATTEMPTS ONLY. Marking a live sitting would race the student's
//      own writes and produce a mark on a paper still being written.
// ══════════════════════════════════════════════════════════════════

interface SetManualMarkData {
  attemptId: string;
  questionId: string;
  /** Marks to award, or null to withdraw the mark and requeue the answer. */
  marks: number | null;
  feedback?: string;
}

export const setManualMark = onCall<SetManualMarkData>(
  CALLABLE_BASE,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

    const callerRole        = request.auth.token.role        as Role   | undefined;
    const callerInstituteId = request.auth.token.instituteId as string | undefined;

    const { attemptId, questionId, marks, feedback } =
      request.data || ({} as SetManualMarkData);

    if (!attemptId || typeof attemptId !== 'string') {
      throw new HttpsError('invalid-argument', 'attemptId is required.');
    }
    if (!questionId || typeof questionId !== 'string') {
      throw new HttpsError('invalid-argument', 'questionId is required.');
    }
    if (marks !== null && (typeof marks !== 'number' || !Number.isFinite(marks))) {
      throw new HttpsError('invalid-argument', 'marks must be a number, or null to clear.');
    }
    if (feedback !== undefined && typeof feedback !== 'string') {
      throw new HttpsError('invalid-argument', 'feedback must be a string.');
    }
    if (typeof feedback === 'string' && feedback.length > MAX_FEEDBACK_CHARS) {
      throw new HttpsError('invalid-argument',
        `feedback is limited to ${MAX_FEEDBACK_CHARS} characters.`);
    }

    const db = getFirestore();

    const attemptRef  = db.collection('attempts').doc(attemptId);
    const attemptSnap = await attemptRef.get();
    if (!attemptSnap.exists) throw new HttpsError('not-found', 'Attempt not found.');
    const attempt = attemptSnap.data() as {
      assessmentId: string;
      studentId?: string;
      instituteId?: string;
      status?: string;
      isDeleted?: boolean;
      answers?: Record<string, AttemptAnswerDoc>;
      gradingConfig?: AssessmentGradingConfigS;
      examSnapshot?: { sections?: unknown };
    };

    // AuthZ — graders only. Students never mark, not even their own paper.
    // Mirrors the isGrader arm of gradeAttempt rather than inventing a second
    // spelling of the same rule.
    const isGrader =
      callerRole === 'webOwner'
      || ((callerRole === 'institute' || callerRole === 'faculty')
          && !!callerInstituteId && callerInstituteId === attempt.instituteId);
    if (!isGrader) {
      throw new HttpsError('permission-denied', 'Only graders may mark an answer.');
    }

    const FINISHED = new Set(['submitted', 'auto_submitted', 'terminated']);
    if (!attempt.status || !FINISHED.has(attempt.status)) {
      throw new HttpsError('failed-precondition',
        'NOT_FINISHED: an answer can only be marked once the sitting is over.');
    }
    if (attempt.isDeleted) {
      throw new HttpsError('failed-precondition',
        'DELETED_ATTEMPT: this attempt has been withdrawn and cannot be marked.');
    }

    const aSnap = await db.collection('assessments').doc(attempt.assessmentId).get();
    if (!aSnap.exists) throw new HttpsError('not-found', 'Assessment not found.');

    // B-02: mark against the paper THIS attempt sat.
    const assessment = examContractFor(
      attempt as unknown as Record<string, unknown>,
      aSnap.data() as Record<string, unknown>,
    ) as GradingAssessmentDoc;
    const sections = normalizeSections(assessment);

    // The question must be ON this paper, and we need its marks ceiling.
    let maxMarks: number | null = null;
    for (const sec of sections) {
      for (const sq of sec.questions) {
        if (sq.questionId === questionId) { maxMarks = sq.marks; break; }
      }
      if (maxMarks !== null) break;
    }
    if (maxMarks === null) {
      throw new HttpsError('failed-precondition',
        'NOT_ON_PAPER: that question is not part of the paper this student sat.');
    }

    const qIds = Array.from(new Set(
      sections.flatMap((sec) => sec.questions.map((q) => q.questionId)),
    ));
    const { questionMap, answerMap } = await loadQuestionAndAnswerMaps(db, qIds);

    const question = questionMap.get(questionId);
    if (!question) {
      throw new HttpsError('failed-precondition',
        'QUESTION_UNAVAILABLE: the question document no longer exists.');
    }
    if (!isManuallyMarkable(question.engine)) {
      throw new HttpsError('failed-precondition',
        'NOT_MANUAL: this question is machine-marked. Use a regrade to change its mark.');
    }

    const codeVerdicts = await loadCodeVerdicts(db, attemptId, questionMap);

    // Property 3: a coding answer the judge has actually marked is the judge's.
    if (question.engine === 'code') {
      const verdict = codeVerdicts.get(questionId);
      const ansDoc  = answerMap.get(questionId);
      const outcome = verdict ? codeOutcomeFor(verdict, ansDoc?.tests ?? []) : null;
      if (outcome) {
        throw new HttpsError('failed-precondition',
          'ALREADY_JUDGED: the code runner has marked this answer. Re-run the judge '
          + 'to change it rather than marking over the top of a verdict.');
      }
    }

    const markRef = db.collection('attemptManualMarks').doc(manualMarkDocId(attemptId, questionId));
    const nowIso  = new Date().toISOString();

    if (marks === null) {
      // Withdraw. The answer returns to the queue on the re-score below, which
      // is why this is a delete rather than a zero — zero is a mark someone
      // chose to give, and the two must not look alike to the next grader.
      await markRef.delete();
    } else {
      const existing = (await markRef.get()).data() as ManualMarkDoc | undefined;
      const doc: ManualMarkDoc = {
        attemptId,
        questionId,
        assessmentId: attempt.assessmentId,
        instituteId: attempt.instituteId ?? null,
        studentId: attempt.studentId ?? null,
        marksAwarded: clampManualAward(marks, maxMarks),
        gradedBy: request.auth.uid,
        gradedByRole: String(callerRole ?? 'unknown'),
        gradedAt: nowIso,
        firstGradedAt: existing?.firstGradedAt ?? nowIso,
        revision: (existing?.revision ?? 0) + 1,
      };
      const trimmed = (feedback ?? '').trim();
      if (trimmed) doc.feedback = trimmed;
      await markRef.set(doc);
    }

    // Re-score the whole paper through the shared scorer. This is what clears
    // requiresManualReview and restores a real pass/fail verdict once the last
    // outstanding answer has been marked.
    const { scores, gradedAnswers } = scoreAttemptAnswers({
      sections,
      questionMap,
      answerMap,
      codeVerdicts,
      manualMarks: await loadManualMarks(db, attemptId, questionMap),
      answers: attempt.answers,
      passingScore: assessment.passingScore,
      exposeKeysToStudent: reviewAudienceAllows(assessment, 'students'),
      gradingConfig: attempt.gradingConfig ?? assessment.gradingConfig,
    });

    await attemptRef.update({ scores, gradedAnswers, updatedAt: nowIso });

    return { ok: true, scores };
  }
);

// ══════════════════════════════════════════════════════════════════
// getAnswerKeysForReview — scoped answer-key reads for graders
//
// With questionAnswers locked to owners in the Firestore rules, reviewer
// surfaces (report triage, attempt drill-in) can no longer read keys of
// questions they don't own — e.g. an institute reviewer judging an
// "answer is wrong" report on a webOwner-owned question. This callable is
// the ONLY sanctioned path for those reads, and it is assessment-scoped:
//
//   • caller must be webOwner, OR an institute/faculty grader for whom the
//     assessment is legitimately visible — they own it, or it is published
//     and assigned to their institute (type 'all' or instituteIds match) —
//     the exact mirror of the assessments read rule;
//   • only keys for questions that actually appear IN that assessment are
//     returned (requested ids are intersected with the paper), so this can
//     never be used to dump the bank at large;
//   • students are always denied.
// ══════════════════════════════════════════════════════════════════

interface GetAnswerKeysData {
  assessmentId: string;
  questionIds?: string[]; // optional subset; defaults to the whole paper
}

export const getAnswerKeysForReview = onCall<GetAnswerKeysData>(
  CALLABLE_BASE,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

    const callerRole        = request.auth.token.role        as Role   | undefined;
    const callerInstituteId = request.auth.token.instituteId as string | undefined;
    const callerFacultyId   = request.auth.token.facultyId   as string | undefined;

    if (callerRole !== 'webOwner' && callerRole !== 'institute' && callerRole !== 'faculty') {
      throw new HttpsError('permission-denied', 'Only graders may read answer keys.');
    }

    const { assessmentId, questionIds } = request.data || ({} as GetAnswerKeysData);
    if (!assessmentId) throw new HttpsError('invalid-argument', 'assessmentId is required.');
    if (questionIds !== undefined
        && (!Array.isArray(questionIds) || questionIds.some((id) => typeof id !== 'string'))) {
      throw new HttpsError('invalid-argument', 'questionIds must be an array of strings.');
    }

    const db = getFirestore();
    const aSnap = await db.collection('assessments').doc(assessmentId).get();
    if (!aSnap.exists) throw new HttpsError('not-found', 'Assessment not found.');
    const assessment = aSnap.data() as GradingAssessmentDoc & {
      ownerType?: string;
      ownerId?: string;
      status?: string;
      assignedTo?: { type: string; instituteIds?: string[] };
    };

    if (callerRole !== 'webOwner') {
      const ownsIt =
        (callerRole === 'institute'
          && assessment.ownerType === 'institute'
          && assessment.ownerId === callerInstituteId)
        || (callerRole === 'faculty'
          && assessment.ownerType === 'faculty'
          && assessment.ownerId === callerFacultyId);
      const published = assessment.status === 'active' || assessment.status === 'closed';
      const target = assessment.assignedTo;
      const assignedToCaller = published && !!target
        && (target.type === 'all'
            || (target.type === 'institutes'
                && !!callerInstituteId
                && (target.instituteIds ?? []).includes(callerInstituteId)));
      // N5 final form: non-owner staff get keys ONLY when the exam owner has
      // put their audience in allowReviewTo (or, on legacy docs, when the
      // allowReview boolean is on — the same access students have). Being
      // assigned/published alone no longer exports the key set; exam status
      // (active vs closed) is irrelevant once the audience allows it, which
      // is the point: the owner's flag is the consent, not the clock.
      const audience: VisibilityAudience =
        callerRole === 'institute' ? 'institute' : 'faculty';
      const staffMayReview = reviewAudienceAllows(assessment, audience);
      if (!ownsIt && !(assignedToCaller && staffMayReview)) {
        throw new HttpsError('permission-denied', 'This assessment is not visible to you.');
      }
    }

    // ── Intersect requested ids with the paper — never leak keys beyond it ──
    //
    // B-03: "the paper" is the set this exam has ever put in front of a
    // student, not the set the live document happens to name today. Once the
    // paper is frozen per attempt (A-05), a question removed from the live doc
    // is still sitting in finished attempts — and intersecting against the live
    // set alone made those unmarkable, because the human marking a text answer
    // could not obtain its key.
    //
    // The union stays tightly bounded, which is what the intersection is for:
    // it is exactly the live paper plus what real attempts were served, so this
    // still cannot be used to dump the bank at large. One extra query on a
    // staff review endpoint — the same query regradeAttempts already runs — is
    // the cost.
    const paperIds = new Set(
      normalizeSections(assessment).flatMap((s) => s.questions.map((q) => q.questionId))
    );
    try {
      const satSnap = await db.collection('attempts')
        .where('assessmentId', '==', assessmentId)
        .limit(500)
        .get();
      for (const d of satSnap.docs) {
        const snapSections = (d.get('examSnapshot') as { sections?: Array<{
          questions?: Array<{ questionId?: string }>;
        }> } | undefined)?.sections;
        if (!Array.isArray(snapSections)) continue;
        for (const sec of snapSections) {
          for (const q of sec.questions ?? []) {
            if (typeof q.questionId === 'string') paperIds.add(q.questionId);
          }
        }
      }
    } catch (e) {
      // A widening step must never break the endpoint. Falling back to the
      // live paper alone is exactly the previous behaviour.
      console.warn('[getAnswerKeysForReview] sat-paper widening skipped', assessmentId, e);
    }
    const wanted = (questionIds && questionIds.length > 0)
      ? questionIds.filter((id) => paperIds.has(id))
      : Array.from(paperIds);

    const { answerMap } = await loadQuestionAndAnswerMaps(db, wanted);

    const keys: Record<string, { correctIds: string[]; correctPairs: CorrectPair[]; modelAnswer: string }> = {};
    for (const id of wanted) {
      const ans = answerMap.get(id);
      if (ans) {
        keys[id] = {
          correctIds:   ans.correctIds   ?? [],
          correctPairs: ans.correctPairs ?? [],
          modelAnswer:  ans.modelAnswer  ?? '',
        };
      }
    }
    return { ok: true, keys };
  }
);

// ══════════════════════════════════════════════════════════════════
// getExamQuestions — the ONLY path students receive question content
//
// The `questions` collection read rule denies students entirely: with
// direct reads, any signed-in student could fetch ANY question document
// by id from the browser console — the whole bank's stems and options,
// across every owner — since assessments (readable when published)
// expose the question ids. This callable closes that leak:
//
//   • students only, and only for assessments they can legitimately sit
//     (published + assigned to them / their institute / everyone) or have
//     already attempted (so results review keeps working after an exam
//     closes or is reassigned);
//   • field WHITELIST — never returns correctIds / correctPairs /
//     modelAnswer; `explanation` is included only in review mode, and
//     review mode requires a FINISHED attempt + allowReview on the
//     assessment (mirrors the results page's own gate);
//   • only questions inside that assessment's paper are ever returned.
//
// Side benefit: the exam shell previously issued one read per question
// (N roundtrips); this is a single call for the whole paper.
// ══════════════════════════════════════════════════════════════════

interface GetExamQuestionsData {
  assessmentId: string;
  sebToken?: string;
  mode?: 'exam' | 'review';
}

/**
 * The PUBLIC half of a coding question, narrowed field by field.
 *
 * codeSpec carries what the candidate is entitled to see — which languages the
 * question accepts, the buffer their editor opens into, and the limits their
 * program runs under. None of it is the answer; `tests` is, and `tests` lives
 * on the questionAnswers sibling and is never touched here.
 *
 * Rebuilt rather than passed through, on the same discipline as the whitelist
 * that calls it: a field added to CodeSpec later must be named here before a
 * candidate can see it, so the next field cannot arrive by accident.
 *
 * WITHOUT THIS the exam is not merely missing a nicety. resolveLanguages reads
 * an absent spec as "every language the platform runs", so an author's
 * restriction silently evaporates and the editor opens in whichever language
 * sorts first — while starterFor returns '' and the candidate faces an empty
 * buffer the question was written to pre-fill.
 */
function sanitizeCodeSpecForStudent(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const spec = raw as Record<string, unknown>;
  const limits = (spec.limits ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;

  const starter = (spec.starterCode ?? {}) as Record<string, unknown>;
  const starterCode: Record<string, string> = {};
  for (const [lang, body] of Object.entries(starter)) {
    if (typeof body === 'string') starterCode[lang] = body;
  }

  return stripUndefined({
    languages: Array.isArray(spec.languages)
      ? (spec.languages as unknown[]).filter((l): l is string => typeof l === 'string')
      : [],
    starterCode,
    // The author's raw numbers. The server clamps to MAX_LIMITS at submission
    // time (buildCodeSubmission → clampLimits); showing the author's figure
    // here would be a lie only if it exceeded the ceiling, so it is clamped
    // for display too — the candidate is told the limit they will actually run
    // under, not the one that was typed.
    limits: stripUndefined({
      cpuMs:     num(limits.cpuMs),
      wallMs:    num(limits.wallMs),
      memoryKb:  num(limits.memoryKb),
      outputKb:  num(limits.outputKb),
      processes: num(limits.processes),
    }),
  });
}

// ── Shared student-facing question sanitizer ──────────────────────
// Single source of truth for the field whitelist. Used by getExamQuestions
// AND submitAnswerAndAdvance (Phase 2.5) so the two can never drift and a
// leaky field can never reach a student through either path.
// Answer keys NEVER leave through these endpoints.
function sanitizeQuestionForStudent(q: Record<string, unknown>, includeExplanation: boolean) {
  return {
    id:          q.id,
    engine:      q.engine,
    variant:     q.variant ?? null,
    stem:        q.stem ?? '',
    stemImage:   q.stemImage ?? null,
    options:     Array.isArray(q.options) ? q.options : [],
    pairs:       Array.isArray(q.pairs)   ? q.pairs   : [],
    subject:     q.subject ?? '',
    topic:       q.topic ?? '',
    subjectId:   q.subjectId ?? null,
    topicId:     q.topicId ?? null,
    tags:        Array.isArray(q.tags) ? q.tags : [],
    difficulty:  q.difficulty ?? 'medium',
    // Group membership (Phase 1). Without these two the exam shell cannot
    // tell which questions share a stimulus, and every grouped question
    // renders as a standalone one with its passage missing.
    groupId:     q.groupId ?? null,
    groupOrder:  typeof q.groupOrder === 'number' ? q.groupOrder : null,
    // Coding delivery settings (engine 'code'). PUBLIC — see
    // sanitizeCodeSpecForStudent. Null for every other engine, so nothing
    // changes shape for the papers that carry no coding questions.
    codeSpec:    q.engine === 'code' ? sanitizeCodeSpecForStudent(q.codeSpec) : null,
    explanation: includeExplanation ? (q.explanation ?? '') : '',
    correctIds:   [] as string[],
    correctPairs: [] as CorrectPair[],
    modelAnswer:  '',
    // The hidden suite IS the answer key for a coding question. Emptied here
    // for the same reason correctIds is: a pre-migration document that still
    // carries tests inline is neutralised by the sanitiser rather than by
    // remembering that it should not have them.
    tests:        [] as unknown[],
    isDeleted:   false,
    createdAt:   q.createdAt ?? '',
    updatedAt:   q.updatedAt ?? '',
  };
}

// ── Shared student-facing GROUP sanitizer (Phase 1) ───────────────
// The stimulus half of the whitelist. Same contract as
// sanitizeQuestionForStudent: an explicit allow-list, so a field added to
// group documents later cannot reach a student by default.
//
// Notably ABSENT and deliberately so:
//   • childIds — the group's full membership. A paper may use 3 of 8
//     children; handing over all 8 ids tells a candidate exactly how much of
//     the set they were not asked, and hands anyone scraping the payload a
//     map of the bank's structure. The student's own paper already tells
//     them which questions they have.
//   • ownerType / ownerId / instituteId — tenant internals.
//   • isDeleted, createdAt, updatedAt — bank bookkeeping.
function sanitizeGroupForStudent(g: Record<string, unknown>) {
  const stimulus = (g.stimulus ?? {}) as Record<string, unknown>;
  const table = stimulus.table as Record<string, unknown> | undefined;
  return {
    id:    g.id,
    kind:  g.kind ?? 'generic',
    // title is the author's INTERNAL label ("DI — hard set, reuse Q3") and is
    // not written for candidates. The stimulus speaks for itself.
    stimulus: {
      format: stimulus.format ?? 'richtext',
      body:   stimulus.body ?? '',
      images: Array.isArray(stimulus.images) ? stimulus.images : [],
      // Rows are `{ cells: [...] }` objects, not a 2-D array: Firestore
      // rejects nested arrays outright, so this is the only shape that can
      // have been stored. Passed through as-is.
      table:  table
        ? {
            caption: table.caption ?? '',
            headers: Array.isArray(table.headers) ? table.headers : [],
            rows:    Array.isArray(table.rows) ? table.rows : [],
          }
        : null,
    },
  };
}

export const getExamQuestions = onCall<GetExamQuestionsData>(
  EXAM_HOT_PATH,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const role        = request.auth.token.role        as string | undefined;
    const studentId   = request.auth.token.studentId   as string | undefined;
    const instituteId = request.auth.token.instituteId as string | undefined;
    if (role !== 'student' || !studentId || !instituteId) {
      throw new HttpsError('permission-denied', 'Only students may fetch exam questions here.');
    }

    const { assessmentId, mode } = request.data || ({} as GetExamQuestionsData);
    if (!assessmentId) throw new HttpsError('invalid-argument', 'assessmentId is required.');

    const db = getFirestore();
    const aSnap = await db.collection('assessments').doc(assessmentId).get();
    if (!aSnap.exists) throw new HttpsError('not-found', 'Assessment not found.');
    const assessment = aSnap.data() as GradingAssessmentDoc & {
      status?: string;
      assignedTo?: { type: string; instituteIds?: string[]; studentIds?: string[] };
      blockedStudents?: string[];
    };

    // AuthZ — assigned & published, OR the student already has an attempt
    // (covers review after close / unassignment; an attempt is proof they
    // legitimately sat the paper).
    //
    // Phase C / Audit 2026-07-17, N2 — mirror startExam's two-path gate:
    //   'rules' → the materialized assessmentMembers list is authoritative.
    //             resolveAllocation stamps allocationMode but does NOT clear
    //             the stale assignedTo left on the doc, so checking only
    //             assignedTo here leaked the full paper content of a
    //             rules-allocated exam (commonly assignedTo.type 'all') to
    //             every student on the platform while it was active.
    //   else    → legacy assignedTo gate, byte-for-byte unchanged.
    const published = assessment.status === 'active' || assessment.status === 'closed';
    let assigned: boolean;
    if ((assessment as { allocationMode?: string }).allocationMode === 'rules') {
      const memberSnap = await db.collection('assessmentMembers')
        .doc(`${assessmentId}_${studentId}`)
        .get();
      assigned = memberSnap.exists && memberSnap.get('active') === true;
    } else {
      const target = assessment.assignedTo;
      assigned = !target
        || target.type === 'all'
        || (target.type === 'institutes' && (target.instituteIds ?? []).includes(instituteId))
        || (target.type === 'students'   && (target.studentIds   ?? []).includes(studentId));
    }

    const attemptsSnap = await db.collection('attempts')
      .where('studentId', '==', studentId)
      .where('assessmentId', '==', assessmentId)
      .get();
    const hasAttempt = !attemptsSnap.empty;
    const hasFinishedAttempt = attemptsSnap.docs.some((d) => {
      const s = (d.data() as { status?: string }).status;
      return s === 'submitted' || s === 'auto_submitted' || s === 'terminated';
    });

    if (!(published && assigned) && !hasAttempt) {
      throw new HttpsError('permission-denied', 'This exam is not available to you.');
    }

    // Explanation only for post-exam review, and only when STUDENTS are in
    // the assessment's review audience (N5 final form) — same gate
    // gradeAttempt applies when writing keys into the attempt.
    const includeExplanation =
      mode === 'review'
      && hasFinishedAttempt
      && reviewAudienceAllows(
           assessment as { allowReview?: boolean; allowReviewTo?: unknown },
           'students');

    // ── Delivery-mode scoping (Phase 2.5) ─────────────────────────
    // In linear/adaptive the client must NEVER hold the paper. Only the
    // questions the server has actually served are returned. Standard mode is
    // unchanged (whole paper, one call). Legacy attempts (no securityConfig)
    // fall through to standard behaviour.
    const liveAttempt = attemptsSnap.docs
      .map((d) => d.data() as {
        status?: string;
        securityConfig?: { deliveryMode?: string; requireSEB?: boolean } | null;
        servedQuestions?: Array<{ questionId: string }>;
        createdAt?: string;
        // B-01: the frozen paper, so standard delivery serves what it grades.
        examSnapshot?: { sections?: unknown };
      })
      .sort((x, y) => (y.createdAt ?? '').localeCompare(x.createdAt ?? ''))[0];

    // ── S-01 (audit 2026-07-26) — no paper without a live sitting ─────
    // Before this gate, `published && assigned` was sufficient to receive the
    // whole paper. AssessmentStatus has no 'scheduled' state (draft|active|
    // closed), so an exam published for next week is 'active' today: every
    // assigned student could download the entire question set before it
    // opened, with no attempt and — because the SEB check below keyed off
    // `liveAttempt?.status === 'in_progress'`, undefined when no attempt
    // exists — without Safe Exam Browser either.
    //
    // The fix is to require a live attempt rather than to re-list startExam's
    // schedule checks. A live attempt can only exist because startExam
    // admitted it, and startExam gates on startDate, endDate, maxAttempts,
    // blockedStudents, targeting, device class, camera and SEB (:4461-4558).
    // Requiring one is therefore strictly stronger than re-checking the
    // schedule here, and it cannot drift from startExam the way a duplicated
    // copy of those checks would.
    //
    // Deliberately NOT re-checking startDate/endDate: those are evaluated at
    // admission, and re-evaluating them on every fetch would cut off a student
    // who is legitimately mid-exam when the window closes or when staff edit
    // the schedule underneath them. ExamShell:872 states the same rule from
    // the client side — "once started, letting a running attempt continue is
    // the right thing."
    //
    // blockedStudents IS re-checked, because unlike the schedule it is a live
    // invigilation action: a student blocked mid-exam must stop being able to
    // re-fetch the paper on reload.
    //
    // 'frozen' counts as live. It is a paused sitting, not a finished one, and
    // both startExam (:4547-4550) and ExamShell (:876, :901) already treat
    // in_progress|frozen as the live pair. Gating on 'in_progress' alone would
    // break resume for any student an invigilator has frozen.
    //
    // Both modes are gated. 'review' is NOT a safe default: the authz check
    // above passes on `published && assigned` alone, so a caller who simply
    // sends mode:'review' would otherwise walk out with the same paper the
    // live-attempt requirement is meant to protect. Review therefore requires
    // an attempt to exist — proof the student actually sat the paper.
    //
    // hasAttempt (any status), not hasFinishedAttempt: it mirrors the client's
    // own precondition (ExamResultsPage:327 gates on `att &&`), and it is
    // already sufficient here — creating an attempt at all means clearing
    // every startExam gate, so a caller who can do that could equally read the
    // paper through exam mode. Requiring 'finished' would buy no security and
    // would break a student who opens results with a sitting still open.
    if (mode === 'review') {
      if (!hasAttempt) {
        throw new HttpsError('failed-precondition', 'You have not sat this exam.');
      }
    } else {
      if ((assessment.blockedStudents ?? []).includes(studentId)) {
        throw new HttpsError('permission-denied', 'This exam is not available to you.');
      }
      const liveStatus = liveAttempt?.status;
      if (liveStatus !== 'in_progress' && liveStatus !== 'frozen') {
        throw new HttpsError(
          'failed-precondition',
          'Start the exam before fetching questions.',
        );
      }
    }

    // Phase 3 — gate the LIVE exam fetch only. 'review' runs after submission,
    // when the student has quit SEB; requiring SEB there would make results
    // permanently unviewable.
    //
    // S-01: the gate above guarantees a live attempt in every non-review call,
    // so this no longer needs its own status test — and dropping that test is
    // what closes the frozen-resume hole, where SEB was previously skipped.
    // The attempt's FROZEN securityConfig.requireSEB is still the input, never
    // the client's claim; ExamShell arms the token manager at :867 on the
    // resume path too, so a frozen resume carries a proof.
    if (mode !== 'review') {
      assertSEB(request.data?.sebToken, request.auth.uid, liveAttempt?.securityConfig?.requireSEB, assessmentId);
    }

    const attemptDeliveryMode = liveAttempt?.securityConfig?.deliveryMode ?? 'standard';
    const isSequentialDelivery =
      attemptDeliveryMode === 'linear' || attemptDeliveryMode === 'adaptive';

    // ── B-01: serve the paper THIS attempt sat ──────────────────────
    //
    // Sequential delivery was always right — it lists servedQuestions, which is
    // the attempt's own record. Standard delivery listed the LIVE document, and
    // once the paper was frozen onto the attempt for grading (A-05) the two
    // could disagree: a staff re-save swaps a question, and the student is then
    // SERVED one that will never be marked while never seeing the one that will
    // be marked blank. Freezing the grader without freezing the server did not
    // remove that inconsistency, it moved it somewhere worse.
    //
    // examContractFor falls through to the live document for attempts with no
    // snapshot, so legacy sittings are unchanged.
    const paperForAttempt = liveAttempt
      ? (examContractFor(
          liveAttempt as unknown as Record<string, unknown>,
          assessment as unknown as Record<string, unknown>,
        ) as GradingAssessmentDoc)
      : assessment;
    const qIds = isSequentialDelivery
      ? Array.from(new Set((liveAttempt?.servedQuestions ?? []).map((s) => s.questionId)))
      : Array.from(new Set(
          normalizeSections(paperForAttempt).flatMap((s) => s.questions.map((q) => q.questionId))
        ));

    const chunkedGetAll = async (ids: string[]) => {
      const out: FirebaseFirestore.DocumentSnapshot[] = [];
      for (let i = 0; i < ids.length; i += 300) {
        const refs = ids.slice(i, i + 300).map((id) => db.collection('questions').doc(id));
        out.push(...await db.getAll(...refs));
      }
      return out;
    };
    const snaps = await chunkedGetAll(qIds);

    // Field WHITELIST — anything not listed here never reaches a student,
    // including any leaky field added to question docs in the future.
    const questions = snaps
      .filter((s) => s.exists)
      .map((s) => s.data() as Record<string, unknown>)
      .filter((q) => q.isDeleted !== true)
      .map((q) => sanitizeQuestionForStudent(q, includeExplanation));

    // ── Shared stimulus for grouped questions (Phase 1) ──────────────
    // Fetched HERE rather than by the client for the same reason the
    // questions are: /questionGroups denies students outright, because a
    // reading passage is content worth as much as an answer key — a leaked
    // passage burns the whole set. This is the only path stimulus reaches a
    // student, it is scoped to their own paper, and it is whitelisted.
    //
    // Only groups actually referenced by the questions above are loaded, so a
    // paper with no grouped questions costs no extra reads and returns [].
    const groupIds = Array.from(new Set(
      questions
        .map((q) => q.groupId)
        .filter((g): g is string => typeof g === 'string' && g.length > 0),
    ));

    let groups: ReturnType<typeof sanitizeGroupForStudent>[] = [];
    if (groupIds.length > 0) {
      const gSnaps: FirebaseFirestore.DocumentSnapshot[] = [];
      for (let i = 0; i < groupIds.length; i += 300) {
        const refs = groupIds.slice(i, i + 300).map((id) => db.collection('questionGroups').doc(id));
        gSnaps.push(...await db.getAll(...refs));
      }
      groups = gSnaps
        .filter((s) => s.exists)
        .map((s) => s.data() as Record<string, unknown>)
        // isDeleted is NOT filtered here, unlike the questions above. If a
        // child question survived on the paper, its stimulus must be served
        // with it — withholding the passage of a question the student is
        // still being asked leaves them an unanswerable item. Deleting a
        // group normally cascades to its children, so they drop out together
        // and this list simply comes back empty; this branch covers the case
        // where they did not.
        .map((g) => sanitizeGroupForStudent(g));
    }

    return { ok: true, questions, groups };
  }
);

// ══════════════════════════════════════════════════════════════════
// STUDENT ASSESSMENT LIST  (audit 2026-07-26, S-04)
// ══════════════════════════════════════════════════════════════════
// Replaces a client-side collection scan. The old getAssessmentsForStudent
// ran two UNFILTERED queries — status=='active' and status=='closed', with no
// tenant or assignment constraint — pulling every assessment on the platform
// to every student's browser and filtering there. The filtering was cosmetic:
// the full set, including other institutes' exams, was already on the wire.
//
// That could not be fixed in firestore.rules alone. Rules are evaluated per
// returned document and one failure rejects the whole query, so tightening
// the student read rule while the client still issued an unscoped query would
// simply have emptied every student's dashboard. The list has to move to a
// place that can filter BEFORE returning, which means here.
//
// Deliberately the same visibility logic and the same two queries the client
// ran, executed server-side. Matching current behaviour exactly is the point:
// this is a security fix, not a rewrite, and a targeted-query optimisation
// would change which exams appear. Reducing the read cost is worth doing —
// see P-02 — but as its own change, where a visibility regression would be
// attributable.
//
// Legacy docs with no assignedTo field at all are treated as webOwner-global,
// byte-for-byte as the client did (`if (!t) return true`). They cannot be
// found by query — Firestore cannot match a missing field — which is the
// other reason the scan stays.

/** Fields a student may see in their OWN assessment list. */
interface StudentAssessmentSummary {
  id: string;
  title?: unknown;
  subject?: unknown;
  status?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  totalMarks?: unknown;
  passingScore?: unknown;
  maxAttempts?: unknown;
  showResults?: unknown;
  allowReview?: unknown;
  questions?: unknown;
  sections?: unknown;
  blockedStudents: string[];
  attemptOverrides: Record<string, number>;
  // ── What device may sit this, and how seriously ────────────────
  // Added so the assessment CARD can say "needs a computer" and disable its
  // own Start button. Without these the list could not know, and a student on
  // a phone learned the answer three screens later — after the briefing, after
  // granting camera, from a raw server error. None of it is sensitive: the
  // briefing reads the same fields straight off the assessment document, and
  // the tier is printed on the briefing page in words.
  securityTier?: unknown;
  allowMobile?: unknown;
  allowTablet?: unknown;
}

/**
 * Field WHITELIST, same construction as sanitizeQuestionForStudent — anything
 * not named here never reaches a student, so a leaky field added to assessment
 * docs later is contained by default rather than by remembering to exclude it.
 *
 * Two fields are REDUCED rather than dropped, because the list UI genuinely
 * needs them but only ever reads this student's own entry:
 *
 *   blockedStudents  — a roster of other students' ids. The page asks exactly
 *                      one question of it (`includes(studentId)`, :50 and
 *                      :300), so returning either [] or [studentId] preserves
 *                      that check bit-for-bit while disclosing nobody else.
 *   attemptOverrides — a map keyed by student id. Read only as
 *                      `[studentId]` (:52, :258), so a single-entry map is
 *                      indistinguishable to the client.
 *
 * questions / sections are kept INTACT. Question ids used to matter because
 * they were half the input to the S-01 paper-download attack, but that is
 * closed: getExamQuestions now demands a live attempt, and firestore.rules:621
 * denies students direct reads of the questions collection. An id on its own
 * is inert, and the list needs `questions.length` plus each section's id, name
 * and timeLimit to render.
 */
function sanitizeAssessmentForStudent(
  id: string,
  a: Record<string, unknown>,
  studentId: string,
): StudentAssessmentSummary {
  const blocked = Array.isArray(a.blockedStudents) ? (a.blockedStudents as string[]) : [];
  const overrides = (a.attemptOverrides ?? {}) as Record<string, number>;
  const own = overrides[studentId];

  return {
    id,
    title: a.title,
    subject: a.subject,
    status: a.status,
    startDate: a.startDate,
    endDate: a.endDate,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    totalMarks: a.totalMarks,
    passingScore: a.passingScore,
    maxAttempts: a.maxAttempts,
    showResults: a.showResults,
    allowReview: a.allowReview,
    questions: a.questions ?? [],
    sections: a.sections ?? [],
    blockedStudents: blocked.includes(studentId) ? [studentId] : [],
    attemptOverrides: own === undefined ? {} : { [studentId]: own },
    // The EFFECTIVE device policy, resolved here rather than shipped raw, so
    // the card and startExam answer the same question. A card reading the
    // stored allowMobile would tell a student on a phone to go ahead with a
    // 'normal' exam that stores true from before the lock — and then the
    // server would refuse them, which is the disagreement this whole change
    // is about. Only the grandfather clause makes that document's true
    // survive, and it is reproduced exactly.
    securityTier: a.securityTier,
    allowMobile: effectiveAllowMobileForCard(a),
    allowTablet: effectiveAllowTabletForCard(a),
  };
}

/**
 * The device policy as startExam will derive it — the read-only half of the
 * rules in the gate, kept next to the projection that needs them.
 *
 * These duplicate logic that startExam owns, which is a cost worth naming: two
 * places computing one fact is exactly the failure mode DEPLOY.md §5 warns
 * about. They are separate because startExam's version also throws, freezes a
 * config and reads request headers, none of which a list projection may do.
 * Any change to the tier's device rules must touch both, and the frontend's
 * applyTierDefaults as well.
 */
function effectiveAllowMobileForCard(a: Record<string, unknown>): boolean {
  const tier = a.securityTier as string | undefined;
  if (tier === undefined) return true;               // legacy: nothing was ever gated
  if (tier === 'mock') return (a.allowMobile as boolean | undefined) ?? true;
  if (tier === 'high_stake') return false;
  // 'normal' — locked off, but for a document published before the lock.
  return a.allowMobile === true && !!a.securityLockedAt;
}

function effectiveAllowTabletForCard(a: Record<string, unknown>): boolean {
  const tier = a.securityTier as string | undefined;
  if (tier === undefined) return true;
  if (tier === 'mock') return (a.allowTablet as boolean | undefined) ?? true;
  if (tier === 'high_stake') return false;
  return (a.allowTablet as boolean | undefined) ?? (a.allowMobile as boolean | undefined) ?? false;
}

export const getStudentAssessments = onCall(
  CALLABLE_BASE,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const role        = request.auth.token.role        as string | undefined;
    const studentId   = request.auth.token.studentId   as string | undefined;
    const instituteId = request.auth.token.instituteId as string | undefined;
    if (role !== 'student' || !studentId || !instituteId) {
      throw new HttpsError('permission-denied', 'Only students may list their assessments here.');
    }

    const db = getFirestore();

    const [activeSnap, closedSnap, memberSnap] = await Promise.all([
      db.collection('assessments')
        .where('status', '==', 'active').where('isDeleted', '==', false).get(),
      db.collection('assessments')
        .where('status', '==', 'closed').where('isDeleted', '==', false).get(),
      db.collection('assessmentMembers')
        .where('studentId', '==', studentId).where('active', '==', true).get(),
    ]);

    const memberOf = new Set(memberSnap.docs.map((d) => String(d.get('assessmentId'))));

    const assessments: StudentAssessmentSummary[] = [];
    for (const doc of [...activeSnap.docs, ...closedSnap.docs]) {
      const a = doc.data() as Record<string, unknown> & {
        allocationMode?: string;
        assignedTo?: { type?: string; instituteIds?: string[]; studentIds?: string[] };
      };

      // Two paths, chosen per-assessment by allocationMode — the same split
      // startExam and getExamQuestions use. Under 'rules' the materialized
      // membership list is authoritative and assignedTo is stale by design
      // (resolveAllocation does not clear it), so consulting assignedTo here
      // would let a rules-allocated exam carrying assignedTo.type 'all' show
      // up for every student on the platform.
      let visible: boolean;
      if (a.allocationMode === 'rules') {
        visible = memberOf.has(doc.id);
      } else {
        const t = a.assignedTo;
        visible = !t
          || t.type === 'all'
          || (t.type === 'institutes' && (t.instituteIds ?? []).includes(instituteId))
          || (t.type === 'students'   && (t.studentIds   ?? []).includes(studentId));
      }
      if (!visible) continue;

      assessments.push(sanitizeAssessmentForStudent(doc.id, a, studentId));
    }

    return { ok: true, assessments };
  }
);

// ══════════════════════════════════════════════════════════════════
// ATTEMPT SOFT DELETE  (audit 2026-07-26, S-03)
// ══════════════════════════════════════════════════════════════════
// Attempts were deletable by any institute or faculty in the owning tenant:
// firestore.rules listed 'isDeleted' in staffAttemptUpdateFieldsAllowed(), and
// the client did it with a bare updateDoc. That contradicted the deletion
// rights model outright — WEBOWNER_ONLY_S names 'attempt' precisely because
// "attempts are the audit trail; a tenant that can delete them can delete the
// evidence of what happened in an exam". Two defects, not one:
//
//   1. the wrong principals could do it at all, and
//   2. nothing was recorded when they did — a bare updateDoc writes no
//      deletionAudit row, so evidence could disappear without a trace of who
//      removed it. For an attempt that is the whole problem.
//
// This callable is now the only path. It is webOwner-only, and it writes the
// state change and the audit row in ONE transaction so an attempt can never be
// deleted without a corresponding record.
//
// Scope note: the bare-updateDoc pattern is shared by softDeleteQuestion,
// softDeleteQuestionBank and softDeleteAssessment, which are equally
// unaudited. Those are resources a tenant is legitimately allowed to delete,
// so the missing audit row there is a gap rather than a contradiction, and
// closing it is its own change. Only attempts are fixed here.

interface SoftDeleteAttemptData {
  attemptId: string;
  reason?: string;
}

export const softDeleteAttempt = onCall<SoftDeleteAttemptData>(
  CALLABLE_BASE,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

    // webOwner ONLY. Not "owner of the assessment" — the owning institute is
    // exactly the principal this finding is about, since an institute deleting
    // the attempts of an exam it ran is the evidence-destruction case.
    if ((request.auth.token.role as string | undefined) !== 'webOwner') {
      throw new HttpsError(
        'permission-denied',
        'Only the platform owner may delete exam attempts.',
      );
    }

    const attemptId = request.data?.attemptId;
    if (!attemptId) throw new HttpsError('invalid-argument', 'attemptId is required.');

    const reason = typeof request.data?.reason === 'string'
      ? request.data.reason.slice(0, 500)
      : null;

    const db = getFirestore();
    const ref = db.collection('attempts').doc(attemptId);

    await db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'Attempt not found.');

      const a = snap.data() as {
        isDeleted?: boolean;
        studentId?: string;
        studentName?: string;
        instituteId?: string;
        assessmentTitle?: string;
        status?: string;
      };

      // Idempotent: deleting an already-deleted attempt is a no-op rather than
      // an error, so a double-click cannot produce two audit rows for one act.
      if (a.isDeleted === true) return;

      txn.update(ref, { isDeleted: true, updatedAt: new Date().toISOString() });

      // Bound to the same transaction, so there is no window in which the
      // attempt is gone but the record of its removal is not.
      await writeAuditRow(db, {
        action: 'softDelete',
        entityType: 'attempt',
        entityId: attemptId,
        entityLabel: a.studentName
          ? `${a.studentName} — ${a.assessmentTitle ?? 'attempt'}`
          : attemptId,
        fromState: 'active',
        toState: 'softDeleted',
        actorUid: request.auth!.uid,
        actorRole: 'webOwner',
        actorName: (request.auth!.token.name as string | undefined) ?? null,
        instituteId: a.instituteId ?? null,
        reason,
      }, txn);
    });

    return { ok: true };
  }
);


// The exam clock must not be spoofable via the student's local system
// time. These callables own every time transition: exam start, section
// start, and section submit. `new Date()` inside a Cloud Function is the
// SERVER clock, and the schema already stores ISO strings, so we write
// `new Date().toISOString()` directly (no serverTimestamp() sentinel,
// which would break the client's `new Date(startedAt)` parsing).

const DEFAULT_SECTION_GRACE_SECONDS = 30;
const DEFAULT_OVERALL_GRACE_SECONDS = 30;

interface AttemptSectionTiming {
  startedAt: string;
  submittedAt?: string;
  timeUsedSeconds: number;
}

// ── getServerTime ─────────────────────────────────────────────────
// Client calls this once on exam load to compute skew = serverNow -
// clientNow, so the countdown display stays accurate even if the local
// clock is later tampered with.
export const getServerTime = onCall(
  CALLABLE_BASE,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    return { serverTime: Date.now() };
  },
);

// ══════════════════════════════════════════════════════════════════
// PHASE 1 — Server-authoritative enforcement
// examHeartbeat / reportExtensionCheck / verifyAndResume
//
// These give the security tiers real teeth. The client DETECTS and
// REPORTS; the server DECIDES and RECORDS. None of these trust the
// browser. App Check enforcement is deferred to a dedicated hardening
// pass (Option 1) — added later across all callables at once.
// ══════════════════════════════════════════════════════════════════

// ── examHeartbeat ─────────────────────────────────────────────────
// Client pings every ~15s while an attempt is in progress. The server
// stamps lastHeartbeatAt. A gap (heartbeat→submit) is later flagged by
// gradeAttempt: a student who blocks Firestore to hide violations also
// stops heartbeating, so the gap becomes a server-visible signal.
//
// ── Why gaps are recorded HERE and not derived later ──────────────
//
// lastHeartbeatAt is a single overwritten field, so it carries no history.
// gradeAttempt can therefore only ever measure ONE gap — the final
// heartbeat→submit interval — and every silence DURING the sitting is
// overwritten by the next successful beat and lost. A student offline for ten
// minutes in the middle of an exam and back before the end looks, at grade
// time, exactly like a student who never stopped.
//
// The gap only exists at the moment the beat lands and the previous stamp is
// still readable, so it is measured and recorded then. The read is free: the
// document is already fetched above for the ownership and SEB checks.
interface HeartbeatData {
  attemptId: string;
  sebToken?: string;
  /** The machine as it looks NOW, compared server-side against the baseline. */
  fingerprint?: DeviceFingerprintS;
  /**
   * Exam-machine shadow warnings (audit F-9 stage 2b).
   *
   * DIAGNOSTIC ONLY — nothing is stored, nothing is decided, and no attempt
   * field moves. They are logged so an operator can answer "is the transition
   * table safe to enforce yet?" from `firebase functions:log`, which was the
   * whole point of shadow mode and was not achievable while the warnings went
   * to the candidate's own console — a place nobody reads, and one that is
   * unreachable inside SEB.
   */
  machineWarnings?: string[];
}

/**
 * Bound anything client-supplied before it reaches a log line.
 *
 * Same discipline as sanitiseFingerprint and the CSP sink: an untrusted string
 * that reaches a log unbounded is a log-flooding amplifier, and one containing
 * a newline can forge a second entry. Count, length and newlines are all
 * capped here because the caller is a browser in an exam, which is the least
 * trusted thing in the system.
 */
const MAX_MACHINE_WARNINGS = 5;
const MAX_MACHINE_WARNING_CHARS = 200;

function sanitiseMachineWarnings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((w): w is string => typeof w === 'string' && w.trim() !== '')
    .slice(0, MAX_MACHINE_WARNINGS)
    .map((w) => w.replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_MACHINE_WARNING_CHARS));
}

/**
 * Silence past this is recorded as a gap. Matches the threshold gradeAttempt
 * already applies to the final heartbeat→submit interval, so mid-session and
 * end-of-session gaps mean the same thing.
 *
 * Four missed beats at the client's 15s interval. Comfortably past an ordinary
 * page reload or a few seconds of bad wifi, which is the point: this counts
 * silences worth a reviewer's attention, not every network hiccup.
 */
const HEARTBEAT_GAP_SECONDS = 60;

/** Bound on the stored gap list. Counters stay exact; only detail is capped. */
const MAX_HEARTBEAT_GAPS_STORED = 20;

export const examHeartbeat = onCall<HeartbeatData>(
  EXAM_HOT_PATH,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const callerStudentId = request.auth.token.studentId as string | undefined;
    const { attemptId, sebToken } = request.data || ({} as HeartbeatData);
    if (!attemptId) throw new HttpsError('invalid-argument', 'attemptId is required.');

    // Logged BEFORE the attempt is loaded and before any gate, deliberately.
    // These are diagnostics about the CLIENT, and they are most interesting in
    // exactly the cases where the heartbeat then goes on to be refused — a
    // superseded session, a closed window, an expired SEB proof. Logging them
    // after a guard would drop the ones worth reading.
    const machineWarnings = sanitiseMachineWarnings(
      (request.data as HeartbeatData | undefined)?.machineWarnings,
    );
    for (const w of machineWarnings) {
      console.warn(`[examMachine] SHADOW attempt=${attemptId} ${w}`);
    }

    const db = getFirestore();
    const ref = db.collection('attempts').doc(attemptId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Attempt not found.');
    const a = snap.data() as {
      studentId: string; status: string; assessmentId: string;
      securityConfig?: { requireSEB?: boolean } | null;
      lastHeartbeatAt?: string | null;
      heartbeatGaps?: {
        count?: number;
        maxSeconds?: number;
        recent?: Array<{ at: string; seconds: number }>;
      } | null;
      deviceFingerprint?: DeviceFingerprintS | null;
      fingerprintDrift?: { count?: number; firstAt?: string; changes?: string[] } | null;
    };
    // Phase 3 Stage 2b — the proof must hold for the WHOLE exam, not just the
    // door. A student who starts in SEB and switches to Chrome fails here
    // within the token's TTL, because Chrome cannot mint a new proof.
    assertSEB(sebToken, request.auth.uid, a.securityConfig?.requireSEB, a.assessmentId);
    if (a.studentId !== callerStudentId) {
      throw new HttpsError('permission-denied', 'Not your attempt.');
    }
    if (a.status !== 'in_progress') {
      // Ignore heartbeats on finished/frozen attempts — not an error.
      return { ok: true, ignored: true };
    }

    const nowIso = new Date().toISOString();
    const updates: Record<string, unknown> = { lastHeartbeatAt: nowIso };

    // ── Gap measurement ───────────────────────────────────────────
    //
    // No previous stamp means this is the attempt's first beat and there is no
    // interval to measure. A freeze does not produce a false gap either: the
    // early return above means a paused attempt's stamp is never advanced, and
    // the release path (closeFreezeUpdates) re-stamps lastHeartbeatAt at the
    // moment of release — so the pause is excluded rather than counted as
    // silence. That matters, because an invigilator freeze can easily run past
    // this threshold and would otherwise manufacture a gap on every release.
    const prevIso = a.lastHeartbeatAt;
    const prevMs = prevIso ? Date.parse(prevIso) : NaN;
    if (Number.isFinite(prevMs)) {
      const gapSeconds = Math.round((Date.parse(nowIso) - prevMs) / 1000);
      if (gapSeconds > HEARTBEAT_GAP_SECONDS) {
        const prior = a.heartbeatGaps ?? {};
        const recent = [
          ...(prior.recent ?? []),
          { at: nowIso, seconds: gapSeconds },
        ].slice(-MAX_HEARTBEAT_GAPS_STORED);
        // Written as a whole object from the snapshot read above rather than
        // with increment(): count and maxSeconds have to agree with the list,
        // and one attempt has one live session beating every 15s, so there is
        // no writer to race. A dropped record under an unexpected race costs a
        // reviewer one data point and cannot corrupt the attempt.
        updates.heartbeatGaps = {
          count: (prior.count ?? 0) + 1,
          maxSeconds: Math.max(prior.maxSeconds ?? 0, gapSeconds),
          recent,
        };
      }
    }

    // ── Fingerprint drift ─────────────────────────────────────────
    //
    // Compared against the baseline THIS FUNCTION reads from the document, not
    // against anything the caller supplied alongside the current reading — the
    // caller gets to describe the machine it is on and nothing else.
    //
    // An attempt with no baseline (created before this shipped, or by a
    // browser that reported nothing readable) is left alone rather than having
    // the first heartbeat adopt one. A late baseline would be a fingerprint of
    // whoever happens to be holding the sitting now, which is precisely the
    // thing being checked for, and it would make the record say the machine
    // was verified when it never was.
    const current = sanitiseFingerprint(request.data?.fingerprint);
    if (a.deviceFingerprint && current) {
      const changes = fingerprintDriftS(a.deviceFingerprint, current);
      if (changes.length > 0) {
        const prior = a.fingerprintDrift ?? {};
        updates.fingerprintDrift = {
          count: (prior.count ?? 0) + 1,
          // The first is what matters — it dates the moment the sitting stopped
          // being on the machine it started on.
          firstAt: prior.firstAt ?? nowIso,
          // Union, capped: the same drift repeats on every subsequent beat, so
          // storing each occurrence would fill the document with one fact.
          changes: Array.from(new Set([...(prior.changes ?? []), ...changes])).slice(0, 8),
        };
      }
    }

    await ref.update(updates);
    return { ok: true };
  },
);

// ── reportExtensionCheck ──────────────────────────────────────────
// The client reports the result of an extension scan. The SERVER decides
// whether to freeze: if a check FAILS during an active attempt on a tier
// that requires the extension check, the attempt is frozen server-side
// and resume requires verification (see verifyAndResume).
interface ReportExtensionCheckData {
  attemptId: string;
  sebToken?: string;
  passed: boolean;
  found?: string[];
}

export const reportExtensionCheck = onCall<ReportExtensionCheckData>(
  { ...CALLABLE_BASE, secrets: [SEB_SIGNING_SECRET] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const callerUid = request.auth.uid;
    const callerStudentId = request.auth.token.studentId as string | undefined;
    const { attemptId, passed, found } = request.data || ({} as ReportExtensionCheckData);
    if (!attemptId) throw new HttpsError('invalid-argument', 'attemptId is required.');

    const db = getFirestore();
    const ref = db.collection('attempts').doc(attemptId);

    // Transactional now, because a freeze is a ledger append and an append
    // read-modify-written outside a transaction can lose a concurrent entry.
    const shouldFreeze = await db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'Attempt not found.');
      const a = snap.data() as {
        studentId: string;
        status: string;
        assessmentId: string;
        freezes?: FreezeLedgerEntry[];
        securityConfig?: { tier?: string; requireExtensionCheck?: boolean; requireSEB?: boolean } | null;
      };
      if (a.studentId !== callerStudentId) {
        throw new HttpsError('permission-denied', 'Not your attempt.');
      }
      assertSEB(request.data?.sebToken, callerUid, a.securityConfig?.requireSEB, a.assessmentId);

      const nowIso = new Date().toISOString();
      const tierRequiresCheck = a.securityConfig?.requireExtensionCheck === true;
      const alreadyOpen = (a.freezes ?? []).some((f) => !f.endedAt);
      const freezeNow = !passed && a.status === 'in_progress' && tierRequiresCheck && !alreadyOpen;

      // Read before write, and only when there is a freeze to snapshot.
      const aSnap = freezeNow && a.assessmentId
        ? await txn.get(db.collection('assessments').doc(a.assessmentId))
        : null;

      const updates: Record<string, unknown> = {
        lastExtensionCheck: { at: nowIso, passed: !!passed, found: found ?? [] },
        updatedAt: nowIso,
      };

      if (freezeNow) {
        // ── The same pause every other freeze opens (F6) ───────────
        //
        // This wrote freezeState + status and nothing else. No ledger entry
        // meant openFreezeStartedMs found nothing, so effectiveNowMs never
        // pinned and every SERVER clock kept running; no frozenAt meant
        // ExamShell's isFrozen stayed false, so every CLIENT clock kept
        // running too and all four auto-expiry paths stayed armed. A student
        // frozen out by an antivirus false positive was refused answer
        // writes by the rules while their section drained, and was resolved
        // into the next section without ever being released.
        //
        // reason:'extension_check' is what still distinguishes it, and
        // assertCanUnfreeze already reads that field: a system pause has no
        // human owner, so any invigilator may clear it.
        const opened = openFreezeUpdates(
          a as unknown as Record<string, unknown>,
          aSnap?.exists ? (aSnap.data() as Record<string, unknown>) : null,
          { reason: 'extension_check', frozenBy: 'system', frozenByRole: 'system', nowIso },
        );
        Object.assign(updates, opened.updates);
        updates.freezeState = { frozen: true, reason: 'extension_detected', since: nowIso };
        updates.resumeRequiresVerification = true;
        updates.frozenReason = 'Browser extension detected';
      }

      txn.update(ref, updates);
      return freezeNow;
    });

    return { ok: true, frozen: shouldFreeze };
  },
);

// ── verifyAndResume ───────────────────────────────────────────────
// Clears an AUTOMATIC freeze and resumes the attempt, per the auto-resume
// policy. Student may self-resume ONLY if the pause was automatic, the tier is
// auto-resume AND the latest reported check passed. An invigilator may clear
// it subject to the same authority ladder unfreezeAttempt enforces.
//
// ── C-01: THIS WAS THE LADDER'S SECOND DOOR ───────────────────────
//
// §3/§8 attach authority to the individual pause: the freezer, or someone
// strictly above them, and never a peer. assertCanUnfreeze is that rule, read
// from the open ledger entry. unfreezeAttempt calls it. This function ends the
// same pause, through the same closeFreezeUpdates, and did not — it asked two
// other questions instead ("is the tier auto-resume", "did the last check
// pass"), neither of which says anything about who paused the sitting or why.
//
// So both halves of the ladder were reachable from the wrong side. A PEER
// invigilator could clear a colleague's pause here that they were refused one
// function away. And the STUDENT could clear an invigilator's deliberate pause
// outright, because `lastExtensionCheck.passed` is not a fact about the
// machine — it is written by the student's own reportExtensionCheck call, with
// the value their client chose. Measured: faculty pauses a sitting for
// suspected phone use, the student posts a passing check and resumes, and the
// pause ends with no refusal and no record.
//
// WHAT MAKES A PAUSE THE STUDENT'S TO END is now the only question this asks
// of them: the pause must be one nobody chose — reason 'extension_check' or
// 'system', the same set assertCanUnfreeze already treats as ownerless.
interface VerifyAndResumeData { attemptId: string; sebToken?: string; }

/**
 * How much time the AUTOMATIC release may hand back across one sitting (C-02).
 *
 * D8 — "an automatic state needs an automatic exit in the student's favour" —
 * was implemented literally: the whole pause, granted every time, with no
 * ceiling. That is right for the interruption it was written for. It is not
 * right when the pause is one the STUDENT'S OWN CLIENT declares.
 *
 * reportExtensionCheck({passed:false}) opens the pause and
 * reportExtensionCheck({passed:true}) makes it clearable. So on a normal-tier
 * exam with auto-resume the loop
 *
 *     report failed -> think for as long as you like -> report passed -> resume
 *
 * handed back exactly the time it consumed and could be run again. Measured:
 * two forty-minute cycles moved the overall deadline eighty minutes later on a
 * sixty-minute exam. That is not a grace period, it is an untimed exam,
 * reachable from the console by the person being examined.
 *
 * TEN MINUTES, CUMULATIVE, PER SITTING. Generous against the case this exists
 * for — an antivirus false positive, cleared in seconds once the student closes
 * the offending extension — and finite against the loop. A cap per pause would
 * not terminate the loop at all, which is why the budget is per sitting.
 *
 * WHAT IS NOT CAPPED: an invigilator's grant, here or in unfreezeAttempt. A
 * human deciding a pause was genuine can still give back all of it, and that
 * decision carries an actor, an instant and an audit row — the three things the
 * automatic path cannot produce. A student who genuinely lost half an hour to a
 * misbehaving machine is not refused their time; they are asked to get it from
 * somebody who can be accountable for the decision.
 *
 * The pause is still MEASURED in full either way: elapsedMs on the ledger row
 * is the wall-clock truth, grantedMs is what was given. Capping the grant must
 * never falsify the record an invigilator reviews afterwards.
 */
const AUTO_RESUME_CREDIT_CAP_MS = 10 * 60_000;

export const verifyAndResume = onCall<VerifyAndResumeData>(
  { ...CALLABLE_BASE, secrets: [SEB_SIGNING_SECRET] },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const callerRole        = request.auth.token.role        as Role   | undefined;
    const callerStudentId   = request.auth.token.studentId   as string | undefined;
    const callerInstituteId = request.auth.token.instituteId as string | undefined;
    const { attemptId } = request.data || ({} as VerifyAndResumeData);
    if (!attemptId) throw new HttpsError('invalid-argument', 'attemptId is required.');

    const db = getFirestore();
    const ref = db.collection('attempts').doc(attemptId);

    // ── TRANSACTIONAL, for the reason reportExtensionCheck already is ──
    //
    // "A freeze is a ledger append and an append read-modify-written outside a
    // transaction can lose a concurrent entry." The RELEASE is the same shape:
    // closeFreezeUpdates rebuilds the whole `freezes` array from the document
    // it was handed and writes it back wholesale, so a plain read-then-update
    // silently discards any entry that appeared in between. unfreezeAttempt
    // does this work inside a transaction; this one did not.
    const outcome = await db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'Attempt not found.');
      const a = snap.data() as {
        studentId: string;
        instituteId: string;
        status: string;
        assessmentId: string;
        lastExtensionCheck?: { passed?: boolean } | null;
        securityConfig?: { autoResume?: boolean; requireSEB?: boolean } | null;
        // Phase 1: where this freeze started, so its duration can be measured.
        // Extension freezes stamp freezeState.since; invigilator freezes stamp
        // frozenAt. Both are read — see the accumulation note below.
        freezeState?: { frozen?: boolean; since?: string } | null;
        frozenAt?: string | null;
        freezes?: FreezeLedgerEntry[];
      };

      const isStudentOwner = callerRole === 'student' && callerStudentId === a.studentId;
      const isInvigilator =
        callerRole === 'webOwner'
        || ((callerRole === 'institute' || callerRole === 'faculty')
            && callerInstituteId === a.instituteId);
      if (!isStudentOwner && !isInvigilator) {
        throw new HttpsError('permission-denied', 'Not authorized.');
      }
      if (a.status !== 'frozen') {
        return { resumed: false as const };
      }

      // Phase 3 — SEB applies to the EXAM-TAKER only. An invigilator clearing a
      // freeze does so from their own (normal) browser; requiring SEB of staff
      // would lock the student out of their exam permanently.
      if (isStudentOwner) {
        assertSEB(request.data?.sebToken, request.auth!.uid, a.securityConfig?.requireSEB, a.assessmentId);
      }

      // ── C-01: WHOSE PAUSE IS THIS? ──────────────────────────────
      //
      // Asked before anything else, because the auto-resume policy answers a
      // different question — "may this student clear an automatic pause" — and
      // answering it about an invigilator's pause is how the ladder was
      // bypassed.
      //
      // LEGACY, PRE-LEDGER ATTEMPTS carry no entry, and the two paths are
      // still distinguishable there: the extension path was the only writer of
      // freezeState and the invigilator path the only writer of frozenAt. A
      // pause we cannot classify at all is treated as a human's, which is the
      // direction that cannot invent authority — worst case a student waits
      // for staff who can always clear it.
      const openEntry = (a.freezes ?? []).find((f) => !f.endedAt);
      const pauseIsAutomatic = openEntry
        ? (openEntry.reason === 'extension_check' || openEntry.reason === 'system')
        : a.freezeState?.frozen === true;

      if (isStudentOwner && !isInvigilator) {
        if (!pauseIsAutomatic) {
          throw new HttpsError('permission-denied',
            'FREEZE_AUTHORITY: this session was paused by an invigilator. '
            + 'Only they, or someone above them, can resume it.');
        }
        const autoResume   = a.securityConfig?.autoResume === true;
        const latestPassed = a.lastExtensionCheck?.passed === true;
        if (!autoResume || !latestPassed) {
          throw new HttpsError('failed-precondition',
            'RESUME_BLOCKED: verification not satisfied; an invigilator must clear this.');
        }
      } else {
        // The same ladder unfreezeAttempt applies, read from the same entry.
        // A system pause has no human owner and any invigilator may clear it,
        // which assertCanUnfreeze already encodes — so this narrows nothing
        // about the extension case it was written for.
        assertCanUnfreeze({ uid: request.auth!.uid, role: String(callerRole ?? '') }, openEntry);
      }

      const nowIso = new Date().toISOString();

    // ── Release through the SAME function as unfreezeAttempt ──────
    //
    // This used to write status, freezeState and
    // `totalFrozenSeconds: FieldValue.increment(elapsed)` — and no lock, no
    // freezeCredits. Two separate defects came out of that:
    //
    //   F4  Two writers, two meanings, one field. unfreezeAttempt SETS
    //       totalFrozenSeconds from the ledger (GRANTED time); this
    //       INCREMENTED it with measured ELAPSED time. A later invigilator
    //       pause therefore overwrote the extension credit with its own much
    //       smaller ledger sum, and accumulated credit FELL — measured at ten
    //       minutes lost, with overallLockedAfter moving eight minutes
    //       earlier and no penalty row to justify it. INV-4a and INV-3a.
    //
    //   F7  Doctrine D5: the materialised lock is a CACHE and every event
    //       that changes an input must recompute it. Granting credit changes
    //       an input. A released student carried a pre-freeze
    //       answersLockedAfter and pre-freeze freezeCredits until some later
    //       section boundary happened to recompute them.
    //
    // GRANTED IN FULL, and that is a policy choice worth naming. A human
    // pauses a sitting and owes a decision on the paused time, which is why
    // unfreezeAttempt demands an explicit grantedMs. Nobody decided this one:
    // an automated check paused the student. Doctrine D8 says an automatic
    // state needs an automatic exit in the STUDENT'S FAVOUR, and the retired
    // stale-freeze branch in the sweep applied exactly this rule ("stale
    // freezes are granted in full"). An invigilator who judges the pause the
    // student's own fault can still deduct it with unfreezeAttempt's
    // penalties.
      const elapsedForGrant = (() => {
        const since = openEntry?.startedAt ?? a.freezeState?.since ?? a.frozenAt ?? null;
        if (!since) return 0;
        const ms = Date.parse(since);
        return Number.isFinite(ms) ? Math.max(0, Date.now() - ms) : 0;
      })();

      // ── C-02: the automatic path spends from a fixed budget ──────
      //
      // Only the automatic path. An invigilator clearing an extension freeze
      // here is making the same decision unfreezeAttempt exists for, and is
      // trusted with it in exactly the same way.
      const autoSpent = (a.freezes ?? []).reduce(
        (sum, f) => sum + (f.autoGranted ? Math.max(0, f.grantedMs ?? 0) : 0), 0);
      const grantedForThis = isInvigilator
        ? elapsedForGrant
        : Math.min(elapsedForGrant, Math.max(0, AUTO_RESUME_CREDIT_CAP_MS - autoSpent));

      const aSnap = a.assessmentId
        ? await txn.get(db.collection('assessments').doc(a.assessmentId))
        : null;

      const closed = closeFreezeUpdates(
        a as unknown as Record<string, unknown>,
        aSnap?.exists ? (aSnap.data() as Record<string, unknown>) : null,
        {
          grantedMs: grantedForThis,
          decidedBy: isInvigilator ? request.auth!.uid : null,
          // The shortfall is named on the row, so the next person to look at
          // this sitting sees a capped grant rather than a short pause.
          note: !isInvigilator && grantedForThis < elapsedForGrant
            ? 'extension check cleared; automatic credit capped'
            : 'extension check cleared',
          nowIso,
          clearedBy: isInvigilator ? 'invigilator' : 'auto',
          autoGranted: !isInvigilator,
        },
      );

      // ── A9 / C-03: this release invalidates the grade too ────────
      //
      // gradeProvisional's design note explains why a sibling document is safe
      // where a score on the attempt would not be: "unfreezeAttempt deletes the
      // row, so the grade cannot outlive the pause that justified it.
      // Invalidation is not a cleanup step someone must remember — the score
      // has nowhere to go stale."
      //
      // It was a cleanup step someone had to remember, and only one of the two
      // releases remembered. A student who cleared their own extension pause
      // walked away from a stored mark describing a moment that had passed,
      // still stamped with a freezeId that was no longer open, on an attempt
      // they went on answering. Staff surfaces read that row.
      //
      // In the same transaction as the release, for the same reason
      // unfreezeAttempt does it there: a failure between the two leaves a stale
      // grade on a running attempt, which is the exact state A9 forbids.
      // Deleting a row that is not there is a no-op.
      txn.delete(db.collection('provisionalGrades').doc(attemptId));
      txn.update(ref, closed.updates);
      return {
        resumed: true as const,
        elapsedMs: closed.elapsedMs,
        grantedMs: closed.grantedMs,
        byInvigilator: isInvigilator,
      };
    });

    if (!outcome.resumed) return { ok: true, resumed: false, note: 'not frozen' };

    // ── The release leaves a record (C-01) ────────────────────────
    //
    // freezeAttempt writes `attemptFrozen` and unfreezeAttempt writes
    // `attemptUnfrozen`. This path wrote neither, so a pause could begin with
    // an audit row and end without one — including when an invigilator ended
    // it here, which is the same act unfreezeAttempt records.
    //
    // The automatic clearance is recorded too, and named as such: "nobody
    // decided this" is itself the fact a reviewer needs, and a release that
    // moved a deadline should never be invisible just because no human moved
    // it.
    await writeAuditRow(db, {
      action: 'attemptUnfrozen',
      entityType: 'attempt',
      entityId: attemptId,
      actorUid: request.auth.uid,
      actorRole: String(callerRole ?? 'unknown'),
      reason: outcome.byInvigilator ? 'extension check cleared' : 'auto-resume: extension check passed',
      impact: { elapsedMs: outcome.elapsedMs, grantedMs: outcome.grantedMs },
    });
    // M5: credit was granted here without a human choosing it, which is the
    // case INV-4a is least likely to be watched on.
    await auditTimingFromStore(db, 'verifyAndResume', attemptId,
      ['question', 'section', 'break', 'choose', 'ended', 'not_started']);

    return {
      ok: true,
      resumed: true,
      frozenForSeconds: Math.round(outcome.elapsedMs / 1000),
      grantedMs: outcome.grantedMs,
    };
  },
);

// ══════════════════════════════════════════════════════════════════
// PHASE 2.5 — Sequential delivery (linear; adaptive shares this machinery)
//
// submitAnswerAndAdvance: the ONE atomic operation that makes linear real.
// Answering and advancing happen together, server-side:
//   validate → write answer → lock it → serve the next question
// The client never holds the paper (getExamQuestions is scoped to
// servedQuestions) and cannot answer a locked or unserved question.
// ══════════════════════════════════════════════════════════════════

interface SubmitAnswerAndAdvanceData {
  attemptId: string;
  sebToken?: string;
  /** Phase 2 — the browser session driving this sitting (INV-5a). */
  sessionId?: string;
  questionId: string;
  // null = no answer (e.g. per-question timer expired). We deliberately do NOT
  // write a blank answer: an unanswered served question already scores 0, and
  // writing a null value would pollute the timing analytics with a fake
  // answeredAt. Skipping the write keeps grading unambiguous.
  answer: { type: string; value: unknown } | null;
}

/**
 * Refuse an answer whose section or overall clock has already run out. (A-03.)
 *
 * WHY THIS EXISTS AT ALL — the asymmetry it closes.
 *
 * In STANDARD delivery answers are a direct client write and firestore.rules
 * refuse them past `answersLockedAfter` (answerWriteWindowOpen, :754). In
 * LINEAR/ADAPTIVE the rules refuse the direct write outright
 * (studentAnswerWriteAllowed, :629) — answers may travel ONLY through
 * submitAnswerAndAdvance and saveAnswerNoAdvance, which run under the Admin SDK
 * and therefore bypass rules entirely.
 *
 * Both callables checked auth, ownership, session, SEB, status, delivery mode
 * and the served-question pointer, then computed `lateAnswer` against the
 * QUESTION clock — and stored the answer regardless. Neither ever read the
 * section or overall bound. So sequential delivery, which is the MORE
 * controlled mode (one question at a time, no going back, the client never
 * holds the paper), was the WEAKER one on time: measured accepting an answer 25
 * minutes past the overall deadline while getExamVerdict already said 'ended'.
 *
 * The bound enforced here is deliberately min(section, overall) — byte-for-byte
 * what `answersLockedAfter` holds and what the rules enforce for standard mode.
 * Parity is the point; a sequential student should face the same wall as a
 * standard one, no earlier and no later.
 *
 * Freeze is credited and paused exactly as everywhere else: computeDeadlines
 * applies per-clock credit (D-28) and subtracts recorded penalties (A4), and
 * effectiveNowMs holds time still while a freeze is open (4.3). A paused
 * student therefore cannot be refused for time that was never theirs to spend.
 *
 * A MISSING BOUND IS NOT AN EXPIRED BOUND. An untimed exam, an unreadable
 * anchor or an absent assessment all yield null, and null means "no
 * constraint" — never "over". The failure direction favours the student, which
 * is the rule the whole timing module is built on.
 */
function assertSequentialAnswerWindowOpen(
  attempt: Record<string, unknown>,
  assessmentRaw: Record<string, unknown> | undefined,
  nowMs: number,
): void {
  if (!assessmentRaw) return;          // cannot prove a deadline; do not invent one
  let endsAt: number | null;
  let evalNow: number;
  try {
    const core = toCoreAttempt(attempt);
    // A-06: the clocks this attempt was given, not the exam's current ones.
    const contract = examContractFor(attempt, assessmentRaw) ?? assessmentRaw;
    const dl = computeDeadlines(core, toCoreAssessment(contract));
    endsAt = minNonNullMs(dl.sectionEndsAt, dl.overallEndsAt);
    evalNow = effectiveNowMs(core, nowMs);
  } catch (e) {
    // A resolver fault must never cost a student their answer. Same posture as
    // auditTiming and gradeAttempt's escape hatch: fail soft, let them write.
    console.warn('[assertSequentialAnswerWindowOpen] deadline check failed; allowing', e);
    return;
  }
  if (endsAt === null || evalNow <= endsAt) return;
  throw new HttpsError(
    'deadline-exceeded',
    'ANSWER_WINDOW_CLOSED: your time for this section has ended.',
  );
}

/** min() over the bounds that actually exist. Null when none do. */
function minNonNullMs(...xs: Array<number | null>): number | null {
  const vals = xs.filter((x): x is number => x !== null);
  return vals.length === 0 ? null : Math.min(...vals);
}

export const submitAnswerAndAdvance = onCall<SubmitAnswerAndAdvanceData>(
  EXAM_HOT_PATH,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const role      = request.auth.token.role      as string | undefined;
    const studentId = request.auth.token.studentId as string | undefined;
    if (role !== 'student' || !studentId) {
      throw new HttpsError('permission-denied', 'Only students may answer.');
    }
    const { attemptId, questionId, answer, sebToken } = request.data || ({} as SubmitAnswerAndAdvanceData);
    if (!attemptId || !questionId) {
      throw new HttpsError('invalid-argument', 'attemptId and questionId are required.');
    }

    const db = getFirestore();
    const attemptRef = db.collection('attempts').doc(attemptId);
    const attemptSnap = await attemptRef.get();
    if (!attemptSnap.exists) throw new HttpsError('not-found', 'Attempt not found.');
    const attempt = attemptSnap.data() as {
      studentId: string;
      status: string;
      assessmentId: string;
      questionOrder?: Record<string, string[]>;
      servedQuestions?: Array<{
        questionId: string; sectionId: string; difficulty: string;
        servedAt: string; locked: boolean;
      }>;
      securityConfig?: { deliveryMode?: string; requireSEB?: boolean } | null;
      activeSessionId?: string | null;
    };

    if (attempt.studentId !== studentId) {
      throw new HttpsError('permission-denied', 'Not your attempt.');
    }
    assertSession(attempt, request.data?.sessionId, 'submitAnswerAndAdvance');
    if (attempt.status !== 'in_progress') {
      throw new HttpsError('failed-precondition', 'Attempt is not in progress.');
    }
    assertSEB(sebToken, request.auth.uid, attempt.securityConfig?.requireSEB, attempt.assessmentId);
    const dMode = attempt.securityConfig?.deliveryMode ?? 'standard';
    if (dMode !== 'linear' && dMode !== 'adaptive') {
      throw new HttpsError('failed-precondition',
        'This exam uses standard delivery; answers are saved directly.');
    }

    // The question being answered MUST be the current served, unlocked one.
    // This is what enforces strict-linear: a locked question can never be
    // revisited, and an unserved question is unknown to the client anyway.
    const served = attempt.servedQuestions ?? [];
    const current = served.length > 0 ? served[served.length - 1] : undefined;
    if (!current || current.questionId !== questionId || current.locked === true) {
      throw new HttpsError('failed-precondition',
        'QUESTION_LOCKED: you cannot answer this question.');
    }

    const nowIso = new Date().toISOString();

    // Per-question timing (authority toggle: section.questionTimeLimit in
    // seconds; undefined = off). A late answer is RECORDED and FLAGGED, never
    // rejected — a lag spike must not cost a student their work. The server's
    // servedAt is the only clock that counts.
    const aSnap = await db.collection('assessments').doc(attempt.assessmentId).get();
    const assessment = aSnap.exists ? (aSnap.data() as GradingAssessmentDoc) : undefined;
    // D-21: reuses the read above — no extra cost.
    assertNotBlocked(assessment as { blockedStudents?: string[] } | undefined, studentId);
    // A-03: the section and overall clocks reach this path at last. Placed
    // before any write, so a refused answer leaves no trace and the served
    // pointer does not move.
    assertSequentialAnswerWindowOpen(
      attempt as unknown as Record<string, unknown>,
      assessment as unknown as Record<string, unknown> | undefined,
      Date.parse(nowIso),
    );
    // B-04: questionTimeLimit lives on the section, and this read it from the
    // LIVE document — so cutting the per-question clock mid-sitting
    // retroactively made answers late for a student already looking at the
    // question. The clock a student races is part of the contract they started
    // under (A-06); this is the one reader of it that was missed.
    const contractForQ = assessment
      ? examContractFor(
          attempt as unknown as Record<string, unknown>,
          assessment as unknown as Record<string, unknown>,
        ) as GradingAssessmentDoc
      : undefined;
    const sectionsNorm = contractForQ ? normalizeSections(contractForQ) : [];

    // Phase 3b shadow — the question clock is where server and client have
    // historically disagreed most (D-14: 5s grace here, 0s there, and the last
    // question of every section untimed). Reported only.
    auditTiming('submitAnswerAndAdvance', attemptId,
      attempt as unknown as Record<string, unknown>,
      assessment as unknown as Record<string, unknown> | undefined,
      ['question', 'section', 'break', 'choose', 'ended']);
    const secDef = sectionsNorm.find((s) => s.id === current.sectionId);
    const qLimit = secDef?.questionTimeLimit;
    // ── What "late" means, from one source (F13 / D-14) ────────────
    //
    // This was `qLimit + 5`, hardcoded, in both this function and its sibling.
    // D-14's fix was "one number, consumed by BOTH sides" — the assessment's
    // questionGraceSeconds — and the resolver consumed it while these two did
    // not, so an exam configured with a 15s grace flagged answers late that
    // the resolver considered on time.
    //
    // Freeze credit is applied for the same reason it applies to every other
    // clock: a pause the invigilator gave back is time the student is entitled
    // to spend, and flagging their answer late for spending it re-imposes the
    // pause as a penalty nobody decided.
    const lateGraceSec =
      (contractForQ as { questionGraceSeconds?: number } | undefined)?.questionGraceSeconds
      ?? DEFAULT_QUESTION_GRACE_SECONDS;
    let lateAnswer = false;
    if (typeof qLimit === 'number' && qLimit > 0) {
      const creditSec = creditForAnchor(
        toCoreAttempt(attempt as unknown as Record<string, unknown>), current.servedAt) / 1000;
      const elapsedSec = (Date.parse(nowIso) - Date.parse(current.servedAt)) / 1000;
      if (elapsedSec > qLimit + lateGraceSec + creditSec) lateAnswer = true;
    }

    const updates: Record<string, unknown> = { updatedAt: nowIso };

    // Write the answer server-side (Admin SDK bypasses rules — and the rules
    // forbid the client from writing answers in sequential delivery).
    // Firestore rejects `undefined`, so a missing value is normalised to null.
    if (answer && typeof answer.type === 'string') {
      updates[`answers.${questionId}`] = {
        type: answer.type,
        value: answer.value === undefined ? null : answer.value,
        sectionId: current.sectionId,
        answeredAt: nowIso,
        ...(lateAnswer ? { lateAnswer: true } : {}),
      };
    }

    // Lock the answered question, then pick the next one in this section.
    const nextServed = served.map((s, i) =>
      i === served.length - 1 ? { ...s, locked: true } : s);

    const orderForSection = attempt.questionOrder?.[current.sectionId] ?? [];
    const servedIdsInSection = new Set(
      served.filter((s) => s.sectionId === current.sectionId).map((s) => s.questionId));
    const nextQid = orderForSection.find((qid) => !servedIdsInSection.has(qid));

    let nextQuestion: ReturnType<typeof sanitizeQuestionForStudent> | null = null;
    if (nextQid) {
      const qSnap = await db.collection('questions').doc(nextQid).get();
      if (qSnap.exists) {
        const qData = qSnap.data() as Record<string, unknown>;
        nextServed.push({
          questionId: nextQid,
          sectionId: current.sectionId,
          difficulty: (qData.difficulty as string) ?? 'medium',
          servedAt: nowIso,
          locked: false,
        });
        nextQuestion = sanitizeQuestionForStudent(qData, false);
      }
    }

    updates.servedQuestions = nextServed;

    // ── D-35 completion: serving a question RESETS its credit ───────
    //
    // freezeCredits.questionMs is anchored on the CURRENT question's servedAt,
    // so it has to be recomputed every time that anchor moves. This site was
    // missed: startExam, startSection and both submitSection branches all
    // refresh it, and this one — the ordinary next-question advance, by far
    // the most frequent of the four — did not.
    //
    // The effect was that a pause was paid out again on every subsequent
    // question. Freeze 40s on question 1, grant it in full, and question 2
    // opened showing 24s + 5s grace + that same 40s. The student saw a minute
    // and four seconds on a twenty-four second question, and the server's own
    // deadline agreed, because both read the same stale number.
    //
    // The new question was served AT nowIso, so no freeze can have begun after
    // its anchor: creditForAnchor returns 0 by arithmetic, exactly as at a
    // section advance. The outer clocks keep their credit, which is the whole
    // point of crediting per clock.
    applyCreditUpdates(
      updates,
      toCoreAttempt(attempt as unknown as Record<string, unknown>),
      { questionServedAt: nowIso },
    );

    await attemptRef.update(updates);

    return {
      ok: true,
      question: nextQuestion,          // null when the section is finished
      sectionComplete: !nextQid,
      lateAnswer,
    };
  },
);

// ══════════════════════════════════════════════════════════════════
// PHASE 4.2 — SAVE WITHOUT ADVANCING  (sequential delivery)
//
// WHY THIS EXISTS
// In linear/adaptive the ONLY route an answer has to the server is
// submitAnswerAndAdvance, and firestore.rules reject a direct client write.
// That function does not merely save — it LOCKS the answered question and
// SERVES the next one. So there has been no way to persist the selection in
// front of a student without also moving them past it.
//
// Three things need exactly that:
//
//   1. FREEZE (FREEZE_AND_ROADMAP A2 step 1). The first thing that must happen
//      when an invigilator pauses a sitting is "their answer is saved".
//      Advancing a student you have just paused would be a worse bug than the
//      one being fixed — ExamShell said so in as many words, which is why
//      flushAnswers() returned early for sequential modes and the current
//      selection was simply lost on freeze.
//   2. ANSWER DURABILITY (Part B / D-31). The retry-and-sweep layer needs a
//      commit that is safe to call repeatedly.
//   3. Ordinary crash resilience: a browser that dies between being served a
//      question and advancing past it currently loses the selection entirely.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   • does not set `locked` on the served entry
//   • does not append a new served question
//   • does not touch sectionTimings, currentSectionIdx, or any lock field
//
// It writes exactly two keys: `answers.{questionId}` and `updatedAt`, both as
// dot-paths, so it cannot disturb neighbouring state even if a future edit is
// careless. Calling it twice is harmless — the second write overwrites the
// first with the same shape.
//
// LATE ANSWERS
// A late answer against the QUESTION clock is recorded and flagged, never
// rejected — byte-for-byte the policy submitAnswerAndAdvance applies, using the
// assessment's own questionGraceSeconds (F13/D-14 replaced the hardcoded
// `qLimit + 5` this comment used to name), so the two cannot disagree about
// what "late" means. A lag spike must not cost a student their work.
//
// The SECTION and OVERALL clocks are different, and since A-03 both callables
// refuse an answer past them through one shared gate. That is not a latency
// question — it is the deadline itself, and standard delivery has always
// enforced it through firestore.rules.
//
// NOT FOR STANDARD DELIVERY. Standard-mode answers are a direct, rules-gated
// client write, which the master plan's trust-boundary table blesses
// explicitly. Routing a whole cohort's 1.5s autosaves through a callable
// instead would be a large capacity change for no security gain.
// ══════════════════════════════════════════════════════════════════

interface SaveAnswerNoAdvanceData {
  attemptId: string;
  sebToken?: string;
  /** Phase 2 — the browser session driving this sitting (INV-5a). */
  sessionId?: string;
  questionId: string;
  /**
   * The student's current selection.
   *
   * `null` is a NO-OP here, not a recorded non-answer. This differs from
   * submitAnswerAndAdvance on purpose: there, null means "the per-question
   * timer expired and they are moving on regardless", which is a real event
   * worth recording as unanswered. Here it means "nothing is selected yet",
   * and writing a blank would put a fake `answeredAt` on a question the
   * student has not answered.
   */
  answer: { type: string; value: unknown } | null;
}

/**
 * How long after a pause begins a durability flush is still accepted (C-04).
 *
 * This is the width of "the flush was already in flight", not a grace period
 * the student may spend. See the note at the status gate in
 * saveAnswerNoAdvance for why it exists and why it is the only write path that
 * needs one.
 */
const FROZEN_FLUSH_GRACE_MS = 60_000;

export const saveAnswerNoAdvance = onCall<SaveAnswerNoAdvanceData>(
  // Born with capacity settings (D-19). Every sequential-mode student will hit
  // this on a debounce plus a periodic durability sweep, so it carries
  // strictly MORE traffic than submitAnswerAndAdvance, which it sits beside.
  // Retrofitting capacity onto a hot-path callable after the fact is the
  // mistake D-19 records; this one does not repeat it. EXAM_HOT_PATH also
  // carries SEB_SIGNING_SECRET, without which assertSEB fails closed.
  EXAM_HOT_PATH,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const role      = request.auth.token.role      as string | undefined;
    const studentId = request.auth.token.studentId as string | undefined;
    if (role !== 'student' || !studentId) {
      throw new HttpsError('permission-denied', 'Only students may answer.');
    }
    const { attemptId, questionId, answer, sebToken } =
      request.data || ({} as SaveAnswerNoAdvanceData);
    if (!attemptId || !questionId) {
      throw new HttpsError('invalid-argument', 'attemptId and questionId are required.');
    }

    const db = getFirestore();
    const attemptRef = db.collection('attempts').doc(attemptId);
    const attemptSnap = await attemptRef.get();
    if (!attemptSnap.exists) throw new HttpsError('not-found', 'Attempt not found.');
    const attempt = attemptSnap.data() as {
      studentId: string;
      status: string;
      assessmentId: string;
      servedQuestions?: Array<{
        questionId: string; sectionId: string; difficulty: string;
        servedAt: string; locked: boolean;
      }>;
      securityConfig?: { deliveryMode?: string; requireSEB?: boolean } | null;
      activeSessionId?: string | null;
      // C-04: how long this sitting has been paused, so an in-flight flush can
      // be told apart from working through the pause.
      freezes?: FreezeLedgerEntry[];
      frozenAt?: string | null;
    };

    if (attempt.studentId !== studentId) {
      throw new HttpsError('permission-denied', 'Not your attempt.');
    }
    assertSession(attempt, request.data?.sessionId, 'saveAnswerNoAdvance');

    // ── `frozen` is accepted BRIEFLY, and the bound is the point (C-04) ──
    //
    // The client learns of a freeze through its Firestore subscription, so a
    // flush already in flight lands just AFTER the pause. Refusing every frozen
    // attempt would fail this call at precisely the moment it exists to
    // succeed, which is why 'frozen' is accepted at all.
    //
    // What was never bounded is how long "just after" lasts, and F5 named the
    // rule the unbounded version breaks: "A pause is a state the student cannot
    // write from… a pause that stops the clock but not the student is an
    // unbounded time grant to anyone willing to call the callable directly."
    //
    // The window was not merely open, it was UNTIMED. effectiveNowMs pins the
    // resolver's clock at the freeze, so assertSequentialAnswerWindowOpen — the
    // A-03 gate below — cannot refuse a paused student either. Measured: a
    // student frozen at 9:01 of a 30-minute section was still writing new
    // answers into it at 9:41, and the answer they composed during the pause is
    // the one scoreAttemptAnswers marks.
    //
    // A-03's shape again, in the same place: sequential delivery, the MORE
    // controlled mode, was the weaker one. Every other write path already
    // refuses a pause — firestore.rules require in_progress on both sides of a
    // standard-mode answer write, submitAnswerAndAdvance refuses anything but
    // in_progress, runCodeSample refuses an open freeze in as many words, and
    // recordCodeTelemetry refuses it too. That last one is the sharpest: on a
    // coding paper the answer went on changing while the record of how it was
    // produced had a hole exactly there.
    //
    // ONE MINUTE, measured from the start of the open pause. Long enough for a
    // debounced flush, a 6s client timeout and a subscription that is slow to
    // deliver the freeze; far short of working through a pause. A student whose
    // subscription is broken for longer than that loses edits made after it
    // broke, and that is the right side to fail on: the alternative is the
    // exam continuing for whoever can keep the tab open.
    //
    // Terminal attempts are still refused outright: nothing may be written to a
    // sitting that has been graded (INV-6).
    if (attempt.status !== 'in_progress' && attempt.status !== 'frozen') {
      throw new HttpsError('failed-precondition', 'Attempt is not live.');
    }
    if (attempt.status === 'frozen') {
      const open = (attempt.freezes ?? []).find((f) => !f.endedAt);
      // Legacy pauses carry no ledger entry; frozenAt is what both pre-ledger
      // paths wrote. An unreadable start instant means the flush is allowed —
      // a missing bound is not an expired bound, the same rule the whole timing
      // module fails on.
      const sinceIso = open?.startedAt ?? attempt.frozenAt ?? null;
      const sinceMs = sinceIso ? Date.parse(sinceIso) : NaN;
      if (Number.isFinite(sinceMs) && Date.now() - sinceMs > FROZEN_FLUSH_GRACE_MS) {
        throw new HttpsError('failed-precondition',
          'ATTEMPT_PAUSED: this sitting is paused; answers cannot be saved until it resumes.');
      }
    }
    assertSEB(sebToken, request.auth.uid, attempt.securityConfig?.requireSEB, attempt.assessmentId);

    const dMode = attempt.securityConfig?.deliveryMode ?? 'standard';
    if (dMode !== 'linear' && dMode !== 'adaptive') {
      throw new HttpsError('failed-precondition',
        'This exam uses standard delivery; answers are saved directly.');
    }

    // Same gate as submitAnswerAndAdvance: the question must be the current
    // served, unlocked one. A locked question is finished and must never be
    // rewritten; an unserved question is one the client should not know about.
    const served = attempt.servedQuestions ?? [];
    const current = served.length > 0 ? served[served.length - 1] : undefined;
    if (!current || current.questionId !== questionId || current.locked === true) {
      throw new HttpsError('failed-precondition',
        'QUESTION_LOCKED: you cannot answer this question.');
    }

    // Nothing selected. Not an error: the durability sweep is allowed to call
    // this speculatively, and a student clearing their choice is legitimate.
    // Reported honestly as `saved: false` rather than a fake success (D7).
    if (!answer || typeof answer.type !== 'string') {
      return { ok: true, saved: false, savedAt: null, lateAnswer: false };
    }

    const nowIso = new Date().toISOString();

    const aSnap = await db.collection('assessments').doc(attempt.assessmentId).get();
    const assessment = aSnap.exists ? (aSnap.data() as GradingAssessmentDoc) : undefined;
    // D-21: reuses the read above — no extra cost. Kept identical to
    // submitAnswerAndAdvance deliberately; whether a blocked student may still
    // SAVE work they had already done is N5's to decide, and this function
    // must not quietly answer it differently from its sibling.
    assertNotBlocked(assessment as { blockedStudents?: string[] } | undefined, studentId);
    // A-03: the same gate its sibling applies, from the same function, so the
    // two cannot disagree about when a student's time is up. A durability
    // flush that arrives after the deadline is refused here exactly as the
    // rules would refuse a standard-mode autosave at the same instant.
    assertSequentialAnswerWindowOpen(
      attempt as unknown as Record<string, unknown>,
      assessment as unknown as Record<string, unknown> | undefined,
      Date.parse(nowIso),
    );
    // B-04: same frozen question clock its sibling uses — see the note there.
    const contractForQ = assessment
      ? examContractFor(
          attempt as unknown as Record<string, unknown>,
          assessment as unknown as Record<string, unknown>,
        ) as GradingAssessmentDoc
      : undefined;
    const sectionsNorm = contractForQ ? normalizeSections(contractForQ) : [];
    const secDef = sectionsNorm.find((s) => s.id === current.sectionId);
    const qLimit = secDef?.questionTimeLimit;
    // ── What "late" means, from one source (F13 / D-14) ────────────
    //
    // This was `qLimit + 5`, hardcoded, in both this function and its sibling.
    // D-14's fix was "one number, consumed by BOTH sides" — the assessment's
    // questionGraceSeconds — and the resolver consumed it while these two did
    // not, so an exam configured with a 15s grace flagged answers late that
    // the resolver considered on time.
    //
    // Freeze credit is applied for the same reason it applies to every other
    // clock: a pause the invigilator gave back is time the student is entitled
    // to spend, and flagging their answer late for spending it re-imposes the
    // pause as a penalty nobody decided.
    const lateGraceSec =
      (contractForQ as { questionGraceSeconds?: number } | undefined)?.questionGraceSeconds
      ?? DEFAULT_QUESTION_GRACE_SECONDS;
    let lateAnswer = false;
    if (typeof qLimit === 'number' && qLimit > 0) {
      const creditSec = creditForAnchor(
        toCoreAttempt(attempt as unknown as Record<string, unknown>), current.servedAt) / 1000;
      const elapsedSec = (Date.parse(nowIso) - Date.parse(current.servedAt)) / 1000;
      if (elapsedSec > qLimit + lateGraceSec + creditSec) lateAnswer = true;
    }

    // Firestore rejects `undefined`, so a missing value is normalised to null.
    await attemptRef.update({
      [`answers.${questionId}`]: {
        type: answer.type,
        value: answer.value === undefined ? null : answer.value,
        sectionId: current.sectionId,
        answeredAt: nowIso,
        ...(lateAnswer ? { lateAnswer: true } : {}),
      },
      updatedAt: nowIso,
    });

    // M5 (audit 2026-08-06): shadow audit on the highest-frequency write in
    // the system.
    //
    // The `decided` set is every verdict kind, which makes the VERDICT half of
    // this call a no-op by construction — and that is honest rather than lazy.
    // saveAnswerNoAdvance makes no timing decision to compare against: it
    // persists a selection and deliberately declines to advance, which is why
    // it exists separately from submitAnswerAndAdvance. Asserting a narrower
    // set would manufacture disagreements out of a function that never
    // disagreed, exactly the failure this helper's own comments record twice.
    // submitAnswerAndAdvance passes the full set for the same reason.
    //
    // What is NOT a no-op is checkTimingInvariants, which runs against stored
    // state regardless of `decided`. That is the half worth having here: this
    // is the callable a live sitting hits most often, so it is the earliest
    // and cheapest place a drifting clock becomes visible. No extra read —
    // `attempt` and `assessment` are already in hand.
    //
    // No projection: the write touches answers and updatedAt, never a clock,
    // so stored state and post-write state agree on everything the resolver
    // reads.
    auditTiming('saveAnswerNoAdvance', attemptId,
      attempt as unknown as Record<string, unknown>,
      assessment as unknown as Record<string, unknown> | undefined,
      ['question', 'section', 'break', 'choose', 'ended', 'not_started']);

    // savedAt is echoed back so the client's durability layer (Phase 4.1) can
    // mark this exact selection confirmed rather than assuming the request it
    // sent was the one that landed.
    return { ok: true, saved: true, savedAt: nowIso, lateAnswer };
  },
);

// ══════════════════════════════════════════════════════════════════
// PHASE 3 — SEB DIAGNOSTIC (Stage 1; temporary, webOwner-only)
//
// Enforcement is NOT written yet, on purpose. Two things cannot be settled
// from documentation and, if guessed wrong, would reject every candidate:
//   1. Does SEB inject X-SafeExamBrowser-ConfigKeyHash into CROSS-ORIGIN XHR
//      (our callables live on cloudfunctions.net, the app on Vercel)?
//   2. What exact absolute URL does SEB use as the hash salt, and can we
//      reconstruct it byte-for-byte behind Cloud Run's proxy?
//
// SEB computes: SHA256(absoluteRequestURL + ConfigKey), URL first, fragment
// stripped, hex-encoded. A single character of URL drift changes the hash
// completely. So: run this once inside real SEB, read the truth, then write
// the verification against it.
//
// Returns every plausible URL reconstruction plus the raw SEB headers, and —
// if a candidate key is supplied — which reconstruction (if any) reproduces
// the received hash. That last part is what pins Stage 2.
// ══════════════════════════════════════════════════════════════════

interface SebDiagnosticsData {
  candidateConfigKey?: string; // optional: test a key against every URL form
}

export const sebDiagnostics = onCall<SebDiagnosticsData>(
  CALLABLE_BASE,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    if (request.auth.token.role !== 'webOwner') {
      throw new HttpsError('permission-denied', 'webOwner only.');
    }

    const req = request.rawRequest as unknown as {
      headers: Record<string, string | string[] | undefined>;
      originalUrl?: string;
      url?: string;
      method?: string;
    };
    const headers = req.headers ?? {};
    const hdr = (n: string): string | undefined => {
      const v = headers[n];
      return Array.isArray(v) ? v[0] : v;
    };

    // Every SEB header we received, verbatim.
    const sebHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase().startsWith('x-safeexambrowser')) {
        sebHeaders[k] = Array.isArray(v) ? v.join(',') : String(v ?? '');
      }
    }

    const host           = hdr('host');
    const xForwardedHost = hdr('x-forwarded-host');
    const proto          = hdr('x-forwarded-proto') ?? 'https';
    const path           = req.originalUrl ?? req.url ?? '';
    const origin         = hdr('origin');
    const referer        = hdr('referer');

    // Candidate absolute URLs SEB might have hashed.
    //
    // IMPORTANT (learned from the Chrome control run): Cloud Run strips the
    // function name from originalUrl — `path` arrives as "/" — so
    // `${host}${path}` reconstructs to ".../" and MISSES the function name.
    // The browser, however, requested ".../sebDiagnostics". So the reliable
    // reconstruction is `https://{host}/{functionName}`, which also
    // generalises to every other callable in Stage 2.
    const pathNoQuery = path.split('?')[0];
    const fnName = process.env.K_SERVICE ?? 'sebDiagnostics'; // Cloud Run service = function name
    const urlCandidates: Record<string, string> = {
      // The two that the control run proved are WRONG (kept to show the drift):
      host_full:            `${proto}://${host}${path}`,
      host_noQuery:         `${proto}://${host}${pathNoQuery}`,
      // The generalisable forms — these are what Stage 2 will use:
      host_fnName:          `${proto}://${host}/${fnName}`,
      host_fnName_httpsFixed: `https://${host}/${fnName}`,
      xfwdHost_fnName:      xForwardedHost ? `${proto}://${xForwardedHost}/${fnName}` : '',
      cloudfunctions_guess: `https://us-central1-${process.env.GCLOUD_PROJECT ?? ''}.cloudfunctions.net/${fnName}`,
      // Trailing-slash variant, in case SEB normalised it that way:
      host_fnName_slash:    `${proto}://${host}/${fnName}/`,
    };

    // If a candidate key was supplied, show which URL form reproduces the
    // received ConfigKeyHash. Whichever matches is the one Stage 2 must use.
    const received = (sebHeaders['x-safeexambrowser-configkeyhash']
      ?? sebHeaders['X-SafeExamBrowser-ConfigKeyHash'] ?? '').toLowerCase();
    const matches: Record<string, boolean> = {};
    if (request.data?.candidateConfigKey && received) {
      const key = request.data.candidateConfigKey.trim();
      for (const [name, url] of Object.entries(urlCandidates)) {
        if (!url) continue;
        const h = createHash('sha256').update(url + key, 'utf8').digest('hex');
        matches[name] = h.toLowerCase() === received;
      }
    }

    return {
      ok: true,
      sawAnySebHeader: Object.keys(sebHeaders).length > 0,
      sebHeaders,
      receivedConfigKeyHash: received || null,
      urlCandidates,
      matches,               // {} unless candidateConfigKey supplied
      raw: {
        host, xForwardedHost, proto, path, origin, referer, method: req.method,
        // Confirms how we derive the function name for URL reconstruction.
        K_SERVICE: process.env.K_SERVICE ?? null,
        GCLOUD_PROJECT: process.env.GCLOUD_PROJECT ?? null,
      },
      userAgent: hdr('user-agent') ?? null,
    };
  },
);

// ══════════════════════════════════════════════════════════════════
// PHASE 3 — SEB proof verification (Stage 2)
//
// The SEB header never reaches these functions: SEB injects its keys only on
// same-origin requests to the app's domain (measured, Stage 1). So the app
// calls /api/seb-verify on Vercel, which checks the ConfigKeyHash and mints a
// short-lived HMAC token bound to the AUTHENTICATED uid. We verify that token
// here.
//
// Token format: v1.<base64url(JSON{uid,exp,v})>.<hex hmac-sha256 of the b64 part>
// The signing secret is shared with Vercel and must match exactly.
//
// Short TTL is the point: a student who verifies in SEB and then switches to
// Chrome cannot mint a new token (Chrome sends no SEB header), so access dies
// within a minute or so.
// ══════════════════════════════════════════════════════════════════


/**
 * Split the configured secret into the list of secrets that are VALID RIGHT NOW.
 *
 * ── WHY A LIST (audit S-6 / R-14) ─────────────────────────────────
 *
 * The signing secret lives in two deployment systems that cannot see each
 * other: Vercel mints the proof, Cloud Functions verify it. While each side
 * held exactly ONE secret there was no rotation that did not break exams —
 * whichever side you changed first, every proof was rejected until the other
 * caught up, and DEPLOY.md §9 had to tell operators to take a window.
 *
 * The shape is not new to this file. `SEB_CONFIG_KEYS` — the other SEB secret,
 * read a few functions over in api/seb-verify.js — has always been a
 * comma-separated list, precisely so several can be valid at once. This is
 * that same idea applied to the secret that actually needed it.
 *
 * VERIFY ACCEPTS ANY; THE MINTER USES THE FIRST. That asymmetry is what makes
 * rotation seamless, and it decides the order of operations:
 *
 *   1. append the new secret here   → both old and new proofs verify
 *   2. put the new secret first in Vercel → new proofs are minted
 *   3. drop the old secret from here → the old one stops working
 *
 * At no point is a proof in flight rejected. A single secret with no comma is
 * unchanged behaviour, which is what makes this safe to deploy before anyone
 * intends to rotate.
 */
function sebSecrets(raw: string): string[] {
  return String(raw || '').split(',').map((x) => x.trim()).filter(Boolean);
}

function verifySebToken(token: string, uid: string, secrets: string[], assessmentId: string): void {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    throw new HttpsError('permission-denied', 'SEB_REQUIRED: malformed proof.');
  }
  const [, b64, sig] = parts;

  // Every candidate secret is tried, and the loop does NOT break early on a
  // match — it records one. Returning as soon as a secret matches would make
  // the work depend on WHICH secret signed the proof, and during a rotation
  // that difference is observable: an old-secret proof would take measurably
  // longer than a new-secret one. Constant work across the list keeps the
  // timing-safe comparison actually timing-safe.
  const b = Buffer.from(sig, 'utf8');
  let matched = false;
  for (const secret of secrets) {
    const expected = createHmac('sha256', secret).update(b64).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    if (a.length === b.length && timingSafeEqual(a, b)) matched = true;
  }
  if (!matched) {
    throw new HttpsError('permission-denied', 'SEB_REQUIRED: proof signature invalid.');
  }

  let body: { uid?: string; aid?: string; exp?: number };
  try {
    body = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
  } catch {
    throw new HttpsError('permission-denied', 'SEB_REQUIRED: proof unreadable.');
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof body.exp !== 'number' || body.exp <= now) {
    throw new HttpsError('permission-denied', 'SEB_EXPIRED: re-verify Safe Exam Browser.');
  }
  // Binding to the caller is what stops one student in SEB minting proofs for
  // classmates sitting in Chrome.
  if (!body.uid || body.uid !== uid) {
    throw new HttpsError('permission-denied', 'SEB_REQUIRED: proof belongs to another user.');
  }
  // Stage 4: binding to the ASSESSMENT is what makes per-exam Config Keys
  // real — without it, a session verified under the platform config could be
  // replayed against an exam that demands its own config.
  // A token without aid is a stale mint from the pre-Stage-4 endpoint (≤90s
  // window during deploy): SEB_EXPIRED makes the client force-refresh, and the
  // fresh token carries aid. A token with the WRONG aid is a replay: rejected
  // outright.
  if (typeof body.aid !== 'string' || !body.aid) {
    throw new HttpsError('permission-denied', 'SEB_EXPIRED: re-verify Safe Exam Browser.');
  }
  if (body.aid !== assessmentId) {
    throw new HttpsError('permission-denied', 'SEB_REQUIRED: proof was issued for a different exam.');
  }
}

/**
 * No-op unless the attempt's frozen securityConfig requires SEB. Legacy and
 * mock/normal attempts are entirely unaffected.
 */
function assertSEB(
  sebToken: string | undefined,
  uid: string,
  requireSEB: boolean | undefined,
  assessmentId: string,
): void {
  if (requireSEB !== true) return;
  const secrets = sebSecrets(SEB_SIGNING_SECRET.value());
  if (secrets.length === 0) {
    // Fail closed. A missing secret must never read as "SEB satisfied" — and
    // neither must a value that is only commas and whitespace, which is why
    // this checks the PARSED list rather than the raw string.
    throw new HttpsError('failed-precondition', 'SEB_NOT_CONFIGURED');
  }
  if (!sebToken) {
    throw new HttpsError('permission-denied', 'SEB_REQUIRED: this exam must be taken in Safe Exam Browser.');
  }
  verifySebToken(sebToken, uid, secrets, assessmentId);
}

interface StartExamData {
  assessmentId: string;
  // Phase 3 — short-lived proof minted by /api/seb-verify on our own origin.
  sebToken?: string;
  // ── IGNORED as of master plan Phase 2 (D-07 / doctrine D6) ──────
  // These three used to define the exam's SHAPE and were taken from the
  // caller verbatim. They are still ACCEPTED so a cached older client keeps
  // working (and so a server rollback is clean), but nothing reads them —
  // sections, question order, shuffling and section order are all derived
  // from the assessment document now. Remove the fields once no client sends
  // them.
  sections?: Array<{
    id: string;
    name: string;
    questions: Array<{ questionId: string; marks: number; order: number }>;
  }>;
  shuffleQuestions?: boolean;
  sectionStartOrder?: 'sequential' | 'random' | 'student_choice';
  // Advisory, and documented as such: an honest-majority signal the client
  // reports about itself. Not evidence. SEB is the real device control.
  cameraDeclined?: boolean;
  deviceClass?: 'desktop' | 'mobile' | 'tablet';
  /** Phase 2 — the browser session claiming this attempt (INV-5a). */
  sessionId?: string;
  /** The baseline machine, stored once. See sanitiseFingerprint. */
  fingerprint?: DeviceFingerprintS;
}

// ══════════════════════════════════════════════════════════════════
// DEVICE FINGERPRINT — the baseline lives here, not on the client
// ══════════════════════════════════════════════════════════════════
//
// A browser session cannot move between machines, so a sitting that reports
// one machine at startExam and a different one on a later heartbeat was
// resumed somewhere else. That is a stronger signal than any single
// client-side report, because it is not an observation about behaviour a
// student could explain — it is two incompatible facts about one sitting.
//
// The BASELINE is written once, server-side, and never rewritten by a later
// call. That placement is the whole design: a client that compared against its
// own stored copy would be defeated by editing the copy, so the comparison has
// to happen somewhere the student cannot reach.
//
// What this does NOT do, stated plainly so nobody builds on a stronger claim:
// the values are client-reported, so a client that lies can report the
// baseline forever, and one that runs the entire exam inside a VM reports the
// VM consistently and drifts from nothing. It catches an HONEST client on
// changed hardware. SEB remains the only control that reaches virtualisation
// and remote desktop.

interface DeviceFingerprintS {
  gpu?: string;
  cores?: number;
  memory?: number;
  platform?: string;
}

/** Bound on each stored string — these land in an attempt document. */
const MAX_FINGERPRINT_FIELD = 120;

/**
 * Never store the caller's object as given. It is client-supplied, so it can
 * carry arbitrary keys and unbounded strings straight into a document with a
 * hard size ceiling. Only the four known fields survive, each clipped.
 */
function sanitiseFingerprint(raw: unknown): DeviceFingerprintS | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) =>
    typeof v === 'string' ? v.trim().slice(0, MAX_FINGERPRINT_FIELD) : '';
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const out: DeviceFingerprintS = {
    gpu: str(r.gpu),
    cores: num(r.cores),
    memory: num(r.memory),
    platform: str(r.platform),
  };
  // Nothing readable at all — a hardened browser, or a caller sending {}.
  // Storing an all-empty baseline would make every later report "drift from
  // nothing", so there is nothing worth recording.
  if (!out.gpu && !out.cores && !out.memory && !out.platform) return null;
  return out;
}

/**
 * Which fields disagree. Server twin of fingerprintDrift in
 * src/lib/deviceFingerprint.ts — KEEP IN SYNC.
 *
 * A field empty on either side is NOT drift. Browsers withhold these values
 * situationally — a privacy setting toggled mid-sitting, a WebGL context that
 * failed to create once — and "could not read it this time" is an absence of
 * evidence, not evidence of a different machine. Only two populated values
 * that disagree count.
 */
function fingerprintDriftS(
  baseline: DeviceFingerprintS | null | undefined,
  current: DeviceFingerprintS | null | undefined,
): string[] {
  if (!baseline || !current) return [];
  const drifted: string[] = [];
  for (const field of ['gpu', 'cores', 'memory', 'platform'] as const) {
    const a = baseline[field];
    const b = current[field];
    if (a === undefined || b === undefined) continue;
    if (a === '' || b === '' || a === 0 || b === 0) continue;
    if (a !== b) {
      drifted.push(`${field}: ${String(a).slice(0, 40)} → ${String(b).slice(0, 40)}`);
    }
  }
  return drifted;
}

// ── startExam ─────────────────────────────────────────────────────
// Server-authoritative attempt creation. Enforces the schedule window
// (startDate/endDate) and the attempt limit against the SERVER clock and
// the assessment doc (not client-supplied values), then writes the
// attempt with server-set timestamps. Idempotent: returns an existing
// in_progress/frozen attempt if one is present.
/**
 * Classify a student's existing attempts for one assessment.
 *
 * Extracted (audit 2026-07-28) so the cheap pre-check and the authoritative
 * in-transaction check cannot drift. They ask the same question at two
 * different moments; if their answers ever disagreed because someone edited
 * one and not the other, the bug would surface as a duplicate attempt under
 * load and be near-impossible to reproduce.
 */
function evaluateStudentAttempts(
  docs: FirebaseFirestore.QueryDocumentSnapshot[],
  effectiveMax: number,
): {
  live: FirebaseFirestore.QueryDocumentSnapshot | undefined;
  finished: number;
  limitReached: boolean;
} {
  const statusOf = (d: FirebaseFirestore.QueryDocumentSnapshot) =>
    (d.data() as { status?: string }).status;
  const live = docs.find(
    (d) => statusOf(d) === 'in_progress' || statusOf(d) === 'frozen',
  );
  const finished = docs.filter((d) => {
    const s = statusOf(d);
    return s === 'submitted' || s === 'auto_submitted' || s === 'terminated';
  }).length;
  return { live, finished, limitReached: finished >= effectiveMax };
}

// ══════════════════════════════════════════════════════════════════
// SESSION OWNERSHIP + INTEGRITY LOG  (master plan Phase 2)
//
// Both fields used to be written directly by the student's browser under the
// firestore.rules whitelist. Both are moved here for the same reason: a field
// the subject of a measurement can rewrite is not a measurement.
// ══════════════════════════════════════════════════════════════════

interface RegisterSessionData { attemptId: string; sessionId: string }

/**
 * Claim an attempt for one browser session. (INV-5a / INV-5b, D-08.)
 *
 * TAKEOVER IS DELIBERATE, AND SO IS THE TRANSACTION.
 *
 * The joining device wins, exactly as before — "first device wins" would
 * strand a student whose browser crashed behind a session they can no longer
 * produce, which is a far more common event than a cheater with two laptops.
 * What changes is that the swap is ATOMIC and the conflict is recorded
 * server-side, where a student cannot suppress it.
 *
 * The previous client-side implementation was a getDoc followed by an
 * updateDoc — two devices arriving together could both read "unclaimed" and
 * both believe they were first, and no conflict was recorded at all.
 */
export const registerSession = onCall<RegisterSessionData>(
  EXAM_HOT_PATH,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const studentId = request.auth.token.studentId as string | undefined;
    if ((request.auth.token.role as string | undefined) !== 'student' || !studentId) {
      throw new HttpsError('permission-denied', 'Only students may claim a sitting.');
    }
    const { attemptId, sessionId } = request.data || ({} as RegisterSessionData);
    if (!attemptId || !sessionId) {
      throw new HttpsError('invalid-argument', 'attemptId and sessionId are required.');
    }

    const db = getFirestore();
    const ref = db.collection('attempts').doc(attemptId);

    return db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) return { ok: true, conflict: false };
      const d = snap.data() as { studentId?: string; activeSessionId?: string | null };
      if (d.studentId !== studentId) {
        throw new HttpsError('permission-denied', 'Not your attempt.');
      }

      const existing = d.activeSessionId;
      const nowIso = new Date().toISOString();
      const conflict = !!existing && existing !== sessionId;

      txn.update(ref, {
        activeSessionId: sessionId,
        ...(conflict ? { sessionConflictAt: nowIso } : {}),
        updatedAt: nowIso,
      });

      return {
        ok: true,
        conflict,
        ...(conflict ? { existingSessionId: existing } : {}),
      };
    });
  },
);

// ══════════════════════════════════════════════════════════════════
// DEVICE CLASS — the server's own reading
// ══════════════════════════════════════════════════════════════════
//
// Server twin of src/lib/deviceClass.ts, and deliberately NOT a port of it.
// The client classifies from things only a running page can see —
// maxTouchPoints, matchMedia, screen geometry — and none of those reach a
// Cloud Function. What does reach it is the User-Agent header, which the
// page's own JavaScript did not author. That is the entire value here: it is
// a second, independent opinion, not a better one.
//
// It is weaker than the client's in the ordinary case (it cannot see an iPad
// reporting a Macintosh UA, because the header IS the Macintosh UA) and
// stronger in the one that matters (a student who edits the callable payload
// does not thereby edit the header their browser sent). The two are combined
// by taking the stricter answer, so each covers the other's blind spot.

type DeviceClassS = 'desktop' | 'mobile' | 'tablet';

const DEVICE_CLASSES_S: readonly string[] = ['desktop', 'mobile', 'tablet'];

/** Accept a client-supplied device class, or nothing. Never throws. */
function normaliseDeviceClass(v: unknown): DeviceClassS | null {
  return typeof v === 'string' && DEVICE_CLASSES_S.includes(v) ? (v as DeviceClassS) : null;
}

/**
 * Classify from the User-Agent header alone.
 *
 * Returns null when the header names nothing recognisable — absence of
 * evidence, which must not be read as evidence of a desktop. A null here
 * leaves the client's claim standing rather than overriding it, because a
 * header this function cannot parse is a browser it has never seen, not a
 * candidate doing something.
 */
function deviceClassFromUserAgent(ua: string): DeviceClassS | null {
  if (!ua) return null;
  // Tablet first: an Android tablet UA contains "Android" but not "Mobile",
  // and iPadOS <13 says "iPad" outright. Order matters because the mobile
  // patterns below would otherwise claim some of these.
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua)) return 'tablet';
  if (/Android/i.test(ua) && !/Mobile/i.test(ua)) return 'tablet';
  if (/Mobi|Android|iPhone|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return 'mobile';
  if (/Macintosh|Windows|X11|CrOS|Linux/i.test(ua)) return 'desktop';
  return null;
}

/**
 * Combine the two readings by taking the one that permits least.
 *
 * A desktop claim contradicted by a phone header becomes a phone; a phone
 * claim "contradicted" by a desktop header stays a phone. Both directions are
 * the same rule — the client can always make its own sitting stricter, and
 * can never make it looser.
 */
function strictestDeviceClass(
  claimed: DeviceClassS,
  observed: DeviceClassS | null,
): DeviceClassS {
  if (observed === null) return claimed;
  const rank: Record<DeviceClassS, number> = { desktop: 0, tablet: 1, mobile: 2 };
  return rank[observed] > rank[claimed] ? observed : claimed;
}

/** The device policy, in one place, so the gate and the freeze cannot drift. */
function deviceClassAllowed(
  cls: DeviceClassS,
  allowMobile: boolean,
  allowTablet: boolean,
): boolean {
  if (cls === 'mobile') return allowMobile;
  if (cls === 'tablet') return allowTablet;
  return true;
}

/** Counter field per violation type. Server twin of VIOLATION_COUNTER in
 *  src/lib/submissionService.ts — KEEP IN SYNC. */
const VIOLATION_COUNTER_S: Record<string, string> = {
  tab_switch: 'tabSwitches',
  focus_loss: 'focusLosses',
  fullscreen_exit: 'fullscreenExits',
  copy_attempt: 'copyAttempts',
  paste_attempt: 'pasteAttempts',
  right_click: 'rightClickAttempts',
  multi_person: 'multiPersonEvents',
  face_absent: 'faceAbsenceEvents',
  devtools_open: 'devtoolsEvents',
  reload_attempt: 'tabSwitches',
  keyboard_block: 'keyboardBlockEvents',
  extension_detected: 'extensionEvents',
  viewport_narrowed: 'viewportEvents',
  foreign_dom: 'foreignDomEvents',
  focus_state_mismatch: 'focusMismatchEvents',
  render_throttled: 'renderThrottleEvents',
  print_attempt: 'printAttempts',
};

/** Warning-type violations — the three that drive the termination threshold.
 *  Mirrors WARNING_VIOLATION_TYPES in ExamShell. */
const WARNING_VIOLATION_TYPES_S = new Set(['tab_switch', 'focus_loss', 'fullscreen_exit']);
const MAX_INTEGRITY_WARNINGS_S = 3;

/**
 * The warning tally, from the counters only this file can write.
 *
 * A `function` declaration rather than a const arrow because gradeAttempt sits
 * ~3000 lines ABOVE this point and calls it. Declarations hoist, so there is no
 * temporal-dead-zone question for a future reader to have to reason about.
 *
 * Counting is deliberately duplicated nowhere else: logViolation's reply, the
 * client's resume guard and gradeAttempt's finalisation gate all come through
 * here, so the three cannot drift into disagreeing about what a warning is.
 */
export function countIntegrityWarnings(
  log: { tabSwitches?: number; focusLosses?: number; fullscreenExits?: number } | null | undefined,
): number {
  if (!log) return 0;
  return (log.tabSwitches ?? 0) + (log.focusLosses ?? 0) + (log.fullscreenExits ?? 0);
}

/**
 * Ceiling on STORED violation events per attempt (N5, audit 2026-08-06).
 *
 * integrityLog.violations grew by arrayUnion with no bound. Each entry carries
 * a unique `timestamp`, so arrayUnion never de-duplicates — every call
 * appends. At roughly 550 bytes per entry (type, timestamp, up to 500
 * characters of detail, warningNumber) the array alone approaches Firestore's
 * 1 MiB DOCUMENT limit somewhere under two thousand events.
 *
 * The consequence is not a large document, it is a DEAD ATTEMPT. Once the doc
 * hits the limit EVERY subsequent write to it fails — answer autosave, section
 * transitions, grading. A student would lose their exam, and the attempt could
 * become impossible to finalise.
 *
 * It does not take an attacker. focus_loss fires on any window blur and
 * tab_switch on any visibility change, so a flaky machine or an OS throwing
 * notifications generates these continuously; a script generates them as fast
 * as the network allows. The 3-warning termination does not bound it either,
 * because it only counts WARNING types and logViolation accepts others.
 *
 * 500 is far past any honest sitting and far short of the limit. The COUNTERS
 * are deliberately left uncapped: they are increments, they cost no space, and
 * they are what the examiner's verdict reads. So an attempt that blows through
 * the ceiling still reports its true total — the aggregate stays truthful and
 * only the per-event detail stops accumulating.
 */
const MAX_VIOLATION_EVENTS_S = 500;

interface LogViolationData {
  attemptId: string;
  type: string;
  detail?: string;
  warningNumber?: number;
  /** Past the shell's event cap: keep counting, stop appending event objects. */
  skipEventDetail?: boolean;
  sessionId?: string;
  /** Where the student was. Validated against the attempt — see below. */
  context?: {
    questionId?: string;
    sectionId?: string;
    questionNumber?: number;
    sectionNumber?: number;
  };
}

/**
 * Validate the reported position AGAINST THIS ATTEMPT'S OWN PAPER.
 *
 * The context is client-supplied and its whole purpose is to be read by a
 * human deciding whether a student cheated. Storing it as given would let a
 * hostile client write arbitrary text into that record, or — more quietly, and
 * worse — attribute its violations to a question the student was never served,
 * making the timeline disagree with the answers beside it.
 *
 * So an id survives only if the attempt's own questionOrder contains it. An id
 * that does not is dropped rather than rejected: the violation itself is the
 * thing that must be recorded, and refusing the whole call over a bad position
 * would turn a garbled context into a missing detection.
 */
function sanitiseViolationContext(
  raw: unknown,
  attempt: { questionOrder?: Record<string, string[]>; sectionIds?: string[] },
): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  const order = attempt.questionOrder ?? {};
  const sectionIds = attempt.sectionIds ?? Object.keys(order);

  if (typeof r.sectionId === 'string' && sectionIds.includes(r.sectionId)) {
    out.sectionId = r.sectionId;
  }
  if (typeof r.questionId === 'string') {
    const served = Object.values(order).some((qs) => Array.isArray(qs) && qs.includes(r.questionId as string));
    if (served) out.questionId = r.questionId;
  }
  // Positions are display sugar for the id above, so they are only kept when
  // they are plausible small integers. A number is cheap to store and
  // impossible to cross-check, so the bound is the whole defence.
  const pos = (v: unknown) =>
    typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 10_000 ? v : undefined;
  const qn = pos(r.questionNumber);
  const sn = pos(r.sectionNumber);
  if (qn !== undefined) out.questionNumber = qn;
  if (sn !== undefined) out.sectionNumber = sn;

  return out;
}

/**
 * Record an integrity violation. (D-09, master plan Phase 2.)
 *
 * WHY THIS IS A CALLABLE NOW
 * `integrityLog` sat on the student rules whitelist. logViolation used
 * increment(), but nothing stopped a plain updateDoc resetting the whole
 * object to zeros — a student could erase their own violation record mid-exam,
 * including the counters the termination threshold reads.
 *
 * Moving the write here makes the log APPEND-ONLY and server-incremented. The
 * rules whitelist drops `integrityLog` in the same phase (deployed after the
 * frontend, so no client is left writing a field it can no longer write).
 *
 * WHAT THIS STILL DOES NOT CLOSE, deliberately: a client that never CALLS this
 * never logs anything. Browser-side proctoring cannot close that and pretending
 * otherwise adds code without adding security — SEB is the control. What
 * changes is that a violation, once reported, cannot be un-reported.
 *
 * `thresholdReached` is returned so the shell can act on a count it no longer
 * owns. Termination itself still runs through gradeAttempt.
 */
export const logViolation = onCall<LogViolationData>(
  EXAM_HOT_PATH,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const studentId = request.auth.token.studentId as string | undefined;
    if ((request.auth.token.role as string | undefined) !== 'student' || !studentId) {
      throw new HttpsError('permission-denied', 'Only students report violations here.');
    }
    const { attemptId, type, detail, warningNumber, skipEventDetail, sessionId } =
      request.data || ({} as LogViolationData);
    if (!attemptId || !type) {
      throw new HttpsError('invalid-argument', 'attemptId and type are required.');
    }
    const counter = VIOLATION_COUNTER_S[type];
    if (!counter) {
      throw new HttpsError('invalid-argument', `Unknown violation type: ${type}`);
    }

    const db = getFirestore();
    const ref = db.collection('attempts').doc(attemptId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Attempt not found.');
    const att = snap.data() as {
      studentId?: string;
      status?: string;
      activeSessionId?: string | null;
      integrityLog?: Record<string, unknown>;
      // Read so the reported position can be checked against the paper this
      // student was actually served — see sanitiseViolationContext.
      questionOrder?: Record<string, string[]>;
      sectionIds?: string[];
      // The frozen contract, read only for its tier: practice never reports a
      // threshold as reached. See the return value below.
      securityConfig?: { tier?: string };
    };
    if (att.studentId !== studentId) {
      throw new HttpsError('permission-denied', 'Not your attempt.');
    }
    // A finished attempt takes no further events; a frozen one still does,
    // because a freeze is a paused sitting and events during it are exactly
    // what a reviewer wants.
    if (att.status !== 'in_progress' && att.status !== 'frozen') {
      return { ok: true, ignored: true };
    }
    assertSession(att, sessionId, 'logViolation');

    const nowIso = new Date().toISOString();
    const updates: Record<string, unknown> = {
      [`integrityLog.${counter}`]: FieldValue.increment(1),
      'integrityLog.totalViolations': FieldValue.increment(1),
      updatedAt: nowIso,
    };
    // Counters always increment; only the detail array is bounded. Read from
    // the pre-write snapshot already in hand, so this costs no extra read.
    const storedEvents = Array.isArray(
      (att.integrityLog as { violations?: unknown[] } | undefined)?.violations,
    )
      ? ((att.integrityLog as { violations?: unknown[] }).violations as unknown[]).length
      : 0;
    if (!skipEventDetail && storedEvents < MAX_VIOLATION_EVENTS_S) {
      updates['integrityLog.violations'] = FieldValue.arrayUnion({
        type,
        timestamp: nowIso,
        ...(detail ? { detail: String(detail).slice(0, 500) } : {}),
        ...(typeof warningNumber === 'number' ? { warningNumber } : {}),
        // Position, validated against this attempt's own paper. Spread last so
        // a caller cannot smuggle `type` or `timestamp` in through it.
        ...sanitiseViolationContext(request.data?.context, att),
      });
    }
    await ref.update(updates);

    // Recompute the warning count from the pre-write snapshot plus this event.
    const log = (att.integrityLog ?? {}) as Record<string, number>;
    const warnings =
      (log.tabSwitches ?? 0) + (log.focusLosses ?? 0) + (log.fullscreenExits ?? 0)
      + (WARNING_VIOLATION_TYPES_S.has(type) ? 1 : 0);

    return {
      ok: true,
      warnings,
      // Practice records warnings and terminates on none of them, so the
      // server never tells a mock sitting that it has reached the threshold.
      // The shell checks its own resolved profile too — this is the half that
      // matters, because the shell treats a `thresholdReached: true` from here
      // as authoritative over its own count and would terminate on it.
      thresholdReached:
        att.securityConfig?.tier !== 'mock' && warnings >= MAX_INTEGRITY_WARNINGS_S,
    };
  },
);

interface GetExamVerdictData {
  attemptId: string;
  sessionId?: string;
  sebToken?: string;
}

/**
 * Where does this student stand right now?  (Master plan Phase 3c.)
 *
 * The one endpoint every caller asks instead of deciding for itself — doctrine
 * D1 (the server owns every clock) and D4 (display is local, decisions are
 * remote). The shell's countdown becomes a picture of a decision already made
 * here, rather than a second implementation that drifts from this one.
 *
 * ADDITIVE. Nothing calls it yet; Phase 3d points the shell at it. It ships
 * now, separately, so it can be deployed and watched before anything depends
 * on it — the same reason 3a shipped inert.
 *
 * WHY IT CARRIES EXAM_HOT_PATH FROM BIRTH (D-19)
 * Once the shell asks for a verdict at every countdown zero, a cohort that
 * started together will hit section end together and arrive here in one burst
 * — the same synchronised shape that makes gradeAttempt a scale risk. A
 * capacity setting retrofitted after the first bad exam day is a capacity
 * setting learned the expensive way. The client-side jitter that spreads the
 * burst belongs to 3d and must land with it.
 *
 * DEPLOY NOTE: this is a NEW callable, and on this project the CLI has twice
 * created one without the Cloud Run `allUsers` / `roles/run.invoker` binding —
 * which fails silently, rejecting every call before any code runs. Verify with
 * `gcloud run services get-iam-policy getexamverdict --region=us-central1`
 * before believing a quiet log.
 */
// ══════════════════════════════════════════════════════════════════
// FREEZE AS A LEDGER  (master plan Phase 4, step 1)
//
// Freeze used to be a direct client write of four loose fields, and the time
// it took was never given back — computeAttemptLocks ignored
// totalFrozenSeconds entirely (D-03). The display credited the pause and the
// write gate did not, so a student paused for ten minutes saw ten extra
// minutes and had none. Worse, unfreezeAttempt computed `current + additional`
// from a total supplied BY THE CLIENT, so stale roster state or two
// invigilators acting at once made accumulated credit go DOWN (INV-4a).
//
// The ledger replaces guesswork with a record. Each freeze is an entry with a
// MEASURED elapsedMs and a DECIDED grantedMs, and creditedFreezeMs is their
// sum — one number, consumed uniformly by every deadline.
//
// STEP 1 IS ADDITIVE ON PURPOSE. These callables write the ledger AND keep
// totalFrozenSeconds in step, so nothing that reads the old field breaks. No
// deadline moves yet: examTimingCore's CONSUME_LEGACY_FROZEN_SECONDS is still
// false and no attempt carries creditedFreezeMs until an unfreeze runs here.
// Credit only starts flowing when that constant is flipped, which is the LAST
// step of this phase — after the invigilator can actually make the decision
// and the student is told about it. A deadline that moves for a reason nobody
// authorised is a broken promise even when it moves in the student's favour.
// ══════════════════════════════════════════════════════════════════

interface FreezeAttemptData {
  attemptId: string;
  reason?: string;
}

type FreezeLedgerEntry = {
  id: string;
  startedAt: string;
  endedAt?: string | null;
  reason: 'invigilator' | 'extension_check' | 'system';
  frozenBy?: string | null;
  /** Measured wall-clock duration of the freeze. */
  elapsedMs?: number | null;
  /** Decided credit, 0..elapsedMs. The only figure deadlines consume. */
  grantedMs?: number | null;
  decidedBy?: string | null;
  decidedAt?: string | null;
  note?: string | null;
  /**
   * This pause was released by the STUDENT, not by a human decision (C-02).
   *
   * The one field that distinguishes a grant nobody chose from a grant an
   * invigilator chose, and the reason the automatic ceiling can be a per-
   * SITTING budget rather than a per-pause one: summing grantedMs over the
   * rows carrying this flag says how much time the auto-resume path has
   * already handed back, which is the only number that makes the loop
   * "freeze, wait, resume, repeat" terminate.
   *
   * Recorded on the row rather than derived from `decidedBy == null`, because
   * the synthetic pre-ledger migration row (preLedgerCreditEntry) also carries
   * no decider and is not an automatic release of anything.
   */
  autoGranted?: boolean | null;
  /**
   * The freezer's ROLE at the instant they froze (§3, §8).
   *
   * Authority attaches per freeze, and unfreezing requires the freezer or
   * someone above them. Deriving that later from a profile lookup asks a
   * question about the past using present data: a faculty member promoted to
   * institute admin would appear to have frozen as an admin, and one who has
   * left would have no role at all. `frozenBy` alone cannot answer "who is
   * above this decision".
   *
   * Recorded now, while nothing depends on it, so 4.6 has a fact rather than
   * an inference.
   */
  frozenByRole?: 'webOwner' | 'institute' | 'faculty' | 'system' | null;
  /**
   * What each clock had left at the instant of the pause (§2).
   *
   * Two things need this and neither has a source today. The student is owed
   * "they see where they stood, frozen at that instant" — a screen that
   * currently has nothing to render. And the resume modal needs the caps for
   * A4's per-clock deductions.
   *
   * Stored rather than recomputed because both would otherwise derive it
   * independently, from different code, at different moments — and would
   * drift. It is also the only honest source: after the pause, "what the
   * question had left" is a fact about the past, not something the present
   * state can be asked.
   *
   * null for a clock that was not running (no question in standard delivery,
   * no section between sections, no cap where none is configured). Distinct
   * from 0, which means the clock had run out.
   */
  clocksAtFreeze?: {
    questionMs: number | null;
    sectionMs: number | null;
    overallMs: number | null;
  } | null;
};

/** Staff who may pause a sitting: webOwner, or the attempt's own tenant. */
function assertInvigilator(
  request: { auth?: { token: Record<string, unknown>; uid: string } | null },
  attempt: { instituteId?: string },
): { uid: string; role: string } {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
  const role = request.auth.token.role as string | undefined;
  const instituteId = request.auth.token.instituteId as string | undefined;
  // 'webOwner', camelCase — the claim firestore.rules documents at the top of
  // the file and AuthContext issues. Writing 'web_owner' here silently
  // rejected every Web Owner, so freezing appeared to do nothing at all.
  const ok = role === 'webOwner'
    || ((role === 'institute' || role === 'faculty') && attempt.instituteId === instituteId);
  if (!ok) throw new HttpsError('permission-denied', 'Not permitted to invigilate this attempt.');
  return { uid: request.auth.uid, role: role as string };
}

/**
 * Who outranks whom (§3, §8).
 *
 * Deliberately a small ladder rather than a permission matrix: the rule is
 * "the freezer, or anyone above them, never a peer", and a ladder is the only
 * shape that says that in one comparison.
 */
const INVIGILATOR_RANK: Record<string, number> = {
  faculty: 1,
  institute: 2,
  webOwner: 3,
};

/**
 * May this actor clear THIS freeze? (§3, §8.)
 *
 * Authority attaches to the individual pause, not to the attempt. Faculty
 * froze the first, a web owner the second: the second needs a web owner.
 *
 *   Frozen by         Cleared by
 *   faculty           that faculty · their institute admin · web owner
 *   institute admin   that institute admin · web owner
 *   web owner         that web owner only
 *   system / extension any invigilator
 *
 * NEVER A PEER. Two faculty at the same institute cannot undo each other's
 * decisions — the whole reason authority is recorded is that a pause is a
 * judgement about a student, and one colleague overruling another silently is
 * the thing this prevents.
 *
 * Read from the STORED frozenByRole, never from a profile lookup, and the two
 * edge cases in §10 are why:
 *
 *   "The freezer leaves or is deleted" — a lookup would return nothing and
 *   strand the student. The stored rank still says who is above them.
 *   "Freezer promoted" — they are the freezer AND above, and the uid match
 *   below authorises them without needing to re-derive anything.
 *
 * LEGACY ENTRIES (no frozenByRole) fall back to the old flat rule: any
 * invigilator on the tenant. Inventing a restriction retroactively could leave
 * a student frozen with nobody authorised to release them, and a student
 * stranded by our own data migration is a worse outcome than a peer clearing a
 * pause from before the rule existed. Drains as old freezes resolve.
 */
function assertCanUnfreeze(
  actor: { uid: string; role: string },
  entry: FreezeLedgerEntry | undefined,
): void {
  if (!entry) return;                                   // nothing to judge

  // §3: a system freeze has no human owner, so any invigilator may clear it.
  if (entry.reason === 'extension_check' || entry.reason === 'system') return;

  const frozenByRole = entry.frozenByRole;
  if (!frozenByRole) return;                            // legacy — see above

  // The freezer themselves, whatever they have since become.
  if (entry.frozenBy && entry.frozenBy === actor.uid) return;

  const mine = INVIGILATOR_RANK[actor.role] ?? 0;
  const theirs = INVIGILATOR_RANK[frozenByRole] ?? 0;
  // STRICTLY above. Equal rank is a peer, and a peer is not authority.
  if (mine > theirs) return;

  const who = frozenByRole === 'faculty' ? 'a faculty member'
            : frozenByRole === 'institute' ? 'an institute admin'
            : 'the web owner';
  throw new HttpsError('permission-denied',
    `FREEZE_AUTHORITY: this session was paused by ${who}. ` +
    `It can be resumed by them, or by someone above them.`);
}

// ══════════════════════════════════════════════════════════════════
// ONE FREEZE MECHANISM  (F6 / F7 — 2026-08-03)
//
// There were two, with different shapes, and every consumer had to know both:
//
//   freezeAttempt         freezes[] entry + frozenAt   status stays in_progress
//   reportExtensionCheck  freezeState + status:'frozen'  no ledger, no frozenAt
//
// Only the first paused anything. effectiveNowMs() pins the resolver's clock
// off an OPEN LEDGER ENTRY, and ExamShell derives isFrozen from frozenAt, so an
// extension freeze stopped neither the server's clocks nor the client's: a
// student locked out by an antivirus false positive watched their section drain
// behind the overlay, was refused answer writes by firestore.rules
// (status != 'in_progress'), and was resolved into the NEXT section without
// ever being released. That is D-32 and D-36 again, in the mechanism nobody
// converted.
//
// It also left three other rules half-applied: the sweep's window-close branch
// queries status:'frozen' and therefore never saw an invigilator freeze (F9),
// and verifyAndResume wrote totalFrozenSeconds with FieldValue.increment while
// unfreezeAttempt SET the same field from the ledger, so the two disagreed
// about what the field even meant and credit went DOWN (F4).
//
// Both paths now open and close the same ledger entry through these two
// helpers. The difference between an invigilator pause and a system pause is
// where it belongs — in `reason`, which assertCanUnfreeze already keys off —
// and not in the shape of the state.
// ══════════════════════════════════════════════════════════════════

/**
 * Pre-ledger credit, carried across the moment the ledger begins (F3).
 *
 * creditForAnchor switches branch the instant `freezes` is non-empty: with no
 * ledger it returns the flat `totalFrozenSeconds`, with one it sums per-freeze
 * grantedMs. So on an attempt carrying legacy credit, pressing Freeze DELETED
 * that credit — the open entry has no grantedMs yet, so the sum is zero.
 * Measured at eight minutes lost on the button press.
 *
 * Migrating it as a synthetic CLOSED row keeps the arithmetic continuous.
 *
 * THE ANCHOR IS A RECONSTRUCTION, and worth being honest about. A pre-ledger
 * total records no instants, so which clocks it was meant to credit cannot be
 * recovered. Anchoring it at the OPEN SECTION's start (attempt start when
 * between sections) reproduces exactly what the student's deadlines said one
 * moment earlier for the overall and section clocks, and declines to credit a
 * question served later — which is what D-28 would have decided had the data
 * existed. It is the closest truthful reading available, not a measurement.
 *
 * Returns null when there is nothing to migrate, which is every attempt
 * created after the ledger shipped. Drains as legacy attempts finish.
 */
function preLedgerCreditEntry(
  att: { totalFrozenSeconds?: number; freezes?: FreezeLedgerEntry[]; startedAt?: string;
         sectionTimings?: Record<string, { startedAt?: string; submittedAt?: string }> },
  nowIso: string,
): FreezeLedgerEntry | null {
  if (Array.isArray(att.freezes) && att.freezes.length > 0) return null;
  const legacy = att.totalFrozenSeconds;
  if (typeof legacy !== 'number' || !Number.isFinite(legacy) || legacy <= 0) return null;

  const openId = openSectionId(toCoreAttempt(att as unknown as Record<string, unknown>));
  const anchor = (openId ? att.sectionTimings?.[openId]?.startedAt : undefined)
    || att.startedAt
    || nowIso;

  return {
    id: `fz_legacy_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    startedAt: anchor,
    endedAt: anchor,
    reason: 'system',
    frozenBy: null,
    frozenByRole: 'system',
    elapsedMs: Math.round(legacy * 1000),
    grantedMs: Math.round(legacy * 1000),
    decidedBy: null,
    decidedAt: nowIso,
    note: 'pre-ledger credit carried forward (totalFrozenSeconds)',
    clocksAtFreeze: null,
  };
}

/**
 * Snapshot what each clock had left at this instant (§2).
 *
 * EXCLUDES GRACE (F11). The stored deadline includes sectionGraceSeconds, so
 * `deadline - now` was 30 s (default) larger than the number on the student's
 * own screen — SectionTimer renders `timeLimit - elapsed` with no grace. The
 * resume modal showed a "time remaining at the pause" the student had never
 * seen, and derived its per-clock penalty caps from it, so a deduction could
 * eat into the latency buffer rather than into the student's time.
 *
 * The server-side clamp in unfreezeAttempt still measures against the real
 * post-credit deadline, grace included. This only changes what is DESCRIBED,
 * so the description matches the thing it describes.
 *
 * null means the clock was not running — no question in standard delivery, no
 * section between sections, no cap configured. Distinct from 0, which means it
 * had run out, and A10 turns on the difference.
 */
function snapshotClocks(
  core: CoreAttempt,
  coreAsmt: CoreAssessment,
  nowMs: number,
): FreezeLedgerEntry['clocksAtFreeze'] {
  const d = computeDeadlines(core, coreAsmt);
  const graceMs = (x: number | null, gs: number | undefined, dflt: number) =>
    x === null ? null : Math.max(0, x - nowMs - (gs ?? dflt) * 1000);
  return {
    questionMs: graceMs(d.questionEndsAt, coreAsmt.questionGraceSeconds, DEFAULT_QUESTION_GRACE_SECONDS),
    sectionMs: graceMs(d.sectionEndsAt, coreAsmt.sectionGraceSeconds, DEFAULT_SECTION_GRACE_SECONDS),
    overallMs: graceMs(d.overallEndsAt, coreAsmt.overallGraceSeconds, DEFAULT_OVERALL_GRACE_SECONDS),
  };
}

/**
 * Everything a pause writes, for either mechanism.
 *
 * Fails soft on the snapshot: a missing or unreadable assessment yields nulls,
 * never a thrown freeze. An invigilator must always be able to stop a sitting,
 * and a system check must always be able to, and a snapshot is worth less than
 * the pause itself.
 */
function openFreezeUpdates(
  att: Record<string, unknown>,
  assessmentRaw: Record<string, unknown> | null,
  opts: {
    reason: FreezeLedgerEntry['reason'];
    frozenBy: string | null;
    frozenByRole: FreezeLedgerEntry['frozenByRole'];
    nowIso: string;
  },
): { updates: Record<string, unknown>; entry: FreezeLedgerEntry } {
  let clocksAtFreeze: FreezeLedgerEntry['clocksAtFreeze'] = null;
  try {
    if (assessmentRaw) {
      // A-06: snapshot against the contract this attempt is sitting under.
      clocksAtFreeze = snapshotClocks(
        toCoreAttempt(att),
        toCoreAssessment(examContractFor(att, assessmentRaw) ?? assessmentRaw),
        Date.parse(opts.nowIso));
    }
  } catch { clocksAtFreeze = null; }

  const entry: FreezeLedgerEntry = {
    id: `fz_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    startedAt: opts.nowIso,
    reason: opts.reason,
    frozenBy: opts.frozenBy,
    frozenByRole: opts.frozenByRole,
    clocksAtFreeze,
  };

  // F3: carry pre-ledger credit across the branch switch, in the same write.
  const carried = preLedgerCreditEntry(
    att as Parameters<typeof preLedgerCreditEntry>[0], opts.nowIso);
  const ledger = carried ? [carried, entry] : [entry];

  return {
    entry,
    updates: {
      freezes: FieldValue.arrayUnion(...ledger),
      ...(carried ? { creditedFreezeMs: carried.grantedMs ?? 0 } : {}),
      // ── A pause is a state the student cannot write from (F5) ────
      //
      // freezeAttempt left `status` at 'in_progress', and every guard on the
      // student's transition paths tests exactly that — so a paused student
      // could still advance questions, start and submit sections, and
      // FINALISE their own attempt, with the clocks stopped by
      // effectiveNowMs. A pause that stops the clock but not the student is
      // an unbounded time grant to anyone willing to call the callable
      // directly.
      //
      // 'frozen' is the state the extension path already used and every
      // reader already understands: firestore.rules require 'in_progress' on
      // both sides of a student write, getStudentAssessments counts it as
      // live, examHeartbeat ignores it, and the sweep's window-close branch
      // queries it — which is also what makes A10 reach an invigilator freeze
      // for the first time (F9).
      //
      // saveAnswerNoAdvance deliberately still accepts it. The client learns
      // of a freeze through its subscription, so the in-flight flush lands
      // AFTER the pause; refusing it would fail the one call that exists to
      // save the answer in front of a student being paused.
      status: 'frozen',
      // Legacy fields kept in step for one release — SectionTimer pauses on
      // frozenAt, and the roster reads frozenBy/frozenReason. The extension
      // path now writes them too, which is what makes the CLIENT pause on a
      // system freeze (F6).
      frozenAt: opts.nowIso,
      frozenBy: opts.frozenBy,
      updatedAt: opts.nowIso,
    },
  };
}

/**
 * Close the open entry, decide credit, and recompute everything that depends
 * on it. The single implementation of "the pause is over".
 *
 * RECOMPUTING IS NOT OPTIONAL (doctrine D5, and F7). verifyAndResume used to
 * write status and freezeState and nothing else, so a released student carried
 * a pre-freeze answersLockedAfter and pre-freeze freezeCredits. The credit
 * surfaced later, at whatever section boundary happened to run
 * computeAttemptLocks next, as the flat legacy total applied to whichever clock
 * was running then. Both halves of that are fixed by doing the work here.
 */
function closeFreezeUpdates(
  att: Record<string, unknown>,
  assessmentRaw: Record<string, unknown> | null,
  opts: {
    grantedMs: number;
    decidedBy: string | null;
    note?: string | null;
    nowIso: string;
    penalties?: { questionMs?: number; sectionMs?: number; overallMs?: number };
    decidedByRole?: string;
    clearedBy?: 'invigilator' | 'auto' | 'sweep';
    /** C-02: mark the row as credit granted without a human deciding it. */
    autoGranted?: boolean;
  },
): {
  updates: Record<string, unknown>;
  elapsedMs: number; grantedMs: number; creditedFreezeMs: number;
} {
  const d = att as {
    freezes?: FreezeLedgerEntry[]; frozenAt?: string | null;
    freezeState?: { frozen?: boolean; since?: string } | null;
    startedAt?: string; penalties?: CorePenalty[];
    sectionTimings?: Record<string, { startedAt?: string; submittedAt?: string }>;
  };
  const nowMs = Date.parse(opts.nowIso);

  const ledger = [...(d.freezes ?? [])];
  const idx = ledger.findIndex((f) => !f.endedAt);
  // Three shapes, because an attempt already paused when this deploys can be
  // in any of them: a ledger entry (both paths, from now on), `frozenAt` (an
  // invigilator freeze from before the ledger), or `freezeState.since` (an
  // extension freeze from before this change — the only field that path ever
  // wrote). Missing all three would measure a zero-length pause and grant
  // nothing, which is the in-flight student paying for our migration.
  const startedAtIso = idx >= 0
    ? ledger[idx].startedAt
    : (d.frozenAt || d.freezeState?.since || null);
  const startMs = startedAtIso ? Date.parse(startedAtIso) : NaN;
  const elapsedMs = Number.isFinite(startMs) ? Math.max(0, nowMs - startMs) : 0;
  // Cannot grant more than actually elapsed (INV-4c).
  const granted = Math.min(Math.max(0, Math.round(opts.grantedMs)), elapsedMs);

  const closed: FreezeLedgerEntry = {
    ...(idx >= 0 ? ledger[idx] : {
      id: `fz_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      startedAt: startedAtIso ?? opts.nowIso,
      reason: 'invigilator' as const,
    }),
    endedAt: opts.nowIso,
    elapsedMs,
    grantedMs: granted,
    decidedBy: opts.decidedBy,
    decidedAt: opts.nowIso,
    ...(opts.note ? { note: String(opts.note).slice(0, 500) } : {}),
    ...(opts.autoGranted ? { autoGranted: true } : {}),
  };
  if (idx >= 0) ledger[idx] = closed; else ledger.push(closed);

  // Derived from the ledger, never incremented from a caller-supplied total.
  // This is what makes INV-4a hold by construction — and now holds for BOTH
  // release paths, where verifyAndResume's FieldValue.increment did not (F4).
  const creditedFreezeMs = ledger.reduce(
    (sum, f) => sum + Math.max(0, f.grantedMs ?? 0), 0);

  const creditedAttempt = {
    ...toCoreAttempt(att),
    freezes: ledger,
    creditedFreezeMs,
  } as CoreAttempt;

  // A-06: every deadline this release recomputes is the attempt's own.
  const contractRaw = assessmentRaw ? (examContractFor(att, assessmentRaw) ?? assessmentRaw) : null;
  const coreAsmt = contractRaw ? toCoreAssessment(contractRaw) : ({ sections: [] } as CoreAssessment);

  // Penalties, capped against the POST-CREDIT clock (A4).
  const dl = computeDeadlines(creditedAttempt, coreAsmt);
  const remaining = (endsAt: number | null): number =>
    endsAt === null ? 0 : Math.max(0, endsAt - nowMs);
  const wanted = opts.penalties ?? {};
  const clamp = (asked: unknown, cap: number): number => {
    const n = typeof asked === 'number' && Number.isFinite(asked) ? asked : 0;
    return Math.max(0, Math.min(Math.round(n), cap));
  };
  const penaltyRows: CorePenalty[] = [];
  const addPenalty = (clock: PenaltyClockS, amountMs: number) => {
    if (amountMs <= 0) return;
    penaltyRows.push({
      id: `pen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      freezeId: closed.id,
      clock,
      amountMs,
      decidedAt: opts.nowIso,
      decidedBy: opts.decidedBy ?? undefined,
    });
  };
  // ── The caps are CUMULATIVE, innermost first (A-04) ─────────────
  //
  // Each cap used to be measured against its own clock alone:
  //
  //   question -> remaining(question)
  //   section  -> remaining(section)
  //   overall  -> remaining(overall)
  //
  // Correct in isolation, and wrong together, because PENALTY_REACHES routes a
  // deduction OUTWARD (examTimingCore:204): time taken from the question is
  // also gone from the section and from the total. So the overall clock
  // absorbed sectionPenalty + overallPenalty while only the second had ever
  // been capped against it.
  //
  // Measured: a 60m exam with a 30m section, frozen at +5:00 and released at
  // +8:00 with 3m granted and a large deduction asked on both clocks. Section
  // capped at 25.5m, overall capped at 55.5m, both individually right — and
  // the overall clock then absorbed 81m against 63.5m of runway, landing
  // overallLockedAfter at t0 − 17:30. Seventeen minutes before the exam began.
  // The student was instantly and irrecoverably out of time.
  //
  // A4 promises "no arithmetic that can go negative"; this is that arithmetic
  // going negative through the door A5 left open. Each cap now subtracts what
  // the inner clocks have already taken from it, so the TOTAL any clock
  // absorbs is at most what that clock had left.
  //
  // NO FLOOR IS APPLIED TO THE RESULTING DEADLINE, deliberately. With the caps
  // right, the worst case is a deadline landing exactly at `now` — "you have
  // no time left", which is a legitimate thing for an invigilator to decide.
  // Flooring on top would mask a deadline that had gone into the past for some
  // OTHER reason, and hiding that is how a clock defect survives a release.
  const qPenalty = clamp(wanted.questionMs, remaining(dl.questionEndsAt));
  const sPenalty = clamp(wanted.sectionMs, remaining(dl.sectionEndsAt) - qPenalty);
  const oPenalty = clamp(wanted.overallMs, remaining(dl.overallEndsAt) - qPenalty - sPenalty);
  addPenalty('question', qPenalty);
  addPenalty('section', sPenalty);
  addPenalty('overall', oPenalty);

  const penalisedAttempt = {
    ...creditedAttempt,
    penalties: [...(d.penalties ?? []), ...penaltyRows],
  } as CoreAttempt;

  const openId = openSectionId(penalisedAttempt);
  const openSectionIso = openId ? d.sectionTimings?.[openId]?.startedAt : undefined;
  const openSectionLimit = openId
    ? (assessmentRaw?.sections as Array<{ id: string; timeLimit?: number }> | undefined)
        ?.find((s) => s.id === openId)?.timeLimit
    : undefined;

  const updates: Record<string, unknown> = {
    freezes: ledger,
    creditedFreezeMs,
    penalties: penalisedAttempt.penalties,
    // The exit from the state openFreezeUpdates put them in. Paired here so
    // there is exactly one way in and one way out.
    status: 'in_progress',
    // Cleared on both release paths. verifyAndResume used to leave a stale
    // `{frozen: true}` behind on the invigilator path and vice versa.
    freezeState: { frozen: false, clearedBy: opts.clearedBy ?? 'invigilator', since: opts.nowIso },
    resumeRequiresVerification: false,
    // Legacy mirror, kept in step for one release. GRANTED, not elapsed.
    totalFrozenSeconds: Math.round(creditedFreezeMs / 1000),
    frozenAt: FieldValue.delete(),
    frozenBy: FieldValue.delete(),
    frozenReason: FieldValue.delete(),
    // The heartbeat clock restarts at the release. examHeartbeat ignores beats
    // on a paused attempt, so without this the first beat after a release
    // measures the whole pause and records it as a gap — turning every freeze
    // an invigilator grants into a tamper signal against the student. Both
    // release paths run through here, so neither can produce that.
    lastHeartbeatAt: opts.nowIso,
    updatedAt: opts.nowIso,
  };
  applyLockUpdates(updates, computeAttemptLocks(
    d.startedAt,
    openSectionIso,
    openSectionLimit,
    (assessmentRaw ?? {}) as Parameters<typeof computeAttemptLocks>[3],
    penalisedAttempt,
  ));
  applyCreditUpdates(updates, penalisedAttempt);

  return { updates, elapsedMs, grantedMs: granted, creditedFreezeMs };
}

type PenaltyClockS = 'question' | 'section' | 'overall';

/**
 * Pause a sitting. (Phase 4.)
 *
 * Opens a ledger entry. It is CLOSED by unfreezeAttempt, which is where the
 * credit decision happens — a freeze on its own grants nothing, because
 * nobody has decided anything yet.
 */
// ══════════════════════════════════════════════════════════════════
// PHASE 4.4 — PROVISIONAL GRADING  (A9)
//
// An invigilator needs to see where a paused student had got to — to decide
// about the pause, to answer a query, to include them in an export — without
// ending their sitting.
//
// STORED OFF THE ATTEMPT, AND THAT IS THE WHOLE DESIGN.
//
// The obvious implementation writes `scores` onto the attempt. A9 rules it
// out in as many words: "a stale score sitting on a live attempt is exactly
// the quiet wrongness this whole project has been about." Two things go wrong
// if you do it. The student reads their own attempt, so a score there is a
// score they can see — and A9 says a frozen student must not see a result
// that is not final. And the moment they answer one more question the stored
// score is a lie that nothing forces anyone to notice.
//
// A sibling document in `provisionalGrades` fixes both by construction. The
// attempt stays unscored and live; students have no read access in the rules;
// and EVERY RELEASE deletes the row, so the grade cannot outlive the pause that
// justified it.
//
// "Every release" is written that way because it was not true (C-03). This note
// used to name unfreezeAttempt alone, and unfreezeAttempt alone did it —
// verifyAndResume, the other release, added for the other freeze, did not. A
// student who cleared their own extension pause left a stored mark behind on an
// attempt they went on answering, stamped with a freezeId that was no longer
// open. Invalidation is a cleanup step somebody has to remember, and being one
// function short of remembering it everywhere is what "nowhere to go stale"
// actually costs.
//
// NOT a submission. Status is untouched, submittedAt is untouched, no attempt
// is consumed (A9: unfreezing does not consume another — it is the same
// sitting continuing).
// ══════════════════════════════════════════════════════════════════

interface GradeProvisionalData {
  attemptId: string;
}

export const gradeProvisional = onCall<GradeProvisionalData>(
  CALLABLE_BASE,
  async (request) => {
    const { attemptId } = request.data || ({} as GradeProvisionalData);
    if (!attemptId) throw new HttpsError('invalid-argument', 'attemptId is required.');

    const db = getFirestore();
    const attemptSnap = await db.collection('attempts').doc(attemptId).get();
    if (!attemptSnap.exists) throw new HttpsError('not-found', 'Attempt not found.');
    const attempt = attemptSnap.data() as {
      instituteId?: string; studentId?: string; assessmentId: string;
      status?: string; answers?: Record<string, AttemptAnswerDoc>;
      gradingConfig?: AssessmentGradingConfigS;
      freezes?: FreezeLedgerEntry[];
    };
    const actor = assertInvigilator(request, attempt);

    // Only while genuinely paused. A running attempt has no need of this, and
    // a terminal one already has a real grade that this must never shadow.
    const open = (attempt.freezes ?? []).find((f) => !f.endedAt);
    if (!open) {
      throw new HttpsError('failed-precondition',
        'NOT_FROZEN: provisional grading applies only to a paused attempt.');
    }

    const assessmentSnap = await db.collection('assessments').doc(attempt.assessmentId).get();
    if (!assessmentSnap.exists) throw new HttpsError('not-found', 'Assessment not found.');
    // A-05: a provisional mark is still a mark; grade the paper they sat.
    const assessment = examContractFor(
      attempt as unknown as Record<string, unknown>,
      assessmentSnap.data() as Record<string, unknown>,
    ) as GradingAssessmentDoc;
    const sections = normalizeSections(assessment);
    const qIds = Array.from(new Set(
      sections.flatMap((sec) => sec.questions.map((q) => q.questionId)),
    ));
    const { questionMap, answerMap } = await loadQuestionAndAnswerMaps(db, qIds);

    const { scores, gradedAnswers } = scoreAttemptAnswers({
      sections,
      questionMap,
      answerMap,
      codeVerdicts: await loadCodeVerdicts(db, attemptId, questionMap),
      // A provisional grade previews the real one, so it must be computed the
      // same way — including any marking already done on an earlier sitting.
      manualMarks: await loadManualMarks(db, attemptId, questionMap),
      answers: attempt.answers,
      passingScore: assessment.passingScore,
      // NEVER to the student on this path, whatever the review audience says.
      // This document is staff-only and the student cannot read it; passing
      // true would put answer keys in a row that exists precisely because the
      // sitting is not over.
      exposeKeysToStudent: false,
      // The policy frozen on the attempt at start, exactly as gradeAttempt
      // uses — a provisional mark must be computed the same way as the real
      // one or it is not a preview of anything.
      gradingConfig: attempt.gradingConfig ?? assessment.gradingConfig,
    });

    const nowIso = new Date().toISOString();
    await db.collection('provisionalGrades').doc(attemptId).set({
      attemptId,
      assessmentId: attempt.assessmentId,
      instituteId: attempt.instituteId ?? null,
      studentId: attempt.studentId ?? null,
      scores,
      gradedAnswers,
      // Which pause this describes. If a later freeze is graded the row is
      // replaced; the id makes it checkable that a grade belongs to the freeze
      // currently open rather than an earlier one.
      freezeId: open.id,
      answeredCount: Object.keys(attempt.answers ?? {}).length,
      gradedAt: nowIso,
      gradedBy: actor.uid,
      gradedByRole: actor.role,
    });

    await writeAuditRow(db, {
      action: 'attemptGradedProvisional',
      entityType: 'attempt',
      entityId: attemptId,
      entityLabel: attempt.studentId ?? null,
      instituteId: attempt.instituteId ?? null,
      actorUid: actor.uid,
      actorRole: actor.role,
      reason: `freeze ${open.id}`,
    });

    return { ok: true, scores, provisional: true as const, gradedAt: nowIso };
  },
);

export const freezeAttempt = onCall<FreezeAttemptData>(
  CALLABLE_BASE,
  async (request) => {
    const { attemptId, reason } = request.data || ({} as FreezeAttemptData);
    if (!attemptId) throw new HttpsError('invalid-argument', 'attemptId is required.');

    const db = getFirestore();
    const ref = db.collection('attempts').doc(attemptId);

    const result = await db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'Attempt not found.');
      const att = snap.data() as {
        instituteId?: string; status?: string; frozenAt?: string | null;
        freezes?: FreezeLedgerEntry[];
        // Phase 4.5 Stage 2 — needed to snapshot the clocks at this instant.
        assessmentId?: string;
      };
      const actor = assertInvigilator(request, att);

      if (att.status !== 'in_progress' && att.status !== 'frozen') {
        throw new HttpsError('failed-precondition', 'Attempt is not live.');
      }
      // Already paused: return the open entry rather than opening a second
      // one. Two overlapping entries would break INV-4c and double-count.
      const open = (att.freezes ?? []).find((f) => !f.endedAt);
      if (open || att.frozenAt) {
        return { alreadyFrozen: true, entryId: open?.id ?? null };
      }

      const nowIso = new Date().toISOString();
      // ── §2: capture where the student stood, at this instant ────
      //
      // Read inside the transaction and before the write, so the numbers are
      // the ones that were true when the pause landed — not when someone next
      // opens a modal. Recomputing later would be asking the present state a
      // question about the past.
      const aSnap = att.assessmentId
        ? await txn.get(db.collection('assessments').doc(att.assessmentId))
        : null;

      const { updates, entry } = openFreezeUpdates(
        att as unknown as Record<string, unknown>,
        aSnap?.exists ? (aSnap.data() as Record<string, unknown>) : null,
        {
          reason: 'invigilator',
          frozenBy: actor.uid,
          // §3/§8: authority attaches per freeze, so the role is part of the
          // record rather than something 4.6 has to infer later.
          frozenByRole: actor.role as FreezeLedgerEntry['frozenByRole'],
          nowIso,
        },
      );

      txn.update(ref, {
        ...updates,
        ...(reason ? { frozenReason: String(reason).slice(0, 300) } : {}),
      });
      return { alreadyFrozen: false, entryId: entry.id, actor };
    });

    if (!result.alreadyFrozen && result.actor) {
      await writeAuditRow(db, {
        action: 'attemptFrozen',
        entityType: 'attempt',
        entityId: attemptId,
        actorUid: result.actor.uid,
        actorRole: result.actor.role,
        reason: reason ?? null,
      });
      // M5: a freeze opens a ledger entry, which is the input to every clock
      // the resolver computes. INV-4a ("freeze credit cannot create time") is
      // the invariant most likely to break here and least likely to be
      // noticed, because the damage shows up later as a student with more
      // time than anyone granted. No verdict comparison — a freeze is not a
      // timing decision — so the full kind set, and the invariant check is
      // the whole point.
      await auditTimingFromStore(db, 'freezeAttempt', attemptId,
        ['question', 'section', 'break', 'choose', 'ended', 'not_started']);
    }
    return { ok: true, ...result };
  },
);

interface UnfreezeAttemptData {
  attemptId: string;
  /**
   * Milliseconds of credit to grant, 0..elapsed. REQUIRED — there is no
   * default, because "how much of this pause was the student's fault" is a
   * judgement the system cannot make for the invigilator. The UI pre-fills the
   * full elapsed time; accepting zero is deliberate and must be explicit.
   */
  grantedMs: number;
  note?: string;
  /**
   * Deductions taken as part of this resume decision (Phase 4.5 / A4).
   *
   * All three clocks in one action, because that is how the decision is made:
   * "give back four minutes but take twenty seconds off the section" is one
   * judgement, not two. Omitted or zero means no penalty — the default, and
   * the only outcome that requires no justification.
   *
   * Each is capped server-side at what that clock has left AFTER the credit
   * lands. A4 promises no arithmetic that can go negative, and measuring the
   * cap before the credit would break that promise whenever the grant is
   * partial.
   */
  penalties?: {
    questionMs?: number;
    sectionMs?: number;
    overallMs?: number;
  };
}

/**
 * Resume a sitting, deciding how much of the pause to give back. (Phase 4.)
 *
 * WHY THE TOTAL IS COMPUTED HERE AND NOT PASSED IN
 * The old client call took `currentTotalFrozenSeconds` as an argument and
 * wrote `current + additional`. Stale roster state — or two invigilators on
 * the same attempt — therefore made accumulated credit DECREASE, which is
 * INV-4a. Inside this transaction the total is derived from the ledger, so it
 * cannot regress no matter who calls it or how stale their screen is.
 */
export const unfreezeAttempt = onCall<UnfreezeAttemptData>(
  CALLABLE_BASE,
  async (request) => {
    const { attemptId, grantedMs, note } = request.data || ({} as UnfreezeAttemptData);
    if (!attemptId) throw new HttpsError('invalid-argument', 'attemptId is required.');
    if (typeof grantedMs !== 'number' || !Number.isFinite(grantedMs) || grantedMs < 0) {
      throw new HttpsError('invalid-argument', 'grantedMs must be a number >= 0.');
    }

    const db = getFirestore();
    const ref = db.collection('attempts').doc(attemptId);

    const result = await db.runTransaction(async (txn) => {
      const snap = await txn.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'Attempt not found.');
      const att = snap.data() as {
        instituteId?: string; frozenAt?: string | null;
        freezes?: FreezeLedgerEntry[]; totalFrozenSeconds?: number;
        // Phase 4.3 — needed to re-materialise the lock once credit is granted.
        assessmentId?: string; startedAt?: string;
        sectionTimings?: Record<string, { startedAt?: string; submittedAt?: string }>;
        // Phase 4.5 — existing deductions, appended to never replaced (INV-11).
        penalties?: CorePenalty[];
      };
      const actor = assertInvigilator(request, att);

      // Read before write — Firestore transactions require it, and the update
      // below is the only write. `{}` when the assessment is missing: an
      // untimed result is the safe direction, never a thrown unfreeze. An
      // invigilator must always be able to release a student.
      const lockSnap = att.assessmentId
        ? await txn.get(db.collection('assessments').doc(att.assessmentId))
        : null;

      const ledger = [...(att.freezes ?? [])];
      const idx = ledger.findIndex((f) => !f.endedAt);
      // §3/§8: checked against THIS entry, inside the transaction, before
      // anything is written. Authority belongs to the pause, so it has to be
      // read from the pause rather than from the attempt.
      assertCanUnfreeze(actor, idx >= 0 ? ledger[idx] : undefined);
      const startedAtIso = idx >= 0 ? ledger[idx].startedAt : att.frozenAt;
      if (!startedAtIso) {
        throw new HttpsError('failed-precondition', 'Attempt is not frozen.');
      }

      const nowIso = new Date().toISOString();

      // ── Everything the release writes lives in closeFreezeUpdates ──
      //
      // Closing the entry, deriving creditedFreezeMs from the ledger, clamping
      // the A4 deductions against the post-credit clock, recomputing the three
      // lock fields and re-materialising freezeCredits are one operation, and
      // they are now expressed once. verifyAndResume performs the same release
      // through the same function, so the invigilator path and the system path
      // cannot reach different state (F4 / F7).
      const closed = closeFreezeUpdates(
        att as unknown as Record<string, unknown>,
        lockSnap?.exists ? (lockSnap.data() as Record<string, unknown>) : null,
        {
          grantedMs,
          decidedBy: actor.uid,
          note,
          nowIso,
          penalties: request.data?.penalties,
          decidedByRole: actor.role,
        },
      );

      // ── A9: unfreeze invalidates the provisional grade ──────────
      //
      // "Unfreeze invalidates the grade. Stale scores are cleared
      // automatically." The student is about to keep working, so any mark
      // describing where they had got to is now describing a moment that has
      // passed.
      //
      // In the same transaction as the release, not a follow-up write: a
      // failure between the two would leave a stale grade on a running
      // attempt, which is the exact state A9 forbids. Deleting a row that is
      // not there is a no-op, so no existence check is needed.
      txn.delete(db.collection('provisionalGrades').doc(attemptId));
      txn.update(ref, closed.updates);

      return {
        elapsedMs: closed.elapsedMs,
        grantedMs: closed.grantedMs,
        creditedFreezeMs: closed.creditedFreezeMs,
        actor,
      };
    });

    await writeAuditRow(db, {
      action: 'attemptUnfrozen',
      entityType: 'attempt',
      entityId: attemptId,
      actorUid: result.actor.uid,
      actorRole: result.actor.role,
      reason: note ?? null,
      impact: { elapsedMs: result.elapsedMs, grantedMs: result.grantedMs },
    });

    // M5: the sharper half of the freeze pair. This is where credit is
    // actually GRANTED — a human choosing a number between 0 and elapsed —
    // and where INV-4a is decided. The Math.min(granted, elapsed) cap and the
    // per-clock penalty caps run inside the transaction above; this is the
    // independent check that what landed in the document agrees with them.
    await auditTimingFromStore(db, 'unfreezeAttempt', attemptId,
      ['question', 'section', 'break', 'choose', 'ended', 'not_started']);

    return {
      ok: true,
      elapsedMs: result.elapsedMs,
      grantedMs: result.grantedMs,
      creditedFreezeMs: result.creditedFreezeMs,
    };
  },
);

export const getExamVerdict = onCall<GetExamVerdictData>(
  EXAM_HOT_PATH,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const role = request.auth.token.role as string | undefined;
    const studentId = request.auth.token.studentId as string | undefined;
    const instituteId = request.auth.token.instituteId as string | undefined;

    const { attemptId, sessionId, sebToken } = request.data || ({} as GetExamVerdictData);
    if (!attemptId) throw new HttpsError('invalid-argument', 'attemptId is required.');

    const db = getFirestore();
    const snap = await db.collection('attempts').doc(attemptId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Attempt not found.');
    const att = snap.data() as Record<string, any>;

    // A student may ask about their own sitting; staff may ask about one in
    // their tenant. Same scoping the roster already relies on.
    const isOwner = role === 'student' && att.studentId === studentId;
    const isStaff = role === 'webOwner'
      || ((role === 'institute' || role === 'faculty') && att.instituteId === instituteId);
    if (!isOwner && !isStaff) {
      throw new HttpsError('permission-denied', 'Not your attempt.');
    }

    if (isOwner) {
      assertSession(att, sessionId, 'getExamVerdict');
      assertSEB(sebToken, request.auth.uid, att.securityConfig?.requireSEB, att.assessmentId);
    }

    const aSnap = await db.collection('assessments').doc(att.assessmentId).get();
    if (!aSnap.exists) throw new HttpsError('not-found', 'Assessment not found.');

    const core = toCoreAttempt(att);
    // A-06: the student's screen renders the contract they started under.
    const coreAsmt = toCoreAssessment(
      examContractFor(att, aSnap.data() as Record<string, unknown>) as Record<string, unknown>);
    const serverNow = Date.now();
    const verdict = resolveTiming(core, coreAsmt, serverNow);

    // serverNow rides along so the client can measure its own skew against the
    // same instant the verdict was computed at, rather than trusting a local
    // clock it has no reason to trust (the existing getServerTime contract).
    return { ok: true, serverNow, verdict };
  },
);

export const startExam = onCall<StartExamData>(
  // Phase 3: the secret must be declared here or SEB_SIGNING_SECRET.value()
  // is empty at runtime and assertSEB would fail closed on every call.
  // EXAM_HOT_PATH carries that secret plus the capacity settings.
  EXAM_HOT_PATH,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const role = request.auth.token.role as string | undefined;
    const studentId = request.auth.token.studentId as string | undefined;
    const instituteId = request.auth.token.instituteId as string | undefined;
    if (role !== 'student' || !studentId || !instituteId) {
      throw new HttpsError('permission-denied', 'Only students may start an exam.');
    }

    // ── Structure is NOT taken from the caller (D-07, doctrine D6) ──
    // `sections`, `shuffleQuestions` and `sectionStartOrder` used to be read
    // straight out of request.data and used to build the attempt. Because the
    // section time limit was looked up as
    //   a.sections?.find(s => s.id === firstSectionId)?.timeLimit
    // a caller who supplied a section id that does not exist in the document
    // got `undefined` back — computeAttemptLocks then produced no section
    // bound, and submitSection's deadline check was skipped by the same failed
    // lookup. A per-section timed exam became one untimed block. The paper was
    // never at risk (getExamQuestions reads the document) and neither was the
    // mark (grading reads the document too) — the exploit was purely on TIME,
    // which for a timed exam is the whole contract.
    //
    // They are still ACCEPTED in the payload and ignored, so a cached client
    // keeps working through the rollout and a rollback is clean.
    const { assessmentId, cameraDeclined, sebToken, sessionId } =
      request.data || ({} as StartExamData);
    if (!assessmentId) {
      throw new HttpsError('invalid-argument', 'assessmentId is required.');
    }

    const db = getFirestore();

    // Resolve the student's display name from their profile doc (the token's
    // name claim may be unset).
    const stuSnap = await db.collection('students').doc(studentId).get();
    const studentName = stuSnap.exists
      ? String((stuSnap.data() as { name?: string }).name ?? '')
      : '';

    // Read the assessment — schedule + limits are authoritative from here.
    const aSnap = await db.collection('assessments').doc(assessmentId).get();
    if (!aSnap.exists) throw new HttpsError('not-found', 'Assessment not found.');
    const a = aSnap.data() as {
      status?: string;
      startDate?: string;
      endDate?: string;
      maxAttempts?: number;
      attemptOverrides?: Record<string, number>;
      blockedStudents?: string[];
      title?: string;
      assignedTo?: { type: string; instituteIds?: string[]; studentIds?: string[] };
      // Phase C — when 'rules', targeting is enforced by the materialized
      // assessmentMembers list instead of assignedTo (both paths coexist).
      allocationMode?: string;
      securityTier?: 'mock' | 'normal' | 'high_stake';
      deliveryMode?: 'standard' | 'linear' | 'adaptive';
      requireCamera?: boolean;
      allowMobile?: boolean;
      allowTablet?: boolean;
      autoResume?: boolean;
      requireExtensionCheck?: boolean;
      requireSEB?: boolean;
      sebConfigKeys?: string[];
      securityLockedAt?: string;
      gradingConfig?: AssessmentGradingConfigS;   // frozen onto the attempt below
      // Timing, read for the answer-write lock (audit 2026-07-28). Section
      // limits come from HERE, never from the client's sections payload —
      // that array is caller-supplied and a forged timeLimit would buy the
      // student a longer writable window, which is the whole thing being
      // closed.
      sections?: Array<{ id: string; timeLimit?: number }>;
      sectionGraceSeconds?: number;
      overallTimeLimit?: number;
      overallGraceSeconds?: number;
      // Phase 2 (D-07): exam STRUCTURE is read from here, never from the
      // caller. See the note where effectiveSections is built below.
      shuffleQuestions?: boolean;
      sectionStartOrder?: 'sequential' | 'random' | 'student_choice';
    };

    // ── Effective security config, re-derived SERVER-SIDE (Phase 0) ──
    // Never trust client-supplied security values. Legacy docs (no
    // securityTier) behave exactly as today: no camera gate, no extension
    // gate, mobile left open. High-stake locks camera on / mobile off /
    // extension on regardless of stored overrides.
    const isLegacy = a.securityTier === undefined;
    const tier: 'mock' | 'normal' | 'high_stake' = a.securityTier ?? 'normal';
    const requireCamera = isLegacy
      ? false
      : tier === 'high_stake'
        ? true
        : (a.requireCamera ?? (tier === 'mock' ? false : true));
    // ── Device policy, re-derived server-side ─────────────────────
    //
    // Two axes now, where there was one. `allowMobile` used to cover phones
    // AND tablets, so an authority that wanted to admit a 13-inch iPad had to
    // admit a 6-inch phone with it.
    //
    // Phones are LOCKED off at 'normal' as well as 'high_stake'. Previously
    // 'normal' merely defaulted them off and an author could tick them back
    // on, which meant the tier's name said nothing about the device — while
    // the tier's proctoring, which is the thing the name is promising, does
    // not survive a phone. Fullscreen does not exist on iOS Safari; the
    // viewport detectors measure desktop browser chrome and read an on-screen
    // keyboard as a docked DevTools panel. 'mock' is the tier that means "sit
    // this anywhere", and it still does.
    //
    // GRANDFATHERED, on the same terms as requireSEB below: an assessment
    // whose security config was already frozen (securityLockedAt) and which
    // explicitly stored allowMobile:true keeps admitting phones. Tightening
    // those would start refusing candidates mid-window over a device their
    // institution told them to bring — the exact failure the SEB grandfather
    // was written to avoid, and the lock binds at publish like every other
    // frozen field rather than reaching back through one.
    const mobileGrandfathered =
      tier === 'normal' && a.allowMobile === true && !!a.securityLockedAt;
    const allowMobile = isLegacy
      ? true
      : tier === 'high_stake'
        ? false
        : tier === 'mock'
          ? (a.allowMobile ?? true)
          : mobileGrandfathered;   // 'normal' — locked off but for a pre-lock opt-in
    const allowTablet = isLegacy
      ? true
      : tier === 'high_stake'
        ? false
        : tier === 'mock'
          ? (a.allowTablet ?? true)
          // 'normal' — the one device permission an authority still holds.
          // A pre-split document has no allowTablet field; it does have the
          // old combined allowMobile, and a 'normal' exam that admitted
          // phones certainly admitted tablets, so that is what it inherits.
          : (a.allowTablet ?? a.allowMobile ?? false);
    const requireExtensionCheck = isLegacy
      ? false
      : tier === 'high_stake'
        ? true
        : (a.requireExtensionCheck ?? true);
    // ── Phase 3 — SEB requirement, re-derived server-side ─────────
    //
    // D-10: high_stake now LOCKS this on, joining camera / mobile / extension
    // above. It was the one high-stake control an authority could switch off,
    // and it is the only one that reaches remote-desktop tools, VPNs and
    // userscript managers — everything the in-page deterrents are explicitly
    // unable to see. A high-stake exam with SEB disabled was running on the
    // deterrent layer alone while presenting itself as the strictest tier.
    //
    // GRANDFATHERED: an assessment whose security config was already frozen
    // (securityLockedAt) and which explicitly stored requireSEB:false keeps
    // running without it. Tightening those would be P-01/P-18 in reverse — an
    // exam already published, possibly already scheduled and briefed, would
    // start rejecting every candidate at the door for want of a .seb file
    // nobody was told to install. The lock binds at publish, like every other
    // frozen field; it does not reach back through one.
    const sebGrandfathered =
      tier === 'high_stake' && a.requireSEB === false && !!a.securityLockedAt;
    const requireSEB = isLegacy
      ? false
      : tier === 'high_stake'
        ? !sebGrandfathered   // LOCKED on, except for a pre-lock opt-out
        : (a.requireSEB ?? false);

    // Phase 3 gate. Uses the SERVER-derived requireSEB, never the client's
    // claim, and binds the proof to this caller's uid. Placed before any
    // attempt is created so a non-SEB student never gets an attempt document.
    assertSEB(sebToken, request.auth.uid, requireSEB, assessmentId);

    const effectiveAutoResume = isLegacy
      ? false
      : tier === 'high_stake'
        ? false
        : (a.autoResume ?? false);

    if (a.status === 'draft') {
      throw new HttpsError('failed-precondition', 'This assessment is not published.');
    }
    if (a.blockedStudents?.includes(studentId)) {
      throw new HttpsError('permission-denied', 'You are blocked from this exam.');
    }

    // ── Device policy gate (Phase 0) ──────────────────────────────
    //
    // Runs before the idempotency check, so a resuming student re-passes it
    // (safe: same device on resume).
    //
    // The device class used to be read straight off `request.data`, which made
    // the whole gate a client assertion: one line in a browser console set it
    // to 'desktop' and a high-stake exam opened on a phone. The claim is still
    // accepted — the client sees things the header cannot, and the honest path
    // should stay the fast one — but it is now CORROBORATED against the
    // request's own User-Agent, which the page's JavaScript does not author.
    // Where the two disagree, the stricter reading wins and the disagreement
    // is recorded on the attempt for a human to weigh.
    //
    // This is not spoof-proof either: a proxy or a rebuilt client can set any
    // header it likes. It closes the gap between "trivially bypassable from
    // the address bar" and "requires tooling", which is where every other
    // deterrent in this product already sits. Real device assurance for
    // high-stake exams is SEB's config-key check, not this.
    const claimedDeviceClass = normaliseDeviceClass(request.data?.deviceClass) ?? 'desktop';
    const headerDeviceClass = deviceClassFromUserAgent(
      String(request.rawRequest?.headers?.['user-agent'] ?? ''),
    );
    const deviceClass = strictestDeviceClass(claimedDeviceClass, headerDeviceClass);
    const deviceClaimMismatch =
      headerDeviceClass !== null && headerDeviceClass !== claimedDeviceClass
        ? { claimed: claimedDeviceClass, observed: headerDeviceClass }
        : null;

    if (!deviceClassAllowed(deviceClass, allowMobile, allowTablet)) {
      // The suffix names WHICH device was refused, so the client can say
      // "phones are not permitted, use a tablet or a computer" instead of a
      // single sentence that is wrong half the time. Kept machine-readable in
      // the same shape as SEB_* and ATTEMPT_LIMIT_EXCEEDED, which the shell
      // already knows how to translate.
      throw new HttpsError(
        'failed-precondition',
        `DEVICE_NOT_ALLOWED:${deviceClass}: this exam must be taken on a ${
          allowTablet ? 'computer or tablet' : 'computer'
        }.`,
      );
    }
    // ── Camera-required gate (Phase 0) ────────────────────────────
    if (requireCamera && cameraDeclined === true) {
      throw new HttpsError(
        'failed-precondition',
        'CAMERA_REQUIRED: this exam requires your camera to be enabled.',
      );
    }

    // Targeting gate — the client briefing filters targeting, but nothing
    // stopped a student from calling startExam directly with any active
    // assessment id. Enforce server-side.
    //
    // Phase C — two paths, chosen per-assessment by allocationMode:
    //   'rules' → the materialized assessmentMembers list is authoritative
    //             (O(1) doc-id lookup; the resolveAllocation / addManualMember
    //             callables are its only writers).
    //   else   → legacy assignedTo gate, byte-for-byte unchanged. Legacy docs
    //            without assignedTo are treated as webOwner-global ('all').
    // Enumeration hardening: a not-assigned student gets the SAME uniform
    // denial as not-found / not-open, so probing reveals nothing.
    let admittedAllocationVersion: number | null = null;
    let admittedAllocationSource: string | null = null;
    if (a.allocationMode === 'rules') {
      const memberSnap = await db.collection('assessmentMembers')
        .doc(`${assessmentId}_${studentId}`)
        .get();
      if (!memberSnap.exists || memberSnap.get('active') !== true) {
        throw new HttpsError('permission-denied', 'This exam is not assigned to you.');
      }
      admittedAllocationVersion = Number(memberSnap.get('admittedByVersion') ?? 0);
      admittedAllocationSource = String(memberSnap.get('source') ?? 'rules');
    } else {
      const target = a.assignedTo;
      if (target && target.type !== 'all') {
        const assigned =
          target.type === 'institutes'
            ? (target.instituteIds ?? []).includes(instituteId)
            : target.type === 'students'
              ? (target.studentIds ?? []).includes(studentId)
              : false;
        if (!assigned) {
          throw new HttpsError('permission-denied', 'This exam is not assigned to you.');
        }
      }
    }

    const serverNow = Date.now();
    if (a.startDate && serverNow < new Date(a.startDate).getTime()) {
      throw new HttpsError('failed-precondition', 'This exam has not opened yet.');
    }
    if (a.endDate && serverNow > new Date(a.endDate).getTime()) {
      throw new HttpsError('failed-precondition', 'This exam has closed.');
    }

    // ── Fast path (NOT authoritative) ─────────────────────────────
    // A plain read that short-circuits the two common cases without paying to
    // build an attempt: resuming a live sitting, and a student who is already
    // out of attempts. The transaction at the end of this function is what
    // actually decides — see the note there for why this read alone is not
    // enough.
    const attemptsQuery = db.collection('attempts')
      .where('studentId', '==', studentId)
      .where('assessmentId', '==', assessmentId);

    const effectiveMax = a.attemptOverrides?.[studentId] ?? a.maxAttempts ?? 1;

    const preSnap = await attemptsQuery.get();
    const pre = evaluateStudentAttempts(preSnap.docs, effectiveMax);
    if (pre.live) return { ok: true, attempt: pre.live.data() };

    // ── Manually CLOSED assessment (D-11, master plan Phase 1) ────
    // Only 'draft' was checked here, so an exam a Web Owner closed by hand
    // stayed enterable whenever its endDate was still future or unset — the
    // briefing page was the only thing stopping it, and the briefing page is
    // not a security control.
    //
    // Placed AFTER the live-attempt return, deliberately. A student already
    // mid-sitting when staff close the exam must still be able to resume and
    // submit; closing an exam is an admissions decision, not a reason to
    // destroy work in progress. This blocks NEW sittings only.
    //
    // (endDate is checked earlier and does still block resume. That is the
    // authored hard wall from the timing spec, and changing it belongs to the
    // window work in Phase 5, not here.)
    if (a.status === 'closed') {
      throw new HttpsError('failed-precondition', 'This exam has closed.');
    }

    if (pre.limitReached) {
      throw new HttpsError(
        'resource-exhausted',
        `ATTEMPT_LIMIT_EXCEEDED:${pre.finished}:${effectiveMax}`,
      );
    }

    // ── Build frozen state (mirrors legacy startAttempt) ──────────
    const nowIso = new Date().toISOString();

    // ── Legacy fallback for the security freeze (audit P-01) ───────
    // The freeze now happens at PUBLISH (assessmentService.stampIfPublishing,
    // enforced by firestore.rules), so any assessment published after that
    // change arrives here already stamped and this block is skipped entirely.
    //
    // It remains for assessments that went live BEFORE that change and carry
    // no stamp. Removing it outright would leave those exams' security config
    // editable forever, which is the opposite of the intent.
    //
    // NON-FATAL, and that is the whole point at scale. This is the only write
    // to a SHARED document anywhere on the student hot path. At a large
    // simultaneous opening every invocation that reads the doc before the
    // first write propagates also writes — hundreds to thousands of writes
    // onto one document, against Firestore's ~1-write-per-second-per-document
    // ceiling. Previously this was a bare `await`, so a contention rejection
    // threw and STOPPED THAT STUDENT SITTING THE EXAM. Swallowing it is
    // correct: the stamp is idempotent and racing writers all write the same
    // instant, so with thousands trying at least one lands, and a student is
    // never blocked from starting because of a bookkeeping write.
    if (!a.securityLockedAt) {
      try {
        await db.collection('assessments').doc(assessmentId)
          .set({ securityLockedAt: nowIso, updatedAt: nowIso }, { merge: true });
      } catch (e) {
        console.warn('[startExam] legacy securityLockedAt stamp skipped', assessmentId, e);
      }
    }

    // ── Server-derived exam structure (D-07, doctrine D6) ─────────
    // normalizeSections is the SAME function grading uses, so the sections an
    // attempt is built from and the sections it is marked against can never
    // disagree. It also handles the three legacy shapes (resolved sections /
    // flat question list distributed across named sections / no sections at
    // all) identically to the grader.
    const effectiveSections = normalizeSections(aSnap.data() as GradingAssessmentDoc);
    if (effectiveSections.length === 0) {
      throw new HttpsError('failed-precondition', 'This exam has no questions.');
    }
    const shuffleQuestions = a.shuffleQuestions === true;
    const sectionStartOrder = a.sectionStartOrder ?? 'sequential';

    let ordered = effectiveSections;
    if (sectionStartOrder === 'random' || sectionStartOrder === 'student_choice') {
      ordered = [...effectiveSections];
      for (let i = ordered.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
      }
    }
    const sectionIds = ordered.map((s) => s.id);

    // ── Question order, with grouped sets kept intact (Phase 1) ──────
    //
    // Shuffling is per-question EXCEPT across a group. A grouped set — a DI
    // chart, an RC passage, a caselet, a seating scenario — is one unit of
    // work: its questions are written to be read together, often ramp in
    // difficulty, and routinely refer to each other ("in the year identified
    // in Q2..."). A flat Fisher-Yates over the section would scatter them
    // between unrelated questions and reorder them internally, which is not a
    // harder paper, it is a broken one.
    //
    // So: build blocks, where a standalone question is a block of one and a
    // group is a block of all its questions in groupOrder. Shuffle the BLOCKS.
    // Group members stay contiguous and stay in their authored order.
    //
    // Unchanged for every pre-Phase-1 paper: with no groupId anywhere, every
    // block has length 1 and this is exactly the old per-question shuffle.
    const questionOrder: Record<string, string[]> = {};
    for (const sec of ordered) {
      const sorted = [...sec.questions].sort((x, y) => (x.order ?? 0) - (y.order ?? 0));

      // Blocks, in first-appearance order.
      const blocks: string[][] = [];
      const blockByGroup = new Map<string, string[]>();
      for (const q of sorted) {
        const gid = (q as { groupId?: string }).groupId;
        if (!gid) {
          blocks.push([q.questionId]);
          continue;
        }
        let block = blockByGroup.get(gid);
        if (!block) {
          block = [];
          blockByGroup.set(gid, block);
          blocks.push(block);
        }
        block.push(q.questionId);
      }

      if (shuffleQuestions) {
        for (let i = blocks.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
        }
      }

      questionOrder[sec.id] = blocks.flat();
    }

    // ── Served-question sequence (Phase 0) ────────────────────────
    // Append-only source of truth for what the student was actually shown.
    // Standard mode writes the whole paper now (all unlocked = free nav);
    // linear/adaptive will append one at a time in Phase 2.5. Grading will
    // iterate this. Client-supplied sections carry no difficulty field, so
    // difficulty defaults to 'medium' (display metadata only, non-security).
    // ── Served-question sequence (Phase 0 shape; Phase 2.5 behaviour) ──
    // Append-only source of truth for what the student was actually shown.
    // standard  : the whole paper is written now (all unlocked = free nav).
    // linear    : ONLY the first question of the auto-started section. The rest
    //             are served one at a time by submitAnswerAndAdvance, so the
    //             client never holds the paper.
    // adaptive  : same as linear (ladder picks the next) — Phase 2.5 Stage 4.
    // Difficulty is display metadata; client-supplied sections carry none, so
    // it defaults to 'medium' here and is corrected when the server serves.
    const deliveryMode = a.deliveryMode ?? 'standard';
    const isSequential = deliveryMode === 'linear' || deliveryMode === 'adaptive';
    const servedQuestions: Array<{
      questionId: string;
      sectionId: string;
      difficulty: string;
      servedAt: string;
      locked: boolean;
    }> = [];
    if (isSequential) {
      // Only the first question of the section that auto-starts. If the student
      // chooses their own section order, nothing is served until startSection.
      const autoStarts = sectionStartOrder !== 'student_choice';
      const firstSec = ordered[0];
      const firstQid = firstSec ? questionOrder[firstSec.id]?.[0] : undefined;
      if (autoStarts && firstSec && firstQid) {
        servedQuestions.push({
          questionId: firstQid,
          sectionId: firstSec.id,
          difficulty: 'medium',
          servedAt: nowIso,
          locked: false,
        });
      }
    } else {
      for (const sec of ordered) {
        for (const qid of questionOrder[sec.id]) {
          servedQuestions.push({
            questionId: qid,
            sectionId: sec.id,
            difficulty: 'medium',
            servedAt: nowIso,
            locked: false,
          });
        }
      }
    }

    const sectionTimings: Record<string, AttemptSectionTiming> = {};
    const autoStartFirst = sectionStartOrder !== 'student_choice';
    ordered.forEach((sec, idx) => {
      sectionTimings[sec.id] = {
        startedAt: autoStartFirst && idx === 0 ? nowIso : '',
        timeUsedSeconds: 0,
      };
    });

    // Answer-write lock for the FIRST section (audit 2026-07-28). startSection
    // recomputes this on every later section, but section one is auto-started
    // here and never passes through it, so without this the opening section
    // would be the one stretch of the exam with no server-side time bound.
    //
    // student_choice defers the first start, so there is no section clock to
    // bound yet — the overall deadline still applies if the exam has one, and
    // the student's own startSection call sets the section bound when they
    // pick. computeAttemptLocks handles that by taking whichever bounds
    // exist.
    const firstSectionId = autoStartFirst ? ordered[0]?.id : undefined;
    const initialLocks = computeAttemptLocks(
      nowIso,
      firstSectionId ? nowIso : undefined,
      a.sections?.find((sec) => sec.id === firstSectionId)?.timeLimit,
      a,
    );

    // Random component FIRST — monotonically increasing document IDs cluster
    // index writes and hotspot above ~500 creates/sec. Random prefix spreads
    // them. Timestamp kept (after) for human readability in the console.
    const id = `attempt_${Math.random().toString(36).slice(2, 9)}_${Date.now()}`;
    const attempt = {
      id,
      assessmentId,
      assessmentTitle: a.title ?? '',
      studentId,
      studentName,
      instituteId,
      status: 'in_progress' as const,
      startedAt: nowIso,
      currentSectionIdx: 0,
      sectionIds,
      sectionTimings,
      // Combined = min(section, overall); still exactly what the rules gate on.
      // D-35: present from birth so the client never sees the field missing.
      // Always zero here — a new attempt has no ledger to credit from.
      freezeCredits: { overallMs: 0, sectionMs: 0, questionMs: 0, breakMs: 0 },
      answersLockedAfter: initialLocks.combined ? Timestamp.fromDate(initialLocks.combined) : null,
      // Split bounds (Phase 0) — the resume path needs to know WHICH clock
      // tripped, which the minimum alone cannot say.
      sectionLockedAfter: initialLocks.section ? Timestamp.fromDate(initialLocks.section) : null,
      overallLockedAfter: initialLocks.overall ? Timestamp.fromDate(initialLocks.overall) : null,
      questionOrder,
      servedQuestions,
      answers: {},
      integrityLog: {
        tabSwitches: 0, focusLosses: 0, fullscreenExits: 0, copyAttempts: 0,
        pasteAttempts: 0, rightClickAttempts: 0, multiPersonEvents: 0,
        faceAbsenceEvents: 0, devtoolsEvents: 0, keyboardBlockEvents: 0,
        extensionEvents: 0, viewportEvents: 0, foreignDomEvents: 0, printAttempts: 0,
        focusMismatchEvents: 0, renderThrottleEvents: 0,
        totalViolations: 0, violations: [], autoTerminated: false,
      },
      cameraDeclined: cameraDeclined ?? false,
      // The SERVER's conclusion, not the client's claim — see the gate above.
      deviceClass,
      // Written only when the claim and the header disagreed, so its presence
      // is the whole signal. Recorded rather than acted on: iOS "Request
      // Desktop Website" produces exactly this and is a normal accessibility
      // choice, so it is a thing for an invigilator to weigh, not a refusal.
      ...(deviceClaimMismatch ? { deviceClaimMismatch } : {}),
      // The machine baseline. Written at creation and never rewritten — every
      // later heartbeat is compared against THIS, server-side.
      ...(sanitiseFingerprint(request.data?.fingerprint)
        ? { deviceFingerprint: sanitiseFingerprint(request.data?.fingerprint) }
        : {}),
      // Phase 2 (INV-5a): the session that opened this sitting owns it from
      // the first instant, so there is no unclaimed window in which a second
      // device could slip in ahead of the real one.
      ...(sessionId ? { activeSessionId: sessionId } : {}),
      // Frozen security snapshot — the contract this student actually sits
      // under, independent of any later edit to the assessment (Phase 0).
      securityConfig: {
        tier,
        deliveryMode: a.deliveryMode ?? 'standard',
        requireCamera,
        requireExtensionCheck,
        allowMobile,
        allowTablet,
        autoResume: effectiveAutoResume,
        // Phase 3 — frozen with the rest of the contract, so toggling the
        // assessment mid-exam cannot change what this attempt must satisfy.
        requireSEB,
      },
      // Frozen grading policy — negative marking + blank handling, resolved per
      // question at grade time from THIS snapshot, so editing the exam's policy
      // mid-flight can't change how an in-progress student is scored. Only
      // stored when the exam actually defines a policy (keeps legacy attempts
      // clean; absent === legacy scoring).
      ...(a.gradingConfig ? { gradingConfig: a.gradingConfig } : {}),
      // ── Frozen paper + timing contract (A-05 / A-06) ──────────────
      // The third snapshot on this document, and it exists for the same reason
      // as the two above it: what a student is marked against, and the clocks
      // they race, must be what they were given — not whatever the assessment
      // says by the time anyone looks. `ordered` is this student's own play
      // order, so a shuffle is captured too. See examContractFor for what is
      // deliberately left reading live (the availability window).
      examSnapshot: buildExamSnapshot(aSnap.data() as Record<string, unknown>, ordered),
      totalFrozenSeconds: 0,
      serverAnchored: true, // marks this attempt as using server-owned timestamps
      // Phase C — allocation provenance: which materialization admitted this
      // student, and whether via rules or a manual roster add. null on the
      // legacy assignedTo path. Answers "why could X sit this exam?" forever.
      allocationVersion: admittedAllocationVersion,
      allocationSource: admittedAllocationSource,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    // ── Authoritative create (audit 2026-07-28) ───────────────────
    // The check above is a plain read, and a plain read followed by a plain
    // write is NOT atomic. Two concurrent startExam calls for the same student
    // both read, both see no live attempt, both generate a different random
    // id, and both write — producing TWO live attempts for one student, and
    // letting both pass an attempt-limit check that should have admitted one.
    //
    // That was reachable before (double-click, two tabs, flaky network) but
    // the client-side retry added for the staggered start made it far more
    // likely: 'deadline-exceeded' means "the client stopped waiting", not
    // "the server failed", so the original call may still be running and about
    // to succeed when the retry arrives. Retrying was justified on the grounds
    // that startExam is idempotent — true only for SEQUENTIAL calls. This
    // transaction is what makes that claim true under concurrency, and
    // therefore what makes the retry safe.
    //
    // Scope is deliberate. The read set is a single student's attempts for a
    // single assessment, so two students never contend — unlike a transaction
    // on the shared assessment doc, which is exactly what was rejected for
    // P-01. Only a student's own racing requests serialise, which is the point.
    //
    // Everything expensive — SEB verification, camera and targeting gates,
    // section building and shuffling — stays OUTSIDE. A transaction body can
    // re-run on contention, so anything in here is work that may be repeated,
    // and Firestore requires all reads before all writes within it.
    const created = await db.runTransaction(async (txn) => {
      const snap = await txn.get(attemptsQuery);
      const nowState = evaluateStudentAttempts(snap.docs, effectiveMax);

      // Someone won the race. Return THEIR attempt rather than creating a
      // second one — this is the case the fast path could not see.
      if (nowState.live) return nowState.live.data();

      if (nowState.limitReached) {
        throw new HttpsError(
          'resource-exhausted',
          `ATTEMPT_LIMIT_EXCEEDED:${nowState.finished}:${effectiveMax}`,
        );
      }

      txn.set(db.collection('attempts').doc(id), attempt);
      return attempt as FirebaseFirestore.DocumentData;
    });

    return { ok: true, attempt: created };
  },
);

interface StartSectionData {
  attemptId: string;
  sebToken?: string;
  /** Phase 2 — the browser session driving this sitting (INV-5a). */
  sessionId?: string;
  sectionId: string;
  reorderedSectionIds?: string[]; // student_choice only — new play order
}

// ── startSection ──────────────────────────────────────────────────
// Server-set startedAt for the section the student is entering. Covers
// sequential advance, student_choice pick (with reordering), and post-
// break resume. Refuses to start a section whose preceding MANDATORY
// break has not yet elapsed.

// ── Positional break resolution ───────────────────────────────────
// (Server twin of breakAfterCompletion in src/app/pages/student/ExamShell.tsx
// — the client schedules the UI from the same formula. Keep them in sync.)
//
// A break is AUTHORED on a section in builder order, but is APPLIED by
// completion count: the break after the Nth completed section is the one
// authored on the Nth section in builder order, regardless of the per-student
// play order. Under 'random' / 'student_choice' this makes the break schedule
// identical for every student; under 'sequential' builder order == play
// order, so it is exactly the legacy per-section behaviour.
//
// builderSections = assessment.sections (builder order). attemptSectionIds is
// the attempt's frozen played set (possibly a filtered subset of the builder
// list — empty sections are dropped client-side; legacy flat-question
// attempts use a synthetic id that matches nothing → no breaks). Sections
// complete strictly in play order in every mode, so a section's play index IS
// its completion ordinal.
type BreakCfg = { durationMinutes: number; mandatory: boolean };

function breakAfterCompletion(
  builderSections: Array<{ id: string; breakAfter?: BreakCfg }> | undefined,
  attemptSectionIds: string[] | undefined,
  completedCount: number,
): BreakCfg | null {
  if (!builderSections || builderSections.length === 0 || completedCount < 1) return null;
  const played = new Set(attemptSectionIds ?? []);
  const ordered = played.size > 0
    ? builderSections.filter((s) => played.has(s.id))
    : builderSections;
  if (completedCount >= ordered.length) return null; // no break after the last section
  const brk = ordered[completedCount - 1]?.breakAfter;
  return brk && typeof brk.durationMinutes === 'number' && brk.durationMinutes > 0 ? brk : null;
}
/**
 * Absolute instant after which a student may no longer write answers.
 *
 * Audit 2026-07-28, exam integrity. firestore.rules had NO time dimension at
 * all — the student attempt-update branch checked ownership, status
 * in_progress and a field whitelist, and nothing else. So while an attempt was
 * in_progress a student could keep writing answers indefinitely, hours past
 * every deadline. Time was enforced only inside submitSection / gradeAttempt,
 * both of which the STUDENT triggers, which made the limits advisory: leave
 * mid-exam, come back after the clock ran out, keep working. gradeAttempt then
 * scored every one of those late answers.
 *
 * The lock has to be a materialized Firestore Timestamp rather than something
 * the rules derive, because every clock anchor on the attempt is an ISO
 * STRING (attempt.startedAt, sectionTimings[id].startedAt) and rules cannot
 * parse a string into a timestamp. So the server computes the instant and
 * stores it; the rule does one comparison against request.time.
 *
 * It is the EARLIER of the two live deadlines, recomputed whenever a section
 * starts:
 *   section — sectionTimings[id].startedAt + timeLimit + sectionGrace
 *   overall — attempt.startedAt + overallTimeLimit + overallGrace
 * An untimed section contributes no section bound; an exam with no overall
 * limit contributes no overall bound; with neither there is nothing to lock
 * and this returns null, which the rule reads as "no time constraint".
 *
 * FREEZE WAS DELIBERATELY NOT CREDITED HERE — and no longer: Phase 4.3 credits
 * this gate, and Phase 4.5 subtracts recorded penalties from it. The paragraph
 * that used to sit here argued the other way and was right at the time; it is
 * removed rather than left standing, because a comment that contradicts the
 * function under it is worse than no comment (C-4). The reasoning for the
 * change is in the Phase 4.3 block further down, next to the code that does it.
 *
 * ── Phase 0 (timer plan, 2026-07-31) ──────────────────────────────
 * Renamed from computeAnswersLockedAfter, and now returns the two bounds
 * SEPARATELY as well as their minimum.
 *
 * WHY. The single value this used to return was min(section, overall), which
 * is the correct WRITE gate but destroys the one fact the resume path needs:
 * WHICH clock ran out. The client could only ask "is the window shut?", and
 * the only safe answer to that question is to finalise the whole attempt — so
 * a student who stepped away during section 2 of 4 lost sections 3 and 4.
 * Section expiry must advance to the next section; only OVERALL expiry ends
 * the sitting.
 *
 * `combined` keeps the exact previous semantics and is still what
 * `answersLockedAfter` stores, so firestore.rules and
 * scheduledCloseExpiredAttempts are untouched. The two new fields are purely
 * additive: attempts that started before this shipped simply lack them, and
 * the client falls back to the previous behaviour for those.
 *
 * The freeze note above still holds — crediting freeze is Phase 2's job, and
 * it will move BOTH bounds together. Nothing in Phase 0 alters a deadline.
 */
function computeAttemptLocks(
  attemptStartedAtIso: string | undefined,
  sectionStartedAtIso: string | undefined,
  sectionTimeLimitMin: number | undefined,
  a: {
    sectionGraceSeconds?: number;
    overallTimeLimit?: number;
    overallGraceSeconds?: number;
    /** A-07: the availability window, folded into `combined` below. */
    endDate?: string;
  },
  /**
   * The attempt, for freeze credit (Phase 4.3). Optional so every pre-existing
   * call site keeps compiling; omitting it means zero credit, which is exactly
   * what this function did before.
   *
   * PER CLOCK, never a single total — that was D-28. A ten-minute pause during
   * section 1 must not be added to a fifteen-second question in section 3.
   * creditForAnchor gives each bound only the pauses that began after its own
   * anchor.
   */
  creditFrom?: CoreAttempt,
): { section: Date | null; overall: Date | null; combined: Date | null } {
  // ── Phase 3b: the arithmetic lives in examTimingCore now ────────
  //
  // The signature and the result are unchanged on purpose — every existing
  // caller keeps working and this is provably a no-op today. What changes is
  // WHERE the rule lives: the write gate and the resolver now compute a
  // section deadline with the same function, so they cannot disagree.
  //
  // Freeze credit is passed as 0 here, and the core's legacy
  // totalFrozenSeconds fallback is off (CONSUME_LEGACY_FROZEN_SECONDS).
  // Crediting frozen time is Phase 4's decision to make explicitly, with the
  // student told — not a side effect of adopting the resolver.
  //
  // EQUIVALENCE, measured rather than assumed: across 13,824 combinations of
  // valid-or-absent timestamps, limits and grace values, this returns exactly
  // what the previous expression returned. Zero divergence.
  //
  // It is NOT identical on one input, and the difference is a fix. Given an
  // UNPARSEABLE timestamp the old expression produced `new Date(NaN)` — an
  // Invalid Date, which is TRUTHY — so applyLockUpdates went on to call
  // Timestamp.fromDate() on it and threw:
  //     Value for argument "seconds" is not a valid integer
  // A corrupt startedAt therefore 500'd the callable and blocked the student
  // out of their own section. The core returns null instead: no bound, the
  // outer clocks still apply, the student keeps working. Unreadable input
  // means "unknown", never "expired" — the failure direction always favours
  // the student.
  //
  // The WINDOW and QUESTION bounds are deliberately NOT folded in. The core
  // knows about both, but adding them to the materialised lock changes what
  // firestore.rules enforces, and that belongs to Phase 5 with its own deploy
  // and its own rollback.
  // ── Phase 4.3: freeze credit reaches the WRITE GATE ─────────────
  //
  // This was hardcoded to 0, with a note saying crediting frozen time was
  // "Phase 4's decision to make explicitly". This is that step.
  //
  // It matters because answersLockedAfter is what firestore.rules enforces.
  // The resolver has credited per-clock since D-28, so without this the two
  // disagreed: getExamVerdict would say a student had four minutes left while
  // the rules refused their writes. Same rule, two answers — the shape every
  // timing defect in this system has taken.
  //
  // Zero when no attempt is supplied, so untouched callers are unchanged.
  const sectionCredit = creditFrom ? creditForAnchor(creditFrom, sectionStartedAtIso) : 0;
  const overallCredit = creditFrom ? creditForAnchor(creditFrom, attemptStartedAtIso) : 0;
  // ── Phase 4.5 completion: penalties reach the WRITE GATE too (F2) ──
  //
  // Credit reached this function in 4.3 and deductions never did, so a
  // recorded penalty shortened the resolver's answer and the student's screen
  // while answersLockedAfter — the field firestore.rules actually enforces —
  // kept the unpenalised instant. The same split that made D-03, pointed the
  // other way: the display taking time the gate still allowed.
  //
  // Anchored exactly as the credit is. penaltyForClock counts only deductions
  // decided AFTER the clock started, and PENALTY_REACHES routes a question or
  // section deduction outward into the total, so the two bounds absorb
  // precisely what the resolver says they do.
  const sectionPenalty = creditFrom ? penaltyForClock(creditFrom, 'section', sectionStartedAtIso) : 0;
  const overallPenalty = creditFrom ? penaltyForClock(creditFrom, 'overall', attemptStartedAtIso) : 0;
  const secMs = sectionDeadlineMs(
    sectionStartedAtIso, sectionTimeLimitMin, a.sectionGraceSeconds, sectionCredit, sectionPenalty,
  );
  const ovrMs = overallDeadlineMs(
    attemptStartedAtIso, a.overallTimeLimit, a.overallGraceSeconds, overallCredit, overallPenalty,
  );

  // ── The availability window is part of the write gate (A-07) ────
  //
  // The note further up used to say the WINDOW and QUESTION bounds were
  // "deliberately NOT folded in… that belongs to Phase 5". This is that step,
  // for the window. resolve() has always treated endDate as a hard outer wall
  // (R2/A10) and startExam refuses entry past it — but `answersLockedAfter`,
  // the field firestore.rules actually enforces, ignored it. So between the
  // window closing and the student's own overall deadline, the rules still let
  // answers through: measured at a lock reading +181m on an exam whose window
  // shut at +20m, with getExamVerdict already returning window_closed. The only
  // thing standing in the way was the hourly sweep.
  //
  // It goes into `combined` ONLY. The split `section` / `overall` fields exist
  // so the client can tell WHICH clock ran out, and a window closure is neither
  // of them — folding it into either would make the shell report the wrong
  // reason and, worse, advance a student to the next section when the exam is
  // over.
  //
  // No freeze credit, matching computeDeadlines exactly:
  // FREEZE_CREDIT_EXTENDS_WINDOW is false, because the window belongs to the
  // institution rather than to the student's clocks.
  //
  // The QUESTION bound is still deliberately excluded. It is anchored on a
  // served instant that moves several times a minute in sequential delivery,
  // and materialising it would mean rewriting the lock on every question —
  // where the callable path now enforces it directly (A-03).
  const windowMs = toTimingMs(a.endDate);

  const section = secMs === null ? null : new Date(secMs);
  const overall = ovrMs === null ? null : new Date(ovrMs);
  const bounds = [secMs, ovrMs, windowMs].filter((x): x is number => x !== null);
  const combined = bounds.length === 0 ? null : new Date(Math.min(...bounds));

  return { section, overall, combined };
}

// ══════════════════════════════════════════════════════════════════
// TIMING TELEMETRY  (master plan Phase 3b)
//
// The resolver runs alongside the existing inline logic and REPORTS. It does
// not decide anything yet — that is Phase 3c, and it happens only once these
// logs show the two agreeing on real traffic.
//
// This is the cheapest possible way to answer the question 3b exists to ask:
// "would the resolver have done the same thing?" Running it in shadow costs a
// few array scans on a doc already in memory, and answers it against real
// students rather than generated states.
// ══════════════════════════════════════════════════════════════════

/** Map a stored assessment onto the core's plain input shape. */
/**
 * The exam contract a given attempt is sitting under. (A-05 / A-06.)
 *
 * WHAT WENT WRONG. `securityLockedAt` freezes exactly seven fields —
 * securityTier, deliveryMode, requireCamera, allowMobile,
 * requireExtensionCheck, autoResume and the stamp itself (firestore.rules:571).
 * `sections`, `questions` and every timing field are not among them, while
 * grading marked against normalizeSections(THE LIVE DOC) and computeAttemptLocks
 * read timeLimit / overallTimeLimit / the grace knobs from the LIVE DOC on every
 * recompute.
 *
 * So an ordinary staff edit to a running exam reached students already sitting
 * it. Two measured failures:
 *
 *   A-05  The builder re-draws rule-based sections AT RANDOM on every save with
 *         status 'active' (DetailsStep -> resolveQuestionsForSections). A
 *         student who had answered every question correctly scored 30/40: their
 *         correct answer to a question the re-draw had removed was discarded,
 *         and a question they were never shown was counted as a blank.
 *   A-06  Editing overallTimeLimit from 120 to 20 moved a live student's
 *         deadline 100 minutes earlier, retroactively, and flipped their
 *         verdict to 'ended'.
 *
 * THE FIX IS TO FREEZE, NOT TO FORBID. Locking the fields in the rules would
 * also block legitimate repairs to an exam nobody has started yet, and would
 * not help the attempts already running. Freezing the contract onto the attempt
 * is the pattern this codebase already uses twice — `securityConfig` and
 * `gradingConfig` are both snapshotted at startExam for exactly this reason —
 * so this extends it to the two things that were left reading live.
 *
 * WHAT IS DELIBERATELY NOT FROZEN: startDate and endDate. The availability
 * window is the institution's outer wall, not one of the student's clocks (A10,
 * and the reason resolve() races it against real time while every other
 * deadline pauses). Staff closing an exam early or extending it is an
 * admissions decision that must keep working, so the merge below lets those —
 * and everything else the snapshot does not name, such as passingScore and the
 * review audiences, which regradeAttempts exists to re-apply — come from the
 * live document.
 *
 * LEGACY ATTEMPTS carry no snapshot and fall through to the live document,
 * which is exactly today's behaviour. Nothing in flight changes on deploy.
 */
function examContractFor(
  attempt: Record<string, unknown>,
  liveAssessment: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const snap = (attempt as { examSnapshot?: { sections?: unknown } }).examSnapshot;
  if (!snap || !Array.isArray(snap.sections)) return liveAssessment;
  // Frozen paper + frozen timing OVER the live doc, so fields the snapshot
  // deliberately omits still track the assessment.
  return { ...(liveAssessment ?? {}), ...(snap as Record<string, unknown>) };
}

/**
 * Build the frozen contract, at startExam, from the sections actually played.
 *
 * `ordered` is the per-student play order after any shuffle, so the snapshot
 * records the paper THIS student was given — not the builder's list. Marks and
 * order ride along because grading needs them; timeLimit, questionTimeLimit and
 * breakAfter because the clocks do.
 */
function buildExamSnapshot(
  a: Record<string, unknown>,
  ordered: EffectiveSection[],
): Record<string, unknown> {
  const rawSections = (a.sections ?? []) as Array<{
    id: string; timeLimit?: number; breakAfter?: BreakCfg;
  }>;
  const rawById = new Map(rawSections.map((s) => [s.id, s]));
  return {
    sections: ordered.map((s) => stripUndefined({
      id: s.id,
      name: s.name,
      questions: s.questions.map((q) => stripUndefined({
        questionId: q.questionId, marks: q.marks, order: q.order,
      })),
      timeLimit: rawById.get(s.id)?.timeLimit,
      questionTimeLimit: s.questionTimeLimit,
      breakAfter: rawById.get(s.id)?.breakAfter,
    })),
    ...stripUndefined({
      overallTimeLimit: a.overallTimeLimit as number | undefined,
      overallGraceSeconds: a.overallGraceSeconds as number | undefined,
      sectionGraceSeconds: a.sectionGraceSeconds as number | undefined,
      questionGraceSeconds: a.questionGraceSeconds as number | undefined,
      sectionStartOrder: a.sectionStartOrder as string | undefined,
      deliveryMode: a.deliveryMode as string | undefined,
    }),
  };
}

function toCoreAssessment(raw: Record<string, unknown>): CoreAssessment {
  const doc = raw as GradingAssessmentDoc & {
    startDate?: string; endDate?: string;
    overallTimeLimit?: number; overallGraceSeconds?: number;
    sectionGraceSeconds?: number; questionGraceSeconds?: number;
    sectionStartOrder?: 'sequential' | 'random' | 'student_choice';
    deliveryMode?: 'standard' | 'linear' | 'adaptive';
  };
  // normalizeSections gives the same question sets grading uses; the raw
  // sections carry timeLimit and breakAfter, which its return type drops —
  // hence reading them off the untyped record rather than the narrowed doc.
  const eff = normalizeSections(doc);
  const rawSections = (raw.sections ?? []) as Array<{
    id: string; timeLimit?: number; breakAfter?: BreakCfg;
  }>;
  const rawById = new Map(rawSections.map((s) => [s.id, s]));
  return {
    startDate: doc.startDate,
    endDate: doc.endDate,
    overallTimeLimit: doc.overallTimeLimit,
    overallGraceSeconds: doc.overallGraceSeconds,
    sectionGraceSeconds: doc.sectionGraceSeconds,
    questionGraceSeconds: doc.questionGraceSeconds,
    sectionStartOrder: doc.sectionStartOrder,
    deliveryMode: doc.deliveryMode,
    sections: eff.map((s) => ({
      id: s.id,
      timeLimit: rawById.get(s.id)?.timeLimit,
      questionTimeLimit: s.questionTimeLimit,
      breakAfter: rawById.get(s.id)?.breakAfter as CoreAssessment['sections'][number]['breakAfter'],
      questionIds: s.questions.map((q) => q.questionId),
    })),
  };
}

/**
 * Map a stored attempt onto the core's plain input shape.
 *
 * THIS MAPPER IS THE RESOLVER'S ENTIRE VIEW OF THE WORLD. A field missing here
 * is not missing in one place — it is invisible in every place at once, because
 * every caller that reasons about timing goes through it: getExamVerdict,
 * submitSection's deadline gate, the expiry sweep, gradeAttempt's trapped-frozen
 * check, and every computeAttemptLocks call site.
 *
 * A-01: `penalties` was absent, and the consequences were exactly that broad.
 * penaltyForClock() reads `a.penalties`, found undefined, and returned 0 — so a
 * deduction an invigilator had recorded, with an actor and an instant, was
 * invisible to the student's own screen and was REFUNDED IN FULL the next time
 * anything recomputed the locks. Ordinary progress undid it: submitSection's
 * advance branch re-derives answersLockedAfter from this shape, so pressing
 * "next section" restored the time somebody had deliberately taken away.
 *
 * It looked correct under test because closeFreezeUpdates is the one site that
 * reattaches penalties by hand (see `penalisedAttempt` there) — so the freeze
 * suite's "penalties reach the write gate" check passed on the instant of
 * unfreeze and nothing exercised the instant after.
 *
 * No invariant caught it either, and that is worth stating: INV-3a forbids the
 * overall bound moving EARLIER without a ledger row behind it. A refund moves it
 * LATER, which is the direction the whole module is built to treat as safe.
 */
function toCoreAttempt(raw: Record<string, unknown>): CoreAttempt {
  const d = raw as Record<string, any>;
  return {
    status: d.status,
    startedAt: d.startedAt,
    sectionIds: Array.isArray(d.sectionIds) ? d.sectionIds : [],
    currentSectionIdx: d.currentSectionIdx,
    sectionTimings: d.sectionTimings ?? {},
    servedQuestions: d.servedQuestions ?? [],
    answers: d.answers ?? {},
    creditedFreezeMs: d.creditedFreezeMs,
    totalFrozenSeconds: d.totalFrozenSeconds,
    freezes: d.freezes,
    // A-01. Kept adjacent to `freezes` on purpose: credit and deduction are the
    // two halves of one ledger, and they must travel together or the arithmetic
    // is one-sided in the student's favour.
    penalties: Array.isArray(d.penalties) ? d.penalties : undefined,
    scores: d.scores,
    gradedAnswers: d.gradedAnswers,
    answersLockedAfter: d.answersLockedAfter,
    sectionLockedAfter: d.sectionLockedAfter,
    overallLockedAfter: d.overallLockedAfter,
    activeSessionId: d.activeSessionId,
  };
}

/**
 * Run the resolver and the invariant checker in shadow, and log anything
 * surprising. Never throws — a telemetry fault must not cost a student their
 * exam, which is the whole reason this phase reports rather than decides.
 */
/**
 * Append a newly served question, locking everything already served.
 * (D-23, master plan Phase 3b.)
 *
 * INV-2: at most one served question is unlocked at any moment.
 *
 * BOTH serve sites — startSection and submitSection — used to do
 * `[...served, {locked: false}]`, leaving the outgoing section's current
 * question unlocked forever. Every linear/adaptive multi-section attempt
 * therefore accumulated one stranded question per boundary. The Phase 3b
 * shadow reported it as INV-2 on every advance of a real sitting.
 *
 * Fixing only submitSection left startSection producing the same state, which
 * is exactly why this is now ONE function rather than two similar blocks: two
 * copies of a rule is how the rule ends up applied in one place and not the
 * other.
 *
 * Benign in itself — a stranded question sits in a closed section and cannot
 * be answered — but it is wrong state, and anything identifying "the live
 * question" by lock status gets a second answer it should never see.
 */
function appendServedQuestion<T extends { locked?: boolean }>(
  served: T[],
  entry: T,
): T[] {
  return [
    ...served.map((sq) => (sq.locked === true ? sq : { ...sq, locked: true })),
    entry,
  ];
}

function auditTiming(
  where: string,
  attemptId: string,
  attemptRaw: Record<string, unknown>,
  assessmentRaw: Record<string, unknown> | undefined,
  /**
   * What the callable decided, as the set of verdicts that would agree with
   * it. A set rather than a string because some inline decisions are
   * genuinely ambiguous: `pauseBeforeNext` is client-supplied and covers BOTH
   * "there is a break here" and "this exam lets you pick the next section", so
   * insisting on one verdict reported a disagreement that was mine, not the
   * resolver's.
   */
  decided: string[],
  /**
   * State the callable is ABOUT to write, applied before resolving.
   *
   * Without this the comparison is unfair and useless. submitSection decides
   * "what happens now this section is submitted", but the attempt it holds in
   * memory still shows that section OPEN — so the resolver answers a different
   * question ("where is the student right now?") and reports a disagreement on
   * every single submit. The first real sitting produced exactly that:
   *     verdict=question decided=break
   * which was my instrumentation being wrong, not the resolver.
   */
  project?: (a: CoreAttempt) => CoreAttempt,
): void {
  if (!assessmentRaw) return;
  try {
    const a0 = toCoreAttempt(attemptRaw);
    const a = project ? project(a0) : a0;
    const asmt = toCoreAssessment(examContractFor(attemptRaw, assessmentRaw) ?? assessmentRaw);
    const verdict = resolveTiming(a, asmt, Date.now());

    if (!decided.includes(verdict.kind)) {
      console.log(`[timing/${where}] verdict=${verdict.kind}` +
        (verdict.kind === 'ended' ? `:${verdict.reason}` : '') +
        ` decided=${decided.join('|')} attempt=${attemptId}`);
    }

    // Invariants are checked against the STORED state, never the projection —
    // the point is to detect what is really in the database.
    const errs = checkTimingInvariants(a0, asmt).filter((v) => v.severity === 'error');
    if (errs.length > 0) {
      console.error(`[timing/${where}] INVARIANT VIOLATION attempt=${attemptId} ` +
        errs.map((e) => `${e.id}(${e.message})`).join('; '));
    }
  } catch (e) {
    console.warn(`[timing/${where}] shadow audit failed`, e);
  }
}

/**
 * auditTiming against COMMITTED state, re-read from the store (M5, audit
 * 2026-08-06).
 *
 * The sibling above takes documents the caller already holds, which is right
 * for the callables that hold a plain post-write projection. The freeze pair
 * cannot use it: openFreezeUpdates returns `freezes: FieldValue.arrayUnion(…)`,
 * so spreading its patch over the in-memory attempt puts a SENTINEL where the
 * ledger should be and the resolver reads garbage. Rebuilding the merged
 * ledger here instead would duplicate openFreezeUpdates' logic in a second
 * place that has to stay in step with it — the exact drift this file warns
 * about repeatedly.
 *
 * Re-reading sidesteps both, and is a better fit besides. auditTiming's own
 * rule is that invariants are checked against stored state, "the point is to
 * detect what is really in the database" — after a commit, that is precisely
 * what a re-read returns and what a projection only approximates.
 *
 * Two extra reads, paid only on freeze and unfreeze: rare, staff-initiated,
 * and already doing a transaction plus an audit-row write. Not a cost worth
 * carrying on an answer-submission path, which is why the frequent callables
 * use the in-memory sibling.
 *
 * Fails soft and awaits nothing the caller needs — a broken shadow audit must
 * never fail a freeze.
 */
async function auditTimingFromStore(
  db: FirebaseFirestore.Firestore,
  where: string,
  attemptId: string,
  decided: string[],
): Promise<void> {
  try {
    const aSnap = await db.collection('attempts').doc(attemptId).get();
    if (!aSnap.exists) return;
    const attemptRaw = aSnap.data() as Record<string, unknown>;
    const assessmentId = attemptRaw.assessmentId as string | undefined;
    if (!assessmentId) return;
    const asmtSnap = await db.collection('assessments').doc(assessmentId).get();
    if (!asmtSnap.exists) return;
    auditTiming(where, attemptId, attemptRaw, asmtSnap.data() as Record<string, unknown>, decided);
  } catch (e) {
    console.warn(`[timing/${where}] shadow audit (from store) failed`, e);
  }
}

type AttemptLocks = ReturnType<typeof computeAttemptLocks>;

/**
 * Write all three lock fields onto an update payload. (Master plan D-01,
 * Phase 1 — 2026-08-01.)
 *
 * WHY THIS EXISTS AS A HELPER RATHER THAN THREE INLINE LINES
 * The three fields are one fact expressed three ways: `combined` is the
 * minimum of the other two, and firestore.rules gates on `combined` while the
 * client reads the split pair to tell WHICH clock ran out. Writing any of them
 * without the others produces an attempt whose stored lock disagrees with
 * itself — and the failure mode is silent, because the rules keep working
 * against a stale minimum while the client renders a fresh section timer.
 *
 * Every site that changes a lock input therefore calls this, never assigns the
 * fields directly. Doctrine D5: the materialised lock is a CACHE, and every
 * event that changes an input must recompute it.
 */
/**
 * Materialise per-clock freeze credit onto the attempt (D-35).
 *
 * The companion to applyLockUpdates, and called from the same places for the
 * same reason: these are a CACHE of the freeze ledger, and every event that
 * changes the ledger must recompute them (doctrine D5).
 *
 * The client reads these four numbers instead of dividing one flat total
 * across every clock. It performs no credit arithmetic of its own, so it
 * cannot disagree with the write gate about how much time a pause was worth.
 */
function applyCreditUpdates(
  updates: Record<string, unknown>,
  a: CoreAttempt,
  anchors?: Parameters<typeof computeFreezeCredits>[1],
): void {
  updates.freezeCredits = computeFreezeCredits(a, anchors);
}

function applyLockUpdates(
  updates: Record<string, unknown>,
  locks: AttemptLocks,
): void {
  // Null (not undefined, not omitted) when a bound does not exist: the rules
  // read a missing/null lock as "no time constraint", which is what keeps
  // untimed exams working. Omitting the key would leave the PREVIOUS section's
  // value in place, which is the D-01 bug in miniature.
  updates.answersLockedAfter = locks.combined ? Timestamp.fromDate(locks.combined) : null;
  updates.sectionLockedAfter = locks.section ? Timestamp.fromDate(locks.section) : null;
  updates.overallLockedAfter = locks.overall ? Timestamp.fromDate(locks.overall) : null;
}

/**
 * Read a stored lock as epoch millis, whatever shape it arrived in.
 *
 * Locks are written as Firestore Timestamps, but attempts predating the field
 * carry nothing and some legacy paths wrote ISO strings. Callers treat null as
 * "no bound", never as "expired" — a missing deadline is missing information,
 * not permission to close someone's exam.
 */
function lockInstantMs(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    const t = Date.parse(raw);
    return Number.isNaN(t) ? null : t;
  }
  const maybe = raw as { toMillis?: () => number };
  if (typeof maybe?.toMillis === 'function') {
    const ms = maybe.toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** Has this attempt's answer-write window closed? Null lock = never. */
function attemptWindowClosed(
  attempt: { answersLockedAfter?: unknown },
  nowMs: number = Date.now(),
): boolean {
  const ms = lockInstantMs(attempt.answersLockedAfter);
  return ms !== null && nowMs >= ms;
}

/**
 * Reject a call coming from a browser session that no longer owns this
 * attempt. (INV-5a, master plan Phase 2 / D-08.)
 *
 * WHAT THIS DOES AND DOES NOT CLOSE — read before relying on it.
 *
 * `activeSessionId` existed only as a writable field on the student rules
 * whitelist. No rule and no callable ever compared it, so two browsers signed
 * in as the same student could both drive one attempt indefinitely; the
 * conflict overlay was client-side decoration.
 *
 * Enforcing it HERE makes every state transition single-session: a superseded
 * device cannot start a section, submit one, advance a question, or finalise.
 * In linear/adaptive that is complete, because answers only ever move through
 * submitAnswerAndAdvance.
 *
 * In STANDARD delivery answers are written directly by the client under
 * firestore.rules, and rules cannot enforce this — a second device can read
 * the attempt (students may read their own) and echo back whatever
 * `activeSessionId` it finds, so any rules-level check is trivially defeated.
 * The residual gap is therefore "a superseded device can keep autosaving
 * answers but can never advance or submit". Closing it fully needs answers to
 * move through a callable in standard mode too, which is a Phase 3 decision.
 *
 * A caller that supplies NO sessionId is allowed through: during the rollout
 * a cached client predates the field, and locking those students out of their
 * own exam would be a far worse failure than the hole this closes. Flip
 * REQUIRE_SESSION_ID once no such client remains.
 */
const REQUIRE_SESSION_ID = false;

function assertSession(
  attempt: { activeSessionId?: string | null },
  supplied: string | undefined,
  where: string,
): void {
  const active = attempt.activeSessionId;
  if (!active) return;                       // nobody has claimed it yet
  if (!supplied) {
    if (REQUIRE_SESSION_ID) {
      throw new HttpsError('failed-precondition',
        'SESSION_REQUIRED: reload the exam to continue.');
    }
    console.warn(`[${where}] legacy client sent no sessionId`);
    return;
  }
  if (supplied !== active) {
    throw new HttpsError(
      'failed-precondition',
      'SESSION_SUPERSEDED: this exam was opened on another device.',
    );
  }
}

/**
 * Refuse an exam action by a student blocked from this assessment.
 * (D-21, master plan Phase 2.)
 *
 * `blockedStudents` was re-checked in getExamQuestions and startExam only, so
 * blocking someone mid-sitting stopped a reload but not the sitting: they
 * carried on answering, advancing and submitting normally. "Block" therefore
 * meant two different things depending on whether the target happened to
 * refresh.
 *
 * OPEN DECISION (plan item N5): this makes a block stop every TRANSITION —
 * the student cannot advance a section, submit one, or advance a question —
 * but it deliberately does NOT finalise their attempt. Ending someone's exam
 * from an invigilator's click is a policy choice, not a bug fix, and it is
 * still awaiting a decision. Until then the honest behaviour is a distinct,
 * surfaceable error rather than a silent refusal (doctrine D7).
 *
 * Takes the already-loaded assessment data — every caller has it in hand, so
 * this costs no extra read.
 */
function assertNotBlocked(
  assessment: { blockedStudents?: string[] } | undefined,
  studentId: string,
): void {
  if ((assessment?.blockedStudents ?? []).includes(studentId)) {
    throw new HttpsError(
      'permission-denied',
      'BLOCKED_FROM_EXAM: an invigilator has blocked you from this exam.',
    );
  }
}

export const startSection = onCall<StartSectionData>(
  EXAM_HOT_PATH,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const role = request.auth.token.role as string | undefined;
    const studentId = request.auth.token.studentId as string | undefined;
    if (role !== 'student' || !studentId) {
      throw new HttpsError('permission-denied', 'Only students may start a section.');
    }
    const { attemptId, sectionId, reorderedSectionIds } = request.data || ({} as StartSectionData);
    if (!attemptId || !sectionId) {
      throw new HttpsError('invalid-argument', 'attemptId and sectionId are required.');
    }

    const db = getFirestore();
    const attemptRef = db.collection('attempts').doc(attemptId);
    const attemptSnap = await attemptRef.get();
    if (!attemptSnap.exists) throw new HttpsError('not-found', 'Attempt not found.');
    const attempt = attemptSnap.data() as {
      studentId: string;
      status: string;
      assessmentId: string;
      sectionIds: string[];
      sectionTimings: Record<string, AttemptSectionTiming>;
      // Wall-clock start of the whole sitting — the overall-clock anchor, and
      // one of the two bounds computeAttemptLocks needs.
      startedAt?: string;
      // Phase 2.5 — needed to serve the section's first question in linear mode
      questionOrder?: Record<string, string[]>;
      servedQuestions?: Array<{
        questionId: string; sectionId: string; difficulty: string;
        servedAt: string; locked: boolean;
      }>;
      securityConfig?: { deliveryMode?: string; requireSEB?: boolean } | null;
      activeSessionId?: string | null;
    };
    if (attempt.studentId !== studentId) {
      throw new HttpsError('permission-denied', 'Not your attempt.');
    }
    assertSession(attempt, request.data?.sessionId, 'startSection');
    assertSEB(request.data?.sebToken, request.auth.uid, attempt.securityConfig?.requireSEB, attempt.assessmentId);
    if (attempt.status !== 'in_progress') {
      throw new HttpsError('failed-precondition', 'Attempt is not in progress.');
    }
    if (attempt.sectionTimings[sectionId]?.startedAt) {
      throw new HttpsError('failed-precondition', 'Section already started.');
    }

    // ── F-01: the section must BE one of this attempt's (audit 2026-08-09) ──
    //
    // submitSection has validated its advance target against the played set
    // since A-02 (:9738). This callable performs the SAME transition and never
    // acquired the check: it took `sectionIds.indexOf(sectionId)` below and
    // tolerated -1, so any string at all got a sectionTimings row.
    //
    // The stray row was never the damage. The lock recompute further down
    // resolves the section's time limit by id against the frozen contract —
    // and a section the contract has never heard of has no limit, so
    // sectionDeadlineMs returns null, the section bound drops out of
    // answersLockedAfter, and what firestore.rules enforces collapses to
    // min(overall, availability window). Measured on a perfectly ordinary
    // paper — 30-minute sections, no overall cap, a week-long window — the
    // answer-write deadline moved from +30:30 to +7 DAYS on one call.
    //
    // It was also the third route past a mandatory break, after the two D-22
    // closed. submitSection resolves breaks positionally from
    // sectionIds.indexOf (:9693), which is -1 for a section nobody authored,
    // so breakDue came back null and the advance ran with the break unserved.
    // Both fall to this one guard, which is why it is here and not in the
    // break gate: the gate was never wrong, it was asked about a section that
    // should not have existed.
    //
    // STRICT, deliberately, unlike its sibling in submitSection. This function
    // already cannot run without a played set — `sectionIds.indexOf` below is
    // called on `attempt.sectionIds` directly and throws a TypeError if it is
    // absent, so an attempt with no sectionIds 500'd here already. Refusing it
    // by name turns a stack trace into an answer.
    const playedSectionIds = Array.isArray(attempt.sectionIds) ? attempt.sectionIds : [];
    if (!playedSectionIds.includes(sectionId)) {
      throw new HttpsError(
        'invalid-argument',
        'SECTION_START_INVALID: that section is not part of this attempt.',
      );
    }

    // ── INV-1: exactly one section open at a time (D-22, Phase 2) ──
    //
    // This callable only ever checked whether the TARGET section had been
    // started. It never checked whether the section the student is CURRENTLY
    // in has been closed, so starting C while B was still open left two
    // sections with a startedAt and no submittedAt — two clocks running, and
    // in linear/adaptive a second UNLOCKED served question that
    // submitAnswerAndAdvance can never reach (it resolves the current question
    // positionally, as served[served.length - 1]), so that question became
    // silently unanswerable.
    //
    // It was also a mandatory-break bypass. The break gate below reads
    // `prevTiming?.submittedAt`, so a section that is simply never submitted
    // makes the gate evaluate to nothing at all. Enforcing INV-1 closes that
    // route at its source rather than patching the gate.
    const openSectionId = Object.entries(attempt.sectionTimings ?? {})
      .find(([, t]) => t?.startedAt && !t?.submittedAt)?.[0];
    if (openSectionId && openSectionId !== sectionId) {
      throw new HttpsError(
        'failed-precondition',
        'SECTION_STILL_OPEN: finish the section you are in before starting another.',
      );
    }

    // Validate reorder (student_choice) is a permutation of the frozen ids.
    let sectionIds = attempt.sectionIds;
    if (reorderedSectionIds) {
      const same = reorderedSectionIds.length === sectionIds.length
        && [...reorderedSectionIds].sort().join('|') === [...sectionIds].sort().join('|');
      if (!same) throw new HttpsError('invalid-argument', 'Invalid section reorder.');

      // ── Played sections are pinned (D-22, second route) ─────────
      // A permutation check alone let a caller move an UNPLAYED section to
      // index 0. The break gate below is guarded on `idx > 0`, so landing at
      // index 0 skipped it entirely — a mandatory break bypass that survived
      // the INV-1 check above, because no section was open at the time.
      //
      // Sections that have already been started keep their index; only
      // unplayed ones may move. That is exactly what "choose your next
      // section" means, and it makes the play position of any new section
      // necessarily greater than the number already played.
      for (let i = 0; i < sectionIds.length; i++) {
        const played = attempt.sectionTimings[sectionIds[i]]?.startedAt;
        if (played && reorderedSectionIds[i] !== sectionIds[i]) {
          throw new HttpsError(
            'invalid-argument',
            'Invalid section reorder: completed sections cannot be moved.',
          );
        }
      }
      sectionIds = reorderedSectionIds;
    }

    // Mandatory-break gate (POSITIONAL): starting the section at play index
    // `idx` means `idx` sections are already completed, so the applicable
    // break is the one after the idx-th completion — resolved by builder-
    // order position via breakAfterCompletion, NOT by which section happened
    // to be played (random shuffles / student picks make identity meaningless
    // for scheduling). Deny if that break is mandatory and hasn't elapsed
    // since the previous play-order section's submit.
    const idx = sectionIds.indexOf(sectionId);
    if (idx > 0) {
      const prevId = sectionIds[idx - 1];
      const prevTiming = attempt.sectionTimings[prevId];
      if (prevTiming?.submittedAt) {
        const aSnap = await db.collection('assessments').doc(attempt.assessmentId).get();
        // A-06: break schedule comes from the frozen contract too — a break
        // added or removed mid-sitting must not reach a student already in it.
        const a = examContractFor(
          attempt as unknown as Record<string, unknown>, aSnap.data(),
        ) as { sections?: Array<{ id: string; breakAfter?: BreakCfg }> } | undefined;
        const brk = breakAfterCompletion(a?.sections, attempt.sectionIds, idx);
        if (brk && brk.mandatory) {
          // ── A break is a clock, and it is credited too (F6 / D-29) ──
          //
          // This was `submittedAt + durationMinutes`, full stop. D-29 added a
          // credit term to the break deadline in the RESOLVER and this gate —
          // the other place that decides when a break ends — was never
          // updated. Freeze a student for six minutes during a ten-minute
          // mandatory break and getExamVerdict held them until +16 while this
          // let them in at +10: the screen said "on a break" and the server
          // said "come in".
          //
          // creditForAnchor on the submit instant, which is when the break
          // began, so only pauses that started after it count — the same
          // per-clock rule every other deadline uses.
          const anchorIso = prevTiming.submittedAt;
          const breakEndsAt = new Date(anchorIso).getTime()
            + brk.durationMinutes * 60_000
            + creditForAnchor(toCoreAttempt(attempt as unknown as Record<string, unknown>), anchorIso);
          if (Date.now() < breakEndsAt) {
            throw new HttpsError('failed-precondition', 'Mandatory break has not ended yet.');
          }
        }
      }
    }

    const nowIso = new Date().toISOString();

    // Recompute the answer-write lock for the section being entered (audit
    // 2026-07-28). Read here rather than reusing the conditional read above,
    // which only happens on the mandatory-break path and fetches a narrower
    // shape. One extra document read per section start is a fair price for the
    // rule that stops a student answering after their time is gone.
    const lockSnap = await db.collection('assessments').doc(attempt.assessmentId).get();
    // A-06: timing comes from the contract this attempt is sitting under, so a
    // live edit to timeLimit / overallTimeLimit / grace cannot move the
    // deadline of a student already inside the exam. blockedStudents is
    // deliberately live — a block is an invigilation decision taken NOW, and
    // the snapshot does not carry it, so it arrives through the merge.
    const lockA = (examContractFor(
      attempt as unknown as Record<string, unknown>, lockSnap.data(),
    ) ?? {}) as {
      sections?: Array<{ id: string; timeLimit?: number }>;
      sectionGraceSeconds?: number;
      overallTimeLimit?: number;
      overallGraceSeconds?: number;
      blockedStudents?: string[];
    };
    // D-21: reuses the read this line already performs — no extra cost.
    assertNotBlocked(lockA, studentId);
    // Phase 3b shadow — the resolver's view of a section that is starting.
    auditTiming('startSection', attemptId,
      attempt as unknown as Record<string, unknown>, lockSnap.data(),
      // 'break' belongs here: startSection is exactly how a student LEAVES a
      // break, and the gate above only blocks MANDATORY ones — so skipping an
      // optional break is legal, and the resolver reporting "on a break" at
      // that instant is correct rather than a disagreement.
      ['section', 'question', 'break']);

    const locks = computeAttemptLocks(
      attempt.startedAt,
      nowIso,
      lockA.sections?.find((s) => s.id === sectionId)?.timeLimit,
      lockA,
      toCoreAttempt(attempt as unknown as Record<string, unknown>),
    );

    const updates: Record<string, unknown> = {
      currentSectionIdx: idx,
      [`sectionTimings.${sectionId}.startedAt`]: nowIso,
      [`sectionTimings.${sectionId}.timeUsedSeconds`]: 0,
      // Null when the exam has no timed bound at all — the rule treats a
      // missing/null lock as "no time constraint", which is also what keeps
      // untimed exams working.
      // D-35: credit for the section being entered — 0 by arithmetic, since no
      // freeze can have begun after an anchor of `now`.
      freezeCredits: computeFreezeCredits(
        toCoreAttempt(attempt as unknown as Record<string, unknown>),
        { sectionStartedAt: nowIso, questionServedAt: nowIso, breakAnchor: nowIso },
      ),
      answersLockedAfter: locks.combined ? Timestamp.fromDate(locks.combined) : null,
      // Split bounds (Phase 0). Recomputed on every section entry: the section
      // bound moves with the new section, the overall bound does not move at
      // all, but writing both together keeps the three fields consistent by
      // construction rather than by remembering to update them separately.
      sectionLockedAfter: locks.section ? Timestamp.fromDate(locks.section) : null,
      overallLockedAfter: locks.overall ? Timestamp.fromDate(locks.overall) : null,
      updatedAt: nowIso,
    };

    // ── Serve the section's first question (Phase 2.5, linear/adaptive) ──
    // In sequential delivery the client holds nothing until the server serves.
    // The question CONTENT is returned in the response — the client cannot
    // fetch it any other way (getExamQuestions is scoped to servedQuestions,
    // and it was already called before this section existed).
    // Idempotent: if a question from this section was already served (e.g. a
    // retried call), don't append a duplicate.
    const dMode = attempt.securityConfig?.deliveryMode ?? 'standard';
    let servedQuestion: ReturnType<typeof sanitizeQuestionForStudent> | null = null;
    if (dMode === 'linear' || dMode === 'adaptive') {
      const served = attempt.servedQuestions ?? [];
      const existingHere = served.find((s) => s.sectionId === sectionId);
      const firstQid = existingHere?.questionId ?? attempt.questionOrder?.[sectionId]?.[0];
      if (firstQid) {
        const qSnap = await db.collection('questions').doc(firstQid).get();
        if (qSnap.exists) {
          const qData = qSnap.data() as Record<string, unknown>;
          servedQuestion = sanitizeQuestionForStudent(qData, false);
          if (!existingHere) {
            // D-23: same rule as submitSection. Fixing one and not the other
            // is what left INV-2 still firing after the first attempt at this.
            updates.servedQuestions = appendServedQuestion(served, {
              questionId: firstQid,
              sectionId,
              difficulty: (qData.difficulty as string) ?? 'medium',
              servedAt: nowIso,
              locked: false,
            });
          }
        }
      }
    }

    if (reorderedSectionIds) updates.sectionIds = sectionIds;
    await attemptRef.update(updates);
    return { ok: true, startedAt: nowIso, sectionIds, question: servedQuestion };
  },
);

interface SubmitSectionData {
  attemptId: string;
  /** Phase 2 — the browser session driving this sitting (INV-5a). */
  sessionId?: string;
  sectionId: string;
  nextSectionId?: string | null;
  /**
   * IGNORED as of A-02. Still ACCEPTED so a cached client keeps working and a
   * rollback is clean, but nothing reads it: the play index is derived from
   * `sectionIds.indexOf(nextSectionId)` server-side. A caller-supplied index
   * was written straight to `currentSectionIdx`, which is state nobody
   * authored. Remove the field once no client sends it.
   */
  nextSectionIdx?: number;
  pauseBeforeNext?: boolean;
  sebToken?: string;
}

// ── submitSection ─────────────────────────────────────────────────
// Server-authoritative section close. Rejects submits arriving past
// startedAt + timeLimit + grace (per-assessment sectionGraceSeconds,
// default 30 s). timeUsedSeconds is computed server-side. When advancing
// with no break/pick, starts the next section's timer atomically.
export const submitSection = onCall<SubmitSectionData>(
  EXAM_HOT_PATH,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const role = request.auth.token.role as string | undefined;
    const studentId = request.auth.token.studentId as string | undefined;
    if (role !== 'student' || !studentId) {
      throw new HttpsError('permission-denied', 'Only students may submit a section.');
    }
    // nextSectionIdx is deliberately NOT destructured — see the interface.
    const { attemptId, sectionId, nextSectionId, pauseBeforeNext } =
      request.data || ({} as SubmitSectionData);
    if (!attemptId || !sectionId) {
      throw new HttpsError('invalid-argument', 'attemptId and sectionId are required.');
    }

    const db = getFirestore();
    const attemptRef = db.collection('attempts').doc(attemptId);
    const attemptSnap = await attemptRef.get();
    if (!attemptSnap.exists) throw new HttpsError('not-found', 'Attempt not found.');
    const attempt = attemptSnap.data() as {
      studentId: string;
      status: string;
      assessmentId: string;
      startedAt?: string;      // wall-clock start of the whole sitting — overall-clock anchor
      sectionIds?: string[];   // frozen play order — used for positional break resolution
      sectionTimings: Record<string, AttemptSectionTiming>;
      // Phase 2.5 — serve the next section's first question on advance
      questionOrder?: Record<string, string[]>;
      servedQuestions?: Array<{
        questionId: string; sectionId: string; difficulty: string;
        servedAt: string; locked: boolean;
      }>;
      securityConfig?: { deliveryMode?: string; requireSEB?: boolean } | null;
      activeSessionId?: string | null;
    };
    if (attempt.studentId !== studentId) {
      throw new HttpsError('permission-denied', 'Not your attempt.');
    }
    assertSession(attempt, request.data?.sessionId, 'submitSection');
    if (attempt.status !== 'in_progress') {
      throw new HttpsError('failed-precondition', 'Attempt is not in progress.');
    }
    assertSEB(request.data?.sebToken, request.auth.uid, attempt.securityConfig?.requireSEB, attempt.assessmentId);

    // ── F-02: the section being CLOSED is checked too (audit 2026-08-09) ──
    //
    // A-02 validated `nextSectionId` and left `sectionId` resting on "it has a
    // timing row". With startSection fixed above, a row for a section outside
    // the attempt can no longer be created, so this is unreachable today —
    // which is exactly the point at which to state it. The break schedule
    // below is resolved from `sectionIds.indexOf(sectionId)`, and a -1 there
    // silently means "no break is due"; a defect that makes the answer to
    // "which break applies?" be *nothing* should not depend on another
    // function's guard holding. Two callables, two ids, one rule.
    //
    // LENIENT when the attempt carries no played set, unlike startSection.
    // This function works today without `sectionIds` — the timing row is
    // enough — so a hard requirement would strand any hand-repaired or
    // pre-`sectionIds` attempt with no way to close a section it had genuinely
    // started. Every attempt startExam has ever written carries the field, so
    // the fallback covers nothing the guard needs to reach, and the failure
    // direction stays where doctrine puts it: unknown input never costs a
    // student their submit.
    //
    // `playedIds` is hoisted here rather than declared beside the advance check
    // below, which used to own it: both guards ask the same question of the
    // same list, and two copies of `Array.isArray(attempt.sectionIds) ? … : []`
    // in one function is how the two ends of a rule start disagreeing.
    const playedIds = Array.isArray(attempt.sectionIds) ? attempt.sectionIds : [];
    if (playedIds.length > 0 && !playedIds.includes(sectionId)) {
      throw new HttpsError(
        'invalid-argument',
        'SECTION_SUBMIT_INVALID: that section is not part of this attempt.',
      );
    }

    const timing = attempt.sectionTimings[sectionId];
    if (!timing?.startedAt) {
      throw new HttpsError('failed-precondition', 'Section was never started.');
    }

    const aSnap = await db.collection('assessments').doc(attempt.assessmentId).get();
    if (!aSnap.exists) throw new HttpsError('not-found', 'Assessment not found.');
    // A-06: one contract, used by the break schedule, both deadline gates and
    // every lock recompute below. blockedStudents rides in live through the
    // merge — see examContractFor.
    const contractRaw = examContractFor(
      attempt as unknown as Record<string, unknown>, aSnap.data(),
    ) as Record<string, unknown>;
    const a = contractRaw as {
      sectionGraceSeconds?: number;
      overallTimeLimit?: number;
      overallGraceSeconds?: number;
      sections?: Array<{ id: string; timeLimit?: number; breakAfter?: BreakCfg }>;
      blockedStudents?: string[];
    };
    // D-21: a block must stop the sitting advancing, not only a reload.
    assertNotBlocked(a, studentId);

    // ── Server-side pause decision (positional breaks) ───────────────
    // Submitting the section at play index `playIdx` completes playIdx + 1
    // sections, so the break due now is breakAfterCompletion(…, playIdx + 1).
    // When that break is MANDATORY, the server refuses to auto-start the next
    // section regardless of the client's pauseBeforeNext — a tampered client
    // can no longer skip a mandatory break by claiming no pause is needed.
    // (Skippable breaks stay client-scheduled: the student may continue
    // immediately anyway, so forcing a pause here would add nothing.)
    const playIdx = Array.isArray(attempt.sectionIds) ? attempt.sectionIds.indexOf(sectionId) : -1;
    const breakDue = playIdx >= 0
      ? breakAfterCompletion(a.sections, attempt.sectionIds, playIdx + 1)
      : null;
    const mandatoryBreakDue = !!(breakDue && breakDue.mandatory);

    // ── Which section, if any, this call may advance INTO (A-02) ─────
    //
    // `nextSectionId` and `nextSectionIdx` arrive from request.data and were
    // used verbatim: written as a dot-path key onto sectionTimings, assigned
    // straight to currentSectionIdx, and — the part that mattered — used to
    // re-anchor answersLockedAfter, which is the field firestore.rules gates
    // every answer write on.
    //
    // Naming the section being submitted was therefore a TIME EXPLOIT. The one
    // update both closed SA and re-opened it, and the lock was recomputed as
    // `now + SA's full time limit`. Measured at +30:30 → +56:00 on a single
    // call, repeatable, and unbounded on the very ordinary configuration of
    // per-section limits with no overall cap. It also rewrote the section's own
    // startedAt, which is INV-9 ("a section's start instant never moves").
    //
    // Everything below is a rule startSection has always enforced (:7941 for
    // "already started", :7960 for INV-1). This branch is the same transition
    // and simply never acquired them.
    //
    // ONE CASE IS NOT AN ATTACK AND MUST NOT THROW: a retry after a lost
    // response. The client re-sends the same submit, the next section is by
    // then legitimately started, and the desired end state is exactly what is
    // already stored. That is an idempotent no-op — the advance WRITES are
    // skipped, so nothing is re-anchored, and the call still succeeds and still
    // returns the served question. Turning a dropped response into a hard error
    // would strand a student for a network blip.
    const requestedNext = typeof nextSectionId === 'string' && nextSectionId
      ? nextSectionId : null;
    let advanceTo: string | null = null;
    let advanceIdx = -1;
    let advanceAlreadyStarted = false;
    if (requestedNext) {
      if (requestedNext === sectionId) {
        throw new HttpsError('invalid-argument',
          'SECTION_ADVANCE_INVALID: a section cannot advance into itself.');
      }
      advanceIdx = playedIds.indexOf(requestedNext);
      if (advanceIdx < 0) {
        throw new HttpsError('invalid-argument',
          'SECTION_ADVANCE_INVALID: that section is not part of this attempt.');
      }
      if (attempt.sectionTimings?.[requestedNext]?.submittedAt) {
        throw new HttpsError('invalid-argument',
          'SECTION_ADVANCE_INVALID: that section is already finished.');
      }
      advanceAlreadyStarted = !!attempt.sectionTimings?.[requestedNext]?.startedAt;
      advanceTo = requestedNext;
    }
    // currentSectionIdx is DERIVED, never taken from the caller. It is only a
    // convenience mirror of the play order — the timings are the record — but a
    // caller-set index is still state nobody authored.
    const advanceIdxSafe = advanceIdx;

    const startedMs = new Date(timing.startedAt).getTime();
    const serverNow = Date.now();
    const timeUsedSeconds = Math.max(0, Math.floor((serverNow - startedMs) / 1000));

    // ── The deadlines this call is judged against (F1) ───────────────
    //
    // These two gates used to build their own deadlines inline:
    //
    //   startedMs + sec.timeLimit * 60_000 + graceSec * 1000
    //   examStartMs + a.overallTimeLimit * 60_000 + overallGraceSec * 1000
    //
    // No freeze credit, no penalty, and compared against Date.now() rather
    // than effectiveNowMs. The note that used to sit above the overall check
    // said so in as many words — "the server ignores freeze here; credited
    // only in the client display" — which was the posture BEFORE Phase 4.3
    // credited the write gate, and it stayed here after every other path moved.
    //
    // The result was that a grant could not be spent. answersLockedAfter moved
    // out, getExamVerdict said 'section', the student's screen showed the time
    // restored — and this function threw SECTION_DEADLINE_EXCEEDED and clamped
    // submittedAt back to the pre-freeze instant. The clamp then re-anchored
    // the following break, so the damage outlived the section.
    //
    // One source now. computeDeadlines applies credit per clock (D-28) and
    // subtracts recorded penalties (A4); effectiveNowMs holds time still while
    // a freeze is open (4.3). This gate and the resolver cannot disagree,
    // because they are the same function.
    const gateCore = toCoreAttempt(attempt as unknown as Record<string, unknown>);
    const gateAsmt = toCoreAssessment(contractRaw);
    const gateDl = computeDeadlines(gateCore, gateAsmt);
    const evalNow = effectiveNowMs(gateCore, serverNow);

    // ── Overall exam deadline (hard cut) ─────────────────────────────
    // Anchored on attempt.startedAt — the wall-clock start of the whole
    // sitting — so all idle time between/inside sections and every break
    // counts against it. This is the fence that closes the "walk away
    // between sections" leak: the section clocks each run independently and
    // honestly, but nothing else stops a student from taking hours across
    // the exam. Checked BEFORE the section deadline: if the whole exam is
    // over, that verdict wins regardless of the section's own clock.
    //
    // On breach we HARD CUT — close the current section at the overall
    // deadline and refuse to advance to any next section. The client
    // finalises the attempt (gradeAttempt) on seeing this signal; whatever
    // is answered stands. Grace is the overall knob (own 30s default), the
    // single trailing buffer for network lag at the buzzer.
    //
    // Freeze posture: credited and paused, exactly like every other clock —
    // see the note on gateDl above.
    if (gateDl.overallEndsAt !== null) {
      const overallDeadlineMs = gateDl.overallEndsAt;
      if (evalNow > overallDeadlineMs) {
        // Close the current section at its true submit time (clamped to the
        // section's own deadline if that is earlier), never advancing.
        let sectionCloseMs = serverNow;
        if (gateDl.sectionEndsAt !== null) {
          sectionCloseMs = Math.min(serverNow, gateDl.sectionEndsAt);
        }
        const closeIso = new Date(sectionCloseMs).toISOString();
        const usedSec = Math.max(0, Math.floor((sectionCloseMs - startedMs) / 1000));
        await attemptRef.update({
          [`sectionTimings.${sectionId}.submittedAt`]: closeIso,
          [`sectionTimings.${sectionId}.timeUsedSeconds`]: usedSec,
          updatedAt: new Date().toISOString(),
        });
        // The client catches this and calls gradeAttempt('time_expired') to
        // finalise the whole attempt. No next section is served.
        throw new HttpsError('deadline-exceeded', 'OVERALL_DEADLINE_EXCEEDED');
      }
    }

    if (gateDl.sectionEndsAt !== null) {
      const deadlineMs = gateDl.sectionEndsAt;
      if (evalNow > deadlineMs) {
        // Strict: close the section at its true deadline (no extra credit) and
        // signal the client the submit was late. The section is finalised
        // regardless so the student cannot get stuck or gain time.
        const clampedIso = new Date(deadlineMs).toISOString();
        const cappedUsed = Math.floor((deadlineMs - startedMs) / 1000);
        const lateUpdates: Record<string, unknown> = {
          [`sectionTimings.${sectionId}.submittedAt`]: clampedIso,
          [`sectionTimings.${sectionId}.timeUsedSeconds`]: cappedUsed,
          updatedAt: new Date().toISOString(),
        };
        if (advanceTo && !advanceAlreadyStarted && !pauseBeforeNext && !mandatoryBreakDue) {
          const lateNextStartIso = new Date().toISOString();
          lateUpdates.currentSectionIdx = advanceIdxSafe;
          lateUpdates[`sectionTimings.${advanceTo}.startedAt`] = lateNextStartIso;
          lateUpdates[`sectionTimings.${advanceTo}.timeUsedSeconds`] = 0;
          // D-01: recompute the write lock for the section being ENTERED.
          // Same reasoning as the on-time branch below — see the note there.
          const lateCore = toCoreAttempt(attempt as unknown as Record<string, unknown>);
          applyLockUpdates(lateUpdates, computeAttemptLocks(
            attempt.startedAt,
            lateNextStartIso,
            a.sections?.find((s) => s.id === advanceTo)?.timeLimit,
            a,
            lateCore,
          ));
          // D-35: anchors for the section being ENTERED, so its credit is 0
          // rather than the departing section's.
          applyCreditUpdates(lateUpdates, lateCore, {
            sectionStartedAt: lateNextStartIso,
            questionServedAt: lateNextStartIso,
            breakAnchor: lateNextStartIso,
          });
        }
        await attemptRef.update(lateUpdates);
        throw new HttpsError('deadline-exceeded', 'SECTION_DEADLINE_EXCEEDED');
      }
    }

    const nowIso = new Date().toISOString();
    const updates: Record<string, unknown> = {
      [`sectionTimings.${sectionId}.submittedAt`]: nowIso,
      [`sectionTimings.${sectionId}.timeUsedSeconds`]: timeUsedSeconds,
      updatedAt: nowIso,
    };
    let nextQuestion: ReturnType<typeof sanitizeQuestionForStudent> | null = null;
    // Phase 3b shadow — what would the resolver have said about the state as
    // it stands the instant before this write? Reported, never acted on.
    auditTiming('submitSection', attemptId,
      attempt as unknown as Record<string, unknown>, aSnap.data(),
      !advanceTo ? ['ended']
        : mandatoryBreakDue ? ['break']
        // pauseBeforeNext is the client saying "stop here" — which it does for
        // a break OR for student-choice. Either verdict agrees.
        : pauseBeforeNext ? ['break', 'choose']
        : ['section', 'question'],
      // Apply the submit this call is about to make, so the resolver is asked
      // the same question the callable just answered.
      (core) => ({
        ...core,
        sectionTimings: {
          ...core.sectionTimings,
          [sectionId]: { ...core.sectionTimings?.[sectionId], submittedAt: nowIso },
        },
      }));

    if (advanceTo && !pauseBeforeNext && !mandatoryBreakDue) {
      // A-02: skipped on a retry whose advance already landed, so a lost
      // response cannot re-anchor a lock or move a section's start instant.
      if (!advanceAlreadyStarted) {
        updates.currentSectionIdx = advanceIdxSafe;
        updates[`sectionTimings.${advanceTo}.startedAt`] = nowIso;
        updates[`sectionTimings.${advanceTo}.timeUsedSeconds`] = 0;
      }

      // ── Recompute the answer-write lock (D-01, master plan Phase 1) ──
      //
      // THIS IS THE FIX FOR THE WORST BUG IN THE MODULE. Read this before
      // touching the branch.
      //
      // Only startExam and startSection used to write the lock fields. This
      // branch advances the student into the next section WITHOUT going
      // through startSection — `pauseBeforeNext` is false for sequential and
      // random order with no break, which is the ordinary case — so the
      // attempt carried the PREVIOUS section's deadline for the rest of the
      // sitting. Once that instant passed, firestore.rules
      // (answerWriteWindowOpen) denied every answer write, and the client
      // swallowed the denial: the 1.5s autosave catches to console, and the
      // final flush treats permission-denied as "the deadline doing its job".
      // Students lost everything they typed from section 2 onward, silently.
      //
      // The client cannot repair this by calling startSection afterwards —
      // that callable throws 'Section already started' against the startedAt
      // written three lines above.
      //
      // Anchored on nowIso (the instant this section actually begins), NOT on
      // the previous section's start, and the section limit is read from the
      // ASSESSMENT DOC via `a`, never from the caller's payload.
      //
      // Note the lock legitimately moves EARLIER here when a long section is
      // followed by a short one (60m section submitted at minute 2, next
      // section 10m -> lock goes 60:30 to 12:30). That is correct: the
      // combined lock is a minimum over a CHANGING active section, so it has
      // no monotonicity property. Only the per-section and overall bounds do.
      const advCore = toCoreAttempt(attempt as unknown as Record<string, unknown>);
      applyLockUpdates(updates, computeAttemptLocks(
        attempt.startedAt,
        nowIso,
        a.sections?.find((s) => s.id === advanceTo)?.timeLimit,
        a,
        advCore,
      ));
      applyCreditUpdates(updates, advCore, {
        sectionStartedAt: nowIso,
        questionServedAt: nowIso,
        breakAnchor: nowIso,
      });

      // ── Serve the next section's first question (Phase 2.5) ──────
      // This is the no-break advance path: the client goes straight from one
      // section to the next without startSection, so the question must be
      // served (and its CONTENT returned) here — the client has no other way
      // to obtain it, since getExamQuestions is scoped to servedQuestions.
      const dMode = attempt.securityConfig?.deliveryMode ?? 'standard';
      if (dMode === 'linear' || dMode === 'adaptive') {
        const served = attempt.servedQuestions ?? [];
        const existingHere = served.find((s) => s.sectionId === advanceTo);
        const firstQid = existingHere?.questionId ?? attempt.questionOrder?.[advanceTo]?.[0];
        if (firstQid) {
          const qSnap = await db.collection('questions').doc(firstQid).get();
          if (qSnap.exists) {
            const qData = qSnap.data() as Record<string, unknown>;
            nextQuestion = sanitizeQuestionForStudent(qData, false);
            if (!existingHere) {
              // ── D-23 (Phase 3b): lock what we are leaving behind ──────
              //
              // This appended the next section's question WITHOUT locking the
              // outgoing section's current one, so every linear/adaptive
              // multi-section attempt ended up with a permanently unlocked
              // question from a section the student had already left — and a
              // fresh one appended at each boundary, so the count grew.
              //
              // Found by the Phase 3b shadow, which reported INV-2 ("2
              // unlocked served questions") on every advance of a real
              // sitting, always pairing the same stranded question with a
              // rotating current one.
              //
              // Benign today: the stranded question sits in a closed section
              // and submitAnswerAndAdvance resolves the current one
              // positionally, so nothing misbehaves. It is still wrong state,
              // and anything that reasons about "which question is live" by
              // lock status — the resolver included — gets a second answer it
              // should never see. Closing it here rather than teaching every
              // reader to tolerate it.
              updates.servedQuestions = appendServedQuestion(served, {
                questionId: firstQid,
                sectionId: advanceTo,
                difficulty: (qData.difficulty as string) ?? 'medium',
                servedAt: nowIso,
                locked: false,
              });
            }
          }
        }
      }
    }
    await attemptRef.update(updates);
    // breakDue is informational for the client (the new bundle computes the
    // same positional schedule itself); it also documents why an auto-start
    // was refused when a mandatory break was due.
    return { ok: true, timeUsedSeconds, question: nextQuestion, breakDue };
  },
);
// ═══════════════════════════════════════════════════════════════════════════
// QUESTION RIGHTS — Phase 2 (permission model)
// Rights-enforced write path for institute/faculty question authoring.
// Web Owner authoring stays on the direct client path (unrestricted owner).
// These callables make the create/edit/delete RIGHT tamper-proof: the client
// UI hides buttons, but the actual write is gated here against the caller's
// server-side rights, the institute ceiling, ownership, and the tenant stamp.
// Direct mode only in Phase 2; 'request' mode is stored but its approval
// workflow is Phase 3, so a request-mode grant is treated as "not permitted"
// for direct execution here.
// ═══════════════════════════════════════════════════════════════════════════

type CeilingRightS = { allowed?: boolean; modes?: Array<'direct' | 'request'> };
type QuestionRightsCeilingS = Record<'create' | 'edit' | 'share' | 'delete', CeilingRightS | undefined>;
type FacultyRightS = { granted?: boolean; mode?: 'direct' | 'request' };
type FacultyRightsS = Record<'create' | 'edit' | 'share' | 'delete', FacultyRightS | undefined>;

// Server twin of effectiveFacultyMode/instituteHasRight in
// src/lib/questionRights.ts — keep in sync. Resolves whether the caller may
// perform `right` in DIRECT mode right now.
async function assertQuestionRight(
  db: FirebaseFirestore.Firestore,
  callerRole: string | undefined,
  callerInstituteId: string | undefined,
  callerFacultyId: string | undefined,
  right: 'create' | 'edit' | 'share' | 'delete',
  // Which mode the caller must hold for this action:
  //   'direct'  — the direct callables (act immediately)
  //   'request' — the request-submission callable (faculty raises a request)
  //   'any'     — accept either (used when the mode isn't the gate)
  // The institute admin always resolves to 'direct' (never operates in
  // request mode against themselves).
  requireMode: 'direct' | 'request' | 'any' = 'direct',
): Promise<{ ownerType: 'institute' | 'faculty'; ownerId: string; instituteId: string; mode: 'direct' | 'request' }> {
  if (callerRole !== 'institute' && callerRole !== 'faculty') {
    throw new HttpsError('permission-denied', 'Only institute or faculty accounts use this endpoint.');
  }
  if (!callerInstituteId) {
    throw new HttpsError('permission-denied', 'Missing institute context.');
  }

  // Institute ceiling — required for the right to exist at all.
  const instSnap = await db.collection('institutes').doc(callerInstituteId).get();
  // C1: the tenant must still be switched on. Free here — the document is
  // already in hand for the ceiling read below.
  assertInstituteActiveS(instSnap);
  const ceiling = (instSnap.get('questionRightsCeiling') as QuestionRightsCeilingS | undefined) ?? undefined;
  const cr = ceiling?.[right];
  if (!cr?.allowed) {
    throw new HttpsError('permission-denied', `This institute does not have the "${right}" right.`);
  }

  if (callerRole === 'institute') {
    // The institute admin holds all rights the ceiling allows, in direct mode.
    if (requireMode === 'request') {
      throw new HttpsError('failed-precondition', 'Institute admins act directly, not by request.');
    }
    return { ownerType: 'institute', ownerId: callerInstituteId, instituteId: callerInstituteId, mode: 'direct' };
  }

  // Faculty: needs the individual grant, in an allowed mode, within the ceiling.
  if (!callerFacultyId) {
    throw new HttpsError('permission-denied', 'Missing faculty context.');
  }
  const facSnap = await db.collection('faculty').doc(callerFacultyId).get();
  if (!facSnap.exists) {
    throw new HttpsError('permission-denied', 'Faculty account not found.');
  }
  const rights = (facSnap.get('questionRights') as FacultyRightsS | undefined) ?? undefined;
  const fr = rights?.[right];
  const grantableModes = cr.modes ?? [];
  // The granted mode must be currently grantable by the ceiling.
  if (!fr?.granted || !fr.mode || !grantableModes.includes(fr.mode)) {
    throw new HttpsError(
      'permission-denied',
      `The "${right}" right is not enabled for your account. Ask your institute admin.`,
    );
  }
  if (requireMode !== 'any' && fr.mode !== requireMode) {
    throw new HttpsError(
      'failed-precondition',
      requireMode === 'direct'
        ? `Your "${right}" right requires approval — submit a request instead.`
        : `Your "${right}" right is direct — no request needed.`,
    );
  }
  return { ownerType: 'faculty', ownerId: callerFacultyId, instituteId: callerInstituteId, mode: fr.mode };
}

/**
 * Shared answer-key extraction — the server twin of ANSWER_KEYS in
 * src/lib/questionAnswerSplit.ts. KEEP IN EXACT SYNC.
 *
 * A key present there and missing here does not fail loudly, it fails in both
 * directions at once: the field is written to the PUBLIC question document
 * (where it is an answer key sitting in the collection students read from),
 * and it is NOT written to the questionAnswers sibling (where every grading
 * path looks for it). That is what happened to `tests` — a coding question
 * authored by faculty or an institute shipped its expected outputs on the
 * public doc while `buildCodeSubmission` saw an empty suite, so the candidate
 * could not run their code ("no sample tests to run"), the judge was handed
 * zero tests, and the answer sat in manual review forever.
 *
 * The direct client write path (createQuestion) never had the bug, so only
 * faculty- and institute-authored coding questions are affected. Existing ones
 * are repaired by functions/scripts/repair-code-answer-split.ts.
 */
const ANSWER_KEYS_S = ['correctIds', 'correctPairs', 'modelAnswer', 'tests'] as const;
function splitQuestionPayload(payload: Record<string, unknown>) {
  const publicPart: Record<string, unknown> = {};
  const answerPart: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if ((ANSWER_KEYS_S as readonly string[]).includes(k)) answerPart[k] = v;
    else publicPart[k] = v;
  }
  return { publicPart, answerPart };
}
function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as T;
}

// ── Reusable question executors ───────────────────────────────────
// The actual write logic for each action, factored out so BOTH the direct
// callables and the request-approval path (resolveQuestionRequest) run
// identical, server-authoritative writes. Each takes the resolved owner
// (from assertQuestionRight) plus the payload, and performs no rights check
// of its own — the caller must have already authorized.

type QOwner = { ownerType: 'institute' | 'faculty'; ownerId: string; instituteId: string };

/**
 * Build the two documents one question becomes, without writing them.
 *
 * Extracted from execCreateQuestion (audit S-02) so the single-create path and
 * the bulk path produce byte-identical documents. They differ ONLY in how the
 * writes are committed — one batch per question versus one batch per chunk —
 * and that difference must never leak into the document shape. Same reasoning
 * as the Phase 3A exec* extraction: if two paths write the same entity, they
 * share the code that decides what the entity looks like.
 *
 * `seq` disambiguates ids inside a single chunk. The id carries Date.now(),
 * which is identical across a tight server-side loop, so the random suffix
 * would be the only thing keeping two questions apart. That is fine in
 * isolation and needlessly fragile at 200 per call — the sequence number makes
 * a collision structurally impossible rather than merely unlikely. Omitting it
 * reproduces the original format exactly, so the single path is unchanged.
 */
function buildQuestionDocs(
  owner: QOwner,
  src: Record<string, unknown>,
  seq?: number,
): { id: string; publicDoc: Record<string, unknown>; answerDoc: Record<string, unknown> } {
  const suffix = seq === undefined ? '' : `_${seq}`;
  const id = `q_${Date.now()}_${Math.random().toString(36).slice(2, 9)}${suffix}`;
  const nowIso = new Date().toISOString();
  const full: Record<string, unknown> = {
    ...src,
    id,
    ownerType: owner.ownerType,
    ownerId:   owner.ownerId,
    instituteId: owner.instituteId,
    isDeleted: false,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const { publicPart, answerPart } = splitQuestionPayload(full);
  // The answer fields are OVERWRITTEN with empties rather than merely omitted,
  // so a payload that still carries one inline is neutralised by the same call
  // — the point is that what lands in `questions` cannot contain an answer,
  // whatever the caller passed in. Same construction as sanitizePublic on the
  // client. `tests` joins the list because the hidden suite is the answer key
  // for a coding question.
  const publicDoc = stripUndefined({
    ...publicPart, correctIds: [], correctPairs: [], modelAnswer: '', tests: [],
  });
  const answerDoc = stripUndefined({
    id, ownerType: owner.ownerType, ownerId: owner.ownerId,
    correctIds: [], correctPairs: [], modelAnswer: '', tests: [], ...answerPart, updatedAt: nowIso,
  });
  return { id, publicDoc, answerDoc };
}

async function execCreateQuestion(
  db: FirebaseFirestore.Firestore,
  owner: QOwner,
  src: Record<string, unknown>,
  taxonomy: { subjectId?: string | null; topicId?: string | null },
): Promise<{ id: string }> {
  const { id, publicDoc, answerDoc } = buildQuestionDocs(owner, src);
  const batch = db.batch();
  batch.set(db.collection('questions').doc(id), publicDoc);
  batch.set(db.collection('questionAnswers').doc(id), answerDoc);
  await batch.commit();
  try {
    if (taxonomy.subjectId) await db.collection('subjects').doc(String(taxonomy.subjectId)).update({ questionCount: FieldValue.increment(1) });
    if (taxonomy.topicId)   await db.collection('topics').doc(String(taxonomy.topicId)).update({ questionCount: FieldValue.increment(1) });
  } catch (e) { console.warn('[execCreateQuestion] counter bump skipped', e); }
  return { id };
}

async function execEditQuestion(
  db: FirebaseFirestore.Firestore,
  owner: QOwner,
  id: string,
  src: Record<string, unknown>,
  taxonomy: { subjectId?: string | null; topicId?: string | null; prevSubjectId?: string | null; prevTopicId?: string | null },
): Promise<void> {
  // Ownership: edit is OWN-questions-only.
  const existing = await db.collection('questions').doc(id).get();
  if (!existing.exists) throw new HttpsError('not-found', 'Question not found.');
  if (existing.get('ownerType') !== owner.ownerType || existing.get('ownerId') !== owner.ownerId) {
    throw new HttpsError('permission-denied', 'You can only edit your own questions.');
  }
  const nowIso = new Date().toISOString();
  const { publicPart, answerPart } = splitQuestionPayload(src);
  delete publicPart.id; delete publicPart.ownerType; delete publicPart.ownerId;
  delete publicPart.instituteId; delete publicPart.createdAt;
  const batch = db.batch();
  // Self-heal on write. Questions authored while `tests` was missing from
  // ANSWER_KEYS_S carry the hidden suite on their PUBLIC document; an edit is
  // the one moment this path is already touching that document, so it clears
  // the stale copy rather than leaving it for the repair script alone. Emptied
  // rather than deleted, matching what buildQuestionDocs now writes.
  const publicWipes = answerPart.tests !== undefined || existing.get('tests') !== undefined
    ? { tests: [] }
    : {};
  if (Object.keys(publicPart).length > 0 || Object.keys(publicWipes).length > 0) {
    batch.update(
      db.collection('questions').doc(id),
      stripUndefined({ ...publicPart, ...publicWipes, updatedAt: nowIso }),
    );
  }
  if (Object.keys(answerPart).length > 0) {
    batch.set(
      db.collection('questionAnswers').doc(id),
      stripUndefined({ ...answerPart, ownerType: owner.ownerType, ownerId: owner.ownerId, updatedAt: nowIso }),
      { merge: true },
    );
  }
  await batch.commit();
  const { subjectId, topicId, prevSubjectId, prevTopicId } = taxonomy;
  try {
    if (prevSubjectId && prevSubjectId !== subjectId) await db.collection('subjects').doc(String(prevSubjectId)).update({ questionCount: FieldValue.increment(-1) });
    if (subjectId && subjectId !== prevSubjectId)     await db.collection('subjects').doc(String(subjectId)).update({ questionCount: FieldValue.increment(1) });
    if (prevTopicId && prevTopicId !== topicId)       await db.collection('topics').doc(String(prevTopicId)).update({ questionCount: FieldValue.increment(-1) });
    if (topicId && topicId !== prevTopicId)           await db.collection('topics').doc(String(topicId)).update({ questionCount: FieldValue.increment(1) });
  } catch (e) { console.warn('[execEditQuestion] counter shift skipped', e); }
}

async function execDeleteQuestion(
  db: FirebaseFirestore.Firestore,
  owner: QOwner,
  id: string,
  taxonomy: { subjectId?: string | null; topicId?: string | null },
): Promise<void> {
  const existing = await db.collection('questions').doc(id).get();
  if (!existing.exists) throw new HttpsError('not-found', 'Question not found.');
  if (existing.get('ownerType') !== owner.ownerType || existing.get('ownerId') !== owner.ownerId) {
    throw new HttpsError('permission-denied', 'You can only delete your own questions.');
  }
  await db.collection('questions').doc(id).update({ isDeleted: true, updatedAt: new Date().toISOString() });
  const subjectId = taxonomy.subjectId ?? existing.get('subjectId') ?? null;
  const topicId   = taxonomy.topicId ?? existing.get('topicId') ?? null;
  try {
    if (subjectId) await db.collection('subjects').doc(String(subjectId)).update({ questionCount: FieldValue.increment(-1) });
    if (topicId)   await db.collection('topics').doc(String(topicId)).update({ questionCount: FieldValue.increment(-1) });
  } catch (e) { console.warn('[execDeleteQuestion] counter bump skipped', e); }
}

async function execShareQuestions(
  db: FirebaseFirestore.Firestore,
  owner: QOwner,
  questionIds: string[],
  recipients: Array<{ id: string; type: 'faculty' | 'institute' }>,
  note: string,
): Promise<{ shareIds: string[] }> {
  // Recipients must be inside the caller's institute.
  for (const r of recipients) {
    if (r.type === 'institute') {
      if (r.id !== owner.instituteId) throw new HttpsError('permission-denied', 'Can only share within your own institute.');
    } else if (r.type === 'faculty') {
      const facSnap = await db.collection('faculty').doc(r.id).get();
      if (!facSnap.exists || facSnap.get('instituteId') !== owner.instituteId) {
        throw new HttpsError('permission-denied', 'Recipient is not in your institute.');
      }
    } else {
      throw new HttpsError('invalid-argument', 'Invalid recipient type.');
    }
  }
  // Each shared question must be legitimately held by the caller.
  for (let i = 0; i < questionIds.length; i += 30) {
    const chunk = questionIds.slice(i, i + 30);
    const snap = await db.collection('questions').where('id', 'in', chunk).get();
    const found = new Map(snap.docs.map((d) => [d.id, d]));
    for (const qid of chunk) {
      const doc = found.get(qid);
      if (!doc) throw new HttpsError('not-found', `Question ${qid} not found.`);
      const qOwnerType = doc.get('ownerType') ?? 'webOwner';
      const qOwnerId   = doc.get('ownerId')   ?? 'webOwner';
      const qInstitute = doc.get('instituteId') ?? '';
      const ownedByCaller = qOwnerType === owner.ownerType && qOwnerId === owner.ownerId;
      const inCallerInstitute = qInstitute === owner.instituteId;
      const isWebOwnerContent = qOwnerType === 'webOwner';
      if (!ownedByCaller && !inCallerInstitute && !isWebOwnerContent) {
        throw new HttpsError('permission-denied', `You cannot share question ${qid}.`);
      }
    }
  }
  const nowIso = new Date().toISOString();
  const batch = db.batch();
  const created: string[] = [];
  for (const r of recipients) {
    const id = `qs_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    created.push(id);
    batch.set(db.collection('questionShares').doc(id), {
      id,
      sharedBy:            owner.ownerId,
      sharedByType:        owner.ownerType,
      sharedByInstituteId: owner.instituteId,
      sharedWith:          r.id,
      sharedWithType:      r.type,
      questionIds,
      note,
      isRevoked:           false,
      sharedAt:            nowIso,
      updatedAt:           nowIso,
    });
  }
  await batch.commit();
  return { shareIds: created };
}

interface QWritePayload {
  id?: string;
  // Full question fields the client already assembled (public + answer keys),
  // minus owner/stamp which the server assigns authoritatively.
  question: Record<string, unknown>;
  // taxonomy hint for counter bumps
  subjectId?: string | null;
  topicId?: string | null;
  prevSubjectId?: string | null;
  prevTopicId?: string | null;
}

/** Create a question as institute/faculty, gated by the create right. */
export const createQuestionAsRole = onCall<QWritePayload>(
  CALLABLE_BASE,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const db = getFirestore();
    const role        = request.auth.token.role        as string | undefined;
    const instituteId = request.auth.token.instituteId as string | undefined;
    const facultyId   = request.auth.token.facultyId   as string | undefined;

    const owner = await assertQuestionRight(db, role, instituteId, facultyId, 'create');

    const src = request.data?.question;
    if (!src || typeof src !== 'object') {
      throw new HttpsError('invalid-argument', 'Missing question payload.');
    }
    const { id } = await execCreateQuestion(db, owner, src, {
      subjectId: request.data?.subjectId ?? null,
      topicId:   request.data?.topicId ?? null,
    });
    return { ok: true, id };
  },
);

/**
 * Bulk-create questions as institute/faculty — gated by the create right,
 * checked ONCE for the whole chunk.
 *
 * Audit S-02. Bulk upload previously wrote straight to Firestore in a
 * client-side loop, which meant it bypassed the rights model entirely: a
 * faculty member with no create grant could not add a single question through
 * the UI but could import a thousand through the same page. Routing it through
 * createQuestionAsRole one row at a time would have closed that, but at the
 * cost of one HTTPS round-trip per question — roughly 2-4 minutes for a
 * 500-row file against about 40 seconds for the direct writes it replaced.
 * A security fix that makes a routine task four times slower does not survive
 * contact with the people using it.
 *
 * So the chunk is the unit of work. 500 rows becomes three calls instead of
 * five hundred, and the per-question work happens next to Firestore rather
 * than across the wire — which lands it FASTER than the direct path it
 * replaces, not slower.
 *
 * Sizing, and why 200:
 *   • each question writes TWO documents, so 200 items is 400 writes and stays
 *     under Firestore's hard 500-per-batch ceiling with headroom
 *   • the rights check runs once per call rather than once per row
 *   • counter bumps are AGGREGATED per chunk — a naive loop would issue two
 *     increments per question (400 extra round-trips) to reach the same totals
 *
 * The cap is enforced here as well as in the client. A client-side limit is a
 * usability affordance; this one is the actual constraint, since the endpoint
 * can be called directly.
 */
const BULK_CREATE_MAX_PER_CALL = 200;

interface BulkQuestionItem {
  question: Record<string, unknown>;
  subjectId?: string | null;
  topicId?: string | null;
}

export const createQuestionsBulkAsRole = onCall<{ items?: BulkQuestionItem[] }>(
  CALLABLE_BASE,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const db = getFirestore();
    const role        = request.auth.token.role        as string | undefined;
    const instituteId = request.auth.token.instituteId as string | undefined;
    const facultyId   = request.auth.token.facultyId   as string | undefined;

    // One check for the chunk. Identical gate to createQuestionAsRole — same
    // ceiling, same per-faculty grant, same direct-mode requirement — so bulk
    // can never be a softer door than single-create. That asymmetry was the
    // bug.
    const owner = await assertQuestionRight(db, role, instituteId, facultyId, 'create');

    const items = request.data?.items;
    if (!Array.isArray(items) || items.length === 0) {
      throw new HttpsError('invalid-argument', 'items must be a non-empty array.');
    }
    if (items.length > BULK_CREATE_MAX_PER_CALL) {
      throw new HttpsError(
        'invalid-argument',
        `At most ${BULK_CREATE_MAX_PER_CALL} questions per call; send in chunks.`,
      );
    }

    // Per-item validation SKIPS rather than throws, deliberately. The client
    // loop this replaces caught per row and incremented a "skipped" counter,
    // so one unusable row never cost the other 499. Throwing here would have
    // quietly converted a partial import into a total failure — the kind of
    // regression that hides behind a green test run because the happy path is
    // identical. Skipped indexes come back so the caller's count stays true.
    const batch = db.batch();
    const ids: string[] = [];
    const skipped: number[] = [];
    const subjectDeltas = new Map<string, number>();
    const topicDeltas   = new Map<string, number>();

    items.forEach((it, i) => {
      if (!it || typeof it !== 'object' || !it.question || typeof it.question !== 'object') {
        skipped.push(i);
        return;
      }
      const { id, publicDoc, answerDoc } = buildQuestionDocs(owner, it.question, i);
      batch.set(db.collection('questions').doc(id), publicDoc);
      batch.set(db.collection('questionAnswers').doc(id), answerDoc);
      ids.push(id);
      if (it.subjectId) subjectDeltas.set(String(it.subjectId), (subjectDeltas.get(String(it.subjectId)) ?? 0) + 1);
      if (it.topicId)   topicDeltas.set(String(it.topicId),     (topicDeltas.get(String(it.topicId))     ?? 0) + 1);
    });

    if (ids.length > 0) await batch.commit();

    // After the commit, and best-effort — matching execCreateQuestion, where a
    // counter failure warns rather than throws. The questions exist at this
    // point; a drifted count is a cosmetic problem that refreshAllSubjectCounts
    // repairs, whereas throwing here would report failure for an import that
    // actually succeeded and invite a duplicate re-run.
    try {
      const bumps: Promise<unknown>[] = [];
      for (const [subjectId, delta] of subjectDeltas) {
        bumps.push(db.collection('subjects').doc(subjectId).update({ questionCount: FieldValue.increment(delta) }));
      }
      for (const [topicId, delta] of topicDeltas) {
        bumps.push(db.collection('topics').doc(topicId).update({ questionCount: FieldValue.increment(delta) }));
      }
      await Promise.all(bumps);
    } catch (e) {
      console.warn('[createQuestionsBulkAsRole] counter bump skipped', e);
    }

    return { ok: true, ids, skipped };
  },
);

/** Edit a question as institute/faculty — gated by the edit right AND ownership. */
export const editQuestionAsRole = onCall<QWritePayload>(
  CALLABLE_BASE,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const db = getFirestore();
    const role        = request.auth.token.role        as string | undefined;
    const instituteId = request.auth.token.instituteId as string | undefined;
    const facultyId   = request.auth.token.facultyId   as string | undefined;

    const owner = await assertQuestionRight(db, role, instituteId, facultyId, 'edit');

    const id = request.data?.id;
    if (!id) throw new HttpsError('invalid-argument', 'Missing question id.');
    const src = request.data?.question;
    if (!src || typeof src !== 'object') throw new HttpsError('invalid-argument', 'Missing question payload.');

    await execEditQuestion(db, owner, id, src, {
      subjectId: request.data?.subjectId ?? null,
      topicId:   request.data?.topicId ?? null,
      prevSubjectId: request.data?.prevSubjectId ?? null,
      prevTopicId:   request.data?.prevTopicId ?? null,
    });
    return { ok: true };
  },
);

/** Soft-delete a question as institute/faculty — gated by the delete right AND ownership. */
export const deleteQuestionAsRole = onCall<{ id?: string; subjectId?: string | null; topicId?: string | null }>(
  CALLABLE_BASE,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const db = getFirestore();
    const role        = request.auth.token.role        as string | undefined;
    const instituteId = request.auth.token.instituteId as string | undefined;
    const facultyId   = request.auth.token.facultyId   as string | undefined;

    const owner = await assertQuestionRight(db, role, instituteId, facultyId, 'delete');

    const id = request.data?.id;
    if (!id) throw new HttpsError('invalid-argument', 'Missing question id.');

    await execDeleteQuestion(db, owner, id, {
      subjectId: request.data?.subjectId ?? null,
      topicId:   request.data?.topicId ?? null,
    });
    return { ok: true };
  },
);

// ══════════════════════════════════════════════════════════════════
// QUESTION GROUPS — role-gated writes (Phase 1)
// ══════════════════════════════════════════════════════════════════
//
// firestore.rules allows direct writes to /questionGroups for the webOwner
// only, for the same reason /questions does: the questionRightsCeiling and
// Faculty.questionRights model lives inside assertQuestionRight, and a rule
// that authorized by identity alone would let anyone with DevTools skip it.
// These callables are therefore the ONLY way institute and faculty content
// reaches the collection.
//
// They deliberately reuse the EXISTING create/edit/delete question rights
// rather than introducing group-specific ones. Authoring a DI set is authoring
// questions; a separate right would mean every ceiling already configured on
// the platform silently failed to cover the new content type.

interface GroupWritePayload {
  id?: string;
  /** Group fields the client assembled, minus owner/stamp (server assigns). */
  group?: Record<string, unknown>;
  /** Child questions, in order. Create only. */
  children?: Record<string, unknown>[];
  subjectId?: string | null;
  topicId?: string | null;
}

/** Batch-write ceiling: each child costs 2 writes, the group 1. */
const MAX_GROUP_CHILDREN = 249;

/**
 * Create a group and its children as institute/faculty.
 *
 * The group and every child are committed in ONE batch. A half-written group
 * is not a degraded result, it is two distinct bugs: a stimulus with no
 * questions, or — worse — children with no stimulus, which stay eligible for
 * ordinary topic rules and can be drawn into an exam as unanswerable items.
 */
export const createQuestionGroupAsRole = onCall<GroupWritePayload>(
  CALLABLE_BASE,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const db = getFirestore();
    const role        = request.auth.token.role        as string | undefined;
    const instituteId = request.auth.token.instituteId as string | undefined;
    const facultyId   = request.auth.token.facultyId   as string | undefined;

    const owner = await assertQuestionRight(db, role, instituteId, facultyId, 'create');

    const src = request.data?.group;
    const children = request.data?.children;
    if (!src || typeof src !== 'object') {
      throw new HttpsError('invalid-argument', 'Missing group payload.');
    }
    if (!Array.isArray(children) || children.length === 0) {
      throw new HttpsError('invalid-argument', 'A question group needs at least one child question.');
    }
    if (children.length > MAX_GROUP_CHILDREN) {
      throw new HttpsError('invalid-argument',
        `A question group can hold at most ${MAX_GROUP_CHILDREN} questions (got ${children.length}).`);
    }

    const nowIso = new Date().toISOString();
    const groupId = `grp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const batch = db.batch();

    // Children carry the group's id and their position, and inherit the
    // owner/tenant stamps from buildQuestionDocs — the same stamps the group
    // gets below. Divergent stamps would leave a group and its children on
    // opposite sides of the tenant fence.
    const childIds: string[] = [];
    children.forEach((child, idx) => {
      const { id, publicDoc, answerDoc } = buildQuestionDocs(
        owner,
        { ...child, groupId, groupOrder: idx },
        idx,
      );
      childIds.push(id);
      batch.set(db.collection('questions').doc(id), publicDoc);
      batch.set(db.collection('questionAnswers').doc(id), answerDoc);
    });

    const groupDoc = stripUndefined({
      ...src,
      id: groupId,
      childIds,
      ownerType: owner.ownerType,
      ownerId:   owner.ownerId,
      instituteId: owner.instituteId,
      isDeleted: false,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    batch.set(db.collection('questionGroups').doc(groupId), groupDoc);

    await batch.commit();

    // Children are ordinary questions and count toward taxonomy totals like
    // any other, so the builder's availability numbers stay truthful.
    try {
      const n = childIds.length;
      const { subjectId, topicId } = request.data ?? {};
      if (subjectId) await db.collection('subjects').doc(String(subjectId)).update({ questionCount: FieldValue.increment(n) });
      if (topicId)   await db.collection('topics').doc(String(topicId)).update({ questionCount: FieldValue.increment(n) });
    } catch (e) { console.warn('[createQuestionGroupAsRole] counter bump skipped', e); }

    return { ok: true, id: groupId, childIds };
  },
);

/**
 * Edit a group's own fields (stimulus, metadata) as institute/faculty.
 * Child questions are edited through editQuestionAsRole like any other
 * question — this callable does not touch them.
 */
export const editQuestionGroupAsRole = onCall<GroupWritePayload>(
  CALLABLE_BASE,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const db = getFirestore();
    const role        = request.auth.token.role        as string | undefined;
    const instituteId = request.auth.token.instituteId as string | undefined;
    const facultyId   = request.auth.token.facultyId   as string | undefined;

    const owner = await assertQuestionRight(db, role, instituteId, facultyId, 'edit');

    const id = request.data?.id;
    if (!id) throw new HttpsError('invalid-argument', 'Missing group id.');
    const src = request.data?.group;
    if (!src || typeof src !== 'object') throw new HttpsError('invalid-argument', 'Missing group payload.');

    // Ownership: edit is OWN-content-only, same as execEditQuestion.
    const existing = await db.collection('questionGroups').doc(id).get();
    if (!existing.exists) throw new HttpsError('not-found', 'Question group not found.');
    if (existing.get('ownerType') !== owner.ownerType || existing.get('ownerId') !== owner.ownerId) {
      throw new HttpsError('permission-denied', 'You can only edit your own question groups.');
    }

    const patch = { ...src };
    // Server-owned fields are never taken from the client. childIds is in this
    // list on purpose: membership changes by creating or deleting children,
    // not by rewriting the array, so accepting it here would let a caller
    // adopt questions they do not own into their own group.
    for (const k of ['id', 'ownerType', 'ownerId', 'instituteId', 'createdAt', 'childIds']) {
      delete patch[k];
    }

    await db.collection('questionGroups').doc(id).update(
      stripUndefined({ ...patch, updatedAt: new Date().toISOString() }),
    );
    return { ok: true };
  },
);

/**
 * Soft-delete a group AND its children as institute/faculty.
 *
 * The cascade is mandatory. Children are ordinary question documents, so a
 * child left alive after its group is gone stays eligible for any topic rule
 * and would be drawn into an exam with its stimulus missing. Deleting the
 * container deletes what only made sense inside it.
 */
export const deleteQuestionGroupAsRole = onCall<{ id?: string; subjectId?: string | null; topicId?: string | null }>(
  CALLABLE_BASE,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const db = getFirestore();
    const role        = request.auth.token.role        as string | undefined;
    const instituteId = request.auth.token.instituteId as string | undefined;
    const facultyId   = request.auth.token.facultyId   as string | undefined;

    const owner = await assertQuestionRight(db, role, instituteId, facultyId, 'delete');

    const id = request.data?.id;
    if (!id) throw new HttpsError('invalid-argument', 'Missing group id.');

    const snap = await db.collection('questionGroups').doc(id).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Question group not found.');
    if (snap.get('ownerType') !== owner.ownerType || snap.get('ownerId') !== owner.ownerId) {
      throw new HttpsError('permission-denied', 'You can only delete your own question groups.');
    }
    if (snap.get('isDeleted') === true) return { ok: true, deletedChildren: 0 };

    const childIds: string[] = Array.isArray(snap.get('childIds')) ? snap.get('childIds') : [];
    const nowIso = new Date().toISOString();
    const batch = db.batch();
    batch.update(db.collection('questionGroups').doc(id), { isDeleted: true, updatedAt: nowIso });

    // Only children that are actually still live and actually still point at
    // this group — a child moved out or already deleted is not ours to touch,
    // and counting it would corrupt the taxonomy totals below.
    let deleted = 0;
    const childSnaps = childIds.length > 0
      ? await db.getAll(...childIds.map((cid) => db.collection('questions').doc(cid)))
      : [];
    for (const child of childSnaps) {
      if (!child.exists) continue;
      if (child.get('isDeleted') === true) continue;
      if (child.get('groupId') !== id) continue;
      batch.update(child.ref, { isDeleted: true, updatedAt: nowIso });
      deleted++;
    }
    await batch.commit();

    try {
      const { subjectId, topicId } = request.data ?? {};
      if (deleted > 0) {
        if (subjectId) await db.collection('subjects').doc(String(subjectId)).update({ questionCount: FieldValue.increment(-deleted) });
        if (topicId)   await db.collection('topics').doc(String(topicId)).update({ questionCount: FieldValue.increment(-deleted) });
      }
    } catch (e) { console.warn('[deleteQuestionGroupAsRole] counter bump skipped', e); }

    return { ok: true, deletedChildren: deleted };
  },
);

/**
 * Share questions with peers as institute/faculty — gated by the SHARE right.
 * Faculty may share their OWN questions and content GRANTED to them, strictly
 * with recipients inside their own institute. The server:
 *   1. enforces the share right (ceiling + faculty grant, direct mode),
 *   2. verifies every recipient is inside the caller's institute,
 *   3. verifies every shared question is one the caller legitimately holds
 *      (owns, or was shared/granted to them),
 * then writes one QuestionShare per recipient. Direct mode only in Phase 2;
 * request mode routes to the Phase-3 approval workflow.
 */
export const shareQuestionsAsRole = onCall<{
  questionIds?: string[];
  recipients?: Array<{ id: string; type: 'faculty' | 'institute' }>;
  note?: string;
}>(
  CALLABLE_BASE,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const db = getFirestore();
    const role        = request.auth.token.role        as string | undefined;
    const instituteId = request.auth.token.instituteId as string | undefined;
    const facultyId   = request.auth.token.facultyId   as string | undefined;

    const owner = await assertQuestionRight(db, role, instituteId, facultyId, 'share');

    const questionIds = Array.isArray(request.data?.questionIds) ? request.data!.questionIds! : [];
    const recipients  = Array.isArray(request.data?.recipients) ? request.data!.recipients! : [];
    const note = typeof request.data?.note === 'string' ? request.data!.note.slice(0, 500) : '';
    if (questionIds.length === 0) throw new HttpsError('invalid-argument', 'No questions to share.');
    if (recipients.length === 0)  throw new HttpsError('invalid-argument', 'No recipients selected.');
    if (questionIds.length > 200) throw new HttpsError('invalid-argument', 'Too many questions in one share.');

    const { shareIds } = await execShareQuestions(db, owner, questionIds, recipients, note);
    return { ok: true, shareIds };
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// QUESTION REQUESTS — Phase 3 (request/approval workflow)
// When a faculty member's grant for an action is in REQUEST mode, the action
// doesn't execute directly — it becomes a pending questionRequests doc that
// the institute admin approves or rejects. Approval EXECUTES the action
// server-side via the same exec* functions the direct callables use, so the
// approval path is exactly as tamper-proof as the direct path.
// ═══════════════════════════════════════════════════════════════════════════

interface RequestPayload {
  type?: 'create' | 'edit' | 'delete' | 'share';
  // create/edit: full question fields; delete: unused; share: unused
  question?: Record<string, unknown>;
  questionId?: string;                // edit/delete/share subject
  questionStem?: string;              // denormalized for inbox display
  subjectId?: string | null;
  topicId?: string | null;
  prevSubjectId?: string | null;
  prevTopicId?: string | null;
  // share
  recipients?: Array<{ id: string; type: 'faculty' | 'institute' }>;
  note?: string;
}

/**
 * Faculty submits a request for an action their grant only permits in REQUEST
 * mode. Verifies the request-mode grant, validates the payload the same way
 * the direct callables do (ownership for edit/delete; recipients+holdings for
 * share), and writes a PENDING questionRequests doc. Does NOT mutate anything.
 */
export const submitQuestionRequest = onCall<RequestPayload>(
  CALLABLE_BASE,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const db = getFirestore();
    const role        = request.auth.token.role        as string | undefined;
    const instituteId = request.auth.token.instituteId as string | undefined;
    const facultyId   = request.auth.token.facultyId   as string | undefined;

    const type = request.data?.type;
    if (!type || !['create', 'edit', 'delete', 'share'].includes(type)) {
      throw new HttpsError('invalid-argument', 'Invalid request type.');
    }

    // Must hold the right in REQUEST mode (institute admins never reach here —
    // they act directly). This throws if the grant is direct or absent.
    const owner = await assertQuestionRight(db, role, instituteId, facultyId, type, 'request');

    // Pre-validate the payload so obviously-invalid requests are rejected at
    // submission rather than sitting in the inbox until approval fails.
    if (type === 'edit' || type === 'delete') {
      const qid = request.data?.questionId;
      if (!qid) throw new HttpsError('invalid-argument', 'Missing question id.');
      const existing = await db.collection('questions').doc(qid).get();
      if (!existing.exists) throw new HttpsError('not-found', 'Question not found.');
      if (existing.get('ownerType') !== owner.ownerType || existing.get('ownerId') !== owner.ownerId) {
        throw new HttpsError('permission-denied', `You can only ${type} your own questions.`);
      }
    }
    if (type === 'create' || type === 'edit') {
      if (!request.data?.question || typeof request.data.question !== 'object') {
        throw new HttpsError('invalid-argument', 'Missing question payload.');
      }
    }
    if (type === 'share') {
      const recips = request.data?.recipients;
      if (!Array.isArray(recips) || recips.length === 0) {
        throw new HttpsError('invalid-argument', 'No recipients selected.');
      }
    }

    // Faculty display name for the inbox.
    const facSnap = await db.collection('faculty').doc(facultyId!).get();
    const facultyName = (facSnap.get('name') as string | undefined) ?? 'Faculty';

    const id = `qr_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    const nowIso = new Date().toISOString();
    await db.collection('questionRequests').doc(id).set(stripUndefined({
      id,
      type,
      status: 'pending',
      facultyId,
      facultyName,
      instituteId: owner.instituteId,
      questionId:   request.data?.questionId ?? null,
      questionStem: request.data?.questionStem ?? null,
      payload: stripUndefined({
        question:  request.data?.question ?? null,
        recipients: request.data?.recipients ?? null,
        note:       request.data?.note ?? null,
        subjectId:  request.data?.subjectId ?? null,
        topicId:    request.data?.topicId ?? null,
        prevSubjectId: request.data?.prevSubjectId ?? null,
        prevTopicId:   request.data?.prevTopicId ?? null,
      }),
      createdAt: nowIso,
      updatedAt: nowIso,
    }));
    return { ok: true, id };
  },
);

/**
 * Institute admin approves or rejects a pending request. On APPROVE, executes
 * the action server-side via the exec* functions with the ORIGINAL faculty
 * requester as owner (so ownership checks pass and the question stays theirs).
 * On REJECT, just marks it. Idempotent-ish: a non-pending request is refused.
 */
export const resolveQuestionRequest = onCall<{ requestId?: string; decision?: 'approve' | 'reject'; reviewNote?: string }>(
  CALLABLE_BASE,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const db = getFirestore();
    const role        = request.auth.token.role        as string | undefined;
    const callerInst  = request.auth.token.instituteId as string | undefined;

    if (role !== 'institute') {
      throw new HttpsError('permission-denied', 'Only the institute admin can resolve requests.');
    }
    const requestId = request.data?.requestId;
    const decision  = request.data?.decision;
    if (!requestId) throw new HttpsError('invalid-argument', 'Missing request id.');
    if (decision !== 'approve' && decision !== 'reject') {
      throw new HttpsError('invalid-argument', 'Decision must be approve or reject.');
    }

    const reqRef = db.collection('questionRequests').doc(requestId);
    const reqSnap = await reqRef.get();
    if (!reqSnap.exists) throw new HttpsError('not-found', 'Request not found.');
    const req = reqSnap.data() as {
      type: 'create' | 'edit' | 'delete' | 'share';
      status: string;
      facultyId: string;
      instituteId: string;
      questionId?: string | null;
      payload?: {
        question?: Record<string, unknown> | null;
        recipients?: Array<{ id: string; type: 'faculty' | 'institute' }> | null;
        note?: string | null;
        subjectId?: string | null; topicId?: string | null;
        prevSubjectId?: string | null; prevTopicId?: string | null;
      };
    };

    // Authorization: the caller must be the admin of this request's institute.
    if (req.instituteId !== callerInst) {
      throw new HttpsError('permission-denied', 'This request belongs to another institute.');
    }
    if (req.status !== 'pending') {
      throw new HttpsError('failed-precondition', 'This request has already been resolved.');
    }

    const nowIso = new Date().toISOString();
    const reviewNote = typeof request.data?.reviewNote === 'string' ? request.data.reviewNote.slice(0, 500) : '';

    if (decision === 'reject') {
      await reqRef.update({ status: 'rejected', reviewedBy: callerInst, reviewNote, updatedAt: nowIso });
      return { ok: true, status: 'rejected' };
    }

    // APPROVE — execute the action as the ORIGINAL faculty requester so
    // ownership checks pass and authored content stays theirs. The faculty's
    // request-mode grant was verified at submission; we re-confirm the right
    // still exists at all (ceiling may have changed) but not the mode.
    const owner: QOwner = { ownerType: 'faculty', ownerId: req.facultyId, instituteId: req.instituteId };
    // Re-check the institute still has this right (ceiling could have been
    // revoked between submission and approval).
    const instSnap = await db.collection('institutes').doc(req.instituteId).get();
    // N1 (audit 2026-08-06): THE FIFTH GOVERNANCE READ, and the one C1 missed.
    //
    // C1 wired assertInstituteActiveS into the four sites that read a ceiling
    // off institutes/{id} — assertQuestionRight and the three deletion gates —
    // and this one was not among them. A request sitting in the queue is
    // exactly the case where the tenant's status is most likely to have
    // changed since the request was raised, so of the five it is the one that
    // most needed the check.
    //
    // Without it, a disabled or expired institute admin could still approve
    // pending requests and execute create / edit / delete / share against
    // their question bank, because disabling an institute never revokes its
    // token — the same root cause C1 turned on.
    assertInstituteActiveS(instSnap);
    const ceiling = instSnap.get('questionRightsCeiling') as QuestionRightsCeilingS | undefined;
    if (!ceiling?.[req.type]?.allowed) {
      throw new HttpsError('failed-precondition', `The institute no longer has the "${req.type}" right — cannot approve.`);
    }

    const p = req.payload ?? {};
    try {
      if (req.type === 'create') {
        if (!p.question) throw new HttpsError('failed-precondition', 'Request has no question payload.');
        await execCreateQuestion(db, owner, p.question, { subjectId: p.subjectId ?? null, topicId: p.topicId ?? null });
      } else if (req.type === 'edit') {
        if (!req.questionId || !p.question) throw new HttpsError('failed-precondition', 'Request has no edit payload.');
        await execEditQuestion(db, owner, req.questionId, p.question, {
          subjectId: p.subjectId ?? null, topicId: p.topicId ?? null,
          prevSubjectId: p.prevSubjectId ?? null, prevTopicId: p.prevTopicId ?? null,
        });
      } else if (req.type === 'delete') {
        if (!req.questionId) throw new HttpsError('failed-precondition', 'Request has no question id.');
        await execDeleteQuestion(db, owner, req.questionId, { subjectId: p.subjectId ?? null, topicId: p.topicId ?? null });
      } else if (req.type === 'share') {
        if (!Array.isArray(p.recipients) || p.recipients.length === 0) {
          throw new HttpsError('failed-precondition', 'Request has no recipients.');
        }
        const qids = req.questionId ? [req.questionId] : [];
        if (qids.length === 0) throw new HttpsError('failed-precondition', 'Request has no question to share.');
        await execShareQuestions(db, owner, qids, p.recipients, p.note ?? '');
      }
    } catch (e) {
      // Execution failed (e.g. ownership changed, question deleted). Leave the
      // request pending so the admin can retry or reject, and surface why.
      if (e instanceof HttpsError) throw e;
      throw new HttpsError('internal', 'Failed to execute the approved action.');
    }

    await reqRef.update({ status: 'approved', reviewedBy: callerInst, reviewNote, updatedAt: nowIso });
    return { ok: true, status: 'approved' };
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// ALLOCATION SYSTEM — Phase B (plans/ALLOCATION_SYSTEM_PLAN.md)
//
// Three callables, webOwner-only in v1:
//   resolveAllocation      — dry-run preview AND transactional commit; ONE
//                            code path (invariant 3), version-preconditioned
//                            (the concurrent-admins race, handled here once).
//   addManualMember        — the roster "Add student" flow; idempotent.
//   getAllocationPreviewPage — paged member reads with student-name join.
//
// Writers: these functions are the ONLY writers of allocations/,
// assessmentMembers/, allocationAudit/ and assessments.allocationMode —
// firestore.rules denies every client write to all four (invariant 9).
// Pure resolution semantics live in ./allocationCore (swept headlessly).
// ═══════════════════════════════════════════════════════════════════════════

const ALLOC_TXN_MEMBER_WRITE_CAP = 380; // headroom under the 500-op transaction limit

function requireWebOwner(request: { auth?: { token?: Record<string, unknown> } | null }): void {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
  if ((request.auth.token as { role?: string } | undefined)?.role !== 'webOwner') {
    throw new HttpsError('permission-denied', 'Only the Web Owner may manage allocation.');
  }
}

/** Fetch selected node docs + expansion inputs and hand them to the pure core. */
async function fetchCoreInput(
  db: FirebaseFirestore.Firestore,
  assessmentId: string,
  nodeType: AllocNodeType,
  nodeIds: string[],
): Promise<{ core: CoreInput; selectedDocs: Map<string, FirebaseFirestore.DocumentData> }> {
  const selectedDocs = new Map<string, FirebaseFirestore.DocumentData>();
  const selected: CoreSelectedNode[] = [];

  const col = nodeType === 'institute' ? 'institutes' : COLLECTION_OF[nodeType as SubNodeType];
  const refs = nodeIds.map((id) => db.collection(col).doc(id));
  const snaps = refs.length > 0 ? await db.getAll(...refs) : [];
  snaps.forEach((snap) => {
    if (!snap.exists) return;
    const d = snap.data() as Record<string, unknown>;
    selectedDocs.set(snap.id, d);
    selected.push({
      id: snap.id,
      name: String(d.name ?? snap.id),
      // Institutes carry no status field — treat them as active.
      status: nodeType === 'institute' ? 'active' : String(d.status ?? 'active'),
      instituteId: nodeType === 'institute' ? snap.id : String(d.instituteId ?? ''),
    });
  });

  const descendants: CoreDescendant[] = [];
  const mappings: CoreMapping[] = [];
  let instituteStudents: { id: string; instituteId: string }[] | undefined;

  if (nodeType === 'institute') {
    instituteStudents = [];
    for (const instId of nodeIds) {
      const stuSnap = await db.collection('students').where('instituteId', '==', instId).get();
      stuSnap.docs.forEach((doc) => instituteStudents!.push({ id: doc.id, instituteId: instId }));
    }
  } else if (nodeType === 'course') {
    // B-2: course left the spine. A course is an OFFERING that resolves SIDEWAYS
    // to the section(s) it's attached to, then normally down to students:
    //   section-level course (has sectionId) → that one section
    //   whole-semester course (semesterId set) → all sections of that semester
    //   whole-year course (semesterId null)   → all sections directly under the year
    // We treat those resolved sections as the descendants, plus their groups.
    const sectionIds = new Set<string>();
    for (const [, d] of selectedDocs) {
      const secId = d.sectionId as string | undefined;
      const semId = d.semesterId as string | null | undefined;
      const yrId = d.yearId as string | undefined;
      if (secId) {
        sectionIds.add(secId);
      } else if (semId) {
        const secs = await db.collection('sections').where('semesterId', '==', semId).get();
        secs.docs.forEach((s) => sectionIds.add(s.id));
      } else if (yrId) {
        const secs = await db.collection('sections').where('yearId', '==', yrId).get();
        secs.docs.forEach((s) => { if (s.get('semesterId') == null) sectionIds.add(s.id); });
      }
    }
    // The resolved sections + their groups become the descendants, each
    // attributed to the selected course that reaches it (via-attribution credits
    // the course). A student under multiple selected courses dedupes in the core.
    const sectionDocs = sectionIds.size > 0
      ? await db.getAll(...[...sectionIds].map((sid) => db.collection('sections').doc(sid)))
      : [];
    const activeSectionIds: string[] = [];
    sectionDocs.forEach((s) => {
      if (!s.exists) return;
      const active = String(s.get('status') ?? 'active') === 'active';
      // Attribute this section to the course(s) that reach it.
      let owner = '';
      for (const [cid, d] of selectedDocs) {
        const secId = d.sectionId as string | undefined;
        const semId = d.semesterId as string | null | undefined;
        const yrId = d.yearId as string | undefined;
        if (secId === s.id) { owner = cid; break; }
        if (!secId && semId && s.get('semesterId') === semId) { owner = cid; break; }
        if (!secId && !semId && yrId && s.get('yearId') === yrId && s.get('semesterId') == null) { owner = cid; break; }
      }
      descendants.push({ id: s.id, status: active ? 'active' : 'archived', parentSelectedId: owner || nodeIds[0] });
      if (active) activeSectionIds.push(s.id);
    });
    // Groups under those sections.
    for (const ids of chunk(activeSectionIds)) {
      const gsnap = await db.collection('groups').where('sectionId', 'in', ids).get();
      gsnap.docs.forEach((g) => {
        const active = String(g.get('status') ?? 'active') === 'active';
        descendants.push({ id: g.id, status: active ? 'active' : 'archived', parentSelectedId: g.get('sectionId') as string });
      });
    }
    // Mappings at the resolved sections + groups (the course node itself holds
    // no direct student mappings in the new model).
    const activeDescIds = descendants.filter((d) => d.status === 'active').map((d) => d.id);
    for (const ids of chunk(activeDescIds)) {
      if (ids.length === 0) continue;
      const snap = await db.collection('academicMappings').where('nodeId', 'in', ids).get();
      snap.docs.forEach((doc) => {
        const d = doc.data() as Record<string, unknown>;
        mappings.push({
          studentId: String(d.studentId ?? ''),
          nodeId: String(d.nodeId ?? ''),
          instituteId: String(d.instituteId ?? ''),
        });
      });
    }
  } else {
    // Expansion: every collection BELOW nodeType, keyed by our ancestor field.
    const field = ANCESTOR_FIELD[nodeType as SubNodeType];
    for (const belowType of typesBelow(nodeType)) {
      for (const ids of chunk(nodeIds)) {
        const snap = await db.collection(COLLECTION_OF[belowType]).where(field, 'in', ids).get();
        snap.docs.forEach((doc) => {
          const d = doc.data() as Record<string, unknown>;
          descendants.push({
            id: doc.id,
            status: String(d.status ?? 'active'),
            parentSelectedId: String(d[field] ?? ''),
          });
        });
      }
    }
    const activeDescIds = descendants.filter((d) => d.status === 'active').map((d) => d.id);
    const allMappingNodeIds = [...nodeIds, ...activeDescIds];
    for (const ids of chunk(allMappingNodeIds)) {
      const snap = await db.collection('academicMappings').where('nodeId', 'in', ids).get();
      snap.docs.forEach((doc) => {
        const d = doc.data() as Record<string, unknown>;
        mappings.push({
          studentId: String(d.studentId ?? ''),
          nodeId: String(d.nodeId ?? ''),
          instituteId: String(d.instituteId ?? ''),
        });
      });
    }
  }

  // Delta base: existing RULES-sourced members only. Manual members never
  // enter the core, so sync cannot touch them (invariant 2).
  const currentSnap = await db.collection('assessmentMembers')
    .where('assessmentId', '==', assessmentId)
    .where('source', '==', 'rules')
    .get();
  const currentRulesMemberIds = currentSnap.docs.map((d) => String(d.get('studentId')));

  return {
    core: {
      nodeType,
      requestedIds: nodeIds,
      selected,
      descendants,
      mappings,
      instituteStudents,
      currentRulesMemberIds,
    },
    selectedDocs,
  };
}

/** Denormalize name + breadcrumb for each selected node (audit survives renames). */
async function buildNodeSummaries(
  db: FirebaseFirestore.Firestore,
  nodeType: AllocNodeType,
  nodeIds: string[],
  selectedDocs: Map<string, FirebaseFirestore.DocumentData>,
): Promise<{ nodeId: string; nodeName: string; breadcrumb: string; instituteId: string }[]> {
  if (nodeType === 'institute') {
    return nodeIds.map((id) => ({
      nodeId: id,
      nodeName: String(selectedDocs.get(id)?.name ?? id),
      breadcrumb: '',
      instituteId: id,
    }));
  }
  // Collect unique ancestor ids (in hierarchy order) across all selected nodes.
  const ancestorOrder: { field: string; col: string }[] = [
    { field: 'schoolId', col: 'schools' },
    { field: 'levelId', col: 'academicLevels' },
    { field: 'programId', col: 'programs' },
    { field: 'sessionId', col: 'academicSessions' },
    { field: 'yearId', col: 'academicYears' },
    { field: 'semesterId', col: 'semesters' },
    { field: 'courseId', col: 'courses' },
    { field: 'sectionId', col: 'sections' },
  ];
  const wanted = new Map<string, string>(); // ancestorId → collection
  selectedDocs.forEach((d) => {
    ancestorOrder.forEach(({ field, col }) => {
      const id = d[field];
      if (typeof id === 'string' && id) wanted.set(id, col);
    });
  });
  const nameOf = new Map<string, string>();
  const entries = [...wanted.entries()];
  for (const batch of chunk(entries, 100)) {
    const snaps = await db.getAll(...batch.map(([id, col]) => db.collection(col).doc(id)));
    snaps.forEach((s) => { if (s.exists) nameOf.set(s.id, String(s.get('name') ?? s.id)); });
  }
  return nodeIds.map((id) => {
    const d = selectedDocs.get(id) ?? {};
    const parts: string[] = [];
    ancestorOrder.forEach(({ field }) => {
      const aid = (d as Record<string, unknown>)[field];
      if (typeof aid === 'string' && aid && nameOf.has(aid)) parts.push(nameOf.get(aid)!);
    });
    return {
      nodeId: id,
      nodeName: String((d as Record<string, unknown>).name ?? id),
      breadcrumb: parts.join(' › '),
      instituteId: String((d as Record<string, unknown>).instituteId ?? ''),
    };
  });
}

interface ResolveAllocationData {
  assessmentId: string;
  nodeType: AllocNodeType;
  nodeIds: string[];
  expectedVersion: number;
  dryRun: boolean;
}

export const resolveAllocation = onCall<ResolveAllocationData>(
  CALLABLE_BASE,
  async (request) => {
    requireWebOwner(request);
    const { assessmentId, nodeType, nodeIds, expectedVersion, dryRun } =
      request.data || ({} as ResolveAllocationData);

    if (!assessmentId || typeof assessmentId !== 'string') {
      throw new HttpsError('invalid-argument', 'assessmentId is required.');
    }
    if (!Array.isArray(nodeIds) || nodeIds.some((id) => typeof id !== 'string')) {
      throw new HttpsError('invalid-argument', 'nodeIds must be an array of ids.');
    }
    if (typeof expectedVersion !== 'number' || expectedVersion < 0) {
      throw new HttpsError('invalid-argument', 'expectedVersion is required (0 for a first materialization).');
    }

    const db = getFirestore();
    const assessmentRef = db.collection('assessments').doc(assessmentId);
    const aSnap = await assessmentRef.get();
    if (!aSnap.exists || aSnap.get('isDeleted') === true) {
      throw new HttpsError('not-found', 'Assessment not found.');
    }

    const { core, selectedDocs } = await fetchCoreInput(db, assessmentId, nodeType, nodeIds);
    const result = resolveCore(core);

    // Live-shrink guard (system plan D7): while an exam is ACTIVE the list may
    // only grow. Draft/closed assessments may shrink freely — that's editing.
    const isActive = aSnap.get('status') === 'active';
    const liveShrink = isActive && result.delta.removed.length > 0;

    if (dryRun) {
      // Sample of the ADDED students with display names (capped — never the
      // whole list in one response; getAllocationPreviewPage pages the rest).
      const sampleIds = result.delta.added.slice(0, 50);
      const sampleStudents: { id: string; name: string; email: string }[] = [];
      for (const ids of chunk(sampleIds, 100)) {
        const snaps = await db.getAll(...ids.map((id) => db.collection('students').doc(id)));
        snaps.forEach((s) => {
          if (s.exists) sampleStudents.push({
            id: s.id,
            name: String(s.get('name') ?? s.id),
            email: String(s.get('email') ?? ''),
          });
        });
      }
      return {
        valid: result.errors.length === 0,
        errors: result.errors,
        commitBlockers: liveShrink
          ? [...result.commitBlockers,
             `This exam is LIVE — the new selection would remove ${result.delta.removed.length} student(s). Removals while live aren't supported.`]
          : result.commitBlockers,
        warnings: result.warnings,
        resolvedCount: result.members.length,
        byNode: result.byNode,
        deltaCounts: { added: result.delta.added.length, removed: result.delta.removed.length },
        sampleStudents,
        isLive: isActive,
      };
    }

    // ── COMMIT ──────────────────────────────────────────────────────
    if (result.errors.length > 0) {
      throw new HttpsError('failed-precondition', result.errors.join(' '));
    }
    if (result.commitBlockers.length > 0) {
      throw new HttpsError('failed-precondition', result.commitBlockers.join(' '));
    }
    if (liveShrink) {
      throw new HttpsError(
        'failed-precondition',
        'This exam is LIVE — the new selection would remove students. Removals while live are not supported.',
      );
    }

    const nodes = await buildNodeSummaries(db, nodeType, nodeIds, selectedDocs);
    const memberByStudent = new Map(result.members.map((m) => [m.studentId, m]));
    const nowIso = new Date().toISOString();
    const callerUid = request.auth!.uid;
    const allocationRef = db.collection('allocations').doc(assessmentId);
    const auditRef = db.collection('allocationAudit').doc();
    const instituteIds = [...new Set(result.members.map((m) => m.instituteId).filter(Boolean))].sort();
    const smallDelta =
      result.delta.added.length + result.delta.removed.length <= ALLOC_TXN_MEMBER_WRITE_CAP;

    const newVersion = await db.runTransaction(async (txn) => {
      const [allocSnap, freshA] = await Promise.all([txn.get(allocationRef), txn.get(assessmentRef)]);
      const currentVersion = allocSnap.exists ? Number(allocSnap.get('version') ?? 0) : 0;
      if (currentVersion !== expectedVersion) {
        throw new HttpsError('aborted', 'ALLOCATION_CHANGED — the allocation was modified elsewhere. Re-preview and try again.');
      }
      // Re-check liveness INSIDE the transaction (it may have flipped since the read above).
      if (freshA.get('status') === 'active' && result.delta.removed.length > 0) {
        throw new HttpsError('failed-precondition', 'This exam is LIVE — removals are not supported.');
      }

      const version = currentVersion + 1;
      txn.set(allocationRef, {
        assessmentId,
        ownerType: 'webOwner',
        version,
        status: 'confirmed',
        nodeType,
        nodeIds,
        nodes,
        instituteId: nodeType === 'institute' ? '*' : (nodes[0]?.instituteId ?? ''),
        resolvedCount: result.members.length,
        resolvedInstituteIds: instituteIds,
        lastMaterializedAt: nowIso,
        lastMaterializedBy: callerUid,
        ...(allocSnap.exists ? {} : { createdAt: nowIso }),
        updatedAt: nowIso,
        materializing: !smallDelta,
      }, { merge: true });

      // Stamp the mode AND denormalize the resolved head-count onto the
      // assessment doc. The count matters because every STAFF surface (list
      // rows, roster, export) reads the assessment doc and nothing else:
      // `allocations` and `assessmentMembers` are webOwner-only in the rules,
      // so an institute admin or faculty member physically cannot read them.
      // Without this field they fall back to `assignedTo`, which is empty for
      // a rule-allocated exam — that is the "0 Students" bug.
      //
      // This is a display counter, never an authorization input. The exam gate
      // remains the materialized assessmentMembers list (invariant 6); nothing
      // reads allocatedCount to decide who may sit the exam.
      txn.set(assessmentRef, {
        allocationMode: 'rules',
        allocatedCount: result.members.length,
      }, { merge: true });

      if (smallDelta) {
        result.delta.added.forEach((sid) => {
          const m = memberByStudent.get(sid)!;
          txn.set(db.collection('assessmentMembers').doc(`${assessmentId}_${sid}`), {
            assessmentId,
            studentId: sid,
            instituteId: m.instituteId,
            source: 'rules',
            active: true,
            viaNodeIds: m.viaNodeIds,
            admittedByVersion: version,
            addedBy: callerUid,
            createdAt: nowIso,
          });
        });
        result.delta.removed.forEach((sid) => {
          txn.delete(db.collection('assessmentMembers').doc(`${assessmentId}_${sid}`));
        });
      }

      txn.set(auditRef, {
        assessmentId,
        version,
        actorUid: callerUid,
        actorRole: 'webOwner',
        action: allocSnap.exists ? (result.delta.removed.length > 0 || result.delta.added.length > 0 ? 'sync' : 'materialize') : 'create',
        delta: {
          addedStudentIds: result.delta.added.slice(0, AUDIT_DELTA_ID_CAP),
          removedStudentIds: result.delta.removed.slice(0, AUDIT_DELTA_ID_CAP),
        },
        deltaCounts: { added: result.delta.added.length, removed: result.delta.removed.length },
        truncated:
          result.delta.added.length > AUDIT_DELTA_ID_CAP ||
          result.delta.removed.length > AUDIT_DELTA_ID_CAP,
        allocationSnapshot: { nodeType, nodeIds, nodes },
        manualStudent: null,
        isLive: freshA.get('status') === 'active',
        at: nowIso,
      });

      return version;
    });

    // Large-delta overflow: member docs land via BulkWriter AFTER the txn.
    // Safe because a partially-written window only means "not admitted YET" —
    // a member doc either exists or it doesn't (additions), and removals only
    // occur on non-active assessments (guarded above).
    if (!smallDelta) {
      const writer = db.bulkWriter();
      result.delta.added.forEach((sid) => {
        const m = memberByStudent.get(sid)!;
        writer.set(db.collection('assessmentMembers').doc(`${assessmentId}_${sid}`), {
          assessmentId,
          studentId: sid,
          instituteId: m.instituteId,
          source: 'rules',
          active: true,
          viaNodeIds: m.viaNodeIds,
          admittedByVersion: newVersion,
          addedBy: callerUid,
          createdAt: nowIso,
        });
      });
      result.delta.removed.forEach((sid) => {
        writer.delete(db.collection('assessmentMembers').doc(`${assessmentId}_${sid}`));
      });
      await writer.close();
      await allocationRef.update({ materializing: false });
    }

    return {
      version: newVersion,
      resolvedCount: result.members.length,
      deltaCounts: { added: result.delta.added.length, removed: result.delta.removed.length },
    };
  },
);

interface AddManualMemberData {
  assessmentId: string;
  studentId: string;
}

export const addManualMember = onCall<AddManualMemberData>(
  CALLABLE_BASE,
  async (request) => {
    requireWebOwner(request);
    const { assessmentId, studentId } = request.data || ({} as AddManualMemberData);
    if (!assessmentId || !studentId) {
      throw new HttpsError('invalid-argument', 'assessmentId and studentId are required.');
    }

    const db = getFirestore();
    const aSnap = await db.collection('assessments').doc(assessmentId).get();
    if (!aSnap.exists || aSnap.get('isDeleted') === true) {
      throw new HttpsError('not-found', 'Assessment not found.');
    }
    if (aSnap.get('allocationMode') !== 'rules') {
      throw new HttpsError('failed-precondition', 'Manual members apply to rule-allocated assessments only. Use the legacy targeting controls otherwise.');
    }
    // Deliberately NO same-institute requirement: this is the external/retest
    // escape hatch (system plan D8), and it is webOwner-only by construction.
    const sSnap = await db.collection('students').doc(studentId).get();
    if (!sSnap.exists) throw new HttpsError('not-found', 'Student not found.');

    const memberRef = db.collection('assessmentMembers').doc(`${assessmentId}_${studentId}`);
    const existing = await memberRef.get();
    if (existing.exists) {
      // Idempotent: already a member (via rules or a previous manual add) —
      // no duplicate doc, no duplicate audit entry.
      return { ok: true, alreadyMember: true, source: existing.get('source') };
    }

    const nowIso = new Date().toISOString();
    const allocSnap = await db.collection('allocations').doc(assessmentId).get();
    const version = allocSnap.exists ? Number(allocSnap.get('version') ?? 0) : 0;

    const batch = db.batch();
    batch.set(memberRef, {
      assessmentId,
      studentId,
      instituteId: String(sSnap.get('instituteId') ?? ''),
      source: 'manual',
      active: true,
      viaNodeIds: [],
      admittedByVersion: version,
      addedBy: request.auth!.uid,
      createdAt: nowIso,
    });
    batch.set(db.collection('allocationAudit').doc(), {
      assessmentId,
      version,
      actorUid: request.auth!.uid,
      actorRole: 'webOwner',
      action: 'manual_add',
      delta: { addedStudentIds: [studentId], removedStudentIds: [] },
      deltaCounts: { added: 1, removed: 0 },
      truncated: false,
      allocationSnapshot: null,
      manualStudent: { studentId, name: String(sSnap.get('name') ?? studentId) },
      isLive: aSnap.get('status') === 'active',
      at: nowIso,
    });
    batch.update(db.collection('allocations').doc(assessmentId),
      allocSnap.exists ? { manualCount: FieldValue.increment(1), updatedAt: nowIso } : {});
    if (!allocSnap.exists) {
      // Rule-path assessment without an allocation doc shouldn't happen
      // (allocationMode is set by resolveAllocation), but never fail the add
      // over a missing summary counter.
      batch.set(db.collection('allocations').doc(assessmentId), {
        assessmentId, manualCount: 1, updatedAt: nowIso,
      }, { merge: true });
    }
    // Keep the denormalized staff-facing head-count in step with the member
    // list. resolveAllocation writes it absolutely (it knows the whole set);
    // here we only know we added exactly one, so increment. Guarded by the
    // `existing.exists` early-return above, so this can't double-count.
    batch.set(db.collection('assessments').doc(assessmentId), {
      allocatedCount: FieldValue.increment(1),
    }, { merge: true });
    await batch.commit();

    return { ok: true, alreadyMember: false };
  },
);

interface GetAllocationPreviewPageData {
  assessmentId: string;
  limit?: number;
  cursor?: string;          // last member doc id from the previous page
  source?: 'rules' | 'manual';
}

export const getAllocationPreviewPage = onCall<GetAllocationPreviewPageData>(
  CALLABLE_BASE,
  async (request) => {
    requireWebOwner(request);
    const { assessmentId, limit, cursor, source } = request.data || ({} as GetAllocationPreviewPageData);
    if (!assessmentId) throw new HttpsError('invalid-argument', 'assessmentId is required.');
    const pageSize = Math.min(Math.max(Number(limit) || 100, 1), 200);

    const db = getFirestore();
    let q = db.collection('assessmentMembers')
      .where('assessmentId', '==', assessmentId) as FirebaseFirestore.Query;
    if (source === 'rules' || source === 'manual') q = q.where('source', '==', source);
    q = q.orderBy('__name__').limit(pageSize);
    if (cursor && typeof cursor === 'string') {
      q = q.startAfter(db.collection('assessmentMembers').doc(cursor));
    }
    const snap = await q.get();

    // Join display names for exactly this page (never the whole list).
    const rowsRaw = snap.docs.map((d) => ({
      docId: d.id,
      studentId: String(d.get('studentId')),
      instituteId: String(d.get('instituteId') ?? ''),
      source: String(d.get('source')),
      viaNodeIds: (d.get('viaNodeIds') as string[] | undefined) ?? [],
      addedBy: String(d.get('addedBy') ?? ''),
      createdAt: String(d.get('createdAt') ?? ''),
    }));
    const nameOf = new Map<string, { name: string; email: string }>();
    for (const ids of chunk(rowsRaw.map((r) => r.studentId), 100)) {
      const snaps = await db.getAll(...ids.map((id) => db.collection('students').doc(id)));
      snaps.forEach((s) => {
        if (s.exists) nameOf.set(s.id, {
          name: String(s.get('name') ?? s.id),
          email: String(s.get('email') ?? ''),
        });
      });
    }
    const rows = rowsRaw.map((r) => ({
      ...r,
      name: nameOf.get(r.studentId)?.name ?? r.studentId,
      email: nameOf.get(r.studentId)?.email ?? '',
    }));

    return {
      rows,
      nextCursor: snap.docs.length === pageSize ? snap.docs[snap.docs.length - 1].id : null,
    };
  },
);

// ══════════════════════════════════════════════════════════════════
// SESSION REVOCATION (Remediation plan Batch A, issue #12)
// ══════════════════════════════════════════════════════════════════
// revokeSessions — invalidates every refresh token for the CALLER's own
// account, signing out all other devices. Wired to the "Sign out of all
// other devices" action on the Security pages, and intended to be called
// after a successful password change so a stolen session doesn't outlive
// the credential that created it.
//
// Self-only by design: no admin variant here. Revoking OTHER users'
// sessions (e.g. webOwner force-logout of a compromised account) should be
// added as a separate, explicitly-authorised callable when needed.
//
// Note: ID tokens already minted stay valid up to 1h (Firebase constant);
// revocation bites at the next token refresh. The caller's CURRENT session
// also gets revoked — the client should re-authenticate or treat its own
// session as ending, which is acceptable for both trigger paths (password
// change re-prompts; explicit "sign out everywhere" expects it).

export const revokeSessions = onCall(
  CALLABLE_BASE,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    await getAuth().revokeRefreshTokens(request.auth.uid);
    return { ok: true, revokedAt: new Date().toISOString() };
  },
);

// ══════════════════════════════════════════════════════════════════
// ACCOUNT ACCESS — making "disabled" mean disabled
// ══════════════════════════════════════════════════════════════════
//
// ── WHAT WAS WRONG ────────────────────────────────────────────────
//
// Switching an account off was a bare Firestore write. StudentTab and
// FacultyTab flipped `status: 'disabled'` with a full-document `set`, and
// UserManagementPage did the same for an institute. None of the three touched
// Firebase Auth, and `firestore.rules` reads `status` NOWHERE — the string
// does not appear in that file outside comments and one unrelated
// field-whitelist. So the entire effect of disabling somebody was that the
// login screen would refuse them the next time they visited it.
//
// Concretely, before this: a student disabled mid-morning kept a working
// session for as long as they left the tab open — indefinitely, because
// sessions here never expire — and their ID token still carried
// role:'student', studentId and instituteId, so every rule in the file kept
// passing for direct SDK calls. Disabling a student who was cheating did not
// stop them sitting the exam they were cheating in.
//
// The three client gates (evaluateAccess, via the auth contexts) are a
// courtesy that shapes the UI. They run on the candidate's machine. They were
// never the boundary, and the audit comment on institutes/{id} in
// firestore.rules has said so since C1.
//
// ── WHAT REPLACES IT ──────────────────────────────────────────────
//
// One callable that owns the whole decision, so the Firestore field and the
// Firebase Auth account can never disagree. Disabling now:
//
//   1. sets `disabled: true` on the Auth user   → no new sign-in, no refresh
//   2. revokes every refresh token              → live sessions cannot renew
//   3. writes `status: 'disabled'` on the profile
//
// The client is no longer permitted to do step 3 on its own: `statusUntouched()`
// in firestore.rules rejects any client write that CHANGES `status` on
// students, faculty or institutes, so this endpoint is the only way through
// and the two halves cannot drift apart again.
//
// ── THE HOUR THAT REMAINS, STATED PLAINLY ─────────────────────────
//
// An ID token already minted stays valid until it expires, up to one hour,
// and Cloud Firestore rules do not check token revocation (Realtime Database
// and Cloud Storage do; Firestore would need an auth_time comparison against
// a stored revocation stamp in every rule). So a session open at the moment
// of disabling can keep reading and writing for up to an hour, and then stops
// dead — it cannot refresh.
//
// That is the same posture soft delete has always had (performAccountSoftDelete
// disables the Auth user and accepts the same window), and it is a bounded
// hour against what it replaces, which was forever. Closing it completely
// means an auth_time check in every rule, which costs a document read on the
// exam hot path — see assertInstituteActiveS for why that trade is refused
// there.

type StatusRole = 'institute' | 'faculty' | 'student';

const STATUS_ROLES: StatusRole[] = ['institute', 'faculty', 'student'];

/**
 * Marks a member switched off because their TENANT went off, rather than by
 * someone deciding about them personally.
 *
 * The distinction is what makes reinstatement safe. Without it, bringing a
 * renewed institute back would sweep every account inside it to `active` —
 * including the faculty member an administrator disabled in March for reasons
 * that have not changed. Only accounts carrying this marker come back, and
 * setAccountStatus deletes it whenever a person makes the call by hand, so a
 * manual decision always outranks the sweep.
 */
const SUSPENDED_BY_TENANT = 'instituteSuspended';

/**
 * Make an account's Auth state match a decision that has just been taken.
 *
 * ORDER MATTERS WHEN DISABLING. `updateUser({disabled})` first, then revoke:
 * disabling stops the next refresh, revoking invalidates the refresh tokens
 * that already exist. Doing only the first leaves a token that a client may
 * still present until it expires; doing only the second lets the account sign
 * in again from scratch with its password. Both, in that order, is what
 * "switched off" means.
 *
 * A missing Auth user is not an error. Profile documents outlive their Auth
 * users — a purge that half-completed, a record migrated in from before the
 * Auth wiring — and refusing to update the profile because the account it
 * points at is already gone would leave the row unmanageable forever.
 */
async function applyAuthAccess(uid: string, enabled: boolean): Promise<void> {
  const auth = getAuth();
  try {
    await auth.updateUser(uid, { disabled: !enabled });
    if (!enabled) await auth.revokeRefreshTokens(uid);
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === 'auth/user-not-found') {
      console.warn(`[accountAccess] no Auth user for ${uid} — profile updated regardless`);
      return;
    }
    throw err;
  }
}

interface SetAccountStatusData {
  role: StatusRole;
  uid: string;
  status: 'active' | 'disabled';
}

export const setAccountStatus = onCall<SetAccountStatusData>(
  // Longer than the 60s default because disabling an institute cascades to its
  // members. The cascade is budgeted well inside this (TENANT_CALLABLE_BUDGET_MS)
  // and hands whatever it does not finish to the hourly sweep, so the ceiling
  // is headroom rather than something a normal call approaches.
  { ...CALLABLE_BASE, timeoutSeconds: 120 },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');

    const { role, uid, status } = request.data || ({} as SetAccountStatusData);
    if (!STATUS_ROLES.includes(role)) {
      throw new HttpsError('invalid-argument', 'role must be institute, faculty or student.');
    }
    if (typeof uid !== 'string' || !uid) {
      throw new HttpsError('invalid-argument', 'uid is required.');
    }
    if (status !== 'active' && status !== 'disabled') {
      throw new HttpsError('invalid-argument', "status must be 'active' or 'disabled'.");
    }

    const db = getFirestore();
    const actor = actorFrom(request);
    const profileRef = db.collection(COLLECTION_BY_ROLE[role]).doc(uid);
    const snap = await profileRef.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Account not found.');

    // ── AuthZ ─────────────────────────────────────────────────────
    // Deliberately narrower than firestore.rules was. Faculty could update
    // student documents under the old rule, which meant any faculty member
    // could disable any student in their institute; nothing in the product
    // offers that, so it is not carried forward here. Turning a tenant off
    // stays a Web Owner act — an institute able to switch itself back on is
    // the self-reinstatement escalation C1 closed.
    if (actor.actorRole !== 'webOwner') {
      const targetInstituteId =
        role === 'institute' ? uid : ((snap.get('instituteId') as string) ?? null);
      const governs =
        actor.actorRole === 'institute'
        && role !== 'institute'
        && !!actor.instituteId
        && actor.instituteId === targetInstituteId;
      if (!governs) throw new HttpsError('permission-denied', 'Insufficient permissions.');
    }

    // A soft-deleted record is the deletion system's to manage. Re-enabling
    // one here would hand sign-in back to an account someone deleted, without
    // the restore path's audit row or its lifecycle bookkeeping.
    if (snap.get('lifecycleState') === 'softDeleted') {
      throw new HttpsError(
        'failed-precondition',
        'This account is deleted. Restore it from Deleted accounts first.',
      );
    }

    // Re-enabling a member of an expired or disabled tenant would produce an
    // account that is active on paper and refused at the door — and, worse,
    // one whose Auth user we had just switched back on. The tenant comes back
    // first; the cascade below then sweeps its members.
    if (status === 'active' && role !== 'institute') {
      const instituteId = (snap.get('instituteId') as string) ?? null;
      const instSnap = instituteId
        ? await db.collection('institutes').doc(instituteId).get()
        : null;
      if (!instSnap?.exists) {
        throw new HttpsError('failed-precondition', 'This account has no live institute.');
      }
      assertInstituteActiveS(instSnap);
    }

    // Same rule one level up, and it has to be checked HERE rather than left
    // to the cascade. Without it, enabling a lapsed tenant would succeed, the
    // reconcile immediately behind it would find the window still closed, and
    // it would switch the institute straight back off — a success message
    // followed by a row that flips back, with nothing said about why.
    if (status === 'active' && role === 'institute' && hasExpiredS(snap.get('activeUntil'))) {
      throw new HttpsError(
        'failed-precondition',
        "This institute's access period has expired. Extend its validity to restore access.",
      );
    }

    // Auth FIRST when switching off, so a failure here cannot leave a profile
    // marked disabled while the account it names still signs in. The reverse
    // order on the way back on, for the same reason read the other way round.
    if (status === 'disabled') {
      try {
        await applyAuthAccess(uid, false);
      } catch (err) {
        console.error('[setAccountStatus] could not disable auth user', uid, err);
        throw new HttpsError('internal', 'Could not revoke sign-in for this account.');
      }
    }

    await profileRef.update({
      status,
      // Clearing the marker matters: a person re-enabling an account by hand
      // is overriding the sweep, and leaving the flag set would let the next
      // renewal "restore" an account nobody had suspended.
      accessSuspendedReason: FieldValue.delete(),
      accessSuspendedAt: FieldValue.delete(),
      updatedAt: new Date().toISOString(),
    });

    if (status === 'active') {
      try {
        await applyAuthAccess(uid, true);
      } catch (err) {
        console.error('[setAccountStatus] could not re-enable auth user', uid, err);
        throw new HttpsError('internal', 'Could not restore sign-in for this account.');
      }
    }

    // SWITCHING A TENANT OFF SWITCHES ITS PEOPLE OFF. The client gate has
    // always read it that way — evaluateAccess refuses a member whose
    // institute is disabled — so stopping at the admin's own account would
    // leave every faculty member and student of a disabled institute holding
    // a working session, which is the same hole one level down.
    //
    // Shared with the expiry sweep rather than written twice: an institute is
    // off because it was disabled or because its window closed, and the two
    // must not be able to disagree about what that does to the people inside.
    let cascade: { changed: number; finished: boolean } | null = null;
    if (role === 'institute') {
      // Re-read: the reconcile decides from `status`, `activeUntil` and the
      // sweep marker, and the update above has just changed two of those.
      const fresh = await profileRef.get();
      const result = await reconcileInstituteAccess(db, fresh, Date.now() + TENANT_CALLABLE_BUDGET_MS);
      cascade = { changed: result.changed, finished: result.finished };
    }

    console.info(
      `[setAccountStatus] ${role}/${uid} → ${status} by ${actor.actorRole}/${actor.actorUid}`
      + (cascade ? ` cascade=${cascade.changed} finished=${cascade.finished}` : ''),
    );
    return { ok: true, status, cascade };
  },
);

// ══════════════════════════════════════════════════════════════════
// TENANT ACCESS — an institute going off takes its people with it
// ══════════════════════════════════════════════════════════════════
//
// Two ways a tenant goes off, treated as one throughout: a Web Owner disabled
// it, or its `activeUntil` window closed. The client gate has always collapsed
// them — evaluateAccess refuses a member whose institute is disabled OR
// expired, without distinguishing — so enforcing them separately here is how
// the two halves would drift apart.
//
// `activeUntil` is how a Web Owner sells a fixed access period, and until now
// it was enforced in exactly two places: the login screens, and
// assertInstituteActiveS on the four administrative callables that happened to
// have the institute document in hand already. Neither reaches a session that
// is already open, and neither reaches a student sitting an exam.
//
// So an institute whose access period ended kept every one of its faculty and
// students working normally, indefinitely, as long as they did not sign out.
// The commercial gate was a label.
//
// This sweep makes the lapse real: at the moment the window closes, every
// member of the tenant is switched off through the same path a person would
// use, and marked with WHY, so renewal can put back exactly the accounts the
// lapse took and nothing else.
//
// ── WHY MARK, RATHER THAN JUST DISABLE ────────────────────────────
//
// Renewal has to be able to distinguish "off because the institute lapsed"
// from "off because an administrator switched this person off in March".
// Without the marker, restoring a renewed tenant would silently reinstate
// every individually-disabled account inside it. `accessSuspendedReason`
// carries that distinction, and setAccountStatus deletes it whenever a person
// makes the decision by hand — a manual override outranks the sweep.

/** Members are paged rather than loaded whole; institutes run to thousands. */
const TENANT_PAGE_SIZE = 400;
/** Auth writes are the slow part. Enough concurrency to matter, not enough to throttle. */
const TENANT_CONCURRENCY = 12;
/** Leaves headroom inside the sweep's 540s timeout to finish the institute in progress. */
const TENANT_SWEEP_BUDGET_MS = 7 * 60 * 1000;
/**
 * The slice a CALLABLE may do inline before handing the rest to the sweep.
 *
 * A Web Owner disabling a tenant of ten thousand students cannot wait for ten
 * thousand Auth writes, and a callable that tried would hit its own timeout
 * and report failure for work that had largely succeeded. The part that must
 * be immediate — the institute admin's own account — is already done before
 * the cascade starts; the members are best-effort here and guaranteed by the
 * sweep, which is why that runs hourly rather than nightly.
 */
const TENANT_CALLABLE_BUDGET_MS = 45 * 1000;

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      await fn(items[index]);
    }
  });
  await Promise.all(workers);
}

/**
 * Switch every member of one institute on or off.
 *
 * RESUMABLE BY CONSTRUCTION. Each document is compared against the state it is
 * being moved to and skipped if it is already there, so a run that exhausts
 * its budget half way costs the next run some reads and no duplicated Auth
 * writes. That is why paging by document snapshot is enough and no cursor is
 * persisted anywhere.
 *
 * ── ORDER, AND WHY IT DIFFERS BY DIRECTION ────────────────────────
 *
 * Switching OFF: Auth first. A failure then leaves an account that still signs
 * in and whose profile still says `active` — visibly untouched, and retried on
 * the next run. Writing the profile first would leave one marked disabled
 * while the account it names still worked, which is precisely the split this
 * whole change exists to remove.
 *
 * Switching ON: profile first. A failure then leaves an account marked active
 * that cannot sign in — locked out, but not let in. The other order would
 * re-enable a Firebase Auth account while its profile still read `disabled`,
 * and since these rules do not gate on `status`, that account would have full
 * data access with nothing on the record saying it should.
 *
 * Never touches a soft-deleted record. Those are disabled already, and
 * re-enabling one on renewal would resurrect an account someone deleted.
 */
async function sweepInstituteMembers(
  db: FirebaseFirestore.Firestore,
  instituteId: string,
  direction: 'suspend' | 'restore',
  deadline: number,
): Promise<{ changed: number; finished: boolean }> {
  let changed = 0;
  let failed = 0;

  for (const collection of ['faculty', 'students']) {
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    for (;;) {
      if (Date.now() > deadline) return { changed, finished: false };

      let query = db.collection(collection)
        .where('instituteId', '==', instituteId)
        .orderBy('__name__')
        .limit(TENANT_PAGE_SIZE);
      // The snapshot rather than its id: `startAfter` resolves a snapshot
      // against the query's own ordering, where a bare string would have to be
      // interpreted as a document path.
      if (cursor) query = query.startAfter(cursor);

      const page = await query.get();
      if (page.empty) break;
      cursor = page.docs[page.docs.length - 1];

      const targets = page.docs.filter((doc) => {
        if (doc.get('lifecycleState') === 'softDeleted') return false;
        return direction === 'suspend'
          // Already off — by the sweep or by an administrator — is already
          // where we want it, and re-disabling would waste an Auth write.
          ? doc.get('status') !== 'disabled'
          // Only what THIS sweep switched off comes back. An account an
          // administrator disabled stays disabled through a renewal.
          : doc.get('accessSuspendedReason') === SUSPENDED_BY_TENANT;
      });

      await mapWithConcurrency(targets, TENANT_CONCURRENCY, async (doc) => {
        try {
          if (direction === 'suspend') {
            await applyAuthAccess(doc.id, false);
            await doc.ref.update({
              status: 'disabled',
              accessSuspendedReason: SUSPENDED_BY_TENANT,
              accessSuspendedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
          } else {
            await doc.ref.update({
              status: 'active',
              accessSuspendedReason: FieldValue.delete(),
              accessSuspendedAt: FieldValue.delete(),
              updatedAt: new Date().toISOString(),
            });
            try {
              await applyAuthAccess(doc.id, true);
            } catch (err) {
              // The marker is what makes this member visible to the next run,
              // and it has just been cleared. Put it back, or this account is
              // stranded: disabled in Auth, `active` on paper, and matching no
              // filter that would ever look at it again.
              await doc.ref.update({
                status: 'disabled',
                accessSuspendedReason: SUSPENDED_BY_TENANT,
                accessSuspendedAt: new Date().toISOString(),
              });
              throw err;
            }
          }
          changed++;
        } catch (err) {
          // One member failing must not abandon the rest of the tenant. It is
          // counted rather than swallowed: a pass with any failure is reported
          // unfinished, which withholds the `accessSweepState` marker and so
          // brings the next run back to try again.
          failed++;
          console.error(`[tenantAccess] ${direction} failed for ${collection}/${doc.id}`, err);
        }
      });

      if (page.size < TENANT_PAGE_SIZE) break;
    }
  }

  // A pass that could not move every member it found is not a finished pass,
  // whatever the reason. Reporting otherwise would stamp the sweep marker and
  // put this institute on the cheap path, where nothing looks at its members
  // again until the tenant's state next changes.
  return { changed, finished: failed === 0 };
}

/**
 * The institute admin's own account, which is the institute document's uid.
 *
 * Kept separate from the member sweep because the shapes differ: there is no
 * `instituteId` field to query on, and the institute's own `status` is the Web
 * Owner's own switch. A tenant that lapsed AND was disabled by hand must not
 * come back to `active` when the invoice is paid — so only a document this
 * sweep marked is restored, exactly as for members.
 */
async function sweepInstituteAdmin(
  instSnap: FirebaseFirestore.DocumentSnapshot,
  direction: 'suspend' | 'restore',
): Promise<boolean> {
  const suspendedByUs = instSnap.get('accessSuspendedReason') === SUSPENDED_BY_TENANT;
  if (direction === 'suspend') {
    // Already off: either a Web Owner disabled it (setAccountStatus has
    // already revoked the Auth account) or a previous run got here first.
    if (instSnap.get('status') === 'disabled') return false;
    await applyAuthAccess(instSnap.id, false);
    await instSnap.ref.update({
      status: 'disabled',
      accessSuspendedReason: SUSPENDED_BY_TENANT,
      accessSuspendedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return true;
  }
  if (!suspendedByUs) return false;
  await instSnap.ref.update({
    status: 'active',
    accessSuspendedReason: FieldValue.delete(),
    accessSuspendedAt: FieldValue.delete(),
    updatedAt: new Date().toISOString(),
  });
  try {
    await applyAuthAccess(instSnap.id, true);
  } catch (err) {
    // The marker is what makes this institute recognisable as ours to restore,
    // and it has just been cleared. Put it back, or the tenant is stranded:
    // disabled in Auth, `active` on paper, and no longer matching the one
    // condition under which anything would look at it again.
    await instSnap.ref.update({
      status: 'disabled',
      accessSuspendedReason: SUSPENDED_BY_TENANT,
      accessSuspendedAt: new Date().toISOString(),
    });
    throw err;
  }
  return true;
}

/**
 * Bring one institute's people into line with whether the tenant is on.
 *
 * ── WHAT "OFF" MEANS ──────────────────────────────────────────────
 *
 * Two things, deliberately treated as one: a Web Owner disabled the institute,
 * or its `activeUntil` window closed. The client gate has always collapsed
 * them — evaluateAccess refuses a member whose institute is disabled OR
 * expired, without distinguishing — so enforcing them differently on the
 * server is how the two halves would drift apart.
 *
 * ── THE CHEAP PATH IS THE COMMON ONE ──────────────────────────────
 *
 * `accessSweepState` records the state the members were last swept INTO, and
 * is written only when a sweep ran to completion. When it already matches
 * where the tenant is, this returns without reading a single member document
 * — which is every institute on almost every run. Without it, an hourly sweep
 * would page every student of every tenant to discover there was nothing to
 * do.
 *
 * A partial run leaves the marker unwritten, so the next run resumes. That is
 * safe because both directions are idempotent per document: each member is
 * compared against the state it is being moved to and skipped if already
 * there.
 *
 * Shared by the hourly sweep, the manual reconcile and setAccountStatus, so a
 * Web Owner disabling a tenant and a window closing on its own reach exactly
 * the same place by exactly the same code.
 */
async function reconcileInstituteAccess(
  db: FirebaseFirestore.Firestore,
  instSnap: FirebaseFirestore.DocumentSnapshot,
  deadline: number,
): Promise<{ direction: 'suspend' | 'restore' | 'none'; changed: number; finished: boolean }> {
  // A deleted tenant belongs to the deletion system, not to this one. Its
  // members are already disabled, and restoring one here would hand sign-in
  // back to an account someone deleted.
  if (instSnap.get('lifecycleState') === 'softDeleted') {
    return { direction: 'none', changed: 0, finished: true };
  }

  // WHOSE `disabled` IS THIS? The suspend path writes `status: 'disabled'` on
  // the institute document itself, so reading that field back naively makes
  // the sweep's own output an input: a lapsed tenant would be permanently off,
  // because extending its validity would clear the expiry while leaving behind
  // the `disabled` the sweep had written — and that alone would keep tenantOff
  // true forever. Renewal would never restore anybody.
  //
  // The marker is what separates the two. A `disabled` this sweep wrote is not
  // a decision, it is the record of one already accounted for here; a
  // `disabled` with no marker is a person's decision and does count. That
  // asymmetry is also what makes a manual disable outrank a renewal: extending
  // the validity of a tenant a Web Owner had switched off by hand leaves it
  // switched off, which is the right answer.
  const suspendedByUs = instSnap.get('accessSuspendedReason') === SUSPENDED_BY_TENANT;
  const disabledByPerson = instSnap.get('status') === 'disabled' && !suspendedByUs;
  const tenantOff = disabledByPerson || hasExpiredS(instSnap.get('activeUntil'));

  const desired = tenantOff ? 'suspended' : 'active';
  const swept = instSnap.get('accessSweepState');
  if (swept === desired) {
    return { direction: 'none', changed: 0, finished: true };
  }

  // FIRST RUN ON A HEALTHY TENANT IS FREE. An institute that has never been
  // swept and is not off has nothing to restore: SUSPENDED_BY_TENANT is
  // written only by the code below, so before it has ever run there are no
  // markers to find. Without this, deploying would page every student of every
  // tenant on the first run to discover exactly that.
  if (swept === undefined && !tenantOff) {
    await instSnap.ref.update({ accessSweepState: 'active' });
    return { direction: 'none', changed: 0, finished: true };
  }

  const direction = tenantOff ? 'suspend' : 'restore';
  const adminChanged = await sweepInstituteAdmin(instSnap, direction);
  const members = await sweepInstituteMembers(db, instSnap.id, direction, deadline);

  // Only on a complete pass. A marker written after a partial sweep would tell
  // every later run there was nothing left to do, stranding whichever members
  // the budget did not reach.
  if (members.finished) {
    await instSnap.ref.update({ accessSweepState: desired });
  }

  return {
    direction,
    changed: members.changed + (adminChanged ? 1 : 0),
    finished: members.finished,
  };
}

/**
 * HOURLY, not nightly, and the cadence is doing two jobs.
 *
 * It bounds how long an expiry goes unenforced: a window that closes at 14:00
 * is acted on by 15:00, rather than at the following 02:00. And it is the
 * backstop for whatever a callable's cascade could not finish inline — a Web
 * Owner disabling a tenant of ten thousand students gets the admin account off
 * immediately and the members within the hour, instead of within the day.
 *
 * Hourly is affordable because of `accessSweepState`: an institute already in
 * the state it should be in costs one field comparison and no member reads at
 * all, so the steady-state run is a single collection read of `institutes`.
 */
export const scheduledEnforceTenantAccess = onSchedule(
  { schedule: 'every 60 minutes', timeZone: 'Etc/UTC', region: 'us-central1', timeoutSeconds: 540 },
  async () => {
    const db = getFirestore();
    const deadline = Date.now() + TENANT_SWEEP_BUDGET_MS;

    // Read every institute rather than querying on `activeUntil`. There are
    // tens to hundreds of tenants on this platform, the field is a string in
    // two different shapes, and expiry is decided by hasExpiredS rather than by
    // a comparison Firestore can index. One whole-collection read an hour is
    // cheaper than the index and the shape migration it would take to avoid it.
    const institutes = await db.collection('institutes').get();

    let suspended = 0;
    let restored = 0;
    let incomplete = 0;

    for (const instSnap of institutes.docs) {
      if (Date.now() > deadline) {
        console.warn('[tenantAccess] budget exhausted — remaining institutes wait for the next run');
        incomplete++;
        break;
      }
      try {
        const result = await reconcileInstituteAccess(db, instSnap, deadline);
        if (result.direction === 'suspend' && result.changed > 0) suspended++;
        if (result.direction === 'restore' && result.changed > 0) restored++;
        if (!result.finished) incomplete++;
      } catch (err) {
        console.error(`[tenantAccess] institute ${instSnap.id} failed`, err);
      }
    }

    console.log(
      `[tenantAccess] examined=${institutes.size} suspended=${suspended}`
      + ` restored=${restored} incomplete=${incomplete}`,
    );
  },
);

/**
 * Bring one institute back the moment its validity is extended.
 *
 * Called by the Web Owner's edit and extend sheets after they write a new
 * `activeUntil`. The hourly sweep reaches the same state on its own — this
 * exists so a customer who has just renewed is not locked out for up to an
 * hour afterwards.
 */
export const restoreInstituteAccess = onCall<{ instituteId: string }>(
  CALLABLE_BASE,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    if ((request.auth.token.role as string) !== 'webOwner') {
      throw new HttpsError('permission-denied', 'Web Owner only.');
    }
    const { instituteId } = request.data || ({} as { instituteId: string });
    if (typeof instituteId !== 'string' || !instituteId) {
      throw new HttpsError('invalid-argument', 'instituteId is required.');
    }

    const db = getFirestore();
    const snap = await db.collection('institutes').doc(instituteId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Institute not found.');

    const result = await reconcileInstituteAccess(db, snap, Date.now() + TENANT_CALLABLE_BUDGET_MS);
    console.info(
      `[tenantAccess] manual reconcile ${instituteId}`
      + ` direction=${result.direction} changed=${result.changed} finished=${result.finished}`,
    );
    return { ok: true, ...result };
  },
);

// ══════════════════════════════════════════════════════════════════
// CODING — the judging sweep
// ══════════════════════════════════════════════════════════════════
//
// Judging is asynchronous because it has to be: a judge is remote, slow, and
// permitted to be down, and the alternative is an outage that stops students
// finishing an exam. gradeAttempt therefore finalises a paper into manual
// review and sets codeJudgePending; this sweep does the work afterwards and
// rewrites the scores once every coding answer on the paper has settled.
//
// The re-judge path is not a separate mechanism. A submission whose verdict
// never completed simply still has codeJudgePending set, with a backoff saying
// when to try again — so an outage that resolves an hour later is picked up by
// the same loop that judged everything else.

/**
 * Judge every outstanding coding answer on one attempt.
 *
 * Returns whether the paper is now settled — every coding answer either judged
 * or out of retries — which is what clears the pending flag.
 */
async function judgeAttemptCoding(
  db: FirebaseFirestore.Firestore,
  adapter: JudgeAdapter,
  attemptId: string,
): Promise<{ judged: number; settled: boolean }> {
  const attemptSnap = await db.collection('attempts').doc(attemptId).get();
  if (!attemptSnap.exists) return { judged: 0, settled: true };
  const attempt = attemptSnap.data() as {
    assessmentId: string;
    instituteId?: string;
    answers?: Record<string, AttemptAnswerDoc>;
    gradingConfig?: AssessmentGradingConfigS;
  };

  const assessmentSnap = await db.collection('assessments').doc(attempt.assessmentId).get();
  // No assessment means nothing to judge against. Settled, so the flag clears
  // rather than the attempt being retried forever against a missing paper.
  if (!assessmentSnap.exists) return { judged: 0, settled: true };

  // A-05: judge against the paper THIS attempt sat.
  const assessment = examContractFor(
    attempt as unknown as Record<string, unknown>,
    assessmentSnap.data() as Record<string, unknown>,
  ) as GradingAssessmentDoc;
  const sections = normalizeSections(assessment);
  const qIds = Array.from(new Set(
    sections.flatMap((sec) => sec.questions.map((q) => q.questionId)),
  ));
  const { questionMap, answerMap } = await loadQuestionAndAnswerMaps(db, qIds);

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  let judged = 0;
  let outstanding = 0;

  for (const qid of Object.keys(attempt.answers ?? {})) {
    const q = questionMap.get(qid);
    if (q?.engine !== 'code') continue;
    const ans = answerMap.get(qid);
    if (!ans) continue;

    const vRef = db.collection('attemptVerdicts').doc(codeVerdictDocId(attemptId, qid));
    const existing = (await vRef.get()).data() as { state?: JudgeAttemptState } | undefined;
    const state = existing?.state;

    if (!shouldJudgeNow(state, nowMs)) {
      // Not eligible now. Only a submission that is still going to be tried
      // again keeps the paper open; a settled or exhausted one does not.
      const done = state?.lastStatus === 'completed'
                || state?.lastStatus === 'compile_error'
                || judgeExhausted(state);
      if (!done) outstanding++;
      continue;
    }

    const base = {
      attemptId,
      questionId: qid,
      instituteId: attempt.instituteId ?? null,
      updatedAt: nowIso,
    };

    const submission = buildCodeSubmission(q, ans, attempt.answers![qid].value, `${attemptId}:${qid}`);
    if (!submission) {
      // Nothing runnable was submitted — no language, or no source. That is not
      // a judging failure to retry, it is an answer no judge can execute, so it
      // is marked terminally and left in manual review.
      await vRef.set({
        ...base,
        state: { attempts: MAX_JUDGE_ATTEMPTS, lastStatus: 'internal_error' as const },
      }, { merge: true });
      continue;
    }

    // Claim first, so an overlapping sweep skips this submission rather than
    // spending a second judge slot on it. The claim is a lease: if this worker
    // dies now, shouldJudgeNow releases it once the lease expires.
    await vRef.set({ ...base, state: { ...(state ?? { attempts: 0 }), claimedAt: nowIso } }, { merge: true });

    const verdict = await adapter.run(submission);
    const nextState = advanceJudgeState(state, verdict, nowMs);
    await vRef.set({ ...base, verdict, state: nextState }, { merge: true });
    judged++;

    if (!judgeExhausted(nextState)
        && nextState.lastStatus !== 'completed'
        && nextState.lastStatus !== 'compile_error') {
      outstanding++;
    }
  }

  const settled = outstanding === 0;
  if (settled) {
    // Every coding answer has an answer of some kind. Re-score with the
    // verdicts now in place — this is the step that turns a judged submission
    // into a mark, and it is the same scorer every other path uses.
    const codeVerdicts = await loadCodeVerdicts(db, attemptId, questionMap);
    const { scores, gradedAnswers } = scoreAttemptAnswers({
      sections,
      questionMap,
      answerMap,
      codeVerdicts,
      // A paper can carry both a coding answer and an essay. The judge landing
      // must not undo the essay's mark on its way past.
      manualMarks: await loadManualMarks(db, attemptId, questionMap),
      answers: attempt.answers,
      passingScore: assessment.passingScore,
      exposeKeysToStudent: reviewAudienceAllows(assessment, 'students'),
      gradingConfig: attempt.gradingConfig ?? assessment.gradingConfig,
    });
    await attemptSnap.ref.update({
      scores,
      gradedAnswers,
      codeJudgePending: FieldValue.delete(),
      updatedAt: new Date().toISOString(),
    });
  }

  return { judged, settled };
}

// ══════════════════════════════════════════════════════════════════
// CODING — the in-exam sample run
// ══════════════════════════════════════════════════════════════════
//
// The one path where a student's action reaches the judge directly, and the
// only place in the platform where that is true. It exists because writing
// code blind is a test of nerve rather than of programming: every real
// environment lets you run what you wrote, and a candidate who cannot check
// their understanding of the problem is being examined on something else.
//
// It is also, for the same reason, the most abusable surface in the subsystem,
// so it is bounded on two independent axes (a per-question quota and a
// cooldown) and it never, under any circumstance, sends a hidden test to the
// judge or returns one to the browser.

interface RunCodeSampleData {
  attemptId: string;
  questionId: string;
  language: string;
  source: string;
  /** D-01: the browser session driving this sitting (INV-5a). */
  sessionId?: string;
}

// ══════════════════════════════════════════════════════════════════
// CODING — telemetry capture
// ══════════════════════════════════════════════════════════════════
//
// Records what a candidate did while writing, so Stage C's replay and
// similarity work has something to read. Nothing in the grading path consumes
// any of it, and that separation is the point: the moment behaviour affects a
// score, a candidate is being marked on how they worked rather than on what
// they produced.
//
// APPEND-ONLY CHUNKS, never a growing document. Each flush writes a new doc
// with its own sequence number, which avoids the 1 MB document ceiling, avoids
// read-modify-write races between a flush and a submit, and means a record
// cannot be quietly rewritten after the fact — which matters for something
// that may end up being cited about a person.

/** Per call. The client compacts first; this is the backstop against a client that does not. */
const TELEMETRY_MAX_EVENTS_PER_CALL = 500;
/** Per (attempt, question). At one flush every 30s this is several hours of writing. */
const TELEMETRY_MAX_CHUNKS = 400;
const TELEMETRY_MAX_BYTES_PER_CALL = 256 * 1024;

interface RecordTelemetryData {
  attemptId: string;
  questionId: string;
  seq: number;
  events: unknown[];
  /** D-01: the browser session driving this sitting (INV-5a). */
  sessionId?: string;
}

export const recordCodeTelemetry = onCall<RecordTelemetryData>(
  CALLABLE_BASE,
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const callerRole      = request.auth.token.role      as Role   | undefined;
    const callerStudentId = request.auth.token.studentId as string | undefined;

    const { attemptId, questionId, seq, events } = request.data || ({} as RecordTelemetryData);
    if (!attemptId || !questionId) {
      throw new HttpsError('invalid-argument', 'attemptId and questionId are required.');
    }
    if (!Array.isArray(events) || events.length === 0) {
      // Nothing to record is not an error — a flush with an empty buffer is
      // normal when a candidate is reading rather than typing.
      return { ok: true as const, stored: 0 };
    }

    const db = getFirestore();
    const attemptSnap = await db.collection('attempts').doc(attemptId).get();
    if (!attemptSnap.exists) throw new HttpsError('not-found', 'Attempt not found.');
    const attempt = attemptSnap.data() as {
      studentId?: string;
      assessmentId: string;
      instituteId?: string;
      status?: string;
      // D-01/D-03: the session that owns this sitting, and the paper it sat.
      activeSessionId?: string | null;
      examSnapshot?: { sections?: unknown };
    };

    // The owning student only, and only while they are actually sitting. A
    // finished attempt cannot acquire new telemetry — that would let a record
    // be extended after the fact, which is exactly what an append-only log is
    // supposed to prevent.
    if (callerRole !== 'student' || callerStudentId !== attempt.studentId) {
      throw new HttpsError('permission-denied', 'Not your attempt.');
    }
    // ── D-01: and only from the device that owns the sitting ─────
    //
    // The sentence above is the whole reason this gate belongs here. A device
    // that LOST the session can extend the record in exactly the way the
    // comment forbids, and the rows it writes are indistinguishable from the
    // real candidate's — which makes the evidence worse than useless, because
    // it looks authoritative. Every other student-facing exam callable has
    // called assertSession since Phase 2; this one was written afterwards and
    // never acquired it.
    assertSession(attempt, request.data?.sessionId, 'recordCodeTelemetry');
    if (attempt.status !== 'in_progress') {
      throw new HttpsError('failed-precondition', 'This attempt is not in progress.');
    }

    const assessmentSnap = await db.collection('assessments').doc(attempt.assessmentId).get();
    if (!assessmentSnap.exists) throw new HttpsError('not-found', 'Assessment not found.');
    const assessmentRaw = assessmentSnap.data() as Record<string, unknown>;
    const assessment = assessmentRaw as {
      securityTier?: 'mock' | 'normal' | 'high_stake';
      codeTelemetry?: boolean;
      blockedStudents?: string[];
    };

    // ── D-02: an invigilator's block reaches here too ────────────
    //
    // D-21 settled that a block must stop the sitting advancing rather than
    // only a reload, which is why assertNotBlocked sits on both answer paths
    // and both section transitions. B-12 then established that blockedStudents
    // is THE live lever — de-allocating a student mid-sitting deliberately does
    // not eject them, so this list is the whole mechanism.
    //
    // Pulled, it left the coding surface running: the student could not answer,
    // advance or submit, and could still spend judge capacity and still append
    // to their own evidence log. Checked BEFORE the `enabled` return below, so
    // a blocked student is refused whether or not this exam records anything.
    //
    // Read live, never from the snapshot — a block is an invigilation decision
    // taken NOW, which is exactly why examContractFor leaves it out of the
    // frozen contract.
    assertNotBlocked(assessment, attempt.studentId ?? '');

    // ── D-03: and the question must be on the paper THIS student sat ──
    //
    // A-09's shape in the collection built after it: caller-supplied input
    // naming a stored document. The chunk id is
    // `${attemptId}__${questionId}__${seq}`, and questionId arrived straight
    // from request.data with nothing checked — so `NOT_A_QUESTION` produced a
    // real attemptTelemetry row that no attempt could explain, in the
    // collection reviewers read.
    //
    // runCodeSample — its sibling, on the same paper, in the same file —
    // already refuses this in as many words. The two now agree.
    const onPaper = normalizeSections(
      (examContractFor(attempt as unknown as Record<string, unknown>, assessmentRaw)
        ?? assessmentRaw) as GradingAssessmentDoc,
    ).some((sec) => sec.questions.some((q) => q.questionId === questionId));
    if (!onPaper) {
      throw new HttpsError('permission-denied', 'That question is not on your paper.');
    }

    // THE SERVER DECIDES WHETHER ANYONE IS RECORDED. The client makes the same
    // determination to avoid sending pointless traffic, but a client that
    // decides it may record is not a reason to store anything: practice is
    // never recorded, an institution may decline at the proctored tiers, and an
    // assessment that cannot state its tier does not start a recording.
    const tier = assessment.securityTier;
    const enabled =
      tier === 'mock' || tier === undefined ? false : (assessment.codeTelemetry ?? true);
    if (!enabled) {
      return { ok: true as const, stored: 0, recording: false as const };
    }

    if (events.length > TELEMETRY_MAX_EVENTS_PER_CALL) {
      throw new HttpsError('invalid-argument', 'Too many events in one call.');
    }
    const payload = JSON.stringify(events);
    if (Buffer.byteLength(payload, 'utf8') > TELEMETRY_MAX_BYTES_PER_CALL) {
      throw new HttpsError('invalid-argument', 'Telemetry payload too large.');
    }
    const chunk = Number.isInteger(seq) && seq >= 0 ? seq : 0;
    if (chunk >= TELEMETRY_MAX_CHUNKS) {
      // Stop accepting rather than fail the exam over it. A candidate who has
      // written for this long is not the problem, and a rejected flush must
      // never surface as an error in front of someone sitting a paper.
      return { ok: true as const, stored: 0, full: true as const };
    }

    await db.collection('attemptTelemetry')
      .doc(`${attemptId}__${questionId}__${String(chunk).padStart(4, '0')}`)
      .set({
        attemptId,
        questionId,
        instituteId: attempt.instituteId ?? null,
        seq: chunk,
        events,
        createdAt: new Date().toISOString(),
      });

    return { ok: true as const, stored: events.length };
  },
);

export const runCodeSample = onCall<RunCodeSampleData>(
  { ...CALLABLE_BASE, secrets: [JUDGE0_AUTH_TOKEN], ...JUDGE_ACCESS },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign-in required.');
    const callerRole      = request.auth.token.role      as Role   | undefined;
    const callerStudentId = request.auth.token.studentId as string | undefined;

    const { attemptId, questionId, language, source } = request.data || ({} as RunCodeSampleData);
    if (!attemptId || !questionId) {
      throw new HttpsError('invalid-argument', 'attemptId and questionId are required.');
    }
    if (typeof source !== 'string') {
      throw new HttpsError('invalid-argument', 'source must be a string.');
    }

    const db = getFirestore();
    const attemptSnap = await db.collection('attempts').doc(attemptId).get();
    if (!attemptSnap.exists) throw new HttpsError('not-found', 'Attempt not found.');
    const attempt = attemptSnap.data() as {
      studentId?: string;
      assessmentId: string;
      status?: string;
      freezes?: FreezeLedgerEntry[];
      answersLockedAfter?: unknown;
      codeRuns?: Record<string, SampleRunState>;
      /** D-01: which browser session owns this sitting (INV-5a). */
      activeSessionId?: string | null;
    };

    // ── Who ──────────────────────────────────────────────────────
    // The OWNING STUDENT ONLY. Deliberately narrower than gradeAttempt, which
    // also admits graders: a run executes code, and there is no reason for
    // staff to execute a student's code through the student's quota.
    if (callerRole !== 'student' || callerStudentId !== attempt.studentId) {
      throw new HttpsError('permission-denied', 'Not your attempt.');
    }
    // ── D-01: from the device that owns the sitting ──────────────
    //
    // "The student's quota" is the phrase above, and a quota is exactly what a
    // second browser spends. Sample runs are metered — maxPerQuestion, a
    // cooldown, real compute on a shared judge — so a superseded device
    // reaching this is a second person working the paper on the candidate's
    // allowance. INV-5a says one sitting, one session; P-15 proves the loser
    // cannot submit a section, and this is the path where that stopped being
    // true.
    assertSession(attempt, request.data?.sessionId, 'runCodeSample');

    // ── When ─────────────────────────────────────────────────────
    if (attempt.status !== 'in_progress') {
      throw new HttpsError('failed-precondition', 'This attempt is not in progress.');
    }
    // A paused student is paused. Running code during a freeze would be doing
    // the exam while the clock is stopped, which is the one thing a freeze is
    // meant to prevent. Read the same way gradeProvisional reads it.
    if ((attempt.freezes ?? []).some((f) => !f.endedAt)) {
      throw new HttpsError('failed-precondition', 'This attempt is paused.');
    }
    // answersLockedAfter is a Firestore Timestamp on current attempts, an ISO
    // string on legacy ones, and absent on untimed exams. It is the SECTION or
    // OVERALL lock rather than the availability window, which would be the
    // wrong clock to read while a freeze is open — but an open freeze was
    // rejected immediately above, so here the two agree.
    const lockRaw = attempt.answersLockedAfter;
    const lockMs =
      lockRaw instanceof Timestamp ? lockRaw.toMillis()
      : typeof lockRaw === 'string' ? Date.parse(lockRaw)
      : null;
    if (lockMs !== null && Number.isFinite(lockMs) && Date.now() > lockMs) {
      throw new HttpsError('failed-precondition', 'The answer window has closed.');
    }

    // ── What ─────────────────────────────────────────────────────
    // A-05: the paper THIS attempt sat, so a question added to the live
    // assessment mid-exam is not runnable by someone who never received it.
    const assessmentSnap = await db.collection('assessments').doc(attempt.assessmentId).get();
    if (!assessmentSnap.exists) throw new HttpsError('not-found', 'Assessment not found.');
    const assessment = examContractFor(
      attempt as unknown as Record<string, unknown>,
      assessmentSnap.data() as Record<string, unknown>,
    ) as GradingAssessmentDoc & { codingRuns?: Partial<SampleRunConfig> };

    // D-02: the live block, for the reason recordCodeTelemetry's copy of this
    // comment gives — an invigilation decision taken now, which is why
    // examContractFor deliberately lets blockedStudents ride in from the live
    // document rather than freezing it onto the attempt.
    assertNotBlocked(
      assessment as { blockedStudents?: string[] },
      attempt.studentId ?? '',
    );

    const onPaper = normalizeSections(assessment)
      .some((sec) => sec.questions.some((q) => q.questionId === questionId));
    if (!onPaper) throw new HttpsError('permission-denied', 'That question is not on your paper.');

    const [qSnap, aSnap] = await Promise.all([
      db.collection('questions').doc(questionId).get(),
      db.collection('questionAnswers').doc(questionId).get(),
    ]);
    if (!qSnap.exists) throw new HttpsError('not-found', 'Question not found.');
    const q = qSnap.data() as QuestionDoc;
    if (q.engine !== 'code') {
      throw new HttpsError('failed-precondition', 'That question does not run code.');
    }
    const qAns = (aSnap.data() as QuestionAnswerDoc | undefined) ?? {
      id: questionId, correctIds: [], correctPairs: [], modelAnswer: '',
    };

    if (!isJudgeLanguage(language)) {
      throw new HttpsError('invalid-argument', 'Unsupported language.');
    }
    // An author who restricted the languages meant it — running Python against
    // a Java-only question is not a thing the candidate is being examined on.
    const allowed = q.codeSpec?.languages;
    if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes(language)) {
      throw new HttpsError('invalid-argument', 'That language is not allowed for this question.');
    }

    const cfg = resolveSampleRunConfig(assessment.codingRuns);
    if (Buffer.byteLength(source, 'utf8') > cfg.maxSourceBytes) {
      throw new HttpsError('invalid-argument', 'Source is too large to run.');
    }

    // ── How often ────────────────────────────────────────────────
    const state = attempt.codeRuns?.[questionId];
    const nowMs = Date.now();
    const decision = checkSampleRun(state, cfg, nowMs);
    if (!decision.allowed) {
      // Returned rather than thrown. A candidate who has run out of runs, or
      // who pressed the button twice, has done nothing wrong — an error dialog
      // mid-exam reads as "something broke" and costs them attention they do
      // not have to spare.
      return {
        ok: false as const,
        reason: decision.reason,
        remaining: decision.remaining,
        retryAfterMs: decision.retryAfterMs ?? 0,
      };
    }

    // ── Run ──────────────────────────────────────────────────────
    // sampleRunSubmission strips the hidden tests BEFORE the submission is
    // built, so the answer key never reaches the provider at all — not merely
    // never reaches the response.
    const full = buildCodeSubmission(q, qAns, { language, source }, `sample:${attemptId}:${questionId}`);
    if (!full) throw new HttpsError('invalid-argument', 'Nothing to run.');
    const submission = sampleRunSubmission(full);
    if (submission.tests.length === 0) {
      return { ok: false as const, reason: 'no_samples' as const, remaining: decision.remaining, retryAfterMs: 0 };
    }

    const verdict = await getJudgeAdapter().run(submission);

    // C-10: the ONLY record of why a run failed. Every reason the adapter
    // produces — connect timeout, HTTP status, open circuit breaker — is
    // returned to the browser inside the verdict and, before this line, went
    // nowhere else. That made a failing judge diagnosable only from DevTools,
    // which is not available when a candidate reports it after the fact.
    // Successes stay silent deliberately: this runs once per candidate click.
    if (verdict.status === 'judge_unavailable' || verdict.status === 'internal_error') {
      console.error(
        `[judge] runCodeSample status=${verdict.status} attempt=${attemptId} question=${questionId} adapter=${verdict.adapter} reason=${verdict.failureReason ?? 'none'}`,
      );
    }

    const nextState = advanceRunState(state, verdict, nowMs);
    await attemptSnap.ref.update({
      [`codeRuns.${questionId}`]: nextState,
      updatedAt: new Date(nowMs).toISOString(),
    });

    // redactForCandidate is the second half of the guarantee: visible tests
    // keep their output, hidden ones are reduced to a count, and the operator
    // detail on a failed run never leaves the server.
    //
    // It is given the FULL suite, not the sample-only one the judge received.
    // Redaction filters results by visibility either way, but only the full
    // list can tell the candidate how many hidden tests are waiting — which is
    // the number that tells them a green sample run is not a finished answer.
    return {
      ok: true as const,
      verdict: redactForCandidate(verdict, full.tests),
      remaining: Math.max(0, cfg.maxPerQuestion - nextState.count),
      // A judge that is down must not read as "your code failed". The client
      // shows this as a service message, and the candidate's answer is graded
      // later from the hidden suite regardless of whether they ever ran it.
      judgeAvailable: verdict.status !== 'judge_unavailable' && verdict.status !== 'internal_error',
    };
  },
);

// ══════════════════════════════════════════════════════════════════
// CODING — re-arming a submission the platform gave up on
// ══════════════════════════════════════════════════════════════════
//
// MAX_JUDGE_ATTEMPTS bounds the damage one pathological submission can do to a
// shared judge during an exam, and that bound is right. What was missing is
// what happens AFTER it: a submission that exhausted its retries kept
// codeJudgePending set, the sweep re-read the paper every five minutes and
// correctly declined to act, and there was no way — no button, no callable —
// to tell the platform to try again once the cause was fixed.
//
// So a judge outage that outlasted eighty minutes of backoff left a cohort's
// coding marks unrecoverable through the product. The only remedy was editing
// Firestore by hand, which is not a remedy anyone should need.
//
// WHAT THIS DELIBERATELY WILL NOT DO: re-judge a submission that already has a
// REAL VERDICT. `completed` and `compile_error` are settled — a mark that a
// student may already have been shown — and quietly recomputing one is a
// different and much larger decision than recovering from an outage. Fixing a
// wrong expected output and re-marking a cohort is a re-grade, and it should
// look like one rather than hiding inside a retry button.

interface RejudgeCodingData {
  attemptId: string;
  /** Narrow to one question. Omitted means every stuck coding answer on the paper. */
  questionId?: string;
}

export const rejudgeAttemptCoding = onCall<RejudgeCodingData>(
  {
    ...CALLABLE_BASE,
    // Judges inline rather than waiting for the next sweep: this is a person
    // pressing a button and watching, and "it will fix itself within five
    // minutes" is how someone presses it four more times.
    timeoutSeconds: 300,
    memory: '512MiB',
    secrets: [JUDGE0_AUTH_TOKEN],
    ...JUDGE_ACCESS,
  },
  async (request) => {
    const { attemptId, questionId } = request.data || ({} as RejudgeCodingData);
    if (!attemptId) throw new HttpsError('invalid-argument', 'attemptId is required.');

    const db = getFirestore();
    const attemptSnap = await db.collection('attempts').doc(attemptId).get();
    if (!attemptSnap.exists) throw new HttpsError('not-found', 'Attempt not found.');
    const attempt = attemptSnap.data() as {
      instituteId?: string;
      studentId?: string;
      assessmentId: string;
      answers?: Record<string, AttemptAnswerDoc>;
    };
    // The same gate freezing and provisional grading use — staff of the owning
    // institute, or a webOwner. A student may never re-arm their own judging.
    const actor = assertInvigilator(request, attempt);

    const assessmentSnap = await db.collection('assessments').doc(attempt.assessmentId).get();
    if (!assessmentSnap.exists) throw new HttpsError('not-found', 'Assessment not found.');
    const assessment = examContractFor(
      attempt as unknown as Record<string, unknown>,
      assessmentSnap.data() as Record<string, unknown>,
    ) as GradingAssessmentDoc;
    const qIds = Array.from(new Set(
      normalizeSections(assessment).flatMap((sec) => sec.questions.map((q) => q.questionId)),
    ));
    if (questionId && !qIds.includes(questionId)) {
      throw new HttpsError('invalid-argument', 'That question is not on this paper.');
    }
    const { questionMap } = await loadQuestionAndAnswerMaps(db, qIds);

    // Which submissions are actually stuck? Only ones the candidate attempted,
    // and only ones that never produced a real verdict.
    const targets = Object.keys(attempt.answers ?? {}).filter((qid) => {
      if (questionId && qid !== questionId) return false;
      const q = questionMap.get(qid);
      if (q?.engine !== 'code') return false;
      return !isEmptyCodeAnswer(q, attempt.answers![qid]);
    });

    let rearmed = 0;
    for (const qid of targets) {
      const vRef = db.collection('attemptVerdicts').doc(codeVerdictDocId(attemptId, qid));
      const snap = await vRef.get();
      if (!snap.exists) continue;   // never judged at all — the flag below is enough
      const state = (snap.data() as { state?: JudgeAttemptState } | undefined)?.state;
      if (state?.lastStatus === 'completed' || state?.lastStatus === 'compile_error') continue;

      // Dot paths with delete sentinels, NOT a merged `state` object: a merge
      // deep-merges maps, so lastStatus and nextAttemptAt would survive and
      // shouldJudgeNow would refuse the submission again on the same grounds.
      await vRef.update({
        'state.attempts': 0,
        'state.lastStatus': FieldValue.delete(),
        'state.nextAttemptAt': FieldValue.delete(),
        'state.claimedAt': FieldValue.delete(),
        updatedAt: new Date().toISOString(),
      });
      rearmed++;
    }

    // Set even when nothing was re-armed: a paper whose sweep never ran has no
    // verdict documents to reset, and this is what puts it back in the queue.
    await attemptSnap.ref.update({
      codeJudgePending: true,
      updatedAt: new Date().toISOString(),
    });

    const result = await judgeAttemptCoding(db, getJudgeAdapter(), attemptId);

    await writeAuditRow(db, {
      action: 'attemptCodingRejudged',
      entityType: 'attempt',
      entityId: attemptId,
      entityLabel: attempt.studentId ?? null,
      instituteId: attempt.instituteId ?? null,
      actorUid: actor.uid,
      actorRole: actor.role,
      reason: questionId ? `question ${questionId}` : `${rearmed} submission(s)`,
    });

    return {
      ok: true as const,
      rearmed,
      judged: result.judged,
      // False means at least one submission still has no verdict — the judge is
      // still unreachable. The caller shows that rather than implying success.
      settled: result.settled,
    };
  },
);

// ══════════════════════════════════════════════════════════════════
// PRE-EXAM WARM-UP (audit R-8 / §5 cold-start cliff)  — SHIPPED OFF
// ══════════════════════════════════════════════════════════════════
//
// EXAM_HOT_PATH deliberately leaves minInstances at 0, because a warm instance
// bills continuously whether or not an exam is running. The comment there
// prescribes the mitigation — "set it to 2-3 on startExam and getExamQuestions
// before a large scheduled sitting, and back to 0 afterwards" — and that is a
// correct procedure that depends on a human remembering it on the morning of
// an exam. This is that procedure, scheduled.
//
// ── INERT UNTIL TURNED ON, AND IT NEEDS A GRANT FIRST ─────────────
//
// Off unless WARMUP_ENABLED=true, for two reasons rather than caution alone:
//
//   1. It needs an IAM permission the functions service account does not have
//      by default — `run.services.update`, i.e. roles/run.developer. Without
//      it every call 403s. It fails closed and says so, but a function that
//      logs a permission error every five minutes is noise, not a feature.
//   2. Warm instances cost money continuously. Turning this on is a spending
//      decision, and spending decisions should not arrive inside a merge.
//
// TO ENABLE:
//   gcloud projects add-iam-policy-binding YOUR_PROJECT \
//     --member=serviceAccount:YOUR_PROJECT@appspot.gserviceaccount.com \
//     --role=roles/run.developer
//   then WARMUP_ENABLED=true in functions/.env.<project>, and redeploy.
//
// ── WHY THE CLOUD RUN ADMIN API AND NOT A PING ────────────────────
//
// A scheduled function that merely CALLS the hot path would warm roughly as
// many instances as it sends concurrent requests, and each one would show up
// as a failed unauthenticated call. minInstances is the actual control Cloud
// Run offers, so this sets it. Gen2 functions ARE Cloud Run services, and the
// service name is the function name lowercased.
//
// ── WHY IT IS SAFE TO GET WRONG ───────────────────────────────────
//
// Every failure path here leaves the platform exactly as it is today: no warm
// instances, and a cold-start cliff at exam open. That is the pre-R-8 status
// quo, so this can only improve on it or do nothing — which is the property
// that makes shipping it disabled reasonable rather than lazy.

const WARMUP_ENABLED = process.env.WARMUP_ENABLED === 'true';
/** How far ahead to look for a sitting, and how long to stay warm after it opens. */
const WARMUP_LOOKAHEAD_MIN = envInt('WARMUP_LOOKAHEAD_MIN', 20);
const WARMUP_TRAILING_MIN = envInt('WARMUP_TRAILING_MIN', 30);
/** Instances to hold on each hot-path function while a window is near. */
const WARMUP_MIN_INSTANCES = envInt('WARMUP_MIN_INSTANCES', 3);

/**
 * The two functions a whole cohort hits simultaneously at exam open.
 *
 * Not all ten of EXAM_HOT_PATH: the rest are reached DURING a sitting, by
 * which point instances are warm from the opening burst. Warming ten would
 * triple the bill to remove a cliff that only two of them stand on.
 */
const WARMUP_TARGETS = ['startexam', 'getexamquestions'];

/**
 * PATCH a Cloud Run service's minInstances annotation.
 *
 * Returns true when the service now reads as requested. A 403 is the expected
 * failure before the IAM grant, and is reported distinctly, because "you have
 * not granted the permission yet" and "the API is down" want different
 * responses from whoever reads the log.
 */
async function setMinInstances(
  service: string,
  value: number,
  projectId: string,
  region: string,
): Promise<boolean> {
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const name = `projects/${projectId}/locations/${region}/services/${service}`;
  const url = `https://run.googleapis.com/v2/${name}?updateMask=template.scaling.minInstanceCount`;
  try {
    const res = await client.request({
      url,
      method: 'PATCH',
      data: { template: { scaling: { minInstanceCount: value } } },
    });
    return res.status >= 200 && res.status < 300;
  } catch (e) {
    const status = (e as { response?: { status?: number } })?.response?.status;
    if (status === 403) {
      console.error(
        `[warmup] DENIED on ${service}: the functions service account lacks`
        + ' run.services.update. Grant roles/run.developer — see the block above'
        + ' scheduledWarmup. Nothing was changed.',
      );
    } else {
      console.error(`[warmup] ${service} PATCH failed (status=${status ?? 'none'})`, e);
    }
    return false;
  }
}

export const scheduledWarmup = onSchedule(
  { schedule: 'every 5 minutes', timeZone: 'Etc/UTC', region: 'us-central1', timeoutSeconds: 120 },
  async () => {
    if (!WARMUP_ENABLED) return;   // the default, and a no-op

    const db = getFirestore();
    const now = Date.now();
    const projectId = process.env.GCLOUD_PROJECT ?? '';
    if (!projectId) {
      console.error('[warmup] GCLOUD_PROJECT is unset — cannot address the services.');
      return;
    }

    // Is a sitting near? `startDate` is an ISO string on the assessment, and
    // the window is deliberately asymmetric: ahead of the start so instances
    // exist BEFORE the burst, and trailing it because latecomers and reloads
    // keep arriving after the bell.
    const fromIso = new Date(now - WARMUP_TRAILING_MIN * 60_000).toISOString();
    const toIso = new Date(now + WARMUP_LOOKAHEAD_MIN * 60_000).toISOString();
    //
    // A RANGE ON ONE FIELD AND NOTHING ELSE, on purpose. Adding
    // `.where('status','==','active')` would make this a composite query
    // needing a (status, startDate) index that does not exist — so enabling
    // the warm-up would have required an index deploy first, and forgetting
    // that would fail the query at exactly the moment it was supposed to
    // help. `startDate` alone is a single-field index, which Firestore
    // maintains automatically. Status is filtered in memory below; the window
    // is under an hour wide, so the result set is small enough that this is
    // cheaper than the coordination.
    const soon = await db.collection('assessments')
      .where('startDate', '>=', fromIso)
      .where('startDate', '<=', toIso)
      .limit(50)
      .get();

    const anyLive = soon.docs.some((d) => d.get('status') === 'active');
    const wanted = anyLive ? WARMUP_MIN_INSTANCES : 0;

    // Idempotent by construction: this runs every five minutes and PATCHes the
    // same value repeatedly while a window is open, then the same 0 repeatedly
    // once it closes. Cloud Run treats a no-change PATCH as a no-op, so there
    // is no state to track and nothing to get out of sync — which matters,
    // because the alternative is a flag that says "warm" after a failed deploy.
    let changed = 0;
    for (const service of WARMUP_TARGETS) {
      if (await setMinInstances(service, wanted, projectId, 'us-central1')) changed++;
    }
    console.log(
      `[warmup] window=${anyLive ? 'open' : 'none'} candidates=${soon.size} minInstances=${wanted}`
      + ` applied=${changed}/${WARMUP_TARGETS.length}`,
    );
  },
);

export const scheduledJudgeCoding = onSchedule(
  {
    schedule: 'every 5 minutes',
    timeZone: 'Etc/UTC',
    region: 'us-central1',
    // Judging is network-bound against a remote sandbox, and one paper can
    // carry several submissions each running a full test suite.
    timeoutSeconds: 540,
    memory: '512MiB',
    secrets: [JUDGE0_AUTH_TOKEN],
    ...JUDGE_ACCESS,
  },
  async () => {
    const db = getFirestore();
    const adapter = getJudgeAdapter();
    const startedAt = Date.now();

    // ── Why this run is bounded by TIME, not by a paper count ──────
    //
    // It used to take `.limit(50)` and judge them one after another. At a
    // five-minute schedule that is a hard ceiling of 600 papers an hour, and
    // the audit measured what that means against this system's own stated
    // target: a 10,000-student cohort with coding items takes ~17 HOURS to
    // drain. The sweep was correctly designed to spread work across runs
    // rather than outlast its timeout; the rate was simply never sized
    // against the number the rest of the platform is sized for.
    //
    // The count was also the wrong knob. Raising it trades one failure for
    // another — a run that overshoots `timeoutSeconds` is killed mid-paper —
    // because the cost of a paper is not knowable in advance: it is however
    // many submissions it carries times however long their suites take.
    // A deadline is the honest bound, and it holds whatever a paper costs.
    const budgetMs = Math.max(60_000, JUDGE_SWEEP_BUDGET_SECONDS * 1000);

    // ── And the real bottleneck was never the limit ────────────────
    //
    // The cluster runs FOUR worker replicas — docker-compose.yml calls that
    // "the real concurrency ceiling of the whole platform" — and this loop
    // awaited one paper at a time. Three of the four workers were idle while
    // a cohort waited. Concurrency is what actually moves the number; the
    // deadline is what keeps it safe.
    //
    // Deliberately defaulted to the cluster's replica count rather than
    // something larger: past it the extra requests only queue inside Judge0,
    // and the sweep would lose the ability to stop cleanly at its deadline.
    // Both are env-tunable so the pair can be re-sized together when the
    // cluster is (see infra/judge0/README.md).
    const concurrency = Math.max(1, JUDGE_SWEEP_CONCURRENCY);

    const pending = await db.collection('attempts')
      .where('codeJudgePending', '==', true)
      .limit(JUDGE_SWEEP_MAX_PAPERS)
      .get();

    let papers = 0;
    let judged = 0;
    let settled = 0;
    let skippedForBudget = 0;

    // Shared cursor over the batch; each worker takes the next paper when it
    // finishes one, so a slow paper cannot stall the others behind it (which
    // a fixed chunking would).
    let next = 0;
    const worker = async () => {
      for (;;) {
        if (Date.now() - startedAt > budgetMs) {
          // Stop STARTING work, never abandon work in flight. The papers not
          // reached keep codeJudgePending and are picked up next run — the
          // same across-runs draining the original design intended.
          skippedForBudget += Math.max(0, pending.docs.length - next);
          next = pending.docs.length;
          return;
        }
        const i = next++;
        if (i >= pending.docs.length) return;
        const docSnap = pending.docs[i];
        try {
          const r = await judgeAttemptCoding(db, adapter, docSnap.id);
          papers++;
          judged += r.judged;
          if (r.settled) settled++;
        } catch (e) {
          // One bad paper must not stop the sweep — the rest of the cohort is
          // waiting on it. The attempt keeps its pending flag and is retried.
          console.error('[judgeCoding] attempt', docSnap.id, e);
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, pending.docs.length) }, worker),
    );

    // ── The backlog line the audit asked for ───────────────────────
    //
    // `papers=0` was previously indistinguishable from "nothing queued" and
    // "the judge is unreachable", and neither said whether a backlog was
    // building. `queued` is what the query found; when it equals the cap the
    // real backlog is at least that and probably larger, which is the signal
    // worth alerting on. Single greppable line, same prefix as before.
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    const atCap = pending.docs.length >= JUDGE_SWEEP_MAX_PAPERS;
    console.log(
      `[judgeCoding] queued=${pending.docs.length}${atCap ? '+' : ''} papers=${papers}`
      + ` judged=${judged} settled=${settled} deferred=${skippedForBudget}`
      + ` concurrency=${concurrency} elapsed=${elapsed}s`,
    );
    if (atCap || skippedForBudget > 0) {
      console.warn(
        `[judgeCoding] BACKLOG queued=${pending.docs.length}${atCap ? '+' : ''}`
        + ` deferred=${skippedForBudget} — the sweep did not clear its batch;`
        + ' raise JUDGE_SWEEP_CONCURRENCY with the cluster replica count, or'
        + ' shorten the schedule, if this persists across runs',
      );
    }
  },
);
