<script setup lang="ts">
// Self-contained projects manager: tree table, client-side search (projects
// are nestable, so the full list must stay client-side for tree assembly),
// create/edit editor and delete confirm. The page renders the shell.
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { watchDebounced } from '@vueuse/core';
// Projects: nestable containers for tasks. Mobile-first: stacked tree cards,
// desktop table; create/edit modal follows the #footer submit law.
import { computed, reactive, ref, unref } from 'vue';

import { CHANGE_RESOURCE, PROJECT_STATUS, type ProjectStatus } from '#shared/enums';
import type { ProjectRow } from '~/utils/orpc-types';

const { $orpc, $client } = useNuxtApp();
const queryClient = useQueryClient();

const liveQuery = useQuery($orpc.projects.list.queryOptions({ queryKey: [CHANGE_RESOURCE.PROJECTS] }));
const allRows = computed(() => (unref(liveQuery.data) ?? []) as ProjectRow[]);
const search = ref('');
const searchDebounced = ref('');
watchDebounced(
  search,
  (v) => {
    searchDebounced.value = v.trim();
  },
  { debounce: 300 },
);
const rows = computed(() => {
  const q = searchDebounced.value.toLowerCase();
  if (!q) return allRows.value;
  // keep matches and their ancestor chain so the tree stays navigable
  const byId = new Map(allRows.value.map((r) => [r.id, r]));
  const keep = new Set<string>();
  for (const r of allRows.value) {
    if (r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)) {
      let cur: ProjectRow | undefined = r;
      while (cur) {
        keep.add(cur.id);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
    }
  }
  return allRows.value.filter((r) => keep.has(r.id));
});
const busy = ref(false);
const message = ref('');
const editorOpen = ref(false);
const editingId = ref<string | null>(null);
const confirmId = ref<string | null>(null);
const form = reactive({
  name: '',
  description: '',
  prompt: '',
  parentId: '__none__' as string,
  status: PROJECT_STATUS.ACTIVE as ProjectStatus,
});

// nested rows for the tree table (TanStack sub-rows) + a flat walk for mobile
interface FlatRow extends ProjectRow {
  depth: number;
  path: string;
}
function byParentOf(list: ProjectRow[]) {
  const map = new Map<string | null, ProjectRow[]>();
  for (const r of list) {
    const l = map.get(r.parentId) ?? [];
    l.push(r);
    map.set(r.parentId, l);
  }
  for (const l of map.values()) l.sort((a, b) => a.name.localeCompare(b.name));
  return map;
}
const byParent = computed(() => byParentOf(rows.value));

// flat walk with depth + path for indentation; children of collapsed parents
// hidden — EXCEPT while searching: hiding collapsed branches would swallow
// matches under them, so the full filtered tree stays visible/navigable
const collapsed = ref<Set<string>>(new Set());

function toggleCollapse(id: string) {
  const next = new Set(collapsed.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  collapsed.value = next;
}

const hasChildren = (id: string) => (byParent.value.get(id) ?? []).length > 0;

const searchQ = computed(() => searchDebounced.value.toLowerCase());

/** depth+path flat walk; `respectCollapse` hides children of collapsed parents */
function flattenTree(list: ProjectRow[], respectCollapse: boolean): FlatRow[] {
  const map = byParentOf(list);
  const out: FlatRow[] = [];
  const walk = (parent: string | null, depth: number, path: string) => {
    for (const r of map.get(parent) ?? []) {
      const label = depth === 0 ? r.name : `${path} / ${r.name}`;
      out.push({ ...r, depth, path: label });
      if (respectCollapse && collapsed.value.has(r.id)) continue;
      walk(r.id, depth + 1, label);
    }
  };
  walk(null, 0, '');
  return out;
}

// display tree: children of collapsed parents hidden — EXCEPT while searching,
// which would swallow matches under them; the filtered tree stays fully visible
const flat = computed<FlatRow[]>(() => flattenTree(rows.value, !searchQ.value));

// parent picker always walks the FULL tree (no search filter, no collapse) so
// every project stays selectable no matter what the list above is doing
const fullFlat = computed<FlatRow[]>(() => flattenTree(allRows.value, false));

// parent options for the picker: any project except self and its descendants
const parentItems = computed(() => {
  const excluded = new Set<string>();
  if (editingId.value) {
    excluded.add(editingId.value);
    const byParent = byParentOf(allRows.value);
    const walk = (id: string) => {
      for (const c of byParent.get(id) ?? []) {
        excluded.add(c.id);
        walk(c.id);
      }
    };
    walk(editingId.value);
  }
  return [
    { label: 'No parent (top level)', value: '__none__' },
    ...fullFlat.value.filter((r) => !excluded.has(r.id)).map((r) => ({ label: r.path, value: r.id })),
  ];
});

function openEditor(row?: FlatRow) {
  editingId.value = row?.id ?? null;
  form.name = row?.name ?? '';
  form.description = row?.description ?? '';
  form.prompt = row?.prompt ?? '';
  form.parentId = row?.parentId ?? '__none__';
  form.status = row?.status ?? PROJECT_STATUS.ACTIVE;
  message.value = '';
  editorOpen.value = true;
}

async function save() {
  busy.value = true;
  message.value = '';
  try {
    const payload = {
      name: form.name,
      description: form.description,
      prompt: form.prompt,
      parentId: form.parentId === '__none__' ? null : form.parentId,
      ...(editingId.value ? { status: form.status } : {}),
    };
    if (editingId.value) await $client.projects.update({ id: editingId.value, ...payload });
    else await $client.projects.create(payload);
    editorOpen.value = false;
  } catch (e) {
    message.value = e instanceof Error ? e.message : 'Save failed.';
  } finally {
    busy.value = false;
  }
}

async function askRemove(row: FlatRow) {
  confirmId.value = row.id;
}

async function remove_() {
  if (!confirmId.value) return;
  busy.value = true;
  try {
    await $client.projects.remove({ id: confirmId.value });
    confirmId.value = null;
  } catch (e) {
    // close the confirm so the page-level message isn't hidden behind the modal
    confirmId.value = null;
    message.value = e instanceof Error ? e.message : 'Delete failed.';
  } finally {
    busy.value = false;
  }
}

const statusColor = (s: string) => (s === PROJECT_STATUS.ARCHIVED ? 'neutral' : 'success');
const STATUS_LABELS: Record<string, string> = {
  [PROJECT_STATUS.ACTIVE]: 'Active',
  [PROJECT_STATUS.ARCHIVED]: 'Archived',
};
const statusLabel = (s: string) => STATUS_LABELS[s] ?? s;

// the search box is pointless over an empty, unfiltered list — hide it there
const isFiltered = computed(() => !!searchDebounced.value);

onServerPrefetch(() => liveQuery.suspense());
</script>

<template>
  <div>
    <!-- ONE toolbar row: search left, every action right -->
    <div class="flex flex-wrap items-center gap-2">
      <UInput
        v-if="allRows.length || search"
        v-model="search"
        icon="i-lucide-search"
        placeholder="Search projects…"
        size="sm"
        class="w-full sm:max-w-xs"
        aria-label="Search projects"
      />
      <div class="ms-auto flex items-center gap-2 overflow-x-auto">
        <UButton icon="i-lucide-plus" label="New project" size="sm" @click="openEditor()" />
      </div>
    </div>

    <p v-if="message && !editorOpen" role="alert" class="text-error mt-3 text-sm">{{ message }}</p>

    <DataTable
      class="mt-3"
      :data="flat"
      :loading="liveQuery.isPending.value"
      :columns="[
        { accessorKey: 'name', header: 'Project' },
        { accessorKey: 'status', header: 'Status' },
        { accessorKey: 'actions', header: '' },
      ]"
      show-empty-state
      :empty-icon="isFiltered ? 'i-lucide-search-x' : 'i-lucide-folder-tree'"
      :empty-text="isFiltered ? 'No results — try a different search.' : 'No projects yet — create your first one.'"
    >
      <template #empty-cta>
        <UButton v-if="!isFiltered" icon="i-lucide-plus" label="New project" @click="openEditor()" />
      </template>
      <template #name-cell="{ row }">
        <div class="flex min-w-0 items-center gap-1.5" :style="{ paddingLeft: `${row.original.depth * 1.25}rem` }">
          <UButton
            v-if="hasChildren(row.original.id)"
            :icon="collapsed.has(row.original.id) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'"
            variant="ghost"
            color="neutral"
            size="xs"
            :aria-label="collapsed.has(row.original.id) ? 'Expand' : 'Collapse'"
            class="px-0.5"
            @click="toggleCollapse(row.original.id)"
          />
          <div class="min-w-0">
            <p class="text-highlighted truncate font-medium">{{ row.original.name }}</p>
            <p v-if="row.original.description" class="text-dimmed truncate text-xs">
              {{ row.original.description }}
            </p>
          </div>
        </div>
      </template>
      <template #status-cell="{ row }">
        <UBadge :color="statusColor(row.original.status)" variant="subtle" size="sm">{{
          statusLabel(row.original.status)
        }}</UBadge>
      </template>
      <template #actions-cell="{ row }">
        <div class="row-actions flex justify-end gap-1 transition-opacity">
          <UPopover mode="hover" enable-touch>
            <UButton
              icon="i-lucide-plus"
              variant="ghost"
              color="neutral"
              size="xs"
              aria-label="Add subproject"
              @click="
                openEditor(undefined);
                form.parentId = row.original.id;
              "
            />
            <template #content>
              <div class="px-3 py-1.5 text-xs">Add subproject</div>
            </template>
          </UPopover>
          <UPopover mode="hover" enable-touch>
            <UButton
              icon="i-lucide-pencil"
              variant="ghost"
              color="neutral"
              size="xs"
              aria-label="Edit project"
              @click="openEditor(row.original)"
            />
            <template #content>
              <div class="px-3 py-1.5 text-xs">Edit project</div>
            </template>
          </UPopover>
          <UPopover mode="hover" enable-touch>
            <UButton
              icon="i-lucide-trash-2"
              variant="ghost"
              color="neutral"
              size="xs"
              class="text-muted hover:text-error"
              aria-label="Delete project"
              :disabled="busy"
              @click="askRemove(row.original)"
            />
            <template #content>
              <div class="px-3 py-1.5 text-xs">Delete project</div>
            </template>
          </UPopover>
        </div>
      </template>
      <template #mobile-item="{ row }">
        <UCard :ui="{ root: 'shadow-sm' }" :class="row.depth > 0 ? 'ml-4' : ''">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="text-highlighted truncate text-sm font-medium">
                <UIcon v-if="row.depth > 0" name="i-lucide-corner-down-right" class="text-dimmed mr-1 size-3.5" />
                {{ row.name }}
              </p>
              <p v-if="row.description" class="text-muted mt-0.5 line-clamp-2 text-xs">{{ row.description }}</p>
            </div>
            <UBadge :color="statusColor(row.status)" variant="subtle" size="sm">{{ statusLabel(row.status) }}</UBadge>
          </div>
          <div class="mt-3 flex justify-end gap-1">
            <UPopover mode="hover" enable-touch>
              <UButton
                icon="i-lucide-plus"
                variant="ghost"
                color="neutral"
                size="sm"
                aria-label="Add subproject"
                @click="
                  openEditor(undefined);
                  form.parentId = row.id;
                "
              />
              <template #content>
                <div class="px-3 py-1.5 text-xs">Add subproject</div>
              </template>
            </UPopover>
            <UPopover mode="hover" enable-touch>
              <UButton
                icon="i-lucide-pencil"
                variant="ghost"
                color="neutral"
                size="sm"
                aria-label="Edit project"
                @click="openEditor(row)"
              />
              <template #content>
                <div class="px-3 py-1.5 text-xs">Edit project</div>
              </template>
            </UPopover>
            <UPopover mode="hover" enable-touch>
              <UButton
                icon="i-lucide-trash-2"
                variant="ghost"
                color="neutral"
                size="sm"
                class="text-muted hover:text-error"
                aria-label="Delete project"
                :disabled="busy"
                @click="askRemove(row)"
              />
              <template #content>
                <div class="px-3 py-1.5 text-xs">Delete project</div>
              </template>
            </UPopover>
          </div>
        </UCard>
      </template>
    </DataTable>

    <!-- editor modal -->
    <UModal
      v-model:open="editorOpen"
      :title="editingId ? 'Edit project' : 'New project'"
      :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }"
    >
      <template #body>
        <UForm id="project-editor-form" :state="form" class="space-y-4" @submit="save">
          <UFormField label="Name" name="name">
            <UInput v-model="form.name" icon="i-lucide-folder" placeholder="Project name" class="w-full" required />
          </UFormField>
          <UFormField name="parentId">
            <template #label>
              Parent
              <FormHint text="Nest this project under another" />
            </template>
            <USelectMenu
              v-model="form.parentId"
              :items="parentItems"
              value-key="value"
              :search-input="{ placeholder: 'Search projects' }"
              icon="i-lucide-folder-tree"
              placeholder="No parent (top level)"
              class="w-full"
            />
          </UFormField>
          <UFormField v-if="editingId" label="Status" name="status">
            <USelect
              v-model="form.status"
              :items="[
                { label: 'Active', value: PROJECT_STATUS.ACTIVE },
                { label: 'Archived', value: PROJECT_STATUS.ARCHIVED },
              ]"
              value-key="value"
              icon="i-lucide-circle-dot"
              class="w-full"
            />
          </UFormField>
          <UFormField label="Description" name="description">
            <UTextarea v-model="form.description" placeholder="What this project is about" :rows="3" class="w-full" />
          </UFormField>
          <UFormField name="prompt">
            <template #label>
              Project prompt
              <FormHint text="Added to every agent brief of this project's tasks (empty = omitted)" />
            </template>
            <UTextarea
              v-model="form.prompt"
              placeholder="e.g. This project integrates FedEx/UPS APIs into a NestJS checkout. Never store raw API keys in the repo…"
              :rows="5"
              class="w-full"
            />
          </UFormField>
          <p v-if="message" role="alert" class="text-error text-sm">{{ message }}</p>
        </UForm>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" label="Cancel" :disabled="busy" @click="editorOpen = false" />
          <UButton
            type="submit"
            :loading="busy"
            :label="editingId ? 'Save changes' : 'Create project'"
            form="project-editor-form"
          />
        </div>
      </template>
    </UModal>

    <!-- delete confirm -->
    <UModal
      :open="confirmId !== null"
      title="Delete project"
      @update:open="
        (v: boolean) => {
          if (!v) confirmId = null;
        }
      "
    >
      <template #body>
        <p class="text-muted text-sm">
          Delete this project? Its tasks become unscoped and subprojects move to the top level.
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" label="Cancel" @click="confirmId = null" />
          <UButton color="error" label="Delete" :loading="busy" @click="remove_()" />
        </div>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
/* desktop hover-reveal for row actions — always visible on touch/mobile */
@media (min-width: 768px) and (hover: hover) {
  :deep(tbody tr:not(:hover):not(:focus-within)) .row-actions {
    opacity: 0;
  }
}
</style>
