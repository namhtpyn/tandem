<script setup lang="ts">
// General settings card: workspace identity (name, prompt), run policy (timeout,
// tasks per agent) and the workspace AI assignments (decision engine + internal
// LLM). Self-loading — it shares the settings/providers/vault query keys with
// the rest of the app, so SSE invalidation keeps every section in sync.
import { useQuery } from '@tanstack/vue-query';
import { z } from 'zod';

import { PROVIDER_KIND, endpointKind, isModelsEndpoint } from '#shared/api-styles';
import { CHANGE_RESOURCE } from '#shared/enums';
import { RUN_TIMEOUT_MAX_COPY, RUN_TIMEOUT_MINUTES } from '#shared/run-policy';
import { NONE_ID, saveFailed } from '~/utils/forms';
import type { ModelProviderRow, SettingsPayload } from '~/utils/orpc-types';
import type { SecretOption, VaultSecretOptionRow } from '~/utils/vault-options';
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

/** what the refs hold right after seeding from a server payload (comparison baseline) */
function projectionOf(v: SettingsPayload) {
  const assignment = (a: SettingsPayload['internalLlm']) => ({
    providerId: a?.providerId,
    model: a?.model ?? '',
    keySecretId: a?.keySecretId ?? null,
  });
  return {
    companyName: v.companyName.trim() || 'Tandem',
    runTimeoutMinutes: Math.round(v.runTimeoutMs / 60_000),
    tasksPerAgent: v.tasksPerAgent,
    peak: { peakStartHour: v.peakStartHour, peakEndHour: v.peakEndHour, peakMultiplier: v.peakMultiplier },
    companyPrompt: v.companyPrompt,
    internalLlm: assignment(v.internalLlm),
    internalDecision: assignment(v.internalDecision),
  };
}

const lastProjection = ref<ReturnType<typeof projectionOf> | null>(null);

/** untouched = no arrival seen yet, or the ref still holds what we last seeded */
function isUntouched(
  key:
    | 'companyName'
    | 'runTimeoutMinutes'
    | 'tasksPerAgent'
    | 'peak'
    | 'companyPrompt'
    | 'internalLlm'
    | 'internalDecision',
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
  if (isUntouched('peak', peakForm)) {
    peakForm.peakStartHour = seeded.peak.peakStartHour;
    peakForm.peakEndHour = seeded.peak.peakEndHour;
    peakForm.peakMultiplier = seeded.peak.peakMultiplier;
  }
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
// peak cadence (#70): one form for the window + multiplier triple
const peakForm = reactive({ peakStartHour: 8, peakEndHour: 17, peakMultiplier: 1 });
const peakState = reactive({ peakForm });

// loose frontend schemas (repo law): presence/shape only, the server re-validates.
// UForm only renders per-field errors when it has a schema — these six forms had
// none, so a blank name or bad limit silently did nothing.
const companyNameSchema = z.object({
  companyName: z.string().trim().min(1, 'Workspace name is required'),
});
const companyPromptSchema = z.object({
  companyPrompt: z.string().trim().max(8000, 'Keep it under 8000 characters'),
});
// one range for the form and the schema; the server caps a run at the same 6h
const runTimeoutSchema = z.object({
  runTimeoutMinutes: z
    .number(`Enter a whole number of minutes between ${RUN_TIMEOUT_MINUTES.min} and ${RUN_TIMEOUT_MINUTES.max}`)
    .int(`Enter a whole number of minutes between ${RUN_TIMEOUT_MINUTES.min} and ${RUN_TIMEOUT_MINUTES.max}`)
    .min(
      RUN_TIMEOUT_MINUTES.min,
      `Enter a whole number of minutes between ${RUN_TIMEOUT_MINUTES.min} and ${RUN_TIMEOUT_MINUTES.max}`,
    )
    .max(
      RUN_TIMEOUT_MINUTES.max,
      `Enter a whole number of minutes between ${RUN_TIMEOUT_MINUTES.min} and ${RUN_TIMEOUT_MINUTES.max}`,
    ),
});
const tasksPerAgentSchema = z.object({
  tasksPerAgent: z
    .number('Enter a number between 1 and 32')
    .int('Enter a whole number between 1 and 32')
    .min(1, 'Enter a whole number between 1 and 32')
    .max(32, 'Enter a whole number between 1 and 32'),
});
// loose frontend check (repo law): presence/shape only — the server re-validates
// the start<end window rule against the saved other half
const peakSchema = z.object({
  peakForm: z.object({
    peakStartHour: z.number('Enter a whole hour between 0 and 23').int().min(0).max(23),
    peakEndHour: z.number('Enter a whole hour between 1 and 24').int().min(1).max(24),
    peakMultiplier: z.number('Enter a factor between 0 and 1').min(0).max(1),
  }),
});
/** assignment forms: provider optional; a chosen provider needs a key + model */
const assignmentSchema = z
  .object({
    providerId: z.string().optional(),
    keySecretId: z.string().nullish(),
    model: z.string().trim(),
  })
  .superRefine((v, ctx) => {
    if (!v.providerId || v.providerId === NONE_ID) return;
    if (!v.keySecretId) {
      ctx.addIssue({ code: 'custom', path: ['keySecretId'], message: 'Pick a vault secret for this provider' });
    }
    if (!v.model) {
      ctx.addIssue({ code: 'custom', path: ['model'], message: 'Model is required' });
    }
  });
// ---- one save lifecycle for the four single-field forms ----
type SettingsUpdateInput = Parameters<typeof $client.settings.update>[0];

/** busy + message + tone for one settings form; build() returns the update
 *  input, or a validation message string when the local check fails */
function useSettingsSaver(field: string) {
  const saving = ref(false);
  const message = ref('');
  const ok = ref(false);
  async function save(build: () => SettingsUpdateInput | string) {
    saving.value = true;
    message.value = '';
    ok.value = false;
    try {
      const input = build();
      if (typeof input === 'string') {
        message.value = input;
        return;
      }
      await $client.settings.update(input);
      message.value = 'Saved';
      ok.value = true;
    } catch (e) {
      message.value = saveFailed(e, field);
    } finally {
      saving.value = false;
    }
  }
  return reactive({ saving, message, ok, save });
}
const nameSaver = useSettingsSaver('workspace name');
const promptSaver = useSettingsSaver('workspace prompt');
const timeoutSaver = useSettingsSaver('run timeout');
const tasksSaver = useSettingsSaver('task limit');
const peakSaver = useSettingsSaver('peak cadence');

async function saveCompanyName() {
  await nameSaver.save(() => ({ companyName: companyName.value.trim() }));
}
async function saveCompanyPrompt() {
  await promptSaver.save(() => {
    const text = companyPrompt.value.trim();
    if (text.length > 8000) return 'Keep it under 8000 characters';
    return { companyPrompt: text };
  });
}
async function saveRunTimeout() {
  await timeoutSaver.save(() => {
    const minutes = Number(runTimeoutMinutes.value);
    if (!Number.isInteger(minutes) || minutes < RUN_TIMEOUT_MINUTES.min || minutes > RUN_TIMEOUT_MINUTES.max) {
      return `Enter a whole number of minutes between ${RUN_TIMEOUT_MINUTES.min} and ${RUN_TIMEOUT_MINUTES.max}`;
    }
    return { runTimeoutMs: Math.round(minutes * 60_000) };
  });
}
async function saveTasksPerAgent() {
  await tasksSaver.save(() => {
    const n = Number(tasksPerAgent.value);
    if (!Number.isInteger(n) || n < 1 || n > 32) return 'Enter a whole number between 1 and 32';
    return { tasksPerAgent: n };
  });
}
async function savePeakCadence() {
  await peakSaver.save(() => {
    const { peakStartHour: s, peakEndHour: e, peakMultiplier: m } = peakForm;
    const hoursOk = Number.isInteger(s) && s >= 0 && s <= 23 && Number.isInteger(e) && e >= 1 && e <= 24;
    if (!hoursOk) return 'Enter whole hours: start 0–23, end 1–24';
    if (s >= e) return 'The peak window start must be before its end';
    if (!(m >= 0 && m <= 1)) return 'Enter a multiplier between 0 and 1';
    return { peakStartHour: s, peakEndHour: e, peakMultiplier: m };
  });
}
// ---- Workspace AI: internal LLM + decision assignments ----
// vault picker source — one shared [VAULT,'all'] walk (useAllVaultSecrets)
const vaultLive = useAllVaultSecrets();
const vaultItems = computed<SecretOption[]>(() =>
  groupedSecretOptions((unref(vaultLive.data) ?? []) as VaultSecretOptionRow[]),
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
const allProviders = computed<ModelProviderRow[]>(() => unref(providersLive.data) ?? []);
/** provider options for one endpoint kind — the two pickers were identical
 *  copies apart from the kind they filter on */
function providerOptionsFor(kind: typeof PROVIDER_KIND.LLM | typeof PROVIDER_KIND.DECISION) {
  return [
    NO_PROVIDER_ITEM,
    ...allProviders.value
      .filter((p) => (p.endpoints ?? []).some((st) => endpointKind(st) === kind))
      .map((p) => ({ label: p.label, value: p.id })),
  ];
}
const llmProviders = computed(() => providerOptionsFor(PROVIDER_KIND.LLM));
const decisionProviders = computed(() => providerOptionsFor(PROVIDER_KIND.DECISION));

// model autocomplete for the Workspace AI slots: fires when the chosen provider
// speaks a /v1/models endpoint; the picked key unlocks the probe. immediate so a
// saved assignment shows its model list on first paint, not only after an edit.
function aiModelsState(form: AiAssignmentForm) {
  const items = ref<string[]>([]);
  const loading = ref(false);
  watch(
    [() => form.providerId, () => form.keySecretId],
    async ([providerId, keySecretId]) => {
      items.value = [];
      if (!providerId || providerId === NONE_ID || !keySecretId) return;
      const p = allProviders.value.find((x) => x.id === providerId);
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
    { immediate: true },
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
    message.value = saveFailed(e, kind === 'internalLlm' ? 'internal LLM' : 'decision engine');
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
    applySettings(d);
  },
  { immediate: true },
);

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

    <!-- a failed load must never let a Save write placeholder defaults over the
         real settings: no data = skeleton/error, never editable defaults -->
    <template v-if="settingsLive.isPending.value">
      <div class="space-y-4" aria-hidden="true">
        <div v-for="i in 3" :key="i" class="space-y-1.5">
          <div class="bg-elevated h-4 w-28 animate-pulse rounded-sm" />
          <div class="bg-elevated h-10 w-full max-w-md animate-pulse rounded-md" />
        </div>
      </div>
    </template>
    <div v-else-if="settingsLive.isError.value" role="alert" class="space-y-2 py-4">
      <p class="text-error text-sm">Couldn't load workspace settings — saving is disabled until they load.</p>
      <UButton
        size="sm"
        color="neutral"
        variant="outline"
        icon="i-lucide-rotate-cw"
        label="Try again"
        @click="settingsLive.refetch()"
      />
    </div>

    <template v-else>
      <UForm
        :state="nameState"
        :schema="companyNameSchema"
        class="flex flex-wrap items-end gap-3"
        @submit="saveCompanyName"
      >
        <UFormField label="Workspace name" name="companyName" class="min-w-56 flex-1">
          <template #hint><FormHint text="Shown in the sidebar and on the login screen" /></template>
          <UInput
            v-model="companyName"
            icon="i-lucide-building-2"
            placeholder="Workspace name"
            class="w-full"
            :disabled="nameSaver.saving"
          />
        </UFormField>
        <UButton
          type="submit"
          icon="i-lucide-save"
          color="neutral"
          variant="soft"
          :loading="nameSaver.saving"
          :disabled="!settingsLive.isSuccess.value"
          >Save name</UButton
        >
        <span
          v-if="nameSaver.message"
          class="pb-2 text-xs"
          :class="nameSaver.ok ? 'text-success' : 'text-error'"
          :role="nameSaver.ok ? 'status' : 'alert'"
          >{{ nameSaver.message }}</span
        >
      </UForm>

      <USeparator class="my-5" />

      <UForm :state="promptState" :schema="companyPromptSchema" class="flex flex-col gap-3" @submit="saveCompanyPrompt">
        <UFormField label="Workspace prompt" name="companyPrompt">
          <template #hint
            ><FormHint text="Added to every agent brief — workspace-wide context, standards, tone (empty = omitted)"
          /></template>
          <UTextarea
            v-model="companyPrompt"
            placeholder="e.g. We are a shipping-integration agency. Always prefer pinned dependencies. Reply in English…"
            :rows="5"
            class="w-full"
            :disabled="promptSaver.saving"
          />
        </UFormField>
        <div class="flex items-center gap-3">
          <UButton
            type="submit"
            icon="i-lucide-save"
            :loading="promptSaver.saving"
            :disabled="!settingsLive.isSuccess.value"
            >Save prompt</UButton
          >
          <span
            v-if="promptSaver.message"
            class="pb-2 text-xs"
            :class="promptSaver.ok ? 'text-success' : 'text-error'"
            :role="promptSaver.ok ? 'status' : 'alert'"
            >{{ promptSaver.message }}</span
          >
        </div>
      </UForm>

      <USeparator class="my-5" />

      <UForm
        :state="timeoutState"
        :schema="runTimeoutSchema"
        class="flex flex-wrap items-end gap-3"
        @submit="saveRunTimeout"
      >
        <UFormField label="Agent run timeout (minutes)" name="runTimeoutMinutes" class="min-w-56">
          <template #hint
            ><FormHint :text="`Hard cap on one agent run — cancelled when it exceeds this. ${RUN_TIMEOUT_MAX_COPY}.`"
          /></template>
          <UInput
            v-model.number="runTimeoutMinutes"
            type="number"
            :min="RUN_TIMEOUT_MINUTES.min"
            :max="RUN_TIMEOUT_MINUTES.max"
            icon="i-lucide-timer"
            class="w-40"
            :disabled="timeoutSaver.saving"
          />
        </UFormField>
        <UButton
          type="submit"
          icon="i-lucide-save"
          color="neutral"
          variant="soft"
          :loading="timeoutSaver.saving"
          :disabled="!settingsLive.isSuccess.value"
          >Save timeout</UButton
        >
        <span
          v-if="timeoutSaver.message"
          class="pb-2 text-xs"
          :class="timeoutSaver.ok ? 'text-success' : 'text-error'"
          :role="timeoutSaver.ok ? 'status' : 'alert'"
          >{{ timeoutSaver.message }}</span
        >
      </UForm>

      <USeparator class="my-5" />

      <UForm
        :state="tasksState"
        :schema="tasksPerAgentSchema"
        class="flex flex-wrap items-end gap-3"
        @submit="saveTasksPerAgent"
      >
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
            :disabled="tasksSaver.saving"
          />
        </UFormField>
        <UButton
          type="submit"
          icon="i-lucide-save"
          color="neutral"
          variant="soft"
          :loading="tasksSaver.saving"
          :disabled="!settingsLive.isSuccess.value"
          >Save task limit</UButton
        >
        <span
          v-if="tasksSaver.message"
          class="pb-2 text-xs"
          :class="tasksSaver.ok ? 'text-success' : 'text-error'"
          :role="tasksSaver.ok ? 'status' : 'alert'"
          >{{ tasksSaver.message }}</span
        >
      </UForm>

      <USeparator class="my-5" />

      <UForm :state="peakState" :schema="peakSchema" class="flex flex-wrap items-end gap-3" @submit="savePeakCadence">
        <UFormField label="Peak window start (ICT)" name="peakStartHour" class="min-w-40">
          <template #hint
            ><FormHint text="Hour the peak window opens (Mon–Fri only, ICT). Weekends always run full cadence"
          /></template>
          <UInput
            v-model.number="peakForm.peakStartHour"
            type="number"
            :min="0"
            :max="23"
            icon="i-lucide-sunrise"
            class="w-32"
            :disabled="peakSaver.saving"
          />
        </UFormField>
        <UFormField label="Peak window end (ICT)" name="peakEndHour" class="min-w-40">
          <template #hint
            ><FormHint text="Hour the peak window closes (Mon–Fri only, ICT). 17 = 17:00 sharp"
          /></template>
          <UInput
            v-model.number="peakForm.peakEndHour"
            type="number"
            :min="1"
            :max="24"
            icon="i-lucide-sunset"
            class="w-32"
            :disabled="peakSaver.saving"
          />
        </UFormField>
        <UFormField label="Peak multiplier" name="peakMultiplier" class="min-w-40">
          <template #hint
            ><FormHint
              text="In-window cap factor: each agent runs floor(tasks per agent × this) during peak. 1 = no throttling, 0 = pause new dispatches"
          /></template>
          <UInput
            v-model.number="peakForm.peakMultiplier"
            type="number"
            :min="0"
            :max="1"
            :step="0.1"
            icon="i-lucide-gauge"
            class="w-32"
            :disabled="peakSaver.saving"
          />
        </UFormField>
        <UButton
          type="submit"
          icon="i-lucide-save"
          color="neutral"
          variant="soft"
          :loading="peakSaver.saving"
          :disabled="!settingsLive.isSuccess.value"
          >Save peak cadence</UButton
        >
        <span
          v-if="peakSaver.message"
          class="pb-2 text-xs"
          :class="peakSaver.ok ? 'text-success' : 'text-error'"
          :role="peakSaver.ok ? 'status' : 'alert'"
          >{{ peakSaver.message }}</span
        >
      </UForm>

      <USeparator class="my-5" />

      <div>
        <h3 class="pb-1 text-sm font-medium">Decision engine (auto-assign)</h3>
        <p class="text-muted pb-2 text-xs">
          Picks which employee takes a task. Provider must offer a decision-compatible endpoint.
        </p>
        <UForm
          :state="decisionForm"
          :schema="assignmentSchema"
          class="flex flex-col gap-3"
          @submit="saveAssignment('internalDecision')"
        >
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
              create-item
              icon="i-lucide-cpu"
              placeholder="e.g. claude-sonnet"
              class="w-full"
              :disabled="decisionSaving"
            />
          </UFormField>
          <UButton
            type="submit"
            icon="i-lucide-save"
            :loading="decisionSaving"
            :disabled="!settingsLive.isSuccess.value"
            class="self-start"
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
        <h3 class="pb-1 text-sm font-medium">Internal LLM</h3>
        <p class="text-muted pb-2 text-xs">
          Used by Tandem's own server-side features. Provider must offer an LLM-compatible endpoint. Not sent to agents.
        </p>
        <UForm
          :state="llmForm"
          :schema="assignmentSchema"
          class="flex flex-col gap-3"
          @submit="saveAssignment('internalLlm')"
        >
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
              create-item
              icon="i-lucide-cpu"
              placeholder="e.g. gpt-5.2"
              class="w-full"
              :disabled="llmSaving"
            />
          </UFormField>
          <UButton
            type="submit"
            icon="i-lucide-save"
            :loading="llmSaving"
            :disabled="!settingsLive.isSuccess.value"
            class="self-start"
            >Save internal LLM</UButton
          >
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
    </template>
  </UCard>
</template>
