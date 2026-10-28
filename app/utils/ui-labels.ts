// Shared UI vocabulary: one color mapping, one label mapping per enum — a status
// must render the same color, and a kind/category the same words, on every surface.
import { ROLE, type Role } from '#shared/enums';

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

/** map-miss fallback: humanize the raw enum ('IN_PROGRESS' → 'In progress') —
 * SCREAMING_SNAKE_CASE values must never reach the UI verbatim */
export function humanizeEnum(value: string): string {
  const words = value.replace(/[_-]+/g, ' ').trim().replace(/\s+/g, ' ');
  if (!words) return value;
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

export function categoryLabel(category: string | null | undefined): string {
  if (!category) return '';
  return CATEGORY_LABELS[category] ?? humanizeEnum(category);
}

export function kindLabel(kind: string | null | undefined): string {
  if (kind === 'ai') return 'AI agent';
  if (kind === 'human') return 'Human';
  return kind ? humanizeEnum(kind) : '';
}

/** Status name from a by-id lookup — one fallback ladder on every surface:
 * known row name, else humanize the raw id, else 'Unknown' for a missing id. */
export function statusLabel<V extends { name: string }>(
  statusId: string | null | undefined,
  byId: Map<string, V>,
): string {
  if (!statusId) return 'Unknown';
  return byId.get(statusId)?.name ?? humanizeEnum(statusId);
}

/** shared composer placeholders — the task page and the workflow drawer stay word-identical */
export function composerPlaceholder(waitingAnswer: boolean): string {
  return waitingAnswer ? 'Write an answer — the agent resumes' : 'Write a note…';
}

const ROLE_LABELS: { readonly [K in Role]: string } = {
  [ROLE.ADMIN]: 'Admin',
  [ROLE.EMPLOYEE]: 'Employee',
  [ROLE.VIEWER]: 'Viewer',
};

/** user role as a word — raw enum tokens ('ADMIN') never reach the UI */
export function roleLabel(role: string | null | undefined): string {
  return role ? (ROLE_LABELS[role as Role] ?? humanizeEnum(role)) : '';
}
