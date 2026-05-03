# 🚀 STRATUM - Quick Start After Firebase Migration

## ⚡ 3-Minute Setup

### 1. Create Firebase Project
```
→ Go to: https://console.firebase.google.com
→ Click: "Add project"
→ Name: "STRATUM"
→ Click through setup
```

### 2. Enable Firestore
```
→ Sidebar: "Firestore Database"
→ Click: "Create database"
→ Mode: "Production mode"
→ Location: Choose nearest
→ Click: "Enable"
```

### 3. Set Development Rules
```
→ Click: "Rules" tab
→ Replace with:

rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if true;
    }
  }
}

→ Click: "Publish"
```

### 4. Get Your Config
```
→ Project Settings (gear icon)
→ Scroll to "Your apps"
→ Click web icon (</>)
→ Register app: "STRATUM Web App"
→ Copy the firebaseConfig object
```

### 5. Update Code
```typescript
// Open: /src/lib/firebase.ts
// Replace the placeholder config with yours:

const firebaseConfig = {
  apiKey: "AIzaSy...",              // ← Your actual API key
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project-id",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc..."
};
```

### 6. Create First User
```
→ Firestore Database → "Start collection"
→ Collection ID: "webowners"
→ Document ID: "admin@stratum.com"  (your email)
→ Add fields:
  • email: string → "admin@stratum.com"
  • name: string → "Your Name"
  • password: string → "YourPassword123"
→ Click: "Save"
```

### 7. Test Login
```
→ Run your app
→ Go to Web Owner login
→ Use credentials from Step 6
→ ✅ You're in!
```

---

## ✅ What Works Now

- **Web Owner Login** - Full authentication
- **Institute Creation** - Add new institutes  
- **Institute Admin Login** - Admin portal access
- **Logo Upload** - Institute branding
- **Password Management** - Reset & change

---

## 📚 Full Documentation

- **FIREBASE_SETUP.md** - Detailed setup guide
- **MIGRATION_STATUS.md** - What's done, what's next
- **README_FIREBASE_MIGRATION.md** - Complete overview

---

## 🎯 No More Errors

❌ **Before:** 403 Forbidden (Supabase deployment)  
✅ **After:** Direct Firebase access (no deployment needed)

---

**Time to Working App:** ~15 minutes  
**Difficulty:** Easy ⭐⭐☆☆☆
