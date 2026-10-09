// /rpc — oRPC v2 Fetch API adapter. Live queries stream over SSE; session
// context built per request from the incoming headers.
import { RPCHandler } from '@orpc/server/fetch'
import { defineEventHandler, setResponseStatus } from 'h3'
import { router, buildServerContext } from '../../utils/orpc'

const handler = new RPCHandler(router)

export default defineEventHandler(async (event) => {
  const headers = new Headers()
  Object.entries(event.node.req.headers).forEach(([k, v]) => {
    if (v === undefined) return
    if (Array.isArray(v)) v.forEach(item => headers.append(k, item))
    else headers.set(k, v)
  })
  const url = new URL(event.node.req.url ?? '/', 'http://localhost')
  const rawBody = (event.node.req as { body?: unknown }).body
  const body = typeof rawBody === 'string' ? rawBody : rawBody === undefined ? undefined : JSON.stringify(rawBody)
  const request = new Request(url, {
    method: event.method,
    headers,
    ...(body !== undefined ? { body, duplex: 'half' as const } : {}),
  })
  const { response } = await handler.handle(request, {
    prefix: '/rpc',
    context: buildServerContext(headers),
  })
  if (response) return response
  setResponseStatus(event, 404, 'Not found')
  return 'Not found'
})
