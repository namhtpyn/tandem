<script setup lang="ts">
useHead({ title: 'Settings' });
// Settings page shell — General (workspace identity + AI), model providers and
// authentication (OIDC + password policy) each live in their own self-loading
// section component; shared server state flows through the vue-query cache.
// Admin-only surface (SPEC "Roles & access" — UI tier visibility): every card
// writes through admin-tier verbs; non-admin deep links get the read-only note.
const isAdmin = useIsAdmin();
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #body>
      <UDashboardNavbar title="Settings" :ui="{ root: 'lg:px-8' }">
        <template #leading>
          <UDashboardSidebarCollapse />
          <MobileDecisionBadge />
        </template>
      </UDashboardNavbar>

      <div v-if="isAdmin" class="space-y-6 p-4 sm:p-6 lg:p-8">
        <p class="text-muted hidden text-sm sm:block">General and authentication for this workspace</p>

        <SettingsGeneralCard />
        <SettingsProvidersCard />
        <SettingsChannelsCard />
        <SettingsAuthCard />
      </div>

      <div v-else class="p-4 sm:p-6 lg:p-8">
        <p class="text-muted text-sm">Admin only</p>
      </div>
    </template>
  </UDashboardPanel>
</template>
