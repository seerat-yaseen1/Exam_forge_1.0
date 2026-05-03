Institute Detail View Structure

Only two tabs already exist:

Student List

Faculty List

Now we will create the 3rd tab: Schools.

3rd Tab: Schools

The Schools tab will manage the complete academic hierarchy and student mapping for the institute.

Final hierarchy

School → Level → Program → Academic Session → Year → Semester / Trimester → Course → Section → Group → Students

This is the full structure to be implemented.

Meaning of Each Layer
1. School

The highest academic container.

Examples:

School of Engineering

School of Management

School of Arts

2. Level

The broad academic level under a school.

Examples:

UG

PG

Diploma

3. Program

The actual academic program offered under a level.

Examples:

B.Tech

MBA

B.Sc

Diploma in Computer Science

4. Academic Session

The overall admission or academic cycle.

Examples:

2024-25

2025-26

This helps organize the same program across different years of admission.

5. Year

The year inside a program.

Examples:

Year 1

Year 2

Year 3

Year 4

6. Semester / Trimester

This layer depends on the institute pattern.

Examples:

Semester 1

Semester 2

Trimester 1

Trimester 2

This should be optional, because not every institute follows the same academic pattern.

7. Course

The subject or course taught within that academic structure.

Examples:

Mathematics

Data Structures

Operating Systems

Financial Accounting

8. Section

A division of students within a course or academic batch.

Examples:

Section A

Section B

Section C

9. Group

A smaller subdivision inside a section.

Examples:

Group 1

Group 2

Group 3

10. Students

Students are assigned at the appropriate level of the hierarchy.

Student Mapping Rule

A student can belong to multiple:

schools

levels

programs

academic sessions

years

semesters / trimesters

courses

sections

groups

Important

This must be treated as multi-mapping.

The system should not block a student from being assigned to another entity in the hierarchy.

If the student is already mapped elsewhere, the system should only show a warning, not an error.

Warning example

“This student is already mapped to another school / level / program / session / year / semester / course / section / group. The new mapping will also be added.”

Rules:

show warning only

do not block save

do not remove existing mapping

do not force exclusivity

What the Schools tab should allow

Inside Schools, the user should be able to:

create schools

create levels under schools

create programs under levels

assign academic sessions

assign years

assign semesters or trimesters

create courses

create sections

create groups

map students into any of these units

view existing mappings

edit mappings later if needed

Recommended UI flow

The user should create the structure in this order:

School

Level

Program

Academic Session

Year

Semester / Trimester

Course

Section

Group

Students

This keeps the system logical and easy to manage.

Final summary
Existing tabs

Student List

Faculty List

New tab to create

Schools

Final structure inside Schools

School → Level → Program → Academic Session → Year → Semester / Trimester → Course → Section → Group → Students

Core rule

Students may be linked to multiple nodes in the hierarchy, and the system should only warn, not stop, when duplicate mapping exists.