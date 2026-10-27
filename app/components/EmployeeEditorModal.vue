<script setup lang="ts">
// Employee create/edit editor: owns identity + AI-extension form state, the
// avatar pick+downscale pipeline, its catalog loaders (titles, environments,
// providers, vault secrets) and the one-time minted-key alert — the modal
// stays open while the key is on screen. null employee = create mode; emits
// `saved` after a successful write.
import { useMutation, useQuery } from '@tanstack/vue-query';
import { computed, reactive, ref, watch } from 'vue';

import { PROVIDER_KIND, endpointKind, isModelsEndpoint } from '#shared/api-styles';
import { CHANGE_RESOURCE } from '#shared/enums';
import { nonNull } from '#shared/utils/non-null';
import type { EmployeeRow, EnvironmentRow } from '~/utils/orpc-types';
import type { SecretOption } from '~/utils/vault-options';
import { groupedSecretOptions } from '~/utils/vault-options';

const open = defineModel<boolean>('open', { default: false });
const props = defineProps<{ employee: EmployeeRow | null; rows: EmployeeRow[] }>();
const emit = defineEmits<{ saved: [] }>();

const { $orpc, $client } = useNuxtApp();

const titlesQuery = useQuery(
  $orpc.employees.titles.list.queryOptions({ queryKey: [CHANGE_RESOURCE.EMPLOYEES, 'titles'] }),
);
const titles = computed(
  () =>
    (titlesQuery.data.value as { titles: Array<{ id: string; name: string; employees: number }> } | undefined)
      ?.titles ?? [],
);

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
  environmentId: '__none__' as string,
  instructions: '',
  executable: '',
  providerId: '__none__' as string,
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
  [() => form.providerId, () => form.apiKeySecretId],
  async ([providerId, keySecretId]) => {
    modelItems.value = [];
    if (providerId === '__none__' || !providerHasModelsEndpoint.value) return;
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
  { immediate: false },
);
// vault secret picker: a single page caps at 100 rows and silently hides the
// rest of the vault, so walk pages up to `total` (shared [VAULT, 'all'] cache)
const secretsLive = useQuery({
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
const secretItems = computed<SecretOption[]>(() =>
  groupedSecretOptions(
    (unref(secretsLive.data) ?? []) as Array<{
      id: string;
      name: string;
      lastFour: string;
      folder: string | null;
    }>,
  ),
);

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
  form.environmentId = row?.environmentId ?? '__none__';
  form.instructions = row?.instructions ?? '';
  form.executable = row?.executable ?? '';
  form.providerId = row?.providerId ?? '__none__';
  form.model = row?.model ?? '';
  form.apiKeySecretId = row?.apiKeySecretId ?? null;
}

/** existing avatar only enters the form as the preview src; not re-uploaded unless replaced */
function syncAvatarPreview(row: EmployeeRow | undefined) {
  avatarUrl.value = row?.hasAvatar ? `/api/employees/${row.id}/avatar` : null;
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

/** AI create/edit requires an ACP executable before hitting the API */
function aiNeedsExecutable() {
  return (editingId.value ? showAiFields.value : form.kind === 'ai') && !form.executable.trim();
}

/** update call payload — avatar only when freshly picked, AI fields only when shown */
function updateInput() {
  return {
    id: nonNull(editingId.value),
    name: form.name,
    email: form.email,
    ...(avatarDirty.value ? { image: form.image } : {}),
    title: form.title,
    supervisorIds: form.supervisorIds,
    ...(showAiFields.value ? { environmentId: form.environmentId === '__none__' ? null : form.environmentId } : {}),
    ...(showAiFields.value ? { instructions: form.instructions } : {}),
    ...(showAiFields.value ? { executable: form.executable.trim() } : {}),
    ...(showAiFields.value ? { providerId: form.providerId === '__none__' ? null : form.providerId } : {}),
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
          ...(form.environmentId !== '__none__' ? { environmentId: form.environmentId } : {}),
          instructions: form.instructions,
          executable: form.executable.trim(),
          providerId: form.providerId === '__none__' ? null : form.providerId,
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
  busy.value = true;
  message.value = '';
  try {
    if (aiNeedsExecutable()) {
      message.value = 'AI employees need an ACP executable (e.g. "hermes acp")';
      busy.value = false;
      return;
    }
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
    emit('saved');
    if (!mintedKey.value) open.value = false;
  } catch (e) {
    message.value = e instanceof Error ? e.message : 'Save failed.';
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
    :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }"
  >
    <template #body>
      <UForm id="employee-editor-form" :state="form" class="space-y-4" @submit="save">
        <UFormField label="Name" name="name">
          <UInput v-model="form.name" icon="i-lucide-user" placeholder="Full name" class="w-full" required />
        </UFormField>
        <UFormField label="Email (login)" name="email">
          <template #hint><FormHint text="Humans sign in with it; AI employees authenticate by API key" /></template>
          <UInput
            v-model="form.email"
            type="email"
            icon="i-lucide-at-sign"
            placeholder="name@company.com"
            class="w-full"
            required
          />
        </UFormField>
        <UFormField label="Avatar" name="avatar">
          <template #hint><FormHint text="square photo, resized to 256px" /></template>
          <div class="flex items-center gap-3">
            <span
              class="bg-elevated text-muted inline-flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-full text-lg font-semibold"
            >
              <img v-if="form.image" :src="form.image" alt="avatar preview" class="size-12 rounded-full object-cover" />
              <img
                v-else-if="avatarUrl"
                :src="avatarUrl"
                alt="avatar preview"
                class="size-12 rounded-full object-cover"
              />
              <template v-else>{{ form.kind === 'ai' ? 'AI' : form.name.slice(0, 1) || '?' }}</template>
            </span>
            <label
              class="border-default hover:bg-elevated/50 text-highlighted flex flex-1 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm font-medium"
            >
              <UIcon name="i-lucide-image-up" class="size-4 shrink-0" />
              <span class="truncate">Choose image</span>
              <input
                type="file"
                accept="image/*"
                class="sr-only"
                aria-label="Choose avatar image"
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
        <UFormField v-if="!isEdit" label="Kind" name="kind">
          <URadioGroup
            v-model="form.kind"
            :items="[
              { label: 'Human — password/SSO login', value: 'human' },
              { label: 'AI agent — API key, runs on an environment', value: 'ai' },
            ]"
            variant="card"
            class="w-full"
          />
        </UFormField>
        <UFormField v-else name="kind">
          <UBadge
            :color="editingIsAi ? 'primary' : 'neutral'"
            variant="subtle"
            :icon="editingIsAi ? 'i-lucide-bot' : 'i-lucide-user'"
          >
            {{ editingIsAi ? 'AI agent (immutable)' : 'Human (immutable)' }}
          </UBadge>
        </UFormField>
        <UFormField label="Title" name="title">
          <template #hint><FormHint text="Place in the company, e.g. Senior Engineer" /></template>
          <AutoCompleteInput
            v-model="form.title"
            :items="titles.map((t) => t.name)"
            icon="i-lucide-briefcase"
            placeholder="Job title"
            create-hint="A new title will be added to the catalog"
            :disabled="busy"
          />
        </UFormField>
        <UFormField label="Supervisors" name="supervisorIds">
          <template #hint><FormHint text="Many-to-many — an employee can report to several" /></template>
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
          <UFormField label="Environment" name="environmentId">
            <template #hint><FormHint text="SSH target this agent runs on" /></template>
            <USelectMenu
              v-model="form.environmentId"
              :items="[{ label: 'No environment', value: '__none__' }, ...environmentItems]"
              value-key="value"
              placeholder="Select an environment"
              class="w-full"
            />
          </UFormField>
          <UFormField label="ACP executable" name="executable" required>
            <template #hint><FormHint text="Command that starts an ACP server on stdio in the environment" /></template>
            <UInput
              v-model="form.executable"
              icon="i-lucide-terminal"
              placeholder="hermes acp"
              class="w-full"
              data-testid="acp-executable-input"
            />
          </UFormField>
          <UFormField label="Provider" name="providerId">
            <template #hint><FormHint text="Model endpoint this agent uses" /></template>
            <USelect
              v-model="form.providerId"
              :items="[
                { label: 'No provider', value: '__none__' },
                ...modelProviders.map((p) => ({ label: p.label, value: p.id })),
              ]"
              value-key="value"
              icon="i-lucide-plug"
              placeholder="Select a provider"
              class="w-full"
            />
          </UFormField>
          <UFormField label="Model" name="model">
            <template #hint
              ><FormHint text="Model name the agent runs — pick from the list or type your own"
            /></template>
            <UInputMenu
              v-model="form.model"
              :items="modelItems"
              :loading="modelLoading"
              icon="i-lucide-cpu"
              placeholder="Model name"
              class="w-full"
            />
          </UFormField>
          <UFormField label="API key" name="apiKeySecretId">
            <template #hint><FormHint text="Vault secret holding the key (per-agent, injected per run)" /></template>
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
          <UFormField label="Instructions" name="instructions">
            <template #hint><FormHint text="System prompt for this agent" /></template>
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
            API key created — shown only once
          </p>
          <p class="text-muted mt-1 text-xs">Copy it now; it cannot be retrieved later.</p>
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
            label="Done — I saved the key"
            @click="open = false"
          />
        </div>
      </UForm>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
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
