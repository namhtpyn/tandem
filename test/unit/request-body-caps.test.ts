// Request-length caps (audit #241, SPEC §Auth + §Routes): the bun nitro preset
// allows no mid-stream body cap — h3 readRawBody is the only safe consumption
// and event.node.req has no asyncIterator. So the undeclared-length path is
// refused PRE-READ in both body-carrying public routes: a chunked POST with no
// usable content-length can never buffer a byte. Pinned here: the helper truth
// table mirrors h3's own readRawBody read-decision, and both route handlers
// throw 411 before touching the body (no data listeners attached, no read, no
// session gate, no multipart parse).
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

import { createEvent, type H3Event } from 'h3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { hasUndeclaredBodySize } from '#server/domains/kernel/request-body';
import attachmentHandler from '#server/routes/api/tasks/[id]/attachments.post.ts';
import authHandler from '#server/routes/auth/[...].ts';
import rpcHandler from '#server/routes/rpc/[...].ts';

// the oRPC handler is mocked so the pinned contract is the ROUTE's gate table:
// 411/413 fire before oRPC is ever handed a Request; legitimate bodies pass
// through intact (the adapter itself is oRPC's, not ours)
const rpcHandle = vi.hoisted(() => vi.fn(async () => ({ response: new Response('rpc-ok') })));
vi.mock('@orpc/server/fetch', () => ({
  // `new RPCHandler(...)` runs at module load — a vi.fn arrow mock cannot be
  // constructed, so the mock is a real class carrying the shared handle spy
  RPCHandler: class {
    handle = rpcHandle;
  },
}));

type FakeReq = EventEmitter & {
  headers: Record<string, string>;
  method: string;
  url: string;
  readable: boolean;
};

function fakeEvent(method: string, url: string, headers: Record<string, string>): { event: H3Event; req: FakeReq } {
  const req = new EventEmitter() as FakeReq;
  req.headers = headers;
  req.method = method;
  req.url = url;
  req.readable = false;
  const res = { headersSent: false, statusCode: 200 } as never;
  const event = createEvent(req as never, res);
  event.context.params = { id: 'task-x' };
  return { event, req };
}

const chunked = { 'transfer-encoding': 'chunked', 'content-type': 'application/json' };

// rpc body tests need a REAL readable stream — readRawBody consumes h3's body
// from the node stream, so the fake event carries a Readable with the payload
// already buffered
function streamEvent(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: Buffer,
): { event: H3Event; req: Readable } {
  const req = new Readable({ read() {} }) as Readable & {
    headers: Record<string, string>;
    method: string;
    url: string;
  };
  req.headers = headers;
  req.method = method;
  req.url = url;
  const res = { headersSent: false, statusCode: 200 } as never;
  const event = createEvent(req as never, res);
  if (body) req.push(body);
  req.push(null);
  return { event, req };
}

describe('hasUndeclaredBodySize — mirrors h3 readRawBody read-decision', () => {
  it('chunked with no content-length -> undeclared', () => {
    expect(hasUndeclaredBodySize(chunked)).toBe(true);
  });

  it('combined transfer-encoding ending in chunked -> undeclared', () => {
    expect(hasUndeclaredBodySize({ 'transfer-encoding': 'gzip, chunked' })).toBe(true);
  });

  it('chunked with content-length: 0 -> undeclared (h3 parses 0 as falsy and reads the stream)', () => {
    expect(hasUndeclaredBodySize({ ...chunked, 'content-length': '0' })).toBe(true);
  });

  it('chunked with a usable declared length -> declared', () => {
    expect(hasUndeclaredBodySize({ ...chunked, 'content-length': '512' })).toBe(false);
  });

  it('declared length alone -> declared', () => {
    expect(hasUndeclaredBodySize({ 'content-length': '100' })).toBe(false);
  });

  it('no length hints at all -> declared (h3 reads nothing either way)', () => {
    expect(hasUndeclaredBodySize({})).toBe(false);
  });
});

describe('POST /auth/** — chunked body refused before a byte is read', () => {
  it('chunked sign-in POST -> 411, no body listener attached', async () => {
    const { event, req } = fakeEvent('POST', '/auth/sign-in/email', chunked);
    await expect(authHandler(event)).rejects.toMatchObject({ statusCode: 411, statusMessage: 'length required' });
    // pre-read proof: h3 never subscribed to the stream (nothing was consumed)
    expect(req.listenerCount('data')).toBe(0);
    expect(req.listenerCount('readable')).toBe(0);
  });

  it('declared-length auth POST shape is not refused by the length gate', () => {
    expect(hasUndeclaredBodySize({ 'content-type': 'application/json', 'content-length': '256' })).toBe(false);
  });
});

describe('POST /api/tasks/:id/attachments — chunked body refused pre-read, pre-gate, pre-parse', () => {
  it('anonymous chunked upload -> 411 before any byte or session work', async () => {
    const { event, req } = fakeEvent('POST', '/api/tasks/task-x/attachments', {
      ...chunked,
      'content-type': 'multipart/form-data; boundary=xx',
    });
    await expect(attachmentHandler(event)).rejects.toMatchObject({ statusCode: 411, statusMessage: 'length required' });
    expect(req.listenerCount('data')).toBe(0);
    expect(req.listenerCount('readable')).toBe(0);
  });

  it('declared-length upload shape is not refused by the length gate', () => {
    expect(
      hasUndeclaredBodySize({ 'content-type': 'multipart/form-data; boundary=xx', 'content-length': '2048' }),
    ).toBe(false);
  });
});

describe('POST /rpc — chunked body refused before a byte is read, oRPC never dispatched (#252)', () => {
  beforeEach(() => {
    rpcHandle.mockClear();
  });

  it('chunked rpc POST -> 411, no body listener, no oRPC dispatch', async () => {
    const { event, req } = streamEvent('POST', '/rpc/tasks/list', chunked);
    await expect(rpcHandler(event)).rejects.toMatchObject({ statusCode: 411, statusMessage: 'length required' });
    // pre-read proof: h3 never subscribed to the stream (nothing was consumed)
    expect(req.listenerCount('data')).toBe(0);
    expect(req.listenerCount('readable')).toBe(0);
    expect(rpcHandle).not.toHaveBeenCalled();
  });
});

describe('POST /rpc — declared body caps fire before oRPC decodes input (#252)', () => {
  beforeEach(() => {
    rpcHandle.mockClear();
  });

  it('declared body over the 2MB input cap -> 413, oRPC never sees it', async () => {
    const big = Buffer.alloc(2_000_001, 0x78);
    const { event } = streamEvent(
      'POST',
      '/rpc/tasks/list',
      { 'content-type': 'application/json', 'content-length': String(big.byteLength) },
      big,
    );
    await expect(rpcHandler(event)).rejects.toMatchObject({ statusCode: 413, statusMessage: 'payload too large' });
    expect(rpcHandle).not.toHaveBeenCalled();
  });

  it('legitimate declared body is forwarded to the oRPC handler intact', async () => {
    const payload = Buffer.from(JSON.stringify({ json: { limit: 10 } }));
    const { event } = streamEvent(
      'POST',
      '/rpc/tasks/list',
      { 'content-type': 'application/json', 'content-length': String(payload.byteLength) },
      payload,
    );
    await rpcHandler(event);
    expect(rpcHandle).toHaveBeenCalledTimes(1);
    const [request, opts] = rpcHandle.mock.calls[0] as unknown as [Request, { prefix: string }];
    expect(opts.prefix).toBe('/rpc');
    expect(request.method).toBe('POST');
    expect(new URL(request.url).pathname).toBe('/rpc/tasks/list');
    expect(await request.text()).toBe(payload.toString());
  });

  it('GET (SSE live) forwards with no body read', async () => {
    const { event, req } = streamEvent('GET', '/rpc/tasks/live', { accept: 'text/event-stream' });
    await rpcHandler(event);
    const [request] = rpcHandle.mock.calls.at(-1) as unknown as [Request, unknown];
    expect(request.method).toBe('GET');
    expect(request.body).toBeNull();
    expect(req.listenerCount('data')).toBe(0);
  });
});
