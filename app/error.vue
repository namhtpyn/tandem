<script setup lang="ts">
// Global error page (Nuxt 4: app/error.vue) — rendered outside the app shell,
// so it carries its own UApp and the zinc palette used by login/dashboard.
const error = useError();

const statusCode = computed(() => error.value?.statusCode ?? 500);
const title = computed(() => (statusCode.value === 404 ? 'Page not found' : 'Something went wrong'));
// user-facing copy only — never echo error.message (it can carry ops/stack detail)
const description = computed(() => {
  if (statusCode.value === 404) return "This page doesn't exist.";
  if (statusCode.value === 503) return "Can't reach the server. Try again in a moment.";
  return 'This page failed to load. Try again — if it keeps happening, contact your workspace admin.';
});

useHead({ title: () => `${statusCode.value} - Tandem` });

// Back into the app: clearing the error re-renders app.vue fresh; /tasks shows
// the login screen when the error was auth-related.
function backToTasks() {
  clearError({ redirect: '/tasks' });
}
</script>

<template>
  <UApp>
    <div class="bg-default flex min-h-screen flex-col items-center justify-center p-6 text-center">
      <div class="bg-primary/10 flex size-12 items-center justify-center rounded-xl shadow-sm">
        <UIcon
          :name="statusCode === 404 ? 'i-lucide-file-question' : 'i-lucide-triangle-alert'"
          class="text-primary size-6"
        />
      </div>
      <p class="text-dimmed mt-6 text-sm font-medium">{{ statusCode }}</p>
      <h1 class="text-highlighted mt-1 text-2xl font-bold tracking-tight">{{ title }}</h1>
      <p class="text-muted mt-2 max-w-sm text-sm leading-5">{{ description }}</p>
      <UButton class="mt-6" size="lg" icon="i-lucide-arrow-left" label="Back to tasks" @click="backToTasks" />
    </div>
  </UApp>
</template>
