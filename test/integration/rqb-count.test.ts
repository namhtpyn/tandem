import { inArray } from 'drizzle-orm';
// db.query.count / findManyAndCount extensions against the real test DB
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyMigrations } from '#server/db';
import { db } from '#server/db';
import { tasks } from '#server/db/schema';

import { resetData } from './helpers/pg';

describe('rqb count/findManyAndCount (real db)', () => {
  let ids: string[] = [];

  beforeEach(async () => {
    await resetData();
    await applyMigrations();
    const rnd = Math.random().toString(16).slice(2, 8);
    ids = [1, 2, 3, 4, 5].map((n) => `rqb-${rnd}-${n}`);
    await db.insert(tasks).values(ids.map((id) => ({ id, title: `rqb ${rnd}` })));
  });

  afterEach(async () => {
    await db.delete(tasks).where(inArray(tasks.id, ids));
  });

  it('count() counts table rows', async () => {
    const total = await db.query.tasks.count();
    expect(total).toBeGreaterThanOrEqual(5);
  });

  it('count(filter) counts matching rows only', async () => {
    const total = await db.query.tasks.count({ id: { in: ids } });
    expect(total).toBe(5);
  });

  // count/findManyAndCount toSQL shape tests moved to test/unit/query-shape.test.ts

  it('findManyAndCount pages and totals in one await', async () => {
    const { data, total } = await db.query.tasks.findManyAndCount({
      where: { id: { in: ids } },
      orderBy: { id: 'asc' },
      limit: 2,
      offset: 0,
    });
    expect(total).toBe(5);
    expect(data.map((t: { id: string }) => t.id)).toEqual(ids.slice(0, 2));
  });

  it('installRqbExtensions on an empty query object returns early', async () => {
    const { installRqbExtensions } = await import('#server/db/rqb-extensions');
    expect(() => installRqbExtensions({})).not.toThrow();
  });
});
