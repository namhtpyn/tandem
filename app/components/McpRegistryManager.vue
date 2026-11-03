<script setup lang="ts">
// Self-contained MCP registry manager: the admin catalog of MCP servers
// (SPEC "## MCP (registry + per-agent bindings)") — list, create/edit editor,
// delete confirm. The server refuses a remove while bindings exist (400) and
// that message is surfaced verbatim in the confirm. Mirrors the
// VaultSecretsManager list + modal + confirm patterns.
import { useMutation, useQuery } from '@tanstack/vue-query';
import { computed, ref } from 'vue';
import { z } from 'zod';

import { formatWhenShort } from '~/utils/format-when';
import { errorMessage, saveFailed } from '~/utils/forms';

// change-bus resource token the MCP domain publishes under — useChangeEvents
// invalidates [resource] prefixes, so the key must start with it. (Swapped to
// CHANGE_RESOURCE.MCP once the enum gains the entry; the SCREAMING_SNAKE_CASE
// value is stable either way.)
const MCP_RESOURCE = 'MCP';

const { $orpc } = useNuxtApp();

const liveQuery = useQuery($orpc.mcp.registryList.queryOptions({ queryKey: [MCP_RESOURCE, 'registry'] }));
const rows = computed(() => liveQuery.data.value?.data ?? []);

const busy = ref(false);
const removeError = ref<string | null>(null);
const editorOpen = ref(false);
const isEdit = ref(false);
const editingId = ref<string | null>(null);
const form = ref({ name: '', url: '', notes: '' });
// loose frontend schema (repo law): presence + URL shape only — the server
// re-validates strictly (unique name, http/https). UForm blocks submit and
// points at the offending field.
const registrySchema = z.object({
  name: z.string().min(1, 'Name is required'),
  url: z
    .string()
    .min(1, 'URL is required')
    .url('Enter a valid URL')
    .refine((v) => /^https?:\/\//i.test(v), { message: 'Only http/https URLs are supported' }),
  notes: z.string(),
});
const saveError = ref<string | null>(null);

// snapshot at ask-time: resolving the row live from `rows` breaks the confirm
// copy (and the delete target) the moment the list refetches
const confirmingRow = ref<{ id: string; name: string } | null>(null);

const createMutation = useMutation({ ...$orpc.mcp.registryCreate.mutationOptions() });
const updateMutation = useMutation({ ...$orpc.mcp.registryUpdate.mutationOptions() });
const removeMutation = useMutation({ ...$orpc.mcp.registryRemove.mutationOptions() });

function openEditor(row?: { id: string; name: string; url: string; notes: string | null }) {
  saveError.value = null;
  if (row) {
    isEdit.value = true;
    editingId.value = row.id;
    form.value = { name: row.name, url: row.url, notes: row.notes ?? '' };
  } else {
    isEdit.value = false;
    editingId.value = null;
    form.value = { name: '', url: '', notes: '' };
  }
  editorOpen.value = true;
}

async function save() {
  // one write at a time — a double-click or stray Enter must not double-create
  if (busy.value) return;
  saveError.value = null;
  busy.value = true;
  try {
    if (isEdit.value && editingId.value) {
      await updateMutation.mutateAsync({
        id: editingId.value,
        name: form.value.name.trim(),
        url: form.value.url.trim(),
        notes: form.value.notes.trim(),
      });
    } else {
      await createMutation.mutateAsync({
        name: form.value.name.trim(),
        url: form.value.url.trim(),
        notes: form.value.notes.trim(),
      });
    }
    editorOpen.value = false;
  } catch (e) {
    saveError.value = saveFailed(e, 'server');
  } finally {
    busy.value = false;
  }
}

function askRemove(row: { id: string; name: string }) {
  removeError.value = null;
  confirmingRow.value = { id: row.id, name: row.name };
}

async function reallyRemove() {
  if (!confirmingRow.value) return;
  const target = confirmingRow.value;
  removeError.value = null;
  busy.value = true;
  try {
    await removeMutation.mutateAsync({ id: target.id });
    confirmingRow.value = null;
  } catch (e) {
    // in-use guard (SPEC): the server refuses with 400 while bindings exist —
    // its message line is surfaced verbatim so the admin knows to unbind first
    removeError.value = errorMessage(e, saveFailed(e, 'server', 'delete'));
  } finally {
    busy.value = false;
  }
}

onServerPrefetch(() => liveQuery.suspense());
</script>

<template>
  <div>
    <div class="flex flex-wrap items-center gap-2">
      <div class="ms-auto flex items-center gap-2">
        <UButton icon="i-lucide-plus" label="New server" size="sm" @click="openEditor()" />
      </div>
    </div>

    <DataTable
      class="mt-3"
      :data="rows"
      :loading="liveQuery.isPending.value"
      :refreshing="liveQuery.isFetching.value && !liveQuery.isPending.value"
      :error="liveQuery.isError.value"
      @retry="liveQuery.refetch()"
      :columns="[
        { accessorKey: 'name', header: 'Name' },
        { accessorKey: 'url', header: 'URL' },
        { accessorKey: 'notes', header: 'Notes' },
        { accessorKey: 'bindingCount', header: 'Bindings' },
        { accessorKey: 'createdAt', header: 'Created' },
        { id: 'actions', header: 'Actions', meta: { class: { th: 'sr-only' } } },
      ]"
      show-empty-state
      empty-icon="i-lucide-plug"
      empty-noun="servers"
      empty-text="Add the first MCP server — AI employees bind to entries here."
    >
      <template #empty-cta>
        <UButton icon="i-lucide-plus" label="New server" @click="openEditor()" />
      </template>
      <template #url-cell="{ row }">
        <span class="text-dimmed block max-w-64 truncate font-mono text-xs" :title="row.original.url">
          {{ row.original.url }}
        </span>
      </template>
      <template #notes-cell="{ row }">
        <span class="text-muted text-xs">{{ row.original.notes || '—' }}</span>
      </template>
      <template #bindingCount-cell="{ row }">
        <UBadge
          data-testid="mcp-binding-count"
          :color="row.original.bindingCount > 0 ? 'primary' : 'neutral'"
          variant="subtle"
          size="sm"
          :icon="row.original.bindingCount > 0 ? 'i-lucide-link' : undefined"
        >
          {{ row.original.bindingCount }}
        </UBadge>
      </template>
      <template #createdAt-cell="{ row }">
        <span data-allow-mismatch class="text-muted text-xs">{{ formatWhenShort(row.original.createdAt) }}</span>
      </template>
      <template #actions-cell="{ row }">
        <div class="row-actions flex justify-end gap-1 transition-opacity">
          <UPopover mode="hover" enable-touch>
            <UButton
              icon="i-lucide-pencil"
              variant="ghost"
              color="neutral"
              size="sm"
              :aria-label="`Edit ${row.original.name}`"
              :disabled="busy"
              @click="openEditor(row.original)"
            />
            <template #content>
              <div class="px-3 py-1.5 text-xs">Edit server</div>
            </template>
          </UPopover>
          <UPopover mode="hover" enable-touch>
            <UButton
              icon="i-lucide-trash-2"
              variant="ghost"
              color="neutral"
              size="sm"
              class="text-muted hover:text-error"
              :aria-label="`Delete ${row.original.name}`"
              :disabled="busy"
              @click="askRemove(row.original)"
            />
            <template #content>
              <div class="px-3 py-1.5 text-xs">Delete server</div>
            </template>
          </UPopover>
        </div>
      </template>
      <template #mobile-item="{ row }">
        <UCard :ui="{ root: 'shadow-sm' }">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="text-highlighted truncate text-sm font-medium">{{ row.name }}</p>
              <p class="text-dimmed mt-1 truncate font-mono text-xs" :title="row.url">{{ row.url }}</p>
            </div>
            <UBadge :color="row.bindingCount > 0 ? 'primary' : 'neutral'" variant="subtle" size="sm">
              {{ row.bindingCount }}
            </UBadge>
          </div>
          <p v-if="row.notes" class="text-muted mt-1 text-xs">{{ row.notes }}</p>
          <div class="mt-3 flex justify-end gap-3">
            <UPopover mode="hover" enable-touch>
              <UButton
                icon="i-lucide-pencil"
                variant="ghost"
                color="neutral"
                size="sm"
                :aria-label="`Edit ${row.name}`"
                :disabled="busy"
                @click="openEditor(row)"
              />
              <template #content>
                <div class="px-3 py-1.5 text-xs">Edit server</div>
              </template>
            </UPopover>
            <UPopover mode="hover" enable-touch>
              <UButton
                icon="i-lucide-trash-2"
                variant="ghost"
                color="neutral"
                size="sm"
                class="text-muted hover:text-error"
                :aria-label="`Delete ${row.name}`"
                :disabled="busy"
                @click="askRemove(row)"
              />
              <template #content>
                <div class="px-3 py-1.5 text-xs">Delete server</div>
              </template>
            </UPopover>
          </div>
        </UCard>
      </template>
    </DataTable>

    <!-- editor: create / edit -->
    <UModal
      v-model:open="editorOpen"
      :title="isEdit ? 'Edit server' : 'New server'"
      :dismissible="!busy"
      :close="!busy"
      :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }"
    >
      <template #body>
        <UForm id="mcp-registry-form" :schema="registrySchema" :state="form" class="space-y-4" @submit="save">
          <UFormField name="name">
            <template #label> Name </template>
            <template #hint>
              <FormHint text="Must be unique" />
            </template>
            <UInput v-model="form.name" placeholder="Server name" class="w-full" :disabled="busy" />
          </UFormField>
          <UFormField name="url">
            <template #label> URL </template>
            <template #hint>
              <FormHint text="http/https endpoint of the MCP server" />
            </template>
            <UInput
              v-model="form.url"
              icon="i-lucide-link"
              placeholder="https://mcp.example.com/mcp"
              class="w-full"
              :disabled="busy"
              spellcheck="false"
            />
          </UFormField>
          <UFormField name="notes">
            <template #label> Notes </template>
            <template #hint>
              <FormHint text="Optional note" />
            </template>
            <UTextarea v-model="form.notes" placeholder="Notes (optional)" :rows="2" class="w-full" :disabled="busy" />
          </UFormField>
          <UAlert
            v-if="saveError"
            role="alert"
            icon="i-lucide-circle-alert"
            color="error"
            variant="subtle"
            :title="saveError"
          />
        </UForm>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" :disabled="busy" @click="editorOpen = false">Cancel</UButton>
          <UButton
            type="submit"
            form="mcp-registry-form"
            :loading="busy"
            :label="isEdit ? 'Save changes' : 'Create server'"
          />
        </div>
      </template>
    </UModal>

    <!-- delete confirm -->
    <UModal
      :open="confirmingRow !== null"
      title="Delete server"
      :dismissible="!busy"
      :close="!busy"
      @update:open="
        (o: boolean) => {
          if (!o) confirmingRow = null;
        }
      "
    >
      <template #body>
        <p class="text-muted text-sm">
          Delete <span class="text-highlighted font-medium">{{ confirmingRow?.name }}</span
          >? This cannot be undone. A server still bound to AI employees can't be deleted — unbind it first.
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
          <UButton variant="ghost" color="neutral" :disabled="busy" @click="confirmingRow = null">Cancel</UButton>
          <UButton color="error" icon="i-lucide-trash-2" :loading="busy" @click="reallyRemove()">Delete</UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
