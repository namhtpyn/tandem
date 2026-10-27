// Shared UI vocabulary: one color mapping, one label mapping per enum — a status
// must render the same color, and a kind/category the same words, on every surface.
export type BadgeColor = 'primary' | 'success' | 'warning' | 'error' | 'info' | 'neutral';

const CATEGORY_COLORS: Record<string, BadgeColor> = {
  done: 'success',
  cancelled: 'error',
  in_review: 'info',
  working: 'warning',
  waiting_answer: 'warning',
  blocked: 'error',
  todo: 'neutral',
};

export function categoryColor(category: string | null | undefined): BadgeColor {
  return (category && CATEGORY_COLORS[category]) || 'neutral';
}

const CATEGORY_LABELS: Record<string, string> = {
  todo: 'To do',
  working: 'Working',
  in_review: 'In review',
  waiting_answer: 'Waiting answer',
  blocked: 'Blocked',
  done: 'Done',
  cancelled: 'Cancelled',
};

export function categoryLabel(category: string | null | undefined): string {
  return (category && CATEGORY_LABELS[category]) || category || '';
}

export function kindLabel(kind: string | null | undefined): string {
  if (kind === 'ai') return 'AI agent';
  if (kind === 'human') return 'Human';
  return kind ?? '';
}
