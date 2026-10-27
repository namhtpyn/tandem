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
      <div class="p-4 sm:p-6 lg:p-8">
        <!-- subtitle sits directly under the page title (small, muted); hidden on mobile -->
        <p class="text-muted hidden pb-3 text-sm sm:block">Work items for humans and AI agents</p>
        <TasksManager />
      </div>
    </template>
  </UDashboardPanel>
</template>
