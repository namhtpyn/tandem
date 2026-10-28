<script setup lang="ts">
// Model providers card: the LLM/decision endpoint catalog (mobile cards +
// desktop table) with a single add/edit modal. Self-loading — owns the
// providers.list query (shared key: the General card's pickers and the auth
// policy read the same cache) and the save/remove mutations.
import { useQuery } from '@tanstack/vue-query';

import { ENDPOINT_OPTIONS, PROVIDER_ENDPOINT_LABEL, isModelsEndpoint } from '#shared/api-styles';
import { CHANGE_RESOURCE } from '#shared/enums';
import { nonNull } from '#shared/utils/non-null';
import { errorMessage } from '~/utils/forms';
import type { ModelProviderRow, ProviderSaveInput } from '~/utils/orpc-types';
import { endpointBadgeColor } from '~/utils/ui-labels';

const { $orpc, $client } = useNuxtApp();

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
    // one 'Name: value' per line — split on the FIRST ':' only, so values with
    // colons (https:// URLs, timestamps) survive; unparsable lines are skipped
    const headers = mProvForm.extraHeaders.trim()
      ? Object.fromEntries(
          mProvForm.extraHeaders
            .split('\n')
            .map((l) => {
              const idx = l.indexOf(':');
              return idx > 0 ? ([l.slice(0, idx).trim(), l.slice(idx + 1).trim()] as const) : null;
            })
            .filter((p): p is readonly [string, string] => p !== null),
        )
      : undefined;
    await $client.providers.save({
      ...(mProvEditingId.value ? { id: mProvEditingId.value } : {}),
      label: mProvForm.label,
      baseUrl: mProvForm.baseUrl,
      endpoints: mProvForm.endpoints as ProviderSaveInput['endpoints'],
      // always send notes ('' clears) and extraHeaders only when present — an
      // omitted extraHeaders is the server's explicit clear; both fields keep
      // their value across an edit that never touched them
      ...(headers && Object.keys(headers).length ? { extraHeaders: headers } : {}),
      notes: mProvForm.notes,
    });
    mProvEditorOpen.value = false;
  } catch (e) {
    mProvMessage.value = errorMessage(e, 'Save failed');
  } finally {
    mProvBusy.value = false;
  }
}

const pendingRemove = ref<ModelProviderRow | null>(null);
const removeOpen = computed({
  get: () => pendingRemove.value !== null,
  set: (v: boolean) => {
    if (!v) pendingRemove.value = null;
  },
});

async function removeMProv() {
  if (!pendingRemove.value) return;
  mProvBusy.value = true;
  mProvMessage.value = '';
  try {
    await $client.providers.remove({ id: pendingRemove.value.id });
    pendingRemove.value = null;
  } catch (e) {
    // close the confirm so the message renders on the card, not behind the modal
    pendingRemove.value = null;
    mProvMessage.value = errorMessage(e, 'Delete failed');
  } finally {
    mProvBusy.value = false;
  }
}

onServerPrefetch(() => providersLive.suspense());
</script>

<template>
  <UCard :ui="{ root: 'shadow-sm' }">
    <template #header>
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-cpu" class="text-dimmed size-4" />
        <h2 class="text-highlighted text-sm font-semibold">Model providers</h2>
      </div>
    </template>
    <div class="space-y-5">
      <div>
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h4 class="text-highlighted text-sm font-semibold">Catalog</h4>
          <UButton icon="i-lucide-plus" size="sm" label="Add provider" @click="openMProvEditor()" />
        </div>
        <!-- Mobile: stacked cards -->
        <div v-if="mProvList.length" class="space-y-3 md:hidden">
          <UCard v-for="p in mProvList" :key="p.id" :ui="{ root: 'shadow-sm' }">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <p class="text-highlighted truncate text-sm font-medium">{{ p.label }}</p>
                <p class="text-dimmed truncate font-mono text-xs">{{ p.baseUrl }}</p>
              </div>
              <UBadge
                v-for="st in p.endpoints"
                :key="st"
                :color="endpointBadgeColor(st)"
                variant="subtle"
                size="sm"
                class="max-w-52 truncate"
                >{{
                  (PROVIDER_ENDPOINT_LABEL[st as keyof typeof PROVIDER_ENDPOINT_LABEL] ?? st).split(' (')[0]
                }}</UBadge
              >
            </div>
            <div class="mt-3 flex justify-end gap-1">
              <UPopover mode="hover" enable-touch>
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
              <UPopover mode="hover" enable-touch>
                <UButton
                  icon="i-lucide-trash-2"
                  variant="ghost"
                  color="neutral"
                  class="text-muted hover:text-error"
                  size="sm"
                  aria-label="Delete provider"
                  :disabled="mProvBusy"
                  @click="pendingRemove = p"
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
                <p class="text-highlighted flex items-center gap-2 truncate font-medium">
                  {{ row.original.label }}
                  <UBadge
                    v-for="st in row.original.endpoints"
                    :key="st"
                    :color="endpointBadgeColor(st)"
                    variant="subtle"
                    size="sm"
                    class="max-w-52 truncate"
                    >{{
                      (PROVIDER_ENDPOINT_LABEL[st as keyof typeof PROVIDER_ENDPOINT_LABEL] ?? st).split(' (')[0]
                    }}</UBadge
                  >
                </p>
                <p class="text-dimmed truncate font-mono text-xs">{{ row.original.baseUrl }}</p>
              </div>
            </template>
            <template #actions-cell="{ row }">
              <div class="flex justify-end gap-1">
                <UPopover mode="hover" enable-touch>
                  <UButton
                    icon="i-lucide-pencil"
                    variant="ghost"
                    color="neutral"
                    size="sm"
                    aria-label="Edit provider"
                    @click="openMProvEditor(row.original)"
                  />
                  <template #content>
                    <div class="px-3 py-1.5 text-xs">Edit provider</div>
                  </template>
                </UPopover>
                <UPopover mode="hover" enable-touch>
                  <UButton
                    icon="i-lucide-trash-2"
                    variant="ghost"
                    color="neutral"
                    class="text-muted hover:text-error"
                    size="sm"
                    aria-label="Delete provider"
                    :disabled="mProvBusy"
                    @click="pendingRemove = row.original"
                  />
                  <template #content>
                    <div class="px-3 py-1.5 text-xs">Delete provider</div>
                  </template>
                </UPopover>
              </div>
            </template>
          </UTable>
        </UCard>
        <p v-if="mProvMessage" class="text-error mt-2 text-sm" role="alert">{{ mProvMessage }}</p>
        <!-- pending: skeleton cards (mobile) + rows (desktop) before any empty copy -->
        <template v-else-if="providersLive.isPending.value">
          <div class="space-y-3 md:hidden" aria-hidden="true">
            <USkeleton class="h-24 w-full rounded-lg" />
            <USkeleton class="h-24 w-full rounded-lg" />
          </div>
          <UCard class="hidden md:block" :ui="{ root: 'shadow-sm', body: 'p-0 sm:p-0' }">
            <div class="space-y-2 p-4" aria-hidden="true">
              <USkeleton class="h-8 w-full rounded" />
              <USkeleton class="h-8 w-3/4 rounded" />
            </div>
          </UCard>
        </template>
        <p v-else-if="providersLive.isError.value" role="alert" class="text-error py-4 text-center text-sm">
          Couldn't load providers
        </p>
        <div
          v-else-if="!mProvList.length"
          class="border-default flex flex-col items-center gap-3 rounded-xl border border-dashed p-8 text-center"
        >
          <UIcon name="i-lucide-cpu" class="text-toned size-10" aria-hidden="true" />
          <p class="text-muted text-sm">No providers yet — add one to power agents and auto-assign.</p>
          <UButton icon="i-lucide-plus" size="sm" label="Add provider" @click="openMProvEditor()" />
        </div>
      </div>
    </div>
  </UCard>

  <!-- model provider editor -->
  <UModal
    v-model:open="mProvEditorOpen"
    :title="mProvEditingId ? 'Edit provider' : 'Add provider'"
    :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }"
  >
    <template #body>
      <UForm id="provider-editor-form" :state="mProvForm" class="space-y-4" @submit="saveMProv">
        <UFormField label="Label" name="label">
          <UInput v-model="mProvForm.label" icon="i-lucide-tag" placeholder="Provider name" class="w-full" required />
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
                  :color="endpointBadgeColor(String(ep))"
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
        <p v-if="mProvMessage" role="alert" class="text-error text-sm">{{ mProvMessage }}</p>
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

  <!-- delete confirm (same pattern as the vault/environment delete confirms) -->
  <UModal v-model:open="removeOpen" title="Delete provider">
    <template #body>
      <div class="space-y-4">
        <p class="text-muted text-sm">
          Delete provider
          <span class="text-highlighted font-semibold">{{ pendingRemove?.label }}</span
          >? Agents using it will stop working until you pick a new provider.
        </p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" color="neutral" label="Cancel" @click="pendingRemove = null" />
        <UButton icon="i-lucide-trash-2" color="error" label="Delete" :loading="mProvBusy" @click="removeMProv" />
      </div>
    </template>
  </UModal>
</template>
