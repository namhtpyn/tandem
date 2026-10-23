<script setup lang="ts">
// Server-paged vault-folder picker (USelectMenu + infinite scroll, Nuxt UI docs
// pattern): the first page loads on first open, scrolling the menu viewport
// fetches the next. v-model is the folder id (value-key="id") or null when
// cleared. creatable adds the create-item affordance backed by folders.save;
// clearable adds the built-in trailing X (4.4+) that resets the model to null.
import { useMutation, useQuery } from '@tanstack/vue-query';
import { useInfiniteScroll } from '@vueuse/core';
import { computed, onMounted, ref, useTemplateRef, watch } from 'vue';

import { CHANGE_RESOURCE } from '#shared/enums';

type FolderOption = { id: string; name: string; label: string };
type FolderOptionsPage = { options: Array<{ id: string; name: string }>; total: number };

const model = defineModel<string | null>({ default: null });
const { creatable = false, clearable = false } = defineProps<{ creatable?: boolean; clearable?: boolean }>();

const PAGE_SIZE = 50;
const { $orpc } = useNuxtApp();

// pages load through vue-query over the oRPC client and accumulate for the
// infinite scroll — one query per page, keyed so SSE invalidation still hits
const page = ref(1);
const loaded = ref<FolderOption[]>([]);

const pagesQuery = useQuery(
  computed(() =>
    $orpc.vault.folders.options.queryOptions({
      input: { page: page.value, pageSize: PAGE_SIZE },
      queryKey: [CHANGE_RESOURCE.VAULT, 'folder-options', page.value],
    }),
  ),
);

const total = computed(() => (pagesQuery.data.value as FolderOptionsPage | undefined)?.total ?? 0);
const options = computed<FolderOption[]>(() => {
  const d = pagesQuery.data.value as FolderOptionsPage | undefined;
  const mapped = (d?.options ?? []).map((o) => ({ ...o, label: o.name }));
  return page.value === 1 ? mapped : [...loaded.value, ...mapped];
});
const busy = computed(() => pagesQuery.isFetching.value);

// accumulate finished pages so scroll load-more appends instead of replacing
watch(
  () => pagesQuery.data.value,
  (d, prev) => {
    if (!d || page.value === 1) {
      loaded.value = [];
      return;
    }
    if (!prev) return;
    const mapped = d.options.map((o) => ({ ...o, label: o.name }));
    const known = new Set(loaded.value.map((o) => o.id));
    loaded.value = [...loaded.value, ...mapped.filter((o) => !known.has(o.id))];
  },
);

function loadMore() {
  if (busy.value) return;
  if (total.value > 0 && options.value.length >= total.value) return;
  page.value += 1;
}

const selectMenu = useTemplateRef('selectMenu');

onMounted(() => {
  useInfiniteScroll(
    () => selectMenu.value?.viewportRef,
    () => loadMore(),
    {
      canLoadMore: () => !busy.value && (total.value === 0 || options.value.length < total.value),
    },
  );
});

const saveMutation = useMutation({ ...$orpc.vault.folders.save.mutationOptions() });

async function onCreate(name: string) {
  const { id } = await saveMutation.mutateAsync({ name });
  // optimistic: the SSE vault invalidation refetches the option pages
  loaded.value = [...loaded.value, { id, name, label: name }];
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
    @create="onCreate"
    @clear="model = null"
  />
</template>
