// /rpc — oRPC v2 Fetch API adapter (official Nuxt adapter pattern):
// toWebRequest(event) forwards the real request; RPCHandler with an onError
// interceptor for server-side error visibility. Live queries stream over SSE.
import { onError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { consola } from 'consola';

import { appRouter as router } from '../../domains/app.router';

export const log = consola.withTag('orpc');

import { buildServerContext } from '../../domains/kernel/context';

const handler = new RPCHandler(router, {
  interceptors: [
    onError((error, { path }) => {
      /* v8 ignore start -- defensive: oRPC always sets code on mapped errors */
      log.error(`${path.join('.')}: ${(error as { code?: string }).code ?? 'UNKNOWN'} ${(error as Error).message}`);
      /* v8 ignore stop */
    }),
  ],
});

export default defineEventHandler(async (event) => {
  const request = toWebRequest(event);
  const headers = new Headers();
  for (const [k, v] of request.headers) headers.set(k, v);
  const { response } = await handler.handle(request, {
    prefix: '/rpc',
    context: buildServerContext(headers),
  });
  if (response) return response;
  setResponseStatus(event, 404, 'Not Found');
  return 'Not found';
});
