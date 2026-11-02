// BY-ID READ LAW (#220): a surface that renders exactly ONE task reads tasks.get —
// every list column PLUS the description body, keyed by PK id; never a
// whole-list snapshot filtered client-side. These tests pin the SHAPES the wire
// issues: the by-id scan's SQL (PK filter + body column), the projection being
// exactly the list columns + description (the snapshot itself stays slim), and
// the hot-path index backing every newest-first list sort. The fetch→NOT_FOUND
// branch (unknown task id) executes a real query, which mockDb throws on by
// design — that contract is covered by the e2e suite against the built server.
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { taskGetScan, taskListColumns } from '#server/domains/tasks/task-description';

import { mockDb, tasks } from './helpers/mock-db';

describe('by-id task read (#220)', () => {
  it('is ONE PK-keyed select carrying the description body', () => {
    const db = mockDb();
    const { sql, params } = db.query.tasks.findFirst(taskGetScan('t-9')).toSQL();
    expect(sql).toContain('"description" as "description"');
    expect(sql).toContain('."id" =');
    expect(params).toContain('t-9');
  });

  it('projects exactly the list columns + description — nothing wider', () => {
    const expected = [...Object.keys(taskListColumns()), 'description'].sort();
    expect(Object.keys(taskGetScan('t-1').columns).sort()).toEqual(expected);
    // the snapshot stays slim: the description body never re-enters list payloads
    expect(Object.keys(taskListColumns())).not.toContain('description');
  });

  it('is backed by the tasks_created_id_idx hot-path index for every list sort', () => {
    const cfg = getTableConfig(tasks);
    const idx = cfg.indexes.find((i) => i.config.name === 'tasks_created_id_idx');
    expect(idx).toBeDefined();
    expect(idx?.config.columns.map((c) => (c as { name?: string }).name)).toEqual(['created_at', 'id']);
  });
});
