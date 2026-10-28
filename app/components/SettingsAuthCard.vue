<script setup lang="ts">
// Authentication card: OIDC provider table + add/edit editor (no v-model over
// v-for aliases — the dxup page transform breaks that pattern; pathbridge
// table+modal law) and the password-login policy switch. Self-loading — shares
// the oidc/settings query keys with the rest of the app (the switch locks until
// an OIDC provider exists; shared cache, no prop drilling).
import { useQuery } from '@tanstack/vue-query';

import { CHANGE_RESOURCE } from '#shared/enums';
import { errorMessage } from '~/utils/forms';

const { $orpc, $client } = useNuxtApp();

type OidcProviderRow = {
  id: string;
  label: string;
  issuer: string;
  clientId: string;
  secretSet: boolean;
};

const oidcLive = useQuery($orpc.oidc.list.queryOptions({ queryKey: [CHANGE_RESOURCE.OIDC] }));
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
const messageOk = ref(false);
// editor-save errors render INSIDE the open editor modal — the card-level <p>
// sits behind it and would never be seen
const editorError = ref('');

const editorOpen = ref(false);
const editingId = ref<string | null>(null);
const form = reactive({ label: '', issuer: '', clientId: '', clientSecret: '' });

// SSR-safe: window.location during setup hydrates a different string on the client
const publicOrigin = useRequestURL().origin;

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
  message.value = '';
  editorError.value = '';
  editorOpen.value = true;
}

async function saveProvider() {
  busy.value = true;
  message.value = '';
  editorError.value = '';
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
    // the editor modal stays open — render the failure where the user is
    editorError.value = errorMessage(e, 'Save failed');
  } finally {
    busy.value = false;
  }
}

const pendingRemove = ref<OidcProviderRow | null>(null);
const removeOpen = computed({
  get: () => pendingRemove.value !== null,
  set: (v: boolean) => {
    if (!v) pendingRemove.value = null;
  },
});

async function removeProvider() {
  if (!pendingRemove.value) return;
  busy.value = true;
  message.value = '';
  try {
    const list = providers.value
      .filter((p) => p.id !== pendingRemove.value?.id)
      .map((p) => ({ id: p.id, label: p.label, issuer: p.issuer, clientId: p.clientId }));
    await $client.oidc.replace({ providers: list });
    pendingRemove.value = null;
  } catch (e) {
    // mirror SettingsProvidersCard: close the confirm so the card-level
    // message renders on the card, not behind the modal
    pendingRemove.value = null;
    message.value = errorMessage(e, 'Delete failed');
    messageOk.value = false;
  } finally {
    busy.value = false;
  }
}

async function savePasswordPolicy(next: boolean) {
  const previous = disablePasswordLogin.value;
  disablePasswordLogin.value = next;
  busy.value = true;
  message.value = '';
  try {
    await $client.settings.update({ disablePasswordLogin: next });
    message.value = 'Saved';
    messageOk.value = true;
  } catch (e) {
    // nothing refetches after a failed write — put the switch back where it was
    disablePasswordLogin.value = previous;
    message.value = errorMessage(e, 'Save failed');
    messageOk.value = false;
  } finally {
    busy.value = false;
  }
}

onServerPrefetch(() => Promise.all([oidcLive.suspense(), settingsLive.suspense()]));
</script>

<template>
  <UCard :ui="{ root: 'shadow-sm' }">
    <template #header>
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-key-round" class="text-dimmed size-4" />
        <h2 class="text-highlighted text-sm font-semibold">Authentication</h2>
      </div>
    </template>
    <div class="space-y-5">
      <div>
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h4 class="text-highlighted text-sm font-semibold">OIDC providers</h4>
          <UButton icon="i-lucide-plus" size="sm" label="Add provider" @click="openEditor()" />
        </div>
        <template v-if="oidcLive.isPending.value">
          <div class="space-y-2" aria-hidden="true">
            <USkeleton class="h-12 w-full rounded-lg" />
            <USkeleton class="h-12 w-full rounded-lg" />
          </div>
        </template>
        <p v-else-if="oidcLive.isError.value" role="alert" class="text-error text-sm">Couldn't load OIDC providers</p>
        <template v-else-if="providers.length">
          <UCard :ui="{ root: 'shadow-sm', body: 'p-0 sm:p-0' }">
            <UTable :data="providers" :columns="providerColumns">
              <template #label-cell="{ row }">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-highlighted text-sm font-medium">{{ row.original.label }}</span>
                  <UBadge v-if="!row.original.secretSet" variant="subtle" color="warning" size="sm"
                    >Client secret not set</UBadge
                  >
                </div>
              </template>
              <template #callback-cell="{ row }">
                <span class="text-muted block font-mono text-xs break-all"
                  >{{ publicOrigin }}/auth/callback/{{ row.original.id }}</span
                >
              </template>
              <template #actions-cell="{ row }">
                <div class="flex justify-end gap-2">
                  <UPopover mode="hover" enable-touch>
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
                  <UPopover mode="hover" enable-touch>
                    <UButton
                      icon="i-lucide-trash-2"
                      variant="ghost"
                      color="neutral"
                      class="text-muted hover:text-error"
                      size="sm"
                      aria-label="Delete provider"
                      :disabled="busy"
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
          <p class="text-dimmed mt-2 text-xs">Register each callback URL above with its identity provider.</p>
        </template>
        <div v-else class="border-default rounded-xl border border-dashed p-8 text-center">
          <p class="text-muted text-sm">No OIDC providers yet — add one to enable single sign-on.</p>
        </div>
      </div>

      <USeparator />

      <div class="flex items-center justify-between gap-4">
        <div>
          <p class="text-highlighted text-sm font-medium">
            Password login
            <UBadge v-if="!disablePasswordLogin" color="success" variant="subtle" size="sm">Enabled</UBadge>
            <UBadge v-else color="warning" variant="subtle" size="sm">Disabled (SSO only)</UBadge>
          </p>
          <p class="text-dimmed text-xs">
            {{
              !oidcLive.isSuccess.value
                ? 'Checking providers…'
                : providers.length === 0
                  ? 'Cannot be disabled until an OIDC provider is configured.'
                  : 'Turn off to require single sign-on.'
            }}
          </p>
        </div>
        <USwitch
          aria-label="Password login"
          :model-value="!disablePasswordLogin"
          :disabled="!oidcLive.isSuccess.value || providers.length === 0 || busy"
          @update:model-value="(v: boolean) => savePasswordPolicy(!v)"
        />
      </div>
    </div>
    <p
      v-if="message"
      :role="messageOk ? 'status' : 'alert'"
      class="mt-3 text-sm"
      :class="messageOk ? 'text-success' : 'text-error'"
    >
      {{ message }}
    </p>
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
        <UFormField name="label" label="Name" required>
          <template #hint><FormHint text="Shown on the login button" /></template>
          <UInput v-model="form.label" icon="i-lucide-tag" class="w-full" placeholder="Display name" />
        </UFormField>
        <UFormField name="issuer" label="Issuer URL" required>
          <UInput v-model="form.issuer" icon="i-lucide-globe" class="w-full" placeholder="https://issuer-url" />
        </UFormField>
        <UFormField name="clientId" label="Client ID" required>
          <UInput v-model="form.clientId" class="w-full" placeholder="Client ID" />
        </UFormField>
        <UFormField
          name="clientSecret"
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
        <UAlert
          v-if="editorError"
          icon="i-lucide-circle-alert"
          color="error"
          variant="subtle"
          :title="editorError"
          :ui="{ title: 'text-sm' }"
        />
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
          :icon="editingId ? 'i-lucide-check' : 'i-lucide-plus'"
          :loading="busy"
          :label="editingId ? 'Save changes' : 'Add provider'"
          form="oidc-editor-form"
        />
      </div>
    </template>
  </UModal>

  <!-- delete confirm (same pattern as the vault/environment delete confirms) -->
  <UModal v-model:open="removeOpen" title="Delete provider">
    <template #body>
      <div class="space-y-4">
        <p class="text-muted text-sm">
          Delete OIDC provider
          <span class="text-highlighted font-semibold">{{ pendingRemove?.label }}</span
          >? Anyone signing in through it loses that login option immediately.
        </p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" color="neutral" label="Cancel" @click="pendingRemove = null" />
        <UButton icon="i-lucide-trash-2" color="error" label="Delete" :loading="busy" @click="removeProvider" />
      </div>
    </template>
  </UModal>
</template>
