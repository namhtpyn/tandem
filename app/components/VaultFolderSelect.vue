<script setup lang="ts">
// Server-paged vault-folder picker (USelectMenu + infinite scroll, Nuxt UI docs
// pattern): the first page loads on first open, scrolling the menu viewport
// fetches the next. v-model is the folder id (value-key="id") or null when
// cleared. creatable adds the create-item affordance backed by folders.save;
// clearable adds the built-in trailing X (4.4+) that resets the model to null.
import { useMutation } from '@tanstack/vue-query';
import { useInfiniteScroll } from '@vueuse/core';
import { computed, onMounted, ref, useTemplateRef, watch } from 'vue';

type FolderOption = { id: string; name: string; label: string };
type FolderOptionsPage = { options: Array<{ id: string; name: string }>; total: number };

const model = defineModel<string | null>({ default: null });
const { creatable = false, clearable = false } = defineProps<{ creatable?: boolean; clearable?: boolean }>();

const PAGE_SIZE = 50;
const { $orpc } = useNuxtApp();

const page = ref(1);
const total = ref(0);
const options = ref<FolderOption[]>([]);

const fetchQuery = computed(() => ({ data: JSON.stringify({ page: page.value, pageSize: PAGE_SIZE }) }));
const { data, status, execute } = await useLazyFetch<FolderOptionsPage>('/rpc/vault/folders/options', {
  key: 'vault-folder-options',
  query: fetchQuery,
  immediate: false,
});

watch(data, () => {
  if (!data.value) return;
  total.value = data.value.total;
  options.value = [...options.value, ...data.value.options.map((o) => ({ ...o, label: o.name }))];
});

function onOpen() {
  if (!options.value.length) execute();
}

const selectMenu = useTemplateRef('selectMenu');

onMounted(() => {
  useInfiniteScroll(
    () => selectMenu.value?.viewportRef,
    () => {
      page.value += 1;
    },
    {
      canLoadMore: () => status.value !== 'pending' && options.value.length < total.value,
    },
  );
});

const saveMutation = useMutation({ ...$orpc.vault.folders.save.mutationOptions() });

async function onCreate(name: string) {
  const { id } = await saveMutation.mutateAsync({ name });
  total.value += 1;
  options.value = [...options.value, { id, name, label: name }];
  model.value = id;
}

const selectModel = computed({
  get: () => model.value ?? undefined,
  set: (v: string | undefined) => {
    model.value = v ?? null;
  },
});
</script>

<template>
  <USelectMenu
    ref="selectMenu"
    v-model="selectModel"
    :items="options"
    :create-item="creatable"
    :clear="clearable"
    value-key="id"
    icon="i-lucide-folder"
    size="sm"
    placeholder="Folder"
    class="w-44"
    @update:open="onOpen"
    @create="onCreate"
    @clear="model = null"
  />
</template>
