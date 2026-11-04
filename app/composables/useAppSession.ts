// Shared app state (SSR-safe): session + auth config + version, initialized by
// app.vue and consumed by the layout/pages (NuxtLayout/NuxtPage forward nothing).
import { computed } from 'vue';

import { ROLE } from '#shared/enums';
import type { Role } from '#shared/enums';
import type { AuthConfig } from '~/types/auth';

// Truthful wire shape of the auth.session procedure: the server projects the
// better-auth session down to just the user — no session id/expiresAt crosses
// the wire, so the type must not claim one.
export type AppSessionPayload = {
  user: { id: string; name: string; email: string; role: Role; mustChangePassword?: boolean };
};

export function useAppSession() {
  return useState<AppSessionPayload | null>('tandem:session', () => null);
}

// UI tier visibility gate (SPEC "Roles & access" — UX, never the boundary):
// true only for ADMIN. Every admin-surface verb renderer wires this into the
// managers' `editable` prop / v-if gates; the server tier matrix stays the
// real boundary. Anonymous (no session yet) reads as non-admin — the login
// shell renders no verb chrome anyway.
export function useIsAdmin() {
  const session = useAppSession();
  return computed(() => session.value?.user.role === ROLE.ADMIN);
}

// Employee-tier render gate (SPEC "Roles & access" — UI tier visibility, #300):
// true for every role whose tier may write tasks.*/projects.* (EMPLOYEE +
// ADMIN); false for VIEWER — the Tasks/Projects managers and the task drawer
// render read-only (create CTAs, row verbs, status moves, composer and review
// box hidden). Unknown roles read as VIEWER, mirroring the server. UX only —
// the server tier matrix stays the boundary.
export function useCanWork() {
  const session = useAppSession();
  const role = computed(() => session.value?.user.role);
  return computed(() => role.value === ROLE.EMPLOYEE || role.value === ROLE.ADMIN);
}

export function useAuthConfigState() {
  return useState<AuthConfig | null>('tandem:auth-config', () => null);
}

export function useAppVersion() {
  return useState<string>('tandem:version', () => 'dev');
}

// True only for explicit auth rejections — oRPC UNAUTHORIZED/FORBIDDEN codes or
// a fetch-layer 401/403. Anything else (500, network blip, timeout) must NOT be
// read as "signed out".
export function isUnauthorizedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; status?: unknown; statusCode?: unknown };
  if (candidate.code === 'UNAUTHORIZED' || candidate.code === 'FORBIDDEN') return true;
  return (
    candidate.status === 401 || candidate.status === 403 || candidate.statusCode === 401 || candidate.statusCode === 403
  );
}

// One focus listener per tab, not per call site: app.vue AND the layout both
// called useSessionRefreshing, so every window focus fired the refresh RPC
// twice. The first caller binds; the listener lives for the tab's lifetime —
// refreshSession only touches shared state, safe from any component.
let focusListenerBound = false;
/** test hook: unit suites re-import per test and need the listener re-armed */
export function __resetFocusListenerForTests() {
  focusListenerBound = false;
}

export function useSessionRefreshing() {
  const session = useAppSession();
  async function refreshSession() {
    try {
      const { $client } = useNuxtApp();
      session.value = await $client.auth.session();
    } catch (error) {
      // only an explicit auth rejection signs the user out visually; a
      // transient 500 or dropped request keeps the previous session on screen
      if (isUnauthorizedError(error)) session.value = null;
    }
  }
  // SSR arm unreachable in unit tests; covered by Playwright e2e in the browser
  /* v8 ignore start */
  onMounted(() => {
    if (import.meta.client && !focusListenerBound) {
      focusListenerBound = true;
      window.addEventListener('focus', () => void refreshSession());
    }
  });
  /* v8 ignore stop */
  return { refreshSession };
}
