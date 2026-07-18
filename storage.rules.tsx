rules_version = '2';

service firebase.storage {
  match /b/{bucket}/o {

    match /question-images/{allPaths=**} {
      allow read: if request.auth != null;
      // Content-type tightened (external review #4): SVG dropped — it's a
      // scriptable format and the declared type is client-controlled anyway,
      // so the least we do is refuse the dangerous label. Existing SVG
      // uploads keep being served (this gates writes only). ImageUploader's
      // accept list mirrors this set.
      allow write: if request.auth != null
                   && request.auth.token.role in ['webOwner', 'institute', 'faculty']
                   && request.resource.size < 5 * 1024 * 1024
                   && request.resource.contentType.matches('image/(png|jpe?g|gif|webp)');
    }

    // ── Phase 3 Stage 4b: SEB configuration files ──────────────────
    // The .seb files students download to enter SEB exams. Student-readable
    // by design (they need the file); the SECRET is the Config Key, which
    // lives in Firestore (webOwner-only) — a modified file yields a different
    // key and is rejected. Write is webOwner-only: config files ARE the
    // exam-entry contract.
    match /seb-configs/{allPaths=**} {
      allow read: if request.auth != null;
      allow write: if request.auth != null
                   && request.auth.token.role == 'webOwner'
                   && request.resource.size < 2 * 1024 * 1024;
    }

    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}