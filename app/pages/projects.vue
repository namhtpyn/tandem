<script setup lang="ts">
useHead({ title: 'Projects' });
// Projects page shell — the tree table, search, editor and delete confirm live
// in ProjectsManager (full-list client tree: projects are nestable).
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #body>
      <UDashboardNavbar title="Projects" :ui="{ root: 'lg:px-8' }">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
      <div class="space-y-6 p-4 sm:p-6 lg:p-8">
        <p class="text-muted hidden text-sm sm:block">Nestable groups of tasks</p>

        <ProjectsManager />
      </div>
    </template>
  </UDashboardPanel>
</template>
