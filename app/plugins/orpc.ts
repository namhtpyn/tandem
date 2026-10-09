// oRPC typed client + TanStack Query utils.
// Browser: RPCLink to /rpc (same origin). SSR: server-side client via
// internalLink — handler invoked in-process, no HTTP hop (oRPC SSR recipe);
// registered on globalThis so the client bundle never imports server code.
import type { RouterClient } from '@orpc/server'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'
import type { router } from '~/../server/utils/orpc'

export default defineNuxtPlugin(async () => {
  let client: RouterClient<typeof router>

  if (import.meta.server) {
    client = globalThis.$tandemOrpcClient ??= await createServerClient()
  }
  else {
    client = createORPCClient(new RPCLink({ url: '/rpc' }))
  }

  const orpc = createTanstackQueryUtils(client)
  return { provide: { client, orpc } }
})

// Built lazily inside a server-only module so the router never enters the
// client bundle (oRPC optimizing-ssr recipe).
async function createServerClient(): Promise<RouterClient<typeof router>> {
  const [{ RPCHandler }, { router, buildServerContext }] = await Promise.all([
    import('@orpc/server/fetch'),
    import('~/../server/utils/orpc'),
  ])
  const event = useRequestEvent()
  const handler = new RPCHandler(router)
  const internalLink = new RPCLink({
    url: '/rpc',
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const request = new Request(url, init)
      const headers = new Headers()
      event?.headers?.forEach((v, k) => headers.set(k, v))
      const { response } = await handler.handle(request, {
        prefix: '/rpc',
        context: buildServerContext(headers),
      })
      return response ?? new Response('Not Found', { status: 404 })
    },
  })
  return createORPCClient(internalLink)
}

declare global {
  var $tandemOrpcClient: RouterClient<typeof router> | undefined
}
