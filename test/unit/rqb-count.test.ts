import { inArray } from 'drizzle-orm';

import './helpers/pg';
// db.query.count / findManyAndCount extensions against the real test DB
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { db } from '../../server/db';
import { tasks } from '../../server/db/schema';

describe('rqb count/findManyAndCount (real db)', () => {
  let ids: string[] = [];

  beforeEach(async () => {
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

  it('count toSQL renders where clause', () => {
    const { sql: rendered } = db.query.tasks.count({ id: { in: ids } }).toSQL();
    expect(rendered).toContain('count(*)');
    expect(rendered).toContain('where');
  });

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

  it('findManyAndCount toSQL exposes both queries', () => {
    const { count, findMany } = db.query.tasks.findManyAndCount({ where: { id: { in: ids } } }).toSQL();
    expect(count.sql).toContain('count(*)');
    expect(findMany.sql).toContain('select');
  });

  it('installRqbExtensions on an empty query object returns early', async () => {
    const { installRqbExtensions } = await import('../../server/db/rqb-extensions');
    expect(() => installRqbExtensions({})).not.toThrow();
  });
});
