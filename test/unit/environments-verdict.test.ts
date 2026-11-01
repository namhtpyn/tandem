// PROBE VERDICT LAW (#178): the last probe verdict persists on the row and the
// manager renders it from data — unit coverage for the invalidation decision +
// SQL shape; the live write + render + reload path is pinned by e2e environments.spec
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { connectionChanged } from '#server/domains/environments/environments.util';

import { environments, mockDb } from './helpers/mock-db';

describe('connectionChanged (verdict invalidation rule)', () => {
  it('name-only edit keeps the verdict', () => {
    expect(connectionChanged({ name: 'renamed' })).toBe(false);
  });

  it('every connection field alone invalidates', () => {
    expect(connectionChanged({ host: 'x' })).toBe(true);
    expect(connectionChanged({ port: '2222' })).toBe(true);
    expect(connectionChanged({ username: 'root' })).toBe(true);
    expect(connectionChanged({ secretId: null })).toBe(true);
    expect(connectionChanged({ secretId: 's1' })).toBe(true);
    expect(connectionChanged({ secretUsage: 'PASSWORD' })).toBe(true);
  });

  it('empty patch keeps the verdict', () => {
    expect(connectionChanged({})).toBe(false);
  });
});

describe('probe-verdict SQL shape (drizzle.mock)', () => {
  it('probe verdict update writes all three columns guarded by id', () => {
    const db = mockDb();
    const { sql, params } = db
      .update(environments)
      .set({ lastProbeOk: false, lastProbeDetail: 'refused', lastProbeAt: new Date(0) })
      .where(eq(environments.id, 'env-1'))
      .toSQL();
    expect(sql).toContain('"last_probe_ok"');
    expect(sql).toContain('"last_probe_detail"');
    expect(sql).toContain('"last_probe_at"');
    expect(sql).toContain('"environments"."id" =');
    expect(params.slice(0, 2)).toEqual([false, 'refused']);
  });

  it('update clearing the verdict binds NULLs for all three columns', () => {
    const db = mockDb();
    const { sql, params } = db
      .update(environments)
      .set({ lastProbeOk: null, lastProbeDetail: null, lastProbeAt: null })
      .toSQL();
    expect(sql).toContain('"last_probe_ok" = $1');
    expect(sql).toContain('"last_probe_detail" = $2');
    expect(sql).toContain('"last_probe_at" = $3');
    expect(params.slice(0, 3)).toEqual([null, null, null]);
  });
});
