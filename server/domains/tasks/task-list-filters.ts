import { escapeIlike } from '#shared/utils/escape-ilike';

/** the user-facing filters of the paged task list (search / status / project) */
export type TaskListSearchInput = { q?: string; statusId?: string; projectId?: string };

/**
 * TASK SCOPE LAW (#339): the list's user-facing filters as drizzle RQB where
 * fragments. `listTasksPaged` AND-composes them with the obligation filters it
 * must resolve against the db first (inbox / awaiting). An unknown project id
 * yields an empty page — a filter is not a lookup, never an error.
 * Exported for shape pins: the predicate render is asserted in unit tests.
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
