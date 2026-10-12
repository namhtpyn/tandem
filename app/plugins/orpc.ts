// oRPC typed client + TanStack Query utils (official patterns):
// - Browser: RPCLink to /rpc (same origin)
// - SSR: createRouterClient — direct in-process calls, no HTTP hop
//   (orpc.dev "Optimizing SSR"); built per request so cookies/headers are
//   always the current request's; server code stays out of the client bundle
//   behind import.meta.server (build-time guard).
import type { RouterClient } from '@orpc/server'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'
import type { appRouter } from '~/../server/domains/app.router'

export default defineNuxtPlugin(async () => {
  let client: RouterClient<typeof appRouter>

  if (import.meta.server) {
    const { createRouterClient } = await import('@orpc/server')
    const { appRouter: serverRouter } = await import('~/../server/domains/app.router')
    const { buildServerContext } = await import('~/../server/domains/kernel/context')
    const event = useRequestEvent()
    client = createRouterClient(serverRouter, {
      context: buildServerContext(event?.headers),
    })
  }
  else {
    client = createORPCClient(new RPCLink({ url: '/rpc' }))
  }

  const orpc = createTanstackQueryUtils(client)
  return { provide: { client, orpc } }
})
