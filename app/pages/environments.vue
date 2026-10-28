<script setup lang="ts">
useHead({ title: 'Environments' });
// Environments page shell — the table, search, probe and CRUD live in
// EnvironmentsManager (server-paged via environments.listPaged).
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #body>
      <UDashboardNavbar title="Environments" :ui="{ root: 'lg:px-8' }">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
      <div class="space-y-6 p-4 sm:p-6 lg:p-8">
        <p class="text-muted hidden text-sm sm:block">SSH hosts the agents run on</p>

        <EnvironmentsManager />
      </div>
    </template>
  </UDashboardPanel>
</template>
