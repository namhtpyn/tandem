// query-shape tests: generated SQL asserted on the driver-less mock db
import { describe, expect, it } from 'vitest';

import { mockDb } from './helpers/mock-db';

describe('query shape (drizzle.mock)', () => {
  it('rqb count(filter) renders where clause', () => {
    const db = mockDb();
    const { sql: rendered } = db.query.tasks
      .count({ id: { in: ['a', 'b'] } })
      .toSQL();
    expect(rendered).toContain('count(*)');
    expect(rendered).toContain('where');
  });

  it('RQB with: joins through the declared relation', () => {
    const db = mockDb();
    const { sql: rendered } = db.query.taskMessages
      .findMany({ with: { task: true }, limit: 1 })
      .toSQL();
    expect(rendered.toLowerCase()).toContain('task_messages');
    expect(rendered.toLowerCase()).toContain('join');
  });
});
