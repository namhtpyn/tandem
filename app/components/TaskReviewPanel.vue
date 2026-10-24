<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
// Review checklist for the current round + earlier rounds collapsed to a count
// (REVIEW LAW). Self-loads reviews + employees (reviewer names) under the same
// query keys wfAction invalidates after each verdict. Props: `taskId`.
import { computed, onServerPrefetch } from 'vue';

import { CHANGE_RESOURCE } from '#shared/enums';

const props = defineProps<{ taskId: string }>();

const { $orpc } = useNuxtApp();

const reviewsQuery = useQuery(
  computed(() =>
    $orpc.tasks.reviews.queryOptions({
      input: { taskId: props.taskId },
      queryKey: ['taskReviews', props.taskId],
    }),
  ),
);
const employeesLive = useQuery($orpc.employees.list.queryOptions({ queryKey: [CHANGE_RESOURCE.EMPLOYEES] }));
const employees = computed(() => (unref(employeesLive.data) ?? []) as unknown as Array<{ userId: string; name: string }>);

/** REVIEW LAW checklist: current-round verdicts per reviewer, history collapsed by round */
const reviewChecklist = computed(() => {
  const rows = (unref(reviewsQuery.data) ?? []) as unknown as Array<{
    reviewerId: string;
    round: number;
    status: string;
    note: string | null;
    source: string | null;
  }>;
  const nameOf = (id: string) => employees.value.find((e) => e.userId === id)?.name ?? 'reviewer';
  let maxRound = 0;
  for (const r of rows) maxRound = Math.max(maxRound, r.round);
  return {
    current: rows.filter((r) => r.round === maxRound).map((r) => ({ ...r, name: nameOf(r.reviewerId) })),
    history: rows.filter((r) => r.round < maxRound).map((r) => ({ ...r, name: nameOf(r.reviewerId) })),
  };
});

onServerPrefetch(() => Promise.all([reviewsQuery.suspense(), employeesLive.suspense()]));
</script>

<template>
  <div>
    <p class="mb-2 text-xs font-semibold tracking-wide text-zinc-400 uppercase">Review</p>
    <ul class="space-y-1 text-sm">
      <li v-for="r in reviewChecklist.current" :key="r.reviewerId" class="flex items-start gap-1.5">
        <UIcon
          :name="
            r.status === 'approved'
              ? 'i-lucide-badge-check'
              : r.status === 'change_requested'
                ? 'i-lucide-undo-2'
                : r.status === 'rejected'
                  ? 'i-lucide-x-circle'
                  : 'i-lucide-user'
          "
          class="mt-0.5 size-3.5 shrink-0"
          :class="
            r.status === 'approved'
              ? 'text-success'
              : r.status === 'pending'
                ? 'text-zinc-400'
                : 'text-warning'
          "
        />
        <span class="min-w-0">
          <span class="block truncate text-zinc-800 dark:text-zinc-200"
            >{{ r.name }}
            <span class="text-xs text-zinc-400">({{ r.source === 'ai' ? 'AI' : 'human' }})</span></span
          >
          <span v-if="r.note" class="block truncate text-xs text-zinc-400" :title="r.note">{{
            r.note
          }}</span>
        </span>
      </li>
      <li v-if="reviewChecklist.history.length" class="pt-1 text-xs text-zinc-400">
        {{ reviewChecklist.history.length }} earlier-round verdict(s)
      </li>
    </ul>
  </div>
</template>
