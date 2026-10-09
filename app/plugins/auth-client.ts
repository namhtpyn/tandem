// better-auth vue client mounted on the app (plugin so $authClient exists app-wide).
// OIDC sign-in goes through POST /auth/sign-in/social directly (no client plugin
// needed — pathbridge pattern).
import { createAuthClient } from 'better-auth/vue'

export default defineNuxtPlugin(() => {
  const url = useRequestURL()
  const headers = import.meta.server ? useRequestHeaders(['cookie']) : undefined
  const client = createAuthClient({
    baseURL: `${url.origin}/auth`,
    fetchOptions: { headers },
  })
  return {
    provide: {
      authClient: client,
    },
  }
})
