<script setup lang="ts" generic="T extends object">
import type { TableColumn } from '@nuxt/ui';
import type { CellContext } from '@tanstack/vue-table';
import type { VNode } from 'vue';

const props = withDefaults(
  defineProps<{
    data: T[];
    columns: TableColumn<T>[];
    loading?: boolean;
    mobileTitleKey?: string;
    mobileHideKeys?: string[];
    /** server-side pagination: 1-based page + total pages; omit for unpaginated tables */
    page?: number;
    pageCount?: number;
    pageSize?: number;
    /** toolbar search box; the parent owns the query (server-side) — v-model:search */
    searchable?: boolean;
    searchPlaceholder?: string;
    search?: string;
  }>(),
  {
    loading: false,
    mobileTitleKey: undefined,
    mobileHideKeys: () => [],
    page: undefined,
    pageCount: undefined,
    pageSize: 10,
    searchable: false,
    searchPlaceholder: 'Search…',
    search: undefined,
  },
);

const emit = defineEmits<{ 'update:page': [page: number]; 'update:search': [q: string] }>();
const paginated = computed(() => props.pageCount !== undefined && props.page !== undefined);
const pagination = computed(() => ({ pageIndex: (props.page ?? 1) - 1, pageSize: props.pageSize }));

defineSlots<
  Record<`${string}-cell` | `${string}-header` | (string & {}), (props: CellContext<T, unknown>) => VNode[]> & {
    'mobile-item'?: (props: { row: T }) => VNode[];
    /** toolbar extras: filter chips, action buttons — rendered right of the search box */
    toolbar?: () => VNode[];
  }
>();

const slots = useSlots();
const desktopSlotNames = computed(() => Object.keys(slots).filter((n) => n !== 'mobile-item' && n !== 'toolbar'));

const titleKey = computed(() => {
  if (props.mobileTitleKey) return props.mobileTitleKey;
  const first = props.columns.find((c) => 'accessorKey' in c && c.accessorKey);
  return first && 'accessorKey' in first ? String(first.accessorKey) : undefined;
});

function detailColumns() {
  return props.columns.filter((c) => {
    if (!c.header) return false;
    const key = 'accessorKey' in c ? String(c.accessorKey) : c.id;
    return key && key !== titleKey.value && !props.mobileHideKeys.includes(key);
  });
}

function cellValue(row: T, col: TableColumn<T>) {
  const key = 'accessorKey' in col ? String(col.accessorKey) : (col.id ?? '');
  const raw = (row as Record<string, unknown>)[key];
  if (raw == null || raw === '') return '—';
  if (raw instanceof Date) return raw.toLocaleString();
  if (Array.isArray(raw)) return raw.length ? raw.join(', ') : '—';
  return String(raw);
}
</script>

<template>
  <div v-if="searchable || data.length || loading" class="space-y-3">
    <div v-if="searchable" class="flex flex-wrap items-center gap-2">
      <UInput
        :model-value="search"
        icon="i-lucide-search"
        :placeholder="searchPlaceholder"
        size="sm"
        class="w-full sm:max-w-xs"
        @update:model-value="(v: string) => emit('update:search', v)"
      />
      <span class="flex-1" />
      <slot name="toolbar" />
    </div>

    <UCard v-if="data.length || loading" :ui="{ root: 'shadow-sm hidden md:block', body: 'p-0 sm:p-0' }">
      <UTable
        :data="data"
        :columns="columns"
        :loading="loading"
        :pagination="paginated ? pagination : undefined"
        :pagination-options="
          paginated ? { getPaginationRowModel: undefined, manualPagination: true, pageCount } : undefined
        "
      >
        <template v-for="name in desktopSlotNames" :key="name" #[name]="slotProps">
          <slot :name="name" v-bind="slotProps ?? {}" />
        </template>
      </UTable>
    </UCard>

    <div v-if="data.length" class="space-y-3 md:hidden">
      <template v-for="(row, idx) in data" :key="String((row as Record<string, unknown>).id ?? idx)">
        <slot name="mobile-item" :row="row">
          <UCard :ui="{ root: 'shadow-sm' }">
            <p class="truncate text-sm font-medium text-zinc-900 dark:text-white">
              {{ titleKey ? cellValue(row, { accessorKey: titleKey }) : '' }}
            </p>
            <dl v-if="detailColumns().length" class="mt-2 space-y-1">
              <div v-for="col in detailColumns()" :key="col.id" class="flex items-baseline justify-between gap-3">
                <dt class="shrink-0 text-xs text-zinc-500 dark:text-zinc-400">{{ col.header }}</dt>
                <dd class="min-w-0 truncate text-right text-xs text-zinc-900 dark:text-white">
                  {{ cellValue(row, col) }}
                </dd>
              </div>
            </dl>
          </UCard>
        </slot>
      </template>
    </div>
  </div>
</template>
