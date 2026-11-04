<script setup lang="ts">
// Employee create/edit editor: owns identity + AI-extension form state, the
// avatar pick+downscale pipeline, its catalog loaders (titles, environments,
// providers, vault secrets) and the one-time minted-key alert — the modal
// stays open while the key is on screen. null employee = create mode; emits
// `saved` after a successful write.
import { useMutation, useQuery } from '@tanstack/vue-query';
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { z } from 'zod';

import { PROVIDER_KIND, endpointKind, isModelsEndpoint } from '#shared/api-styles';
import { CHANGE_RESOURCE } from '#shared/enums';
import { nonNull } from '#shared/utils/non-null';
import { employeeAvatarUrl } from '~/utils/api-urls';
import { errorMessage, NONE_ID, saveFailed } from '~/utils/forms';
import type { EmployeeRow, EnvironmentRow, TitleRow } from '~/utils/orpc-types';
import { kindLabel } from '~/utils/ui-labels';
import type { SecretOption } from '~/utils/vault-options';
import { groupedSecretOptions } from '~/utils/vault-options';

const open = defineModel<boolean>('open', { default: false });
const props = defineProps<{ employee: EmployeeRow | null; rows: EmployeeRow[] }>();

const { $orpc, $client } = useNuxtApp();

const titlesQuery = useQuery(
  $orpc.employees.titles.list.queryOptions({ queryKey: [CHANGE_RESOURCE.EMPLOYEES, 'titles'] }),
);
const titles = computed<TitleRow[]>(() => titlesQuery.data.value?.titles ?? []);

// frontend form schema (loose, repo law): presence + shape only — the server
// re-validates strictly. UForm blocks submit and points at the offending field.
// title + the AI-conditional environment/executable mirror the server's own
// requirements so field errors surface here instead of a generic Save failure.
const employeeFormSchema = z
  .object({
    name: z.string().min(1, 'Name is required'),
    email: z.string().email('Enter a valid email'),
    title: z.string().min(1, 'Title is required'),
    kind: z.string(),
    environmentId: z.string(),
    executable: z.string(),
  })
  .superRefine((v, ctx) => {
    if (v.kind !== 'ai') return;
    if (v.environmentId === NONE_ID)
      ctx.addIssue({ code: 'custom', path: ['environmentId'], message: 'AI employees need an environment' });
    if (!v.executable.trim())
      ctx.addIssue({ code: 'custom', path: ['executable'], message: 'AI employees need an ACP executable' });
  });

const editingId = ref<string | null>(null);
const avatarUrl = ref<string | null>(null); // existing avatar (endpoint URL)
const avatarDirty = ref(false); // true when the user picked a NEW file
const form = reactive({
  name: '',
  email: '',
  kind: 'human' as 'human' | 'ai',
  image: null as string | null,
  title: '',
  supervisorIds: [] as string[],
  environmentId: NONE_ID as string,
  instructions: '',
  executable: '',
  providerId: NONE_ID as string,
  model: '',
  apiKeySecretId: null as string | null,
});
const busy = ref(false);
const message = ref('');
const mintedKey = ref('');
const copied = ref(false);

async function copyKey(key: string) {
  try {
    await navigator.clipboard.writeText(key);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch {
    /* clipboard unavailable — manual selection still possible */
  }
}

const isEdit = computed(() => editingId.value !== null);
// edit mode: the kind comes from the row being edited, never a list lookup —
// a search/page change can drop that row from `rows` while the modal stays open
const editingIsAi = computed(() => (isEdit.value ? props.employee?.kind === 'ai' : false));
const showAiFields = computed(() => (!isEdit.value ? form.kind === 'ai' : editingIsAi.value));

const supervisorItems = computed(() =>
  props.rows.filter((r) => r.id !== editingId.value).map((r) => ({ label: r.name, value: r.id })),
);

const envQuery = useQuery($orpc.environments.list.queryOptions({ queryKey: [CHANGE_RESOURCE.ENVIRONMENTS] }));
const environments = computed<EnvironmentRow[]>(() => (unref(envQuery.data) ?? []) as EnvironmentRow[]);
const environmentItems = computed(() => environments.value.map((e) => ({ label: e.name, value: e.id })));

const providersLive = useQuery($orpc.providers.list.queryOptions({ queryKey: [CHANGE_RESOURCE.PROVIDERS] }));
const modelProviders = computed(() =>
  ((unref(providersLive.data) ?? []) as Array<{ id: string; label: string; endpoints: string[] }>).filter((p) =>
    (p.endpoints ?? []).some((st) => endpointKind(st) === PROVIDER_KIND.LLM),
  ),
);
const modelItems = ref<string[]>([]);
const modelLoading = ref(false);
const providerHasModelsEndpoint = computed(() => {
  const p = ((unref(providersLive.data) ?? []) as Array<{ id: string; endpoints: string[] }>).find(
    (x) => x.id === form.providerId,
  );
  return (p?.endpoints ?? []).some((st) => isModelsEndpoint(st));
});
watch(
  [open, () => form.providerId, () => form.apiKeySecretId],
  async ([o, providerId, keySecretId]) => {
    if (!o) return;
    modelItems.value = [];
    if (providerId === NONE_ID || !providerHasModelsEndpoint.value) return;
    modelLoading.value = true;
    try {
      const res = await $client.providers.models({
        providerId,
        ...(keySecretId ? { keySecretId } : {}),
      });
      modelItems.value = res.models ?? [];
    } catch {
      /* autocomplete is best-effort; freetext still allowed */
    } finally {
      modelLoading.value = false;
    }
  },
  // immediate + keyed on open: reopening/reseeding an editor must refetch the
  // catalog even when provider/secret are unchanged (a same-value reseed never
  // fires a plain change watch)
  { immediate: true },
);
// vault secret picker: every picker shares one [VAULT, 'all'] walk (useAllVaultSecrets)
const secretsLive = useAllVaultSecrets();
const secretItems = computed<SecretOption[]>(() => groupedSecretOptions(unref(secretsLive.data) ?? []));

/** read + downscale an avatar to a 256px JPEG data URL */
async function onAvatarPicked(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('read failed'));
    fr.readAsDataURL(file);
  });
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = dataUrl;
  });
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = nonNull(canvas.getContext('2d'));
  const side = Math.min(img.width, img.height);
  ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
  form.image = canvas.toDataURL('image/jpeg', 0.85);
  avatarDirty.value = true;
}

/** identity + catalog fields seeded from an employee row (undefined = create blank) */
function applyIdentityToForm(row: EmployeeRow | undefined) {
  form.name = row?.name ?? '';
  form.email = row?.email ?? '';
  form.kind = row?.kind ?? 'human';
  form.title = row?.title ?? '';
  form.supervisorIds = row?.supervisorIds ? [...row.supervisorIds] : [];
}

/** AI extension fields seeded from an employee row */
function applyAiExtensionToForm(row: EmployeeRow | undefined) {
  form.environmentId = row?.environmentId ?? NONE_ID;
  form.instructions = row?.instructions ?? '';
  form.executable = row?.executable ?? '';
  form.providerId = row?.providerId ?? NONE_ID;
  form.model = row?.model ?? '';
  form.apiKeySecretId = row?.apiKeySecretId ?? null;
}

/** existing avatar only enters the form as the preview src; not re-uploaded unless replaced */
function syncAvatarPreview(row: EmployeeRow | undefined) {
  avatarUrl.value = row?.hasAvatar ? employeeAvatarUrl(row.id) : null;
}

/** the id the form was last seeded from — the parent now passes a LIVE-resolved
 *  row, so seeding on object identity would wipe in-progress edits, a picked
 *  avatar and the one-time minted key on every EMPLOYEES invalidation */
let seededId: string | null = null;

function seedFrom(row: EmployeeRow | undefined) {
  editingId.value = row?.id ?? null;
  applyIdentityToForm(row);
  applyAiExtensionToForm(row);
  form.image = null;
  avatarDirty.value = false;
  syncAvatarPreview(row);
  message.value = '';
  mintedKey.value = '';
  seededId = row?.id ?? null;
}

// seed on the OPEN transition and on an id change only — never re-seed while
// open on the same id (that is what stream updates look like)
watch(
  () => [open.value, props.employee?.id ?? null] as const,
  ([o, id], prev) => {
    const wasOpen = prev?.[0] ?? false;
    if (!o) {
      // closed: forget the seed so the next open always re-seeds, same row or not
      seededId = null;
      return;
    }
    // skip only a same-id refresh while the modal stays open — a reopen after
    // close (including null->null create) must always re-seed
    if (wasOpen && seededId === id) return;
    seedFrom(props.employee ?? undefined);
  },
  { immediate: true },
);

/** update call payload — avatar only when freshly picked, AI fields only when shown */
function updateInput() {
  return {
    id: nonNull(editingId.value),
    name: form.name,
    email: form.email,
    ...(avatarDirty.value ? { image: form.image } : {}),
    title: form.title,
    supervisorIds: form.supervisorIds,
    ...(showAiFields.value ? { environmentId: form.environmentId === NONE_ID ? null : form.environmentId } : {}),
    ...(showAiFields.value ? { instructions: form.instructions } : {}),
    ...(showAiFields.value ? { executable: form.executable.trim() } : {}),
    ...(showAiFields.value ? { providerId: form.providerId === NONE_ID ? null : form.providerId } : {}),
    ...(showAiFields.value ? { model: form.model || null } : {}),
    ...(showAiFields.value ? { apiKeySecretId: form.apiKeySecretId ?? null } : {}),
  };
}

/** create call payload — AI extension fields only when creating an AI */
function createInput() {
  return {
    name: form.name,
    email: form.email,
    ...(form.image ? { image: form.image } : {}),
    kind: form.kind,
    title: form.title,
    supervisorIds: form.supervisorIds,
    ...(form.kind === 'ai'
      ? {
          // create input has no null for environmentId — omit instead of clearing
          ...(form.environmentId !== NONE_ID ? { environmentId: form.environmentId } : {}),
          instructions: form.instructions,
          executable: form.executable.trim(),
          providerId: form.providerId === NONE_ID ? null : form.providerId,
          model: form.model || null,
          apiKeySecretId: form.apiKeySecretId ?? null,
        }
      : {}),
  };
}

const createMutation = useMutation($orpc.employees.create.mutationOptions());
const updateMutation = useMutation($orpc.employees.update.mutationOptions());
const titleSaveMutation = useMutation($orpc.employees.titles.save.mutationOptions());

async function save() {
  // one write at a time — a double-click or stray Enter must not double-create
  if (busy.value) return;
  busy.value = true;
  message.value = '';
  try {
    // typed-but-unknown titles join the catalog so they autocomplete next time
    if (form.title.trim() && !titles.value.some((t) => t.name === form.title.trim())) {
      await titleSaveMutation.mutateAsync({ name: form.title.trim() }).catch(() => {});
    }
    if (editingId.value) {
      await updateMutation.mutateAsync(updateInput());
    } else {
      const res = await createMutation.mutateAsync(createInput());
      // the API key returns ONCE — surface it before the modal closes
      if (res?.apiKey) mintedKey.value = res.apiKey as string;
    }
    if (!mintedKey.value) open.value = false;
  } catch (e) {
    message.value = saveFailed(e, 'employee');
  } finally {
    busy.value = false;
  }
}

onServerPrefetch(() =>
  Promise.all([titlesQuery.suspense(), envQuery.suspense(), providersLive.suspense(), secretsLive.suspense()]),
);

// ---- MCP bindings (SPEC "MCP (registry + per-agent bindings)") -------------
// Per-agent permission units: one registry entry + an optional vault secret
// whose plaintext rides the dispatch as the Authorization header (write-only
// vault law — the binding carries the ref + last-four only). Admin verbs; the
// /employees surface is admin-tier so this section only renders there.

// change-bus resource token the MCP domain publishes under — same key prefix
// as McpRegistryManager so both surfaces share one cache entry (swapped to
// CHANGE_RESOURCE.MCP once the enum gains the entry).
const MCP_RESOURCE = 'MCP';

/** binding row per the mcp.bindingsList result (SPEC procedure table) */
type McpBindingRow = {
  id: string;
  serverId: string;
  serverName: string;
  url: string;
  authKind?: string;
  oauth?: { connected: boolean; expiresAt: string | null } | null;
  secretId: string | null;
  secretName: string | null;
  lastFour: string | null;
  lastProbeOk: boolean | null;
  lastProbeDetail: string | null;
  lastProbeAt: string | null;
};

const mcpRegistryLive = useQuery($orpc.mcp.registryList.queryOptions({ queryKey: [MCP_RESOURCE, 'registry'] }));
const mcpRegistryItems = computed(() =>
  (mcpRegistryLive.data.value?.data ?? []).map((r: { id: string; name: string }) => ({ label: r.name, value: r.id })),
);

const mcpBindings = ref<McpBindingRow[]>([]);
const mcpLoading = ref(false);
const mcpBusy = ref(false);
const mcpError = ref<string | null>(null);
const newBindingServerId = ref<string | null>(null);
const newBindingSecretId = ref<string | null>(null);
const probingServerId = ref<string | null>(null);
const unbindCandidate = ref<string | null>(null);
/** ephemeral per-server probe feedback (the persisted verdict rides the row via the refetch) */
const probeResults = ref<Record<string, string | undefined>>({});

async function loadBindings() {
  const employeeId = editingId.value;
  if (!employeeId) {
    mcpBindings.value = [];
    return;
  }
  mcpLoading.value = true;
  try {
    const res = await $client.mcp.bindingsList({ employeeId });
    mcpBindings.value = res.data;
  } catch (e) {
    mcpError.value = errorMessage(e, "Couldn't load MCP bindings — try again");
  } finally {
    mcpLoading.value = false;
  }
}

async function addBinding() {
  const employeeId = editingId.value;
  const serverId = newBindingServerId.value;
  if (!employeeId || !serverId || mcpBusy.value) return;
  mcpBusy.value = true;
  mcpError.value = null;
  try {
    // upsert (SPEC): re-binding an entry swaps its credential and clears the verdict
    await $client.mcp.bindingsSet({
      employeeId,
      serverId,
      ...(newBindingSecretId.value ? { secretId: newBindingSecretId.value } : {}),
    });
    newBindingServerId.value = null;
    newBindingSecretId.value = null;
    await loadBindings();
  } catch (e) {
    mcpError.value = errorMessage(e, "Couldn't bind the server — try again");
  } finally {
    mcpBusy.value = false;
  }
}

async function probeBinding(binding: McpBindingRow) {
  const employeeId = editingId.value;
  if (!employeeId || probingServerId.value) return;
  probingServerId.value = binding.serverId;
  try {
    const res = await $client.mcp.probe({ employeeId, serverId: binding.serverId });
    // surface the returned detail line directly — the persisted verdict badge
    // updates via the bindings refetch below
    probeResults.value[binding.serverId] = res.detail || (res.ok ? 'Handshake OK' : 'Probe failed');
    await loadBindings();
  } catch (e) {
    probeResults.value[binding.serverId] = errorMessage(e, "Couldn't probe the server — try again");
  } finally {
    probingServerId.value = null;
  }
}

async function confirmUnbind() {
  const employeeId = editingId.value;
  const serverId = unbindCandidate.value;
  if (!employeeId || !serverId || mcpBusy.value) return;
  mcpBusy.value = true;
  mcpError.value = null;
  try {
    await $client.mcp.bindingsRemove({ employeeId, serverId });
    unbindCandidate.value = null;
    await loadBindings();
  } catch (e) {
    mcpError.value = errorMessage(e, "Couldn't unbind the server — try again");
  } finally {
    mcpBusy.value = false;
  }
}

/** relative 'probed <when>' label (same voice as the environments verdict) */
function probedWhen(iso: string | null | undefined) {
  if (!iso) return '';
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ---- OAuth connect (#270 slice 2, #278) -------------------------------------
// The mint rides the admin-only oRPC POST `mcp.oauthConnect` (the legacy
// state-changing GET was the CSRF-intent vector: a SameSite=Lax admin session
// rides a forged top-level navigation, a cross-site POST does not). The popup
// opens SYNCHRONOUSLY in the click gesture (about:blank) and navigates to the
// provider URL only after the mint round-trip — a post-await window.open is
// popup-blocked. Provider authorize → Tandem callback stores the binding's
// tokens → the callback page postMessages `mcp-oauth` to this opener and we
// refetch the bindings (masked status only).
const connectingServerId = ref<string | null>(null);
let connectPopupWatcher: number | null = null;

function stopConnectWatcher() {
  if (connectPopupWatcher !== null) {
    window.clearInterval(connectPopupWatcher);
    connectPopupWatcher = null;
  }
}

function onOauthMessage(event: MessageEvent) {
  if (event.origin !== window.location.origin) return;
  const data = event.data as { type?: string } | null;
  if (data?.type !== 'mcp-oauth') return;
  connectingServerId.value = null;
  stopConnectWatcher();
  void loadBindings();
}

onMounted(() => window.addEventListener('message', onOauthMessage));
onBeforeUnmount(() => {
  window.removeEventListener('message', onOauthMessage);
  stopConnectWatcher();
});

function connectOauth(binding: McpBindingRow) {
  const employeeId = editingId.value;
  if (!employeeId || connectingServerId.value) return;
  connectingServerId.value = binding.serverId;
  // gesture-safe open first — about:blank is same-origin, the opener may
  // navigate it to the provider URL once the mint resolves
  const popup = window.open('', 'mcp-oauth-connect', 'popup,width=520,height=680');
  if (!popup) {
    // popup blocked — no window to navigate, no server-side mint to spend
    connectingServerId.value = null;
    return;
  }
  // a cancelled/closed popup never postMessages — stop the spinner so the
  // Connect button stays usable (reopening was the only recovery before)
  stopConnectWatcher();
  connectPopupWatcher = window.setInterval(() => {
    if (!popup || popup.closed) {
      stopConnectWatcher();
      connectingServerId.value = null;
    }
  }, 500);
  void $client.mcp
    .oauthConnect({ employeeId, serverId: binding.serverId })
    .then((res) => {
      if (!popup || popup.closed) return;
      popup.location.href = res.connectUrl;
    })
    .catch((e) => {
      popup?.close();
      stopConnectWatcher();
      connectingServerId.value = null;
      // surface the mint rejection — the deleted REST route used to render
      // the message inside the popup; a silent flash-close reads as a glitch
      mcpError.value = errorMessage(e, "Couldn't start the OAuth connect — try again");
    });
}

/** 'connected · expires <when>' label for oauth bindings */
function oauthStatusLabel(b: McpBindingRow) {
  if (!b.oauth?.connected) return 'Not connected';
  if (!b.oauth.expiresAt) return 'Connected';
  const ms = new Date(b.oauth.expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'Connected · token expired (auto-refreshes)';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `Connected · expires in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `Connected · expires in ${h}h`;
  return `Connected · expires in ${Math.floor(h / 24)}d`;
}

// load when the modal opens with an AI employee in edit (create has no id to
// bind against — the section says so instead); an AI-kind switch in create mode
// re-fires with no id and stays a no-op
watch(
  [open, showAiFields, editingId] as const,
  async ([o, ai, id]) => {
    if (!o || !ai || !id) return;
    await loadBindings();
  },
  { immediate: true },
);
</script>

<template>
  <UModal
    v-model:open="open"
    :title="isEdit ? 'Edit employee' : 'New employee'"
    :dismissible="!mintedKey && !busy"
    :close="!mintedKey && !busy"
    :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }"
  >
    <template #body>
      <UForm id="employee-editor-form" :schema="employeeFormSchema" :state="form" class="space-y-4" @submit="save">
        <UFormField name="name" required>
          <template #label> Name </template>
          <template #hint>
            <FormHint text="Shown across tasks, runs and the org graph" />
          </template>
          <UInput v-model="form.name" icon="i-lucide-user" placeholder="Full name" class="w-full" />
        </UFormField>
        <UFormField name="email" required>
          <template #label> Email (login) </template>
          <template #hint>
            <FormHint text="Humans sign in with it; AI employees authenticate by API key" />
          </template>
          <UInput
            v-model="form.email"
            type="email"
            icon="i-lucide-at-sign"
            placeholder="name@company.com"
            class="w-full"
          />
        </UFormField>
        <UFormField name="avatar">
          <template #label> Avatar </template>
          <template #hint>
            <FormHint text="Square photo, resized to 256px" />
          </template>
          <div class="flex items-center gap-3">
            <span
              class="bg-elevated text-muted inline-flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-full"
            >
              <img v-if="form.image" :src="form.image" alt="avatar preview" class="size-12 rounded-full object-cover" />
              <img
                v-else-if="avatarUrl"
                :src="avatarUrl"
                alt="avatar preview"
                class="size-12 rounded-full object-cover"
              />
              <UIcon
                v-else-if="!form.name"
                :name="form.kind === 'ai' ? 'i-lucide-bot' : 'i-lucide-user'"
                class="size-5"
                aria-hidden="true"
              />
              <template v-else>{{ form.name.slice(0, 1) }}</template>
            </span>
            <label
              class="border-default hover:bg-elevated text-highlighted focus-within:ring-primary inline-flex w-fit shrink-0 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium focus-within:ring-2 focus-within:outline-none"
            >
              <UIcon name="i-lucide-image-up" class="size-4 shrink-0" />
              <span class="truncate">Choose image</span>
              <input
                type="file"
                accept="image/*"
                class="sr-only"
                aria-label="Choose image"
                :disabled="busy"
                @change="onAvatarPicked"
              />
            </label>
            <UButton
              v-if="form.image"
              icon="i-lucide-x"
              size="xs"
              color="neutral"
              variant="soft"
              aria-label="Remove avatar"
              @click="
                form.image = null;
                avatarDirty = true;
                avatarUrl = null;
              "
            />
          </div>
        </UFormField>
        <UFormField v-if="!isEdit" name="kind">
          <template #label> Kind </template>
          <template #hint>
            <FormHint text="Fixed after creation — humans sign in, AI agents run on an environment" />
          </template>
          <URadioGroup
            v-model="form.kind"
            :items="[
              { label: 'Human', description: 'Password/SSO login', value: 'human' },
              { label: 'AI agent', description: 'API key, runs on an environment', value: 'ai' },
            ]"
            variant="card"
            color="neutral"
            :ui="{ item: 'has-data-[state=checked]:text-highlighted' }"
            class="w-full"
          />
        </UFormField>
        <UFormField v-else name="kind">
          <template #label> Kind </template>
          <template #hint>
            <FormHint text="Fixed after creation — humans sign in, AI agents run on an environment" />
          </template>
          <UBadge
            :color="editingIsAi ? 'primary' : 'neutral'"
            variant="subtle"
            :icon="editingIsAi ? 'i-lucide-bot' : 'i-lucide-user'"
          >
            {{ kindLabel(editingIsAi ? 'ai' : 'human') }}
          </UBadge>
        </UFormField>
        <UFormField name="title">
          <template #label> Title </template>
          <template #hint>
            <FormHint text="Place in the workspace, e.g. Senior Engineer" />
          </template>
          <AutoCompleteInput
            v-model="form.title"
            :items="titles.map((t) => t.name)"
            icon="i-lucide-briefcase"
            placeholder="Job title"
            create-hint="A new title will be added to the catalog"
            :disabled="busy"
          />
        </UFormField>
        <UFormField name="supervisorIds">
          <template #label> Supervisors </template>
          <template #hint>
            <FormHint text="Many-to-many — an employee can report to several" />
          </template>
          <USelectMenu
            v-model="form.supervisorIds"
            :items="supervisorItems"
            multiple
            value-key="value"
            placeholder="No supervisors"
            class="w-full"
          />
        </UFormField>
        <template v-if="showAiFields">
          <UFormField name="environmentId">
            <template #label> Environment </template>
            <template #hint>
              <FormHint text="SSH target this agent runs on" />
            </template>
            <USelectMenu
              v-model="form.environmentId"
              :items="[{ label: 'No environment', value: NONE_ID }, ...environmentItems]"
              value-key="value"
              placeholder="Select an environment"
              class="w-full"
            />
          </UFormField>
          <UFormField name="executable" required>
            <template #label> ACP executable </template>
            <template #hint>
              <FormHint text="Command that starts an ACP server on stdio in the environment" />
            </template>
            <UInput
              v-model="form.executable"
              icon="i-lucide-terminal"
              placeholder="hermes acp"
              class="w-full"
              data-testid="acp-executable-input"
            />
          </UFormField>
          <UFormField name="providerId">
            <template #label> Provider </template>
            <template #hint>
              <FormHint text="Model endpoint this agent uses" />
            </template>
            <USelect
              v-model="form.providerId"
              :items="[
                { label: 'No provider', value: NONE_ID },
                ...modelProviders.map((p) => ({ label: p.label, value: p.id })),
              ]"
              value-key="value"
              icon="i-lucide-plug"
              placeholder="Select a provider"
              class="w-full"
            />
          </UFormField>
          <UFormField name="model">
            <template #label> Model </template>
            <template #hint>
              <FormHint text="Model name the agent runs — pick from the list or type your own" />
            </template>
            <UInputMenu
              v-model="form.model"
              :items="modelItems"
              :loading="modelLoading"
              icon="i-lucide-cpu"
              placeholder="Model name"
              class="w-full"
            />
          </UFormField>
          <UFormField name="apiKeySecretId">
            <template #label> API key </template>
            <template #hint>
              <FormHint text="Vault secret holding the key (per-agent, injected per run)" />
            </template>
            <USelectMenu
              v-model="form.apiKeySecretId"
              :items="secretItems"
              value-key="value"
              :search-input="{ placeholder: 'Search secrets' }"
              clear
              icon="i-lucide-key-round"
              placeholder="Vault secret with the API key"
              class="w-full"
            />
          </UFormField>
          <UFormField name="instructions">
            <template #label> Instructions </template>
            <template #hint>
              <FormHint text="System prompt for this agent" />
            </template>
            <UTextarea
              v-model="form.instructions"
              :rows="4"
              placeholder="Custom instructions for this agent…"
              class="w-full"
            />
          </UFormField>
          <UFormField name="mcpBindings">
            <template #label> MCP servers </template>
            <template #hint>
              <FormHint text="Bound servers ride every dispatch of this agent" />
            </template>
            <UAlert
              v-if="mcpError"
              role="alert"
              icon="i-lucide-circle-alert"
              color="error"
              variant="subtle"
              :title="mcpError"
              class="mb-2"
              :ui="{ title: 'text-sm' }"
            />
            <!-- edit mode: the live binding list — unbinding revokes on the agent's next dispatch -->
            <div v-if="editingId" class="space-y-2">
              <p v-if="mcpLoading && !mcpBindings.length" class="text-muted text-sm">Loading bindings…</p>
              <p v-else-if="!mcpBindings.length" class="text-muted text-sm">No MCP servers bound.</p>
              <div
                v-for="b in mcpBindings"
                :key="b.id"
                data-testid="mcp-binding-row"
                class="border-default rounded-md p-3"
              >
                <div class="flex min-h-11 flex-wrap items-center justify-between gap-2">
                  <div class="min-w-0">
                    <p class="text-highlighted truncate text-sm font-medium">{{ b.serverName }}</p>
                    <p class="text-dimmed truncate font-mono text-xs" :title="b.url">{{ b.url }}</p>
                  </div>
                  <div class="flex items-center gap-2">
                    <UBadge
                      v-if="b.lastProbeOk === true"
                      color="success"
                      variant="subtle"
                      size="sm"
                      icon="i-lucide-circle-check"
                      data-testid="mcp-probe-ok"
                    >
                      OK
                    </UBadge>
                    <UBadge
                      v-else-if="b.lastProbeOk === false"
                      color="error"
                      variant="subtle"
                      size="sm"
                      icon="i-lucide-circle-alert"
                      data-testid="mcp-probe-detail"
                    >
                      Not OK
                    </UBadge>
                    <UBadge
                      v-else
                      color="neutral"
                      variant="subtle"
                      size="sm"
                      icon="i-lucide-circle"
                      data-testid="mcp-probe-never"
                    >
                      Not probed
                    </UBadge>
                    <span
                      v-if="b.lastProbeAt"
                      class="text-dimmed hidden text-xs sm:inline"
                      :title="`${b.lastProbeDetail ?? ''} · probed ${b.lastProbeAt}`"
                    >
                      probed {{ probedWhen(b.lastProbeAt) }}
                    </span>
                    <UButton
                      icon="i-lucide-plug-zap"
                      variant="ghost"
                      color="neutral"
                      size="sm"
                      :aria-label="`Probe ${b.serverName}`"
                      :loading="probingServerId === b.serverId"
                      :disabled="mcpBusy || (probingServerId !== null && probingServerId !== b.serverId)"
                      @click="probeBinding(b)"
                    />
                    <template v-if="unbindCandidate !== b.serverId">
                      <UButton
                        icon="i-lucide-unlink"
                        variant="ghost"
                        color="neutral"
                        size="sm"
                        class="text-muted hover:text-error"
                        :aria-label="`Unbind ${b.serverName}`"
                        :disabled="mcpBusy"
                        @click="unbindCandidate = b.serverId"
                      />
                    </template>
                    <template v-else>
                      <span class="text-muted text-xs">Revoke access?</span>
                      <UButton
                        label="Unbind"
                        color="error"
                        variant="soft"
                        size="sm"
                        :loading="mcpBusy"
                        @click="confirmUnbind"
                      />
                      <UButton label="Keep" variant="ghost" color="neutral" size="sm" @click="unbindCandidate = null" />
                    </template>
                  </div>
                </div>
                <p class="text-muted mt-1 text-xs" data-testid="mcp-binding-auth">
                  <template v-if="b.authKind === 'oauth'">
                    <UBadge
                      :color="b.oauth?.connected ? 'success' : 'warning'"
                      variant="subtle"
                      size="sm"
                      :icon="b.oauth?.connected ? 'i-lucide-circle-check' : 'i-lucide-circle-alert'"
                      data-testid="mcp-oauth-status"
                    >
                      {{ oauthStatusLabel(b) }}
                    </UBadge>
                    <UButton
                      class="ms-2"
                      icon="i-lucide-key-round"
                      :label="b.oauth?.connected ? 'Reconnect' : 'Connect'"
                      variant="soft"
                      color="primary"
                      size="sm"
                      data-testid="mcp-oauth-connect"
                      :loading="connectingServerId === b.serverId"
                      :disabled="mcpBusy || (connectingServerId !== null && connectingServerId !== b.serverId)"
                      @click="connectOauth(b)"
                    />
                  </template>
                  <template v-else-if="b.secretName">
                    Credential
                    <span class="text-highlighted">{{ b.secretName }}</span>
                    <span class="text-dimmed font-mono"> •••• {{ b.lastFour }}</span>
                  </template>
                  <template v-else>No credential — anonymous requests</template>
                </p>
                <p v-if="probeResults[b.serverId]" class="text-dimmed mt-1 text-xs">
                  {{ probeResults[b.serverId] }}
                </p>
              </div>
            </div>
            <p v-else class="text-muted text-sm">Save the agent first, then bind MCP servers here.</p>
            <!-- add-binding row: registry entry + optional vault credential (write-only: the secret's plaintext is never returned) -->
            <div v-if="editingId" class="mt-2 space-y-2">
              <USelectMenu
                v-model="newBindingServerId"
                :items="mcpRegistryItems"
                value-key="value"
                :search-input="{ placeholder: 'Search servers' }"
                placeholder="MCP server…"
                icon="i-lucide-plug"
                class="w-full"
              />
              <div class="flex items-center gap-2">
                <USelectMenu
                  v-model="newBindingSecretId"
                  :items="secretItems"
                  value-key="value"
                  :search-input="{ placeholder: 'Search secrets' }"
                  clear
                  placeholder="Credential (optional)"
                  icon="i-lucide-key-round"
                  class="w-full flex-1"
                />
                <UButton
                  icon="i-lucide-plus"
                  label="Bind"
                  size="sm"
                  class="shrink-0"
                  :disabled="!newBindingServerId || mcpBusy"
                  :loading="mcpBusy"
                  @click="addBinding"
                />
              </div>
            </div>
          </UFormField>
        </template>
        <UAlert
          v-if="message"
          icon="i-lucide-circle-alert"
          color="error"
          variant="subtle"
          :title="message"
          :ui="{ title: 'text-sm' }"
        />
        <div v-if="mintedKey" class="text-primary bg-primary/10 rounded-lg p-4">
          <p class="flex items-center gap-2 text-sm font-semibold">
            <UIcon name="i-lucide-key-round" class="size-4" />
            API key created
          </p>
          <p class="text-muted mt-1 text-xs">Shown only once — copy it now; it cannot be retrieved later.</p>
          <div class="mt-3 flex items-center gap-2">
            <code class="bg-default/60 flex-1 rounded-md px-2.5 py-2 font-mono text-sm break-all">{{ mintedKey }}</code>
            <UButton
              :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
              :color="copied ? 'success' : 'neutral'"
              variant="soft"
              size="sm"
              :label="copied ? 'Copied' : 'Copy'"
              @click="copyKey(mintedKey)"
            />
          </div>
          <UButton
            class="mt-3"
            size="sm"
            color="primary"
            variant="solid"
            label="Done, key saved"
            @click="open = false"
          />
        </div>
      </UForm>
    </template>
    <template #footer>
      <!-- hidden while the minted key is displayed — 'Create employee' beside
           the key invites a double-create; the panel's Done button closes -->
      <div v-if="!mintedKey" class="flex w-full justify-end gap-2">
        <UButton variant="ghost" color="neutral" label="Cancel" :disabled="busy" @click="open = false" />
        <UButton
          type="submit"
          :loading="busy"
          :label="isEdit ? 'Save changes' : 'Create employee'"
          form="employee-editor-form"
        />
      </div>
    </template>
  </UModal>
</template>
