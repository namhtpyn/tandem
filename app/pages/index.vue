<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';

import { CHANGE_RESOURCE } from '#shared/enums';

useHead({ title: 'Overview' });

// Overview landing: live counts + quick links into the three main areas.
// Counts ride the SAME listPaged procs the managers use with pageSize:1 —
// findManyAndCount is one cheap query per resource, no invented count endpoint.
// The change-events subscription invalidates these keys, so the strip stays live.
const { $orpc } = useNuxtApp();

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

const stats = computed(() => [
  { label: 'Environments', value: envCount.data.value?.total },
  { label: 'Employees', value: employeeCount.data.value?.total },
  { label: 'Tasks', value: taskCount.data.value?.total },
]);

// each blurb is a distinct functional one-liner — no two cards say the same thing
const cards = [
  { to: '/environments', icon: 'i-lucide-server', title: 'Environments', blurb: 'SSH hosts the agents run on' },
  { to: '/employees', icon: 'i-lucide-users', title: 'Employees', blurb: 'People and AI agents, one directory' },
  { to: '/tasks', icon: 'i-lucide-list-todo', title: 'Tasks', blurb: 'Work for humans and agents, one board' },
];
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #body>
      <UDashboardNavbar title="Overview">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
      <!-- min-h-full + flex-1 + justify-center: the content block fills the
           viewport below the navbar and centers vertically — no dead void,
           no top-hugging -->
      <div class="flex min-h-full flex-1 flex-col justify-center gap-8 p-6 lg:p-8">
        <p class="text-muted text-sm">Humans and AI employees, one workspace.</p>

        <div class="grid grid-cols-3 gap-3">
          <div v-for="stat in stats" :key="stat.label" class="bg-elevated/50 rounded-lg px-3 py-2.5">
            <p class="text-highlighted text-xl font-bold tabular-nums sm:text-2xl">{{ stat.value ?? '—' }}</p>
            <p class="text-muted mt-0.5 truncate text-xs">{{ stat.label }}</p>
          </div>
        </div>

        <div class="grid gap-4 sm:grid-cols-3">
          <NuxtLink v-for="card in cards" :key="card.to" :to="card.to" class="group block">
            <!-- cards use ring (not border) per the UCard theme, so the hover
                 affordance lights the ring + raises the bg -->
            <UCard
              :ui="{
                root: 'shadow-sm h-full transition-colors hover:bg-elevated hover:ring-accented',
                body: 'p-4 sm:p-4',
              }"
            >
              <div class="flex h-full flex-col gap-3">
                <div class="flex items-center gap-3">
                  <div class="bg-primary/10 flex size-9 shrink-0 items-center justify-center rounded-lg">
                    <UIcon :name="card.icon" class="text-primary size-5" />
                  </div>
                  <p class="text-highlighted min-w-0 flex-1 truncate text-sm font-medium">{{ card.title }}</p>
                  <UIcon
                    name="i-lucide-chevron-right"
                    class="text-dimmed group-hover:text-default size-4 shrink-0 transition-colors"
                  />
                </div>
                <p class="text-muted text-sm leading-5">{{ card.blurb }}</p>
                <span class="text-primary mt-auto inline-flex items-center gap-1 text-xs font-medium">
                  Open
                  <UIcon
                    name="i-lucide-arrow-right"
                    class="size-3.5 transition-transform group-hover:translate-x-0.5"
                  />
                </span>
              </div>
            </UCard>
          </NuxtLink>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
