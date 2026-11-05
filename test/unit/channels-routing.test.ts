// Channel routing verbs (SPEC: Channels — Routing verbs, Inbound durability,
// #271 slice 1). The db singleton is captured/mocked — no-real-DB unit law —
// and the workflow/assignment/queue edges are mocked at the proc seam: the
// routing under test is the VERB PICK + ack + durability contract, not the
// composer internals (those own their laws and their own tests).
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../server/domains/kernel/env', () => ({
  env: { TANDEM_VAULT_KEY: Buffer.alloc(32, 7).toString('base64'), TANDEM_NO_DISPATCHER: '1' },
}));

// ---- shared mutable fixture state ----
const events = new Map<
  string,
  { id: string; channel: string; threadRef: string; sender: string; body: string; processedAt: Date | null }
>();
const mappings = new Map<string, { channel: string; threadRef: string; taskId: string }>();
let taskStatusCategory = 'ready';
const insertedTasks: Array<Record<string, unknown>> = [];
const insertedThreadRows: Array<Record<string, unknown>> = [];
const processedWrites: Array<Record<string, unknown>> = [];
const eventInserts: Array<Record<string, unknown>> = [];
const enqueuedJobs: Array<{ queue: string; data: unknown }> = [];
const ackSends: Array<{ target: string; text: string }> = [];
let conflictMode: 'none' | 'dup' = 'none';

const STATUS_ROW = { id: 'status-ready', category: 'ready' };

vi.mock('../../server/db/index', () => ({
  db: {
    query: {
      channelEvents: {
        findFirst: async ({ where }: { where?: { id?: { eq?: string } } }) => {
          const id = where?.id?.eq;
          return id ? (events.get(id) ?? null) : null;
        },
      },
      channelThreads: {
        findFirst: async ({ where }: { where?: { channel?: { eq?: string }; threadRef?: { eq?: string } } }) => {
          const channel = where?.channel?.eq;
          const threadRef = where?.threadRef?.eq;
          if (!channel || !threadRef) return null;
          return mappings.get(`${channel}|${threadRef}`) ?? null;
        },
      },
      taskStatuses: {
        findMany: async (opts?: { where?: { id?: { eq?: string } }; orderBy?: unknown }) => {
          if (opts?.where?.id?.eq) return [{ id: STATUS_ROW.id, category: taskStatusCategory }];
          return [STATUS_ROW, { id: 'status-done', category: 'done' }];
        },
      },
      user: {
        findFirst: async ({ where }: { where?: { id?: { eq?: string } } }) => {
          const id = where?.id?.eq;
          return id === 'assignee-1' ? { id } : null;
        },
      },
      tasks: {
        findFirst: async () => ({ id: 'task-1', status: STATUS_ROW.id }),
      },
    },
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          // apply the row only through the event map (guarded-write test law:
          // record attempted writes separately from applied ones)
          if (table !== null && set.processedAt !== undefined && cond != null) {
            processedWrites.push(set);
            const idHit = [...events.values()].filter((e) => e.processedAt === null).map((e) => e.id);
            if (idHit.length === 1) events.get(idHit[0]!)!.processedAt = set.processedAt as Date;
          }
          return Promise.resolve();
        },
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (conflictMode === 'dup') return [];
            eventInserts.push(v);
            return [{ id: `evrow-${eventInserts.length}` }];
          },
        }),
        // plain insert (tasks / channel_threads) is a bare await
        then: (onF?: (v: unknown) => unknown) => {
          if ('externalId' in v) eventInserts.push(v);
          else if ('taskId' in v) insertedThreadRows.push(v);
          else insertedTasks.push(v);
          return Promise.resolve([]).then(onF);
        },
        catch: (onR: (e: unknown) => unknown) => Promise.resolve([]).catch(onR),
      }),
    }),
  },
}));

vi.mock('../../server/domains/kernel/queue', () => ({
  redisQueue: async () => ({
    enqueue: async (queue: string, data: unknown) => {
      enqueuedJobs.push({ queue, data });
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

const addNote = vi.fn();
const answerQuestion = vi.fn();
vi.mock('../../server/domains/tasks/workflow.service', () => ({
  addNote: (...a: unknown[]) => addNote(...(a as [])),
  answerQuestion: (...a: unknown[]) => answerQuestion(...(a as [])),
}));

const recordAssignment = vi.fn();
vi.mock('../../server/domains/tasks/assignments.service', () => ({
  recordAssignment: (...a: unknown[]) => recordAssignment(...(a as [])),
}));

import {
  attachAdapterForTests,
  handleInbound,
  processChannelEvent,
  type ChannelConfig,
} from '../../server/domains/channels/channels.service';

const CFG: ChannelConfig = {
  kind: 'matrix',
  enabled: true,
  homeserverUrl: 'https://matrix.example.org',
  tokenSecretId: 'secret-1',
  bindings: [{ platformUserId: '@u:example.org', userId: 'user-1' }],
  defaultAssigneeId: null,
};

const adapter = {
  kind: 'matrix',
  capabilities: { edit: false, threads: false, maxLen: 4000, markdown: false },
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  send: vi.fn(async (target: string, text: string) => {
    ackSends.push({ target, text });
  }),
};

let seq = 0;
function seedEvent(overrides: Partial<{ sender: string; body: string }> = {}) {
  const id = `ev-${(seq += 1)}`;
  events.set(id, {
    id,
    channel: 'matrix',
    threadRef: '!room:example.org',
    sender: '@u:example.org',
    body: 'Fix the login bug',
    processedAt: null,
    ...overrides,
  });
  return id;
}

function mapThread(taskId: string) {
  mappings.set('matrix|!room:example.org', { channel: 'matrix', threadRef: '!room:example.org', taskId });
}

beforeEach(() => {
  for (const m of [events, mappings, settingsRows]) m.clear();
  insertedTasks.length = 0;
  insertedThreadRows.length = 0;
  processedWrites.length = 0;
  eventInserts.length = 0;
  enqueuedJobs.length = 0;
  ackSends.length = 0;
  conflictMode = 'none';
  taskStatusCategory = 'ready';
  addNote.mockReset();
  answerQuestion.mockReset();
  recordAssignment.mockReset();
  adapter.send.mockClear();
  attachAdapterForTests('matrix:https://matrix.example.org', adapter);
  settingsRows.set('channels', JSON.stringify([CFG]));
});

describe('handleInbound (persist → queue)', () => {
  it('persists the raw event FIRST, then enqueues the processing job', async () => {
    await handleInbound(CFG, {
      threadRef: '!room:example.org',
      senderPlatformId: '@u:example.org',
      text: 'hello',
      raw: { foo: 'bar' },
      externalId: '$a1:example.org',
    });
    expect(eventInserts).toEqual([
      {
        channel: 'matrix',
        externalId: '$a1:example.org',
        threadRef: '!room:example.org',
        sender: '@u:example.org',
        body: 'hello',
        raw: { foo: 'bar' },
      },
    ]);
    expect(enqueuedJobs).toHaveLength(1);
    expect(enqueuedJobs[0]!.queue).toBe('channels-inbound');
    expect(enqueuedJobs[0]!.data).toEqual({ eventId: 'evrow-1' });
  });

  it('a replayed (conflicting) event is a dedupe no-op: no second enqueue', async () => {
    conflictMode = 'dup';
    await handleInbound(CFG, {
      threadRef: '!room:example.org',
      senderPlatformId: '@u:example.org',
      text: 'hello',
      raw: {},
      externalId: '$a1:example.org',
    });
    expect(eventInserts).toHaveLength(0);
    expect(enqueuedJobs).toHaveLength(0);
  });
});

describe('processChannelEvent arms', () => {
  it('an unknown event id is a quiet no-op', async () => {
    await processChannelEvent({ eventId: 'missing' });
    expect(addNote).not.toHaveBeenCalled();
    expect(adapter.send).not.toHaveBeenCalled();
    expect(processedWrites).toHaveLength(0);
  });

  it('an already-processed event never routes twice (idempotent worker)', async () => {
    const id = seedEvent();
    events.get(id)!.processedAt = new Date();
    await processChannelEvent({ eventId: id });
    expect(addNote).not.toHaveBeenCalled();
    expect(adapter.send).not.toHaveBeenCalled();
    expect(processedWrites).toHaveLength(0);
  });

  it('no enabled config for the channel kind: processed + refused, no routing', async () => {
    const id = seedEvent();
    settingsRows.set('channels', '[]');
    await processChannelEvent({ eventId: id });
    expect(processedWrites).toHaveLength(1);
    expect(adapter.send).not.toHaveBeenCalled();
    expect(insertedTasks).toHaveLength(0);
  });

  it('unbound sender is refused (default deny), never routed', async () => {
    const id = seedEvent({ sender: '@stranger:example.org' });
    await processChannelEvent({ eventId: id });
    expect(ackSends).toEqual([{ target: '!room:example.org', text: expect.stringContaining('not authorized') }]);
    expect(addNote).not.toHaveBeenCalled();
    expect(insertedTasks).toHaveLength(0);
    expect(processedWrites).toHaveLength(1);
    expect(events.get(id)!.processedAt).toBeInstanceOf(Date);
  });

  it('unmapped thread creates a task exactly like the composer create path', async () => {
    const id = seedEvent({ body: 'Fix the login bug\n\nSteps: 1. open app' });
    await processChannelEvent({ eventId: id });
    expect(insertedTasks).toHaveLength(1);
    const t = insertedTasks[0]!;
    expect(t.title).toBe('Fix the login bug'); // first line only, ≤200 chars
    expect(t.description).toBe('Fix the login bug\n\nSteps: 1. open app'); // full body
    expect(t.ownerId).toBe('user-1');
    expect(t.createdBy).toBe('user-1');
    expect(t.status).toBe(STATUS_ROW.id);
    expect(t.assigneeId).toBeNull();
    expect(insertedThreadRows).toEqual([{ channel: 'matrix', threadRef: '!room:example.org', taskId: t.id }]);
    expect(ackSends[0]!.text).toContain(`Task ${String(t.id)} created`);
    expect(ackSends[0]!.text).toContain('attach an assignee');
    expect(events.get(id)!.processedAt).toBeInstanceOf(Date);
  });

  it('a valid defaultAssigneeId attaches + records the assignment', async () => {
    settingsRows.set('channels', JSON.stringify([{ ...CFG, defaultAssigneeId: 'assignee-1' }]));
    await processChannelEvent({ eventId: seedEvent() });
    expect(insertedTasks[0]!.assigneeId).toBe('assignee-1');
    expect(recordAssignment).toHaveBeenCalledWith(insertedTasks[0]!.id, 'assignee-1', 'created', 'user-1');
    expect(ackSends[0]!.text).toContain('dispatching to the assigned agent');
  });

  it('a dangling defaultAssigneeId is skipped — the task still creates', async () => {
    settingsRows.set('channels', JSON.stringify([{ ...CFG, defaultAssigneeId: 'ghost' }]));
    await processChannelEvent({ eventId: seedEvent() });
    expect(insertedTasks[0]!.assigneeId).toBeNull();
    expect(recordAssignment).not.toHaveBeenCalled();
  });

  it('mapped thread + non-waiting category → note verb through the composer path', async () => {
    mapThread('task-1');
    addNote.mockResolvedValue({ steered: false, dispatched: true });
    const id = seedEvent();
    await processChannelEvent({ eventId: id });
    expect(addNote).toHaveBeenCalledWith('task-1', 'user-1', 'Fix the login bug');
    expect(answerQuestion).not.toHaveBeenCalled();
    expect(ackSends[0]!.text).toContain('Queued');
    expect(events.get(id)!.processedAt).toBeInstanceOf(Date);
  });

  it('steered + plain-noted outcomes ack what actually fired', async () => {
    mapThread('task-1');
    addNote.mockResolvedValue({ steered: true });
    await processChannelEvent({ eventId: seedEvent() });
    expect(ackSends[0]!.text).toContain('running agent');

    addNote.mockResolvedValue({ steered: false });
    await processChannelEvent({ eventId: seedEvent() });
    expect(ackSends[1]!.text).toContain('Noted');
  });

  it('waiting_answer category routes the ANSWER verb, never a note', async () => {
    mapThread('task-1');
    taskStatusCategory = 'waiting_answer';
    answerQuestion.mockResolvedValue({});
    const id = seedEvent();
    await processChannelEvent({ eventId: id });
    expect(answerQuestion).toHaveBeenCalledWith('task-1', 'user-1', 'Fix the login bug');
    expect(addNote).not.toHaveBeenCalled();
    expect(ackSends[0]!.text).toContain('Answer delivered');
    expect(events.get(id)!.processedAt).toBeInstanceOf(Date);
  });

  it('a failed answer never falls back to a note (no question stomp)', async () => {
    mapThread('task-1');
    taskStatusCategory = 'waiting_answer';
    answerQuestion.mockRejectedValue(new Error('only someone in the question chain can answer'));
    await processChannelEvent({ eventId: seedEvent() });
    expect(addNote).not.toHaveBeenCalled();
    expect(ackSends[0]!.text).toContain('Could not deliver the answer');
  });

  it('terminal category (done) acks closed and routes nothing', async () => {
    mapThread('task-1');
    taskStatusCategory = 'done';
    const id = seedEvent();
    await processChannelEvent({ eventId: id });
    expect(addNote).not.toHaveBeenCalled();
    expect(answerQuestion).not.toHaveBeenCalled();
    expect(ackSends[0]!.text).toContain('closed');
    expect(events.get(id)!.processedAt).toBeInstanceOf(Date);
  });

  it('cancelled category acks closed too', async () => {
    mapThread('task-1');
    taskStatusCategory = 'cancelled';
    await processChannelEvent({ eventId: seedEvent() });
    expect(ackSends[0]!.text).toContain('closed');
  });
});
