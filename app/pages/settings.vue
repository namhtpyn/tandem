<script setup lang="ts">
useHead({ title: 'Settings' });
import { useQuery } from '@tanstack/vue-query';

import {
  PROVIDER_KIND,
  endpointKind,
  isAnthropicWire,
  ENDPOINT_OPTIONS,
  PROVIDER_ENDPOINT_LABEL,
  isModelsEndpoint,
} from '#shared/api-styles';
import { CHANGE_RESOURCE } from '#shared/enums';
import { nonNull } from '#shared/utils/non-null';
import type { ModelProviderRow, ProviderSaveInput } from '~/utils/orpc-types';
import type { SecretOption } from '~/utils/vault-options';
import { groupedSecretOptions } from '~/utils/vault-options';
// Settings: auth policy for this Tandem instance. OIDC provider list is a
// UTable with a single add/edit modal (no v-model over v-for aliases — the
// dxup page transform breaks that pattern; pathbridge table+modal law).
interface OidcProviderRow {
  id: string;
  label: string;
  issuer: string;
  clientId: string;
  secretSet: boolean;
}

const { $orpc, $client } = useNuxtApp();

const oidcLive = useQuery($orpc.oidc.list.queryOptions({ queryKey: [CHANGE_RESOURCE.OIDC] }));
const providersLive = useQuery($orpc.providers.list.queryOptions({ queryKey: [CHANGE_RESOURCE.PROVIDERS] }));
const mProvList = computed(() => unref(providersLive.data) ?? []);

const mProvEditorOpen = ref(false);
const mProvEditingId = ref<string | null>(null);
const mProvForm = reactive({
  label: '',
  baseUrl: '',
  endpoints: ['OPENAI-COMPLETIONS'] as string[],
  extraHeaders: '',
  notes: '',
});

// at most one /v1/models endpoint: picking another replaces the previous one
function onEndpointsChange(next: Array<string | undefined>) {
  const all = next.filter((e): e is string => typeof e === 'string');
  const models = all.filter(isModelsEndpoint);
  if (models.length > 1) {
    const kept = nonNull(models[models.length - 1]);
    mProvForm.endpoints = [...all.filter((e) => !isModelsEndpoint(e)), kept];
    return;
  }
  mProvForm.endpoints = all;
}
const mProvBusy = ref(false);
const mProvMessage = ref('');

function openMProvEditor(row?: ModelProviderRow) {
  mProvEditingId.value = row?.id ?? null;
  mProvForm.label = row?.label ?? '';
  mProvForm.baseUrl = row?.baseUrl ?? '';
  mProvForm.endpoints = row?.endpoints?.length ? [...row.endpoints] : ['OPENAI-COMPLETIONS'];
  mProvForm.extraHeaders = row?.extraHeaders
    ? Object.entries(row.extraHeaders)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
    : '';
  mProvForm.notes = row?.notes ?? '';
  mProvMessage.value = '';
  mProvEditorOpen.value = true;
}

async function saveMProv() {
  mProvBusy.value = true;
  mProvMessage.value = '';
  try {
    const headers = mProvForm.extraHeaders.trim()
      ? Object.fromEntries(
          mProvForm.extraHeaders
            .split('\n')
            .map((l) => l.split(':').map((p) => p.trim()))
            .filter((p) => p.length === 2)
            .map((p) => [nonNull(p[0]), nonNull(p[1])]),
        )
      : undefined;
    await $client.providers.save({
      ...(mProvEditingId.value ? { id: mProvEditingId.value } : {}),
      label: mProvForm.label,
      baseUrl: mProvForm.baseUrl,
      endpoints: mProvForm.endpoints as ProviderSaveInput['endpoints'],
      ...(headers && Object.keys(headers).length ? { extraHeaders: headers } : {}),
      ...(mProvForm.notes ? { notes: mProvForm.notes } : {}),
    });
    mProvEditorOpen.value = false;
  } catch (e) {
    mProvMessage.value = e instanceof Error ? e.message : 'save failed';
  } finally {
    mProvBusy.value = false;
  }
}

async function removeMProv(id: string) {
  mProvBusy.value = true;
  mProvMessage.value = '';
  try {
    await $client.providers.remove({ id });
  } catch (e) {
    mProvMessage.value = e instanceof Error ? e.message : 'delete failed';
  } finally {
    mProvBusy.value = false;
  }
}

const settingsLive = useQuery($orpc.settings.list.queryOptions({ queryKey: [CHANGE_RESOURCE.SETTINGS] }));

const providers = computed<OidcProviderRow[]>(() =>
  (
    (unref(oidcLive.data) ?? []) as Array<{
      id: string;
      label: string;
      issuer: string;
      clientId: string;
      hasSecret: boolean;
    }>
  ).map((p) => ({ id: p.id, label: p.label, issuer: p.issuer, clientId: p.clientId, secretSet: p.hasSecret })),
);

const disablePasswordLogin = ref(false);
const companyName = ref('Tandem');
const runTimeoutMinutes = ref(30);
const tasksPerAgent = ref(1);
const companyPrompt = ref('');
const savingCompanyPrompt = ref(false);
const companyPromptMessage = ref('');
async function saveCompanyPrompt() {
  savingCompanyPrompt.value = true;
  companyPromptMessage.value = '';
  try {
    const text = companyPrompt.value.trim();
    if (text.length > 8000) {
      companyPromptMessage.value = 'Keep it under 8000 characters';
      return;
    }
    await $client.settings.update({ companyPrompt: text });
    companyPromptMessage.value = 'Saved';
  } catch (e) {
    companyPromptMessage.value = e instanceof Error ? e.message : 'Save failed';
  } finally {
    savingCompanyPrompt.value = false;
  }
}
// ---- Workspace AI: internal LLM + decision assignments ----
const vaultLive = useQuery(
  $orpc.vault.secrets.list.queryOptions({
    input: { page: 1, pageSize: 100 },
    queryKey: [CHANGE_RESOURCE.VAULT, 'all'],
  }),
);
const vaultItems = computed<SecretOption[]>(() =>
  groupedSecretOptions(
    (unref(vaultLive.data)?.data ?? []) as Array<{ id: string; name: string; lastFour: string; folder: string | null }>,
  ),
);
interface AiAssignmentForm {
  providerId: string | undefined;
  model: string;
  keySecretId: string | null;
}
const llmForm = reactive<AiAssignmentForm>({ providerId: undefined, model: '', keySecretId: null });
const decisionForm = reactive<AiAssignmentForm>({ providerId: undefined, model: '', keySecretId: null });
const aiMessage = ref('');
const llmSaving = ref(false);
const decisionSaving = ref(false);

const llmProviders = computed(() =>
  ((unref(providersLive.data) ?? []) as Array<{ id: string; label: string; endpoints?: string[] }>)
    .filter((p) => (p.endpoints ?? []).some((st) => endpointKind(st) === PROVIDER_KIND.LLM))
    .map((p) => ({ label: p.label, value: p.id })),
);
const decisionProviders = computed(() =>
  ((unref(providersLive.data) ?? []) as Array<{ id: string; label: string; endpoints?: string[] }>)
    .filter((p) => (p.endpoints ?? []).some((st) => endpointKind(st) === PROVIDER_KIND.DECISION))
    .map((p) => ({ label: p.label, value: p.id })),
);

watch(
  () => unref(settingsLive.data),
  (d) => {
    if (!d) return;
    const v = d as {
      internalLlm?: { providerId: string; model: string | null; keySecretId: string } | null;
      internalDecision?: { providerId: string; model: string | null; keySecretId: string } | null;
    };
    llmForm.providerId = v.internalLlm?.providerId ?? undefined;
    llmForm.model = v.internalLlm?.model ?? '';
    llmForm.keySecretId = v.internalLlm?.keySecretId ?? null;
    decisionForm.providerId = v.internalDecision?.providerId ?? undefined;
    decisionForm.model = v.internalDecision?.model ?? '';
    decisionForm.keySecretId = v.internalDecision?.keySecretId ?? null;
  },
  { immediate: true },
);

// model autocomplete for the Workspace AI slots: fires only when the chosen
// provider speaks a /v1/models endpoint; the picked key unlocks the probe
function aiModelsState(form: AiAssignmentForm) {
  const items = ref<string[]>([]);
  const loading = ref(false);
  watch(
    [() => form.providerId, () => form.keySecretId],
    async ([providerId, keySecretId]) => {
      items.value = [];
      if (!providerId || !keySecretId) return;
      const providers = (unref(providersLive.data) ?? []) as Array<{ id: string; endpoints: string[] }>;
      const p = providers.find((x) => x.id === providerId);
      if (!p || !(p.endpoints ?? []).some((st) => isModelsEndpoint(st))) return;
      loading.value = true;
      try {
        const res = await $client.providers.models({ providerId, keySecretId });
        items.value = res.models ?? [];
      } catch {
        /* best-effort; freetext still allowed */
      } finally {
        loading.value = false;
      }
    },
    { immediate: false },
  );
  return { items, loading };
}
const llmModels = aiModelsState(llmForm);
const decisionModels = aiModelsState(decisionForm);

async function saveAssignment(kind: 'internalLlm' | 'internalDecision') {
  const form = kind === 'internalLlm' ? llmForm : decisionForm;
  const saving = kind === 'internalLlm' ? llmSaving : decisionSaving;
  saving.value = true;
  aiMessage.value = '';
  try {
    if (form.providerId && (!form.keySecretId || !form.model.trim())) {
      aiMessage.value = 'API key and model are required once a provider is picked';
      return;
    }
    const value =
      form.providerId && form.keySecretId
        ? { providerId: form.providerId, model: form.model.trim(), keySecretId: form.keySecretId }
        : null;
    await $client.settings.update({ [kind]: value });
    aiMessage.value = 'Saved';
  } catch (e) {
    aiMessage.value = e instanceof Error ? e.message : 'save failed';
  } finally {
    saving.value = false;
  }
}
watch(
  () => unref(settingsLive.data),
  (d) => {
    if (d) {
      const v = d as {
        disablePasswordLogin: boolean;
        companyName?: string;
        runTimeoutMs?: number;
        tasksPerAgent?: number;
        companyPrompt?: string;
      };
      disablePasswordLogin.value = v.disablePasswordLogin;
      companyName.value = v.companyName?.trim() || 'Tandem';
      runTimeoutMinutes.value = Math.round((v.runTimeoutMs ?? 1_800_000) / 60_000);
      tasksPerAgent.value = v.tasksPerAgent ?? 1;
      companyPrompt.value = v.companyPrompt ?? '';
    }
  },
  { immediate: true },
);

const savingTasksPerAgent = ref(false);
const tasksPerAgentMessage = ref('');
async function saveTasksPerAgent() {
  savingTasksPerAgent.value = true;
  tasksPerAgentMessage.value = '';
  try {
    const n = Number(tasksPerAgent.value);
    if (!Number.isInteger(n) || n < 1 || n > 32) {
      tasksPerAgentMessage.value = 'Enter a whole number between 1 and 32';
      return;
    }
    await $client.settings.update({ tasksPerAgent: n });
    tasksPerAgentMessage.value = 'Saved';
  } catch (e) {
    tasksPerAgentMessage.value = e instanceof Error ? e.message : 'Save failed';
  } finally {
    savingTasksPerAgent.value = false;
  }
}

const savingRunTimeout = ref(false);
const runTimeoutMessage = ref('');
async function saveRunTimeout() {
  savingRunTimeout.value = true;
  runTimeoutMessage.value = '';
  try {
    const minutes = Number(runTimeoutMinutes.value);
    if (!Number.isFinite(minutes) || minutes < 1) {
      runTimeoutMessage.value = 'Enter at least 1 minute';
      return;
    }
    await $client.settings.update({ runTimeoutMs: Math.round(minutes * 60_000) });
    runTimeoutMessage.value = 'Saved';
  } catch (e) {
    runTimeoutMessage.value = e instanceof Error ? e.message : 'Save failed';
  } finally {
    savingRunTimeout.value = false;
  }
}

const savingName = ref(false);
const nameMessage = ref('');
async function saveCompanyName() {
  savingName.value = true;
  nameMessage.value = '';
  try {
    await $client.settings.update({ companyName: companyName.value });
    nameMessage.value = 'Saved';
  } catch (e) {
    nameMessage.value = e instanceof Error ? e.message : 'Save failed';
  } finally {
    savingName.value = false;
  }
}

const busy = ref(false);
const message = ref('');

const editorOpen = ref(false);
const editingId = ref<string | null>(null);
const form = reactive({ label: '', issuer: '', clientId: '', clientSecret: '' });

const publicOrigin = import.meta.client ? window.location.origin : '';

const providerColumns = [
  { accessorKey: 'label', header: 'Provider' },
  { accessorKey: 'issuer', header: 'Issuer' },
  { accessorKey: 'clientId', header: 'Client ID' },
  { accessorKey: 'callback', header: 'Callback URL' },
  { accessorKey: 'actions', header: '' },
];

function openEditor(row?: OidcProviderRow) {
  editingId.value = row?.id ?? null;
  form.label = row?.label ?? '';
  form.issuer = row?.issuer ?? '';
  form.clientId = row?.clientId ?? '';
  form.clientSecret = '';
  editorOpen.value = true;
}

async function saveProvider() {
  busy.value = true;
  message.value = '';
  try {
    const list = providers.value
      .filter((p) => p.id !== editingId.value)
      .map((p) => ({ id: p.id, label: p.label, issuer: p.issuer, clientId: p.clientId }));
    const list2: Array<{
      id: string | undefined;
      label: string;
      issuer: string;
      clientId: string;
      clientSecret?: string;
    }> = list;
    list2.push({
      id: editingId.value ?? undefined,
      label: form.label,
      issuer: form.issuer,
      clientId: form.clientId,
      ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}),
    });
    await $client.oidc.replace({ providers: list2 });
    editorOpen.value = false;
  } catch (e) {
    message.value = e instanceof Error ? e.message : 'save failed';
  } finally {
    busy.value = false;
  }
}

async function removeProvider(row: OidcProviderRow) {
  const list = providers.value
    .filter((p) => p.id !== row.id)
    .map((p) => ({ id: p.id, label: p.label, issuer: p.issuer, clientId: p.clientId }));
  await $client.oidc.replace({ providers: list });
}

async function savePasswordPolicy() {
  busy.value = true;
  try {
    await $client.settings.update({ disablePasswordLogin: disablePasswordLogin.value });
    message.value = 'Saved';
  } catch (e) {
    message.value = e instanceof Error ? e.message : 'save failed';
  } finally {
    busy.value = false;
  }
}

onServerPrefetch(() =>
  Promise.all([oidcLive.suspense(), providersLive.suspense(), settingsLive.suspense(), vaultLive.suspense()]),
);
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #body>
      <UDashboardNavbar title="Settings">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>

      <div class="space-y-6 p-6 lg:p-8">
        <div>
          <p class="text-sm text-zinc-500">General and authentication for this workspace</p>
        </div>

        <UCard :ui="{ root: 'shadow-sm' }">
          <template #header>
            <div class="flex items-center gap-2">
              <UIcon name="i-lucide-building-2" class="size-4 text-zinc-400" />
              <h3 class="text-sm font-semibold text-zinc-900 dark:text-white">General</h3>
            </div>
          </template>
          <UForm :state="{ companyName }" class="flex flex-wrap items-end gap-3" @submit="saveCompanyName">
            <UFormField label="Company name" name="companyName" class="min-w-56 flex-1">
              <template #hint><FormHint text="Shown in the sidebar and on the login screen" /></template>
              <UInput
                v-model="companyName"
                icon="i-lucide-building-2"
                placeholder="Company name"
                class="w-full"
                :disabled="savingName"
              />
            </UFormField>
            <UButton type="submit" icon="i-lucide-save" :loading="savingName">Save</UButton>
            <span
              v-if="nameMessage"
              class="pb-2 text-xs"
              :class="nameMessage === 'Saved' ? 'text-success' : 'text-error'"
              >{{ nameMessage }}</span
            >
          </UForm>

          <USeparator class="my-5" />

          <UForm :state="{ companyPrompt }" class="flex flex-col gap-3" @submit="saveCompanyPrompt">
            <UFormField label="Company prompt" name="companyPrompt">
              <template #hint
                ><FormHint text="Added to EVERY agent brief — company-wide context, standards, tone (empty = omitted)"
              /></template>
              <UTextarea
                v-model="companyPrompt"
                placeholder="e.g. We are a shipping-integration agency. Always prefer pinned dependencies. Reply in English…"
                :rows="5"
                class="w-full"
                :disabled="savingCompanyPrompt"
              />
            </UFormField>
            <div class="flex items-center gap-3">
              <UButton type="submit" icon="i-lucide-save" :loading="savingCompanyPrompt">Save</UButton>
              <span
                v-if="companyPromptMessage"
                class="pb-2 text-xs"
                :class="companyPromptMessage === 'Saved' ? 'text-success' : 'text-error'"
                >{{ companyPromptMessage }}</span
              >
            </div>
          </UForm>

          <USeparator class="my-5" />

          <UForm :state="{ runTimeoutMinutes }" class="flex flex-wrap items-end gap-3" @submit="saveRunTimeout">
            <UFormField label="Agent run timeout (minutes)" name="runTimeoutMinutes" class="min-w-56">
              <template #hint
                ><FormHint text="Hard cap on one agent run — the run is cancelled when it exceeds this"
              /></template>
              <UInput
                v-model.number="runTimeoutMinutes"
                type="number"
                :min="1"
                :max="360"
                icon="i-lucide-timer"
                class="w-40"
                :disabled="savingRunTimeout"
              />
            </UFormField>
            <UButton type="submit" icon="i-lucide-save" :loading="savingRunTimeout">Save</UButton>
            <span
              v-if="runTimeoutMessage"
              class="pb-2 text-xs"
              :class="runTimeoutMessage === 'Saved' ? 'text-success' : 'text-error'"
              >{{ runTimeoutMessage }}</span
            >
          </UForm>

          <USeparator class="my-5" />

          <UForm :state="{ tasksPerAgent }" class="flex flex-wrap items-end gap-3" @submit="saveTasksPerAgent">
            <UFormField label="Tasks per agent" name="tasksPerAgent" class="min-w-56">
              <template #hint
                ><FormHint
                  text="How many tasks one agent can work at the same time (default 1). Agents always run in parallel with each other"
              /></template>
              <UInput
                v-model.number="tasksPerAgent"
                type="number"
                :min="1"
                :max="32"
                icon="i-lucide-layers"
                class="w-40"
                :disabled="savingTasksPerAgent"
              />
            </UFormField>
            <UButton type="submit" icon="i-lucide-save" :loading="savingTasksPerAgent">Save</UButton>
            <span
              v-if="tasksPerAgentMessage"
              class="pb-2 text-xs"
              :class="tasksPerAgentMessage === 'Saved' ? 'text-success' : 'text-error'"
              >{{ tasksPerAgentMessage }}</span
            >
          </UForm>

          <USeparator class="my-5" />

          <div>
            <p class="pb-1 text-sm font-medium">Decision engine (auto-assign)</p>
            <p class="text-muted pb-2 text-xs">
              Picks which employee takes a task. Provider must speak a decision endpoint.
            </p>
            <UForm :state="decisionForm" class="flex flex-col gap-3" @submit="saveAssignment('internalDecision')">
              <UFormField label="Provider" name="dProvider">
                <USelectMenu
                  v-model="decisionForm.providerId"
                  :items="decisionProviders"
                  value-key="value"
                  icon="i-lucide-plug"
                  placeholder="Pick a decision provider"
                  class="w-full"
                  :disabled="decisionSaving"
                />
              </UFormField>
              <UFormField label="API key (vault)" name="dKey" required>
                <USelectMenu
                  v-model="decisionForm.keySecretId"
                  :items="vaultItems"
                  value-key="value"
                  :search-input="{ placeholder: 'Search secrets' }"
                  clear
                  icon="i-lucide-vault"
                  placeholder="Pick a vault secret"
                  class="w-full"
                  :disabled="decisionSaving"
                />
              </UFormField>
              <UFormField label="Model" name="dModel" required>
                <UInputMenu
                  v-model="decisionForm.model"
                  :items="decisionModels.items.value"
                  :loading="decisionModels.loading.value"
                  icon="i-lucide-cpu"
                  placeholder="e.g. jev-latest"
                  class="w-full"
                  :disabled="decisionSaving"
                />
              </UFormField>
              <UButton type="submit" icon="i-lucide-save" :loading="decisionSaving" class="self-start"
                >Save decision engine</UButton
              >
            </UForm>
          </div>

          <USeparator class="my-5" />

          <div>
            <p class="pb-1 text-sm font-medium">Internal LLM</p>
            <p class="text-muted pb-2 text-xs">
              Used by Tandem's own server-side features. Provider must speak an LLM endpoint. Not sent to agents.
            </p>
            <UForm :state="llmForm" class="flex flex-col gap-3" @submit="saveAssignment('internalLlm')">
              <UFormField label="Provider" name="lProvider">
                <USelectMenu
                  v-model="llmForm.providerId"
                  :items="llmProviders"
                  value-key="value"
                  icon="i-lucide-plug"
                  placeholder="Pick an LLM provider"
                  class="w-full"
                  :disabled="llmSaving"
                />
              </UFormField>
              <UFormField label="API key (vault)" name="lKey" required>
                <USelectMenu
                  v-model="llmForm.keySecretId"
                  :items="vaultItems"
                  value-key="value"
                  :search-input="{ placeholder: 'Search secrets' }"
                  clear
                  icon="i-lucide-vault"
                  placeholder="Pick a vault secret"
                  class="w-full"
                  :disabled="llmSaving"
                />
              </UFormField>
              <UFormField label="Model" name="lModel" required>
                <UInputMenu
                  v-model="llmForm.model"
                  :items="llmModels.items.value"
                  :loading="llmModels.loading.value"
                  icon="i-lucide-cpu"
                  placeholder="e.g. gpt-5.2"
                  class="w-full"
                  :disabled="llmSaving"
                />
              </UFormField>
              <UButton type="submit" icon="i-lucide-save" :loading="llmSaving" class="self-start"
                >Save internal LLM</UButton
              >
            </UForm>
          </div>
          <span v-if="aiMessage" class="pb-2 text-xs" :class="aiMessage === 'Saved' ? 'text-success' : 'text-error'">{{
            aiMessage
          }}</span>
        </UCard>

        <UCard :ui="{ root: 'shadow-sm' }">
          <template #header>
            <div class="flex items-center gap-2">
              <UIcon name="i-lucide-cpu" class="size-4 text-zinc-400" />
              <h3 class="text-sm font-semibold text-zinc-900 dark:text-white">Model providers</h3>
            </div>
          </template>
          <div class="space-y-5">
            <div>
              <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h4 class="text-xs font-semibold tracking-wide text-zinc-400 uppercase">Catalog</h4>
                <UButton icon="i-lucide-plus" size="sm" label="Add provider" @click="openMProvEditor()" />
              </div>
              <!-- Mobile: stacked cards -->
              <div v-if="mProvList.length" class="space-y-3 md:hidden">
                <UCard v-for="p in mProvList" :key="p.id" :ui="{ root: 'shadow-sm' }">
                  <div class="flex items-start justify-between gap-2">
                    <div class="min-w-0">
                      <p class="truncate text-sm font-medium text-zinc-900 dark:text-white">{{ p.label }}</p>
                      <p class="truncate font-mono text-xs text-zinc-400">{{ p.baseUrl }}</p>
                    </div>
                    <UBadge
                      v-for="st in p.endpoints"
                      :key="st"
                      :color="
                        endpointKind(st) === PROVIDER_KIND.DECISION
                          ? 'info'
                          : isModelsEndpoint(st)
                            ? 'success'
                            : isAnthropicWire([st])
                              ? 'warning'
                              : 'primary'
                      "
                      variant="subtle"
                      size="sm"
                      class="max-w-52 truncate"
                      >{{
                        (PROVIDER_ENDPOINT_LABEL[st as keyof typeof PROVIDER_ENDPOINT_LABEL] ?? st).split(' (')[0]
                      }}</UBadge
                    >
                  </div>
                  <div class="mt-3 flex justify-end gap-1">
                    <UPopover mode="hover">
                      <UButton
                        icon="i-lucide-pencil"
                        variant="ghost"
                        color="neutral"
                        size="sm"
                        aria-label="Edit provider"
                        @click="openMProvEditor(p)"
                      />
                      <template #content>
                        <div class="px-3 py-1.5 text-xs">Edit provider</div>
                      </template>
                    </UPopover>
                    <UPopover mode="hover">
                      <UButton
                        icon="i-lucide-trash-2"
                        variant="ghost"
                        color="error"
                        size="sm"
                        aria-label="Delete provider"
                        :loading="mProvBusy"
                        @click="removeMProv(p.id)"
                      />
                      <template #content>
                        <div class="px-3 py-1.5 text-xs">Delete provider</div>
                      </template>
                    </UPopover>
                  </div>
                </UCard>
              </div>

              <!-- Desktop: table -->
              <UCard v-if="mProvList.length" :ui="{ root: 'shadow-sm hidden md:block', body: 'p-0 sm:p-0' }">
                <UTable
                  :data="mProvList"
                  :columns="[
                    { accessorKey: 'label', header: 'Provider' },
                    { accessorKey: 'actions', header: '' },
                  ]"
                >
                  <template #label-cell="{ row }">
                    <div class="min-w-0">
                      <p class="flex items-center gap-2 truncate font-medium text-zinc-900 dark:text-white">
                        {{ row.original.label }}
                        <UBadge
                          v-for="st in row.original.endpoints"
                          :key="st"
                          :color="
                            endpointKind(st) === PROVIDER_KIND.DECISION
                              ? 'info'
                              : isModelsEndpoint(st)
                                ? 'success'
                                : isAnthropicWire([st])
                                  ? 'warning'
                                  : 'primary'
                          "
                          variant="subtle"
                          size="sm"
                          class="max-w-52 truncate"
                          >{{
                            (PROVIDER_ENDPOINT_LABEL[st as keyof typeof PROVIDER_ENDPOINT_LABEL] ?? st).split(' (')[0]
                          }}</UBadge
                        >
                      </p>
                      <p class="truncate font-mono text-xs text-zinc-400">{{ row.original.baseUrl }}</p>
                    </div>
                  </template>
                  <template #actions-cell="{ row }">
                    <div class="flex justify-end gap-1">
                      <UPopover mode="hover">
                        <UButton
                          icon="i-lucide-pencil"
                          variant="ghost"
                          color="neutral"
                          size="xs"
                          aria-label="Edit provider"
                          @click="openMProvEditor(row.original)"
                        />
                        <template #content>
                          <div class="px-3 py-1.5 text-xs">Edit provider</div>
                        </template>
                      </UPopover>
                      <UPopover mode="hover">
                        <UButton
                          icon="i-lucide-trash-2"
                          variant="ghost"
                          color="error"
                          size="xs"
                          aria-label="Delete provider"
                          :loading="mProvBusy"
                          @click="removeMProv(row.original.id)"
                        />
                        <template #content>
                          <div class="px-3 py-1.5 text-xs">Delete provider</div>
                        </template>
                      </UPopover>
                    </div>
                  </template>
                </UTable>
              </UCard>
              <p v-if="mProvMessage" class="text-error mt-2 text-xs">{{ mProvMessage }}</p>
              <p v-else-if="!mProvList.length" class="py-4 text-center text-sm text-zinc-500">No providers yet.</p>
            </div>
          </div>
        </UCard>

        <UCard :ui="{ root: 'shadow-sm' }">
          <template #header>
            <div class="flex items-center gap-2">
              <UIcon name="i-lucide-key-round" class="size-4 text-zinc-400" />
              <h3 class="text-sm font-semibold text-zinc-900 dark:text-white">Authentication</h3>
            </div>
          </template>
          <div class="space-y-5">
            <div>
              <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h4 class="text-xs font-semibold tracking-wide text-zinc-400 uppercase">OIDC providers</h4>
                <UButton icon="i-lucide-plus" size="sm" label="Add provider" @click="openEditor()" />
              </div>
              <template v-if="providers.length">
                <UCard :ui="{ root: 'shadow-sm', body: 'p-0 sm:p-0' }">
                  <UTable :data="providers" :columns="providerColumns">
                    <template #provider-cell="{ row }">
                      <div class="flex flex-wrap items-center gap-2">
                        <span class="text-sm font-medium text-zinc-900 dark:text-white">{{ row.original.label }}</span>
                        <UBadge v-if="!row.original.secretSet" variant="subtle" color="warning" size="sm"
                          >no secret</UBadge
                        >
                      </div>
                    </template>
                    <template #callback-cell="{ row }">
                      <span class="block font-mono text-xs break-all text-zinc-500"
                        >{{ publicOrigin }}/auth/callback/{{ row.original.id }}</span
                      >
                    </template>
                    <template #actions-cell="{ row }">
                      <div class="flex justify-end gap-2">
                        <UPopover mode="hover">
                          <UButton
                            icon="i-lucide-pencil"
                            variant="ghost"
                            color="neutral"
                            size="sm"
                            aria-label="Edit provider"
                            @click="openEditor(row.original)"
                          />
                          <template #content>
                            <div class="px-3 py-1.5 text-xs">Edit provider</div>
                          </template>
                        </UPopover>
                        <UPopover mode="hover">
                          <UButton
                            icon="i-lucide-trash-2"
                            variant="ghost"
                            color="error"
                            size="sm"
                            aria-label="Remove provider"
                            @click="removeProvider(row.original)"
                          />
                          <template #content>
                            <div class="px-3 py-1.5 text-xs">Remove provider</div>
                          </template>
                        </UPopover>
                      </div>
                    </template>
                  </UTable>
                </UCard>
                <p class="mt-2 text-xs text-zinc-400">Register each callback URL above with its identity provider.</p>
              </template>
              <div v-else class="rounded-xl border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700">
                <p class="text-sm text-zinc-400">No OIDC providers — password login only.</p>
              </div>
            </div>

            <USeparator />

            <div class="flex items-center justify-between gap-4">
              <div>
                <p class="text-sm font-medium text-zinc-900 dark:text-white">
                  Password login
                  <UBadge v-if="!disablePasswordLogin" color="success" variant="subtle" size="sm">Enabled</UBadge>
                  <UBadge v-else color="warning" variant="subtle" size="sm">Disabled — SSO only</UBadge>
                </p>
                <p class="text-xs text-zinc-400">
                  {{
                    mProvList.length === 0
                      ? 'Cannot be disabled until an OIDC provider is configured.'
                      : 'Turn off to require single sign-on.'
                  }}
                </p>
              </div>
              <USwitch
                :model-value="!disablePasswordLogin"
                :disabled="mProvList.length === 0"
                @update:model-value="
                  async (v: boolean) => {
                    disablePasswordLogin = !v;
                    await savePasswordPolicy();
                  }
                "
              />
            </div>
          </div>
        </UCard>

        <!-- OIDC provider editor modal -->
        <UModal
          :open="editorOpen"
          :title="editingId ? 'Edit provider' : 'Add OIDC provider'"
          description="Register the redirect URL shown after saving in your OIDC provider"
          @update:open="(v: boolean) => (editorOpen = v)"
        >
          <template #body>
            <UForm id="oidc-editor-form" :state="form" class="space-y-4" @submit="saveProvider">
              <UFormField name="label" label="Name" required help="Shown on the login button">
                <UInput v-model="form.label" icon="i-lucide-tag" class="w-full" placeholder="Display name" />
              </UFormField>
              <UFormField name="issuer" label="Issuer URL" required>
                <UInput v-model="form.issuer" icon="i-lucide-globe" class="w-full" placeholder="https://issuer-url" />
              </UFormField>
              <UFormField name="clientId" label="Client ID" required>
                <UInput v-model="form.clientId" class="w-full" placeholder="Client ID" />
              </UFormField>
              <UFormField
                name="secret"
                :label="editingId ? 'Client secret (blank = keep stored)' : 'Client secret'"
                :required="!editingId"
              >
                <UInput
                  v-model="form.clientSecret"
                  type="password"
                  icon="i-lucide-key-round"
                  class="w-full"
                  placeholder="Client secret"
                />
              </UFormField>
            </UForm>
          </template>
          <template #footer>
            <div class="flex w-full justify-end gap-2">
              <UButton
                type="button"
                variant="ghost"
                color="neutral"
                label="Cancel"
                :disabled="busy"
                @click="editorOpen = false"
              />
              <UButton
                type="submit"
                icon="i-lucide-plus"
                :loading="busy"
                :label="editingId ? 'Save changes' : 'Add provider'"
                form="oidc-editor-form"
              />
            </div>
          </template>
        </UModal>

        <p v-if="message" class="text-xs text-zinc-400">{{ message }}</p>
      </div>
      <!-- model provider editor -->
      <UModal
        v-model:open="mProvEditorOpen"
        :title="mProvEditingId ? 'Edit provider' : 'Add provider'"
        :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }"
      >
        <template #body>
          <UForm id="provider-editor-form" :state="mProvForm" class="space-y-4" @submit="saveMProv">
            <UFormField label="Label" name="label">
              <UInput
                v-model="mProvForm.label"
                icon="i-lucide-tag"
                placeholder="Provider name"
                class="w-full"
                required
              />
            </UFormField>
            <UFormField label="Base URL" name="baseUrl">
              <template #hint><FormHint text="OpenAI- or Anthropic-compatible endpoint root" /></template>
              <UInput
                v-model="mProvForm.baseUrl"
                icon="i-lucide-globe"
                placeholder="https://api.openai.com"
                class="w-full"
                required
              />
            </UFormField>
            <UFormField label="Available endpoints" name="endpoints">
              <template #hint
                ><FormHint
                  text="What this provider speaks — LLM endpoints power agents; decision endpoints (typed choices) power auto-assign; models endpoints list the catalog. Only one /v1/models endpoint allowed — picking another replaces it."
              /></template>
              <USelectMenu
                v-model="mProvForm.endpoints"
                :items="ENDPOINT_OPTIONS"
                @update:model-value="onEndpointsChange"
                multiple
                value-key="value"
                icon="i-lucide-plug"
                placeholder="Pick at least one endpoint"
                class="w-full"
              >
                <template #default="{ modelValue }">
                  <span v-if="modelValue?.length" class="flex flex-wrap gap-1">
                    <UBadge
                      v-for="ep in modelValue"
                      :key="ep"
                      :color="
                        endpointKind(String(ep)) === PROVIDER_KIND.DECISION
                          ? 'info'
                          : isModelsEndpoint(String(ep))
                            ? 'success'
                            : 'primary'
                      "
                      variant="subtle"
                      size="sm"
                      class="max-w-52 truncate"
                      >{{
                        (PROVIDER_ENDPOINT_LABEL[ep as keyof typeof PROVIDER_ENDPOINT_LABEL] ?? ep).split(' (')[0]
                      }}</UBadge
                    >
                  </span>
                  <span v-else class="text-dimmed">Pick at least one endpoint</span>
                </template>
              </USelectMenu>
            </UFormField>

            <UFormField label="Extra headers" name="extraHeaders">
              <template #hint><FormHint text="Optional, one 'Name: value' per line" /></template>
              <UTextarea
                v-model="mProvForm.extraHeaders"
                placeholder="HTTP-Referer: https://tandem.local"
                :rows="2"
                class="w-full"
              />
            </UFormField>
            <UFormField label="Notes" name="notes">
              <UInput
                v-model="mProvForm.notes"
                icon="i-lucide-notebook-pen"
                placeholder="Where keys live, budgets…"
                class="w-full"
              />
            </UFormField>
            <p v-if="mProvMessage" class="text-error text-sm">{{ mProvMessage }}</p>
          </UForm>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton
              variant="ghost"
              color="neutral"
              label="Cancel"
              :disabled="mProvBusy"
              @click="mProvEditorOpen = false"
            />
            <UButton
              type="submit"
              :loading="mProvBusy"
              :label="mProvEditingId ? 'Save changes' : 'Add provider'"
              form="provider-editor-form"
            />
          </div>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
