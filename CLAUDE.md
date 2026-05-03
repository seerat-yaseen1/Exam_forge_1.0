# STRATUM — Codebase Map for AI Assistants

> This file is the primary navigation aid for AI assistants working on STRATUM.
> Read this before touching any file. If a `graphify-out/GRAPH_REPORT.md` exists,
> read that **after** this file for deeper structural insight.

---

## 1 · Project identity

| Field | Value |
|---|---|
| Name | **STRATUM** |
| Stack | React 18 · TypeScript · Tailwind CSS v4 · Vite · `react-router` (Data Mode) |
| Backend | Firebase Firestore only (no Firebase Auth — custom password auth) |
| Package manager | pnpm |
| Entry point | `/src/app/App.tsx` → `RouterProvider` → `/src/app/routes.tsx` |
| Palette | off-white `#F7F6F3` background · near-black `#0C0C0B` type |

---

## 2 · Auth roles & isolated contexts

STRATUM has **four completely isolated authentication contexts**. Each has its
own login page, Firestore collection, React context, layout, and route tree.
Passwords are stored in Firestore and compared in browser JS — no Firebase Auth.

| Role | Context file | Layout | Firestore collection |
|---|---|---|---|
| Web Owner | `AuthContext.tsx` | `DashboardLayout.tsx` | `webOwners` |
| Institute Admin | `InstituteAuthContext.tsx` | `InstituteDashboardLayout.tsx` | `institutes` |
| Faculty | `FacultyAuthContext.tsx` | `FacultyDashboardLayout.tsx` | `faculty` |
| Student | `StudentAuthContext.tsx` | `StudentDashboardLayout.tsx` | `students` |

All context files live in `/src/app/context/`.

### 3-tier permission cascade

```
Web Owner
  └─ sets flags on institutes  (e.g. canCreateAssessments, canManageFaculty)
       └─ Institute Admin
            └─ sets flags on faculty  (e.g. canBuildQuestions, canPublishAssessments)
                 └─ Faculty
                      └─ only gets access when BOTH institute gate AND web-owner gate are open
```

---

## 3 · Directory map

```
/
├── src/
│   ├── app/
│   │   ├── App.tsx                    # RouterProvider root
│   │   ├── Root.tsx                   # top-level shell (web-owner)
│   │   ├── routes.tsx                 # createBrowserRouter — all four role trees
│   │   ├── context/                   # one AuthContext per role
│   │   ├── layouts/                   # one DashboardLayout per role
│   │   ├── pages/
│   │   │   ├── (root)                 # Web Owner pages
│   │   │   ├── institute/             # Institute Admin pages
│   │   │   ├── faculty/               # Faculty pages
│   │   │   └── student/               # Student pages (exam shell lives here)
│   │   └── components/
│   │       ├── assignments/           # Assessment builder & roster components
│   │       ├── exam/                  # Exam-time components (face monitor, shell)
│   │       ├── faculty/               # Faculty management drawers
│   │       ├── questions/             # Question bank editor components
│   │       ├── schools/               # Institute hierarchy (schools → courses)
│   │       ├── student/               # Student management drawers
│   │       └── ui/                    # shadcn/ui primitives (low-signal, ignored by graphify)
│   ├── lib/                           # ALL Firestore service functions
│   │   ├── assessmentService.ts       # Assessment CRUD + attempt management
│   │   ├── submissionService.ts       # Attempt lifecycle + answer storage
│   │   ├── questionBankService.ts     # Question CRUD
│   │   ├── questionShareService.ts    # Cross-institute question sharing
│   │   ├── firebaseService.ts         # Generic Firestore helpers + user CRUD
│   │   ├── subjectService.ts          # Subject/topic taxonomy
│   │   ├── emailService.ts            # Email notifications (stub)
│   │   └── firebase.ts                # Firebase app init + db export
│   └── styles/
│       ├── theme.css                  # CSS custom properties (colors, spacing)
│       ├── fonts.css                  # @import font faces (add new fonts here only)
│       └── index.css / tailwind.css   # Global resets + Tailwind entry
├── firestore.rules                    # Security rules
├── firestore.indexes.json
└── firebase.json
```

---

## 4 · Key data models (Firestore)

### Assessment  (`assessments/{id}`)
```ts
{
  id, title, description, status,          // 'draft' | 'active' | 'closed'
  ownerType, ownerId,
  sections: AssessmentSection[],           // each has questions[], timeLimitMinutes
  questionSelectionRules?,                 // random-draw rules
  scheduledStart?, scheduledEnd?,
  maxAttempts?: number,                    // null = unlimited
  attemptOverrides?: Record<studentId, number>, // per-student override
  blockedStudents?: string[],              // per-student block list (gates exam entry)
  createdAt, updatedAt
}
```

### Attempt  (`attempts/{id}`)
```ts
{
  id, assessmentId, studentId,
  status,          // 'in_progress' | 'submitted' | 'timed_out'
  isDeleted?,      // soft-delete flag (feature in progress)
  startedAt, submittedAt?,
  answers: Record<questionId, StudentAnswer>,
  score?, maxScore?,
  violations: ViolationEvent[],
  attemptNumber: number
}
```

### Question  (`questions/{id}`)
```ts
{
  id, type,   // 'mcq' | 'multi_select' | 'true_false' | 'short_answer' | 'long_answer' | 'fill_blank'
  stem, options?, correctAnswer, explanation?,
  subject, topic, difficulty, marks,
  ownerId, ownerType, isShared?,
  createdAt, updatedAt
}
```

### Enrollment  (`enrollments/{assessmentId_studentId}`)
```ts
{ assessmentId, studentId, enrolledAt }
```

---

## 5 · Assessment builder & roster

| File | Purpose |
|---|---|
| `pages/AssignmentsPage.tsx` | Web-owner assessment builder (sections, question picker, max attempts field) |
| `pages/faculty/FacultyAssignmentsPage.tsx` | Faculty mirror of the builder |
| `pages/institute/InstituteAssignmentsPage.tsx` | Institute mirror |
| `components/assignments/AssessmentRosterCore.tsx` | Shared roster component used by all three roles — enrollment table, attempt panel, override controls |
| `components/assignments/QuestionPickerModal.tsx` | Picker to add questions from the bank to a section |

---

## 6 · Exam flow (student)

```
StudentAssessmentsPage  →  ExamBriefingPage  →  ExamShell  →  ExamResultsPage
```

- `ExamBriefingPage` — checks `maxAttempts` / `attemptOverrides` before allowing start
- `ExamShell` — fullscreen + integrity engine; calls `submissionService.startAttempt`
- `submissionService.startAttempt` throws `ATTEMPT_LIMIT_EXCEEDED` if limit reached

Integrity components: `FaceMonitor`, `IntegrityEngine`, `ViolationOverlay`, `SectionTimer`, `QuestionNavigator`, `QuestionRenderer`.

---

## 7 · Feature completion status

| Feature | Status |
|---|---|
| Block/unblock assessment | ✅ done |
| `maxAttempts` + `attemptOverrides` | ✅ done — builder field + roster AttemptsPanel + service enforcement |
| Response viewer (Correct/Wrong/Partial/Unattempted/Text tabs) | ✅ done — `ResponseViewer` in `AssessmentRosterCore`; `getQuestionsByIds` in `questionBankService` |
| Soft-delete attempt (`isDeleted` flag, filtered from roster, shown in drawer history) | ✅ done — `softDeleteAttempt` in `submissionService`; `SoftDeleteConfirmModal` + history badge in `AssessmentRosterCore` |
| Override badge on roster rows | ✅ done — `attemptOverrides` prop on `RosterTableRow`; blue `#N` pill shown when override is set |

---

## 8 · Conventions & rules

- **No Firebase Auth.** Passwords stored in Firestore, compared in browser JS.
- **Service functions only in `/src/lib/`.** Pages/components never call Firestore directly.
- **Role isolation is absolute.** Web-owner pages must never import faculty/student contexts and vice-versa.
- **shadcn/ui** for all UI primitives (in `components/ui/`). Never re-implement these.
- **Tailwind v4** — no `tailwind.config.js`. Tokens live in `theme.css`.
- **Font imports** — only in `styles/fonts.css`, always at the top.
- **Batch Firestore reads** in chunks of 30 (`where('id', 'in', chunk)`) — Firestore `in` operator cap.
- **`removeUndefined()`** helper in every service file — strip `undefined` before writing to Firestore.

---

## 9 · How to navigate this repo with graphify

```bash
# one-time setup
pip install graphifyy && graphify install

# build the graph (run from repo root)
/graphify .

# query without re-reading all files
/graphify query "how does attempt limit enforcement work?"
/graphify query "what calls submissionService.startAttempt?"
/graphify path "ExamBriefingPage" "submissionService"
```

`graphify-out/GRAPH_REPORT.md` — read this after `CLAUDE.md` for god nodes & community clusters.
`graphify-out/graph.json` — queryable graph for precise hop-by-hop traversal.

---

## 10 · graphify navigation instructions  *(written by `graphify claude install`)*

> A knowledge graph exists at `graphify-out/GRAPH_REPORT.md`.
> **Before searching raw files with Glob or Grep, read `GRAPH_REPORT.md`** to identify
> god nodes, community clusters, and critical paths. Use the graph to navigate directly
> to the relevant file rather than scanning the whole tree.

### Quick-reference: where to look for what

| Question | Go to |
|----------|-------|
| "What imports X?" | Section 2 community that contains X, check reverse edges |
| "Where does feature Y live?" | Section 2 — find the community by feature name |
| "What are the riskiest files to touch?" | Section 1 — God Nodes ranked by centrality |
| "What's the call chain for the exam flow?" | Section 3 — Critical Paths |
| "Where do I add a new service function?" | Section 5 — Pending Feature Hooks |
| "What Firestore queries exist?" | Section 4 — Access Patterns |