# ✅ STRATUM Firebase Setup Checklist

## Phase 1: Firebase Setup (Required) ⚡

- [ ] **Create Firebase Project**
  - Go to [Firebase Console](https://console.firebase.google.com)
  - Create new project named "STRATUM"
  - Disable Google Analytics (optional)

- [ ] **Enable Firestore Database**
  - Navigate to "Firestore Database"
  - Create database in production mode
  - Select closest location

- [ ] **Configure Security Rules**
  - Go to Rules tab
  - Set permissive rules for development
  - Publish rules

- [ ] **Register Web App**
  - Click web icon (</>)
  - Register app: "STRATUM Web App"
  - Copy firebaseConfig object

- [ ] **Update Code with Config**
  - Open `/src/lib/firebase.ts`
  - Replace placeholder config with actual values
  - Save file

- [ ] **Create Web Owner Account**
  - In Firestore, create collection: `webowners`
  - Add document with your email as ID
  - Add fields: email, name, password
  - Save document

- [ ] **Test Web Owner Login**
  - Start development server
  - Navigate to login page
  - Log in with created credentials
  - Verify dashboard loads

---

## Phase 2: Verification (5 minutes) ✅

- [ ] **Test Institute Creation**
  - Create a test institute
  - Check Firestore for new document
  - Verify credentials generated

- [ ] **Test Institute Admin Login**
  - Use institute admin email
  - Use temporary password (check console)
  - Change password on first login
  - Verify dashboard access

- [ ] **Test Logo Upload**
  - Upload institute logo
  - Verify logo appears
  - Check Firestore for logo document

- [ ] **Test Password Reset**
  - Request password reset
  - Verify reset code generated
  - Complete password reset
  - Log in with new password

---

## Phase 3: Optional Enhancements (If Needed) 🔧

- [ ] **Migrate Faculty Auth Context**
  - Open `/src/app/context/FacultyAuthContext.tsx`
  - Replace Supabase imports with Firebase
  - Update all API calls to Firebase functions
  - Test faculty login flow

- [ ] **Migrate Student Auth Context**
  - Open `/src/app/context/StudentAuthContext.tsx`
  - Replace Supabase imports with Firebase
  - Update all API calls to Firebase functions
  - Test student login flow

- [ ] **Update Institute Management**
  - Open `/src/app/pages/UserManagementPage.tsx`
  - Replace API calls with Firebase functions
  - Test CRUD operations

- [ ] **Update Faculty Management**
  - Update `/src/app/components/faculty/FacultyTab.tsx`
  - Update related components
  - Test add/edit/delete

- [ ] **Update Student Management**
  - Update `/src/app/components/student/StudentTab.tsx`
  - Update related components
  - Test add/edit/delete

---

## Phase 4: Cleanup (After Everything Works) 🗑️

- [ ] **Delete Supabase Files**
  - Remove `/supabase/` directory
  - Remove `/utils/supabase/` directory

- [ ] **Remove Supabase References**
  - Search codebase for "supabase"
  - Remove unused imports
  - Clean up comments

- [ ] **Update Documentation**
  - Document Firebase setup in project README
  - Add production security notes
  - Update deployment guide

---

## Phase 5: Production Preparation (Before Launch) 🚀

- [ ] **Update Security Rules**
  - Create role-based access rules
  - Validate data on writes
  - Test rules thoroughly

- [ ] **Environment Variables**
  - Move Firebase config to environment variables
  - Set up staging/production configs
  - Document environment setup

- [ ] **Enable Firebase Authentication** (Optional)
  - Consider migrating to Firebase Auth
  - Better security and features
  - Built-in OAuth support

- [ ] **Set Up Indexes**
  - Create composite indexes for queries
  - Monitor query performance
  - Optimize as needed

- [ ] **Configure Domain Authorization**
  - Add production domain to Firebase
  - Set up CORS if needed
  - Test from production domain

- [ ] **Implement Password Hashing**
  - Never store plain text passwords
  - Use bcrypt or similar
  - Migrate existing passwords

- [ ] **Set Up Monitoring**
  - Enable Firebase Performance Monitoring
  - Set up error tracking
  - Create alerts for issues

- [ ] **Backup Strategy**
  - Set up automatic Firestore exports
  - Test restore procedures
  - Document backup process

---

## Progress Tracker

**Overall Completion:** ___/8 Essential Items

### Essential Items:
1. [ ] Firebase project created
2. [ ] Firestore enabled
3. [ ] Config updated in code
4. [ ] Web Owner account created
5. [ ] Web Owner login works
6. [ ] Institute creation works
7. [ ] Institute admin login works
8. [ ] Logo upload works

---

## Quick Status Check

```bash
# Run these checks to verify setup:

✅ Can create Firebase project → Phase 1.1
✅ Can access Firestore console → Phase 1.2
✅ Have firebaseConfig copied → Phase 1.4
✅ Config pasted in code → Phase 1.5
✅ Web Owner document exists → Phase 1.6
✅ Can log in as Web Owner → Phase 1.7
✅ No console errors → Verification
✅ Can create institutes → Phase 2.1
```

---

## Troubleshooting Checklist

If something doesn't work:

- [ ] **Check Firebase Config**
  - Is config in `/src/lib/firebase.ts` correct?
  - Are all fields filled in?
  - No placeholder text remaining?

- [ ] **Check Firestore Rules**
  - Are rules permissive for development?
  - Did you click "Publish" after updating?

- [ ] **Check Web Owner Document**
  - Does document exist in `webowners` collection?
  - Is document ID your email address?
  - Are all fields spelled correctly?

- [ ] **Check Browser Console**
  - Any Firebase initialization errors?
  - Any network errors?
  - Any authentication errors?

- [ ] **Check Network Tab**
  - Are Firestore requests succeeding?
  - Any 403 or 401 errors?
  - Are requests going to correct project?

---

## Time Estimates

- **Phase 1 (Setup):** 15-20 minutes
- **Phase 2 (Verification):** 5-10 minutes  
- **Phase 3 (Optional):** 2-3 hours
- **Phase 4 (Cleanup):** 30 minutes
- **Phase 5 (Production):** 3-4 hours

**Minimum to Get Working:** ~20 minutes (Phase 1 + 2)

---

## Success Criteria

Your setup is successful when:

✅ No more 403 Supabase errors  
✅ Web Owner can log in  
✅ Institutes can be created  
✅ Institute admins can log in  
✅ Logos can be uploaded  
✅ Password management works  

---

## Notes Section

Use this space to track your progress, note any issues, or jot down reminders:

```
[Your notes here]





```

---

**Last Updated:** After Firebase migration completion  
**Priority:** Complete Phase 1 & 2 first, then proceed as needed  
**Support:** Reference `FIREBASE_SETUP.md` for detailed instructions
