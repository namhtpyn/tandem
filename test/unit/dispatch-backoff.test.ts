import { eq } from 'drizzle-orm';

import './api-harness';
// Backoff ladder, quota-jump, dispatchAfter gating, reaper, and run timeout settle.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { env, setEnv } from '#server/domains/kernel/env';
import { ROLE, RUN_STATUS } from '#shared/enums';
import { STATUS } from '#shared/status';
import type { TaskRow } from '#shared/types';

import { makeProcCaller } from './helpers/procs.ts';

// mock ssh2: connect+exec succeed; the stream never closes on its own, so tests
// drive terminal events explicitly (error emit) or rely on the run-timeout timer
vi.mock('ssh2', () => {
  // writable silent ACP stream: captures writes, never answers protocol itself.
  // Tests drive terminal events (conn error => stream close, mirroring ssh2).
  class FakeStream {
    handlers: Record<string, Array<(d: unknown) => void>> = {};
    writes: string[] = [];
    on(ev: string, fn: (d: unknown) => void) {
      this.handlers[ev] = [...(this.handlers[ev] ?? []), fn];
      return this;
    }
    write(d: unknown) {
      this.writes.push(String(d));
    }
    signal() {
      /* ssh2 signal */
    }
    end() {
      /* swallow stdin */
    }
    close() {
      (this.handlers['close'] ?? []).forEach((f) => {
        (f as (c: unknown) => void)(null);
      });
    }
  }
  class FakeClient {
    static last: FakeClient;
    handlers: Record<string, Array<(d: unknown) => void>> = {};
    stream = new FakeStream();
    constructor() {
      FakeClient.last = this;
    }
    on(ev: string, fn: (d: unknown) => void) {
      this.handlers[ev] = [...(this.handlers[ev] ?? []), fn];
      return this;
    }
    end() {}
    exec(_c: string, cb: (e: Error | null, s: unknown) => void) {
      cb(null, this.stream);
    }
    connect(_o: unknown) {
      setTimeout(
        () =>
          (this.handlers['ready'] ?? []).forEach((f) => {
            (f as () => void)();
          }),
        0,
      );
    }
    // a lost connection tears down its open streams — runAcpTurn unblocks via close
    emitError(e: Error) {
      (this.handlers['error'] ?? []).forEach((f) => {
        (f as (x: Error) => void)(e);
      });
      this.stream.close();
    }
  }
  return { default: { Client: FakeClient } };
});

const admin = {
  id: '00000000-0000-7000-8000-cd5fca5e2d34',
  name: 'Admin',
  email: 'admin@tandem.local',
  role: ROLE.ADMIN,
};

// official oRPC call() helper — replaces hand-rolled ['~orpc'] internals poking
const procAdmin = await makeProcCaller({
  id: '00000000-0000-7000-8000-c5ea71554c77',
  name: 'A',
  email: 'a@x',
  role: ROLE.ADMIN,
});
const callProc = procAdmin as unknown as (path: string, input?: unknown) => Promise<any>;

beforeEach(async () => {
  const { db } = await import('#server/db');
  const { user, environments, aiEmployees, tasks } = await import('#server/db/schema');
  await db.insert(user).values({
    id: '00000000-0000-7000-8000-cd5fca5e2d34',
    name: 'Admin',
    email: 'admin@tandem.local',
    emailVerified: true,
    role: ROLE.ADMIN,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(user).values({
    id: '00000000-0000-7000-8000-79d931929132',
    name: 'Robby',
    email: 'robby@tandem.local',
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(environments).values({
    id: 'env-1',
    name: 'E1',
    host: '127.0.0.1',
    port: '2222',
    username: '00000000-0000-7000-8000-51e69892ab49',
  });
  await db.insert(aiEmployees).values({
    userId: '00000000-0000-7000-8000-79d931929132',
    environmentId: 'env-1',
    instructions: '',
    executable: 'hermes acp',
  });
  await db.insert(tasks).values({
    id: 't-1',
    title: 'B',
    description: '',
    status: STATUS.todo,
    assigneeId: '00000000-0000-7000-8000-79d931929132',
  });
});

describe('backoff ladder', () => {
  it('1st/2nd/3rd+ failures map to 1m/5m/15m', async () => {
    const { backoffFor } = await import('#server/domains/tasks/runner.service');
    expect(backoffFor(1, 'boom')).toBe(60_000);
    expect(backoffFor(2, 'boom')).toBe(5 * 60_000);
    expect(backoffFor(3, 'boom')).toBe(15 * 60_000);
    expect(backoffFor(99, 'boom')).toBe(15 * 60_000); // capped
    expect(backoffFor(0, 'boom')).toBe(60_000); // failStreak floor
  });

  it('quota signatures jump straight to the 15m tier', async () => {
    const { backoffFor } = await import('#server/domains/tasks/runner.service');
    expect(backoffFor(1, 'Error: 429 Too Many Requests')).toBe(15 * 60_000);
    expect(backoffFor(1, 'insufficient_quota: add credits')).toBe(15 * 60_000);
    expect(backoffFor(2, 'You exceeded your current quota')).toBe(15 * 60_000);
    expect(backoffFor(2, 'normal failure')).toBe(5 * 60_000); // negative control
  });

  it('a failed run sets failStreak + dispatchAfter; success resets both', async () => {
    const { db } = await import('#server/db');
    const { tasks } = await import('#server/db/schema');
    // deterministic fake failure — the ssh emitError choreography hung under CI
    // coverage runs (the mocked connect never readied there)
    setEnv({ TANDEM_FAKE_RUNNER: '1' });
    setEnv({ TANDEM_FAKE_SCRIPT: 'ERR: 429 rate limit exceeded' });
    setEnv({ TANDEM_FAKE_FAIL: '1' });
    try {
      const { dispatchTask } = await import('#server/domains/tasks/runner.service');
      const handle = await dispatchTask('t-1', 'http://t.local');
      const res = await handle.finished;
      expect(res.status).toBe(RUN_STATUS.FAILED);
      const task = (await db.select().from(tasks).where(eq(tasks.id, 't-1')))[0]!;
      expect(task.status).toBe(STATUS.todo);
      expect(task.failStreak).toBe(1);
      expect(task.dispatchAfter).not.toBeNull();
      expect(task.dispatchAfter!.getTime()).toBeGreaterThan(Date.now() + 50_000);
      // success resets both
      await db.update(tasks).set({ failStreak: 5, dispatchAfter: new Date() }).where(eq(tasks.id, 't-1'));
      setEnv({ TANDEM_FAKE_FAIL: '0' });
      const handle2 = await dispatchTask('t-1', 'http://t.local');
      expect((await handle2.finished).status).toBe(RUN_STATUS.DONE);
      const after = (await db.select().from(tasks).where(eq(tasks.id, 't-1')))[0]!;
      expect(after.failStreak).toBe(0);
      expect(after.dispatchAfter).toBeNull();
    } finally {
      setEnv({ TANDEM_FAKE_SCRIPT: undefined });
      setEnv({ TANDEM_FAKE_FAIL: undefined });
      setEnv({ TANDEM_FAKE_RUNNER: '1' });
    }
  }, 30_000);

  it('findEligible skips tasks still in backoff and picks them up after it passes', async () => {
    const { db } = await import('#server/db');
    const { tasks } = await import('#server/db/schema');
    const { findEligible } = await import('#server/domains/tasks/dispatcher.service');
    await db
      .update(tasks)
      .set({ dispatchAfter: new Date(Date.now() + 60_000) })
      .where(eq(tasks.id, 't-1'));
    expect(await findEligible()).toBeNull();
    await db
      .update(tasks)
      .set({ dispatchAfter: new Date(Date.now() - 1000) })
      .where(eq(tasks.id, 't-1'));
    const hit = await findEligible();
    expect(hit?.taskId).toBe('t-1');
  });
});

describe('stale-run reaper', () => {
  it('fails ancient running runs and bounces the task with a long backoff', async () => {
    const { db } = await import('#server/db');
    const { tasks, taskRuns } = await import('#server/db/schema');
    await db.insert(taskRuns).values({
      id: 'r-old',
      taskId: 't-1',
      employeeId: '00000000-0000-7000-8000-79d931929132',
      environmentId: 'env-1',
      status: RUN_STATUS.RUNNING,
      output: 'partial output',
      startedAt: new Date(Date.now() - 3 * 60 * 60_000),
    });
    await db.update(tasks).set({ status: STATUS.doing }).where(eq(tasks.id, 't-1'));
    const { reapStaleRuns } = await import('#server/domains/tasks/dispatcher.service');
    expect(await reapStaleRuns()).toBe(1);
    const run = (await db.select().from(taskRuns)).find((r) => r.id === 'r-old')!;
    expect(run.status).toBe(RUN_STATUS.FAILED);
    expect(run.output).toContain('[reaper]');
    const task = (await db.select().from(tasks)).find((x) => x.id === 't-1')!;
    expect(task.status).toBe(STATUS.todo);
    expect(task.failStreak).toBe(1);
    expect(task.dispatchAfter!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    // fresh running runs are left alone
    await db.insert(taskRuns).values({
      id: 'r-new',
      taskId: 't-1',
      employeeId: '00000000-0000-7000-8000-79d931929132',
      environmentId: 'env-1',
      status: RUN_STATUS.RUNNING,
      output: '',
      startedAt: new Date(),
    });
    expect(await reapStaleRuns()).toBe(0);
  });

  it('leaves the task alone when the stale run is not the newest one', async () => {
    const { db } = await import('#server/db');
    const { tasks, taskRuns } = await import('#server/db/schema');
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    await db.insert(taskRuns).values({
      id: 'r-a',
      taskId: 't-1',
      employeeId: '00000000-0000-7000-8000-79d931929132',
      environmentId: 'env-1',
      status: RUN_STATUS.RUNNING,
      output: '',
      startedAt: old,
    });
    await db.insert(taskRuns).values({
      id: 'r-b',
      taskId: 't-1',
      employeeId: '00000000-0000-7000-8000-79d931929132',
      environmentId: 'env-1',
      status: RUN_STATUS.RUNNING,
      output: '',
      startedAt: new Date(Date.now() - 2 * 60 * 60_000),
    });
    await db.update(tasks).set({ status: STATUS.doing }).where(eq(tasks.id, 't-1'));
    const { reapStaleRuns } = await import('#server/domains/tasks/dispatcher.service');
    expect(await reapStaleRuns()).toBe(2); // both stale -> both reaped
    // now only ONE new run: reaping it must NOT bounce when a newer done run exists
    await db.insert(taskRuns).values({
      id: 'r-c',
      taskId: 't-1',
      employeeId: '00000000-0000-7000-8000-79d931929132',
      environmentId: 'env-1',
      status: RUN_STATUS.RUNNING,
      output: '',
      startedAt: new Date(Date.now() - 3 * 60 * 60_000),
    });
    await db.insert(taskRuns).values({
      id: 'r-d',
      taskId: 't-1',
      employeeId: '00000000-0000-7000-8000-79d931929132',
      environmentId: 'env-1',
      status: RUN_STATUS.DONE,
      exitCode: 0,
      output: '',
      startedAt: new Date(),
    });
    await db
      .update(tasks)
      .set({ status: RUN_STATUS.DONE, failStreak: 0, dispatchAfter: null })
      .where(eq(tasks.id, 't-1'));
    expect(await reapStaleRuns()).toBe(1); // r-c reaped
    const task = (await db.select().from(tasks)).find((x) => x.id === 't-1')!;
    expect(task.status).toBe(RUN_STATUS.DONE); // NOT bounced: r-d is newer
  });
});

describe('double settle', () => {
  it('events after the timer are ignored (idempotent settle)', async () => {
    const { setSetting } = await import('#server/domains/settings/settings.service');
    await setSetting('run_timeout_ms', '60');
    try {
      const { runOverSsh } = await import('#server/domains/tasks/ssh-exec.util');
      const lines: string[] = [];
      let finishCount = 0;
      const done = new Promise<{ status: string }>((r) => {
        void runOverSsh(
          { env: { host: 'x', port: '22', username: '00000000-0000-7000-8000-51e69892ab49' } },
          'cmd',
          '',
          (l) => lines.push(l),
          async () => {
            finishCount += 1;
          },
          (v) => r(v as { status: string }),
        );
      });
      const res = await done;
      expect(res.status).toBe(RUN_STATUS.FAILED);
      // error arriving after timeout must not double-finish
      const clientMod = (await import('ssh2')).default;
      const FakeClient = clientMod.Client as unknown as { last?: { emitError(e: Error): void } };
      await new Promise((rs) => setTimeout(rs, 30));
      FakeClient.last?.emitError(new Error('late error'));
      await new Promise((rs) => setTimeout(rs, 50));
      expect(finishCount).toBe(1);
      expect(lines.filter((l) => l.includes('late')).length).toBe(0);
    } finally {
      await setSetting('run_timeout_ms', '1800000');
    }
  }, 5000);

  it('a failed run on a deleted task does not crash (failStreak default arm)', async () => {
    // task vanishes MID-RUN (fake run still ticking): finish must not crash on the
    // missing row — same ssh-error coverage as before, without the emitError dance
    setEnv({ TANDEM_FAKE_RUNNER: '1' });
    setEnv({ TANDEM_FAKE_SCRIPT: 'working slowly' });
    setEnv({ TANDEM_FAKE_DELAY_MS: '120' });
    setEnv({ TANDEM_FAKE_FAIL: '1' });
    try {
      const { dispatchTask } = await import('#server/domains/tasks/runner.service');
      const handleP = dispatchTask('t-1', 'http://t.local');
      // delete the task once the run row exists (mid-run), before the fake run ends
      await vi.waitFor(async () => {
        // lazy imports: the file's own db destructures are lazy too — a static
        // import here collides (TDZ) with them
        const { db } = await import('#server/db');
        const { taskRuns } = await import('#server/db/schema');
        const rows = await db.select({ id: taskRuns.id }).from(taskRuns).where(eq(taskRuns.taskId, 't-1'));
        expect(rows.length).toBeGreaterThan(0);
      });
      const { db } = await import('#server/db');
      const { tasks } = await import('#server/db/schema');
      await db.delete(tasks).where(eq(tasks.id, 't-1'));
      const handle = await handleP;
      const res = await handle.finished;
      expect(res.status).toBe(RUN_STATUS.FAILED); // the run itself failed; the bounce no-ops on the missing row
    } finally {
      setEnv({ TANDEM_FAKE_SCRIPT: undefined });
      setEnv({ TANDEM_FAKE_DELAY_MS: undefined });
      setEnv({ TANDEM_FAKE_FAIL: undefined });
      setEnv({ TANDEM_FAKE_RUNNER: '1' });
    }
  }, 30_000);

  it('live rows expose dispatchAfter when set (router non-null arm)', async () => {
    const { db } = await import('#server/db');
    const { tasks } = await import('#server/db/schema');
    await db
      .update(tasks)
      .set({ dispatchAfter: new Date(Date.now() + 60_000), failStreak: 2 })
      .where(eq(tasks.id, 't-1'));
    const iter = await callProc('tasks.live', {});
    const snap = await iter.next();
    await iter.return?.();
    const rows = snap.value as TaskRow[];
    const row = rows.find((r) => r.id === 't-1')!;
    expect(row.dispatchAfter).not.toBeNull();
    expect(row.failStreak).toBe(2);
  });
});

describe('ssh run timeout', () => {
  it('a run that never closes settles as failed via the timer', async () => {
    const { setSetting } = await import('#server/domains/settings/settings.service');
    await setSetting('run_timeout_ms', '80');
    try {
      const { runOverSsh } = await import('#server/domains/tasks/ssh-exec.util');
      const lines: string[] = [];
      let finished = false;
      const done = new Promise<{ status: string }>((r) => {
        void runOverSsh(
          { env: { host: 'x', port: '22', username: '00000000-0000-7000-8000-51e69892ab49' } },
          'cmd',
          '',
          (l) => lines.push(l),
          async () => {
            finished = true;
          },
          (v) => r(v as { status: string }),
        );
      });
      const res = await done;
      expect(res.status).toBe(RUN_STATUS.FAILED);
      expect(finished).toBe(true);
      expect(lines.some((l) => l.includes('timed out'))).toBe(true);
    } finally {
      await setSetting('run_timeout_ms', '1800000');
    }
  }, 5000);
});
