<script setup lang="ts">
useHead({ title: 'Employees' });
// Employees page shell — the paged/searched table, org chart and all CRUD
// live in EmployeesManager (server-paged via employees.listPaged).
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #body>
      <UDashboardNavbar title="Employees">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
      <div class="space-y-6 p-6 lg:p-8">
        <div class="flex flex-wrap items-end justify-between gap-2">
          <div>
            <p class="text-sm text-zinc-500">Humans and AI agents, one hierarchy — every employee is a login</p>
          </div>
        </div>

        <EmployeesManager />
      </div>
    </template>
  </UDashboardPanel>
</template>
