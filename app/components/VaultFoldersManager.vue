<script setup lang="ts">
// Self-contained vault folders manager: owns its paged query, search,
// save/remove mutations and the stacked editor + delete-confirm modals. The
// parent only toggles open. Deleting emits `deleted` so parents can drop the
// folder from their own state (e.g. an active filter).
import { useMutation, useQuery, keepPreviousData } from '@tanstack/vue-query';
import { computed, ref, watch } from 'vue';

import { CHANGE_RESOURCE } from '#shared/enums';

const open = defineModel<boolean>('open', { default: false });
const emit = defineEmits<{ deleted: [id: string] }>();

const { $orpc } = useNuxtApp();

const page = ref(1);
const pageSize = ref(10);
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
const foldersPagedQuery = useQuery(
  computed(() =>
    $orpc.vault.folders.listPaged.queryOptions({
      input: {
        page: page.value,
        pageSize: pageSize.value,
        q: searchDebounced.value || undefined,
      },
      queryKey: [
        CHANGE_RESOURCE.VAULT,
        'folders-paged',
        page.value,
        pageSize.value,
        searchDebounced.value,
      ],
    }),
  ),
);
const foldersPaged = computed(() => foldersPagedQuery.data.value?.folders ?? []);
const foldersTotal = computed(() => foldersPagedQuery.data.value?.total ?? 0);
const pageCount = computed(() => Math.max(1, Math.ceil(foldersTotal.value / pageSize.value)));

// deleting the last folder of a high page clamps back into range
watch(foldersTotal, (t) => {
  const maxPage = Math.max(1, Math.ceil(t / pageSize.value));
  if (page.value > maxPage) page.value = maxPage;
});

// full list shares the folders.list cache — used for editor prefill + confirm name
const foldersQuery = useQuery($orpc.vault.folders.list.queryOptions({ queryKey: [CHANGE_RESOURCE.VAULT, 'folders'] }));
const folders = computed(
  () =>
    (foldersQuery.data.value as { folders: Array<{ id: string; name: string; secrets: number }> } | undefined)
      ?.folders ?? [],
);

const editorOpen = ref(false);
const editingId = ref<string | null>(null);
const form = ref({ name: '' });
const busy = ref(false);
const error = ref<string | null>(null);
const confirmId = ref<string | null>(null);
const confirming = computed(() => folders.value.find((f) => f.id === confirmId.value) ?? null);

const saveMutation = useMutation({ ...$orpc.vault.folders.save.mutationOptions() });
const removeMutation = useMutation({ ...$orpc.vault.folders.remove.mutationOptions() });

function openEditor(id?: string) {
  error.value = null;
  editingId.value = id ?? null;
  form.value = { name: folders.value.find((f) => f.id === id)?.name ?? '' };
  editorOpen.value = true;
}

async function saveFolder() {
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
    error.value = e instanceof Error ? e.message : 'Save failed';
  } finally {
    busy.value = false;
  }
}

async function removeFolder(id: string) {
  busy.value = true;
  try {
    await removeMutation.mutateAsync({ id });
    confirmId.value = null;
    emit('deleted', id);
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
        <div v-if="error" class="bg-error/10 text-error mb-3 rounded-md px-3 py-2 text-xs">{{ error }}</div>
        <DataTable
          v-model:search="search"
          searchable
          search-placeholder="Search folders…"
          :data="foldersPaged"
          :columns="[
            { accessorKey: 'name', header: 'Folder' },
            { accessorKey: 'secrets', header: 'Secrets' },
            { id: 'actions', header: '' },
          ]"
          mobile-title-key="name"
          v-model:page="page"
          :page-count="pageCount"
          :page-size="pageSize"
        >
          <template #toolbar>
            <UButton icon="i-lucide-plus" size="sm" label="New folder" @click="openEditor()" />
          </template>
          <template #secrets-cell="{ row }">
            <span class="text-xs text-zinc-500"
              >{{ row.original.secrets }} {{ row.original.secrets === 1 ? 'secret' : 'secrets' }}</span
            >
          </template>
          <template #actions-cell="{ row }">
            <div class="flex justify-end gap-1">
              <UPopover mode="hover">
                <UButton
                  icon="i-lucide-pencil"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  aria-label="Rename folder"
                  :disabled="busy"
                  @click="openEditor(row.original.id)"
                />
                <template #content><div class="px-3 py-1.5 text-xs">Rename</div></template>
              </UPopover>
              <UPopover mode="hover">
                <UButton
                  icon="i-lucide-trash-2"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  aria-label="Delete folder"
                  :disabled="busy"
                  @click="confirmId = row.original.id"
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
                <UButton
                  icon="i-lucide-pencil"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  aria-label="Rename folder"
                  @click="openEditor(row.id)"
                />
                <UButton
                  icon="i-lucide-trash-2"
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  aria-label="Delete folder"
                  @click="confirmId = row.id"
                />
              </div>
              <p class="mt-1 text-xs text-zinc-500">{{ row.secrets }} {{ row.secrets === 1 ? 'secret' : 'secrets' }}</p>
            </UCard>
          </template>
        </DataTable>
        <p v-if="!foldersPaged.length" class="py-6 text-center text-sm text-zinc-500">
          No folders yet — create one to categorize secrets.
        </p>
      </template>
      <template #footer>
        <div class="flex w-full items-center justify-end" />
      </template>
    </UModal>

    <!-- folder editor (stacked on the manager) -->
    <UModal
      v-model:open="editorOpen"
      :title="editingId ? 'Rename folder' : 'New folder'"
      :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }"
    >
      <template #body>
        <UFormField label="Name" name="name" required>
          <UInput
            v-model="form.name"
            icon="i-lucide-folder"
            placeholder="e.g. Production keys"
            class="w-full"
            :disabled="busy"
          />
        </UFormField>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="editorOpen = false">Cancel</UButton>
          <UButton icon="i-lucide-check" :loading="busy" @click="saveFolder">Save</UButton>
        </div>
      </template>
    </UModal>

    <!-- folder delete confirm: secrets survive -->
    <UModal
      :open="confirmId !== null"
      @update:open="
        (v: boolean) => {
          if (!v) confirmId = null;
        }
      "
      title="Delete folder"
    >
      <template #body>
        <p class="text-sm">
          Delete <strong>{{ confirming?.name }}</strong
          >? Secrets in it stay — they just become uncategorized.
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="confirmId = null">Cancel</UButton>
          <UButton color="error" icon="i-lucide-trash-2" :loading="busy" @click="removeFolder(confirming!.id)"
            >Delete</UButton
          >
        </div>
      </template>
    </UModal>
  </div>
</template>
