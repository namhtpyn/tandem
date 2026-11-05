// Matrix adapter transport (SPEC: Channels — adapter contract v1 + first-boot
// history skip + checkpoint-after-sink durability, #271 slice 1). fetch is
// mocked globally; the adapter drives the Client-Server API directly.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelInboundMessage } from '../../server/domains/channels/adapter';
import { createMatrixAdapter, MATRIX_CAPABILITIES } from '../../server/domains/channels/matrix.adapter';

type FetchCall = { url: string; method: string; body?: unknown };
const calls: FetchCall[] = [];
const received: ChannelInboundMessage[] = [];
const checkpoints: string[] = [];
let queue: Array<{ status: number; json: unknown }> = [];
const HOME = 'https://matrix.example.org';

function syncJson(next: string, events: unknown[], userId = '@bot:example.org') {
  return {
    next_batch: next,
    user_id: userId,
    rooms: { join: { '!room:example.org': { timeline: { events } } } },
  };
}

function msg(eventId: string, sender: string, body: string, msgtype = 'm.text') {
  return { type: 'm.room.message', sender, event_id: eventId, content: { msgtype, body } };
}

function mockFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: { method?: string; body?: string }) => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(init.body) : undefined,
      });
      const next = queue.shift();
      if (!next) throw new Error('test queue empty');
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        json: async () => next.json,
      } as Response;
    }),
  );
}

async function until(pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeEach(() => {
  calls.length = 0;
  received.length = 0;
  checkpoints.length = 0;
  queue = [];
  mockFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeAdapter() {
  return createMatrixAdapter({ homeserverUrl: HOME, token: 'tok-1' });
}

function whoOk() {
  return { status: 200, json: { user_id: '@bot:example.org' } };
}

describe('matrix adapter', () => {
  it('first boot: whoami echo guard → initial sync records the checkpoint, delivers NO history', async () => {
    queue.push(whoOk());
    queue.push({ status: 200, json: syncJson('s1', [msg('$old1', '@u:example.org', 'historic message')]) });
    const a = makeAdapter();
    await a.start({
      onMessage: async (m) => {
        received.push(m);
      },
      checkpoint: {
        get: async () => null,
        set: async (v) => {
          checkpoints.push(v);
        },
      },
    });
    await until(() => checkpoints.length > 0, 'first checkpoint');
    expect(received).toHaveLength(0); // history skip law
    expect(checkpoints).toEqual(['s1']);
    await a.stop();
  });

  it('resume: whoami echo guard + deliverable filter + checkpoint advance', async () => {
    queue.push(whoOk());
    queue.push({
      status: 200,
      json: syncJson('s2', [
        msg('$m1', '@u:example.org', 'hello'),
        msg('$m2', '@u:example.org', 'emote', 'm.emote'), // not deliverable
        msg('$m3', '@bot:example.org', 'self echo'), // own sender → echo guard
        { type: 'm.room.message', sender: '@u:example.org', event_id: '$m4', content: {} }, // no body
        { type: 'm.room.encrypted', sender: '@u:example.org', event_id: '$m5', content: {} }, // encrypted
        {
          type: 'm.room.message',
          sender: '@u:example.org',
          event_id: '$m6',
          content: {
            msgtype: 'm.text',
            body: '* hello (edited)',
            'm.relates_to': { rel_type: 'm.replace', event_id: '$m1' },
          },
        }, // edit → skip
      ]),
    });
    const a = makeAdapter();
    await a.start({
      onMessage: async (m) => {
        received.push(m);
      },
      checkpoint: {
        get: async () => 's1',
        set: async (v) => {
          checkpoints.push(v);
        },
      },
    });
    await until(() => checkpoints.length > 0, 'checkpoint advance');
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      threadRef: '!room:example.org',
      senderPlatformId: '@u:example.org',
      text: 'hello',
      externalId: '$m1',
    });
    expect(checkpoints).toEqual(['s2']);
    // the NEXT poll advances to the new position (since-advance law)
    const nextSync = calls.filter((c) => c.url.includes('/sync?')).at(-1);
    expect(nextSync?.url).toContain('since=s2');
    await a.stop();
  });

  it('a failed whoami on FIRST BOOT refuses to start (echo guard is fatal on every start)', async () => {
    queue.push({ status: 401, json: { errcode: 'M_UNKNOWN_TOKEN' } });
    const a = makeAdapter();
    await expect(
      a.start({
        onMessage: async (m) => {
          received.push(m);
        },
        checkpoint: { get: async () => null, set: async () => {} },
      }),
    ).rejects.toThrow('whoami failed');
    expect(calls.length).toBe(1); // no initial sync after the failed whoami
    expect(checkpoints).toHaveLength(0);
    expect(received).toHaveLength(0);
  });

  it('a failed whoami on resume refuses to start (echo guard is fatal)', async () => {
    queue.push({ status: 401, json: { errcode: 'M_UNKNOWN_TOKEN' } });
    const a = makeAdapter();
    await expect(
      a.start({
        onMessage: async (m) => {
          received.push(m);
        },
        checkpoint: { get: async () => 's1', set: async () => {} },
      }),
    ).rejects.toThrow('whoami failed');
    expect(calls.length).toBe(1); // no sync poll after the failed whoami
    expect(received).toHaveLength(0);
  });

  it('a sink failure retries the SAME batch (checkpoint does not advance)', async () => {
    let fail = true;
    queue.push(whoOk());
    queue.push({ status: 200, json: syncJson('s2', [msg('$m1', '@u:example.org', 'hello')]) });
    queue.push({ status: 200, json: syncJson('s2', [msg('$m1', '@u:example.org', 'hello')]) }); // re-read
    const a = makeAdapter();
    await a.start({
      onMessage: async (m) => {
        if (fail) {
          fail = false; // fail exactly once, then accept the re-read
          throw new Error('db down');
        }
        received.push(m);
      },
      checkpoint: {
        get: async () => 's1',
        set: async (v) => {
          checkpoints.push(v);
        },
      },
    });
    await until(() => received.length === 1 && checkpoints.length === 1, 'delivery after retry');
    expect(checkpoints).toEqual(['s2']);
    await a.stop();
  });

  it('M_UNKNOWN_TOKEN stops the adapter instead of spinning', async () => {
    queue.push(whoOk());
    queue.push({ status: 401, json: { errcode: 'M_UNKNOWN_TOKEN', error: 'Invalid macaroon' } });
    const a = makeAdapter();
    await a.start({
      onMessage: async (m) => {
        received.push(m);
      },
      checkpoint: { get: async () => 's1', set: async () => {} },
    });
    await until(() => calls.length >= 2, 'failed poll');
    await new Promise((r) => setTimeout(r, 100));
    const after = calls.length; // no further polls once stopped
    await new Promise((r) => setTimeout(r, 150));
    expect(calls.length).toBe(after);
    await a.stop();
  });

  it('M_UNKNOWN_POS resets the checkpoint to now and resumes', async () => {
    queue.push(whoOk());
    queue.push({ status: 400, json: { errcode: 'M_UNKNOWN_POS', error: 'Unrecognised position' } });
    queue.push({ status: 200, json: syncJson('fresh1', []) }); // timeout=0 reset sync
    const a = makeAdapter();
    await a.start({
      onMessage: async (m) => {
        received.push(m);
      },
      checkpoint: {
        get: async () => 'stale',
        set: async (v) => {
          checkpoints.push(v);
        },
      },
    });
    await until(() => checkpoints.includes('fresh1'), 'reset checkpoint');
    await until(() => calls.filter((c) => c.url.includes('/sync?')).length >= 2, 'post-reset poll');
    const lastSync = calls.filter((c) => c.url.includes('/sync?')).at(-1);
    expect(lastSync?.url).toContain('since=fresh1');
    await a.stop();
  });

  it('send PUTs a plain-text message with a txn id, capped to maxLen', async () => {
    queue.push({ status: 200, json: {} });
    queue.push({ status: 200, json: {} });
    const a = makeAdapter();
    await a.send('!room:example.org', 'x'.repeat(5000));
    const sendCall = calls.find((c) => c.method === 'PUT')!;
    expect(sendCall.url).toContain(
      '/_matrix/client/v3/rooms/' + encodeURIComponent('!room:example.org') + '/send/m.room.message/',
    );
    const body = sendCall.body as { msgtype: string; body: string };
    expect(body.msgtype).toBe('m.text');
    expect(body.body.length).toBe(MATRIX_CAPABILITIES.maxLen);
    expect(body.body.endsWith('…')).toBe(true);
    await a.send('!room:example.org', 'short');
    expect((calls.filter((c) => c.method === 'PUT')[1]!.body as { body: string }).body).toBe('short');
  });

  it('send retries a 429 (honoring retry_after) and succeeds', async () => {
    queue.push({ status: 429, json: { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 10 } });
    queue.push({ status: 200, json: { event_id: '$sent' } });
    const a = makeAdapter();
    await a.send('!room:example.org', 'hi');
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(2);
  });

  it('send carries a JSON content-type header (CS API parity)', async () => {
    queue.push({ status: 200, json: {} });
    const a = makeAdapter();
    await a.send('!room:example.org', 'hi');
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toContain('/send/m.room.message/');
  });

  it('a failed send throws (ack failures are logged upstream, never silent)', async () => {
    queue.push({ status: 403, json: { errcode: 'M_FORBIDDEN' } });
    const a = makeAdapter();
    await expect(a.send('!room:example.org', 'hi')).rejects.toThrow('matrix send failed: status 403');
  });

  it('stop() aborts the loop cleanly', async () => {
    queue.push(whoOk());
    queue.push({ status: 200, json: syncJson('s2', []) });
    const a = makeAdapter();
    await a.start({
      onMessage: async () => {},
      checkpoint: { get: async () => 's1', set: async () => {} },
    });
    await until(() => calls.length >= 1, 'first poll');
    await a.stop();
    const after = calls.length;
    await new Promise((r) => setTimeout(r, 120));
    expect(calls.length).toBe(after);
  });
});
