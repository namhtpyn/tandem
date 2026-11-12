// OWNER-MOVE RECORD (#430), producer half: the prod probe's manual-freedom discriminator
// reads `task_messages.body LIKE 'status: %'` PLUS the 1:1 activity payload's
// `kind = 'STATUS'`. The reader is pinned against seeded rows and the writer against a
// mocked terminal; THIS pins the store itself — insertActivityMessage must persist BOTH
// rows, with the exact body and the payload it was handed (a renamed payload key or a
// dropped extension row would silently blind the watchdog while every other test stays
// green).
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ inserts: [] as Array<{ table: string; values: unknown }> }));

vi.mock('../../server/db/index', async () => {
  const { taskMessages, taskMessageActivities } = await import('../../server/db/schema');
  const insert = (table: unknown) => ({
    values: (values: unknown) => {
      h.inserts.push({
        table:
          table === taskMessages
            ? 'task_messages'
            : table === taskMessageActivities
              ? 'task_message_activities'
              : 'other',
        values,
      });
      return { returning: async () => [{ id: 'msg-1' }] };
    },
  });
  return { asDb: (x: unknown) => x, db: { insert } };
});

// thread.service pulls these at module load; none is under test here
vi.mock('../../server/domains/tasks/brief.service', () => ({ activityKindOf: () => 'STATUS' }));
vi.mock('../../server/domains/tasks/echo-notes', () => ({ dropEchoNotes: () => [] }));
vi.mock('../../server/domains/tasks/run-transcript', () => ({ loadTranscriptBits: async () => ({}) }));

import { insertActivityMessage } from '#server/domains/tasks/thread.service';

describe('insertActivityMessage persists the owner-move record the probe reads (#430)', () => {
  it('writes the message row AND its 1:1 payload with the same kind', async () => {
    h.inserts = [];
    await insertActivityMessage({
      taskId: 'task-1',
      authorId: 'u1',
      body: 'status: a → b',
      payload: { kind: 'STATUS' },
    });
    expect(h.inserts.map((i) => i.table)).toEqual(['task_messages', 'task_message_activities']);
    expect(h.inserts[0]?.values).toMatchObject({ taskId: 'task-1', authorId: 'u1', body: 'status: a → b' });
    expect(h.inserts[1]?.values).toEqual({ messageId: 'msg-1', payload: { kind: 'STATUS' } });
  });
});
