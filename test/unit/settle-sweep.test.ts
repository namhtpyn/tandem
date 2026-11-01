// SANDBOX SWEEP LAW (#160): after a run settles, the task's whole sandbox
// staging dir is removed once NO OTHER run of the task is running — on the
// SUCCESS path too. The old code returned before cleanup on success, and the
// failure path's sibling check counted the settling run itself (which still
// reads RUNNING until writer.finish, after collect), so the sweep could never
// fire anywhere and out/ grew until the 50MB cap silently dropped every later
// deliverable. Collect is idempotent per task: a byte-identical output is
// never stored twice.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RUN_STATUS } from '#shared/enums';

const h = vi.hoisted(() => ({
  siblingRows: [] as Array<{ id: string }>,
  dupRows: [] as Array<{ id: string }>,
  inserts: [] as Array<Record<string, unknown>>,
  saves: [] as Array<unknown[]>,
  collectImpl: null as null | (() => Promise<Array<{ localPath: string; filename: string }>>),
  cleanupCalls: [] as Array<unknown[]>,
  cleanupThrow: false,
}));

vi.mock('../../server/db/index', async () => {
  const { taskRuns, taskAttachments } = await import('../../server/db/schema');
  return {
    asDb: (x: unknown) => x,
    db: {
      select: () => ({
        from: (table: unknown) => {
          const chain: {
            innerJoin: () => typeof chain;
            where: () => Promise<Array<{ id: string }>>;
          } = {
            innerJoin: () => chain,
            where: async () => (table === taskRuns ? h.siblingRows : h.dupRows),
          };
          return chain;
        },
      }),
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          h.inserts.push(v);
          return { returning: async () => [v] };
        },
      }),
    },
  };
});

vi.mock('../../server/domains/tasks/ssh-files.util', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/ssh-files.util')>();
  return {
    ...mod,
    collectRunOutputs: async () => (h.collectImpl ? h.collectImpl() : []),
    cleanupTaskFiles: async (...args: unknown[]) => {
      h.cleanupCalls.push(args);
      if (h.cleanupThrow) throw new Error('rm failed (injected)');
    },
  };
});

vi.mock('../../server/domains/kernel/kernel', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/kernel/kernel')>();
  return { ...mod, publishChange: async () => {} };
});

vi.mock('../../server/domains/tasks/attachments.util', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/attachments.util')>();
  return { ...mod, saveAttachmentBytes: async (...args: unknown[]) => void h.saves.push(args) };
});

vi.mock('../../server/domains/tasks/ssh-exec.util', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/ssh-exec.util')>();
  return { ...mod, loadClient: async () => class {} };
});

import {
  sweepActiveSiblingScan,
  settleAttachments,
  sweepTaskSandboxWhenLastRun,
} from '../../server/domains/tasks/runner.service';
import { mockDb } from './helpers/mock-db';

type SshPlan = import('../../server/domains/tasks/ssh-exec.util').SshPlan;
const sshPlan = { host: 'h', port: 22 } as unknown as SshPlan;

const pngFile = (name: string, byte = 1) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'settle-'));
  const file = path.join(dir, name);
  writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, byte, 2, 3, 4]));
  return file;
};

beforeEach(() => {
  h.siblingRows = [];
  h.dupRows = [];
  h.inserts = [];
  h.saves = [];
  h.collectImpl = null;
  h.cleanupCalls = [];
  h.cleanupThrow = false;
});

describe('sweepActiveSiblingScan shape (#160)', () => {
  it('excludes the settling run itself — its row still reads RUNNING at settle time', () => {
    const db = mockDb();
    const { sql, params } = sweepActiveSiblingScan(db, 't1', 'r1').toSQL();
    const flat = sql.replace(/\s+/g, ' ').toLowerCase();
    expect(flat).toContain('"task_runs"."id" <>');
    expect(flat).toContain('"status" =');
    expect(params).toEqual([RUN_STATUS.RUNNING, 't1', 'r1']);
  });

  it('sweep skips while a sibling runs and sweeps when last', async () => {
    const taskId = 't-sib';
    h.siblingRows = [{ id: 'r-other' }];
    await expect(sweepTaskSandboxWhenLastRun(taskId, 'r1', sshPlan)).resolves.toBe(false);
    expect(h.cleanupCalls).toHaveLength(0);
    h.siblingRows = [];
    await expect(sweepTaskSandboxWhenLastRun(taskId, 'r1', sshPlan)).resolves.toBe(true);
    expect(h.cleanupCalls).toHaveLength(1);
    expect(h.cleanupCalls[0]?.[2]).toBe(taskId);
  });

  it('a failed sweep never throws (best-effort)', async () => {
    h.cleanupThrow = true;
    await expect(sweepTaskSandboxWhenLastRun('t1', 'r1', sshPlan)).resolves.toBe(false);
  });
});

describe('settleAttachments sweeps staging (#160)', () => {
  it('SUCCESS path sweeps when no sibling run is active — the old code returned before cleanup', async () => {
    const file = pngFile('report.png');
    h.collectImpl = async () => [{ localPath: file, filename: 'report.png' }];
    const res = await settleAttachments('t1', 'r1', sshPlan, 'done');
    expect(res.collected).toBe(1);
    expect(res.tokens).toHaveLength(1);
    expect(h.inserts).toHaveLength(1);
    expect(h.inserts[0]?.kind).toBe('output');
    expect(h.cleanupCalls).toHaveLength(1);
    expect(h.cleanupCalls[0]?.[2]).toBe('t1');
  });

  it('an active sibling run blocks the sweep (its own settle will run it)', async () => {
    const file = pngFile('report.png');
    h.siblingRows = [{ id: 'r-other' }];
    h.collectImpl = async () => [{ localPath: file, filename: 'report.png' }];
    const res = await settleAttachments('t1', 'r1', sshPlan, 'done');
    expect(res.collected).toBe(1);
    expect(h.cleanupCalls).toHaveLength(0);
    expect(h.inserts).toHaveLength(1);
  });

  it('a failed collect still sweeps — the failure path was the only one that ever tried', async () => {
    h.collectImpl = async () => {
      throw new Error('ssh down');
    };
    const res = await settleAttachments('t1', 'r1', sshPlan, 'failed');
    expect(res).toEqual({ collected: 0, tokens: [] });
    expect(h.cleanupCalls).toHaveLength(1);
  });

  it('a failed sweep never fails the settle', async () => {
    const file = pngFile('report.png');
    h.cleanupThrow = true;
    h.collectImpl = async () => [{ localPath: file, filename: 'report.png' }];
    const res = await settleAttachments('t1', 'r1', sshPlan, 'done');
    expect(res.collected).toBe(1);
    expect(h.inserts).toHaveLength(1);
  });
});

describe('collect is idempotent per task (#160)', () => {
  it('a byte-identical output already stored is not stored again — no second row, no bytes, no tokens', async () => {
    const file = pngFile('report.png');
    h.dupRows = [{ id: 'existing' }];
    h.collectImpl = async () => [{ localPath: file, filename: 'report.png' }];
    const res = await settleAttachments('t1', 'r1', sshPlan, 'done');
    expect(res.collected).toBe(1);
    expect(res.tokens).toEqual([]);
    expect(h.inserts).toHaveLength(0);
    expect(h.saves).toHaveLength(0);
  });

  it('a fresh output stores normally when nothing matches', async () => {
    const file = pngFile('fresh.png', 7);
    h.collectImpl = async () => [{ localPath: file, filename: 'fresh.png' }];
    const res = await settleAttachments('t1', 'r1', sshPlan, 'done');
    expect(res.collected).toBe(1);
    expect(h.inserts).toHaveLength(1);
    expect(h.saves).toHaveLength(1);
    expect(String(h.inserts[0]?.sha256)).toMatch(/^[0-9a-f]{64}$/);
  });
});
