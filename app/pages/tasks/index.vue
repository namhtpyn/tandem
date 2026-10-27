<script setup lang="ts">
useHead({ title: 'Tasks' });
// Shell only: navbar + blurb. The list/board/manager logic lives in
// TasksManager (server-paged via tasks.listPaged).
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #body>
      <UDashboardNavbar>
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <!-- title + subtitle are ONE unit in the navbar — a subtitle floating
             under the bar reads as an orphan; hidden on mobile -->
        <template #title>
          <div class="min-w-0">
            <p class="text-highlighted truncate text-base font-semibold">Tasks</p>
            <p class="text-muted hidden text-xs sm:block">Work items for humans and AI agents</p>
          </div>
        </template>
      </UDashboardNavbar>
      <div class="p-4 sm:p-6 lg:p-8">
        <TasksManager />
      </div>
    </template>
  </UDashboardPanel>
</template>
