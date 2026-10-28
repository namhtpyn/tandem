<script setup lang="ts">
// Global error page (Nuxt 4: app/error.vue) — rendered outside the app shell,
// so it carries its own UApp and the zinc palette used by login/dashboard.
import { SERVER_UNREACHABLE_COPY } from '~/utils/copy';

const error = useError();

const statusCode = computed(() => error.value?.statusCode ?? 500);
const title = computed(() => (statusCode.value === 404 ? 'Page not found' : 'Something went wrong'));
// user-facing copy only — never echo error.message (it can carry ops/stack detail)
const description = computed(() => {
  if (statusCode.value === 404) return "This page doesn't exist.";
  if (statusCode.value === 503) return SERVER_UNREACHABLE_COPY;
  return 'This page failed to load. Try again — if it keeps happening, contact your workspace admin.';
});

useHead({ title: () => `${statusCode.value} - Tandem` });

// Back into the app: clearing the error re-renders app.vue fresh; the overview
// shows the login screen when the error was auth-related. The action is a real
// UButton (never a bare underlined link) — clearError is the reliable recovery
// path here, a plain NuxtLink would push the error-state router.
function backToOverview() {
  clearError({ redirect: '/' });
}
</script>

<template>
  <UApp>
    <div class="bg-default flex min-h-dvh flex-col items-center justify-center p-6 text-center">
      <div class="bg-primary/10 flex size-14 items-center justify-center rounded-xl shadow-sm">
        <UIcon
          :name="statusCode === 404 ? 'i-lucide-file-question' : 'i-lucide-triangle-alert'"
          class="text-primary size-7"
        />
      </div>
      <p class="text-dimmed mt-8 text-5xl font-bold tracking-tight tabular-nums sm:text-6xl">{{ statusCode }}</p>
      <h1 class="text-highlighted mt-2 text-2xl font-bold tracking-tight">{{ title }}</h1>
      <p class="text-muted mt-2 max-w-sm text-sm leading-5">{{ description }}</p>
      <UButton class="mt-8" size="lg" icon="i-lucide-arrow-left" label="Back to overview" @click="backToOverview" />
    </div>
  </UApp>
</template>
