import { NONE_ID } from './forms';

/** The tasks-list state that must survive a drill-down into a task detail (#341,
 *  TASK SCOPE LAW): the project scope (#339), the assignee scope (#353), the
 *  company awaiting toggle (#91) and the personal needs-my-decision inbox
 *  (#350) — all are URL-synced list state, so the detail URL carries them and
 *  the detail page's back link rebuilds the exact list the user came from. */
export type TaskListQuery = { project?: string; assignee?: string; awaiting?: '1'; inbox?: '1' };

/** the first VALID project value in a query param (arrays can carry several);
 *  the internal 'no selection' sentinel and blanks are display values, never a
 *  scope — `?project=__none__` must read as no scope (mirrors the API boundary) */
export function scopeFromQuery(v: unknown): string | null {
  for (const raw of Array.isArray(v) ? v : [v]) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (id && id !== NONE_ID) return id;
  }
  return null;
}

/** the list-state query a task-detail URL carries, normalized through the same
 *  scope rules as the list itself (NONE_ID / blanks / non-strings are dropped,
 *  unknown values never leak into a link) */
export function taskListQueryFrom(q: {
  project?: unknown;
  assignee?: unknown;
  awaiting?: unknown;
  inbox?: unknown;
}): TaskListQuery {
  const project = scopeFromQuery(q.project);
  const assignee = scopeFromQuery(q.assignee);
  const out: TaskListQuery = {};
  if (project) out.project = project;
  if (assignee) out.assignee = assignee;
  if (q.awaiting === '1') out.awaiting = '1';
  if (q.inbox === '1') out.inbox = '1';
  return out;
}

/** task-detail location that keeps the surrounding list state; the query stays
 *  empty when the detail was opened from an unscoped list, so URLs stay clean */
export function taskDetailLocation(taskId: string, query: TaskListQuery): { path: string; query: TaskListQuery } {
  return { path: `/tasks/${taskId}`, query };
}
