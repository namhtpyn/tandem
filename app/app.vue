<script setup lang="ts">
// Tandem shell: resolve session/auth-config/version once (SSR), share via useState.
const session = useAppSession();
const authConfig = useAuthConfigState();
const appVersion = useAppVersion();

const { $client } = useNuxtApp();

// The three setup GETs used to await one-by-one, tripling time-to-render — run
// them in parallel. On failure the app cannot know who is signed in, so show
// the Nuxt error page with a clean message instead of letting the raw RPC
// error escape setup.
try {
  const [sess, config, meta] = await Promise.all([
    $client.auth.session(),
    $client.auth.config(),
    $client.meta.version(),
  ]);
  // plain GETs (SSE law: initial data comes from conventional queries; the
  // change-events subscription below refetches when auth-affecting
  // settings/oidc change). Plain POJOs, devalue-serializable.
  session.value = sess;
  authConfig.value = config;
  if (meta.version) appVersion.value = meta.version;
} catch {
  throw createError({
    fatal: true,
    statusCode: 503,
    statusMessage: 'Tandem is unreachable',
    message: 'Could not reach the Tandem server — it may be restarting. Try again in a moment.',
  });
}

// SSE law enforcement: GET queries carry first-load data; this subscription
// only invalidates them after the page is loaded (it opens after mount, so it
// never blocks hydration). Focus-refresh of the session lives in the layout —
// useSessionRefreshing binds its listener once per tab.
useChangeEvents();

useHead({ titleTemplate: (t) => (t ? `${t} - Tandem` : 'Tandem') });

// Nuxt polls builds/latest.json (checkOutdatedBuildInterval) and fires this
// hook when a newer build is deployed — offer a reload, client-side only
const newVersion = ref(false);
const dismissed = ref(false);
if (import.meta.client) {
  useNuxtApp().hooks.hookOnce('app:manifest:update', () => {
    newVersion.value = true;
  });
}

function reload() {
  window.location.reload();
}
</script>

<template>
  <UApp>
    <NuxtRouteAnnouncer />
    <a
      href="#main"
      class="focus:bg-primary focus:text-inverted sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:rounded-md focus:px-3 focus:py-2"
    >
      Skip to main content
    </a>
    <NuxtLayout>
      <!-- display:contents keeps the skip-link main without inserting a block
         between UDashboardGroup's flex row and UDashboardPanel — the panel must
         be a direct flex child or it grows past the viewport and never scrolls -->
      <main id="main" tabindex="-1" class="contents">
        <NuxtPage />
      </main>
    </NuxtLayout>

    <Teleport to="body">
      <div
        v-if="newVersion && !dismissed"
        class="fixed right-4 bottom-4 z-[9999] max-w-sm"
        role="status"
        aria-live="polite"
      >
        <UCard :ui="{ root: 'shadow-lg' }">
          <div class="flex items-start gap-3">
            <UIcon name="i-lucide-refresh-cw" class="text-primary mt-0.5 size-5 shrink-0" />
            <div class="min-w-0 flex-1">
              <p class="text-highlighted text-sm font-medium">New version available</p>
              <p class="text-muted mt-0.5 text-xs">A newer build of Tandem is deployed. Reload to update.</p>
              <div class="mt-3 flex gap-2">
                <UButton size="xs" label="Reload" icon="i-lucide-rotate-cw" @click="reload" />
                <UButton size="xs" color="neutral" variant="ghost" label="Later" @click="dismissed = true" />
              </div>
            </div>
          </div>
        </UCard>
      </div>
    </Teleport>
  </UApp>
</template>
