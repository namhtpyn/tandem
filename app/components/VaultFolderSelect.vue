<script setup lang="ts">
// Server-paged vault-folder picker (USelectMenu + useInfiniteScroll, Nuxt UI
// docs pattern) backed by a TanStack infinite query over the oRPC client:
// pages accumulate via getNextPageParam, the menu viewport scroll calls
// fetchNextPage, and the search box feeds the server-side q filter (debounced)
// so typing never depends on what a page happens to hold — client filtering
// is off. v-model is the folder id (value-key="id") or null when cleared.
// creatable adds the create-item affordance backed by folders.save; clearable
// adds the built-in trailing X (4.4+) that resets the model to null.
import { useInfiniteQuery, useMutation } from '@tanstack/vue-query';
import { useInfiniteScroll, watchDebounced } from '@vueuse/core';
import { computed, onMounted, ref, useTemplateRef } from 'vue';

import { CHANGE_RESOURCE } from '#shared/enums';

type FolderOption = { id: string; name: string; label: string };

const model = defineModel<string | null>({ default: null });
const { creatable = false, clearable = false, size = 'sm' } = defineProps<{
  creatable?: boolean;
  clearable?: boolean;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
}>();

const PAGE_SIZE = 20;
const { $orpc } = useNuxtApp();

const searchTerm = ref('');
const debouncedSearch = ref('');
watchDebounced(
  searchTerm,
  (v) => {
    debouncedSearch.value = v.trim();
  },
  { debounce: 300 },
);

const pagesQuery = useInfiniteQuery(
  computed(() =>
    $orpc.vault.folders.options.infiniteOptions({
      input: (page: number) => ({ page, pageSize: PAGE_SIZE, q: debouncedSearch.value || undefined }),
      queryKey: [CHANGE_RESOURCE.VAULT, 'folder-options', debouncedSearch.value],
      initialPageParam: 1,
      getNextPageParam: (lastPage, allPages) => {
        const loaded = allPages.reduce((n, p) => n + p.options.length, 0);
        return loaded < lastPage.total ? allPages.length + 1 : undefined;
      },
    }),
  ),
);

const options = computed<FolderOption[]>(() =>
  (pagesQuery.data.value?.pages ?? []).flatMap((p) => p.options.map((o) => ({ ...o, label: o.name }))),
);

const selectMenu = useTemplateRef('selectMenu');

// fetchNextPage flips isFetchingNextPage only after a tick, so a scroll burst
// can double-fire — this guard flips synchronously inside the handler
const loadingMore = ref(false);

function onLoadMore() {
  if (loadingMore.value || !pagesQuery.hasNextPage.value) return;
  loadingMore.value = true;
  pagesQuery.fetchNextPage().finally(() => {
    loadingMore.value = false;
  });
}

onMounted(() => {
  useInfiniteScroll(
    () => selectMenu.value?.viewportRef,
    () => onLoadMore(),
    { canLoadMore: () => pagesQuery.hasNextPage.value && !loadingMore.value },
  );
});

const saveMutation = useMutation({ ...$orpc.vault.folders.save.mutationOptions() });

async function onCreate(name: string) {
  const { id } = await saveMutation.mutateAsync({ name });
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
    v-model:search-term="searchTerm"
    :items="options"
    :create-item="creatable"
    :clear="clearable"
    ignore-filter
    :loading="pagesQuery.isFetching.value"
    value-key="id"
    icon="i-lucide-folder"
    :size="size"
    placeholder="Folder"
    class="w-44"
    @create="onCreate"
    @clear="model = null"
  >
    <template #content-bottom>
      <div v-if="pagesQuery.isFetchingNextPage.value" class="flex w-full items-center justify-center py-2">
        <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-muted" />
      </div>
    </template>
  </USelectMenu>
</template>
