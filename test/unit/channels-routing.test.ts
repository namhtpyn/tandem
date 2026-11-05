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
  {
    id: string;
    channel: string;
    adapter: string;
    externalId: string;
    threadRef: string;
    sender: string;
    body: string;
    processedAt: Date | null;
  }
>();
const mappings = new Map<string, { adapter: string; threadRef: string; taskId: string }>();
let taskStatusCategory = 'ready';
const insertedTasks: Array<Record<string, unknown>> = [];
const insertedThreadRows: Array<Record<string, unknown>> = [];
const deletedTaskIds: string[] = [];
const processedWrites: Array<Record<string, unknown>> = [];
const eventInserts: Array<Record<string, unknown>> = [];
const enqueuedJobs: Array<{ queue: string; data: unknown; opts?: unknown }> = [];
const ackSends: Array<{ target: string; text: string }> = [];
let conflictMode: 'none' | 'dup' = 'none';
let mappingConflict = false; // arbiter: channel_threads insert loses
let claimConflict = false; // claim CAS: another worker owns the event

const U1 = '00000000-0000-4000-8000-000000000001';
const U2 = '00000000-0000-4000-8000-000000000002';
const ASSIGNEE = '00000000-0000-4000-8000-000000000003';
const GHOST = '00000000-0000-4000-8000-000000000009';
const DELETED = '00000000-0000-4000-8000-00000000000a';
const VIEWER = '00000000-0000-4000-8000-00000000000b';
const STATUS_ROW = { id: 'status-ready', category: 'ready' };

vi.mock('../../server/db/index', () => ({
  db: {
    query: {
      channelEvents: {
        findFirst: async ({
          where,
        }: {
          where?: { id?: { eq?: string }; adapter?: { eq?: string }; externalId?: { eq?: string } };
        }) => {
          const id = where?.id?.eq;
          if (id) return events.get(id) ?? null;
          const adapterKey = where?.adapter?.eq;
          const externalId = where?.externalId?.eq;
          if (adapterKey && externalId)
            return [...events.values()].find((e) => e.adapter === adapterKey && e.externalId === externalId) ?? null;
          return null;
        },
      },
      channelThreads: {
        findFirst: async ({ where }: { where?: { adapter?: { eq?: string }; threadRef?: { eq?: string } } }) => {
          const adapterKey = where?.adapter?.eq;
          const threadRef = where?.threadRef?.eq;
          if (!adapterKey || !threadRef) return null;
          return mappings.get(`${adapterKey}|${threadRef}`) ?? null;
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
          // every well-formed id exists EXCEPT the explicit ghost fixtures;
          // VIEWER is the view-only fixture for the employee-tier gate
          if (!id || id === DELETED || id === GHOST) return null;
          return { id, role: id === VIEWER ? 'VIEWER' : 'EMPLOYEE' };
        },
      },
      tasks: {
        findFirst: async () => ({ id: 'task-1', status: STATUS_ROW.id }),
      },
      taskMessages: {
        findFirst: async () => null, // no run touched the task → safe to delete
      },
      aiEmployees: {
        // assignee-1 is the AI fixture; everyone else is human
        findFirst: async ({ where }: { where?: { userId?: { eq?: string } } }) =>
          where?.userId?.eq === ASSIGNEE ? { id: 'ai-1' } : null,
      },
    },
    delete: (table: unknown) => ({
      where: (cond: unknown) => {
        void table;
        void cond;
        deletedTaskIds.push('last-inserted');
        return Promise.resolve();
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: (cond: unknown) => {
          const apply = () => {
            // apply the row only through the event map (guarded-write test law:
            // record attempted writes separately from applied ones)
            if (table !== null && set.processedAt !== undefined && cond != null) {
              processedWrites.push(set);
              const idHit = [...events.values()].filter((e) => e.processedAt === null).map((e) => e.id);
              if (idHit.length === 1) events.get(idHit[0]!)!.processedAt = set.processedAt as Date;
            }
            return [];
          };
          return {
            then: (onF?: (v: unknown) => unknown) => Promise.resolve(apply()).then(onF),
            catch: (onR: (e: unknown) => unknown) => Promise.resolve(apply()).catch(onR),
            // claim CAS returns the claimed row (empty when someone else owns it)
            returning: async () => (claimConflict ? [] : [{ id: 'claimed' }]),
          };
        },
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if ('externalId' in v) {
              if (conflictMode === 'dup') return [];
              eventInserts.push(v);
              return [{ id: `evrow-${eventInserts.length}` }];
            }
            // channel_threads mapping arbiter
            if (mappingConflict) {
              // the concurrent winner's mapping lands between our statements
              mappings.set(`${v.adapter}|${v.threadRef}`, {
                adapter: String(v.adapter),
                threadRef: String(v.threadRef),
                taskId: 'task-1',
              });
              return [];
            }
            insertedThreadRows.push(v);
            return [{ id: 'maprow-1' }];
          },
        }),
        // plain insert (tasks) is a bare await
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
    enqueue: async (queue: string, data: unknown, opts?: unknown) => {
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
  bindings: [{ platformUserId: '@u:example.org', userId: U1 }],
  defaultAssigneeId: null,
};

const adapter = {
  kind: 'matrix',
  capabilities: { edit: false, threads: false, maxLen: 4000, markdown: false },
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  isLive: () => true,
  send: vi.fn(async (target: string, text: string) => {
    ackSends.push({ target, text });
  }),
};

let seq = 0;
function seedEvent(overrides: Partial<{ sender: string; body: string; adapter: string; threadRef: string }> = {}) {
  const id = `ev-${(seq += 1)}`;
  events.set(id, {
    id,
    channel: 'matrix',
    adapter: 'matrix:https://matrix.example.org',
    externalId: `$x${seq}:example.org`,
    threadRef: '!room:example.org',
    sender: '@u:example.org',
    body: 'Fix the login bug',
    processedAt: null,
    ...overrides,
  });
  return id;
}

function mapThread(taskId: string) {
  mappings.set('matrix:https://matrix.example.org|!room:example.org', {
    adapter: 'matrix:https://matrix.example.org',
    threadRef: '!room:example.org',
    taskId,
  });
}

beforeEach(() => {
  for (const m of [events, mappings, settingsRows]) m.clear();
  insertedTasks.length = 0;
  insertedThreadRows.length = 0;
  deletedTaskIds.length = 0;
  processedWrites.length = 0;
  eventInserts.length = 0;
  enqueuedJobs.length = 0;
  ackSends.length = 0;
  conflictMode = 'none';
  mappingConflict = false;
  claimConflict = false;
  taskStatusCategory = 'ready';
  addNote.mockReset();
  answerQuestion.mockReset();
  recordAssignment.mockReset();
  adapter.send.mockClear();
  attachAdapterForTests('matrix:https://matrix.example.org', adapter);
  settingsRows.set('channels', JSON.stringify([CFG]));
});

describe('handleInbound (persist → queue)', () => {
  it('persists the raw event FIRST, then enqueues the processing job (originating adapter key)', async () => {
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
        adapter: 'matrix:https://matrix.example.org',
        externalId: '$a1:example.org',
        threadRef: '!room:example.org',
        sender: '@u:example.org',
        body: 'hello',
        raw: { foo: 'bar' },
      },
    ]);
    expect(enqueuedJobs).toHaveLength(1);
    expect(enqueuedJobs[0]!.queue).toBe('channels-inbound');
    expect(enqueuedJobs[0]!.data).toEqual({ eventId: 'evrow-1', deferred: 0 });
    // jobId dedupe: a second job for the same event id is refused by BullMQ
    expect(enqueuedJobs[0]!.opts).toMatchObject({ jobId: 'evrow-1', removeOnFail: true });
  });

  it('a replayed event with NO processed row behind it re-enqueues (conflict recovery)', async () => {
    // persist succeeded earlier but the enqueue was lost (redis blip): the
    // adapter re-polls the batch, the conflict hits, recovery must enqueue
    const strandedId = seedEvent(); // processedAt null = never routed
    conflictMode = 'dup';
    await handleInbound(CFG, {
      threadRef: '!room:example.org',
      senderPlatformId: '@u:example.org',
      text: 'Fix the login bug',
      raw: {},
      externalId: events.get(strandedId)!.externalId,
    });
    expect(enqueuedJobs).toHaveLength(1);
    expect(enqueuedJobs[0]!.data).toEqual({ eventId: strandedId, deferred: 0 });
    expect(enqueuedJobs[0]!.opts).toMatchObject({ jobId: strandedId, removeOnFail: true });
  });

  it('NUL bytes and lone surrogates are sanitized, never wedging the channel', async () => {
    await handleInbound(CFG, {
      threadRef: '!room:example.org',
      senderPlatformId: '@u:example.org',
      text: 'a\u0000b\ud800c',
      raw: { body: 'x\udfff', nested: { s: 'y\u0000' } },
      externalId: '$nul1:example.org',
    });
    expect(eventInserts[0]).toMatchObject({ body: 'abc', raw: { body: 'x', nested: { s: 'y' } } });
    expect(enqueuedJobs).toHaveLength(1);
  });

  it('a replayed event already routed (or in flight) is a dedupe no-op', async () => {
    const id = seedEvent();
    events.get(id)!.processedAt = new Date();
    conflictMode = 'dup';
    await handleInbound(CFG, {
      threadRef: '!room:example.org',
      senderPlatformId: '@u:example.org',
      text: 'Fix the login bug',
      raw: {},
      externalId: events.get(id)!.externalId,
    });
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

  it('no enabled config: the event is DEFERRED (never consumed) and re-driven in 5 min', async () => {
    const id = seedEvent();
    settingsRows.set('channels', '[]');
    await processChannelEvent({ eventId: id });
    expect(processedWrites).toHaveLength(0); // stays queued
    expect(adapter.send).not.toHaveBeenCalled();
    expect(insertedTasks).toHaveLength(0);
    expect(enqueuedJobs).toHaveLength(1);
    expect(enqueuedJobs[0]!.data).toEqual({ eventId: id, deferred: 1 });
    expect(enqueuedJobs[0]!.opts).toMatchObject({ delayMs: 300_000 });
    expect((enqueuedJobs[0]!.opts as { jobId?: string }).jobId).toBe(`${id}-d1`);
  });

  it('deferral gives up after the cap without consuming the row', async () => {
    const id = seedEvent();
    settingsRows.set('channels', '[]');
    await processChannelEvent({ eventId: id, deferred: 12 });
    expect(processedWrites).toHaveLength(0); // raw row kept for the next boot sweep
    expect(enqueuedJobs).toHaveLength(0);
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
    expect(t.ownerId).toBe(U1);
    expect(t.createdBy).toBe(U1);
    expect(t.status).toBe(STATUS_ROW.id);
    expect(t.assigneeId).toBeNull();
    expect(insertedThreadRows).toEqual([
      { channel: 'matrix', adapter: 'matrix:https://matrix.example.org', threadRef: '!room:example.org', taskId: t.id },
    ]);
    expect(ackSends[0]!.text).toContain(`Task ${String(t.id)} created`);
    expect(ackSends[0]!.text).toContain('attach an assignee');
    expect(events.get(id)!.processedAt).toBeInstanceOf(Date);
  });

  it('a valid defaultAssigneeId attaches + records the assignment', async () => {
    settingsRows.set('channels', JSON.stringify([{ ...CFG, defaultAssigneeId: ASSIGNEE }]));
    await processChannelEvent({ eventId: seedEvent() });
    expect(insertedTasks[0]!.assigneeId).toBe(ASSIGNEE);
    expect(recordAssignment).toHaveBeenCalledWith(insertedTasks[0]!.id, ASSIGNEE, 'created', U1);
    expect(ackSends[0]!.text).toContain('dispatching to the assigned agent');
  });

  it('a dangling defaultAssigneeId is skipped — the task still creates', async () => {
    settingsRows.set('channels', JSON.stringify([{ ...CFG, defaultAssigneeId: GHOST }]));
    await processChannelEvent({ eventId: seedEvent() });
    expect(insertedTasks[0]!.assigneeId).toBeNull();
    expect(recordAssignment).not.toHaveBeenCalled();
  });

  it('mapped thread + non-waiting category → note verb through the composer path', async () => {
    mapThread('task-1');
    addNote.mockResolvedValue({ steered: false, dispatched: true });
    const id = seedEvent();
    await processChannelEvent({ eventId: id });
    expect(addNote).toHaveBeenCalledWith('task-1', U1, 'Fix the login bug');
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
    expect(answerQuestion).toHaveBeenCalledWith('task-1', U1, 'Fix the login bug');
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

  it('events resolve through their ORIGINATING adapter — no cross-config wiring', async () => {
    const CFG_B = {
      ...CFG,
      homeserverUrl: 'https://b.example.org',
      bindings: [{ platformUserId: '@y:b.example.org', userId: U2 }],
    };
    settingsRows.set('channels', JSON.stringify([CFG, CFG_B]));
    const ackB: Array<{ target: string; text: string }> = [];
    attachAdapterForTests('matrix:https://b.example.org', {
      ...adapter,
      send: vi.fn(async (target: string, text: string) => {
        ackB.push({ target, text });
      }),
    });
    // sender is bound ONLY on config B, event persisted under adapter B
    const id = seedEvent({
      sender: '@y:b.example.org',
      adapter: 'matrix:https://b.example.org',
      threadRef: '!room-b:b.example.org',
    });
    await processChannelEvent({ eventId: id });
    // routed under B's bindings (created), ack went through B's adapter to B's thread
    expect(insertedTasks).toHaveLength(1);
    expect(ackB).toEqual([{ target: '!room-b:b.example.org', text: expect.stringContaining('Task') }]);
    expect(ackSends).toHaveLength(0); // config A's adapter never fired
  });

  it('an event whose adapter has no LIVE adapter is deferred, not consumed', async () => {
    const id = seedEvent({ adapter: 'matrix:https://gone.example.org' });
    settingsRows.set('channels', JSON.stringify([{ ...CFG, homeserverUrl: 'https://gone.example.org' }]));
    await processChannelEvent({ eventId: id });
    expect(adapter.send).not.toHaveBeenCalled();
    expect(insertedTasks).toHaveLength(0);
    expect(processedWrites).toHaveLength(0); // no silent drop
  });

  it('a stale binding (bound user deleted) refuses politely — no FK poison retry loop', async () => {
    const id = seedEvent({ sender: '@ghost:example.org' });
    // CFG's binding maps only @u; a config whose binding points at a missing user:
    settingsRows.set(
      'channels',
      JSON.stringify([{ ...CFG, bindings: [{ platformUserId: '@ghost:example.org', userId: DELETED }] }]),
    );
    await processChannelEvent({ eventId: id });
    expect(insertedTasks).toHaveLength(0);
    expect(addNote).not.toHaveBeenCalled();
    expect(ackSends[0]!.text).toContain('not available');
    expect(processedWrites).toHaveLength(1); // marked processed — no retry churn
  });

  it('composer parity: oversized bodies are capped at 10k (description + answer)', async () => {
    const huge = 'x'.repeat(12_000);
    await processChannelEvent({ eventId: seedEvent({ body: huge }) });
    expect(String(insertedTasks[0]!.description)).toHaveLength(10_000);

    mapThread('task-1');
    taskStatusCategory = 'waiting_answer';
    answerQuestion.mockResolvedValue({});
    await processChannelEvent({ eventId: seedEvent({ body: huge }) });
    expect(String(answerQuestion.mock.calls[0]![2])).toHaveLength(10_000);
  });

  it('a blank-only message is refused on every verb — never an empty-title task or empty note', async () => {
    const id = seedEvent({ body: '\n\n   \n' });
    await processChannelEvent({ eventId: id });
    expect(insertedTasks).toHaveLength(0);
    expect(ackSends[0]!.text).toContain('Empty message');
    expect(processedWrites).toHaveLength(1);

    mapThread('task-1');
    await processChannelEvent({ eventId: seedEvent({ body: '   ' }) });
    expect(addNote).not.toHaveBeenCalled();
    expect(ackSends[1]!.text).toContain('Empty message');
  });

  it('a concurrent claim (another worker owns the event) is a no-op', async () => {
    claimConflict = true;
    const id = seedEvent();
    await processChannelEvent({ eventId: id });
    expect(addNote).not.toHaveBeenCalled();
    expect(insertedTasks).toHaveLength(0);
    expect(ackSends).toHaveLength(0);
    expect(processedWrites).toHaveLength(0);
  });

  it('a VIEWER-role binding is refused (employee-tier gate, composer parity)', async () => {
    settingsRows.set(
      'channels',
      JSON.stringify([{ ...CFG, bindings: [{ platformUserId: '@v:example.org', userId: VIEWER }] }]),
    );
    const id = seedEvent({ sender: '@v:example.org' });
    await processChannelEvent({ eventId: id });
    expect(insertedTasks).toHaveLength(0);
    expect(ackSends[0]!.text).toContain('view-only');
    expect(processedWrites).toHaveLength(1); // refused = terminal, not deferred
  });

  it('a dead-adapter (isLive false) event defers instead of routing into the void', async () => {
    attachAdapterForTests('matrix:https://matrix.example.org', { ...adapter, isLive: () => false });
    const id = seedEvent();
    await processChannelEvent({ eventId: id });
    expect(processedWrites).toHaveLength(0);
    expect(enqueuedJobs[0]!.opts).toMatchObject({ delayMs: 300_000 });
  });

  it('new-task race loser: arbiter hands the thread to the winner — duplicate task removed, routed as note', async () => {
    mappingConflict = true; // the winner's mapping lands between our statements
    addNote.mockResolvedValue({ steered: false });
    const id = seedEvent();
    await processChannelEvent({ eventId: id });
    expect(deletedTaskIds).toHaveLength(1); // the loser's fresh unmapped task is gone
    expect(addNote).toHaveBeenCalledWith('task-1', U1, 'Fix the login bug');
    expect(ackSends[0]!.text).toContain('Noted');
    expect(processedWrites).toHaveLength(1);
  });
});
