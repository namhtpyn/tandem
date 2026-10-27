// query-shape tests: generated SQL asserted on the driver-less mock db
import { relationsFilterToSQL, SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { mockDb, tasks } from './helpers/mock-db';

describe('query shape (drizzle.mock)', () => {
  it('rqb count(filter) renders where clause', () => {
    const db = mockDb();
    const { sql: rendered } = db.query.tasks.count({ id: { in: ['a', 'b'] } }).toSQL();
    expect(rendered).toContain('count(*)');
    expect(rendered).toContain('where');
  });

  it('RQB with: joins through the declared relation', () => {
    const db = mockDb();
    const { sql: rendered } = db.query.taskMessages.findMany({ with: { task: true }, limit: 1 }).toSQL();
    expect(rendered.toLowerCase()).toContain('task_messages');
    expect(rendered.toLowerCase()).toContain('join');
  });

  // moved from test/integration/rqb-count.test.ts — shape only, literals replace the seeded ids
  it('count toSQL renders where clause', () => {
    const db = mockDb();
    const { sql: rendered } = db.query.tasks.count({ id: { in: ['rqb-a', 'rqb-b'] } }).toSQL();
    expect(rendered).toContain('count(*)');
    expect(rendered).toContain('where');
  });

  // moved from test/integration/rqb-count.test.ts; findManyAndCount starts both
  // queries eagerly and the driver-less mock rejects them — drain so vitest sees
  // no floating rejection
  it('findManyAndCount toSQL exposes both queries', async () => {
    const db = mockDb();
    const query = db.query.tasks.findManyAndCount({ where: { id: { in: ['rqb-a', 'rqb-b'] } } });
    const { count, findMany } = query.toSQL();
    expect(count.sql).toContain('count(*)');
    expect(findMany.sql).toContain('select');
    await query.then(undefined, () => undefined);
  });
});

describe('rqb-extensions shape (drizzle.mock)', () => {
  it('count() renders the quoted table plus the in-list params', () => {
    const db = mockDb();
    const { sql, params } = db.query.tasks.count({ id: { in: ['rqb-a', 'rqb-b'] } }).toSQL();
    expect(sql).toContain('count(*)');
    expect(sql).toContain('"tasks"."id" in');
    expect(params).toEqual(['rqb-a', 'rqb-b']);
  });

  it('count() with no filter renders no where clause', () => {
    const db = mockDb();
    const { sql } = db.query.tasks.count().toSQL();
    expect(sql).toContain('count(*)');
    expect(sql.toLowerCase()).not.toContain('where');
  });

  it('count() with an empty filter object renders no where (pins the built.sql?.length guard)', () => {
    const db = mockDb();
    const { sql } = db.query.tasks.count({}).toSQL();
    expect(sql.toLowerCase()).not.toContain('where');
  });

  it('count() with a nested relation filter throws — rc.5 two-arg relationsFilterToSQL resolves no relations', () => {
    const db = mockDb();
    expect(() => db.query.taskMessages.count({ task: { id: { in: ['t-1'] } } })).toThrowError(
      'Unknown relational filter field: "task"',
    );
  });

  it('findManyAndCount shares the where across both queries and carries the limit', async () => {
    const db = mockDb();
    const query = db.query.tasks.findManyAndCount({ where: { id: { in: ['rqb-a', 'rqb-b'] } }, limit: 2 });
    const { count, findMany } = query.toSQL();
    // same where clause: the filter params lead the findMany param list
    expect(count.sql).toContain('where');
    expect(findMany.sql).toContain('where');
    expect(findMany.params.slice(0, count.params.length)).toEqual(count.params);
    expect(findMany.params).toEqual(['rqb-a', 'rqb-b', 2]);
    await query.then(undefined, () => undefined);
  });
});

describe('relationsFilterToSQL chunk contract (rc.5 BuiltRelationsFilter)', () => {
  it('flat column filter returns non-empty chunks rendering the predicate', () => {
    const built = relationsFilterToSQL(tasks, { id: { in: ['p', 'q'] } });
    expect(built.hasRelationFilters).toBe(false);
    const chunks = built.sql ?? [];
    expect(chunks.length).toBeGreaterThan(0);
    // the chunks are the where body — renderable through a bare dialect, no db
    const { sql, params } = new PgDialect().sqlToQuery(new SQL(chunks));
    expect(sql).toContain('"tasks"."id" in');
    expect(params).toEqual(['p', 'q']);
  });

  it('empty filter object yields undefined sql — the empty arm the count guard skips', () => {
    const built = relationsFilterToSQL(tasks, {});
    expect(built.sql).toBeUndefined();
    expect(built.hasRelationFilters).toBe(false);
  });
  // nested-relation-filter throw is pinned via count() above — count() makes the
  // module's exact two-arg relationsFilterToSQL call, and only it carries the
  // concrete schema types that make `{ task: ... }` type-legal
});
