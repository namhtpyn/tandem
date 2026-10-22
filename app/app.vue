<script setup lang="ts">
// Tandem shell: resolve session/auth-config/version once (SSR), share via useState.
const session = useAppSession();
const authConfig = useAuthConfigState();
const appVersion = useAppVersion();
useSessionRefreshing();

const { $client } = useNuxtApp();

const sess = await $client.auth.session();
if (sess) session.value = sess as unknown as typeof session.value;

// plain GET (SSE law: initial data comes from conventional queries; the
// change-events subscription below refetches when auth-affecting settings/oidc
// change). Plain POJO, devalue-serializable.
authConfig.value = (await $client.auth.config()) as unknown as typeof authConfig.value;

// SSE law enforcement: GET queries carry first-load data; this subscription
// only invalidates them after the page is loaded.
useChangeEvents();

const v = await $client.meta.version();

useHead({ titleTemplate: (t) => (t ? `${t} - Tandem` : 'Tandem') });
if (v.version) appVersion.value = v.version;

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
      <main id="main" tabindex="-1" class="outline-none">
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
              <p class="text-sm font-medium text-zinc-900 dark:text-white">New version available</p>
              <p class="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                A newer build of Tandem is deployed. Reload to update.
              </p>
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
