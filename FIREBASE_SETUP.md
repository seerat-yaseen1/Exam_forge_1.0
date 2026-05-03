# Firebase Setup Guide for STRATUM

## Overview
Your STRATUM platform uses Firebase Firestore as its sole backend. This guide walks through the complete setup.

## Step 1: Create a Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Click "Add project" or "Create a project"
3. Enter project name: `STRATUM` (or your preferred name)
4. Disable Google Analytics (optional for this project)
5. Click "Create project"

## Step 2: Register Your Web App

1. In the Firebase Console, click the **web icon** (</>) to add a web app
2. Register app with nickname: `STRATUM Web App`
3. **Don't check** "Also set up Firebase Hosting" (not needed)
4. Click "Register app"
5. **Copy the configuration object** — you'll need this in Step 5

The config will look like this:
```javascript
const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc..."
};
```

## Step 3: Enable Firestore Database

1. In Firebase Console sidebar, click **Firestore Database**
2. Click "Create database"
3. Choose **Production mode** (rules are deployed in the next step)
4. Select your preferred region (choose closest to your users)
5. Click "Enable"

## Step 4: Deploy Security Rules

Production-grade security rules are already written in `/firestore.rules` in this project. Deploy them using one of the two methods below.

### Option A — Firebase CLI (recommended)

```bash
npm install -g firebase-tools
firebase login
firebase use --add          # select your Firebase project
firebase deploy --only firestore:rules,firestore:indexes
```

### Option B — Firebase Console (manual paste)

1. In Firestore Database, click the **Rules** tab
2. Open `/firestore.rules` from this project and copy its entire contents
3. Paste into the Rules editor
4. Click **Publish**

### What the rules enforce

| Protection | Detail |
|---|---|
| **Schema validation** | Every write is checked for required fields and correct types — malformed documents are rejected |
| **Enum constraints** | `status` must be `active`\|`disabled`; `validityType` must be `monthly`\|`yearly`\|`custom`; `role` is fixed to `Faculty` or `Student` per collection |
| **Logo size cap** | `instituteLogos.dataUrl` is capped at 950 kB (within Firestore's 1 MB document limit) |
| **Web owner protection** | `webowners` documents cannot be deleted from any browser client (`allow delete: if false`) |
| **Collection allowlist** | Only the 9 known collections are accessible — any unknown path is denied by Firestore's default-deny behaviour |

### Why reads are currently public

STRATUM uses custom credential authentication (passwords stored in Firestore, compared in the browser) rather than Firebase Authentication. Because `request.auth` is always `null`, rules cannot verify which role the caller holds. Reads must remain open for login lookups to work correctly.

**To achieve full read-isolation**, migrate to Firebase Authentication and add custom claims (`role`, `instituteId`). This enables rules like:
```
allow read: if request.auth != null && request.auth.token.role == 'WebOwner';
```

### Firebase App Check (strongly recommended)

[App Check](https://firebase.google.com/docs/app-check) ensures only your deployed web app — not raw `curl` or Postman — can reach Firestore, even without Firebase Auth. Enable it in:

> Firebase Console → App Check → Get started → reCAPTCHA v3

## Step 5: Update Firebase Configuration in Code

1. Open `/src/lib/firebase.ts` in this project
2. Replace the placeholder config with your actual Firebase configuration:

```typescript
const firebaseConfig = {
  apiKey: "YOUR_ACTUAL_API_KEY",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-actual-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};
```

## Step 6: Initialize Your First Web Owner Account

Before you can log in, create the first Web Owner record in Firestore:

1. In Firebase Console, go to **Firestore Database**
2. Click "Start collection"
3. Collection ID: `webowners`
4. Document ID: your email address (e.g., `admin@stratum.com`)
5. Add these fields:

| Field | Type | Value |
|-------|------|-------|
| email | string | your-email@example.com |
| name | string | Your Name |
| password | string | YourSecurePassword123 |

6. Click "Save"

Alternatively, use the `/initialize` route in the running app to create the Web Owner through the UI.

> **Password note:** STRATUM currently stores passwords as plain text. See the security checklist below for the hashing upgrade path.

## Step 7: Test Your Setup

1. Save all files and start the development server
2. Navigate to the Web Owner login page (`/login`)
3. Log in with the credentials you created in Step 6

---

## Database Collections Structure

| Collection | Document ID | Purpose |
|---|---|---|
| `webowners` | `{email}` | Web Owner accounts |
| `institutes` | `{uuid}` | Institute records |
| `instituteCredentials` | `{instituteId}` | Institute admin login credentials |
| `instituteLogos` | `{instituteId}` | Institute logos (base64 dataUrl) |
| `instituteConfigs` | `{instituteId}` | Institute operational metadata |
| `faculty` | `{uuid}` | Faculty member records |
| `facultyCredentials` | `{facultyId}` | Faculty login credentials |
| `students` | `{uuid}` | Student records |
| `studentCredentials` | `{studentId}` | Student login credentials |

---

## Production Security Checklist

### Completed ✅
- [x] Firestore security rules written (`/firestore.rules`) — schema validation, enum enforcement, webowner delete protection, collection allowlist
- [x] `firebase.json` and `firestore.indexes.json` created for CLI deployment

### To do before going live

- [ ] **Deploy the rules** — use `firebase deploy --only firestore:rules` or paste into Firebase Console
- [ ] **Enable Firebase App Check** — blocks non-app Firestore access (reCAPTCHA v3 for web)
- [ ] **Hash passwords** — migrate from plain-text to bcrypt (requires a one-time migration script)
- [ ] **Restrict API key** — in Google Cloud Console → Credentials, add HTTP referrer restrictions to your Firebase API key so it only works from your domain
- [ ] **Set authorised domains** — Firebase Console → Authentication → Settings → Authorised domains (add your production domain)
- [ ] **Consider Firebase Authentication** — replacing the custom auth layer with Firebase Auth unlocks full role-based security rules and eliminates plain-text passwords entirely

---

## Troubleshooting

### "Permission denied" errors after deploying rules
The structural validation in the rules is strict. Check that the document being written matches the exact schema. Common causes:
- A required field is missing or empty
- A boolean field is being written as a string (`"true"` instead of `true`)
- `status` has an unexpected value

### "Firebase not initialized"
Verify your Firebase config in `/src/lib/firebase.ts` is correct and the project ID matches.

### "Cannot read data from Firestore"
Ensure the collections and the initial Web Owner document exist (Step 6).

---

## Firebase Documentation

- [Firestore Security Rules](https://firebase.google.com/docs/firestore/security/get-started)
- [Firebase App Check](https://firebase.google.com/docs/app-check)
- [Firebase CLI](https://firebase.google.com/docs/cli)
- [Web SDK Reference](https://firebase.google.com/docs/reference/js)
