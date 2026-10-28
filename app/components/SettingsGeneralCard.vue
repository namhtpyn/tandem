<script setup lang="ts">
// General settings card: company identity (name, prompt), run policy (timeout,
// tasks per agent) and the workspace AI assignments (decision engine + internal
// LLM). Self-loading — it shares the settings/providers/vault query keys with
// the rest of the app, so SSE invalidation keeps every section in sync.
import { useQuery } from '@tanstack/vue-query';

import { PROVIDER_KIND, endpointKind, isModelsEndpoint } from '#shared/api-styles';
import { CHANGE_RESOURCE } from '#shared/enums';
import { NONE_ID, errorMessage } from '~/utils/forms';
import type { SecretOption } from '~/utils/vault-options';
import { groupedSecretOptions } from '~/utils/vault-options';

const { $orpc, $client } = useNuxtApp();

const settingsLive = useQuery($orpc.settings.list.queryOptions({ queryKey: [CHANGE_RESOURCE.SETTINGS] }));
const providersLive = useQuery($orpc.providers.list.queryOptions({ queryKey: [CHANGE_RESOURCE.PROVIDERS] }));

// ---- seed-on-arrival, never clobber unsaved edits ----
// Each save is its own `settings.update` call, so every refetch carries a mix
// of saved + unsaved fields: re-seeding all refs on every refetch would wipe
// what the user typed but hasn't saved yet. A ref is refreshed only when its
// current value still equals the projection the last server arrival seeded —
// anything else means the user touched it.
type SettingsPayload = {
  companyName?: string;
  runTimeoutMs?: number;
  tasksPerAgent?: number;
  companyPrompt?: string;
  internalLlm?: { providerId: string; model: string | null; keySecretId: string } | null;
  internalDecision?: { providerId: string; model: string | null; keySecretId: string } | null;
};

/** what the refs hold right after seeding from a server payload (comparison baseline) */
function projectionOf(v: SettingsPayload) {
  const assignment = (a: SettingsPayload['internalLlm']) => ({
    providerId: a?.providerId ?? undefined,
    model: a?.model ?? '',
    keySecretId: a?.keySecretId ?? null,
  });
  return {
    companyName: v.companyName?.trim() || 'Tandem',
    runTimeoutMinutes: Math.round((v.runTimeoutMs ?? 1_800_000) / 60_000),
    tasksPerAgent: v.tasksPerAgent ?? 1,
    companyPrompt: v.companyPrompt ?? '',
    internalLlm: assignment(v.internalLlm),
    internalDecision: assignment(v.internalDecision),
  };
}

const lastProjection = ref<ReturnType<typeof projectionOf> | null>(null);

/** untouched = no arrival seen yet, or the ref still holds what we last seeded */
function isUntouched(
  key: 'companyName' | 'runTimeoutMinutes' | 'tasksPerAgent' | 'companyPrompt' | 'internalLlm' | 'internalDecision',
  current: unknown,
) {
  const prior = lastProjection.value;
  if (!prior) return true;
  return JSON.stringify(current) === JSON.stringify(prior[key]);
}

function applySettings(v: SettingsPayload) {
  const seeded = projectionOf(v);
  if (isUntouched('companyName', companyName.value)) companyName.value = seeded.companyName;
  if (isUntouched('runTimeoutMinutes', runTimeoutMinutes.value)) runTimeoutMinutes.value = seeded.runTimeoutMinutes;
  if (isUntouched('tasksPerAgent', tasksPerAgent.value)) tasksPerAgent.value = seeded.tasksPerAgent;
  if (isUntouched('companyPrompt', companyPrompt.value)) companyPrompt.value = seeded.companyPrompt;
  if (isUntouched('internalLlm', llmForm)) {
    llmForm.providerId = seeded.internalLlm.providerId;
    llmForm.model = seeded.internalLlm.model;
    llmForm.keySecretId = seeded.internalLlm.keySecretId;
  }
  if (isUntouched('internalDecision', decisionForm)) {
    decisionForm.providerId = seeded.internalDecision.providerId;
    decisionForm.model = seeded.internalDecision.model;
    decisionForm.keySecretId = seeded.internalDecision.keySecretId;
  }
  lastProjection.value = seeded;
}

const companyName = ref('Tandem');
const runTimeoutMinutes = ref(30);
const tasksPerAgent = ref(1);
const companyPrompt = ref('');
// UForm :state needs a stable object — reactive() wrapping the refs keeps both in sync
const nameState = reactive({ companyName });
const promptState = reactive({ companyPrompt });
const timeoutState = reactive({ runTimeoutMinutes });
const tasksState = reactive({ tasksPerAgent });
const savingCompanyPrompt = ref(false);
const companyPromptMessage = ref('');
const companyPromptOk = ref(false); // message tone: success green, failures red
async function saveCompanyPrompt() {
  savingCompanyPrompt.value = true;
  companyPromptMessage.value = '';
  companyPromptOk.value = false;
  try {
    const text = companyPrompt.value.trim();
    if (text.length > 8000) {
      companyPromptMessage.value = 'Keep it under 8000 characters';
      return;
    }
    await $client.settings.update({ companyPrompt: text });
    companyPromptMessage.value = 'Saved';
    companyPromptOk.value = true;
  } catch (e) {
    companyPromptMessage.value = errorMessage(e, 'Save failed');
  } finally {
    savingCompanyPrompt.value = false;
  }
}
// ---- Workspace AI: internal LLM + decision assignments ----
// vault picker source: a single page caps at 100 rows and silently hides the
// rest of the vault, so walk pages up to `total` (shared [VAULT, 'all'] cache)
const vaultLive = useQuery({
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
const vaultItems = computed<SecretOption[]>(() =>
  groupedSecretOptions(
    (unref(vaultLive.data) ?? []) as Array<{ id: string; name: string; lastFour: string; folder: string | null }>,
  ),
);
type AiAssignmentForm = {
  providerId: string | undefined;
  model: string;
  keySecretId: string | null;
};
const llmForm = reactive<AiAssignmentForm>({ providerId: undefined, model: '', keySecretId: null });
const decisionForm = reactive<AiAssignmentForm>({ providerId: undefined, model: '', keySecretId: null });
// one message PER form — a shared ref rendered once could only ever sit below one of them
const llmMessage = ref('');
const llmOk = ref(false); // message tone: success green, failures red
const decisionMessage = ref('');
const decisionOk = ref(false);
const llmSaving = ref(false);
const decisionSaving = ref(false);

// each picker carries an explicit 'No provider' entry: once a provider is
// picked the select must still be able to go back to unset (sentinel law)
const NO_PROVIDER_ITEM = { label: 'No provider', value: NONE_ID };
const llmProviders = computed(() => [
  NO_PROVIDER_ITEM,
  ...((unref(providersLive.data) ?? []) as Array<{ id: string; label: string; endpoints?: string[] }>)
    .filter((p) => (p.endpoints ?? []).some((st) => endpointKind(st) === PROVIDER_KIND.LLM))
    .map((p) => ({ label: p.label, value: p.id })),
]);
const decisionProviders = computed(() => [
  NO_PROVIDER_ITEM,
  ...((unref(providersLive.data) ?? []) as Array<{ id: string; label: string; endpoints?: string[] }>)
    .filter((p) => (p.endpoints ?? []).some((st) => endpointKind(st) === PROVIDER_KIND.DECISION))
    .map((p) => ({ label: p.label, value: p.id })),
]);

// model autocomplete for the Workspace AI slots: fires only when the chosen
// provider speaks a /v1/models endpoint; the picked key unlocks the probe
function aiModelsState(form: AiAssignmentForm) {
  const items = ref<string[]>([]);
  const loading = ref(false);
  watch(
    [() => form.providerId, () => form.keySecretId],
    async ([providerId, keySecretId]) => {
      items.value = [];
      if (!providerId || providerId === NONE_ID || !keySecretId) return;
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
  const message = kind === 'internalLlm' ? llmMessage : decisionMessage;
  const ok = kind === 'internalLlm' ? llmOk : decisionOk;
  saving.value = true;
  message.value = '';
  ok.value = false;
  try {
    // the explicit 'No provider' entry maps back to unset — without it a picked
    // assignment could never be cleared again
    const providerId = form.providerId === NONE_ID ? undefined : form.providerId;
    if (providerId && (!form.keySecretId || !form.model.trim())) {
      message.value = 'API key and model are required once a provider is picked';
      return;
    }
    const value =
      providerId && form.keySecretId ? { providerId, model: form.model.trim(), keySecretId: form.keySecretId } : null;
    await $client.settings.update({ [kind]: value });
    message.value = 'Saved';
    ok.value = true;
  } catch (e) {
    message.value = errorMessage(e, 'Save failed');
  } finally {
    saving.value = false;
  }
}
// single sync point for BOTH form groups — every settings arrival seeds refs
// the user hasn't touched and leaves user-edited ones alone (see applySettings)
watch(
  () => unref(settingsLive.data),
  (d) => {
    if (!d) return;
    applySettings(d as SettingsPayload);
  },
  { immediate: true },
);

const savingTasksPerAgent = ref(false);
const tasksPerAgentMessage = ref('');
const tasksPerAgentOk = ref(false); // message tone: success green, failures red
async function saveTasksPerAgent() {
  savingTasksPerAgent.value = true;
  tasksPerAgentMessage.value = '';
  tasksPerAgentOk.value = false;
  try {
    const n = Number(tasksPerAgent.value);
    if (!Number.isInteger(n) || n < 1 || n > 32) {
      tasksPerAgentMessage.value = 'Enter a whole number between 1 and 32';
      return;
    }
    await $client.settings.update({ tasksPerAgent: n });
    tasksPerAgentMessage.value = 'Saved';
    tasksPerAgentOk.value = true;
  } catch (e) {
    tasksPerAgentMessage.value = errorMessage(e, 'Save failed');
  } finally {
    savingTasksPerAgent.value = false;
  }
}

const savingRunTimeout = ref(false);
const runTimeoutMessage = ref('');
const runTimeoutOk = ref(false); // message tone: success green, failures red
async function saveRunTimeout() {
  savingRunTimeout.value = true;
  runTimeoutMessage.value = '';
  runTimeoutOk.value = false;
  try {
    const minutes = Number(runTimeoutMinutes.value);
    if (!Number.isFinite(minutes) || minutes < 1) {
      runTimeoutMessage.value = 'Enter at least 1 minute';
      return;
    }
    await $client.settings.update({ runTimeoutMs: Math.round(minutes * 60_000) });
    runTimeoutMessage.value = 'Saved';
    runTimeoutOk.value = true;
  } catch (e) {
    runTimeoutMessage.value = errorMessage(e, 'Save failed');
  } finally {
    savingRunTimeout.value = false;
  }
}

const savingName = ref(false);
const nameMessage = ref('');
const nameMessageOk = ref(false); // message tone: success green, failures red
async function saveCompanyName() {
  savingName.value = true;
  nameMessage.value = '';
  nameMessageOk.value = false;
  try {
    await $client.settings.update({ companyName: companyName.value });
    nameMessage.value = 'Saved';
    nameMessageOk.value = true;
  } catch (e) {
    nameMessage.value = errorMessage(e, 'Save failed');
  } finally {
    savingName.value = false;
  }
}

onServerPrefetch(() => Promise.all([settingsLive.suspense(), providersLive.suspense(), vaultLive.suspense()]));
</script>

<template>
  <UCard :ui="{ root: 'shadow-sm' }">
    <template #header>
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-building-2" class="text-dimmed size-4" />
        <h2 class="text-highlighted text-sm font-semibold">General</h2>
      </div>
    </template>
    <UForm :state="nameState" class="flex flex-wrap items-end gap-3" @submit="saveCompanyName">
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
        :class="nameMessageOk ? 'text-success' : 'text-error'"
        :role="nameMessageOk ? 'status' : 'alert'"
        >{{ nameMessage }}</span
      >
    </UForm>

    <USeparator class="my-5" />

    <UForm :state="promptState" class="flex flex-col gap-3" @submit="saveCompanyPrompt">
      <UFormField label="Company prompt" name="companyPrompt">
        <template #hint
          ><FormHint text="Added to every agent brief — company-wide context, standards, tone (empty = omitted)"
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
          :class="companyPromptOk ? 'text-success' : 'text-error'"
          :role="companyPromptOk ? 'status' : 'alert'"
          >{{ companyPromptMessage }}</span
        >
      </div>
    </UForm>

    <USeparator class="my-5" />

    <UForm :state="timeoutState" class="flex flex-wrap items-end gap-3" @submit="saveRunTimeout">
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
        :class="runTimeoutOk ? 'text-success' : 'text-error'"
        :role="runTimeoutOk ? 'status' : 'alert'"
        >{{ runTimeoutMessage }}</span
      >
    </UForm>

    <USeparator class="my-5" />

    <UForm :state="tasksState" class="flex flex-wrap items-end gap-3" @submit="saveTasksPerAgent">
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
        :class="tasksPerAgentOk ? 'text-success' : 'text-error'"
        :role="tasksPerAgentOk ? 'status' : 'alert'"
        >{{ tasksPerAgentMessage }}</span
      >
    </UForm>

    <USeparator class="my-5" />

    <div>
      <h4 class="pb-1 text-sm font-medium">Decision engine (auto-assign)</h4>
      <p class="text-muted pb-2 text-xs">
        Picks which employee takes a task. Provider must offer a decision-compatible endpoint.
      </p>
      <UForm :state="decisionForm" class="flex flex-col gap-3" @submit="saveAssignment('internalDecision')">
        <UFormField label="Provider" name="providerId">
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
        <UFormField label="API key (vault)" name="keySecretId" required>
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
        <UFormField label="Model" name="model" required>
          <UInputMenu
            v-model="decisionForm.model"
            :items="decisionModels.items.value"
            :loading="decisionModels.loading.value"
            icon="i-lucide-cpu"
            placeholder="e.g. claude-sonnet"
            class="w-full"
            :disabled="decisionSaving"
          />
        </UFormField>
        <UButton type="submit" icon="i-lucide-save" :loading="decisionSaving" class="self-start"
          >Save decision engine</UButton
        >
        <span
          v-if="decisionMessage"
          class="text-xs"
          :class="decisionOk ? 'text-success' : 'text-error'"
          :role="decisionOk ? 'status' : 'alert'"
        >
          {{ decisionMessage }}
        </span>
      </UForm>
    </div>

    <USeparator class="my-5" />

    <div>
      <h4 class="pb-1 text-sm font-medium">Internal LLM</h4>
      <p class="text-muted pb-2 text-xs">
        Used by Tandem's own server-side features. Provider must offer an LLM-compatible endpoint. Not sent to agents.
      </p>
      <UForm :state="llmForm" class="flex flex-col gap-3" @submit="saveAssignment('internalLlm')">
        <UFormField label="Provider" name="providerId">
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
        <UFormField label="API key (vault)" name="keySecretId" required>
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
        <UFormField label="Model" name="model" required>
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
        <UButton type="submit" icon="i-lucide-save" :loading="llmSaving" class="self-start">Save internal LLM</UButton>
        <span
          v-if="llmMessage"
          class="text-xs"
          :class="llmOk ? 'text-success' : 'text-error'"
          :role="llmOk ? 'status' : 'alert'"
        >
          {{ llmMessage }}
        </span>
      </UForm>
    </div>
  </UCard>
</template>
