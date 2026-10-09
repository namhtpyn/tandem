// TanStack Query for Vue + oRPC integration. Live queries need
// refetchOnMount: 'always' on the client so hydrated snapshots re-open SSE
// streams (official oRPC SSR guidance).
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
import type { VueQueryPluginOptions } from '@tanstack/vue-query'

export default defineNuxtPlugin((nuxtApp) => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        retry: 1,
        ...(typeof window !== 'undefined' ? { refetchOnMount: 'always' as const } : {}),
      },
    },
  })
  const options: VueQueryPluginOptions = { queryClient }
  nuxtApp.vueApp.use(VueQueryPlugin, options)
})
