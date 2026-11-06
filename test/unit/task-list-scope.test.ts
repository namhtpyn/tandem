// TASK SCOPE LAW (#339): project scope is ONE exact filter on the paged task
// list, built beside the search/status filters so the router AND-composes all
// three with its obligation filters. An unknown project id is an empty page —
// a filter is not a lookup, so the builder never validates existence.
import { describe, expect, it } from 'vitest';

import { taskListSearchFilters } from '../../server/domains/tasks/task-list-filters';

describe('task list search filters (#339)', () => {
  it('no input renders no filter at all (empty where)', () => {
    expect(taskListSearchFilters({})).toEqual({
      searchFilter: undefined,
      statusFilter: undefined,
      projectFilter: undefined,
    });
  });

  it('project scope is an exact match on tasks.projectId', () => {
    const { projectFilter, searchFilter, statusFilter } = taskListSearchFilters({ projectId: 'p-1' });
    expect(projectFilter).toEqual({ projectId: { eq: 'p-1' } });
    expect(searchFilter).toBeUndefined();
    expect(statusFilter).toBeUndefined();
  });

  it('composes with search and status (the router ANDs every present fragment)', () => {
    const { searchFilter, statusFilter, projectFilter } = taskListSearchFilters({
      q: '  deploy ',
      statusId: 's-1',
      projectId: 'p-1',
    });
    // q is trimmed before it reaches the ilike
    expect(searchFilter).toEqual({ OR: [{ title: { ilike: '%deploy%' } }, { description: { ilike: '%deploy%' } }] });
    expect(statusFilter).toEqual({ status: { eq: 's-1' } });
    expect(projectFilter).toEqual({ projectId: { eq: 'p-1' } });
  });

  it('an unknown project id stays a filter — no lookup, no throw', () => {
    expect(() => taskListSearchFilters({ projectId: 'does-not-exist' })).not.toThrow();
    expect(taskListSearchFilters({ projectId: 'does-not-exist' }).projectFilter).toEqual({
      projectId: { eq: 'does-not-exist' },
    });
  });
});
