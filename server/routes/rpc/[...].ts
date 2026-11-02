// /rpc — oRPC v2 Fetch API adapter (official Nuxt adapter pattern):
// the event's raw body is consumed + capped pre-read (SPEC request-body law)
// and rebuilt into a WHATWG Request; RPCHandler with an onError interceptor
// for server-side error visibility. Live queries stream over SSE.
import { onError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { consola } from 'consola';
import { createError, defineEventHandler, getRequestHeaders, readRawBody, setResponseStatus } from 'h3';

import { appRouter as router } from '../../domains/app.router';

export const log = consola.withTag('orpc');

import { buildServerContext } from '../../domains/kernel/context';
import { hasUndeclaredBodySize } from '../../domains/kernel/request-body';
import { buildForwardedRequest } from '../../domains/kernel/request-forward';

const handler = new RPCHandler(router, {
  interceptors: [
    onError((error, { path }) => {
      /* v8 ignore start -- defensive: oRPC always sets code on mapped errors */
      log.error(`${path.join('.')}: ${(error as { code?: string }).code ?? 'UNKNOWN'} ${(error as Error).message}`);
      /* v8 ignore stop */
    }),
  ],
});

/** generous for JSON procedure inputs, small enough that a hostile body cannot balloon memory — oRPC buffers the whole input via request.json() BEFORE any procedure middleware runs, so requireSession would never see an oversized body (audit #252) */
const MAX_RPC_BODY_BYTES = 2_000_000;

export default defineEventHandler(async (event) => {
  // undeclared-length (chunked) bodies: h3 buffers the whole body before any
  // size cap can fire and the bun preset allows no mid-stream cap — refuse
  // before a byte is read (SPEC request-body law, audit #252)
  if (hasUndeclaredBodySize(getRequestHeaders(event))) {
    throw createError({ statusCode: 411, statusMessage: 'length required' });
  }

  const raw = event.method !== 'GET' && event.method !== 'HEAD' ? await readRawBody(event, false) : undefined;
  // 2MB input cap BEFORE the oRPC handler re-buffers the body via request.json()
  // (declared bodies only: chunked was refused 411 above, so h3 never streams unbounded here)
  if (raw && Buffer.byteLength(raw) > MAX_RPC_BODY_BYTES) {
    throw createError({ statusCode: 413, statusMessage: 'payload too large' });
  }

  const body = raw?.byteLength
    ? (raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer)
    : undefined;
  const request = buildForwardedRequest(event, body);
  const { response } = await handler.handle(request, {
    prefix: '/rpc',
    context: buildServerContext(request.headers),
  });
  if (response) return response;
  setResponseStatus(event, 404, 'Not Found');
  return 'Not found';
});
