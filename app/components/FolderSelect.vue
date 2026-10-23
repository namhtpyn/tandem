<script setup lang="ts">
// Self-loading vault-folder picker: owns its own folders query (same query key
// the SSE invalidation rides), so any page drops it in with v-model — no prop
// drilling. v-model is the folder id, or null for "all folders".
import { useQuery } from '@tanstack/vue-query';
import { computed } from 'vue';

import { CHANGE_RESOURCE } from '#shared/enums';

const model = defineModel<string | null>({ default: null });

const ALL = '__all__'; // USelect forbids '' values (reka throws) — sentinel for "no filter"
const { $orpc } = useNuxtApp();
const foldersQuery = useQuery($orpc.vault.folders.list.queryOptions({ queryKey: [CHANGE_RESOURCE.VAULT, 'folders'] }));
const folders = computed(
  () =>
    (foldersQuery.data.value as { folders: Array<{ id: string; name: string; secrets: number }> } | undefined)
      ?.folders ?? [],
);
const items = computed(() => [
  { label: 'All folders', value: ALL },
  ...folders.value.map((f) => ({ label: `${f.name} (${f.secrets})`, value: f.id })),
]);
const selectModel = computed({
  get: () => model.value ?? ALL,
  set: (v: string) => {
    model.value = v === ALL ? null : v;
  },
});
</script>

<template>
  <USelect v-model="selectModel" :items="items" icon="i-lucide-folder" size="sm" class="w-44" />
</template>
