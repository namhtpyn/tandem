// TASK SCOPE LAW (#341): the session-scoped list state a task detail must carry
// so its back link rebuilds the exact list the user came from. The scope parser
// is shared with the list page, so a dead scope can never leak into a link.
import { describe, expect, it } from 'vitest';

import { scopeFromQuery, taskDetailLocation, taskListQueryFrom } from '../../app/utils/task-scope.ts';

describe('scopeFromQuery', () => {
  it('returns the first valid id and trims it', () => {
    expect(scopeFromQuery('p1')).toBe('p1');
    expect(scopeFromQuery('  p1  ')).toBe('p1');
    expect(scopeFromQuery(['', 'p1', 'p2'])).toBe('p1');
    expect(scopeFromQuery(['p2'])).toBe('p2');
  });

  it('never turns the no-selection sentinel or blanks into a scope', () => {
    expect(scopeFromQuery('__none__')).toBeNull();
    expect(scopeFromQuery(['__none__', 'p1'])).toBe('p1');
    expect(scopeFromQuery('')).toBeNull();
    expect(scopeFromQuery('   ')).toBeNull();
    expect(scopeFromQuery(undefined)).toBeNull();
    expect(scopeFromQuery(null)).toBeNull();
    expect(scopeFromQuery(7)).toBeNull();
    expect(scopeFromQuery([42, null, 'p1'])).toBe('p1');
  });
});

describe('taskListQueryFrom', () => {
  it('keeps a resolvable scope and the awaiting deep link', () => {
    expect(taskListQueryFrom({ project: 'p1', awaiting: '1' })).toEqual({ project: 'p1', awaiting: '1' });
    expect(taskListQueryFrom({ project: ' p1 ' })).toEqual({ project: 'p1' });
    expect(taskListQueryFrom({ awaiting: '1' })).toEqual({ awaiting: '1' });
  });

  it('carries the personal inbox deep link (#350)', () => {
    expect(taskListQueryFrom({ inbox: '1' })).toEqual({ inbox: '1' });
    expect(taskListQueryFrom({ project: 'p1', awaiting: '1', inbox: '1' })).toEqual({
      project: 'p1',
      awaiting: '1',
      inbox: '1',
    });
  });

  it('drops display values, dead params and unknown awaiting shapes', () => {
    expect(taskListQueryFrom({ project: '__none__', awaiting: '0' })).toEqual({});
    expect(taskListQueryFrom({ project: '', awaiting: true })).toEqual({});
    expect(taskListQueryFrom({})).toEqual({});
    expect(taskListQueryFrom({ inbox: '0' })).toEqual({});
    expect(taskListQueryFrom({ inbox: true })).toEqual({});
  });
});

describe('taskDetailLocation', () => {
  it('carries the list state onto the task URL', () => {
    expect(taskDetailLocation('t1', { project: 'p1', awaiting: '1' })).toEqual({
      path: '/tasks/t1',
      query: { project: 'p1', awaiting: '1' },
    });
  });

  it('stays clean for an unscoped list', () => {
    expect(taskDetailLocation('t1', {})).toEqual({ path: '/tasks/t1', query: {} });
  });
});
