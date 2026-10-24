<script setup lang="ts">
useHead({ title: 'Tasks' });
// Shell only: navbar + blurb. The list/board/manager logic lives in
// TasksManager (server-paged via tasks.listPaged).
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #body>
      <UDashboardNavbar title="Tasks">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
      <div class="space-y-6 p-6 lg:p-8">
        <div class="flex flex-wrap items-end justify-between gap-2">
          <div>
            <p class="text-sm text-zinc-500">Work items for humans and AI agents</p>
          </div>
        </div>
        <TasksManager />
      </div>
    </template>
  </UDashboardPanel>
</template>
