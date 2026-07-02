STRATUM audit — bugs & security, all four roles
Scope of what I actually read
Auth contexts (all 4), firestore.rules (527 lines), Cloud Functions (createAuthUser, deleteAuthUser, gradeAttempt), routes.tsx, initializeWebOwner.ts, FirebaseDebugPage.tsx, StudentRoot.tsx, the exam service surface, plus targeted greps for cross-role imports, role-scoped queries, and question-key access.

Baseline (what's working)
✅ System has migrated to real Firebase Auth + custom claims (role, instituteId, studentId, facultyId). No plaintext passwords in Firestore, no browser-side compare — CLAUDE.md is stale.
✅ Firestore rules enforce role isolation on nearly every collection; questionAnswers is denied to students (only gradeAttempt Cloud Function can read them).
✅ Cloud Functions do proper AuthN + AuthZ (createAuthUser, deleteAuthUser, gradeAttempt) and never trust client-side claims.
✅ Student service queries all correctly scoped by studentId / instituteId.
✅ No cross-role context imports found in the web-owner pages I checked.
✅ Hard-blocks on attempts delete, webowners delete, academic hierarchy deletes.
🔴 CRITICAL
C1 · Students can inject fake scores into their own attempt
firestore.rules:376–381

allow update: if (role() == 'student'
                 && resource.data.studentId == request.auth.token.studentId
                 && resource.data.status == 'in_progress')
resource.data.status is the pre-write value. Any field can be written in that update. A student can call updateDoc(attempts/{myId}, { status: 'submitted', scores: {total: 100, available: 100, percentage: 100, passed: true} }) from the browser console — the rule passes, gradeAttempt is bypassed entirely, and the grader UI trusts the injected scores. Impact: trivially exploitable exam-score forgery.

C2 · /firebase-debug is a public route that dumps everything
routes.tsx:68 + FirebaseDebugPage.tsx calls firestoreGetAll('webowners' | 'institutes' | 'faculty' | 'students' | 'instituteCredentials' | ...). Post-migration the credentials docs no longer hold plaintext passwords, but a signed-in web owner (or anyone who becomes one) navigating here dumps every user record on the platform in one JSON blob. A signed-in student only gets what rules let them read — but the page has zero access control at the UI level and shouldn't exist in production. Impact: massive PII / directory-listing leak surface.

C3 · /initialize is public and reachable after setup
routes.tsx:71 + initializeWebOwner.ts shows hardcoded owner@platform.com / admin123 credentials directly in the UI to any anonymous visitor. The underlying setWebOwner call would now be blocked by Firestore rules (needs isWebOwner() — nobody is signed in), so the creation is dead — but the credentials are still visibly rendered to any visitor as guidance. If the account already exists, this becomes a permanent "here are the admin credentials" page. Impact: credential exposure; also invites social-engineering.

🟠 HIGH
H1 · /firebase-test is also a public route
routes.tsx:65 — I didn't read the full page, but its sibling (firebase-debug) is a data dumper; test pages typically write to Firestore. Given the debug page's behavior, this one should be presumed leaky too and removed / gated.

H2 · webowners can update each other's records
firestore.rules:100 — allow update: if isWebOwner() — no doc-ID vs request.auth.uid check. If the platform ever has more than one web owner, any web owner can rewrite another web owner's profile (email, name, whatever else lands in the doc). Not exploitable today if only one webOwner exists, but the rule is written for a multi-owner future without the guard.

H3 · Assessment reads are wide-open
firestore.rules:348 — allow read: if signedIn() on assessments. Any signed-in user (any role, any institute) can read every assessment doc — including drafts from other institutes. Since assessments carry sections[].questions[] with question IDs, a hostile student could pre-fetch every question they might ever see from any exam.

H4 · Question reports are readable by everyone signed in
firestore.rules:476 — allow read: if signedIn() on questionReports. Students in institute A can read reports filed by students in institute B (which questions were flagged, by whom, with what free-text reason). Cross-institute leak.

H5 · enrollments reads are readable by any writer of the assessment
firestore.rules:510–513 — reads allowed to the assessment owner (fine) OR the student themselves (fine). But canWriteEnrollment grants the assessment owner read+write on any enrollment for their assessment, which is expected. The concern: allow read: … || (role() == 'student' && resource.data.studentId == request.auth.token.studentId) — students can only read their own. That's correct. Downgrading this to MED — but flagging that writers can bulk-list rosters cross-institute if a webOwner-owned assessment is enrolled in.

🟡 MEDIUM
M1 · sendPasswordResetEmail leaks institute existence
StudentAuthContext.tsx:243–255 — requestPasswordReset calls getInstituteByCode(codeNorm) and returns "Institute not found with this code" before calling sendPasswordResetEmail. That leaks whether an institute code is valid to an unauthenticated caller — an attacker can enumerate institute codes.

M2 · initializeWebOwner.ts still tries to write a password: 'admin123' field
initializeWebOwner.ts:33–37 passes password: 'admin123' into setWebOwner. If the call ever succeeded (it shouldn't, per rules), a plaintext password would land in Firestore. Rule doesn't currently reject the field, only requires email and name be present.

M3 · enforceIntegrityThreshold terminates but leaves student with dead-end error
Already flagged in the exam review — behavior/comment mismatch. Student with remaining attempts must leave and re-enter to spawn the next attempt.

M4 · No startDate gate on briefing entry
Already flagged — nothing enforces "not open yet" client-side. Backing rule doesn't check schedule either.

🟢 LOW
L1 — console.error calls throughout leak stack traces into browser DevTools; not sensitive on their own but noisy on production.
L2 — Bottom bar vs modal empty-check disagreement in exam (whitespace-only text answers).
L3 — SubmitConfirmModal's submitting spinner is dead code.
L4 — Auth pages have px-8 (cramped at 320px but functional).
L5 — subjectService.ts lines 358 & 414 — unfiltered getDocs(collection(db, 'questions')) in count refresh (O(n) on every recount).
✅ Verified clean
All four AuthContext files: proper Firebase Auth flow, custom-claim role verification, no plaintext, correct sign-out on wrong role.
gradeAttempt Cloud Function: rigorous AuthN + AuthZ + idempotency.
submissionService client queries: all role-scoped correctly.
Cross-role imports: none found in web-owner pages.
attempts delete: hard-blocked (soft-delete pattern via isDeleted).
questionAnswers: students denied at the rules layer.
Prioritized fix list
Priority	Item	Effort
1	C1 — tighten attempts update rule for students (whitelist writable fields; block score/status writes)	Small, rules-only
2	C2 + C3 + H1 — delete /firebase-debug, /firebase-test, /initialize routes (or dev-only gate them)	Trivial
3	H3 — scope assessments reads by role/institute	Medium — need to audit read call sites
4	H4 — scope questionReports reads by ownership	Small, rules-only
5	H2 — add ownerId == request.auth.uid on webowners update	Small
6	M1 — remove the institute-existence pre-check	Trivial
7	M2 — strip password from initializeWebOwner, or delete the file entirely (since /initialize is going anyway)	Trivial
8	Remaining M/L items — bundle for next pass	
Verdict: foundations are solid (real Firebase Auth, tight Cloud Functions, mostly-tight rules). But C1 alone is a "close before shipping to real users" item — it lets students set their own scores. And C2/C3/H1 are three public routes that shouldn't exist in production. Everything else is fixable at leisure.

Want me to start fixing? I'd recommend tackling the priority-1 and priority-2 items first — both are small and eliminate the biggest risks.