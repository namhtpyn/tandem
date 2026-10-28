<script setup lang="ts">
// Self-contained vault folders manager: owns its paged query, search,
// save/remove mutations and the stacked editor + delete-confirm modals. The
// parent only toggles open. Deleting emits `deleted` so parents can drop the
// folder from their own state (e.g. an active filter).
import { useMutation, useQuery, keepPreviousData } from '@tanstack/vue-query';
import { watchDebounced } from '@vueuse/core';
import { computed, ref, watch } from 'vue';
import { z } from 'zod';

import { CHANGE_RESOURCE } from '#shared/enums';
import { saveFailed } from '~/utils/forms';
import type { FolderRow } from '~/utils/orpc-types';
import { TABLE_PAGE_SIZE } from '~/utils/pagination';

const open = defineModel<boolean>('open', { default: false });
const emit = defineEmits<{ deleted: [id: string] }>();

// editable=false renders a read-only folder browser: no create/rename/delete UI
const { editable = true } = defineProps<{ editable?: boolean }>();

const { $orpc } = useNuxtApp();

const pageSize = ref(TABLE_PAGE_SIZE);
const page = ref(1);
const search = ref('');
const debouncedSearch = ref('');
watchDebounced(
  search,
  (v) => {
    debouncedSearch.value = v.trim();
    page.value = 1;
  },
  { debounce: 300 },
);

// server-side paging + search over folders.listPaged (findManyAndCount);
// keepPreviousData keeps the table steady while the next page loads
const foldersQuery = useQuery(
  computed(() =>
    $orpc.vault.folders.listPaged.queryOptions({
      input: { page: page.value, pageSize: pageSize.value, q: debouncedSearch.value || undefined },
      queryKey: [CHANGE_RESOURCE.VAULT, 'folders-paged', page.value, pageSize.value, debouncedSearch.value],
      placeholderData: keepPreviousData,
      enabled: open.value,
    }),
  ),
);
const folders = computed<FolderRow[]>(() => foldersQuery.data.value?.folders ?? []);
const total = computed(() => foldersQuery.data.value?.total ?? 0);
const columns = [
  { accessorKey: 'name', header: 'Folder' },
  { accessorKey: 'secrets', header: 'Secrets' },
  { id: 'actions', header: 'Actions', meta: { class: { th: 'sr-only' } } },
];
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));

// a delete or a narrowed search can shrink the total below the current page
watch(pageCount, (pc) => {
  if (page.value > pc) page.value = pc;
});

const editorOpen = ref(false);
const editingId = ref<string | null>(null);
const form = ref({ name: '' });
// loose frontend schema (repo law): name presence only
const folderSchema = z.object({ name: z.string().min(1, 'Name is required') });
const busy = ref(false);
const error = ref<string | null>(null);
const removeError = ref<string | null>(null);
// snapshot at ask-time: the row can leave the current page between the click
// and the confirm, and a live lookup would blank the name / delete target
const confirming = ref<{ id: string; name: string } | null>(null);

const saveMutation = useMutation({ ...$orpc.vault.folders.save.mutationOptions() });
const removeMutation = useMutation({ ...$orpc.vault.folders.remove.mutationOptions() });

function openEditor(id?: string) {
  error.value = null;
  editingId.value = id ?? null;
  form.value = { name: folders.value.find((f) => f.id === id)?.name ?? '' };
  editorOpen.value = true;
}

async function saveFolder() {
  // one write at a time — a double-click or stray Enter must not double-create
  if (busy.value) return;
  error.value = null;
  if (!form.value.name.trim()) {
    error.value = 'Name is required';
    return;
  }
  busy.value = true;
  try {
    await saveMutation.mutateAsync({
      ...(editingId.value ? { id: editingId.value } : {}),
      name: form.value.name.trim(),
    });
    editorOpen.value = false;
  } catch (e) {
    error.value = saveFailed(e, 'folder');
  } finally {
    busy.value = false;
  }
}

function askRemove(row: FolderRow) {
  removeError.value = null;
  confirming.value = { id: row.id, name: row.name };
}

async function removeFolder() {
  if (!confirming.value) return;
  const target = confirming.value;
  removeError.value = null;
  busy.value = true;
  try {
    await removeMutation.mutateAsync({ id: target.id });
    confirming.value = null;
    emit('deleted', target.id);
  } catch (e) {
    removeError.value = saveFailed(e, 'folder', 'delete');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div>
    <UModal
      v-model:open="open"
      title="Vault folders"
      :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }"
    >
      <template #body>
        <DataTable
          v-model:search="search"
          v-model:page="page"
          searchable
          search-placeholder="Search folders…"
          :data="folders"
          :loading="foldersQuery.isFetching.value || foldersQuery.isPlaceholderData.value"
          :error="foldersQuery.isError.value"
          @retry="foldersQuery.refetch()"
          :page-count="pageCount"
          :page-size="pageSize"
          :columns="columns"
          mobile-title-key="name"
          show-empty-state
          empty-icon="i-lucide-folder"
          empty-noun="folders"
          empty-text="Create one to categorize secrets."
        >
          <template #empty-cta>
            <UButton v-if="editable" icon="i-lucide-plus" label="New folder" @click="openEditor()" />
          </template>
          <template #secrets-cell="{ row }">
            <span class="text-muted text-xs"
              >{{ row.original.secrets }} {{ row.original.secrets === 1 ? 'secret' : 'secrets' }}</span
            >
          </template>
          <template v-if="editable" #actions-cell="{ row }">
            <div class="row-actions flex justify-end gap-1 transition-opacity">
              <UPopover mode="hover" enable-touch>
                <UButton
                  icon="i-lucide-pencil"
                  size="sm"
                  color="neutral"
                  variant="ghost"
                  :aria-label="`Rename ${row.original.name}`"
                  :disabled="busy"
                  @click="openEditor(row.original.id)"
                />
                <template #content><div class="px-3 py-1.5 text-xs">Rename</div></template>
              </UPopover>
              <UPopover mode="hover" enable-touch>
                <UButton
                  icon="i-lucide-trash-2"
                  size="sm"
                  color="neutral"
                  variant="ghost"
                  class="text-muted hover:text-error"
                  :aria-label="`Delete ${row.original.name}`"
                  :disabled="busy"
                  @click="askRemove(row.original)"
                />
                <template #content><div class="px-3 py-1.5 text-xs">Delete</div></template>
              </UPopover>
            </div>
          </template>
          <template #mobile-item="{ row }">
            <UCard :ui="{ root: 'shadow-sm' }">
              <div class="flex items-center gap-2">
                <UBadge color="neutral" variant="subtle" icon="i-lucide-folder">{{ row.name }}</UBadge>
                <span class="flex-1" />
                <template v-if="editable">
                  <UButton
                    icon="i-lucide-pencil"
                    size="sm"
                    color="neutral"
                    variant="ghost"
                    :aria-label="`Rename ${row.name}`"
                    :disabled="busy"
                    @click="openEditor(row.id)"
                  />
                  <UButton
                    icon="i-lucide-trash-2"
                    size="sm"
                    color="neutral"
                    variant="ghost"
                    class="text-muted hover:text-error"
                    :aria-label="`Delete ${row.name}`"
                    :disabled="busy"
                    @click="askRemove(row)"
                  />
                </template>
              </div>
              <p class="text-muted mt-1 text-xs">{{ row.secrets }} {{ row.secrets === 1 ? 'secret' : 'secrets' }}</p>
            </UCard>
          </template>
        </DataTable>
      </template>
    </UModal>

    <!-- folder editor (stacked on the manager) -->
    <UModal
      v-if="editable"
      v-model:open="editorOpen"
      :title="editingId ? 'Rename folder' : 'New folder'"
      :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }"
    >
      <template #body>
        <UForm id="folder-editor-form" :schema="folderSchema" :state="form" @submit="saveFolder">
          <UFormField label="Name" name="name" required>
            <UInput
              v-model="form.name"
              icon="i-lucide-folder"
              placeholder="e.g. Production keys"
              class="w-full"
              :disabled="busy"
            />
          </UFormField>
          <UAlert
            v-if="error"
            role="alert"
            icon="i-lucide-circle-alert"
            color="error"
            variant="subtle"
            :title="error"
            class="mt-3"
            :ui="{ title: 'text-sm' }"
          />
        </UForm>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="editorOpen = false">Cancel</UButton>
          <UButton
            type="submit"
            form="folder-editor-form"
            icon="i-lucide-check"
            :loading="busy"
            :label="editingId ? 'Save changes' : 'Create folder'"
          />
        </div>
      </template>
    </UModal>

    <!-- folder delete confirm: secrets survive -->
    <UModal
      :open="confirming !== null"
      @update:open="
        (v: boolean) => {
          if (!v) confirming = null;
        }
      "
      title="Delete folder"
    >
      <template #body>
        <p class="text-sm">
          Delete <strong>{{ confirming?.name }}</strong
          >? Secrets in it stay — they just become uncategorized.
        </p>
        <UAlert
          v-if="removeError"
          role="alert"
          icon="i-lucide-circle-alert"
          color="error"
          variant="subtle"
          :title="removeError"
          class="mt-3"
          :ui="{ title: 'text-sm' }"
        />
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="confirming = null">Cancel</UButton>
          <UButton color="error" icon="i-lucide-trash-2" :loading="busy" @click="removeFolder()">Delete</UButton>
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
