// Channel reply relay (SPEC: Channels — Reply relay, #271 slice 2). The db
// singleton is captured/mocked — no-real-DB unit law — and the queue edge is
// mocked at the enqueue seam: the contract under test is outbox-first
// durability, per-thread ordering, adapter-down deferral (no-loss) and the
// maxLen cap, not the transport.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../server/domains/kernel/env', () => ({
  env: { TANDEM_VAULT_KEY: Buffer.alloc(32, 7).toString('base64'), TANDEM_NO_DISPATCHER: '1' },
}));

// ---- shared mutable fixture state ----
type OutboxRow = {
  id: string;
  adapter: string;
  threadRef: string;
  taskId: string;
  runId: string;
  body: string;
  createdAt: Date;
  claimedAt: Date | null;
  processedAt: Date | null;
};
const outbox = new Map<string, OutboxRow>();
const mappings = new Map<string, { adapter: string; threadRef: string; taskId: string }>();
const messages = new Map<string, { body: string }>();
const enqueuedJobs: Array<{ queue: string; data: unknown; opts?: { jobId?: string; delayMs?: number } }> = [];
const sentMessages: Array<{ target: string; text: string }> = [];
const appliedWrites: Array<Record<string, unknown>> = [];
let outboxConflict = false; // unique (adapter, runId, threadRef) already relayed
let claimConflict = false; // claim CAS: another worker owns the row
let sendError: Error | null = null;
let enqueueFailures = 0; // redis blips: the first N enqueues reject
let headQueryThrows: Error | null = null; // post-claim DB failure (F1 class)
// the worker always claims the row it just LOADED — the findFirst({id}) mock
// records that id so the guarded writes apply to the right row
let lastLoadedOutboxId: string | null = null;

let seq = 0;
function seedRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  const id = `ob-${(seq += 1)}`;
  const row: OutboxRow = {
    id,
    adapter: 'matrix:https://matrix.example.org',
    threadRef: '!room:example.org',
    taskId: 'task-1',
    runId: `run-${seq}`,
    body: 'the reply',
    createdAt: new Date(Date.parse('2026-11-05T12:00:00Z') + seq),
    claimedAt: null,
    processedAt: null,
    ...overrides,
  };
  outbox.set(id, row);
  return row;
}

vi.mock('../../server/db/index', () => ({
  db: {
    query: {
      channelOutbox: {
        findFirst: async ({
          where,
        }: {
          where?: {
            id?: { eq?: string };
            adapter?: { eq?: string };
            threadRef?: { eq?: string };
            processedAt?: { isNull?: boolean };
          };
        }) => {
          const id = where?.id?.eq;
          if (id) {
            lastLoadedOutboxId = id;
            return outbox.get(id) ?? null;
          }
          const adapterKey = where?.adapter?.eq;
          const threadRef = where?.threadRef?.eq;
          const openOnly = where?.processedAt?.isNull === true;
          if (adapterKey && threadRef && openOnly) {
            if (headQueryThrows) throw headQueryThrows;
            const rows = [...outbox.values()].filter(
              (r) => r.adapter === adapterKey && r.threadRef === threadRef && r.processedAt === null,
            );
            rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1));
            return rows[0] ?? null;
          }
          return null;
        },
      },
      channelThreads: {
        findMany: async ({ where }: { where?: { taskId?: { eq?: string } } }) => {
          const taskId = where?.taskId?.eq;
          if (!taskId) return [];
          return [...mappings.values()].filter((m) => m.taskId === taskId);
        },
      },
      taskMessages: {
        findFirst: async ({ where }: { where?: { id?: { eq?: string } } }) => {
          const id = where?.id?.eq;
          return (id && messages.get(id)) ?? null;
        },
      },
    },
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          void table;
          void cond;
          const apply = () => {
            const row = lastLoadedOutboxId ? outbox.get(lastLoadedOutboxId) : null;
            if (!row || row.processedAt !== null) return; // never touch a settled row
            appliedWrites.push({ row: row.id, ...set });
            if ('processedAt' in set) row.processedAt = set.processedAt as Date;
            else row.claimedAt = (set.claimedAt as Date | null) ?? null;
          };
          return {
            then: (onF?: (v: unknown) => unknown) => Promise.resolve(apply()).then(onF),
            catch: (onR: (e: unknown) => unknown) => Promise.resolve(apply()).catch(onR),
            // claim CAS returns the claimed row (empty when someone else owns it)
            returning: async () => {
              if (claimConflict) {
                appliedWrites.push({ cas: 'lost' });
                return [];
              }
              apply();
              return [{ id: lastLoadedOutboxId ?? 'claimed' }];
            },
          };
        },
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown> | Array<Record<string, unknown>>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (outboxConflict) return [];
            const items = Array.isArray(v) ? v : [v];
            const out: Array<{ id: string }> = [];
            for (const item of items) {
              const row: OutboxRow = {
                id: `ob-ins-${outbox.size + 1}`,
                adapter: String(item.adapter),
                threadRef: String(item.threadRef),
                taskId: String(item.taskId),
                runId: String(item.runId),
                body: String(item.body),
                createdAt: new Date(),
                claimedAt: null,
                processedAt: null,
              };
              outbox.set(row.id, row);
              out.push({ id: row.id });
            }
            return out;
          },
        }),
      }),
    }),
  },
}));

vi.mock('../../server/domains/kernel/queue', () => ({
  redisQueue: async () => ({
    enqueue: async (queue: string, data: unknown, opts?: { jobId?: string; delayMs?: number }) => {
      if (enqueueFailures > 0) {
        enqueueFailures--;
        throw new Error('redis blip');
      }
      enqueuedJobs.push({ queue, data, opts });
      return 'job-1';
    },
    queue: async () => ({ close: async () => {} }),
    ping: async () => true,
    close: async () => {},
  }),
}));

const settingsRows = new Map<string, string>();
vi.mock('../../server/domains/settings/settings.service', () => ({
  getSetting: async (key: string) => settingsRows.get(key) ?? null,
  setSetting: async (key: string, value: string) => {
    settingsRows.set(key, value);
  },
}));

vi.mock('../../server/domains/kernel/kernel', () => ({ publishChange: vi.fn(async () => {}) }));

import {
  attachAdapterForTests,
  processOutboundRow,
  relayBodyOf,
  relaySettledRun,
  type ChannelConfig,
} from '../../server/domains/channels/channels.service';

const CFG: ChannelConfig = {
  kind: 'matrix',
  enabled: true,
  homeserverUrl: 'https://matrix.example.org',
  tokenSecretId: 'secret-1',
  bindings: [],
  defaultAssigneeId: null,
};
const ADAPTER_KEY = 'matrix:https://matrix.example.org';

const adapter = {
  kind: 'matrix',
  capabilities: { edit: false, threads: false, maxLen: 4000, markdown: false },
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  isLive: () => true,
  send: vi.fn(async (target: string, text: string) => {
    if (sendError) throw sendError;
    sentMessages.push({ target, text });
  }),
};

beforeEach(() => {
  outbox.clear();
  mappings.clear();
  messages.clear();
  enqueuedJobs.length = 0;
  sentMessages.length = 0;
  appliedWrites.length = 0;
  outboxConflict = false;
  claimConflict = false;
  sendError = null;
  enqueueFailures = 0;
  headQueryThrows = null;
  lastLoadedOutboxId = null;
  settingsRows.clear();
  settingsRows.set('channels', JSON.stringify([CFG]));
  adapter.send.mockClear();
  attachAdapterForTests(ADAPTER_KEY, adapter as never);
});

describe('relayBodyOf', () => {
  it('strips attachment tokens to their label and sanitizes unsafe text', () => {
    expect(relayBodyOf('![shot](attachment-abc) done @[log](attachment-x)')).toBe('shot done log');
    expect(relayBodyOf('a\u0000b\ud800c')).toBe('abc');
    expect(relayBodyOf(null)).toBe('');
    expect(relayBodyOf('   ')).toBe('');
  });
});

describe('relaySettledRun', () => {
  it('persists one outbox row per mapped thread BEFORE the queue kick', async () => {
    mappings.set('m1', { adapter: ADAPTER_KEY, threadRef: '!room:example.org', taskId: 'task-1' });
    mappings.set('m2', { adapter: 'matrix:https://other.example.org', threadRef: '!room2:x', taskId: 'task-1' });
    messages.set('msg-1', { body: 'Finished: all green ![pic](attachment-9)' });
    const n = await relaySettledRun('task-1', 'run-9', 'msg-1');
    expect(n).toBe(2);
    const rows = [...outbox.values()].filter((r) => r.runId === 'run-9');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.threadRef).sort()).toEqual(['!room2:x', '!room:example.org']);
    expect(rows.every((r) => r.body === 'Finished: all green pic')).toBe(true);
    expect(enqueuedJobs).toHaveLength(2);
    expect(enqueuedJobs.every((j) => j.queue === 'channels-outbound')).toBe(true);
  });

  it('is idempotent: an already-relayed run inserts nothing and enqueues nothing', async () => {
    mappings.set('m1', { adapter: ADAPTER_KEY, threadRef: '!room:example.org', taskId: 'task-1' });
    messages.set('msg-1', { body: 'done' });
    outboxConflict = true;
    expect(await relaySettledRun('task-1', 'run-9', 'msg-1')).toBe(0);
    expect(enqueuedJobs).toHaveLength(0);
  });

  it('never relays a blank body; an attachment-only body relays as its label', async () => {
    mappings.set('m1', { adapter: ADAPTER_KEY, threadRef: '!room:example.org', taskId: 'task-1' });
    messages.set('msg-blank', { body: '   ' });
    expect(await relaySettledRun('task-1', 'run-1', 'msg-blank')).toBe(0);
    messages.set('msg-attach', { body: '![pic](attachment-1)' });
    expect(await relaySettledRun('task-1', 'run-2', 'msg-attach')).toBe(1);
    expect([...outbox.values()].find((r) => r.runId === 'run-2')?.body).toBe('pic');
    expect(enqueuedJobs).toHaveLength(1);
  });
});

describe('processOutboundRow', () => {
  it('sends the row and marks it processed (maxLen-capped, pair-aware)', async () => {
    const row = seedRow({ body: 'x'.repeat(4500) });
    await processOutboundRow({ outboxId: row.id });
    expect(sentMessages).toEqual([{ target: '!room:example.org', text: 'x'.repeat(4000) }]);
    expect(row.processedAt).not.toBeNull();
    expect(row.claimedAt).not.toBeNull(); // claim holds until the processed write
    expect(enqueuedJobs).toHaveLength(0);
  });

  it('the maxLen slice never ships a lone surrogate (pair-aware cap)', async () => {
    // an astral char straddles position 4000: a raw slice would split its
    // surrogate pair into an invalid escape (homeserver 400 → permanent wedge)
    const astral = '🎉'; // 2 UTF-16 units
    const row = seedRow({ body: 'x'.repeat(3999) + astral + 'tail' });
    await processOutboundRow({ outboxId: row.id });
    const sent = sentMessages[0]!.text;
    expect(sent.length).toBeLessThanOrEqual(4000);
    expect(sent.endsWith('\uFFFD')).toBe(false); // no replacement char from a split pair
    expect(/[\uD800-\uDBFF]$/.test(sent)).toBe(false); // no trailing lone high surrogate
    expect(sent.startsWith('x'.repeat(3999))).toBe(true); // the pair was dropped whole (or kept)
  });

  it('loses the claim CAS race → no send, no requeue', async () => {
    const row = seedRow();
    claimConflict = true;
    await processOutboundRow({ outboxId: row.id });
    expect(sentMessages).toHaveLength(0);
    expect(enqueuedJobs).toHaveLength(0);
    expect(row.processedAt).toBeNull();
  });

  it('defers when no enabled config resolves (no-loss parity with inbound)', async () => {
    settingsRows.clear();
    const row = seedRow();
    await processOutboundRow({ outboxId: row.id });
    expect(sentMessages).toHaveLength(0);
    expect(row.processedAt).toBeNull();
    expect(row.claimedAt).toBeNull(); // released for the next owner
    expect(enqueuedJobs).toHaveLength(1);
    expect(enqueuedJobs[0]!.opts?.jobId).toBe(`${row.id}-d1`);
    expect(enqueuedJobs[0]!.opts?.delayMs).toBe(300_000);
  });

  it('stops re-driving after the deferral budget and RELEASES the claim (raw row kept for the sweep)', async () => {
    settingsRows.clear();
    const row = seedRow();
    await processOutboundRow({ outboxId: row.id, deferred: 12 });
    expect(enqueuedJobs).toHaveLength(0);
    expect(row.processedAt).toBeNull();
    expect(row.claimedAt).toBeNull(); // a held claim would ghost-stall the thread's head gate
  });

  it('persist-all-then-enqueue: a redis blip mid-relay loses NO mapping and never throws', async () => {
    mappings.set('m1', { adapter: ADAPTER_KEY, threadRef: '!room:example.org', taskId: 'task-1' });
    mappings.set('m2', { adapter: 'matrix:https://other.example.org', threadRef: '!room2:x', taskId: 'task-1' });
    messages.set('msg-1', { body: 'done' });
    enqueueFailures = 1; // the first kick rejects
    const n = await relaySettledRun('task-1', 'run-7', 'msg-1');
    expect(n).toBe(1); // one kick landed, the failed one stays raw for the sweep
    expect([...outbox.values()].filter((r) => r.runId === 'run-7')).toHaveLength(2); // BOTH rows persisted
    expect(enqueuedJobs).toHaveLength(1);
    expect(enqueuedJobs[0]!.data).toMatchObject({ outboxId: expect.any(String) });
  });

  it('defers when the adapter is not live (dead token never consumes a reply)', async () => {
    const row = seedRow();
    attachAdapterForTests(ADAPTER_KEY, { ...adapter, isLive: () => false } as never);
    await processOutboundRow({ outboxId: row.id });
    expect(sentMessages).toHaveLength(0);
    expect(enqueuedJobs[0]!.data).toEqual({ outboxId: row.id, deferred: 1, wait: 0 });
  });

  it('per-thread ordering: a younger row waits; the head sends first', async () => {
    const older = seedRow({ runId: 'run-1', createdAt: new Date(Date.parse('2026-11-05T12:00:01Z')) });
    const younger = seedRow({ runId: 'run-2', createdAt: new Date(Date.parse('2026-11-05T12:00:02Z')) });
    await processOutboundRow({ outboxId: younger.id }); // younger runs first
    expect(sentMessages).toHaveLength(0);
    expect(younger.processedAt).toBeNull();
    expect(younger.claimedAt).toBeNull(); // released while polling
    expect(enqueuedJobs[0]!.opts?.jobId).toBe(`${younger.id}-w1`);
    expect(enqueuedJobs[0]!.opts?.delayMs).toBe(2000);
    await processOutboundRow({ outboxId: older.id }); // head sends
    expect(sentMessages).toHaveLength(1);
    expect(older.processedAt).not.toBeNull();
    // and the released younger row proceeds once the head left the queue
    await processOutboundRow({ outboxId: younger.id, wait: 1 });
    expect(sentMessages).toHaveLength(2);
    expect(younger.processedAt).not.toBeNull();
    // wait growth is capped (the row must NOT be the head to hit this branch)
    const capOlder = seedRow({ runId: 'run-3', createdAt: new Date(Date.parse('2026-11-05T12:01:01Z')) });
    const capYounger = seedRow({ runId: 'run-4', createdAt: new Date(Date.parse('2026-11-05T12:01:02Z')) });
    await processOutboundRow({ outboxId: capYounger.id, wait: 30 });
    expect(enqueuedJobs.at(-1)?.opts?.delayMs).toBe(60_000);
    expect(sentMessages).toHaveLength(2); // capped row waited, nothing sent
    void capOlder;
  });

  it('ordering never crosses threads or adapters', async () => {
    const a = seedRow({ threadRef: '!roomA:x', createdAt: new Date(Date.parse('2026-11-05T12:00:05Z')) });
    const b = seedRow({ threadRef: '!roomB:x', createdAt: new Date(Date.parse('2026-11-05T12:00:01Z')) });
    await processOutboundRow({ outboxId: a.id }); // older row exists but in ANOTHER thread
    expect(sentMessages).toHaveLength(1);
    void b;
  });

  it('a failed send releases the claim and rethrows (job retry, row survives)', async () => {
    const row = seedRow();
    sendError = new Error('homeserver 502');
    await expect(processOutboundRow({ outboxId: row.id })).rejects.toThrow('homeserver 502');
    expect(row.processedAt).toBeNull();
    expect(row.claimedAt).toBeNull(); // released so the retry re-claims
    expect(sentMessages).toHaveLength(0);
  });

  it('ANY post-claim DB failure releases the claim (job retry can never no-op on a fresh claim)', async () => {
    const row = seedRow();
    headQueryThrows = new Error('db failover');
    await expect(processOutboundRow({ outboxId: row.id })).rejects.toThrow('db failover');
    expect(row.claimedAt).toBeNull(); // the retry ladder (3-24s) sits INSIDE the 5-min claim TTL —
    expect(row.processedAt).toBeNull(); // an unreleased claim would orphan the row jobless until boot
    expect(sentMessages).toHaveLength(0);
  });
});
