import { useState, useEffect, useCallback } from 'react';
import { motion } from 'motion/react';
import { BookOpen } from 'lucide-react';
import {
  type NodeLevel,
  NODE_LEVEL_LABELS,
  NODE_CHILD_LEVEL,
  // Fetch functions
  getSchoolsByInstitute,
  getLevelsBySchool,
  getProgramsByLevel,
  getSessionsByProgram,
  getYearsBySession,
  getSemestersByYear,
  getCoursesByYear,
  getCoursesBySemester,
  getCoursesBySection,
  getSectionsBySemester,
  getSectionsByYearDirect,
  getSectionsByCourse,
  getGroupsBySection,
  // Archive functions
  archiveSchool,
  archiveAcademicLevel,
  archiveProgram,
  archiveAcademicSession,
  archiveAcademicYear,
  archiveSemester,
  archiveCourse,
  archiveSection,
  archiveGroup,
} from '../../../lib/firebaseService';
import { HierarchyBreadcrumb, type BreadcrumbNode } from './HierarchyBreadcrumb';
import { HierarchyPanel, type HierarchyItem } from './HierarchyPanel';
import { NodeDrawer, type AncestryMap } from './NodeDrawer';
import { SemesterDrawer } from './SemesterDrawer';
import { CourseDrawer } from './CourseDrawer';
import { NodeStudentRoster } from './NodeStudentRoster';

// ── Types ──────────────────────────────────────────────────────────

export type DrillNode = BreadcrumbNode & {
  ancestry: AncestryMap;
};

type DrawerState =
  | { type: 'node'; level: NodeLevel; editing?: HierarchyItem }
  | { type: 'semester'; editing?: HierarchyItem }
  | { type: 'course'; directToYear?: boolean; editing?: HierarchyItem }
  | null;

// ── Helpers ────────────────────────────────────────────────────────

function toItem(doc: any, level: NodeLevel): HierarchyItem {
  return {
    id: doc.id,
    name: doc.name,
    level,
    subtitle: level === 'semester' ? `${doc.type} · ${doc.number}` : undefined,
    meta: level === 'course' ? doc.code : undefined,
  };
}

async function archiveByLevel(level: NodeLevel, id: string): Promise<void> {
  const fns: Record<NodeLevel, (id: string) => Promise<void>> = {
    school: archiveSchool,
    academicLevel: archiveAcademicLevel,
    program: archiveProgram,
    academicSession: archiveAcademicSession,
    academicYear: archiveAcademicYear,
    semester: archiveSemester,
    course: archiveCourse,
    section: archiveSection,
    group: archiveGroup,
  };
  return fns[level](id);
}

function ancestryKey(level: NodeLevel): keyof AncestryMap {
  const map: Record<NodeLevel, keyof AncestryMap> = {
    school: 'schoolId',
    academicLevel: 'levelId',
    program: 'programId',
    academicSession: 'sessionId',
    academicYear: 'yearId',
    semester: 'semesterId',
    course: 'courseId',
    section: 'sectionId',
    group: 'sectionId', // groups don't need their own key in ancestry
  };
  return map[level];
}

function buildAncestryFromStack(stack: DrillNode[], newItem: { id: string; level: NodeLevel }): AncestryMap {
  const base = stack.length > 0 ? stack[stack.length - 1].ancestry : {};
  const key = ancestryKey(newItem.level);
  return { ...base, [key]: newItem.id };
}

// ── Main component ─────────────────────────────────────────────────

interface Props {
  instituteId: string;
  instituteName: string;
  readOnly?: boolean;
}

export function SchoolsTab({ instituteId, instituteName, readOnly = false }: Props) {
  // Navigation stack
  const [stack, setStack] = useState<DrillNode[]>([]);

  // Current level items
  const [items, setItems] = useState<HierarchyItem[]>([]);
  // Only populated when at Year level: direct courses (no semester)
  const [directCourses, setDirectCourses] = useState<HierarchyItem[]>([]);
  // B-2: sections that hang directly off a YEAR (annual programs, no semester).
  const [directSections, setDirectSections] = useState<HierarchyItem[]>([]);
  const [loading, setLoading] = useState(false);

  // Drawers
  const [drawer, setDrawer] = useState<DrawerState>(null);

  // ── Derived state ──────────────────────────────────────────────

  const currentParent = stack.length > 0 ? stack[stack.length - 1] : null;
  const currentParentLevel = currentParent?.level ?? null;
  const isRootView = stack.length === 0;
  const isYearView = currentParentLevel === 'academicYear';
  const isLeafView = currentParentLevel === 'group';
  const currentAncestry: AncestryMap = currentParent?.ancestry ?? {};

  // What level of items we're listing (primary panel).
  // B-2: a semester now lists SECTIONS (not courses); a year lists semesters
  // when it has them, else sections directly. Course is never a primary level.
  const listedLevel: NodeLevel = isRootView
    ? 'school'
    : isYearView
      ? 'semester'
      : (NODE_CHILD_LEVEL[currentParentLevel!] ?? 'school');

  // ── Fetch ──────────────────────────────────────────────────────

  const fetchItems = useCallback(async () => {
    // Reset side panels each navigation; only year/semester/section repopulate them.
    setDirectSections([]);
    if (isLeafView) { setItems([]); setDirectCourses([]); return; }
    setLoading(true);
    try {
      if (isRootView) {
        const schools = await getSchoolsByInstitute(instituteId);
        setItems(schools.map((s) => toItem(s, 'school')));
        setDirectCourses([]);
      } else {
        const parentId = currentParent!.id;
        switch (currentParentLevel) {
          case 'school': {
            const levels = await getLevelsBySchool(parentId);
            setItems(levels.map((l) => toItem(l, 'academicLevel')));
            setDirectCourses([]);
            break;
          }
          case 'academicLevel': {
            const progs = await getProgramsByLevel(parentId);
            setItems(progs.map((p) => toItem(p, 'program')));
            setDirectCourses([]);
            break;
          }
          case 'program': {
            const sessions = await getSessionsByProgram(parentId);
            setItems(sessions.map((s) => toItem(s, 'academicSession')));
            setDirectCourses([]);
            break;
          }
          case 'academicSession': {
            const years = await getYearsBySession(parentId);
            setItems(years.map((y) => toItem(y, 'academicYear')));
            setDirectCourses([]);
            break;
          }
          case 'academicYear': {
            // B-2: a year may be semesterized OR annual (or both).
            //   items          = semesters
            //   directSections = sections straight under the year (semesterId null)
            //   directCourses  = year-level courses (offerings)
            const [sems, dSections, courses] = await Promise.all([
              getSemestersByYear(parentId),
              getSectionsByYearDirect(parentId),
              getCoursesByYear(parentId),
            ]);
            setItems(sems.map((s) => toItem(s, 'semester')));
            setDirectSections(dSections.map((s) => toItem(s, 'section')));
            setDirectCourses(courses.map((c) => toItem(c, 'course')));
            break;
          }
          case 'semester': {
            // B-2: sections live under the semester now (not under a course).
            //   primary   = sections
            //   secondary = semester-level courses (whole-cohort offerings)
            const [sections, courses] = await Promise.all([
              getSectionsBySemester(parentId),
              getCoursesBySemester(parentId),
            ]);
            setItems(sections.map((s) => toItem(s, 'section')));
            setDirectCourses(courses.map((c) => toItem(c, 'course')));
            break;
          }
          case 'section': {
            // B-2: groups (primary) + section-level courses (secondary).
            const [groups, courses] = await Promise.all([
              getGroupsBySection(parentId),
              getCoursesBySection(parentId),
            ]);
            setItems(groups.map((g) => toItem(g, 'group')));
            setDirectCourses(courses.map((c) => toItem(c, 'course')));
            break;
          }
          default: break;
        }
      }
    } finally {
      setLoading(false);
    }
  }, [stack, instituteId]);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  // ── Navigation ──────────────────────────────────────────────────

  const handleSelect = (item: HierarchyItem) => {
    const newAncestry = buildAncestryFromStack(stack, item);
    setStack((prev) => [...prev, {
      level: item.level, id: item.id, name: item.name, ancestry: newAncestry,
    }]);
  };

  const handleRoot = () => setStack([]);
  const handleCrumb = (index: number) => setStack((prev) => prev.slice(0, index + 1));

  // ── Archive ─────────────────────────────────────────────────────

  const handleArchive = async (id: string, level: NodeLevel) => {
    await archiveByLevel(level, id);
    setItems((prev) => prev.filter((i) => i.id !== id));
    setDirectCourses((prev) => prev.filter((i) => i.id !== id));
  };

  // ── Drawer: onSaved ─────────────────────────────────────────────

  const handleSaved = (item: HierarchyItem, isSecondary = false) => {
    if (isSecondary) {
      // Direct courses on year view
      setDirectCourses((prev) => {
        const idx = prev.findIndex((i) => i.id === item.id);
        if (idx >= 0) { const next = [...prev]; next[idx] = item; return next; }
        return [item, ...prev];
      });
    } else {
      setItems((prev) => {
        const idx = prev.findIndex((i) => i.id === item.id);
        if (idx >= 0) { const next = [...prev]; next[idx] = item; return next; }
        return [item, ...prev];
      });
    }
    setDrawer(null);
  };

  // ── Breadcrumb string for student mapping ───────────────────────

  const mappingBreadcrumb = [instituteName, ...stack.map((n) => n.name)].join(' › ');

  // ── Add handlers ────────────────────────────────────────────────

  const handleAdd = () => {
    if (isYearView) {
      // Year primary add = a semester (annual-program sections are added via
      // the direct-sections affordance below).
      setDrawer({ type: 'semester' });
    } else {
      // semester → section, section → group, etc.
      setDrawer({ type: 'node', level: listedLevel });
    }
  };

  // Add a section directly under a year (annual programs, no semester).
  const handleAddDirectSection = () => {
    setDrawer({ type: 'node', level: 'section' });
  };

  // Course placement (B-2): courses are offerings attached beside the spine.
  //   year view    → whole-year course (directToYear)
  //   semester view→ whole-semester course
  //   section view → section-level course
  const handleAddCourse = () => {
    setDrawer({ type: 'course', directToYear: isYearView });
  };
  const handleAddDirectCourse = () => {
    setDrawer({ type: 'course', directToYear: true });
  };

  const handleEdit = (item: HierarchyItem, isDirectCourse = false) => {
    if (item.level === 'semester') {
      setDrawer({ type: 'semester', editing: item });
    } else if (item.level === 'course') {
      setDrawer({ type: 'course', editing: item, directToYear: isDirectCourse });
    } else {
      setDrawer({ type: 'node', level: item.level, editing: item });
    }
  };

  // ── What level label for section titles ─────────────────────────

  const listedLevelLabel = NODE_LEVEL_LABELS[listedLevel];

  // ── Leaf view (Groups) — roster replaces the old button-only view ─

  if (isLeafView && currentParent) {
    return (
      <div>
        <HierarchyBreadcrumb stack={stack} onRoot={handleRoot} onCrumb={handleCrumb} />
        <NodeStudentRoster
          nodeId={currentParent.id}
          nodeType={currentParent.level}
          nodeName={currentParent.name}
          breadcrumb={mappingBreadcrumb}
          instituteId={instituteId}
          readOnly={readOnly}
        />
      </div>
    );
  }

  // ── Main view ───────────────────────────────────────────────────

  return (
    <div>
      {/* Breadcrumb */}
      <HierarchyBreadcrumb stack={stack} onRoot={handleRoot} onCrumb={handleCrumb} />

      {/* ── Year view: semesters + direct sections + year courses ── */}
      {isYearView ? (
        <div className="space-y-8">
          <HierarchyPanel
            level="semester"
            items={items}
            loading={loading}
            sectionTitle="Semesters / Trimesters"
            addLabel="Add Semester"
            readOnly={readOnly}
            onSelect={handleSelect}
            onAdd={handleAdd}
            onEdit={(item) => handleEdit(item, false)}
            onArchive={(id) => handleArchive(id, 'semester')}
          />

          {/* Sections directly under the year (annual programs, no semester) */}
          <HierarchyPanel
            level="section"
            items={directSections}
            loading={loading}
            sectionTitle="Sections (no semester)"
            addLabel="Add Section"
            readOnly={readOnly}
            onSelect={handleSelect}
            onAdd={handleAddDirectSection}
            onEdit={(item) => handleEdit(item, false)}
            onArchive={(id) => handleArchive(id, 'section')}
          />

          {/* Year-level courses (offerings, no semester) */}
          <HierarchyPanel
            level="course"
            items={directCourses}
            loading={loading}
            sectionTitle="Courses (whole year)"
            addLabel="Add Course"
            readOnly={readOnly}
            onSelect={handleSelect}
            onAdd={handleAddDirectCourse}
            onEdit={(item) => handleEdit(item, true)}
            onArchive={(id) => handleArchive(id, 'course')}
          />
        </div>
      ) : (currentParentLevel === 'semester' || currentParentLevel === 'section') ? (
        /* ── Semester or Section view: primary panel + courses side panel ── */
        <div className="space-y-8">
          <HierarchyPanel
            level={listedLevel}
            items={items}
            loading={loading}
            isLeaf={listedLevel === 'group'}
            readOnly={readOnly}
            onSelect={handleSelect}
            onAdd={handleAdd}
            onEdit={(item) => handleEdit(item, false)}
            onArchive={(id) => handleArchive(id, listedLevel)}
          />

          {/* Courses attached at this level (offerings, not a drill-through) */}
          <HierarchyPanel
            level="course"
            items={directCourses}
            loading={loading}
            sectionTitle={currentParentLevel === 'semester' ? 'Courses (whole semester)' : 'Courses (this section)'}
            addLabel="Add Course"
            readOnly={readOnly}
            onSelect={handleSelect}
            onAdd={handleAddCourse}
            onEdit={(item) => handleEdit(item, false)}
            onArchive={(id) => handleArchive(id, 'course')}
          />
        </div>
      ) : (
        /* ── Standard single-panel view ── */
        <HierarchyPanel
          level={listedLevel}
          items={items}
          loading={loading}
          isLeaf={listedLevel === 'group'}
          readOnly={readOnly}
          onSelect={handleSelect}
          onAdd={handleAdd}
          onEdit={(item) => handleEdit(item, false)}
          onArchive={(id) => handleArchive(id, listedLevel)}
        />
      )}

      {/* ── Inline student roster for the current parent node ── */}
      {currentParent && (
        <NodeStudentRoster
          nodeId={currentParent.id}
          nodeType={currentParent.level}
          nodeName={currentParent.name}
          breadcrumb={mappingBreadcrumb}
          instituteId={instituteId}
          readOnly={readOnly}
        />
      )}

      {/* ── Info line when at root ── */}
      {isRootView && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }}>
          <div className="flex items-start gap-3 mt-6 px-4 py-3"
            style={{ background: 'var(--ef-canvas)', borderRadius: 2, border: '1px solid var(--ef-border)' }}>
            <BookOpen size={12} strokeWidth={1.5} style={{ color: 'var(--ef-text-muted)', flexShrink: 0, marginTop: 1 }} />
            <p className="text-xs" style={{ color: 'var(--ef-text-muted)', lineHeight: 1.6 }}>
              Build your academic hierarchy here: <strong style={{ color: 'var(--ef-text-subtle)' }}>School → Level → Program → Session → Year → Semester → Course → Section → Group</strong>. Students can be assigned at any level. Semesters are optional per year.
            </p>
          </div>
        </motion.div>
      )}

      {/* ── Drawers (only accessible when not readOnly) ── */}
      {!readOnly && drawer?.type === 'node' && (
        <NodeDrawer
          open
          level={drawer.level}
          editing={drawer.editing}
          ancestry={currentAncestry}
          instituteId={instituteId}
          onClose={() => setDrawer(null)}
          onSaved={(item) => handleSaved(item)}
        />
      )}

      {!readOnly && drawer?.type === 'semester' && (
        <SemesterDrawer
          open
          editing={drawer.editing}
          ancestry={currentAncestry}
          instituteId={instituteId}
          onClose={() => setDrawer(null)}
          onSaved={(item) => handleSaved(item)}
        />
      )}

      {!readOnly && drawer?.type === 'course' && (
        <CourseDrawer
          open
          editing={drawer.editing}
          ancestry={currentAncestry}
          instituteId={instituteId}
          directToYear={drawer.directToYear}
          onClose={() => setDrawer(null)}
          onSaved={(item) => handleSaved(item, drawer.directToYear)}
        />
      )}
    </div>
  );
}