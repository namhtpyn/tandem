<script setup lang="ts" generic="T extends object">
import type { TableColumn } from '@nuxt/ui';
import type { CellContext } from '@tanstack/vue-table';
import { computed, ref, watch } from 'vue';
import type { VNode } from 'vue';

import { formatWhen } from '~/utils/format-when';

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
    /** tree data: rows carry `subRows`; UTable expands them natively */
    getSubRows?: (row: T) => T[];
    /** opt-in built-in empty state (data empty + not loading); parents with their own empty UI leave it off */
    showEmptyState?: boolean;
    /** list query errored — swaps the empty state for retry copy */
    error?: boolean;
    /** the parent declares an active filter/search (search box, chips, folder);
     * falls back to the built-in search box when omitted */
    filtered?: boolean;
    /** built-in pager (default on) — tree lists keep a parent's subtrees on one
     * screen by turning it off */
    pager?: boolean;
    /** background refetch in flight while rows are already on screen (static tables) */
    refreshing?: boolean;
    /** bump to reset the internal pager — search/filter changes, NOT background refetches */
    resetPageKey?: string | number;
    /** no-data branding for the built-in empty state; a live search always shows a no-results line instead */
    emptyIcon?: string;
    /** 'No <noun> yet' headline shape for the built-in empty state */
    emptyNoun?: string;
    emptyText?: string;
  }>(),
  {
    loading: false,
    refreshing: false,
    filtered: undefined,
    pager: true,
    resetPageKey: undefined,
    mobileTitleKey: undefined,
    mobileHideKeys: () => [],
    page: undefined,
    pageCount: undefined,
    pageSize: 10,
    searchable: false,
    searchPlaceholder: 'Search…',
    search: undefined,
    getSubRows: undefined,
    showEmptyState: false,
    emptyIcon: undefined,
    emptyNoun: undefined,
    emptyText: undefined,
  },
);

const emit = defineEmits<{
  'update:page': [page: number];
  'update:search': [q: string];
  /** the list query failed — parents wire this to query.refetch() */
  retry: [];
  /** the built-in no-results CTA — parents clear their search AND chip filters */
  'clear-search': [];
}>();
const paginated = computed(() => props.pageCount !== undefined && props.page !== undefined);
const pagination = computed(() => ({ pageIndex: (props.page ?? 1) - 1, pageSize: props.pageSize }));

// tree data flattens (depth-annotated) for the mobile card list
const mobileRows = computed<T[]>(() => {
  const subRows = props.getSubRows;
  if (!subRows) return props.data;
  const out: T[] = [];
  const walk = (rows: T[], depth: number) => {
    for (const r of rows) {
      out.push({ ...(r as object), depth } as T);
      walk(subRows(r) ?? [], depth + 1);
    }
  };
  walk(props.data, 0);
  return out;
});

// client-side pagination for small lists: internal page state, sliced rows —
// no page/pageCount props needed (server-side lists pass them and slice themselves)
const internalPage = ref(1);
// reset ONLY on a parent-declared dataset change (search/filter). Watching the
// data array identity reset the page on every background refetch, snapping a
// reader on page 3 back to page 1 whenever SSE invalidated the list.
watch(
  () => props.resetPageKey,
  () => {
    internalPage.value = 1;
  },
);
// rows disappearing under the current page (delete, narrow filter) clamp instead
// of stranding an empty page (wired after internalPageCount below)
const internalPageCount = computed(() => Math.max(1, Math.ceil(props.data.length / props.pageSize)));
watch(internalPageCount, (pc) => {
  if (internalPage.value > pc) internalPage.value = pc;
});
const viewData = computed(() =>
  paginated.value || !props.pager
    ? props.data
    : props.data.slice((internalPage.value - 1) * props.pageSize, internalPage.value * props.pageSize),
);
// the mobile card list paginates exactly like the desktop rows (server-side
// lists arrive pre-sliced; client-side lists slice the flattened tree)
const mobileViewRows = computed<T[]>(() =>
  paginated.value || !props.pager
    ? mobileRows.value
    : mobileRows.value.slice((internalPage.value - 1) * props.pageSize, internalPage.value * props.pageSize),
);
// one no-results sentence for every table: a search box, a filter chip and a
// folder filter all land here, so the copy cannot contradict the empty state
const NO_RESULTS_TEXT = 'No matches for the current search or filters.';
const isFiltered = computed(() => props.filtered ?? (props.searchable && !!props.search?.trim()));

const showPager = computed(
  () => props.pager && (paginated.value || props.data.length > props.pageSize) && props.data.length > 0,
);
const displayPage = computed(() => (paginated.value ? (props.page ?? 1) : internalPage.value));
const displayPageCount = computed(() => (paginated.value ? (props.pageCount ?? 1) : internalPageCount.value));
function goPage(p: number) {
  if (paginated.value) emit('update:page', p);
  else internalPage.value = p;
}

// windowed pager: 1 … around-current … last — long page lists (vault, employees)
// must not render every page number
type PageItem = number | 'ellipsis-start' | 'ellipsis-end';
const pageItems = computed<PageItem[]>(() => {
  const total = displayPageCount.value;
  const current = displayPage.value;
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const middle = [current - 1, current, current + 1].filter((p) => p > 1 && p < total);
  const items: PageItem[] = [1];
  if (current > 3) items.push('ellipsis-start');
  items.push(...middle);
  if (current < total - 2) items.push('ellipsis-end');
  items.push(total);
  return items;
});

defineSlots<
  Record<`${string}-cell` | `${string}-header` | (string & {}), (props: CellContext<T, unknown>) => VNode[]> & {
    'mobile-item'?: (props: { row: T }) => VNode[];
    /** toolbar extras: filter chips, action buttons — rendered right of the search box */
    toolbar?: () => VNode[];
    /** built-in empty state CTA — no cell props */
    'empty-cta'?: () => VNode[];
    /** retry affordance rendered under the error copy (wire to the list query's refetch) */
    'error-cta'?: () => VNode[];
    /** first-load skeleton rows for the desktop table (real rows, not a flash) */
    loading?: () => VNode[];
  }
>();

const slots = useSlots();
const DESKTOP_HIDDEN_SLOTS = ['mobile-item', 'toolbar', 'empty-cta', 'error-cta', 'loading'];
const desktopSlotNames = computed(() => Object.keys(slots).filter((n) => !DESKTOP_HIDDEN_SLOTS.includes(n)));

// mobile card title: the mobileTitleKey column when resolvable, else the first
// column — a card without a title line reads as a rendering bug, so there is
// always a first column to render
const titleColumn = computed<TableColumn<T> | undefined>(() => {
  if (props.mobileTitleKey) {
    const named = props.columns.find(
      (c) => ('accessorKey' in c && String(c.accessorKey) === props.mobileTitleKey) || c.id === props.mobileTitleKey,
    );
    if (named) return named;
  }
  return props.columns.find((c) => 'accessorKey' in c && c.accessorKey) ?? props.columns[0];
});
const titleKey = computed(() => {
  const col = titleColumn.value;
  if (!col) return undefined;
  return 'accessorKey' in col && col.accessorKey ? String(col.accessorKey) : (col.id ?? undefined);
});

/** header as display text for the mobile dl — a fn header would print its source */
function headerLabel(col: TableColumn<T>): string {
  if (typeof col.header === 'string') return col.header;
  const key = 'accessorKey' in col ? String(col.accessorKey ?? '') : (col.id ?? '');
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .trim()
    .replace(/^./, (c) => c.toUpperCase());
}

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
  if (raw instanceof Date) return formatWhen(raw);
  if (Array.isArray(raw)) return raw.length ? raw.join(', ') : '—';
  return String(raw);
}
</script>

<template>
  <div v-if="searchable || data.length || loading || error || showEmptyState" class="space-y-3">
    <div v-if="searchable" class="flex flex-wrap items-center gap-2">
      <UInput
        :model-value="search"
        icon="i-lucide-search"
        :placeholder="searchPlaceholder"
        :aria-label="searchPlaceholder.replace('…', '')"
        size="sm"
        class="w-full sm:max-w-xs"
        @update:model-value="(v: string) => emit('update:search', v)"
      />
      <span class="flex-1" />
      <slot name="toolbar" />
    </div>

    <!-- stale rows + a failed refetch: keep the last good data on screen, but
         say so and offer the retry right above it -->
    <div
      v-if="error && data.length"
      role="alert"
      class="border-error/40 bg-error/10 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
    >
      <UIcon name="i-lucide-circle-alert" class="text-error size-4 shrink-0" aria-hidden="true" />
      <span class="text-error flex-1 text-sm">Couldn't refresh this list — showing the last loaded rows.</span>
      <UButton
        size="xs"
        color="error"
        variant="subtle"
        icon="i-lucide-rotate-cw"
        label="Try again"
        @click="emit('retry')"
      />
    </div>

    <!-- static lists keep their rows while a refetch runs: a quiet spinner, no
         skeleton flash -->
    <div v-if="refreshing && !loading" class="flex justify-end" aria-live="polite">
      <span class="text-dimmed flex items-center gap-1.5 text-xs">
        <UIcon name="i-lucide-loader-circle" class="size-3.5 animate-spin" aria-hidden="true" />
        Refreshing
      </span>
    </div>

    <UCard v-if="data.length || loading" :ui="{ root: 'shadow-sm hidden md:block', body: 'p-0 sm:p-0' }">
      <UTable
        :data="viewData"
        :columns="columns"
        :loading="loading"
        :get-sub-rows="getSubRows"
        :pagination="paginated ? pagination : undefined"
        :pagination-options="
          paginated ? { getPaginationRowModel: undefined, manualPagination: true, pageCount } : undefined
        "
      >
        <template v-for="name in desktopSlotNames" :key="name" #[name]="slotProps">
          <slot :name="name" v-bind="slotProps ?? {}" />
        </template>
        <!-- UTable only renders this while there are no rows: a first load (or a
             page switch, keepPreviousData) shows real skeleton rows instead of
             the empty slot or a blank body -->
        <template #loading>
          <slot name="loading">
            <span class="sr-only">Loading…</span>
            <div class="space-y-3" aria-hidden="true">
              <div v-for="i in 5" :key="i" class="flex items-center gap-4">
                <USkeleton class="h-4 w-1/4" />
                <USkeleton class="h-4 flex-1" />
                <USkeleton class="hidden h-4 w-1/6 sm:block" />
                <USkeleton class="size-8 shrink-0 rounded-full" />
              </div>
            </div>
          </slot>
        </template>
      </UTable>
    </UCard>

    <div v-if="!mobileViewRows.length && loading" class="space-y-3 md:hidden" aria-hidden="true">
      <USkeleton v-for="i in 3" :key="i" class="h-20 w-full rounded-lg" />
    </div>
    <div v-if="mobileViewRows.length" class="space-y-3 md:hidden">
      <template v-for="(row, idx) in mobileViewRows" :key="String((row as Record<string, unknown>).id ?? idx)">
        <slot name="mobile-item" :row="row">
          <UCard :ui="{ root: 'shadow-sm' }">
            <p class="text-highlighted truncate text-sm font-medium">
              {{ titleColumn ? cellValue(row, titleColumn) : '' }}
            </p>
            <dl v-if="detailColumns().length" class="mt-2 space-y-1">
              <div v-for="col in detailColumns()" :key="col.id" class="flex items-baseline justify-between gap-3">
                <dt class="text-muted shrink-0 text-xs">{{ headerLabel(col) }}</dt>
                <dd class="text-highlighted min-w-0 truncate text-right text-xs">
                  {{ cellValue(row, col) }}
                </dd>
              </div>
            </dl>
          </UCard>
        </slot>
      </template>
    </div>

    <!-- no-results line for ANY live search over empty rows (independent of
         showEmptyState, per the prop contract); without a filter the opt-in
         empty state renders the parent's no-data branding (icon + text + CTA) -->
    <div
      v-if="!data.length && !loading && (error || isFiltered || showEmptyState)"
      class="flex flex-col items-center justify-center gap-3 py-24 text-center"
    >
      <UIcon
        :name="isFiltered ? 'i-lucide-search-x' : (emptyIcon ?? 'i-lucide-inbox')"
        class="text-toned size-12"
        aria-hidden="true"
      />
      <p class="text-highlighted text-base font-medium">
        {{
          error
            ? "Couldn't load this list"
            : isFiltered
              ? 'No results'
              : emptyNoun
                ? `No ${emptyNoun} yet`
                : 'Nothing here yet'
        }}
      </p>
      <p class="text-muted max-w-sm text-sm">
        {{
          error
            ? 'Check the connection and try again.'
            : isFiltered
              ? NO_RESULTS_TEXT
              : emptyText || 'Use the button above to create one.'
        }}
      </p>
      <template v-if="error">
        <slot name="error-cta">
          <UButton
            size="sm"
            color="neutral"
            variant="outline"
            icon="i-lucide-rotate-cw"
            label="Try again"
            @click="emit('retry')"
          />
        </slot>
      </template>
      <UButton
        v-else-if="isFiltered"
        size="sm"
        color="neutral"
        variant="outline"
        icon="i-lucide-x"
        label="Clear search"
        @click="emit('clear-search')"
      />
      <!-- the create CTA belongs to the EMPTY state only — under the error copy
           it reads as 'create anyway' while the data is simply not loaded -->
      <slot v-else name="empty-cta" />
    </div>

    <!-- pagination footer: prev / numbered / next (UButton — reka UPagination
         click handlers never fire in this app, proven in bd8b5f6) -->
    <nav
      v-if="showPager && displayPageCount > 1"
      aria-label="Pagination"
      class="flex items-center justify-end gap-1 pt-2"
    >
      <UButton
        icon="i-lucide-chevron-left"
        color="neutral"
        variant="outline"
        :disabled="displayPage <= 1"
        aria-label="Previous page"
        @click="goPage(displayPage - 1)"
      />
      <template v-for="p in pageItems" :key="p">
        <span v-if="typeof p === 'string'" class="text-dimmed px-1 text-sm" aria-hidden="true">…</span>
        <UButton
          v-else
          color="neutral"
          :variant="p === displayPage ? 'soft' : 'outline'"
          :class="p === displayPage ? 'text-highlighted' : ''"
          :label="String(p)"
          :aria-label="`Page ${p}`"
          :aria-current="p === displayPage ? 'page' : undefined"
          @click="goPage(p)"
        />
      </template>
      <UButton
        icon="i-lucide-chevron-right"
        color="neutral"
        variant="outline"
        :disabled="displayPage >= displayPageCount"
        aria-label="Next page"
        @click="goPage(displayPage + 1)"
      />
    </nav>
  </div>
</template>
