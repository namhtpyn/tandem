<script setup lang="ts">
import { ROLE } from '#shared/enums';

useHead({ title: 'MCP registry' });
// Admin-gated MCP surface: the registry catalog lives here and every entry's
// row carries a per-server binding manager (#274); per-agent bindings are
// ALSO manageable inside the AI employee editor (UI parity, SPEC "Binding
// surfaces"). The gate is UX only — the server enforces the admin tier on
// every write verb (SPEC Roles & access).
const session = useAppSession();
const isAdmin = computed(() => session.value?.user.role === ROLE.ADMIN);
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #body>
      <UDashboardNavbar title="MCP registry" :ui="{ root: 'lg:px-8' }">
        <template #leading>
          <UDashboardSidebarCollapse />
          <MobileDecisionBadge />
        </template>
      </UDashboardNavbar>

      <div v-if="isAdmin" class="space-y-6 p-4 sm:p-6 lg:p-8">
        <p class="text-muted hidden text-sm sm:block">
          Catalog of MCP servers — bind AI employees to entries right here or in an employee's editor
        </p>

        <McpRegistryManager />
      </div>

      <div v-else class="p-4 sm:p-6 lg:p-8">
        <p class="text-muted text-sm">Admin only</p>
      </div>
    </template>
  </UDashboardPanel>
</template>
