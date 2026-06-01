alph1abeta2@cloudshell:~/Exam_forge_1.0 (exam-forge-1-40ba7)$ git stash push -m "cloudshell-locals-pre-grade-attempt-pull"
Saved working directory and index state On main: cloudshell-locals-pre-grade-attempt-pull
alph1abeta2@cloudshell:~/Exam_forge_1.0 (exam-forge-1-40ba7)$ git pull
Username for 'https://github.com': seerat-yaseen1
Password for 'https://seerat-yaseen1@github.com': 
remote: Enumerating objects: 9, done.
remote: Counting objects: 100% (9/9), done.
remote: Compressing objects: 100% (6/6), done.
remote: Total 6 (delta 3), reused 0 (delta 0), pack-reused 0 (from 0)
Unpacking objects: 100% (6/6), 68.27 KiB | 546.00 KiB/s, done.
From https://github.com/seerat-yaseen1/Exam_forge_1.0
   10d9a55..73259d7  main       -> origin/main
Updating 37df1a9..73259d7
Fast-forward
 CLAUDE.md                                           | 230 ------------------------------------------
 firestore.rules                                     | 422 +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++---------------
 functions/package.json                              |   2 +-
 functions/scripts/migrate-question-answers.ts       | 105 +++++++++++++++++++
 functions/src/index.ts                              | 514 +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++----
 index.html                                          |   6 ++
 package.json                                        |   1 -
 src/app/components/faculty/AddFacultyDrawer.tsx     |  79 ++++++++-------
 src/app/components/faculty/BulkFacultyModal.tsx     |  76 +++++++-------
 src/app/components/faculty/FacultyTab.tsx           |  49 +++++++--
 src/app/components/questions/RichText.tsx           |  13 ++-
 src/app/components/student/AddStudentDrawer.tsx     |  81 +++++++--------
 src/app/components/student/BulkStudentModal.tsx     |  82 ++++++++-------
 src/app/components/student/StudentTab.tsx           |  44 +++++++-
 src/app/context/AuthContext.tsx                     |   4 +-
 src/app/context/FacultyAuthContext.tsx              |   2 +-
 src/app/context/InstituteAuthContext.tsx            |   4 +-
 src/app/context/StudentAuthContext.tsx              |   2 +-
 src/app/pages/UserManagementPage.tsx                |  92 ++++++++++-------
 src/app/pages/student/ExamResultsPage.tsx           |  31 ++++--
 src/app/pages/student/ExamShell.tsx                 |  36 +++----
 src/app/pages/student/StudentProfilePage.tsx        |   6 --
 src/imports/image-4.png                             | Bin 0 -> 59634 bytes
 src/imports/image-5.png                             | Bin 0 -> 40262 bytes
 src/imports/image-6.png                             | Bin 0 -> 35812 bytes
 src/imports/pasted_text/create-auth-user-logs-1.txt |  17 ++++
 src/imports/pasted_text/create-auth-user-logs.txt   |  12 +++
 src/lib/emailService.ts                             | 226 -----------------------------------------
 src/lib/firebaseService.ts                          |   4 +-
 src/lib/questionBankService.ts                      | 205 ++++++++++++++++++++++++++++++++++---
 src/lib/submissionService.ts                        |  49 ++++++++-
 31 files changed, 1569 insertions(+), 825 deletions(-)
 delete mode 100644 CLAUDE.md
 create mode 100644 functions/scripts/migrate-question-answers.ts
 create mode 100644 src/imports/image-4.png
 create mode 100644 src/imports/image-5.png
 create mode 100644 src/imports/image-6.png
 create mode 100644 src/imports/pasted_text/create-auth-user-logs-1.txt
 create mode 100644 src/imports/pasted_text/create-auth-user-logs.txt
 delete mode 100644 src/lib/emailService.ts
alph1abeta2@cloudshell:~/Exam_forge_1.0 (exam-forge-1-40ba7)$ grep -c "export const gradeAttempt" functions/src/index.ts 
1
alph1abeta2@cloudshell:~/Exam_forge_1.0 (exam-forge-1-40ba7)$ cd functions && npm run build && cd ..

> stratum-functions@0.1.0 build
> tsc

alph1abeta2@cloudshell:~/Exam_forge_1.0 (exam-forge-1-40ba7)$ firebase deploy --only functions

=== Deploying to 'exam-forge-1-40ba7'...

i  deploying functions
Running command: npm --prefix "$RESOURCE_DIR" run build

> stratum-functions@0.1.0 build
> tsc

✔  functions: Finished running predeploy script.
i  functions: preparing codebase default for deployment
i  functions: ensuring required API cloudfunctions.googleapis.com is enabled...
i  functions: ensuring required API cloudbuild.googleapis.com is enabled...
i  artifactregistry: ensuring required API artifactregistry.googleapis.com is enabled...
⚠  functions: Runtime Node.js 20 was deprecated on 2026-04-30 and will be decommissioned on 2026-10-30, after which you will not be able to deploy without upgrading. Consider upgrading now to avoid disruption. See https://cloud.google.com/functions/docs/runtime-support for full details on the lifecycle policy
⚠  functions: package.json indicates an outdated version of firebase-functions. Please upgrade using npm install --save firebase-functions@latest in your functions directory.
⚠  functions: Please note that there will be breaking changes when you upgrade.
i  functions: Loading and analyzing source code for codebase default to determine what to deploy
Serving at port 8425

i  extensions: ensuring required API firebaseextensions.googleapis.com is enabled...
i  functions: preparing functions directory for uploading...
i  functions: packaged /home/alph1abeta2/Exam_forge_1.0/functions (55.28 KB) for uploading
i  functions: ensuring required API run.googleapis.com is enabled...
i  functions: ensuring required API eventarc.googleapis.com is enabled...
i  functions: ensuring required API pubsub.googleapis.com is enabled...
i  functions: ensuring required API storage.googleapis.com is enabled...
i  functions: generating the service identity for pubsub.googleapis.com...
i  functions: generating the service identity for eventarc.googleapis.com...
⚠  functions: GOOGLE_CLOUD_QUOTA_PROJECT is not usable when uploading source for Cloud Functions.
✔  functions: functions source uploaded successfully
i  functions: creating Node.js 20 (2nd Gen) function gradeAttempt(us-central1)...
i  functions: updating Node.js 20 (2nd Gen) function createAuthUser(us-central1)...
i  functions: updating Node.js 20 (2nd Gen) function deleteAuthUser(us-central1)...
✔  functions[gradeAttempt(us-central1)] Successful create operation.
✔  functions[createAuthUser(us-central1)] Successful update operation.
✔  functions[deleteAuthUser(us-central1)] Successful update operation.

✔  Deploy complete!

Project Console: https://console.firebase.google.com/project/exam-forge-1-40ba7/overview