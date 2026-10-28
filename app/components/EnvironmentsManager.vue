<script setup lang="ts">
// Self-contained environments manager: paged + searched query (server-side),
// probe, create/edit editor, delete confirm, table + mobile cards. The page
// renders the shell; editable=false hides mutation UI for a read-only browser.
import { useQuery, useMutation, keepPreviousData } from '@tanstack/vue-query';
import { watchDebounced } from '@vueuse/core';
import { z } from 'zod';

import { CHANGE_RESOURCE, SECRET_USAGE, type SecretUsage } from '#shared/enums';
import { NONE_ID, errorMessage } from '~/utils/forms';
import type { EnvironmentRow, VaultSecretRow } from '~/utils/orpc-types';
import type { SecretOption } from '~/utils/vault-options';
import { groupedSecretOptions } from '~/utils/vault-options';

const { editable = true } = defineProps<{ editable?: boolean }>();

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
  { debounce: 300 },
);

const liveQuery = useQuery(
  computed(() =>
    $orpc.environments.listPaged.queryOptions({
      input: { page: page.value, pageSize: pageSize.value, q: searchDebounced.value || undefined },
      queryKey: [CHANGE_RESOURCE.ENVIRONMENTS, 'paged', page.value, pageSize.value, searchDebounced.value],
      placeholderData: keepPreviousData,
    }),
  ),
);
const rows = computed<EnvironmentRow[]>(() => liveQuery.data.value?.environments ?? []);
const total = computed(() => liveQuery.data.value?.total ?? 0);
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));

// deleting the last row of a high page clamps back into range — skip transient totals
watch(total, (t) => {
  if (!t) return;
  const maxPage = Math.max(1, Math.ceil(t / pageSize.value));
  if (page.value > maxPage) page.value = maxPage;
});

// vault secrets for the SSH key picker (metadata only) — a single page caps at
// 100 rows and silently hides the rest of the vault, so walk pages up to `total`
const secretsQuery = useQuery({
  queryKey: [CHANGE_RESOURCE.VAULT, 'all'],
  queryFn: async () => {
    const pageSize = 100;
    const first = await $orpc.vault.secrets.list.call({ page: 1, pageSize });
    const rows = [...first.data];
    const pages = Math.min(3, Math.ceil(first.total / pageSize));
    for (let p = 2; p <= pages; p++) {
      const next = await $orpc.vault.secrets.list.call({ page: p, pageSize });
      rows.push(...next.data);
    }
    return rows;
  },
});
const secrets = computed<VaultSecretRow[]>(() => (unref(secretsQuery.data) ?? []) as VaultSecretRow[]);
const secretOptions = computed<SecretOption[]>(() => [
  { label: 'No key (agent default)', value: NONE_ID },
  ...groupedSecretOptions(secrets.value),
]);

const editorOpen = ref(false);
const editingId = ref<string | null>(null);
// loose frontend schema (repo law): presence + port shape only — the server
// re-validates and owns the real SSH contract
const envSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  host: z.string().min(1, 'Host is required'),
  port: z.coerce
    .number()
    .int('Port must be a whole number between 1 and 65535')
    .min(1, 'Port must be a whole number between 1 and 65535')
    .max(65535, 'Port must be a whole number between 1 and 65535'),
  username: z.string().min(1, 'Username is required'),
  secretId: z.string(),
  secretUsage: z.string(),
});

const form = reactive({
  name: '',
  host: '',
  port: '22',
  username: '',
  secretId: NONE_ID,
  secretUsage: SECRET_USAGE.SSH_KEY as SecretUsage,
});
const busy = ref(false);
const message = ref('');
const probingId = ref<string | null>(null);
const pendingDelete = ref<EnvironmentRow | null>(null);
const deleteOpen = computed({
  get: () => pendingDelete.value !== null,
  set: (v: boolean) => {
    if (!v) pendingDelete.value = null;
  },
});
const probeResults = ref<Record<string, { ok: boolean; detail: string; durationMs: number }>>({});

const createMutation = useMutation($orpc.environments.create.mutationOptions());
const updateMutation = useMutation($orpc.environments.update.mutationOptions());
const removeMutation = useMutation($orpc.environments.remove.mutationOptions());
const probeCall = $orpc.environments.probe.call;

const columns = [
  { accessorKey: 'name', header: 'Name' },
  // connection cell stacks username over host:port — port lives only here
  { accessorKey: 'host', header: 'Connection' },
  { accessorKey: 'probe', header: 'Status' },
  { accessorKey: 'actions', header: '' },
];

function openEditor(row?: EnvironmentRow) {
  editingId.value = row?.id ?? null;
  form.name = row?.name ?? '';
  form.host = row?.host ?? '';
  form.port = row?.port ?? '22';
  form.username = row?.username ?? '';
  form.secretId = row?.secretId ?? NONE_ID;
  form.secretUsage = row?.secretUsage ?? SECRET_USAGE.SSH_KEY;
  message.value = '';
  editorOpen.value = true;
}

async function save() {
  // UForm's schema gate blocks submit on a bad port — no manual pre-check here
  busy.value = true;
  message.value = '';
  try {
    const payload = {
      ...form,
      secretId: form.secretId === NONE_ID ? null : form.secretId,
      secretUsage: form.secretId === NONE_ID ? SECRET_USAGE.SSH_KEY : form.secretUsage,
    };
    if (editingId.value) {
      await updateMutation.mutateAsync({ id: editingId.value, ...payload });
    } else {
      await createMutation.mutateAsync(payload);
    }
    editorOpen.value = false;
  } catch (e) {
    message.value = errorMessage(e, 'Save failed');
  } finally {
    busy.value = false;
  }
  // SSE invalidates [ENVIRONMENTS] — the paged query refetches, no manual invalidation
}

function askRemove(row: EnvironmentRow) {
  pendingDelete.value = row;
}

async function remove() {
  if (!pendingDelete.value) return;
  busy.value = true;
  message.value = '';
  try {
    await removeMutation.mutateAsync({ id: pendingDelete.value.id });
    pendingDelete.value = null;
  } catch (e) {
    pendingDelete.value = null;
    message.value = errorMessage(e, 'Delete failed');
  } finally {
    busy.value = false;
  }
}

async function probe(row: EnvironmentRow) {
  probingId.value = row.id;
  message.value = '';
  try {
    const res = await probeCall({ id: row.id });
    probeResults.value[row.id] = res as { ok: boolean; detail: string; durationMs: number };
  } catch (e) {
    probeResults.value[row.id] = { ok: false, detail: errorMessage(e, 'Probe failed'), durationMs: 0 };
  } finally {
    probingId.value = null;
  }
}

const probeLabel = (ok: boolean) => (ok ? 'OK' : 'Failed');

// the search box is pointless over an empty, unfiltered list — hide it there
const showSearch = computed(() => total.value > 0 || !!search.value);
const isFiltered = computed(() => !!searchDebounced.value);

onServerPrefetch(() => Promise.all([liveQuery.suspense(), secretsQuery.suspense()]));
</script>

<template>
  <div>
    <!-- ONE toolbar row: search left, every action right -->
    <div class="flex flex-wrap items-center gap-2">
      <UInput
        v-if="showSearch"
        v-model="search"
        icon="i-lucide-search"
        placeholder="Search environments…"
        size="sm"
        class="w-full sm:max-w-xs"
        aria-label="Search environments"
      />
      <div class="ms-auto flex items-center gap-2 overflow-x-auto">
        <UButton v-if="editable" icon="i-lucide-plus" label="New environment" size="sm" @click="openEditor()" />
      </div>
    </div>

    <p v-if="message && !editorOpen" role="alert" class="text-error mt-3 text-sm">{{ message }}</p>

    <DataTable
      class="mt-3"
      :data="rows"
      :loading="liveQuery.isPending.value"
      :error="liveQuery.isError.value"
      v-model:page="page"
      :page-count="pageCount"
      :page-size="pageSize"
      :columns="columns"
      show-empty-state
      :empty-icon="isFiltered ? 'i-lucide-search-x' : 'i-lucide-server'"
      :empty-text="
        isFiltered
          ? 'No results — try a different search.'
          : 'No environments yet — add the SSH target where your Hermes agents run.'
      "
    >
      <template #empty-cta>
        <UButton v-if="editable && !isFiltered" icon="i-lucide-plus" label="New environment" @click="openEditor()" />
      </template>
      <template #name-cell="{ row }">
        <span class="text-highlighted text-sm font-medium">{{ row.original.name }}</span>
      </template>
      <template #host-cell="{ row }">
        <!-- stacked mono: 'user' label over host:port, both truncate with the full value on hover -->
        <div class="min-w-0 font-mono text-xs">
          <span class="text-muted block truncate" :title="row.original.username">
            user {{ row.original.username }}
          </span>
          <span class="text-highlighted block truncate" :title="`${row.original.host}:${row.original.port}`">
            {{ row.original.host }}:{{ row.original.port }}
          </span>
        </div>
      </template>
      <template #probe-cell="{ row }">
        <div class="flex items-center gap-2">
          <UBadge
            v-if="probeResults[row.original.id]"
            :color="probeResults[row.original.id]!.ok ? 'success' : 'error'"
            variant="subtle"
            size="sm"
            icon="i-lucide-circle-fill"
          >
            {{ probeLabel(probeResults[row.original.id]!.ok) }}
          </UBadge>
          <UBadge v-else color="neutral" variant="subtle" size="sm" icon="i-lucide-circle-fill">Not probed</UBadge>
          <span
            v-if="probeResults[row.original.id]"
            class="text-dimmed truncate text-xs"
            :title="probeResults[row.original.id]!.detail"
          >
            {{ probeResults[row.original.id]!.detail }} ({{ probeResults[row.original.id]!.durationMs }} ms)
          </span>
        </div>
      </template>
      <template v-if="editable" #actions-cell="{ row }">
        <div class="row-actions flex justify-end gap-1 transition-opacity">
          <UPopover mode="hover" enable-touch>
            <UButton
              icon="i-lucide-plug-zap"
              variant="ghost"
              color="neutral"
              size="sm"
              aria-label="Test connection"
              :loading="probingId === row.original.id"
              :disabled="busy || probingId !== null"
              @click="probe(row.original)"
            />
            <template #content>
              <div class="px-3 py-1.5 text-xs">Test connection</div>
            </template>
          </UPopover>
          <UPopover mode="hover" enable-touch>
            <UButton
              icon="i-lucide-pencil"
              variant="ghost"
              color="neutral"
              size="sm"
              aria-label="Edit environment"
              :disabled="busy"
              @click="openEditor(row.original)"
            />
            <template #content>
              <div class="px-3 py-1.5 text-xs">Edit environment</div>
            </template>
          </UPopover>
          <UPopover mode="hover" enable-touch>
            <UButton
              icon="i-lucide-trash-2"
              variant="ghost"
              color="neutral"
              size="sm"
              class="text-muted hover:text-error"
              aria-label="Delete environment"
              :disabled="busy"
              @click="askRemove(row.original)"
            />
            <template #content>
              <div class="px-3 py-1.5 text-xs">Delete environment</div>
            </template>
          </UPopover>
        </div>
      </template>
      <template #mobile-item="{ row }">
        <UCard :ui="{ root: 'shadow-sm' }">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="text-highlighted truncate text-sm font-medium">{{ row.name }}</p>
              <p class="text-dimmed truncate font-mono text-xs">{{ row.username }}@{{ row.host }}:{{ row.port }}</p>
            </div>
            <div class="flex flex-col items-end gap-1">
              <UBadge
                v-if="probeResults[row.id]"
                :color="probeResults[row.id]!.ok ? 'success' : 'error'"
                variant="subtle"
                size="sm"
              >
                {{ probeLabel(probeResults[row.id]!.ok) }}
              </UBadge>
              <UBadge v-else color="neutral" variant="subtle" size="sm" icon="i-lucide-circle-fill">Not probed</UBadge>
            </div>
          </div>
          <p
            v-if="probeResults[row.id]"
            class="text-dimmed mt-1 truncate text-xs"
            :title="probeResults[row.id]!.detail"
          >
            {{ probeResults[row.id]!.detail }} ({{ probeResults[row.id]!.durationMs }} ms)
          </p>
          <div v-if="editable" class="mt-3 flex justify-end gap-1">
            <UPopover mode="hover" enable-touch>
              <UButton
                icon="i-lucide-plug-zap"
                variant="ghost"
                color="neutral"
                size="sm"
                aria-label="Test connection"
                :loading="probingId === row.id"
                :disabled="busy || probingId !== null"
                @click="probe(row)"
              />
              <template #content>
                <div class="px-3 py-1.5 text-xs">Test connection</div>
              </template>
            </UPopover>
            <UPopover mode="hover" enable-touch>
              <UButton
                icon="i-lucide-pencil"
                variant="ghost"
                color="neutral"
                size="sm"
                aria-label="Edit environment"
                :disabled="busy"
                @click="openEditor(row)"
              />
              <template #content>
                <div class="px-3 py-1.5 text-xs">Edit environment</div>
              </template>
            </UPopover>
            <UPopover mode="hover" enable-touch>
              <UButton
                icon="i-lucide-trash-2"
                variant="ghost"
                color="neutral"
                size="sm"
                class="text-muted hover:text-error"
                aria-label="Delete environment"
                :disabled="busy"
                @click="askRemove(row)"
              />
              <template #content>
                <div class="px-3 py-1.5 text-xs">Delete environment</div>
              </template>
            </UPopover>
          </div>
        </UCard>
      </template>
    </DataTable>

    <UModal v-model:open="deleteOpen" title="Delete environment">
      <template #body>
        <div class="space-y-4">
          <p class="text-muted text-sm">
            Delete environment
            <span class="text-highlighted font-semibold">{{ pendingDelete?.name }}</span> ({{
              pendingDelete?.username
            }}@{{ pendingDelete?.host }})? AI agents configured on it will need reassigning.
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

    <UModal
      v-model:open="editorOpen"
      :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }"
      :title="editingId ? 'Edit environment' : 'New environment'"
    >
      <template #body>
        <UForm id="environment-editor-form" :schema="envSchema" :state="form" class="space-y-4" @submit="save">
          <UFormField name="name">
            <template #label>
              Name
              <FormHint text="Unique label, e.g. ct112-tandem" />
            </template>
            <UInput v-model="form.name" icon="i-lucide-tag" placeholder="Environment name" class="w-full" required />
          </UFormField>
          <UFormField name="host">
            <template #label>
              Host
              <FormHint text="Hostname or IP of the SSH target" />
            </template>
            <UInput v-model="form.host" icon="i-lucide-server" placeholder="Hostname or IP" class="w-full" required />
          </UFormField>
          <UFormField name="port">
            <template #label>
              Port
              <FormHint text="SSH port — 22 unless changed on the host" />
            </template>
            <UInput
              v-model="form.port"
              type="number"
              :min="1"
              :max="65535"
              icon="i-lucide-network"
              placeholder="Port"
              class="w-full"
              required
            />
          </UFormField>
          <UFormField name="username">
            <template #label>
              Username
              <FormHint text="Key or password — the runner connects with whichever this environment uses" />
            </template>
            <UInput v-model="form.username" icon="i-lucide-user" placeholder="SSH username" class="w-full" required />
          </UFormField>
          <UFormField name="secretUsage">
            <template #label>
              Authentication
              <FormHint text="How the SSH connection authenticates" />
            </template>
            <USelect
              v-model="form.secretUsage"
              :items="[
                { label: 'SSH key', value: SECRET_USAGE.SSH_KEY },
                { label: 'Password', value: SECRET_USAGE.PASSWORD },
              ]"
              value-key="value"
              icon="i-lucide-fingerprint"
              class="w-full"
            />
          </UFormField>
          <UFormField name="secretId">
            <template #label>
              Secret
              <FormHint text="Vault secret holding the key or password (optional)" />
            </template>
            <USelectMenu
              v-model="form.secretId"
              :items="secretOptions"
              value-key="value"
              icon="i-lucide-key-round"
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
            :label="editingId ? 'Save changes' : 'Create environment'"
            form="environment-editor-form"
          />
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
