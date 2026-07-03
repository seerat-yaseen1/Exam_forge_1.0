rules_version = '2';

service firebase.storage {
  match /b/{bucket}/o {

    match /question-images/{allPaths=**} {
      allow read: if request.auth != null;
      allow write: if request.auth != null
                   && request.auth.token.role in ['webOwner', 'institute', 'faculty']
                   && request.resource.size < 5 * 1024 * 1024
                   && request.resource.contentType.matches('image/.*');
    }

    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}