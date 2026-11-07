<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';

import { CHANGE_RESOURCE } from '#shared/enums';
import { decisionBadgeEnabled } from '~/utils/decision-badge';

// DECISION-VISIBILITY LAW, mobile half: the dashboard sidebar is a closed
// drawer below `lg`, so the same live pending-decision count rides the page
// navbar (next to the drawer toggle) as a one-tap link into the personal
// queue. Shares the shell's ['tasks','inbox'] cache entry — one request, one
// invalidation source (TASKS change resource). Painted after mount for the
// same hydration reason as the sidebar pill (the /tasks cache entry is
// dehydrated by the page, not by the shell).
const { $orpc } = useNuxtApp();
const session = useAppSession();
const inboxLive = useQuery({
  ...$orpc.tasks.inbox.queryOptions({ queryKey: [CHANGE_RESOURCE.TASKS, 'inbox'] }),
  enabled: computed(() => decisionBadgeEnabled(session.value?.user)),
});
const count = computed(() => {
  const data = unref(inboxLive.data) as { items?: unknown[] } | undefined;
  return data?.items?.length ?? 0;
});
const ready = ref(false);
onMounted(() => {
  ready.value = true;
});
</script>

<template>
  <!-- error before count: a failed read must never read as 'nothing waiting'
       (same rule as the shell pill and the Tasks-page toggle) -->
  <NuxtLink
    v-if="ready && inboxLive.isError.value"
    to="/tasks"
    data-testid="nav-inbox-badge-mobile-error"
    aria-label="Decision count unavailable"
    title="Couldn't load the decision count — reopen the page to retry"
    class="bg-error/15 text-error relative inline-flex h-7 min-w-7 items-center justify-center rounded-full px-2 text-xs font-semibold after:absolute after:-inset-2 after:content-[''] lg:hidden"
  >
    <span aria-hidden="true">!</span>
  </NuxtLink>
  <NuxtLink
    v-else-if="ready && count > 0"
    to="/tasks?inbox=1"
    data-testid="nav-inbox-badge-mobile"
    :aria-label="`${count} decision${count === 1 ? '' : 's'} waiting on you`"
    title="Decisions waiting on you"
    class="bg-accented text-default relative inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-full px-2 text-xs font-semibold after:absolute after:-inset-2 after:content-[''] lg:hidden"
  >
    <UIcon name="i-lucide-inbox" class="size-3.5" aria-hidden="true" />
    <span aria-hidden="true">{{ count }}</span>
  </NuxtLink>
</template>
