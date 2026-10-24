<script setup lang="ts">
// Authentication card: OIDC provider table + add/edit editor (no v-model over
// v-for aliases — the dxup page transform breaks that pattern; pathbridge
// table+modal law) and the password-login policy switch. Self-loading — shares
// the providers/settings query keys with the rest of the app (the switch locks
// until a provider exists; shared cache, no prop drilling).
import { useQuery } from '@tanstack/vue-query';

import { CHANGE_RESOURCE } from '#shared/enums';

const { $orpc, $client } = useNuxtApp();

interface OidcProviderRow {
  id: string;
  label: string;
  issuer: string;
  clientId: string;
  secretSet: boolean;
}

const oidcLive = useQuery($orpc.oidc.list.queryOptions({ queryKey: [CHANGE_RESOURCE.OIDC] }));
const providersLive = useQuery($orpc.providers.list.queryOptions({ queryKey: [CHANGE_RESOURCE.PROVIDERS] }));
const providerRows = computed(() => unref(providersLive.data) ?? []);
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
watch(
  () => unref(settingsLive.data),
  (d) => {
    if (d) {
      disablePasswordLogin.value = (d as { disablePasswordLogin: boolean }).disablePasswordLogin;
    }
  },
  { immediate: true },
);

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
  Promise.all([oidcLive.suspense(), providersLive.suspense(), settingsLive.suspense()]),
);
</script>

<template>
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
              providerRows.length === 0
                ? 'Cannot be disabled until an OIDC provider is configured.'
                : 'Turn off to require single sign-on.'
            }}
          </p>
        </div>
        <USwitch
          :model-value="!disablePasswordLogin"
          :disabled="providerRows.length === 0"
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
</template>
