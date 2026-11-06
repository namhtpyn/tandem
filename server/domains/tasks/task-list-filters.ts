import { escapeIlike } from '#shared/utils/escape-ilike';

/** the user-facing filters of the paged task list (search / status / project) */
export type TaskListSearchInput = { q?: string; statusId?: string; projectId?: string };

/** one drizzle RQB where fragment (kept structural — the router casts at the query) */
type ListFilter = Record<string, unknown>;

/**
 * TASK SCOPE LAW (#339): the list's user-facing filters as drizzle RQB where
 * fragments. An unknown project id yields an empty page — a filter is not a
 * lookup, never an error.
 */
export function taskListSearchFilters(input: TaskListSearchInput) {
  const q = input.q?.trim();
  const searchFilter = q
    ? { OR: [{ title: { ilike: `%${escapeIlike(q)}%` } }, { description: { ilike: `%${escapeIlike(q)}%` } }] }
    : undefined;
  const statusFilter = input.statusId ? { status: { eq: input.statusId } } : undefined;
  const projectFilter = input.projectId ? { projectId: { eq: input.projectId } } : undefined;
  return { searchFilter, statusFilter, projectFilter };
}

/**
 * AND-compose the search/status/project fragments with the obligation filters
 * `listTasksPaged` resolves against the db first (inbox / awaiting). `undefined`
 * means no filter at all — the caller supplies the match-all sentinel.
 * Exported with the builder so the composed predicate is unit-pinned (#339 r1).
 */
export function buildTaskListWhere(input: TaskListSearchInput, obligations: ListFilter[] = []): ListFilter | undefined {
  const { searchFilter, statusFilter, projectFilter } = taskListSearchFilters(input);
  const filters = [searchFilter, statusFilter, projectFilter, ...obligations].filter(
    (f): f is ListFilter => f !== undefined,
  );
  if (filters.length === 0) return undefined;
  return filters.length === 1 ? filters[0] : { AND: filters };
}
