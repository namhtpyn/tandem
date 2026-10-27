<script setup lang="ts">
// Self-contained vault secrets manager: owns the paged query (server-side
// folder filter + search), the create/replace editor, the delete confirm and
// the table with mobile cards. The parent owns the folder filter value
// (v-model:folder-id) and reacts to `deleted` (e.g. to clear an active
// filter). editable=false renders a read-only browser.
import { useMutation, useQuery, keepPreviousData } from '@tanstack/vue-query';
import { watchDebounced } from '@vueuse/core';
import { computed, ref, watch } from 'vue';

import { CHANGE_RESOURCE } from '#shared/enums';
import { formatWhen } from '~/utils/format-when';
import type { VaultSecretRow } from '~/utils/orpc-types';

const folderId = defineModel<string | null>('folderId', { default: null });
const emit = defineEmits<{ deleted: [id: string] }>();
const { editable = true } = defineProps<{ editable?: boolean }>();

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

// server-side pagination: rows come pre-filtered by folder from the API
watch(folderId, () => {
  page.value = 1;
});

const liveQuery = useQuery(
  computed(() =>
    $orpc.vault.secrets.list.queryOptions({
      input: {
        page: page.value,
        pageSize: pageSize.value,
        folderId: folderId.value,
        q: searchDebounced.value || undefined,
      },
      queryKey: [CHANGE_RESOURCE.VAULT, page.value, pageSize.value, folderId.value ?? 'all', searchDebounced.value],
      placeholderData: keepPreviousData,
    }),
  ),
);
const rows = computed(() => liveQuery.data.value?.data ?? []);
const total = computed(() => liveQuery.data.value?.total ?? 0);
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));

// deleting the last row of a high page clamps back into range — but only on a REAL
// total: while a page switch is in flight data is undefined (total 0) and clamping
// here would snap the page back to 1 before the fetch lands (the pagination bug)
watch(total, (t) => {
  if (!t) return;
  const maxPage = Math.max(1, Math.ceil(t / pageSize.value));
  if (page.value > maxPage) page.value = maxPage;
});

const busy = ref(false);

const editorOpen = ref(false);
const isEdit = ref(false);
const editingId = ref<string | null>(null);
const form = ref({ name: '', description: '', value: '', folderId: null as string | null });
const formError = ref<string | null>(null);
const showValue = ref(false);

const confirming = ref<string | null>(null);
const confirmingRow = computed(() => rows.value.find((r) => r.id === confirming.value) ?? null);

const createMutation = useMutation({ ...$orpc.vault.secrets.create.mutationOptions() });
const updateMutation = useMutation({ ...$orpc.vault.secrets.update.mutationOptions() });
const removeMutation = useMutation({ ...$orpc.vault.secrets.remove.mutationOptions() });

function openEditor(row?: VaultSecretRow) {
  formError.value = null;
  showValue.value = false;
  if (row) {
    isEdit.value = true;
    editingId.value = row.id;
    form.value = { name: row.name, description: row.description, value: '', folderId: row.folderId ?? null };
  } else {
    isEdit.value = false;
    editingId.value = null;
    form.value = { name: '', description: '', value: '', folderId: null };
  }
  editorOpen.value = true;
}

async function save() {
  formError.value = null;
  if (!form.value.name.trim()) {
    formError.value = 'Name is required';
    return;
  }
  // create needs the secret; edit without a value = metadata-only change (stored secret is kept)
  if (!isEdit.value && !form.value.value) {
    formError.value = 'Value is required (it is stored encrypted and never shown again)';
    return;
  }
  busy.value = true;
  try {
    if (isEdit.value && editingId.value) {
      const payload = {
        id: editingId.value,
        name: form.value.name.trim(),
        description: form.value.description.trim(),
        folderId: form.value.folderId,
        ...(form.value.value ? { value: form.value.value } : {}),
      };
      await updateMutation.mutateAsync(payload);
    } else {
      await createMutation.mutateAsync({
        name: form.value.name.trim(),
        description: form.value.description.trim(),
        value: form.value.value,
        folderId: form.value.folderId,
      });
    }
    editorOpen.value = false;
  } catch (e) {
    formError.value = e instanceof Error ? e.message : 'Save failed';
  } finally {
    busy.value = false;
  }
}

function askRemove(row: VaultSecretRow) {
  confirming.value = row.id;
}

async function reallyRemove(row: VaultSecretRow) {
  confirming.value = null;
  busy.value = true;
  try {
    await removeMutation.mutateAsync({ id: row.id });
    emit('deleted', row.id);
  } finally {
    busy.value = false;
  }
}

onServerPrefetch(() => liveQuery.suspense());
</script>

<template>
  <div>
    <DataTable
      v-model:search="search"
      searchable
      search-placeholder="Search secrets…"
      :data="rows"
      v-model:page="page"
      :page-count="pageCount"
      :page-size="pageSize"
      :columns="[
        { accessorKey: 'name', header: 'Name' },
        { accessorKey: 'description', header: 'Description' },
        { accessorKey: 'lastFour', header: 'Value' },
        { accessorKey: 'updatedAt', header: 'Updated' },
        { id: 'actions', header: '' },
      ]"
    >
      <template #toolbar>
        <VaultFolderSelect v-model="folderId" clearable />
        <span class="flex-1" />
        <UButton v-if="editable" icon="i-lucide-plus" size="sm" label="New secret" @click="openEditor()" />
      </template>
      <template #description-cell="{ row }">
        <span class="text-xs text-zinc-500 dark:text-zinc-400">{{ row.original.description || '—' }}</span>
      </template>
      <template #lastFour-cell="{ row }">
        <span class="font-mono text-xs text-zinc-400">•••• {{ row.original.lastFour }}</span>
      </template>
      <template #updatedAt-cell="{ row }">
        <span suppressHydration-warning class="text-xs text-zinc-500">{{ formatWhen(row.original.updatedAt) }}</span>
      </template>
      <template v-if="editable" #actions-cell="{ row }">
        <div class="flex justify-end gap-1">
          <UPopover mode="hover">
            <UButton
              icon="i-lucide-pencil"
              variant="ghost"
              color="neutral"
              size="sm"
              aria-label="Replace secret"
              :disabled="busy"
              @click="openEditor(row.original)"
            />
            <template #content>
              <div class="px-3 py-1.5 text-xs">Replace secret</div>
            </template>
          </UPopover>
          <UPopover mode="hover">
            <UButton
              icon="i-lucide-trash-2"
              variant="ghost"
              color="error"
              size="sm"
              aria-label="Delete secret"
              :disabled="busy"
              @click="askRemove(row.original)"
            />
            <template #content>
              <div class="px-3 py-1.5 text-xs">Delete secret</div>
            </template>
          </UPopover>
        </div>
      </template>
      <template #mobile-item="{ row }">
        <UCard :ui="{ root: 'shadow-sm' }">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="truncate text-sm font-medium text-zinc-900 dark:text-white">{{ row.name }}</p>
              <p class="mt-1 font-mono text-xs text-zinc-400">•••• {{ row.lastFour }}</p>
            </div>
          </div>
          <p v-if="row.description" class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{{ row.description }}</p>
          <div v-if="editable" class="mt-3 flex justify-end gap-3">
            <UPopover mode="hover">
              <UButton
                icon="i-lucide-pencil"
                variant="ghost"
                color="neutral"
                size="sm"
                aria-label="Replace secret"
                :disabled="busy"
                @click="openEditor(row)"
              />
              <template #content>
                <div class="px-3 py-1.5 text-xs">Replace secret</div>
              </template>
            </UPopover>
            <UPopover mode="hover">
              <UButton
                icon="i-lucide-trash-2"
                variant="ghost"
                color="error"
                size="sm"
                aria-label="Delete secret"
                :disabled="busy"
                @click="askRemove(row)"
              />
              <template #content>
                <div class="px-3 py-1.5 text-xs">Delete secret</div>
              </template>
            </UPopover>
          </div>
        </UCard>
      </template>
    </DataTable>
    <UCard v-if="!rows.length" :ui="{ root: 'shadow-sm' }">
      <template #body>
        <div class="flex flex-col items-center gap-2 py-6 text-center">
          <UIcon name="i-lucide-shield" class="size-8 text-zinc-300 dark:text-zinc-600" />
          <p class="text-sm text-zinc-500">No secrets yet. Store SSH keys and API tokens here — encrypted at rest.</p>
          <UButton v-if="editable" icon="i-lucide-plus" size="sm" class="mt-2" @click="openEditor()"
            >New secret</UButton
          >
        </div>
      </template>
    </UCard>

    <!-- editor: create / replace -->
    <UModal
      v-model:open="editorOpen"
      :title="isEdit ? 'Replace secret' : 'New secret'"
      :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }"
    >
      <template #body>
        <div class="space-y-4">
          <UFormField label="Name" :error="formError && !form.name ? formError : undefined">
            <template #hint><FormHint text="unique" /></template>
            <UInput v-model="form.name" placeholder="Secret name" class="w-full" :disabled="busy" />
          </UFormField>
          <UFormField label="Description">
            <template #hint><FormHint text="optional note" /></template>
            <UTextarea
              v-model="form.description"
              placeholder="Description (optional)"
              :rows="2"
              class="w-full"
              :disabled="busy"
            />
          </UFormField>
          <UFormField label="Folder" name="folder">
            <VaultFolderSelect v-model="form.folderId" creatable clearable size="md" class="w-full" />
          </UFormField>
          <UFormField label="Value" :error="formError && formError !== 'Name is required' ? formError : undefined">
            <template #hint>
              <FormHint :text="isEdit ? 'replaces the stored value' : 'encrypted, never shown again'" />
            </template>
            <div class="relative w-full">
              <UTextarea
                v-model="form.value"
                :placeholder="isEdit ? 'New secret value (leave empty to keep the current one)' : 'Secret value'"
                :rows="4"
                class="w-full"
                :disabled="busy"
                autocomplete="off"
                spellcheck="false"
                :class="showValue ? 'font-mono' : 'secret-masked font-mono'"
              />
              <UPopover mode="hover">
                <UButton
                  :icon="showValue ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                  variant="link"
                  color="neutral"
                  size="sm"
                  :aria-label="showValue ? 'Hide value' : 'Show value'"
                  tabindex="-1"
                  class="absolute top-1 right-1"
                  @click="showValue = !showValue"
                />
                <template #content>
                  <div class="px-3 py-1.5 text-xs">{{ showValue ? 'Hide value' : 'Show value' }}</div>
                </template>
              </UPopover>
            </div>
          </UFormField>
          <UAlert
            v-if="formError && !formError.includes('required')"
            icon="i-lucide-alert-circle"
            color="error"
            variant="subtle"
            :title="formError"
          />
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" :disabled="busy" @click="editorOpen = false">Cancel</UButton>
          <UButton :loading="busy" @click="save">{{ isEdit ? 'Replace' : 'Save' }}</UButton>
        </div>
      </template>
    </UModal>

    <!-- delete confirm -->
    <UModal
      :open="confirming !== null"
      title="Delete secret"
      @update:open="
        (o: boolean) => {
          if (!o) confirming = null;
        }
      "
    >
      <template #body>
        <p class="text-sm text-zinc-600 dark:text-zinc-300">
          Delete <span class="font-medium text-zinc-900 dark:text-white">{{ confirmingRow?.name }}</span
          >? Anything using it (e.g. the SSH runner) will stop working. This cannot be undone.
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="confirming = null">Cancel</UButton>
          <UButton color="error" icon="i-lucide-trash-2" @click="reallyRemove(confirmingRow!)">Delete</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>

<style scoped>
/* mask secret text while the eye toggle is closed (Chromium/WebKit) */
:deep(.secret-masked textarea) {
  -webkit-text-security: disc;
}
</style>
