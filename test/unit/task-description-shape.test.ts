// SNAPSHOT-SLIMMING LAW (#130 slice 3): a task's description body never rides
// list payloads. These tests pin the SHAPES the wire actually issues: the
// on-demand description scan selects id + description filtered by PK id — the
// ONE select where the body travels — and the shared list-row type carries no
// description key. The fetch→NOT_FOUND branch (unknown task id) executes a real
// query, which mockDb throws on by design — that contract is covered by the e2e
// suite against the built server, not here.
import { describe, expect, it } from 'vitest';

import { taskDescriptionScan, taskListColumns } from '#server/domains/tasks/task-description';

import { mockDb } from './helpers/mock-db';

describe('on-demand description scan (#130 slice 3)', () => {
  it('is the ONE select where the description body travels, keyed by task id', () => {
    const db = mockDb();
    const { sql, params } = db.query.tasks.findFirst(taskDescriptionScan('t-9')).toSQL();
    expect(sql).toContain('"description" as "description"');
    expect(sql).toContain('"id" as "id"');
    expect(sql).toContain('."id" =');
    expect(params).toContain('t-9');
  });

  it('projects exactly { id, description } — no rider columns', () => {
    expect(Object.keys(taskDescriptionScan('t-1').columns).sort()).toEqual(['description', 'id']);
  });

  it('where is a plain PK eq (single-row lookup)', () => {
    expect(taskDescriptionScan('t-1').where).toEqual({ id: { eq: 't-1' } });
  });
});

describe('list payload slimming (#130 slice 3)', () => {
  // taskListColumns() is the EXACT columns object both tasks.list and
  // tasks.listPaged select (the router has no other columns literal to drift)
  it('list selects project the snapshot-safe set — the description body is not a list column', () => {
    expect(Object.keys(taskListColumns())).not.toContain('description');
    expect(Object.keys(taskListColumns()).sort()).toEqual([
      'assigneeId',
      'createdAt',
      'createdBy',
      'dispatchAfter',
      'failStreak',
      'id',
      'ownerId',
      'parentTaskId',
      'projectId',
      'reviewers',
      'status',
      'title',
      'updatedAt',
    ]);
  });
});
