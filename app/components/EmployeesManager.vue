<script setup lang="ts">
// Self-contained employees manager: server-paged + searched list
// (employees.listPaged), the environment-name map for the table column, the
// List/Graph view toggle, the delete confirm, and composition of the org
// graph, titles manager, keys drawer and create/edit editor.
import { useMutation, useQuery, keepPreviousData } from '@tanstack/vue-query';
import { watchDebounced } from '@vueuse/core';
import { computed, ref, watch } from 'vue';

import { CHANGE_RESOURCE } from '#shared/enums';
import type { EmployeeRow, EnvironmentRow } from '~/utils/orpc-types';

const { $orpc } = useNuxtApp();

const page = ref(1);
const pageSize = ref(20);
const search = ref('');
const searchDebounced = ref('');
watchDebounced(
  search,
  (v) => {
    searchDebounced.value = v.trim();
    page.value = 1;
  },
  { debounce: 300, maxWait: 1000 },
);

// server-side pagination: rows come pre-searched from the API (name/email/title)
const listQuery = useQuery(
  computed(() =>
    $orpc.employees.listPaged.queryOptions({
      input: { page: page.value, pageSize: pageSize.value, q: searchDebounced.value || undefined },
      queryKey: [CHANGE_RESOURCE.EMPLOYEES, 'paged', page.value, pageSize.value, searchDebounced.value],
      placeholderData: keepPreviousData,
    }),
  ),
);
const rows = computed<EmployeeRow[]>(() => listQuery.data.value?.employees ?? []);
const total = computed(() => listQuery.data.value?.total ?? 0);
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));

// deleting the last row of a high page clamps back into range — skip transient totals
watch(total, (t) => {
  if (!t) return;
  const maxPage = Math.max(1, Math.ceil(t / pageSize.value));
  if (page.value > maxPage) page.value = maxPage;
});

// environment names for the table column (AI rows carry only the id)
const envQuery = useQuery($orpc.environments.list.queryOptions({ queryKey: [CHANGE_RESOURCE.ENVIRONMENTS] }));
const environments = computed<EnvironmentRow[]>(() => (unref(envQuery.data) ?? []) as EnvironmentRow[]);
const envName = (id: string | null) => environments.value.find((e) => e.id === id)?.name ?? null;

// graph, editor supervisor options and name badges need EVERY employee — a
// chart or a picker can't be paged; only the table rides listPaged
const allQuery = useQuery($orpc.employees.list.queryOptions({ queryKey: [CHANGE_RESOURCE.EMPLOYEES] }));
const allEmployees = computed<EmployeeRow[]>(() => (unref(allQuery.data) ?? []) as EmployeeRow[]);
const byId = computed(() => new Map(allEmployees.value.map((r) => [r.id, r])));

// ---- view toggle ----
const view = ref<'list' | 'graph'>('list');

const removeMutation = useMutation($orpc.employees.remove.mutationOptions());

const busy = ref(false);
const message = ref('');
const pendingDelete = ref<EmployeeRow | null>(null);
const deleteOpen = computed({
  get: () => pendingDelete.value !== null,
  set: (v: boolean) => {
    if (!v) pendingDelete.value = null;
  },
});

function askRemove(row: EmployeeRow) {
  pendingDelete.value = row;
}

async function remove() {
  if (!pendingDelete.value) return;
  busy.value = true;
  try {
    await removeMutation.mutateAsync({ id: pendingDelete.value.id });
    pendingDelete.value = null;
  } catch (e) {
    pendingDelete.value = null;
    message.value = e instanceof Error ? e.message : 'delete failed';
  } finally {
    busy.value = false;
  }
}

// ---- composed controls ----
const titleManagerOpen = ref(false);
const editorOpen = ref(false);
const editingRow = ref<EmployeeRow | null>(null);
function openEditor(row?: EmployeeRow) {
  editingRow.value = row ?? null;
  editorOpen.value = true;
}
const keysOpen = ref(false);
const keysEmployee = ref<EmployeeRow | null>(null);
function openKeys(row: EmployeeRow) {
  keysEmployee.value = row;
  keysOpen.value = true;
}

const columns = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'title', header: 'Title' },
  { accessorKey: 'kind', header: 'Kind' },
  { accessorKey: 'supervisors', header: 'Supervisors' },
  { accessorKey: 'environment', header: 'Environment' },
  { accessorKey: 'actions', header: '' },
];

onServerPrefetch(() => Promise.all([listQuery.suspense(), envQuery.suspense()]));
</script>

<template>
  <div>
    <div class="flex flex-wrap items-end justify-between gap-2">
      <span />
      <div class="flex items-center gap-2">
        <div
          class="inline-flex overflow-hidden rounded-md border border-zinc-300 dark:border-zinc-700"
          role="group"
          aria-label="View"
        >
          <button
            type="button"
            class="px-3 py-1.5 text-sm font-medium transition-colors"
            :class="
              view === 'list'
                ? 'bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-400'
                : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
            "
            aria-label="List view"
            @click="view = 'list'"
          >
            List
          </button>
          <button
            type="button"
            class="border-l border-zinc-300 px-3 py-1.5 text-sm font-medium transition-colors dark:border-zinc-700"
            :class="
              view === 'graph'
                ? 'bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-400'
                : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
            "
            aria-label="Graph view"
            @click="view = 'graph'"
          >
            Graph
          </button>
        </div>
        <UButton
          icon="i-lucide-briefcase"
          label="Titles"
          color="neutral"
          variant="outline"
          @click="titleManagerOpen = true"
        />
        <UButton icon="i-lucide-plus" label="New employee" @click="openEditor()" />
      </div>
    </div>

    <p v-if="message && !editorOpen" class="text-error text-sm">{{ message }}</p>

    <!-- Mobile: stacked cards (list view) -->
    <DataTable
      v-if="view === 'list'"
      v-model:search="search"
      searchable
      search-placeholder="Search employees…"
      :data="rows"
      v-model:page="page"
      :page-count="pageCount"
      :page-size="pageSize"
      :columns="columns"
      show-empty-state
      empty-icon="i-lucide-users"
      empty-text="No employees yet — add the first human or AI teammate."
    >
      <template #name-cell="{ row }">
        <div class="flex items-center gap-2">
          <span class="flex items-center gap-2">
            <img
              v-if="row.original.hasAvatar"
              :src="`/api/employees/${row.original.id}/avatar`"
              :alt="row.original.name"
              class="size-6 shrink-0 rounded-full object-cover"
            />
            <span class="text-sm font-medium text-zinc-900 dark:text-white">{{ row.original.name }}</span>
          </span>
          <span class="truncate font-mono text-xs text-zinc-400">{{ row.original.email }}</span>
        </div>
      </template>
      <template #title-cell="{ row }">
        <span class="text-sm text-zinc-600 dark:text-zinc-300">{{ row.original.title }}</span>
      </template>
      <template #kind-cell="{ row }">
        <UBadge
          :color="row.original.kind === 'ai' ? 'primary' : 'neutral'"
          variant="subtle"
          size="sm"
          :icon="row.original.kind === 'ai' ? 'i-lucide-bot' : 'i-lucide-user'"
        >
          {{ row.original.kind }}
        </UBadge>
      </template>
      <template #supervisors-cell="{ row }">
        <div class="flex flex-wrap gap-1">
          <template v-if="row.original.supervisorIds.length">
            <UBadge v-for="sid in row.original.supervisorIds" :key="sid" color="neutral" variant="soft" size="sm">
              {{ byId.get(sid)?.name ?? sid.slice(0, 8) }}
            </UBadge>
          </template>
          <span v-else class="text-xs text-zinc-400">—</span>
        </div>
      </template>
      <template #environment-cell="{ row }">
        <span v-if="row.original.kind === 'ai' && row.original.environmentId" class="font-mono text-xs text-zinc-500">{{
          envName(row.original.environmentId)
        }}</span>
        <span v-else class="text-xs text-zinc-400">—</span>
      </template>
      <template #actions-cell="{ row }">
        <div class="flex justify-end gap-1">
          <UPopover mode="hover">
            <UButton
              icon="i-lucide-key-round"
              variant="ghost"
              color="neutral"
              size="sm"
              aria-label="Access keys"
              :disabled="busy"
              @click="openKeys(row.original)"
            />
            <template #content>
              <div class="px-3 py-1.5 text-xs">Access keys</div>
            </template>
          </UPopover>
          <UPopover mode="hover">
            <UButton
              icon="i-lucide-pencil"
              variant="ghost"
              color="neutral"
              size="sm"
              aria-label="Edit employee"
              :disabled="busy"
              @click="openEditor(row.original)"
            />
            <template #content>
              <div class="px-3 py-1.5 text-xs">Edit employee</div>
            </template>
          </UPopover>
          <UPopover mode="hover">
            <UButton
              icon="i-lucide-trash-2"
              variant="ghost"
              color="error"
              size="sm"
              aria-label="Delete employee"
              :disabled="busy"
              @click="askRemove(row.original)"
            />
            <template #content>
              <div class="px-3 py-1.5 text-xs">Delete employee</div>
            </template>
          </UPopover>
        </div>
      </template>
      <template #mobile-item="{ row }">
        <UCard :ui="{ root: 'shadow-sm' }">
          <div class="flex items-start justify-between gap-2">
            <div class="flex min-w-0 items-start gap-2">
              <img
                v-if="row.hasAvatar"
                :src="`/api/employees/${row.id}/avatar`"
                :alt="row.name"
                class="size-8 shrink-0 rounded-full object-cover"
              />
              <div class="min-w-0">
                <p class="truncate text-sm font-medium text-zinc-900 dark:text-white">{{ row.name }}</p>
                <p class="truncate font-mono text-xs text-zinc-400">{{ row.email }}</p>
                <p v-if="row.title" class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{{ row.title }}</p>
              </div>
            </div>
            <UBadge
              :color="row.kind === 'ai' ? 'primary' : 'neutral'"
              variant="subtle"
              size="sm"
              :icon="row.kind === 'ai' ? 'i-lucide-bot' : 'i-lucide-user'"
            >
              {{ row.kind }}
            </UBadge>
          </div>
          <div
            v-if="row.supervisorIds.length || (row.kind === 'ai' && row.environmentId)"
            class="mt-2 flex flex-wrap gap-1"
          >
            <UBadge v-for="sid in row.supervisorIds" :key="sid" color="neutral" variant="soft" size="sm">
              {{ byId.get(sid)?.name ?? sid.slice(0, 8) }}
            </UBadge>
            <UBadge
              v-if="row.kind === 'ai' && row.environmentId"
              color="info"
              variant="soft"
              size="sm"
              icon="i-lucide-server"
            >
              {{ envName(row.environmentId) }}
            </UBadge>
          </div>
          <div class="mt-3 flex justify-end gap-1">
            <UPopover mode="hover">
              <UButton
                icon="i-lucide-key-round"
                variant="ghost"
                color="neutral"
                size="sm"
                aria-label="Access keys"
                :disabled="busy"
                @click="openKeys(row)"
              />
              <template #content>
                <div class="px-3 py-1.5 text-xs">Access keys</div>
              </template>
            </UPopover>
            <UPopover mode="hover">
              <UButton
                icon="i-lucide-pencil"
                variant="ghost"
                color="neutral"
                size="sm"
                aria-label="Edit employee"
                :disabled="busy"
                @click="openEditor(row)"
              />
              <template #content>
                <div class="px-3 py-1.5 text-xs">Edit employee</div>
              </template>
            </UPopover>
            <UPopover mode="hover">
              <UButton
                icon="i-lucide-trash-2"
                variant="ghost"
                color="error"
                size="sm"
                aria-label="Delete employee"
                :disabled="busy"
                @click="askRemove(row)"
              />
              <template #content>
                <div class="px-3 py-1.5 text-xs">Delete employee</div>
              </template>
            </UPopover>
          </div>
        </UCard>
      </template>
    </DataTable>

    <!-- graph view: supervision hierarchy -->
    <EmployeeOrgGraph v-if="view === 'graph'" :rows="allEmployees" />

    <UModal v-model:open="deleteOpen" title="Delete employee" :ui="{ content: 'max-w-sm' }">
      <template #body>
        <div class="space-y-4">
          <p class="text-sm text-zinc-600 dark:text-zinc-300">
            Delete <span class="font-semibold text-zinc-900 dark:text-white">{{ pendingDelete?.name }}</span> ({{
              pendingDelete?.email
            }})? Their login, supervision links, API keys{{ pendingDelete?.kind === 'ai' ? ', and AI extension' : '' }}
            are removed permanently.
          </p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" label="Cancel" @click="pendingDelete = null" />
          <UButton icon="i-lucide-trash-2" color="error" label="Delete" :loading="busy" @click="remove" />
        </div>
      </template>
    </UModal>

    <EmployeeTitlesManager v-model:open="titleManagerOpen" />
    <EmployeeEditorModal v-model:open="editorOpen" :employee="editingRow" :rows="allEmployees" />
    <EmployeeKeysDrawer v-model:open="keysOpen" :employee="keysEmployee" />
  </div>
</template>
