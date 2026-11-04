<script setup lang="ts">
useHead({ title: 'Employees' });
// Employees page shell — the paged/searched table, org chart and all CRUD
// live in EmployeesManager (server-paged via employees.listPaged). The flex
// column lets the org-graph canvas fill the remaining viewport height.
// Admin-only writes (SPEC "Roles & access" — UI tier visibility): the manager
// renders read-only for non-admin deep links; employee/titles/key verbs are
// admin-tier.
const isAdmin = useIsAdmin();
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #body>
      <UDashboardNavbar title="Employees" :ui="{ root: 'lg:px-8' }">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
      <div class="flex min-h-full flex-col space-y-6 p-4 sm:p-6 lg:p-8">
        <p class="text-muted hidden text-sm sm:block">
          Manage human and AI-agent accounts, titles, and reporting lines
        </p>

        <EmployeesManager class="min-h-0 flex-1" :editable="isAdmin" />
      </div>
    </template>
  </UDashboardPanel>
</template>
