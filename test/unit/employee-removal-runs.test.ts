// EMPLOYEE REMOVAL runs (#370): removing an employee must neutralize their RUNNING
// REVIEW turns — a mid-flight review turn has no owner after the user delete, and its
// late settle would park a round it no longer owns. The settle half (the capture lives
// in review.service) is ONE guarded CAS per run (RUNNING -> STOPPED, output marker
// appended, finishedAt stamped). A lost CAS means the turn settled first — its verdict
// owns the outcome — and the stop-settled marker is unwound; nothing publishes when no
// row flipped.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  casRows: [] as Array<{ id: string }>,
  updates: [] as Array<{ table: string; set: Record<string, unknown>; where: unknown }>,
  published: [] as Array<[string, string]>,
  failFirst: false,
  holdCas: false,
  releaseCas: null as null | (() => void),
}));

vi.mock('../../server/db/index', async () => {
  const { taskRuns } = await import('../../server/db/schema');
  return {
    asDb: (x: unknown) => x,
    db: {
      query: {},
      update: (table: unknown) => ({
        set: (set: Record<string, unknown>) => ({
          where: (where: unknown) => ({
            returning: async () => {
              if (table !== taskRuns) return [];
              if (h.failFirst) {
                h.failFirst = false;
                throw new Error('db down');
              }
              if (h.holdCas) await new Promise<void>((resolve) => (h.releaseCas = resolve));
              h.updates.push({ table: 'taskRuns', set, where });
              return h.casRows;
            },
          }),
        }),
      }),
    },
  };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return {
    ...mod,
    publishChange: async (resource: string, action: string) => {
      h.published.push([resource, action]);
    },
  };
});

import { RUN_STATUS } from '#shared/enums';

import { stoppedRunMarkerIds, stopRunsForRemoval } from '../../server/domains/tasks/runner.service';
import { mockDb, taskRuns } from './helpers/mock-db';

/** render a captured drizzle condition to SQL + params (DB-mock predicate law: pin the
 * predicate by RENDERING it, never by a presence check) */
function renderCond(cond: unknown): string {
  const q = mockDb()
    .select()
    .from(taskRuns)
    .where(cond as never)
    .toSQL();
  return `${q.sql} ${JSON.stringify(q.params)}`;
}

beforeEach(() => {
  h.casRows = [];
  h.updates = [];
  h.published = [];
  h.failFirst = false;
  h.holdCas = false;
  h.releaseCas = null;
});

describe('stopRunsForRemoval (#370)', () => {
  it('settles each captured run STOPPED with ONE guarded CAS + publishes once', async () => {
    h.casRows = [{ id: 'run-1' }];
    expect(await stopRunsForRemoval(['run-1'])).toBe(1);
    expect(h.updates).toHaveLength(1);
    const { set, where } = h.updates[0]!;
    expect(set.status).toBe(RUN_STATUS.STOPPED);
    expect(set.finishedAt).toBeInstanceOf(Date);
    expect(set.exitCode).toBeNull();
    expect(set.output).toBeDefined(); // SQL append of the removal marker
    const sql = renderCond(where);
    expect(sql).toContain('"id" =');
    expect(sql).toContain('"status" =');
    expect(sql).toContain('RUNNING');
    // the CAS targets THIS run id (params carry it — never a presence-only pin)
    expect(sql).toContain('run-1');
    expect(h.published).toEqual([
      ['RUNS', 'UPDATE'],
      ['TASKS', 'UPDATE'],
    ]);
    // no live execution can own the marker — it is cleared at the verb
    expect(stoppedRunMarkerIds()).toEqual([]);
  });

  it('a lost CAS (the turn settled first) is a quiet no-op: no publish, marker unwound', async () => {
    h.casRows = [];
    expect(await stopRunsForRemoval(['run-1'])).toBe(0);
    expect(h.updates).toHaveLength(1); // the CAS was attempted
    expect(h.published).toHaveLength(0);
    expect(stoppedRunMarkerIds()).toEqual([]);
  });

  it('one failing run never stops the rest', async () => {
    // first statement throws, second succeeds — fault isolation is the contract
    h.failFirst = true;
    h.casRows = [{ id: 'run-2' }];
    expect(await stopRunsForRemoval(['run-1', 'run-2'])).toBe(1);
    expect(h.updates).toHaveLength(1); // run-2's CAS landed; run-1 was skipped
    expect(renderCond(h.updates[0]!.where)).toContain('run-2'); // …and targeted run-2, not run-1
    expect(h.published).toEqual([
      ['RUNS', 'UPDATE'],
      ['TASKS', 'UPDATE'],
    ]);
    expect(stoppedRunMarkerIds()).toEqual([]);
  });
});

describe('removal stop hardening (#370 r2)', () => {
  it('duplicate run ids are stopped once — a second CAS miss never unwinds the marker', async () => {
    h.casRows = [{ id: 'run-1' }];
    expect(await stopRunsForRemoval(['run-1', 'run-1'])).toBe(1);
    expect(h.updates).toHaveLength(1); // deduped before the loop
  });

  it('the marker is down BEFORE the awaited CAS — an in-flight turn never misses it', async () => {
    h.holdCas = true;
    h.casRows = [{ id: 'run-1' }];
    const pending = stopRunsForRemoval(['run-1']);
    await vi.waitFor(() => {
      if (!h.releaseCas) throw new Error('CAS not reached yet');
    });
    expect(stoppedRunMarkerIds()).toContain('run-1');
    h.releaseCas!();
    await pending;
    expect(stoppedRunMarkerIds()).toEqual([]);
  });

  it('appends the audit marker to the run output', async () => {
    h.casRows = [{ id: 'run-1' }];
    await stopRunsForRemoval(['run-1']);
    const set = h.updates[0]!.set;
    const rendered = mockDb()
      .update(taskRuns)
      .set({ output: set.output as never })
      .toSQL();
    expect(rendered.sql).toContain('employee removed');
  });
});
