<script setup lang="ts">
useHead({ title: 'Projects' });
// Projects page shell — the tree table, search, editor and delete confirm live
// in ProjectsManager (full-list client tree: projects are nestable).
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #body>
      <UDashboardNavbar title="Projects">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
      <div class="space-y-6 p-6 lg:p-8">
        <div class="flex flex-wrap items-end justify-between gap-2">
          <div>
            <p class="text-sm text-zinc-500">Group work into nestable projects</p>
          </div>
        </div>

        <ProjectsManager />
      </div>
    </template>
  </UDashboardPanel>
</template>
