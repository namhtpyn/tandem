<script setup lang="ts">
useHead({ title: 'Settings' });
// Settings page shell — General (company + workspace AI), model providers and
// authentication (OIDC + password policy) each live in their own self-loading
// section component; shared server state flows through the vue-query cache.
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #body>
      <UDashboardNavbar title="Settings">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>

      <div class="space-y-6 p-6 lg:p-8">
        <div>
          <p class="text-muted text-sm">General and authentication for this workspace</p>
        </div>

        <SettingsGeneralCard />
        <SettingsProvidersCard />
        <SettingsAuthCard />
      </div>
    </template>
  </UDashboardPanel>
</template>
