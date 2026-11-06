import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// RETENTION LAW (#266): the daily retention leg bounds unbounded storage
// without deleting audit rows. These tests pin (a) the SHAPES the legs issue —
// every scan pushes its age/category predicate into the SQL WHERE and carries
// the batch LIMIT (never a fetch-all), the transcript blank keeps the row and
// blanks only output/prompt, the obligation delete matches non-PENDING +
// resolved-horizon only, the session delete matches expired-only — and (b) the
// throttle + fault-isolation contract: one run per 24h keyed on the persisted
// `retention_last_run` stamp (stamped ONLY on a full pass), a failed leg
// leaves the stamp and retries next tick, and runRetentionLeg never rejects.
import { type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  settingWrites: [] as Array<[string, string, unknown]>,
  storedStamp: null as string | null,
  failGetSetting: false,
  getSettingCalls: 0,
  runningDuringSettingRead: false,
  legRows: 0,
  failLegs: false,
  warnCalls: 0,
}));

vi.mock('../../server/domains/settings/settings.service', () => ({
  getSetting: vi.fn(async () => {
    h.getSettingCalls += 1;
    h.runningDuringSettingRead = retentionState.running;
    if (h.failGetSetting) throw new Error('db down (setting read)');
    return h.storedStamp;
  }),
  setSetting: vi.fn(async (key: string, value: string, ex?: unknown) => {
    h.settingWrites.push([key, value, ex]);
    // key-faithful like the real settings table: only the RUN stamp backs
    // getSetting(RETENTION_STAMP_KEY); the attempt stamp is a different row
    if (key === 'retention_last_run') h.storedStamp = value;
  }),
  getRunTimeoutMs: vi.fn(async () => 30 * 60_000),
  getTasksPerAgent: vi.fn(async () => 1),
}));

vi.mock('consola', () => ({
  consola: {
    withTag: () => ({
      warn: () => {
        h.warnCalls += 1;
      },
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
  RETENTION_ATTEMPT_KEY,
  RETENTION_BATCH,
  RETENTION_STAMP_KEY,
  resolvedObligationsScan,
  retentionState,
  runRetentionLeg,
  terminalCategoryScan,
} from '#server/domains/tasks/retention.service';

import { mockDb, session, taskObligations, taskRuns } from './helpers/mock-db';

const CUTOFF = new Date('2026-11-06T00:00:00Z');

/** recording fake executor: captures each write's table + set values + where
 * clause (drizzle calls update(table).set(v).where(sql).returning() on the
 * executor) so the tests pin the WRITE PATH the service actually issues —
 * not hand-built replicas of it (r3 finding). Scans chain untracked. */
function recordingExec() {
  const calls: Array<{ kind: string; table: unknown; set?: Record<string, unknown>; where?: unknown }> = [];
  let mode = 'select';
  let cur: { kind: string; table: unknown; set?: Record<string, unknown>; where?: unknown } | null = null;
  const p: Record<string, unknown> = {
    select: () => {
      mode = 'select';
      return p;
    },
    from: () => p,
    innerJoin: () => p,
    where: (w?: unknown) => {
      // always record onto the current write: the bounded scan rides INSIDE the
      // .where() argument and its select-chain runs mid-expression, AFTER
      // update()/delete() — the write's own .where() call lands last and wins
      if (cur) cur.where = w;
      return p;
    },
    orderBy: () => p,
    limit: () => p,
    update: (t: unknown) => {
      mode = 'update';
      cur = { kind: 'update', table: t };
      calls.push(cur);
      return p;
    },
    set: (v: Record<string, unknown>) => {
      if (cur && mode === 'update') cur.set = v;
      return p;
    },
    delete: (t: unknown) => {
      mode = 'delete';
      cur = { kind: 'delete', table: t };
      calls.push(cur);
      return p;
    },
    returning: async () => {
      if (h.failLegs) throw new Error('db down (leg write)');
      return Array.from({ length: h.legRows }, (_, i) => ({ id: `row-${i}` }));
    },
  };
  return { exec: p, calls };
}

function fakeExec() {
  return recordingExec().exec;
}

describe('retention scan shapes (#266 — category join + LIMIT, never a fetch-all)', () => {
  it('leg 1 scan: settled-only (RUNNING excluded), finished-horizon predicate, terminal CATEGORY join (never status ids)', () => {
    const { sql, params } = blankableTranscriptsScan(CUTOFF, mockDb()).toSQL();
    expect(sql).toContain('"task_runs"."status" <> $1');
    expect(sql).toContain('"task_runs"."finished_at" < $2');
    // already-blanked rows leave the target set — the exclusion arm is what
    // advances the drain past batch one (a blanked row matches NO arm)
    expect(sql).toContain(`(("task_runs"."output" <> '') or (("task_runs"."prompt" is not null)))`);
    expect(sql).toContain('inner join "task_messages" on "task_runs"."message_id" = "task_messages"."id"');
    expect(sql).toContain('inner join "tasks" on "task_messages"."task_id" = "tasks"."id"');
    // the terminal filter rides a task_statuses SUBQUERY on the CATEGORY column
    expect(sql).toContain(
      '"tasks"."status" in (select "id" from "task_statuses" where "task_statuses"."category" in ($3, $4))',
    );
    expect(sql).toContain('limit $5');
    expect(params).toEqual(['RUNNING', CUTOFF.toISOString(), 'done', 'cancelled', RETENTION_BATCH]);
  });

  it('leg 1 scan: a blanked row matches NO arm — drain advances past batch one (r1 P1 regression pin)', () => {
    const { sql } = blankableTranscriptsScan(CUTOFF, mockDb()).toSQL();
    expect(sql).toContain(`("task_runs"."output" <> '') or (("task_runs"."prompt" is not null)`);
    expect(sql).not.toContain('delete from');
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
    // resolved rows on a task that still carries a PENDING obligation are KEPT
    // (a live approval round displays them — r6 finding)
    expect(sql).toContain('not exists (select 1 from "task_obligations" "pending_twins"');
    expect(sql).toContain('"pending_twins"."task_id" = "task_obligations"."task_id"');
    expect(sql).toContain('"pending_twins"."status" = $3');
    expect(sql).toContain('order by "task_obligations"."resolved_at" asc');
    expect(sql).toContain('limit $4');
    expect(params).toEqual(['PENDING', CUTOFF.toISOString(), 'PENDING', RETENTION_BATCH]);
  });

  it('leg 3 scan: expired sessions only (expires_at in the past), LIMIT-bounded', () => {
    const { sql, params } = expiredSessionsScan(CUTOFF, mockDb()).toSQL();
    expect(sql).toContain('"session"."expires_at" < $1');
    expect(sql).toContain('order by "session"."expires_at" asc');
    expect(sql).toContain('limit $2');
    expect(params).toEqual([CUTOFF.toISOString(), RETENTION_BATCH]);
  });

  it('leg 1 write path: the service\u2019s own UPDATE blanks EXACTLY output+prompt, id-scoped by the bounded drain scan (r3: pinned on the real path)', async () => {
    const { exec, calls } = recordingExec();
    await blankRunTranscripts(CUTOFF, exec);
    const upd = calls.find((c) => c.kind === 'update');
    expect(upd, 'leg 1 must issue an UPDATE').toBeTruthy();
    expect(upd?.set).toEqual({ output: '', prompt: null }); // rows KEPT — only transcript text cleared
    const { sql } = new PgDialect().sqlToQuery(upd?.where as SQL);
    expect(upd?.where, 'the UPDATE must be id-scoped by the drain scan subquery').toBeTruthy();
    expect(sql).toContain('"task_runs"."id" in'); // id-scoped write, never an unbounded UPDATE
    expect(sql.toLowerCase()).not.toContain('delete from');
  });

  it('legs 2+3 write paths: the service\u2019s own DELETEs, id-scoped by their bounded scans (r3: pinned on the real path)', async () => {
    const { exec, calls } = recordingExec();
    await deleteResolvedObligations(CUTOFF, exec);
    const delOb = calls.find((c) => c.kind === 'delete' && c.table === taskObligations);
    expect(delOb, 'obligation delete recorded').toBeTruthy();
    expect(delOb?.where, 'obligation delete must be id-scoped by its scan').toBeTruthy();
    const obSql = new PgDialect().sqlToQuery(delOb?.where as SQL).sql;
    expect(obSql).toContain('"task_obligations"."id" in');
    await deleteExpiredSessions(CUTOFF, exec);
    const delSes = calls.find((c) => c.kind === 'delete' && c.table === session);
    expect(delSes, 'session delete recorded').toBeTruthy();
    expect(delSes?.where, 'session delete must be id-scoped by its scan').toBeTruthy();
    const sesSql = new PgDialect().sqlToQuery(delSes?.where as SQL).sql;
    expect(sesSql).toContain('"session"."id" in');
  });
});

describe('retention leg behavior (#266 — throttle + stamp + fault isolation)', () => {
  beforeEach(() => {
    h.settingWrites.length = 0;
    h.storedStamp = null;
    h.failGetSetting = false;
    h.getSettingCalls = 0;
    h.legRows = 0;
    h.failLegs = false;
    h.warnCalls = 0;
    retentionState.lastAt = 0;
    retentionState.lastWarnAt = 0;
    retentionState.running = false;
  });

  it('a stale run executes all three legs and stamps ONLY after a full pass', async () => {
    const result = await runRetentionLeg(fakeExec());
    expect(result).toEqual({ blanked: 0, obligations: 0, sessions: 0 });
    // attempt stamped BEFORE the legs, run stamped only after the full pass (r6)
    expect(h.settingWrites.map(([k]) => k)).toEqual([RETENTION_ATTEMPT_KEY, RETENTION_STAMP_KEY]);
    expect(h.settingWrites[1]?.[1]).toMatch(/^\d+$/);
    expect(retentionState.running).toBe(false); // guard cleared even on success
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
    expect(h.settingWrites.map(([k]) => k)).toEqual([RETENTION_ATTEMPT_KEY, RETENTION_STAMP_KEY]);
  });

  it('a failed leg leaves the RUN stamp untouched (attempt stamp proves the pass ran) — retry is a 15m backoff, never the next tick', async () => {
    h.failLegs = true;
    const result = await runRetentionLeg(fakeExec());
    expect(result).toBeNull();
    expect(h.settingWrites.map(([k]) => k)).toEqual([RETENTION_ATTEMPT_KEY]); // attempt stamped, run NOT
    // backoff: the immediate next tick is skipped, no re-entry storm
    const readsAfterFail = h.getSettingCalls;
    await runRetentionLeg(fakeExec());
    expect(h.getSettingCalls).toBe(readsAfterFail);
    expect(h.settingWrites).toHaveLength(1);
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

  it('warns RATE-LIMITED on repeated failures: one warn per window, not per tick', async () => {
    h.failLegs = true;
    await runRetentionLeg(fakeExec()); // fresh window → warn 1
    await runRetentionLeg(fakeExec()); // inside the window → suppressed
    expect(h.warnCalls).toBe(1);
    retentionState.lastWarnAt = 0; // simulate the warn window elapsing
    retentionState.lastAt = 0; // simulate the 15m backoff elapsing
    await runRetentionLeg(fakeExec()); // warn 2
    expect(h.warnCalls).toBe(2);
    expect(retentionState.running).toBe(false); // guard cleared on the failure path too
  });

  it('cache arms: a fresh persisted stamp is read once and cached — later ticks skip the settings read entirely', async () => {
    h.storedStamp = String(Date.now());
    await runRetentionLeg(fakeExec()); // persisted-stamp arm: one settings read, no legs, no writes
    expect(h.getSettingCalls).toBe(1);
    expect(h.settingWrites).toHaveLength(0);
    await runRetentionLeg(fakeExec()); // in-memory arm: returns BEFORE any settings read
    expect(h.getSettingCalls).toBe(1);
    expect(h.settingWrites).toHaveLength(0);
  });

  it('the cache arm anchors to the STAMP value, not the restart time (r5 pin: restarts cannot slide the 24h cadence)', async () => {
    vi.useFakeTimers();
    try {
      const boot = Date.now();
      const stampMs = boot - 60 * 60_000; // 1h-old stamp survives the restart
      h.storedStamp = String(stampMs);
      await runRetentionLeg(fakeExec());
      expect(retentionState.lastAt).toBe(stampMs); // anchored to the stamp, NOT boot time
      vi.setSystemTime(boot + 22 * 60 * 60_000); // 22h after boot: stamp is 23h old — must stay silent
      await runRetentionLeg(fakeExec());
      expect(h.getSettingCalls).toBe(1); // skipped in-memory, no fresh settings read
      expect(h.settingWrites).toHaveLength(0);
      vi.setSystemTime(boot + 23 * 60 * 60_000); // stamp is now exactly 24h old — the leg fires on the STAMP's cadence
      h.legRows = 1;
      const result = await runRetentionLeg(fakeExec());
      expect(result).toEqual({ blanked: 1, obligations: 1, sessions: 1 });
      expect(h.settingWrites.map(([k]) => k)).toEqual([RETENTION_ATTEMPT_KEY, RETENTION_STAMP_KEY]); // re-stamped after the full pass
    } finally {
      vi.useRealTimers();
    }
  });

  it('the run stamp write shares the legs\u2019 executor (single transaction surface, not the global db)', async () => {
    const ex = fakeExec();
    await runRetentionLeg(ex);
    const runWrite = h.settingWrites.find(([k]) => k === RETENTION_STAMP_KEY);
    expect(runWrite?.[2]).toBe(ex);
    const attemptWrite = h.settingWrites.find(([k]) => k === RETENTION_ATTEMPT_KEY);
    expect(attemptWrite?.[2]).toBe(ex);
  });

  it('a pass in flight blocks re-entry — ticks cannot stack duplicate concurrent passes', async () => {
    retentionState.running = true; // simulate a slow first-ever drain still running
    const result = await runRetentionLeg(fakeExec());
    expect(result).toBeNull();
    expect(h.getSettingCalls).toBe(0); // re-entry returns before ANY work
    expect(h.settingWrites).toHaveLength(0);
  });

  it('the re-entry flag is set SYNCHRONOUSLY before the first await (r3 TOCTOU pin): already true during the settings read', async () => {
    await runRetentionLeg(fakeExec());
    expect(h.runningDuringSettingRead).toBe(true); // a stalled settings read cannot re-admit the next tick
    expect(retentionState.running).toBe(false); // and cleared on completion
  });
});

describe('dispatcher wiring (#266 — the tick actually runs the leg; r6 pin)', () => {
  it('startDispatcher calls runRetentionLeg inside the tick, imported from the service', () => {
    const src = readFileSync(join(import.meta.dirname, '../../server/domains/tasks/dispatcher.service.ts'), 'utf8');
    expect(src).toContain("import { runRetentionLeg } from './retention.service';");
    const start = src.indexOf('export function startDispatcher');
    expect(start).toBeGreaterThan(-1);
    expect(src.slice(start)).toContain('void runRetentionLeg();'); // the ONE call site the probe's stamp arm depends on
  });
});
