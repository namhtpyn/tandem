// Request-length caps (audit #241, SPEC §Auth + §Routes): the bun nitro preset
// allows no mid-stream body cap — h3 readRawBody is the only safe consumption
// and event.node.req has no asyncIterator. So the undeclared-length path is
// refused PRE-READ in both body-carrying public routes: a chunked POST with no
// usable content-length can never buffer a byte. Pinned here: the helper truth
// table mirrors h3's own readRawBody read-decision, and both route handlers
// throw 411 before touching the body (no data listeners attached, no read, no
// session gate, no multipart parse).
import { EventEmitter } from 'node:events';

import { createEvent, type H3Event } from 'h3';
import { describe, expect, it } from 'vitest';

import { hasUndeclaredBodySize } from '#server/domains/kernel/request-body';
import attachmentHandler from '#server/routes/api/tasks/[id]/attachments.post.ts';
import authHandler from '#server/routes/auth/[...].ts';

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
