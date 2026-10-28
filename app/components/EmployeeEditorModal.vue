<script setup lang="ts">
// Employee create/edit editor: owns identity + AI-extension form state, the
// avatar pick+downscale pipeline, its catalog loaders (titles, environments,
// providers, vault secrets) and the one-time minted-key alert — the modal
// stays open while the key is on screen. null employee = create mode; emits
// `saved` after a successful write.
import { useMutation, useQuery } from '@tanstack/vue-query';
import { computed, reactive, ref, watch } from 'vue';
import { z } from 'zod';

import { PROVIDER_KIND, endpointKind, isModelsEndpoint } from '#shared/api-styles';
import { CHANGE_RESOURCE } from '#shared/enums';
import { nonNull } from '#shared/utils/non-null';
import { employeeAvatarUrl } from '~/utils/api-urls';
import { NONE_ID, saveFailed } from '~/utils/forms';
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
const byId = computed(() => new Map(props.rows.map((r) => [r.id, r])));
const editingIsAi = computed(() => (editingId.value ? byId.value.get(editingId.value)?.kind === 'ai' : false));
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

// seeding on open — the page's openEditor body, driven by the controlled props
watch([open, () => props.employee], ([o, emp]) => {
  if (!o) return;
  const row = emp ?? undefined;
  editingId.value = row?.id ?? null;
  applyIdentityToForm(row);
  applyAiExtensionToForm(row);
  form.image = null;
  avatarDirty.value = false;
  syncAvatarPreview(row);
  message.value = '';
  mintedKey.value = '';
});

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
const titleSaveMutation = useMutation({ ...$orpc.employees.titles.save.mutationOptions() });

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
</script>

<template>
  <UModal
    v-model:open="open"
    :title="isEdit ? 'Edit employee' : 'New employee'"
    :dismissible="!mintedKey"
    :close="!mintedKey"
    :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }"
  >
    <template #body>
      <UForm id="employee-editor-form" :schema="employeeFormSchema" :state="form" class="space-y-4" @submit="save">
        <UFormField name="name">
          <template #label> Name </template>
          <template #hint>
            <FormHint text="Shown across tasks, runs and the org graph" />
          </template>
          <UInput v-model="form.name" icon="i-lucide-user" placeholder="Full name" class="w-full" required />
        </UFormField>
        <UFormField name="email">
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
            required
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
              class="border-default hover:bg-elevated text-highlighted inline-flex w-fit shrink-0 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium"
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
            <FormHint text="Place in the company, e.g. Senior Engineer" />
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
