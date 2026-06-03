import type { AssessmentStatus } from '../../../../lib/assessmentService';

/**
 * Per-field editability for an assessment in a given lifecycle status.
 * A `false` here means the field is NOT rendered in the edit panel — we hide,
 * we don't grey out. `'extend-only'` is a special case for endDate.
 */
export type EditableFields = {
  title: boolean;
  description: boolean;
  subject: boolean;

  startDate: boolean;
  endDate: boolean | 'extend-only';
  maxAttempts: boolean;
  attemptOverrides: boolean;

  targetType: boolean;
  blockedStudents: boolean;

  sections: boolean;
  shuffleQuestions: boolean;
  passingScore: boolean;
  showResults: boolean;
  allowReview: boolean;
};

export function editableFields(status?: AssessmentStatus): EditableFields {
  const s = status ?? 'draft';

  if (s === 'draft') {
    return {
      title: true,
      description: true,
      subject: true,
      startDate: true,
      endDate: true,
      maxAttempts: true,
      attemptOverrides: true,
      targetType: true,
      blockedStudents: true,
      sections: true,
      shuffleQuestions: true,
      passingScore: true,
      showResults: true,
      allowReview: true,
    };
  }

  if (s === 'active') {
    return {
      title: true,
      description: true,
      subject: false,
      startDate: false,
      endDate: 'extend-only',
      maxAttempts: true,
      attemptOverrides: true,
      targetType: false,
      blockedStudents: true,
      sections: false,
      shuffleQuestions: false,
      passingScore: true,
      showResults: true,
      allowReview: true,
    };
  }

  // closed
  return {
    title: true,
    description: true,
    subject: false,
    startDate: false,
    endDate: false,
    maxAttempts: false,
    attemptOverrides: false,
    targetType: false,
    blockedStudents: true,
    sections: false,
    shuffleQuestions: false,
    passingScore: false,
    showResults: true,
    allowReview: true,
  };
}

export type PanelKey = 'details' | 'schedule' | 'access' | 'sections' | 'behaviour';

/** Which edit panels should appear in the menu for this status. A panel is
 *  hidden when none of its fields are editable. */
export function availablePanels(status?: AssessmentStatus): PanelKey[] {
  const f = editableFields(status);
  const panels: PanelKey[] = [];

  if (f.title || f.description || f.subject) panels.push('details');
  if (f.startDate || f.endDate || f.maxAttempts || f.attemptOverrides) panels.push('schedule');
  if (f.targetType || f.blockedStudents) panels.push('access');
  if (f.sections) panels.push('sections');
  if (f.shuffleQuestions || f.passingScore || f.showResults || f.allowReview) panels.push('behaviour');

  return panels;
}
