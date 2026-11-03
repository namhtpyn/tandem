<script setup lang="ts">
import { ROLE } from '#shared/enums';

useHead({ title: 'MCP registry' });
// Admin-gated MCP surface: the registry catalog lives here; per-agent bindings
// are managed inside the AI employee editor. The gate is UX only — the server
// enforces the admin tier on every write verb (SPEC Roles & access).
const session = useAppSession();
const isAdmin = computed(() => session.value?.user.role === ROLE.ADMIN);
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #body>
      <UDashboardNavbar title="MCP registry" :ui="{ root: 'lg:px-8' }">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>

      <div v-if="isAdmin" class="space-y-6 p-4 sm:p-6 lg:p-8">
        <p class="text-muted hidden text-sm sm:block">
          Catalog of MCP servers — bind entries to AI employees in their editor
        </p>

        <McpRegistryManager />
      </div>

      <div v-else class="p-4 sm:p-6 lg:p-8">
        <p class="text-muted text-sm">Admin only</p>
      </div>
    </template>
  </UDashboardPanel>
</template>
