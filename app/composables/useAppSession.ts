// Shared app state (SSR-safe): session + auth config + version, initialized by
// app.vue and consumed by the layout/pages (NuxtLayout/NuxtPage forward nothing).
import type { AuthConfig } from '~/types/auth'

export interface AppSessionPayload {
  user: { id: string, name: string, email: string, role: string }
  session: { expiresAt: string }
}

export function useAppSession() {
  return useState<AppSessionPayload | null>('tandem:session', () => null)
}

export function useAuthConfigState() {
  return useState<AuthConfig | null>('tandem:auth-config', () => null)
}

export function useAppVersion() {
  return useState<string>('tandem:version', () => 'dev')
}

export function useSessionRefreshing() {
  const session = useAppSession()
  async function refreshSession() {
    try {
      const { $client } = useNuxtApp()
      session.value = await $client.auth.session() as AppSessionPayload | null
    }
    catch {
      session.value = null
    }
  }
  // SSR arm unreachable in unit tests; covered by Playwright e2e in the browser
  /* v8 ignore start */
  if (import.meta.client) {
    onMounted(() => {
      window.addEventListener('focus', refreshSession)
    })
    onUnmounted(() => {
      window.removeEventListener('focus', refreshSession)
    })
  }
  /* v8 ignore stop */
  return { refreshSession }
}
