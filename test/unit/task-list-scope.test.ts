// TASK SCOPE LAW (#339): project scope is ONE exact filter on the paged task
// list, AND-composed with the search/status fragments and the obligation
// filters the router resolves against the db. An unknown project id is an empty
// page — a filter is not a lookup, so the builder never validates existence.
import { describe, expect, it } from 'vitest';

import { buildTaskListWhere, taskListSearchFilters } from '../../server/domains/tasks/task-list-filters';

describe('task list search filters (#339)', () => {
  it('no input renders no filter at all (empty where)', () => {
    expect(taskListSearchFilters({})).toEqual({
      searchFilter: undefined,
      statusFilter: undefined,
      projectFilter: undefined,
    });
    expect(buildTaskListWhere({})).toBeUndefined();
  });

  it('project scope is an exact match on tasks.projectId', () => {
    const { projectFilter, searchFilter, statusFilter } = taskListSearchFilters({ projectId: 'p-1' });
    expect(projectFilter).toEqual({ projectId: { eq: 'p-1' } });
    expect(searchFilter).toBeUndefined();
    expect(statusFilter).toBeUndefined();
  });

  it('q is trimmed before it reaches the ilike', () => {
    const { searchFilter } = taskListSearchFilters({ q: '  deploy ' });
    expect(searchFilter).toEqual({ OR: [{ title: { ilike: '%deploy%' } }, { description: { ilike: '%deploy%' } }] });
  });

  it('the composed where ANDs every present fragment, project scope included', () => {
    const where = buildTaskListWhere({ q: 'deploy', statusId: 's-1', projectId: 'p-1' }, [
      { id: { inArray: ['t-1'] } },
    ]);
    expect(where).toBeDefined();
    const parts = (where as { AND: Array<Record<string, unknown>> }).AND;
    expect(parts).toHaveLength(4);
    expect(parts).toContainEqual({ projectId: { eq: 'p-1' } });
    expect(parts).toContainEqual({ status: { eq: 's-1' } });
    expect(parts).toContainEqual({ id: { inArray: ['t-1'] } });
  });

  it('a single fragment stays unwrapped (no needless AND)', () => {
    expect(buildTaskListWhere({ projectId: 'p-1' })).toEqual({ projectId: { eq: 'p-1' } });
  });

  it('an unknown project id stays a filter — no lookup, no throw', () => {
    expect(() => taskListSearchFilters({ projectId: 'does-not-exist' })).not.toThrow();
    expect(taskListSearchFilters({ projectId: 'does-not-exist' }).projectFilter).toEqual({
      projectId: { eq: 'does-not-exist' },
    });
  });
});
