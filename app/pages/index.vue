<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';

import { CHANGE_RESOURCE, ROLE } from '#shared/enums';

useHead({ title: 'Overview' });

// Overview landing: ONE row of quick-link cards, each carrying its live total.
// Counts ride the SAME listPaged procs the managers use with pageSize:1 —
// findManyAndCount is one cheap query per resource, no invented count endpoint.
// The change-events subscription invalidates these keys, so counts stay live.
const { $orpc } = useNuxtApp();

const session = useAppSession();
// admin-surface cards (environments, employees) hide for non-admins — the
// server enforces the tier (SPEC Roles & access); this is UX, never the boundary
const isAdmin = computed(() => session.value?.user.role === ROLE.ADMIN);

const envCount = useQuery(
  $orpc.environments.listPaged.queryOptions({
    input: { page: 1, pageSize: 1 },
    queryKey: [CHANGE_RESOURCE.ENVIRONMENTS, 'count'],
  }),
);
const employeeCount = useQuery(
  $orpc.employees.listPaged.queryOptions({
    input: { page: 1, pageSize: 1 },
    queryKey: [CHANGE_RESOURCE.EMPLOYEES, 'count'],
  }),
);
const taskCount = useQuery(
  $orpc.tasks.listPaged.queryOptions({ input: { page: 1, pageSize: 1 }, queryKey: [CHANGE_RESOURCE.TASKS, 'count'] }),
);
// company-wide awaiting-decision queue (#91): same listPaged proc, pageSize:1 —
// the total IS the count; the card links to the pre-filtered tasks list
const awaitingCount = useQuery(
  $orpc.tasks.listPaged.queryOptions({
    input: { page: 1, pageSize: 1, awaitingDecision: true },
    queryKey: [CHANGE_RESOURCE.TASKS, 'count', 'awaiting'],
  }),
);

// number + unit label reads as a live count ('12 environments'), not a bare
// placeholder stat — these are the same totals the section pages show
const cards = computed(() => [
  ...(isAdmin.value
    ? [
        {
          to: '/environments',
          icon: 'i-lucide-server',
          count: envCount.data.value?.total,
          label: { singular: 'environment', plural: 'environments' },
          blurb: 'SSH hosts the agents run on',
        },
        {
          to: '/employees',
          icon: 'i-lucide-users',
          count: employeeCount.data.value?.total,
          label: { singular: 'person', plural: 'people' },
          blurb: 'People and AI agents, one directory',
        },
      ]
    : []),
  {
    to: '/tasks',
    icon: 'i-lucide-list-todo',
    count: taskCount.data.value?.total,
    label: { singular: 'task', plural: 'tasks' },
    blurb: 'Work for humans and agents, one board',
  },
  {
    to: '/tasks?awaiting=1',
    icon: 'i-lucide-hourglass',
    count: awaitingCount.data.value?.total,
    label: { singular: 'task awaiting', plural: 'tasks awaiting' },
    blurb: 'Waiting on a decision from anyone',
  },
]);
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #body>
      <UDashboardNavbar title="Overview" :ui="{ root: 'lg:px-8' }">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
      <!-- top-aligned: content sits under the navbar and the empty space falls
           BELOW the cards — vertical centering left a dead void above them -->
      <div class="flex min-h-full flex-1 flex-col space-y-6 p-4 sm:p-6 lg:p-8">
        <p class="text-muted hidden text-sm sm:block">Humans and AI employees, one workspace</p>

        <!-- one row saying one thing: link + live count per area. The chevron is
             the single affordance — no 'Open →' copy, no hover-translate motion.
             Cards stack below sm; the count + label pair wraps inside a card. -->
        <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <NuxtLink
            v-for="card in cards"
            :key="card.to"
            :to="card.to"
            class="group focus-visible:ring-primary block rounded-xl outline-none focus-visible:ring-2"
          >
            <!-- cards use ring (not border) per the UCard theme, so the hover
                 affordance lights the ring + raises the bg; the keyboard focus
                 ring lives on the NuxtLink (the actual focus target) -->
            <UCard
              :ui="{
                root: 'shadow-sm h-full transition-colors hover:bg-elevated hover:ring-accented group-focus-visible:bg-elevated',
                body: 'p-4 sm:p-4',
              }"
            >
              <div class="flex h-full flex-col gap-3">
                <div class="flex items-center justify-between gap-2">
                  <div class="bg-primary/10 flex size-9 shrink-0 items-center justify-center rounded-xl">
                    <UIcon :name="card.icon" class="text-primary size-5" />
                  </div>
                  <UIcon
                    name="i-lucide-chevron-right"
                    class="text-muted group-hover:text-default size-4 shrink-0 transition-colors"
                  />
                </div>
                <div class="flex flex-wrap items-baseline gap-x-2">
                  <p class="text-highlighted text-3xl font-bold tabular-nums">{{ card.count ?? '—' }}</p>
                  <p class="text-muted text-sm">{{ card.count === 1 ? card.label.singular : card.label.plural }}</p>
                </div>
                <p class="text-muted text-sm leading-5">{{ card.blurb }}</p>
              </div>
            </UCard>
          </NuxtLink>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
