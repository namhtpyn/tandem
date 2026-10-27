<script setup lang="ts">
useHead({ title: 'Vault' });
// Secret vault: write-only secrets (AES-256-GCM server-side). Values are set
// once and never displayed again — only a last-4 hint. Mobile-first cards.
import { ref } from 'vue';

// ---- folder filter: self-loading VaultFolderSelect (v-model = folder id | null) ----
const activeFolder = ref<string | null>(null);
const folderManagerOpen = ref(false);
function onFolderDeleted(id: string) {
  if (activeFolder.value === id) activeFolder.value = null;
}
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #body>
      <UDashboardNavbar title="Vault">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>

      <div class="space-y-6 p-6 lg:p-8">
        <div class="flex flex-wrap items-end justify-between gap-2">
          <div>
            <p class="text-muted text-sm">
              Encrypted secrets for SSH keys and API tokens — write-only, never displayed again
            </p>
          </div>
          <div class="flex items-center gap-2">
            <UButton
              icon="i-lucide-folder"
              label="Folders"
              color="neutral"
              variant="outline"
              @click="folderManagerOpen = true"
            />
          </div>
        </div>

        <VaultSecretsManager v-model:folder-id="activeFolder" @deleted="onFolderDeleted" />
      </div>

      <VaultFoldersManager v-model:open="folderManagerOpen" @deleted="onFolderDeleted" />
    </template>
  </UDashboardPanel>
</template>
