# Assessment pipeline audit — standalone, grouped, coding

**Scope:** every stage from the authoring drawer to the awarded mark, for the
three item families that have to work: standalone questions, grouped sets
(DI / seating / RC / caselet / puzzle), and coding.

**Trigger:** a coding challenge was authored successfully and then did not work
in the exam — code written into the editor did not compile.

Findings are anchored to code. The pipeline was read, not run against a live
project, so the deploy checklist at the end is how the fixes get verified.

---

## 1 · The short answer

`sanitizeQuestionForStudent` is the server's explicit allow-list of fields a
candidate may receive, and **`codeSpec` was not on it**. That field carries the
languages a coding question accepts, the starter buffer the editor opens into,
and the limits the program runs under — all public, none of it the answer.
Stripped, the client reads an absent spec as *"every language the platform
runs"* with an empty starter, so the editor opened blank, in whichever language
sorts first, regardless of what was authored.

That matters more than a missing convenience because of something the platform
does that was never written down:

> **A coding submission is a whole program.** It is compiled and run as-is,
> reads its input from stdin, and is marked on what it prints to stdout. There
> is no harness and no function-signature contract.

The starter templates exist to convey exactly that — every one is a runnable
program that already reads stdin. With them stripped, a bare function is
precisely what does not compile in Java, C, C++, Go, Rust and C#, and prints
nothing in Python or Ruby.

**How to tell which failure you hit:** if Judge0 were unreachable you would have
seen *"The code runner is temporarily unavailable"*, never a compile error. A
genuine compile message means the sandbox is live and was reached — which points
at F-02 and F-04 below.

---

## 2 · Coverage

`✅ works` verified end to end · `🔧 fixed` was broken, repaired here ·
`◻ gap` not built, needs a decision

| Stage | Standalone | Grouped | Coding |
|---|---|---|---|
| Author | ✅ | ◻ Web Owner only | 🔧 picker built a *match* draft; preview blind |
| Store | ✅ | ✅ | 🔧 suite written to the wrong document (F-01) |
| Bank & export | ✅ | ✅ | 🔧 dropped from exports silently (F-06) |
| Select onto a paper | ◻ Web Owner only | ◻ Web Owner only | ◻ Web Owner only |
| Deliver | ✅ | ✅ | 🔧 `codeSpec` stripped (F-02) |
| Run / judge | — | — | 🔧 needs Judge0 deployed |
| Grade | ✅ | ✅ | ✅ |

What is genuinely solid and worth not re-litigating: the grouped delivery path
(stimulus whitelisted and scoped to the paper, shuffle moves whole sets and never
their insides, children graded by their own engine), the coding grading seam
(async sweep then re-score, negative marking opting in per section rather than
inheriting), and the sample-run guard rails (per-question quota, cooldown, hidden
tests stripped before the submission is built rather than after the response).

---

## 3 · Fixed

Every one of these type-checked, passed the suite, and rendered without
complaint. That is the common thread — each sits in a seam between two files
that agree by convention rather than by compiler.

### F-01 · The answer-key split disagreed between client and server — critical
`functions/src/index.ts` → `ANSWER_KEYS_S`

The server's list of answer-key fields is a hand-maintained twin of the client's
and was missing `tests`. Every question written through the faculty and institute
callables split wrongly in both directions at once: the hidden suite went onto
the **public** question document, and `questionAnswers/{id}.tests` was never
written at all.

*Effect:* the candidate got "This question has no sample tests to run" and could
not execute their code. The judge was handed zero tests, returned unavailable,
retried five times, exhausted, and left the answer in manual review permanently.
The expected outputs meanwhile sat in the collection they are specifically kept
out of.

*Fix:* `tests` added to the twin; `buildQuestionDocs` now empties it on the
public document the way it already empties `correctIds`; `execEditQuestion`
clears a stale copy on any edit; `scripts/repair-code-answer-split.ts` moves
suites already misfiled. The direct Web Owner write path always split correctly,
so only faculty- and institute-authored coding questions were affected.

### F-02 · `codeSpec` never reached the candidate — critical
`functions/src/index.ts` → `sanitizeQuestionForStudent`

The whitelist is deliberately explicit so a leaky field cannot arrive by
accident — and the same property means a needed field cannot arrive until it is
named. Added as a narrowed sub-object, rebuilt field by field, so the next
addition to `CodeSpec` still has to be named before a candidate can see it.

### F-03 · Picking a coding type built a match question — major
`QuestionTypeEngine.tsx` → `selectType`

The engine dispatch ended in a bare `else` meaning "match", and no
`buildEmptyCode` factory existed, so a new coding question opened carrying three
blank match pairs and saved them to both documents. Now an exhaustive `switch`
with a `never` default, plus the missing factory; the coding fields reset on type
change like every other engine's.

### F-04 · The TypeScript starter template did not compile — major
`src/lib/codeSnippets.ts` → `STARTER_TEMPLATES.typescript`

Judge0 compiles TypeScript with a bare `tsc` and no `@types/node`, so
`require('fs')` is TS2580 — `tsc` exits non-zero and Judge0 reports a
**compilation error**. The file's docstring promised every template "compiles and
runs as-is"; twelve of thirteen did. A `declare const require` satisfies the
compiler without a type package the sandbox does not have.

### F-05 · Preview was blind to coding questions — major
`QuestionPreview.tsx`

Branches existed for mcq, text and match, and none for code — so every other
defect here was invisible in the one place an author would have looked. Preview
now shows languages, the starter buffer per language, and (behind the same gate
as the other answer keys) the suite with each test's visibility, weight and
comparison mode, plus the total weight — the number that decides whether the
question can be marked at all.

### F-06 · Export silently dropped every coding question — major
`ExportModal.tsx` → `questionsToXLSX`

One sheet per engine, and coding had none, so those questions were not exported
and nothing said so — an author backing up their bank got a quietly short file.
A Code sheet now carries the spec, starter buffers and suite as JSON in single
cells. It is a faithful backup, not a re-import format, and the sheet says so in
its own column.

### Regression guard

`src/lib/twinSync.test.ts` reads the functions source and asserts that the
answer-key lists match exactly, that the three judge language tables agree, and
that the student whitelist still carries `codeSpec` and still refuses the answer
fields. Verified to fail against the original `ANSWER_KEYS_S`.

The client and the Cloud Functions are separate TypeScript builds with no shared
package, so several lists exist twice with a "keep in EXACT sync" comment and
nothing enforcing it. F-01 is the proof that the comment is not enough.

---

## 4 · Open — decisions, not patches

### G-01 · Only the Web Owner can build an assessment — high
`InstituteAssignmentsPage.tsx`, `FacultyAssignmentsPage.tsx` are read-only lists
plus a roster link. `createAssessment` is called from exactly one place in the
app. This bounds all three priorities at once: whatever is fixed about coding or
grouped sets, only one account type can put them on a paper.

### G-02 · Grouped sets can only be authored by the Web Owner — high
Nearly free, and the smaller of the two builds. The server callables
(`createQuestionGroupAsRole` + edit/delete siblings), the rights gating, the
owner-scoped read and the client wrappers (`saveQuestionGroupForRole`,
`updateQuestionGroupForRole`, `deleteQuestionGroupForRole`) are all written — and
called from nowhere. Only the Sets section on the two question pages is missing.

### G-03 · No function-signature mode for coding — medium
The LeetCode shape (author supplies a hidden driver, candidate fills a body) is
not built. It needs a driver field per language on `CodeSpec`, a concatenation
step in `buildCodeSubmission`, and an authoring UI that can verify a driver
compiles against a reference solution. Until then, stems should ask for a program
and state what it reads and what it must print — and the starter templates now
actually arrive to show candidates the shape.

### G-04 · Judge0 deployment is not in the runbook — medium
`infra/judge0/` has a compose file, config and verifier; `DEPLOY.md` never
references them. With `JUDGE0_BASE_URL` unset the composition root returns
`NullJudgeAdapter` — a deliberate safe state (every submission becomes a paper
awaiting review rather than a zero) but a silent one.

Also noted, deliberately not closed: bulk upload has no `code` parser. A
variable-length suite of multi-line inputs is not a spreadsheet row, and the
export sheet says so rather than implying a round trip that does not exist.

---

## 5 · Deploy checklist

1. **Deploy the functions.** F-01 and F-02 are both server-side; nothing else
   takes effect until this lands.
2. **Repair coding questions already written.** Dry run prints what it would move
   and writes nothing; idempotent, and never overwrites a suite already correct.
   ```
   cd functions
   npx ts-node scripts/repair-code-answer-split.ts
   npx ts-node scripts/repair-code-answer-split.ts --apply
   ```
3. **Re-grade papers already marked against the empty suite.** Attempts judged
   before the repair hold a stale verdict; `regradeAttempts` re-scores from the
   repaired answer documents.
4. **Confirm the judge, then sit the exam.** `npm run verify:judge0` checks the
   pinned language table against the live instance — the ids are numeric and
   change between Judge0 releases, and a renumbered table runs submissions in the
   wrong language rather than failing. Then author one challenge and sit it: the
   editor should open into your starter program, in your language, and "Run
   sample tests" should execute.
