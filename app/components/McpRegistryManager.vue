<script setup lang="ts">
// Self-contained MCP registry manager: the admin catalog of MCP servers
// (SPEC "## MCP (registry + per-agent bindings)") — list, create/edit editor,
// delete confirm. The server refuses a remove while bindings exist (400) and
// that message is surfaced verbatim in the confirm. Mirrors the
// VaultSecretsManager list + modal + confirm patterns.
import { useMutation, useQuery } from '@tanstack/vue-query';
import { computed, ref, unref } from 'vue';
import { z } from 'zod';

import { CHANGE_RESOURCE } from '#shared/enums';
import { formatWhenShort } from '~/utils/format-when';
import { errorMessage, saveFailed } from '~/utils/forms';
import type { EmployeeRow } from '~/utils/orpc-types';
import type { SecretOption } from '~/utils/vault-options';
import { groupedSecretOptions } from '~/utils/vault-options';

// change-bus resource token the MCP domain publishes under — useChangeEvents
// invalidates [resource] prefixes, so the key must start with it
const MCP_RESOURCE = CHANGE_RESOURCE.MCP;

const { $orpc } = useNuxtApp();

const liveQuery = useQuery($orpc.mcp.registryList.queryOptions({ queryKey: [MCP_RESOURCE, 'registry'] }));
const rows = computed(() => liveQuery.data.value?.data ?? []);

const busy = ref(false);
const removeError = ref<string | null>(null);
const editorOpen = ref(false);
const isEdit = ref(false);
const editingId = ref<string | null>(null);
const form = ref({
  name: '',
  transport: 'http' as 'http' | 'stdio',
  url: '',
  command: '',
  args: '',
  credentialEnvVar: '',
  notes: '',
  authKind: 'none' as 'none' | 'oauth',
  oauthAuthorizeUrl: '',
  oauthTokenUrl: '',
  oauthRevocationUrl: '',
  oauthScopes: '',
  oauthClientId: '',
  oauthClientSecretId: null as string | null,
});
// loose frontend schema (repo law): presence + shape only — the server
// re-validates strictly (unique name, transport-conditional required fields,
// oauth ∩ stdio refusal). UForm blocks submit and points at the offending field.
const registrySchema = z
  .object({
    name: z.string().min(1, 'Name is required'),
    transport: z.enum(['http', 'stdio']),
    url: z.string(),
    command: z.string(),
    args: z.string(),
    credentialEnvVar: z.string().refine((v) => v === '' || /^[A-Za-z_][A-Za-z0-9_]*$/.test(v), {
      message: 'Must be a valid env var name',
    }),
    notes: z.string(),
    authKind: z.enum(['none', 'oauth']),
    // '' allowed — these only carry content for oauth servers (superRefine
    // enforces presence there); empty strings must not block plain creates
    oauthAuthorizeUrl: z
      .string()
      .refine((v) => v === '' || /^https?:\/\//i.test(v), { message: 'Only http/https URLs are supported' }),
    oauthTokenUrl: z
      .string()
      .refine((v) => v === '' || /^https?:\/\//i.test(v), { message: 'Only http/https URLs are supported' }),
    oauthRevocationUrl: z
      .string()
      .refine((v) => v === '' || /^https?:\/\//i.test(v), { message: 'Only http/https URLs are supported' }),
    oauthScopes: z.string(),
    oauthClientId: z.string(),
    oauthClientSecretId: z.string().nullable(),
  })
  .superRefine((v, ctx) => {
    if (v.transport === 'stdio') {
      if (!v.command.trim()) ctx.addIssue({ code: 'custom', path: ['command'], message: 'Required for stdio servers' });
      else if (!v.command.trim().startsWith('/'))
        ctx.addIssue({
          code: 'custom',
          path: ['command'],
          message: 'Must be an absolute path (ACP stdio contract)',
        });
      return;
    }
    if (!v.url.trim()) ctx.addIssue({ code: 'custom', path: ['url'], message: 'URL is required for http servers' });
    else if (!/^https?:\/\//i.test(v.url.trim()))
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'Only http/https URLs are supported' });
    if (v.authKind !== 'oauth') return;
    for (const field of ['oauthAuthorizeUrl', 'oauthTokenUrl', 'oauthClientId'] as const) {
      if (!v[field]) ctx.addIssue({ code: 'custom', path: [field], message: 'Required for OAuth servers' });
    }
  });
const saveError = ref<string | null>(null);

// confidential-client secret select — same vault surface as the binding editor
const secretsLive = useAllVaultSecrets();
const secretItems = computed<SecretOption[]>(() => groupedSecretOptions(secretsLive.data.value ?? []));

// snapshot at ask-time: resolving the row live from `rows` breaks the confirm
// copy (and the delete target) the moment the list refetches
const confirmingRow = ref<{ id: string; name: string } | null>(null);

const createMutation = useMutation({ ...$orpc.mcp.registryCreate.mutationOptions() });
const updateMutation = useMutation({ ...$orpc.mcp.registryUpdate.mutationOptions() });
const removeMutation = useMutation({ ...$orpc.mcp.registryRemove.mutationOptions() });

// switching transport to stdio resets the auth state — the select is locked to
// the static credential for stdio (oauth ∩ stdio is refused server-side) and a
// stale 'oauth' value would leave the OAuth fields visible with input that is
// silently dropped on save
watch(
  () => form.value.transport,
  (t) => {
    if (t === 'stdio' && form.value.authKind !== 'none') {
      form.value.authKind = 'none';
      Object.assign(form.value, emptyOauth());
    }
  },
);

type RegistryRow = {
  id: string;
  name: string;
  transport: string;
  url: string | null;
  command: string | null;
  args: string[];
  credentialEnvVar: string | null;
  notes: string | null;
  authKind: string;
  oauth: {
    authorizeUrl: string | null;
    tokenUrl: string | null;
    revocationUrl: string | null;
    scopes: string | null;
    clientId: string | null;
    clientSecretId: string | null;
    hasClientSecret: boolean;
  };
};

function emptyOauth() {
  return {
    oauthAuthorizeUrl: '',
    oauthTokenUrl: '',
    oauthRevocationUrl: '',
    oauthScopes: '',
    oauthClientId: '',
    oauthClientSecretId: null as string | null,
  };
}

function openEditor(row?: RegistryRow) {
  saveError.value = null;
  if (row) {
    isEdit.value = true;
    editingId.value = row.id;
    form.value = {
      name: row.name,
      transport: row.transport === 'stdio' ? 'stdio' : 'http',
      url: row.url ?? '',
      command: row.command ?? '',
      args: (row.args ?? []).join('\n'),
      credentialEnvVar: row.credentialEnvVar ?? '',
      notes: row.notes ?? '',
      authKind: row.authKind === 'oauth' ? 'oauth' : 'none',
      ...emptyOauth(),
      oauthAuthorizeUrl: row.oauth.authorizeUrl ?? '',
      oauthTokenUrl: row.oauth.tokenUrl ?? '',
      oauthRevocationUrl: row.oauth.revocationUrl ?? '',
      oauthScopes: row.oauth.scopes ?? '',
      oauthClientId: row.oauth.clientId ?? '',
      oauthClientSecretId: row.oauth.clientSecretId ?? null,
    };
  } else {
    isEdit.value = false;
    editingId.value = null;
    form.value = {
      name: '',
      transport: 'http',
      url: '',
      command: '',
      args: '',
      credentialEnvVar: '',
      notes: '',
      authKind: 'none',
      ...emptyOauth(),
    };
  }
  editorOpen.value = true;
}

async function save() {
  // one write at a time — a double-click or stray Enter must not double-create
  if (busy.value) return;
  saveError.value = null;
  busy.value = true;
  const isStdio = form.value.transport === 'stdio';
  // stdio entries carry NO oauth block (server refuses oauth ∩ stdio); the
  // auth select is locked to the static-credential option for them
  const oauthBlock =
    !isStdio && form.value.authKind === 'oauth'
      ? {
          authKind: 'oauth' as const,
          oauthAuthorizeUrl: form.value.oauthAuthorizeUrl.trim() || null,
          oauthTokenUrl: form.value.oauthTokenUrl.trim() || null,
          oauthRevocationUrl: form.value.oauthRevocationUrl.trim() || null,
          oauthScopes: form.value.oauthScopes.trim() || null,
          oauthClientId: form.value.oauthClientId.trim() || null,
          oauthClientSecretId: form.value.oauthClientSecretId,
        }
      : { authKind: 'none' as const };
  // transport-conditional fields: url for http; command + whitespace-separated
  // args + optional credential env var for stdio (transport rides EVERY write)
  const transportBlock = isStdio
    ? {
        transport: 'stdio' as const,
        command: form.value.command.trim(),
        // one argument per line — args ride the wire as a JSON array of strings,
        // so whitespace-splitting would corrupt entries containing spaces
        args: form.value.args
          .split('\n')
          .map((a) => a.trim())
          .filter(Boolean),
        credentialEnvVar: form.value.credentialEnvVar.trim() || null,
      }
    : {
        transport: 'http' as const,
        url: form.value.url.trim(),
      };
  try {
    if (isEdit.value && editingId.value) {
      await updateMutation.mutateAsync({
        id: editingId.value,
        name: form.value.name.trim(),
        notes: form.value.notes.trim(),
        ...transportBlock,
        ...oauthBlock,
      });
    } else {
      await createMutation.mutateAsync({
        name: form.value.name.trim(),
        notes: form.value.notes.trim(),
        ...transportBlock,
        ...oauthBlock,
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

// ---- per-server binding manager (#274, SPEC "Binding surfaces") -----------
// UI parity with the employee editor's MCP section: bind/unbind AI employees
// + set the binding credential straight from the registry row. Same write
// verbs (mcp.bindingsSet / bindingsRemove), one data model — the change bus
// keeps the editor and this surface in sync (writes publish CHANGE_RESOURCE
// MCP; this list is keyed under the same prefix).
type ServerBindingRow = {
  id: string;
  employeeId: string;
  employeeName: string;
  secretId: string | null;
  secretName: string | null;
  lastFour: string | null;
  transport: string;
  authKind: string;
  oauth: { connected: boolean; expiresAt: string | null } | null;
};

const bindingsOpen = ref(false);
const bindingsRow = ref<{ id: string; name: string } | null>(null);
const bindingsError = ref<string | null>(null);
const bindBusy = ref(false);
const newBindEmployeeId = ref<string | null>(null);
const newBindSecretId = ref<string | null>(null);

const bindingsLive = useQuery(
  computed(() => ({
    ...$orpc.mcp.bindingsListByServer.queryOptions({
      input: { serverId: bindingsRow.value?.id ?? '' },
      queryKey: [MCP_RESOURCE, 'bindings', bindingsRow.value?.id ?? ''],
    }),
    enabled: bindingsOpen.value && bindingsRow.value !== null,
  })),
);
const serverBindings = computed<ServerBindingRow[]>(() => unref(bindingsLive.data)?.data ?? []);

// AI-employee picker — employees.list carries every row with kind; only AI
// agents can bind (the server asserts it too), and bound agents drop out
const employeesLive = useQuery($orpc.employees.list.queryOptions({ queryKey: [CHANGE_RESOURCE.EMPLOYEES, 'list'] }));

// a failed/pending bindings read must not back a blind write: the bind form
// only acts on visible rows (the upsert would otherwise mutate a binding the
// admin cannot see); a failed employees read empties the picker too
const bindFormDisabled = computed(
  () => bindBusy.value || unref(bindingsLive.isPending) || unref(bindingsLive.isError) || unref(employeesLive.isError),
);
const bindableEmployeeItems = computed(() =>
  ((unref(employeesLive.data) ?? []) as EmployeeRow[])
    .filter((e) => e.kind === 'ai' && !serverBindings.value.some((b) => b.employeeId === e.id))
    .map((e) => ({ label: e.name, value: e.id })),
);

function openBindings(row: RegistryRow) {
  bindingsRow.value = { id: row.id, name: row.name };
  bindingsError.value = null;
  // a closed modal must not carry armed destructive confirms or a stale
  // connect banner into the next open
  unbindCandidate.value = null;
  clearCandidate.value = null;
  connectError.value = null;
  newBindEmployeeId.value = null;
  newBindSecretId.value = null;
  bindingsOpen.value = true;
}

const bindSetMutation = useMutation({ ...$orpc.mcp.bindingsSet.mutationOptions() });
const bindRemoveMutation = useMutation({ ...$orpc.mcp.bindingsRemove.mutationOptions() });

async function bindAgent() {
  const row = bindingsRow.value;
  const employeeId = newBindEmployeeId.value;
  if (!row || !employeeId || bindBusy.value) return;
  bindingsError.value = null;
  bindBusy.value = true;
  try {
    // upsert (SPEC): re-binding an entry swaps its credential and clears the verdict
    await bindSetMutation.mutateAsync({
      employeeId,
      serverId: row.id,
      ...(newBindSecretId.value ? { secretId: newBindSecretId.value } : {}),
    });
    newBindEmployeeId.value = null;
    newBindSecretId.value = null;
    await bindingsLive.refetch();
  } catch (e) {
    bindingsError.value = errorMessage(e, saveFailed(e, 'server'));
  } finally {
    bindBusy.value = false;
  }
}

async function setCredential(b: ServerBindingRow, secretId: string | null) {
  const row = bindingsRow.value;
  if (!row || bindBusy.value) return;
  bindingsError.value = null;
  bindBusy.value = true;
  try {
    // explicit null CLEARS the credential (router: secretId is id|null)
    await bindSetMutation.mutateAsync({ employeeId: b.employeeId, serverId: row.id, secretId });
    clearCandidate.value = null;
    await bindingsLive.refetch();
  } catch (e) {
    bindingsError.value = errorMessage(e, saveFailed(e, 'server'));
  } finally {
    bindBusy.value = false;
  }
}

// clearing a credential is destructive (bearer binding falls back to anonymous
// requests + the probe verdict wipes) — the clear rides the same two-step
// confirm as unbind; picking a DIFFERENT secret applies straight away (that
// swap is this surface's whole point — minimal steps)
const clearCandidate = ref<ServerBindingRow | null>(null);

function askClearCredential(b: ServerBindingRow) {
  bindingsError.value = null;
  clearCandidate.value = b;
}

// oauth connect: the shared popup-mint composable — same flow as the editor
const {
  connectingServerId,
  connectingKey,
  connectError,
  connectOauth: startOauthConnect,
} = useMcpOauthConnect(async () => {
  await bindingsLive.refetch();
});

// the composable keys the in-flight mint by `employeeId:serverId` — per-row
// spinner (a server bound to two oauth agents must not spin both buttons)
function connectingRow(b: ServerBindingRow) {
  return connectingKey.value === `${b.employeeId}:${bindingsRow.value?.id}`;
}

function connectOauth(b: ServerBindingRow) {
  const row = bindingsRow.value;
  if (!row) return;
  bindingsError.value = null;
  startOauthConnect(b.employeeId, row.id);
}

async function unbind(b: ServerBindingRow) {
  const row = bindingsRow.value;
  if (!row || bindBusy.value) return;
  bindingsError.value = null;
  bindBusy.value = true;
  try {
    await bindRemoveMutation.mutateAsync({ employeeId: b.employeeId, serverId: row.id });
    unbindCandidate.value = null;
    await bindingsLive.refetch();
  } catch (e) {
    bindingsError.value = errorMessage(e, saveFailed(e, 'server'));
  } finally {
    bindBusy.value = false;
  }
}

// unbind rides a two-step confirm (parity with the editor's MCP section): on an
// oauth binding it best-effort REVOKES the provider tokens — irreversible
const unbindCandidate = ref<ServerBindingRow | null>(null);

function askUnbind(b: ServerBindingRow) {
  bindingsError.value = null;
  unbindCandidate.value = b;
}
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
        { accessorKey: 'url', header: 'Target' },
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
      <template #name-cell="{ row }">
        <span class="flex items-center gap-2">
          <span class="text-highlighted text-sm font-medium">{{ row.original.name }}</span>
          <UBadge
            v-if="row.original.authKind === 'oauth'"
            color="info"
            variant="subtle"
            size="sm"
            icon="i-lucide-key-round"
            data-testid="mcp-oauth-badge"
          >
            OAuth
          </UBadge>
        </span>
      </template>
      <template #url-cell="{ row }">
        <span
          class="text-dimmed block max-w-64 truncate font-mono text-xs"
          :title="row.original.transport === 'stdio' ? row.original.command : row.original.url"
        >
          <UBadge v-if="row.original.transport === 'stdio'" color="neutral" variant="subtle" size="sm" class="mr-1">
            stdio
          </UBadge>
          {{ row.original.transport === 'stdio' ? row.original.command : row.original.url }}
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
              icon="i-lucide-link"
              variant="ghost"
              color="neutral"
              size="sm"
              :aria-label="`Manage bindings for ${row.original.name}`"
              data-testid="mcp-manage-bindings"
              :disabled="busy"
              @click="openBindings(row.original)"
            />
            <template #content>
              <div class="px-3 py-1.5 text-xs">Manage bindings</div>
            </template>
          </UPopover>
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
              <p class="text-highlighted truncate text-sm font-medium">
                {{ row.name }}
                <UBadge
                  v-if="row.authKind === 'oauth'"
                  color="info"
                  variant="subtle"
                  size="sm"
                  icon="i-lucide-key-round"
                  class="align-middle"
                >
                  OAuth
                </UBadge>
              </p>
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
                icon="i-lucide-link"
                variant="ghost"
                color="neutral"
                size="sm"
                :aria-label="`Manage bindings for ${row.name}`"
                :disabled="busy"
                @click="openBindings(row)"
              />
              <template #content>
                <div class="px-3 py-1.5 text-xs">Manage bindings</div>
              </template>
            </UPopover>
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
          <UFormField name="transport">
            <template #label> Transport </template>
            <template #hint>
              <FormHint text="http = URL endpoint; stdio = command spawned per session on the agent host" />
            </template>
            <USelect
              v-model="form.transport"
              data-testid="mcp-transport"
              :items="[
                { label: 'HTTP (url endpoint)', value: 'http' },
                { label: 'stdio (command)', value: 'stdio' },
              ]"
              class="w-full"
              :disabled="busy"
            />
          </UFormField>
          <UFormField v-if="form.transport === 'http'" name="url">
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
          <template v-if="form.transport === 'stdio'">
            <UFormField name="command">
              <template #label> Command </template>
              <template #hint>
                <FormHint text="Absolute path to the executable — spawned per session on the agent host" />
              </template>
              <UInput
                v-model="form.command"
                icon="i-lucide-terminal"
                placeholder="/usr/local/bin/mcp-server"
                class="w-full"
                :disabled="busy"
                spellcheck="false"
              />
            </UFormField>
            <UFormField name="args">
              <template #label> Arguments </template>
              <template #hint>
                <FormHint text="One argument per line, optional" />
              </template>
              <UTextarea
                v-model="form.args"
                placeholder="--port&#10;8080"
                :rows="2"
                class="w-full"
                :disabled="busy"
                spellcheck="false"
              />
            </UFormField>
            <UFormField name="credentialEnvVar">
              <template #label> Credential env var </template>
              <template #hint>
                <FormHint text="Optional — the binding's vault secret rides dispatch/probe as this env var" />
              </template>
              <UInput
                v-model="form.credentialEnvVar"
                placeholder="MCP_API_KEY (optional)"
                class="w-full"
                :disabled="busy"
                spellcheck="false"
              />
            </UFormField>
          </template>
          <UFormField name="notes">
            <template #label> Notes </template>
            <template #hint>
              <FormHint text="Optional note" />
            </template>
            <UTextarea v-model="form.notes" placeholder="Notes (optional)" :rows="2" class="w-full" :disabled="busy" />
          </UFormField>
          <UFormField name="authKind">
            <template #label> Authentication </template>
            <template #hint>
              <FormHint
                :text="
                  form.transport === 'stdio'
                    ? 'stdio servers use the static binding credential only — OAuth is http-only'
                    : 'Static credential rides the binding; OAuth authorizes per agent'
                "
              />
            </template>
            <USelect
              v-model="form.authKind"
              data-testid="mcp-auth-kind"
              :items="
                form.transport === 'stdio'
                  ? [{ label: 'Static credential (per binding)', value: 'none' }]
                  : [
                      { label: 'Static credential (per binding)', value: 'none' },
                      { label: 'OAuth 2.0 (authorize per agent)', value: 'oauth' },
                    ]
              "
              class="w-full"
              :disabled="busy"
            />
          </UFormField>
          <template v-if="form.authKind === 'oauth'">
            <UFormField name="oauthAuthorizeUrl">
              <template #label> Authorize URL </template>
              <UInput
                v-model="form.oauthAuthorizeUrl"
                placeholder="https://provider.com/oauth/authorize"
                class="w-full"
                :disabled="busy"
                spellcheck="false"
              />
            </UFormField>
            <UFormField name="oauthTokenUrl">
              <template #label> Token URL </template>
              <UInput
                v-model="form.oauthTokenUrl"
                placeholder="https://provider.com/oauth/token"
                class="w-full"
                :disabled="busy"
                spellcheck="false"
              />
            </UFormField>
            <UFormField name="oauthRevocationUrl">
              <template #label> Revocation URL </template>
              <template #hint>
                <FormHint text="Optional — RFC 7009; unbinding revokes best-effort" />
              </template>
              <UInput
                v-model="form.oauthRevocationUrl"
                placeholder="https://provider.com/oauth/revoke (optional)"
                class="w-full"
                :disabled="busy"
                spellcheck="false"
              />
            </UFormField>
            <UFormField name="oauthClientId">
              <template #label> Client ID </template>
              <UInput
                v-model="form.oauthClientId"
                placeholder="client id from the provider"
                class="w-full"
                :disabled="busy"
              />
            </UFormField>
            <UFormField name="oauthClientSecretId">
              <template #label> Client secret </template>
              <template #hint>
                <FormHint text="Optional vault secret for confidential clients — write-only, never returned" />
              </template>
              <USelectMenu
                v-model="form.oauthClientSecretId"
                data-testid="mcp-oauth-client-secret"
                :items="secretItems"
                value-key="value"
                clear
                placeholder="None (public client + PKCE)"
                icon="i-lucide-key-round"
                class="w-full"
                :disabled="busy"
              />
            </UFormField>
            <UFormField name="oauthScopes">
              <template #label> Scopes </template>
              <UInput
                v-model="form.oauthScopes"
                placeholder="space-separated scopes (optional)"
                class="w-full"
                :disabled="busy"
                spellcheck="false"
              />
            </UFormField>
          </template>
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

    <!-- per-server binding manager (#274): bind/unbind AI employees + set the
         binding credential — same verbs as the employee editor's MCP section -->
    <UModal
      v-model:open="bindingsOpen"
      :title="bindingsRow ? `Bindings — ${bindingsRow.name}` : 'Bindings'"
      :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }"
    >
      <template #body>
        <div class="space-y-2" data-testid="mcp-server-bindings">
          <div
            v-for="b in serverBindings"
            :key="b.id"
            class="flex items-center justify-between gap-2 rounded-lg border p-2"
            :data-testid="`mcp-server-binding-${b.employeeName}`"
          >
            <div class="min-w-0">
              <p class="text-highlighted truncate text-sm font-medium">
                <UBadge v-if="b.transport === 'stdio'" color="neutral" variant="subtle" size="sm" class="mr-1">
                  stdio
                </UBadge>
                {{ b.employeeName }}
              </p>
              <p class="text-muted mt-0.5 text-xs" data-testid="mcp-server-binding-cred">
                <template v-if="b.authKind === 'oauth'">
                  <UBadge
                    :color="b.oauth?.connected ? 'success' : 'warning'"
                    variant="subtle"
                    size="sm"
                    :icon="b.oauth?.connected ? 'i-lucide-circle-check' : 'i-lucide-circle-alert'"
                    data-testid="mcp-server-binding-oauth"
                  >
                    {{ b.oauth?.connected ? 'OAuth connected' : 'OAuth not connected' }}
                  </UBadge>
                </template>
                <template v-else-if="b.secretName">
                  Credential
                  <span class="text-highlighted">{{ b.secretName }}</span>
                  <span class="text-dimmed font-mono"> •••• {{ b.lastFour }}</span>
                </template>
                <template v-else>No credential — anonymous requests</template>
              </p>
            </div>
            <div class="flex shrink-0 items-center gap-1">
              <template v-if="unbindCandidate?.id === b.id">
                <span class="text-muted text-xs" data-testid="mcp-server-binding-unbind-ask"
                  >Unbind {{ b.employeeName }}?</span
                >
                <UButton
                  label="Unbind"
                  color="error"
                  size="sm"
                  data-testid="mcp-server-binding-unbind-confirm"
                  :loading="bindBusy"
                  @click="unbind(b)"
                />
                <UButton label="Keep" variant="ghost" color="neutral" size="sm" @click="unbindCandidate = null" />
              </template>
              <template v-else>
                <template v-if="clearCandidate?.id === b.id">
                  <span class="text-muted text-xs" data-testid="mcp-server-binding-clear-ask"
                    >Clear credential for {{ b.employeeName }}?</span
                  >
                  <UButton
                    label="Clear"
                    color="error"
                    size="sm"
                    data-testid="mcp-server-binding-clear-confirm"
                    :loading="bindBusy"
                    @click="setCredential(b, null)"
                  />
                  <UButton label="Keep" variant="ghost" color="neutral" size="sm" @click="clearCandidate = null" />
                </template>
                <USelectMenu
                  v-else-if="b.authKind !== 'oauth'"
                  :model-value="b.secretId"
                  :items="secretItems"
                  value-key="value"
                  clear
                  placeholder="Credential (optional)"
                  icon="i-lucide-key-round"
                  class="w-44"
                  :disabled="bindBusy"
                  :aria-label="`Credential for ${b.employeeName}`"
                  @update:model-value="(v: string | null) => (v === null ? askClearCredential(b) : setCredential(b, v))"
                />
                <UButton
                  v-if="b.authKind === 'oauth'"
                  icon="i-lucide-key-round"
                  :label="b.oauth?.connected ? 'Reconnect' : 'Connect'"
                  variant="soft"
                  color="primary"
                  size="sm"
                  data-testid="mcp-server-oauth-connect"
                  :loading="connectingRow(b)"
                  :disabled="bindBusy || (connectingServerId !== null && !connectingRow(b))"
                  @click="connectOauth(b)"
                />
                <UButton
                  icon="i-lucide-unlink"
                  color="error"
                  variant="ghost"
                  size="sm"
                  :aria-label="`Unbind ${b.employeeName}`"
                  data-testid="mcp-server-binding-unbind"
                  :disabled="bindBusy"
                  @click="askUnbind(b)"
                />
              </template>
            </div>
          </div>
          <!-- a pending/failed read must NOT read as an authoritative empty
               state: loading line while pending, error banner + retry on
               failure, and the empty line only for a settled empty read -->
          <p v-if="unref(bindingsLive.isPending) && !serverBindings.length" class="text-muted text-sm">
            Loading bindings…
          </p>
          <UAlert
            v-else-if="bindingsLive.isError.value"
            role="alert"
            icon="i-lucide-circle-alert"
            color="error"
            variant="subtle"
            title="Couldn't load bindings"
            :ui="{ title: 'text-sm' }"
          >
            <UButton
              label="Retry"
              size="sm"
              variant="soft"
              color="primary"
              class="mt-2"
              @click="bindingsLive.refetch()"
            />
          </UAlert>
          <p v-else-if="!serverBindings.length" class="text-muted text-sm">No agents bound — bind one below.</p>

          <div class="mt-3 space-y-2 border-t pt-3">
            <USelectMenu
              v-model="newBindEmployeeId"
              :items="bindableEmployeeItems"
              value-key="value"
              :search-input="{ placeholder: 'Search agents' }"
              placeholder="AI agent…"
              icon="i-lucide-bot"
              class="w-full"
              data-testid="mcp-bind-employee"
              :disabled="bindFormDisabled"
            />
            <div class="flex items-center gap-2">
              <USelectMenu
                v-model="newBindSecretId"
                :items="secretItems"
                value-key="value"
                :search-input="{ placeholder: 'Search secrets' }"
                clear
                placeholder="Credential (optional)"
                icon="i-lucide-key-round"
                class="w-full flex-1"
                data-testid="mcp-bind-secret"
                :disabled="bindFormDisabled"
              />
              <UButton
                icon="i-lucide-link"
                label="Bind"
                size="sm"
                class="shrink-0"
                data-testid="mcp-bind-submit"
                :disabled="!newBindEmployeeId || bindFormDisabled"
                :loading="bindBusy"
                @click="bindAgent"
              />
            </div>
          </div>
          <UAlert
            v-if="connectError"
            role="alert"
            icon="i-lucide-circle-alert"
            color="error"
            variant="subtle"
            :title="connectError"
            class="mt-3"
            :ui="{ title: 'text-sm' }"
          />
          <UAlert
            v-if="unref(employeesLive.isError)"
            role="alert"
            icon="i-lucide-circle-alert"
            color="error"
            variant="subtle"
            title="Couldn't load agents"
            :ui="{ title: 'text-sm' }"
          >
            <UButton
              label="Retry"
              size="sm"
              variant="soft"
              color="primary"
              class="mt-2"
              @click="employeesLive.refetch()"
            />
          </UAlert>
          <UAlert
            v-if="bindingsError"
            role="alert"
            icon="i-lucide-circle-alert"
            color="error"
            variant="subtle"
            :title="bindingsError"
            class="mt-3"
            :ui="{ title: 'text-sm' }"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
