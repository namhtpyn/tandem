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
import { formatWhenShort } from '~/utils/format-when';
import type { VaultSecretRow } from '~/utils/orpc-types';

const folderId = defineModel<string | null>('folderId', { default: null });
const emit = defineEmits<{ deleted: [id: string]; manageFolders: [] }>();
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

// empty-vault detection (zero secrets AND zero folders): the folder filter and
// the Folders manage button have nothing to filter/manage, so the toolbar drops
// them and the empty state below carries the single 'New secret' CTA
const foldersCountQuery = useQuery(
  $orpc.vault.folders.listPaged.queryOptions({
    input: { page: 1, pageSize: 1 },
    queryKey: [CHANGE_RESOURCE.VAULT, 'folders-count'],
  }),
);
const emptyVault = computed(
  () =>
    !liveQuery.isPending.value &&
    total.value === 0 &&
    foldersCountQuery.isSuccess.value &&
    (foldersCountQuery.data.value?.total ?? 0) === 0,
);

// the search box is pointless over an empty, unfiltered list — hide it there
const showSearch = computed(() => total.value > 0 || !!search.value);
const isFiltered = computed(() => !!searchDebounced.value);

// deleting the last row of a high page clamps back into range — but only on a REAL
// total: while a page switch is in flight data is undefined (total 0) and clamping
// here would snap the page back to 1 before the fetch lands (the pagination bug)
watch(total, (t) => {
  if (!t) return;
  const maxPage = Math.max(1, Math.ceil(t / pageSize.value));
  if (page.value > maxPage) page.value = maxPage;
});

const busy = ref(false);
const removeError = ref<string | null>(null);

const editorOpen = ref(false);
const isEdit = ref(false);
const editingId = ref<string | null>(null);
const form = ref({ name: '', description: '', value: '', folderId: null as string | null });
const nameError = ref<string | null>(null);
const valueError = ref<string | null>(null);
const saveError = ref<string | null>(null);
const showValue = ref(false);

const confirming = ref<string | null>(null);
const confirmingRow = computed(() => rows.value.find((r) => r.id === confirming.value) ?? null);

const createMutation = useMutation({ ...$orpc.vault.secrets.create.mutationOptions() });
const updateMutation = useMutation({ ...$orpc.vault.secrets.update.mutationOptions() });
const removeMutation = useMutation({ ...$orpc.vault.secrets.remove.mutationOptions() });

function openEditor(row?: VaultSecretRow) {
  nameError.value = null;
  valueError.value = null;
  saveError.value = null;
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
  nameError.value = null;
  valueError.value = null;
  saveError.value = null;
  if (!form.value.name.trim()) {
    nameError.value = 'Name is required';
    return;
  }
  // create needs the secret; edit without a value = metadata-only change (stored secret is kept)
  if (!isEdit.value && !form.value.value) {
    valueError.value = 'Value is required (it is stored encrypted and never shown again)';
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
    saveError.value = e instanceof Error ? e.message : 'Save failed';
  } finally {
    busy.value = false;
  }
}

function askRemove(row: VaultSecretRow) {
  confirming.value = row.id;
}

async function reallyRemove(row: VaultSecretRow) {
  removeError.value = null;
  busy.value = true;
  try {
    await removeMutation.mutateAsync({ id: row.id });
    confirming.value = null;
    emit('deleted', row.id);
  } catch (e) {
    removeError.value = e instanceof Error ? e.message : 'Delete failed';
  } finally {
    busy.value = false;
  }
}

onServerPrefetch(() => liveQuery.suspense());
</script>

<template>
  <div>
    <!-- ONE toolbar row: search left, filters + actions right -->
    <div class="flex flex-wrap items-center gap-2">
      <UInput
        v-if="showSearch"
        v-model="search"
        icon="i-lucide-search"
        placeholder="Search secrets…"
        size="sm"
        class="w-full sm:max-w-xs"
        aria-label="Search secrets"
      />
      <div class="ms-auto flex items-center gap-2 overflow-x-auto">
        <!-- nothing to filter or manage while the vault is empty — the empty
             state below carries the one 'New secret' CTA -->
        <VaultFolderSelect v-if="!emptyVault" v-model="folderId" clearable aria-label="Filter by folder" />
        <UButton
          v-if="editable && !emptyVault"
          icon="i-lucide-folder"
          label="Folders"
          color="neutral"
          variant="outline"
          size="sm"
          @click="emit('manageFolders')"
        />
        <UButton
          v-if="editable && !emptyVault"
          icon="i-lucide-plus"
          label="New secret"
          size="sm"
          @click="openEditor()"
        />
      </div>
    </div>

    <DataTable
      class="mt-3"
      :data="rows"
      :loading="liveQuery.isPending.value"
      :error="liveQuery.isError.value"
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
      show-empty-state
      :empty-icon="isFiltered ? 'i-lucide-search-x' : 'i-lucide-shield'"
      :empty-text="
        isFiltered
          ? 'No results — try a different search.'
          : 'No secrets yet — store SSH keys and API tokens, encrypted and write-only.'
      "
    >
      <template #empty-cta>
        <UButton v-if="editable && !isFiltered" icon="i-lucide-plus" label="New secret" @click="openEditor()" />
      </template>
      <template #description-cell="{ row }">
        <span class="text-muted text-xs">{{ row.original.description || '—' }}</span>
      </template>
      <template #lastFour-cell="{ row }">
        <span class="text-dimmed font-mono text-xs">•••• {{ row.original.lastFour }}</span>
      </template>
      <template #updatedAt-cell="{ row }">
        <span suppressHydration-warning class="text-muted text-xs">{{ formatWhenShort(row.original.updatedAt) }}</span>
      </template>
      <template v-if="editable" #actions-cell="{ row }">
        <div class="row-actions flex justify-end gap-1 transition-opacity">
          <UPopover mode="hover" enable-touch>
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
          <UPopover mode="hover" enable-touch>
            <UButton
              icon="i-lucide-trash-2"
              variant="ghost"
              color="neutral"
              size="sm"
              class="text-muted hover:text-error"
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
              <p class="text-highlighted truncate text-sm font-medium">{{ row.name }}</p>
              <p class="text-dimmed mt-1 font-mono text-xs">•••• {{ row.lastFour }}</p>
            </div>
          </div>
          <p v-if="row.description" class="text-muted mt-1 text-xs">{{ row.description }}</p>
          <div v-if="editable" class="mt-3 flex justify-end gap-3">
            <UPopover mode="hover" enable-touch>
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
            <UPopover mode="hover" enable-touch>
              <UButton
                icon="i-lucide-trash-2"
                variant="ghost"
                color="neutral"
                size="sm"
                class="text-muted hover:text-error"
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

    <!-- editor: create / replace -->
    <UModal
      v-model:open="editorOpen"
      :title="isEdit ? 'Replace secret' : 'New secret'"
      :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }"
    >
      <template #body>
        <div class="space-y-4">
          <UFormField name="name" :error="nameError ?? undefined">
            <template #label>
              Name
              <FormHint text="Must be unique" />
            </template>
            <UInput v-model="form.name" placeholder="Secret name" class="w-full" :disabled="busy" />
          </UFormField>
          <UFormField name="description">
            <template #label>
              Description
              <FormHint text="Optional note" />
            </template>
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
          <UFormField name="value" :error="valueError ?? undefined">
            <template #label>
              Value
              <FormHint :text="isEdit ? 'Replaces the stored value' : 'Encrypted, never shown again'" />
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
              <UPopover mode="hover" enable-touch>
                <UButton
                  :icon="showValue ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                  variant="link"
                  color="neutral"
                  size="sm"
                  :aria-label="showValue ? 'Hide value' : 'Show value'"
                  class="absolute top-1 right-1"
                  @click="showValue = !showValue"
                />
                <template #content>
                  <div class="px-3 py-1.5 text-xs">{{ showValue ? 'Hide value' : 'Show value' }}</div>
                </template>
              </UPopover>
            </div>
          </UFormField>
          <UAlert v-if="saveError" icon="i-lucide-alert-circle" color="error" variant="subtle" :title="saveError" />
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" :disabled="busy" @click="editorOpen = false">Cancel</UButton>
          <UButton :loading="busy" :label="isEdit ? 'Save changes' : 'Create secret'" @click="save" />
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
        <p class="text-muted text-sm">
          Delete <span class="text-highlighted font-medium">{{ confirmingRow?.name }}</span
          >? Anything using it (e.g. the SSH runner) will stop working. This cannot be undone.
        </p>
        <UAlert
          v-if="removeError"
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
          <UButton
            color="error"
            icon="i-lucide-trash-2"
            :loading="busy"
            @click="confirmingRow && reallyRemove(confirmingRow)"
            >Delete</UButton
          >
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

/* desktop hover-reveal for row actions — always visible on touch/mobile */
@media (min-width: 768px) and (hover: hover) {
  :deep(tbody tr:not(:hover):not(:focus-within)) .row-actions {
    opacity: 0;
  }
}
</style>
