<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
// Review checklist for the current round + earlier rounds collapsed to a count
// (REVIEW LAW). Self-loads reviews + employees (reviewer names) under the same
// query keys wfAction invalidates after each verdict. Props: `taskId`.
import { computed, onServerPrefetch } from 'vue';

import { CHANGE_RESOURCE, REVIEW_STATUS } from '#shared/enums';
import type { EmployeeRow, ReviewRow } from '~/utils/orpc-types';
import { kindLabel, verdictLabel } from '~/utils/ui-labels';

const props = defineProps<{ taskId: string }>();

const { $orpc } = useNuxtApp();

const reviewsQuery = useQuery(
  computed(() =>
    $orpc.tasks.reviews.queryOptions({
      input: { taskId: props.taskId },
      // suffix on the TASK_ACTIVITY prefix: the SSE subscription invalidates the
      // prefix, and each surface keeps its own cache slot
      queryKey: [CHANGE_RESOURCE.TASK_ACTIVITY, props.taskId, 'reviews'],
    }),
  ),
);
const employeesLive = useQuery($orpc.employees.list.queryOptions({ queryKey: [CHANGE_RESOURCE.EMPLOYEES] }));
const employees = computed(() => (unref(employeesLive.data) ?? []) as EmployeeRow[]);

/** reviewer kind comes from the employee record — a PENDING verdict row has no source yet;
 * shared kindLabel vocabulary ('AI agent'/'Human'), never lowercase fragments */
const kindOf = (id: string | null, fallback: string | null) =>
  kindLabel(employees.value.find((e) => e.userId === id)?.kind ?? fallback);

/** the verdict in words — one shared vocabulary (ui-labels); the row communicates
 *  state by icon, which is invisible to screen readers without this */

/** REVIEW LAW checklist: current-round verdicts per reviewer, history collapsed by round.
 * Status is the SCREAMING ReviewStatus enum — compare through its constants (the old
 * lowercase literals never matched a stored value, so every row rendered as pending). */
const reviewChecklist = computed(() => {
  const rows = (unref(reviewsQuery.data) ?? []) as ReviewRow[];
  const nameOf = (id: string | null) => employees.value.find((e) => e.userId === id)?.name ?? 'reviewer';
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
    <h2 class="text-muted mb-2 text-xs font-medium">Review</h2>
    <div v-if="reviewsQuery.isPending.value" class="space-y-1.5" aria-hidden="true">
      <USkeleton class="h-6 w-full rounded" />
      <USkeleton class="h-6 w-3/4 rounded" />
    </div>
    <p v-else-if="reviewsQuery.isError.value" role="alert" class="text-error text-xs">Couldn't load reviews</p>
    <p v-else-if="!reviewChecklist.current.length" class="text-dimmed text-xs">
      No reviews yet — verdicts appear here as reviewers weigh in.
    </p>
    <ul v-else class="space-y-1 text-sm">
      <li
        v-for="r in reviewChecklist.current"
        :key="`${r.round}-${r.reviewerId ?? r.name}`"
        class="flex items-start gap-1.5"
      >
        <UIcon
          :name="
            r.status === REVIEW_STATUS.APPROVED
              ? 'i-lucide-badge-check'
              : r.status === REVIEW_STATUS.CHANGE_REQUESTED
                ? 'i-lucide-undo-2'
                : r.status === REVIEW_STATUS.REJECTED
                  ? 'i-lucide-x-circle'
                  : r.status === REVIEW_STATUS.ESCALATED
                    ? 'i-lucide-arrow-up-right'
                    : r.status === REVIEW_STATUS.SUPERSEDED
                      ? 'i-lucide-minus-circle'
                      : 'i-lucide-user'
          "
          class="mt-0.5 size-3.5 shrink-0"
          aria-hidden="true"
          :class="
            r.status === REVIEW_STATUS.APPROVED
              ? 'text-success'
              : r.status === REVIEW_STATUS.REJECTED
                ? 'text-error'
                : r.status === REVIEW_STATUS.PENDING
                  ? 'text-dimmed'
                  : 'text-warning'
          "
        />
        <span class="min-w-0">
          <span class="sr-only">{{ verdictLabel(r.status) }}: </span>
          <span class="text-default block truncate"
            >{{ r.name }}
            <span v-if="kindOf(r.reviewerId, r.source)" class="text-dimmed text-xs"
              >({{ kindOf(r.reviewerId, r.source) }})</span
            ></span
          >
          <span v-if="r.note" class="text-dimmed block truncate text-xs" :title="r.note">{{ r.note }}</span>
        </span>
      </li>
      <li v-if="reviewChecklist.history.length" class="text-dimmed pt-1 text-xs">
        {{ reviewChecklist.history.length }} earlier-round
        {{ reviewChecklist.history.length === 1 ? 'verdict' : 'verdicts' }}
      </li>
    </ul>
  </div>
</template>
