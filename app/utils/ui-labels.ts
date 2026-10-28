import { isAnthropicWire, endpointKind, isModelsEndpoint, PROVIDER_KIND } from '#shared/api-styles';
// Shared UI vocabulary: one color mapping, one label mapping per enum — a status
// must render the same color, and a kind/category the same words, on every surface.
import {
  ACTIVITY_KIND,
  CATEGORY,
  ROLE,
  RUN_STATUS,
  type ActivityKind,
  type Category,
  type Role,
  type RunStatus,
} from '#shared/enums';

export type BadgeColor = 'primary' | 'success' | 'warning' | 'error' | 'info' | 'neutral';

type CategoryView = { color: BadgeColor; text: string; icon: string; label: string };

// ONE row per category: a status badge, its board-column heading, its glyph and
// its word all read from here, so a category can never be green in one place and
// yellow in another. Typed Record<Category, …> for exhaustiveness, then widened to
// Record<string, …> so an unknown category yields `undefined` and every caller's
// fallback stays reachable (noUncheckedIndexedAccess).
const CATEGORY_VIEWS: Record<Category, CategoryView> = {
  [CATEGORY.BACKLOG]: { color: 'neutral', text: 'text-dimmed', icon: 'i-lucide-circle-dashed', label: 'Backlog' },
  [CATEGORY.READY]: { color: 'neutral', text: 'text-dimmed', icon: 'i-lucide-inbox', label: 'Ready' },
  [CATEGORY.WORKING]: { color: 'warning', text: 'text-warning', icon: 'i-lucide-clock-3', label: 'Working' },
  [CATEGORY.PAUSED]: { color: 'warning', text: 'text-warning', icon: 'i-lucide-pause', label: 'Paused' },
  [CATEGORY.WAITING_ANSWER]: {
    color: 'info',
    text: 'text-info',
    icon: 'i-lucide-message-circle-question',
    label: 'Waiting answer',
  },
  [CATEGORY.IN_REVIEW]: { color: 'info', text: 'text-info', icon: 'i-lucide-eye', label: 'In review' },
  [CATEGORY.DONE]: { color: 'success', text: 'text-success', icon: 'i-lucide-circle-check', label: 'Done' },
  [CATEGORY.CANCELLED]: { color: 'error', text: 'text-error', icon: 'i-lucide-circle-x', label: 'Cancelled' },
};

const CATEGORY_VIEW: Record<string, CategoryView> = CATEGORY_VIEWS;

export function categoryColor(category: string | null | undefined): BadgeColor {
  return (category && CATEGORY_VIEW[category]?.color) || 'neutral';
}

/** map-miss fallback: humanize the raw enum ('IN_PROGRESS' → 'In progress') —
 * SCREAMING_SNAKE_CASE values must never reach the UI verbatim */
export function humanizeEnum(value: string): string {
  const words = value.replace(/[_-]+/g, ' ').trim().replace(/\s+/g, ' ');
  if (!words) return value;
  return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
}

export function categoryLabel(category: string | null | undefined): string {
  if (!category) return '';
  return CATEGORY_VIEW[category]?.label ?? humanizeEnum(category);
}

// solid-dot background class per badge color — the borderless status selects
// (list row + mobile card) render categoryColor as a filled dot instead of a badge
const BADGE_DOT: Record<BadgeColor, string> = {
  success: 'bg-success',
  error: 'bg-error',
  info: 'bg-info',
  warning: 'bg-warning',
  primary: 'bg-primary',
  neutral: 'bg-accented',
};

export function dotClass(color: string): string {
  return BADGE_DOT[color as BadgeColor] ?? BADGE_DOT.neutral;
}

// board column heading: category-driven text color (mirrors categoryColor's mapping)
export function categoryText(category: string | null | undefined): string {
  return (category && CATEGORY_VIEW[category]?.text) || 'text-dimmed';
}

// distinct glyph per category — Doing (clock) vs Waiting answer (speech bubble)
// read as the same yellow dot without one
export function categoryIcon(category: string | null | undefined): string {
  return (category && CATEGORY_VIEW[category]?.icon) || 'i-lucide-circle-dot';
}

export function kindLabel(kind: string | null | undefined): string {
  if (kind === 'ai') return 'AI agent';
  if (kind === 'human') return 'Human';
  return kind ? humanizeEnum(kind) : '';
}

/** picker-option label with the AI suffix — one voice for every
 * assignee/reviewer list ('Ada (AI)'), never a hand-rolled '(AI)' fragment */
export function aiOptionLabel(name: string, kind: string | null | undefined): string {
  return kind === 'ai' ? `${name} (AI)` : name;
}

/** Status name from a by-id lookup — one fallback ladder on every surface:
 * known row name, else 'Unknown status' (a map-miss id is a raw UUID — never render it). */
export function statusLabel<V extends { name: string }>(
  statusId: string | null | undefined,
  byId: Map<string, V>,
): string {
  if (!statusId) return 'Unknown';
  return byId.get(statusId)?.name ?? 'Unknown status';
}

/** endpoint → badge color, one mapping for every provider-endpoint badge
 * (catalog cards, table rows and the editor's selected chips) */
export function endpointBadgeColor(endpoint: string): BadgeColor {
  if (endpointKind(endpoint) === PROVIDER_KIND.DECISION) return 'info';
  if (isModelsEndpoint(endpoint)) return 'success';
  if (isAnthropicWire([endpoint])) return 'warning';
  return 'primary';
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

// ---- agent runs: one normalized status + label/dot map for every surface
// (list drawer run cards, task-page chat turns). AgentRunStatus is the server's
// RunStatus lifecycle (lowercased) plus the terminal states a settled run can
// report — derived from the shared enum so the wire tokens are never re-typed.
export type AgentRunStatus = Lowercase<RunStatus> | 'cancelled' | 'timeout' | 'stopped';

const AGENT_RUN_STATUSES: Record<string, AgentRunStatus> = {
  [RUN_STATUS.RUNNING.toLowerCase()]: 'running',
  [RUN_STATUS.DONE.toLowerCase()]: 'done',
  [RUN_STATUS.FAILED.toLowerCase()]: 'failed',
  cancelled: 'cancelled',
  timeout: 'timeout',
};

/** settled run status from its raw stored form — an unknown value reads as stopped */
export function runStatus(raw: string): AgentRunStatus {
  return AGENT_RUN_STATUSES[raw.toLowerCase()] ?? 'stopped';
}

/** one map, three renderings: the thread's short word, the drawer's run sentence,
 * and the status dot (cancelled/timeout stay neutral; the pulse respects reduced motion) */
export const AGENT_RUN_VIEW: { readonly [K in AgentRunStatus]: { label: string; run: string; dot: string } } = {
  running: { label: 'Working', run: 'Run in progress', dot: 'bg-warning motion-safe:animate-pulse' },
  done: { label: 'Completed', run: 'Run completed', dot: 'bg-success' },
  failed: { label: 'Failed', run: 'Run failed', dot: 'bg-error' },
  cancelled: { label: 'Cancelled', run: 'Run cancelled', dot: 'bg-accented' },
  timeout: { label: 'Timed out', run: 'Run timed out', dot: 'bg-accented' },
  stopped: { label: 'Stopped', run: 'Run stopped', dot: 'bg-accented' },
};

// ---- activity kinds: one word + one glyph for the drawer feed and the chat thread ----
const ACTIVITY_LABELS: { readonly [K in ActivityKind]: string } = {
  [ACTIVITY_KIND.NOTE]: 'Note',
  [ACTIVITY_KIND.QUESTION]: 'Question',
  [ACTIVITY_KIND.ANSWER]: 'Answer',
  [ACTIVITY_KIND.VERDICT]: 'Review verdict',
  [ACTIVITY_KIND.FORWARD]: 'Forwarded',
  [ACTIVITY_KIND.STATUS]: 'Status changed',
};

/** activity kind as a word — map hit, upper-cased legacy row, or humanized fallback */
export function activityLabel(kind: string): string {
  const hit = ACTIVITY_LABELS[kind as ActivityKind] ?? ACTIVITY_LABELS[kind.toUpperCase() as ActivityKind];
  return hit ?? humanizeEnum(kind);
}

export function activityIcon(kind: string): string {
  const k = kind.toLowerCase();
  if (k === 'question') return 'i-lucide-help-circle';
  if (k === 'answer') return 'i-lucide-check-check';
  if (k === 'forward') return 'i-lucide-corner-up-right';
  if (k === 'verdict') return 'i-lucide-gavel';
  return 'i-lucide-info';
}
