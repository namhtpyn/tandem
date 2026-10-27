<script setup lang="ts">
useHead({ title: 'Overview' });

// Overview landing: quick links into the three main areas of the workspace.
const cards = [
  { to: '/environments', icon: 'i-lucide-server', title: 'Environments', blurb: 'SSH targets that run Hermes.' },
  { to: '/employees', icon: 'i-lucide-users', title: 'Employees', blurb: 'Humans and AI, one hierarchy.' },
  { to: '/tasks', icon: 'i-lucide-list-todo', title: 'Tasks', blurb: 'Assign and track work.' },
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
      <div class="space-y-6 p-6 lg:p-8">
        <p class="text-muted text-sm">Humans and AI employees, one workspace.</p>

        <div class="grid gap-4 sm:grid-cols-3">
          <NuxtLink v-for="card in cards" :key="card.to" :to="card.to" class="block">
            <UCard :ui="{ root: 'shadow-sm transition-colors hover:bg-elevated/50' }">
              <div class="flex items-center gap-3">
                <div class="bg-primary/10 flex size-9 items-center justify-center rounded-lg">
                  <UIcon :name="card.icon" class="text-primary size-5" />
                </div>
                <div class="min-w-0">
                  <p class="text-highlighted text-sm font-medium">{{ card.title }}</p>
                  <p class="text-muted text-xs">{{ card.blurb }}</p>
                </div>
              </div>
            </UCard>
          </NuxtLink>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
