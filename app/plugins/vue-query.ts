// TanStack Query for Vue + oRPC integration, SSR per the official Nuxt guide:
// server queries dehydrate into nuxt state, client hydrates — no client refetch
// for fresh snapshots. refetchOnMount: 'always' (client only) still re-opens the
// SSE live streams after hydration (official oRPC SSR guidance).
import type { DehydratedState, VueQueryPluginOptions } from '@tanstack/vue-query'
import { QueryClient, VueQueryPlugin, dehydrate, hydrate } from '@tanstack/vue-query'

export default defineNuxtPlugin((nuxtApp) => {
  const vueQueryState = useState<DehydratedState | null>('vue-query')
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

  if (import.meta.server) {
    nuxtApp.hooks.hook('app:rendered', () => {
      vueQueryState.value = dehydrate(queryClient)
    })
  }
  if (import.meta.client && vueQueryState.value !== null) {
    hydrate(queryClient, vueQueryState.value)
  }
})
