// better-auth vue client mounted on the app (plugin so $authClient exists app-wide).
// OIDC sign-in goes through POST /auth/sign-in/social directly (no client plugin
// needed — pathbridge pattern).
//
// inferAdditionalFields<typeof getAuth>(): the server adds user.role via
// additionalFields; this plugin carries that type to the CLIENT so
// $authClient.useSession / getSession see role without a manual re-declare
// (single-project setup — better-auth docs: concepts/typescript).
import { createAuthClient } from 'better-auth/vue'
import { inferAdditionalFields } from 'better-auth/client/plugins'
import type { getAuth } from '#server/utils/auth'

export default defineNuxtPlugin(() => {
  const url = useRequestURL()
  const headers = import.meta.server ? useRequestHeaders(['cookie']) : undefined
  const client = createAuthClient({
    baseURL: `${url.origin}/auth`,
    fetchOptions: { headers },
    plugins: [inferAdditionalFields<typeof getAuth>()],
  })
  return {
    provide: {
      authClient: client,
    },
  }
})
