// RETENTION LAW (#266): the daily retention leg bounds unbounded storage
// without deleting audit rows. These tests pin (a) the SHAPES the legs issue —
// every scan pushes its age/category predicate into the SQL WHERE and carries
// the batch LIMIT (never a fetch-all), the transcript blank keeps the row and
// blanks only output/prompt, the obligation delete matches non-PENDING +
// resolved-horizon only, the session delete matches expired-only — and (b) the
// throttle + fault-isolation contract: one run per 24h keyed on the persisted
// `retention_last_run` stamp (stamped ONLY on a full pass), a failed leg
// leaves the stamp and retries next tick, and runRetentionLeg never rejects.
import { inArray } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  settingWrites: [] as Array<[string, string]>,
  storedStamp: null as string | null,
  failGetSetting: false,
  legRows: 0,
  failLegs: false,
}));

vi.mock('../../server/domains/settings/settings.service', () => ({
  getSetting: vi.fn(async () => {
    if (h.failGetSetting) throw new Error('db down (setting read)');
    return h.storedStamp;
  }),
  setSetting: vi.fn(async (key: string, value: string) => {
    h.settingWrites.push([key, value]);
    h.storedStamp = value;
  }),
  getRunTimeoutMs: vi.fn(async () => 30 * 60_000),
  getTasksPerAgent: vi.fn(async () => 1),
}));

vi.mock('consola', () => ({
  consola: {
    withTag: () => ({
      warn: vi.fn(),
      error: () => {},
      success: () => {},
      info: () => {},
      start: () => {},
    }),
  },
}));

import {
  blankRunTranscripts,
  blankableTranscriptsScan,
  deleteExpiredSessions,
  deleteResolvedObligations,
  expiredSessionsScan,
  RETENTION_BATCH,
  RETENTION_STAMP_KEY,
  resolvedObligationsScan,
  retentionState,
  runRetentionLeg,
  terminalCategoryScan,
} from '#server/domains/tasks/retention.service';

import { mockDb, session, taskObligations, taskRuns } from './helpers/mock-db';

const CUTOFF = new Date('2026-11-06T00:00:00Z');

/** chainable fake executor for the behavior tests: scans chain, writes return
 * controlled rows (drizzle.mock can't execute — by design it throws). */
function fakeExec() {
  const p: Record<string, unknown> = {
    select: () => p,
    from: () => p,
    innerJoin: () => p,
    where: () => p,
    orderBy: () => p,
    limit: () => p,
    update: () => p,
    set: () => p,
    delete: () => p,
    returning: async () => {
      if (h.failLegs) throw new Error('db down (leg write)');
      return Array.from({ length: h.legRows }, (_, i) => ({ id: `row-${i}` }));
    },
  };
  return p;
}

describe('retention scan shapes (#266 — category join + LIMIT, never a fetch-all)', () => {
  it('leg 1 scan: settled-only (RUNNING excluded), finished-horizon predicate, terminal CATEGORY join (never status ids)', () => {
    const { sql, params } = blankableTranscriptsScan(CUTOFF, mockDb()).toSQL();
    expect(sql).toContain('"task_runs"."status" <> $1');
    expect(sql).toContain('"task_runs"."finished_at" < $2');
    expect(sql).toContain('inner join "task_messages" on "task_runs"."message_id" = "task_messages"."id"');
    expect(sql).toContain('inner join "tasks" on "task_messages"."task_id" = "tasks"."id"');
    // the terminal filter rides a task_statuses SUBQUERY on the CATEGORY column
    expect(sql).toContain(
      '"tasks"."status" in (select "id" from "task_statuses" where "task_statuses"."category" in ($3, $4))',
    );
    expect(params).toEqual(['RUNNING', CUTOFF.toISOString(), 'done', 'cancelled', RETENTION_BATCH]);
  });

  it('leg 1 scan: LIMIT-bounded oldest-first — relics beyond the batch drain tomorrow', () => {
    const { sql } = blankableTranscriptsScan(CUTOFF, mockDb()).toSQL();
    expect(sql).toContain('order by "task_runs"."finished_at" asc');
    expect(sql).toContain('limit $5');
  });

  it('terminal category scan selects status ids by category, no id literals', () => {
    const { sql, params } = terminalCategoryScan(mockDb()).toSQL();
    expect(sql).toContain('"task_statuses"."category" in ($1, $2)');
    expect(params).toEqual(['done', 'cancelled']);
  });

  it('leg 2 scan: non-PENDING + resolved-horizon only, LIMIT-bounded oldest-first', () => {
    const { sql, params } = resolvedObligationsScan(CUTOFF, mockDb()).toSQL();
    expect(sql).toContain('"task_obligations"."status" <> $1');
    expect(sql).toContain('"task_obligations"."resolved_at" < $2');
    expect(sql).toContain('order by "task_obligations"."resolved_at" asc');
    expect(sql).toContain('limit $3');
    expect(params).toEqual(['PENDING', CUTOFF.toISOString(), RETENTION_BATCH]);
  });

  it('leg 3 scan: expired sessions only (expires_at in the past), LIMIT-bounded', () => {
    const { sql, params } = expiredSessionsScan(CUTOFF, mockDb()).toSQL();
    expect(sql).toContain('"session"."expires_at" < $1');
    expect(sql).toContain('order by "session"."expires_at" asc');
    expect(sql).toContain('limit $2');
    expect(params).toEqual([CUTOFF.toISOString(), RETENTION_BATCH]);
  });

  it('leg 1 UPDATE blanks output + prompt in place (rows KEPT, never deleted)', () => {
    const { sql } = mockDb().update(taskRuns).set({ output: '', prompt: null }).where(inArray(taskRuns.id, [])).toSQL();
    expect(sql).toContain('update "task_runs" set');
    expect(sql).toContain('"output" = $1');
    expect(sql).toContain('"prompt" = $2');
    expect(sql.toLowerCase()).not.toContain('delete from');
  });

  it('legs 2+3 issue real DELETEs on their tables, id-scoped by the bounded scan', () => {
    const delOb = mockDb()
      .delete(taskObligations)
      .where(inArray(taskObligations.id, ['o-1']))
      .toSQL();
    const delSes = mockDb()
      .delete(session)
      .where(inArray(session.id, ['s-1']))
      .toSQL();
    expect(delOb.sql).toContain('delete from "task_obligations"');
    expect(delOb.sql).toContain('"task_obligations"."id" in');
    expect(delSes.sql).toContain('delete from "session"');
    expect(delSes.sql).toContain('"session"."id" in');
  });
});

describe('retention leg behavior (#266 — throttle + stamp + fault isolation)', () => {
  beforeEach(() => {
    h.settingWrites.length = 0;
    h.storedStamp = null;
    h.failGetSetting = false;
    h.legRows = 0;
    h.failLegs = false;
    retentionState.lastAt = 0;
    retentionState.lastWarnAt = 0;
  });

  it('a stale run executes all three legs and stamps ONLY after a full pass', async () => {
    const result = await runRetentionLeg(fakeExec());
    expect(result).toEqual({ blanked: 0, obligations: 0, sessions: 0 });
    expect(h.settingWrites).toEqual([[RETENTION_STAMP_KEY, expect.stringMatching(/^\d+$/)]]);
  });

  it('the persisted stamp throttles: a fresh stamp runs nothing and writes nothing', async () => {
    h.storedStamp = String(Date.now());
    const result = await runRetentionLeg(fakeExec());
    expect(result).toBeNull();
    expect(h.settingWrites).toHaveLength(0);
  });

  it('a corrupt stamp value is treated as stale (leg still runs, stamp replaced)', async () => {
    h.storedStamp = 'not-a-number';
    const result = await runRetentionLeg(fakeExec());
    expect(result).toEqual({ blanked: 0, obligations: 0, sessions: 0 });
    expect(h.settingWrites).toHaveLength(1);
  });

  it('a failed leg leaves the stamp untouched — the next tick retries', async () => {
    h.failLegs = true;
    const result = await runRetentionLeg(fakeExec());
    expect(result).toBeNull();
    expect(h.settingWrites).toHaveLength(0);
  });

  it('a failed settings read never rejects the tick (#172) and writes no stamp', async () => {
    h.failGetSetting = true;
    await expect(runRetentionLeg(fakeExec())).resolves.toBeNull();
    expect(h.settingWrites).toHaveLength(0);
  });

  it('counts return real row counts from the legs (bounded drain, not fetch-all)', async () => {
    h.legRows = 2;
    const result = await runRetentionLeg(fakeExec());
    expect(result).toEqual({ blanked: 2, obligations: 2, sessions: 2 });
  });

  it('the legs blank/delete through the same executor they were given', async () => {
    const rows = await blankRunTranscripts(CUTOFF, fakeExec());
    const obl = await deleteResolvedObligations(CUTOFF, fakeExec());
    const ses = await deleteExpiredSessions(CUTOFF, fakeExec());
    expect([rows, obl, ses]).toEqual([0, 0, 0]);
  });
});
