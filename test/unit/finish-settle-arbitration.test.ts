// RUN SETTLE ARBITRATION (#286): writer.finish's guarded row write (status=RUNNING)
// is the settle arbiter — 0 updated rows (a reaper or cross-replica stop already
// settled the run) skips every settle side effect: no message rewrite, no
// attachments, no DONE-envelope settle, no review park, no bounce, no publishes.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RUN_STATUS } from '#shared/enums';

const h = vi.hoisted(() => ({
  casWins: true,
  appends: 0,
  casWrites: 0,
  bodyWrites: [] as Array<[string, string, boolean]>,
  attachments: 0,
  parks: [] as Array<{ why: string; rearmable: boolean }>,
  published: [] as Array<[string, string]>,
}));

vi.mock('../../server/db/index', async () => {
  const { taskRuns } = await import('../../server/db/schema');
  return {
    asDb: (x: unknown) => x,
    db: {
      query: new Proxy(
        {},
        {
          get: () => ({ findMany: async () => [], findFirst: async () => null }),
        },
      ),
      update: (table: unknown) => ({
        set: (_set: Record<string, unknown>) => ({
          where: (_where: unknown) => {
            const applied = () => {
              if (table === taskRuns && h.casWins) h.appends += 1;
              h.casWrites += 1;
              return h.casWins ? [{ id: 'run-1' }] : [];
            };
            return {
              // a real thenable: the writer chains .then/.catch/.finally on flushes
              then: (onF?: (v: Array<Record<string, unknown>>) => unknown) => Promise.resolve(applied()).then(onF),
              catch: (onR: (e: unknown) => unknown) => Promise.resolve(applied()).catch(onR),
              returning: async () => applied(),
            };
          },
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

vi.mock('../../server/domains/tasks/review.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/review.service')>();
  return {
    ...mod,
    parkRound: async (_taskId: unknown, why: string, opts?: { rearmable?: boolean }) => {
      h.parks.push({ why, rearmable: opts?.rearmable === true });
      return true;
    },
  };
});

vi.mock('../../server/domains/tasks/thread.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/thread.service')>();
  return {
    ...mod,
    updateRunMessageBody: async (messageId: string, output: string, review: boolean) => {
      h.bodyWrites.push([messageId, output, review]);
    },
    appendMessageAttachments: async () => void h.attachments++,
  };
});

vi.mock('../../server/domains/tasks/workflow.service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/domains/tasks/workflow.service')>();
  return { ...mod, submitResult: async () => ({ status: 'done' }), askQuestion: async () => ({}) };
});

import { setEnv } from '../../server/domains/kernel/env';
import { createRunWriter } from '../../server/domains/tasks/runner.service';

beforeEach(() => {
  h.casWins = true;
  h.appends = 0;
  h.casWrites = 0;
  h.bodyWrites = [];
  h.attachments = 0;
  h.parks = [];
  h.published = [];
  setEnv({ TANDEM_RUN_FLUSH_MS: undefined, TANDEM_RUN_PUBLISH_MS: undefined });
});

describe('writer.finish settle arbitration (#286)', () => {
  it('a won CAS (row still RUNNING) runs the full settle: body rewrite + review park', async () => {
    const writer = createRunWriter('run-1', '', 'msg-1');
    writer.onLine('agent output');
    await writer.finish('task-1', RUN_STATUS.FAILED, 1, {
      review: { resultBody: 'submitted work' },
      ai: { userId: 'agent-1' },
    });
    expect(h.bodyWrites).toHaveLength(1);
    expect(h.parks).toHaveLength(1);
    expect(h.parks[0]?.rearmable).toBe(true);
  });

  it('a lost CAS (reaper/stop already settled) performs ZERO side effects', async () => {
    h.casWins = false;
    const writer = createRunWriter('run-1', '', 'msg-1');
    writer.onLine('agent output');
    await writer.finish('task-1', RUN_STATUS.FAILED, 1, {
      review: { resultBody: 'submitted work' },
      ai: { userId: 'agent-1' },
    });
    expect(h.bodyWrites).toHaveLength(0);
    expect(h.attachments).toBe(0);
    expect(h.parks).toHaveLength(0);
    expect(h.published).toHaveLength(0);
  });
});
