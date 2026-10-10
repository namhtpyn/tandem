// /rpc — oRPC v2 Fetch API adapter (official Nuxt adapter pattern):
// toWebRequest(event) forwards the real request; RPCHandler with an onError
// interceptor for server-side error visibility. Live queries stream over SSE.
import { onError } from '@orpc/server'
import { RPCHandler } from '@orpc/server/fetch'
import { router, buildServerContext } from '../../utils/orpc'

const handler = new RPCHandler(router, {
  interceptors: [
    onError((error, { path }) => {
      /* v8 ignore start -- defensive: oRPC always sets code on mapped errors */
      console.error(`[orpc] ${path.join('.')}: ${(error as { code?: string }).code ?? 'UNKNOWN'} ${(error as Error).message}`)
      /* v8 ignore stop */
    }),
  ],
})

export default defineEventHandler(async (event) => {
  const request = toWebRequest(event)
  const headers = new Headers()
  request.headers.forEach((v, k) => headers.set(k, v))
  const { response } = await handler.handle(request, {
    prefix: '/rpc',
    context: buildServerContext(headers),
  })
  if (response) return response
  setResponseStatus(event, 404, 'Not Found')
  return 'Not found'
})
