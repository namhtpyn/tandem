// TASK SCOPE LAW (#339) + ASSIGNEE SCOPE LAW (#353): project/assignee scope are
// ONE exact filter each on the paged task list, AND-composed with the
// search/status fragments and the obligation filters the router resolves
// against the db. An unknown id is an empty page — a filter is not a lookup, so
// the builder never validates existence.
import { describe, expect, it } from 'vitest';

import { buildTaskListWhere, taskListSearchFilters } from '../../server/domains/tasks/task-list-filters';

describe('task list search filters (#339/#353)', () => {
  it('no input renders no filter at all (empty where)', () => {
    expect(taskListSearchFilters({})).toEqual({
      searchFilter: undefined,
      statusFilter: undefined,
      projectFilter: undefined,
      assigneeFilter: undefined,
    });
    expect(buildTaskListWhere({})).toBeUndefined();
  });

  it('project scope is an exact match on tasks.projectId', () => {
    const { projectFilter, searchFilter, statusFilter } = taskListSearchFilters({ projectId: 'p-1' });
    expect(projectFilter).toEqual({ projectId: { eq: 'p-1' } });
    expect(searchFilter).toBeUndefined();
    expect(statusFilter).toBeUndefined();
  });

  it('assignee scope is an exact match on tasks.assigneeId', () => {
    const { assigneeFilter, searchFilter, statusFilter, projectFilter } = taskListSearchFilters({
      assigneeId: 'u-1',
    });
    expect(assigneeFilter).toEqual({ assigneeId: { eq: 'u-1' } });
    expect(searchFilter).toBeUndefined();
    expect(statusFilter).toBeUndefined();
    expect(projectFilter).toBeUndefined();
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

  it('assignee scope composes with every other fragment (#353)', () => {
    const where = buildTaskListWhere({ q: 'deploy', statusId: 's-1', projectId: 'p-1', assigneeId: 'u-1' }, [
      { id: { inArray: ['t-1'] } },
    ]);
    const parts = (where as { AND: Array<Record<string, unknown>> }).AND;
    expect(parts).toHaveLength(5);
    expect(parts).toContainEqual({ assigneeId: { eq: 'u-1' } });
  });

  it('a single fragment stays unwrapped (no needless AND)', () => {
    expect(buildTaskListWhere({ projectId: 'p-1' })).toEqual({ projectId: { eq: 'p-1' } });
    expect(buildTaskListWhere({ assigneeId: 'u-1' })).toEqual({ assigneeId: { eq: 'u-1' } });
  });

  it('an unknown project id stays a filter — no lookup, no throw', () => {
    expect(() => taskListSearchFilters({ projectId: 'does-not-exist' })).not.toThrow();
    expect(taskListSearchFilters({ projectId: 'does-not-exist' }).projectFilter).toEqual({
      projectId: { eq: 'does-not-exist' },
    });
  });

  it('an unknown assignee id stays a filter — no lookup, no throw (#353)', () => {
    expect(() => taskListSearchFilters({ assigneeId: 'left-the-company' })).not.toThrow();
    expect(taskListSearchFilters({ assigneeId: 'left-the-company' }).assigneeFilter).toEqual({
      assigneeId: { eq: 'left-the-company' },
    });
  });
});
