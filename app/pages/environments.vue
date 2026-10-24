<script setup lang="ts">
useHead({ title: 'Environments' });
// Environments page shell — the table, search, probe and CRUD live in
// EnvironmentsManager (server-paged via environments.listPaged).
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #body>
      <UDashboardNavbar title="Environments">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
      <div class="space-y-6 p-6 lg:p-8">
        <div class="flex flex-wrap items-end justify-between gap-2">
          <div>
            <p class="text-sm text-zinc-500">SSH targets that run the Hermes agent</p>
          </div>
        </div>

        <EnvironmentsManager />
      </div>
    </template>
  </UDashboardPanel>
</template>
