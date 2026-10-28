<script setup lang="ts">
// Authentication card: OIDC provider table + add/edit editor (no v-model over
// v-for aliases — the dxup page transform breaks that pattern; pathbridge
// table+modal law) and the password-login policy switch. Self-loading — shares
// the oidc/settings query keys with the rest of the app (the switch locks until
// an OIDC provider exists; shared cache, no prop drilling).
import { useQuery } from '@tanstack/vue-query';
import { z } from 'zod';

import { CHANGE_RESOURCE } from '#shared/enums';
import { saveFailed } from '~/utils/forms';

const { $orpc, $client } = useNuxtApp();

// oidc.list row shape (orpc-types.ts belongs to another batch — local alias,
// derived from the procedure output rather than a hand-written double cast)
type OidcProviderRow = {
  id: string;
  label: string;
  issuer: string;
  clientId: string;
  hasSecret: boolean;
};

const oidcLive = useQuery($orpc.oidc.list.queryOptions({ queryKey: [CHANGE_RESOURCE.OIDC] }));
const settingsLive = useQuery($orpc.settings.list.queryOptions({ queryKey: [CHANGE_RESOURCE.SETTINGS] }));

const providers = computed(() => (unref(oidcLive.data) ?? []).map((p) => ({ ...p, secretSet: p.hasSecret })));

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
// loose frontend schema (repo law): presence only. The stored secret is kept
// when the field is left blank on an EDIT, but a NEW provider cannot sign in
// without one — create-mode requires it (computed: editingId flips the rule).
const oidcSchema = computed(() =>
  z
    .object({
      label: z.string().trim().min(1, 'Name is required'),
      issuer: z.string().trim().min(1, 'Issuer URL is required'),
      clientId: z.string().trim().min(1, 'Client ID is required'),
      clientSecret: z.string(),
    })
    .superRefine((v, ctx) => {
      if (!editingId.value && !v.clientSecret.trim()) {
        ctx.addIssue({ code: 'custom', path: ['clientSecret'], message: 'Client secret is required' });
      }
    }),
);

// SSR-safe: window.location during setup hydrates a different string on the client
const publicOrigin = useRequestURL().origin;

const providerColumns = [
  { accessorKey: 'label', header: 'Provider' },
  { accessorKey: 'issuer', header: 'Issuer' },
  { accessorKey: 'clientId', header: 'Client ID' },
  { accessorKey: 'callback', header: 'Callback URL' },
  { id: 'actions', header: 'Actions', meta: { class: { th: 'sr-only' } } },
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
  // one write at a time — a double-click or stray Enter must not double-create
  if (busy.value) return;
  // the registry write is a REPLACE-ALL: it is only safe when the current list
  // is actually on screen. Saving from a pending/failed list would send just
  // this one provider and wipe every other — an auth lockout.
  if (!oidcLive.isSuccess.value) {
    editorError.value = "Providers haven't loaded — close this, load the list, then try again.";
    return;
  }
  if (editingId.value && !providers.value.some((p) => p.id === editingId.value)) {
    editorError.value = 'That provider is no longer in the list — reload and try again.';
    return;
  }
  busy.value = true;
  message.value = '';
  editorError.value = '';
  try {
    const list: Array<{
      id: string | undefined;
      label: string;
      issuer: string;
      clientId: string;
      clientSecret?: string;
    }> = providers.value
      .filter((p) => p.id !== editingId.value)
      .map((p) => ({ id: p.id, label: p.label, issuer: p.issuer, clientId: p.clientId }));
    list.push({
      id: editingId.value ?? undefined,
      label: form.label.trim(),
      issuer: form.issuer.trim(),
      clientId: form.clientId.trim(),
      ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}),
    });
    await $client.oidc.replace({ providers: list });
    editorOpen.value = false;
  } catch (e) {
    // the editor modal stays open — render the failure where the user is
    editorError.value = saveFailed(e, 'provider');
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
const removeError = ref('');

function askRemove(row: OidcProviderRow) {
  removeError.value = '';
  pendingRemove.value = row;
}

async function removeProvider() {
  if (!pendingRemove.value) return;
  // same replace-all hazard as save: never write a registry built from a list
  // that hasn't loaded
  if (!oidcLive.isSuccess.value) {
    removeError.value = "Providers haven't loaded — close this, load the list, then try again.";
    return;
  }
  if (!providers.value.some((p) => p.id === pendingRemove.value?.id)) {
    removeError.value = 'That provider is no longer in the list — reload and try again.';
    return;
  }
  busy.value = true;
  try {
    const list = providers.value
      .filter((p) => p.id !== pendingRemove.value?.id)
      .map((p) => ({ id: p.id, label: p.label, issuer: p.issuer, clientId: p.clientId }));
    await $client.oidc.replace({ providers: list });
    pendingRemove.value = null;
  } catch (e) {
    // in-modal law: the confirm stays open, the failure renders inside it
    removeError.value = saveFailed(e, 'provider', 'delete');
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
    message.value = saveFailed(e, 'settings');
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
          <h3 class="text-highlighted text-sm font-semibold">OIDC providers</h3>
          <UButton
            v-if="oidcLive.isSuccess.value"
            icon="i-lucide-plus"
            size="sm"
            label="New identity provider"
            @click="openEditor()"
          />
        </div>
        <template v-if="oidcLive.isPending.value">
          <div class="space-y-2" aria-hidden="true">
            <USkeleton class="h-12 w-full rounded-lg" />
            <USkeleton class="h-12 w-full rounded-lg" />
          </div>
        </template>
        <!-- the registry is replaced wholesale on save: while the list is not
             loaded, creating/removing is blocked and explained here -->
        <div
          v-else-if="oidcLive.isError.value"
          role="alert"
          class="border-error/40 bg-error/10 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
        >
          <UIcon name="i-lucide-circle-alert" class="text-error size-4 shrink-0" aria-hidden="true" />
          <span class="text-error flex-1 text-sm">
            Couldn't load OIDC providers — saving is blocked until they load.
          </span>
          <UButton
            size="xs"
            color="error"
            variant="subtle"
            icon="i-lucide-rotate-cw"
            label="Try again"
            @click="oidcLive.refetch()"
          />
        </div>
        <template v-else-if="providers.length">
          <!-- Mobile: stacked cards (the 5-column table overflows a phone) -->
          <div class="space-y-3 md:hidden">
            <UCard v-for="p in providers" :key="p.id" :ui="{ root: 'shadow-sm' }">
              <div class="min-w-0">
                <p class="text-highlighted flex flex-wrap items-center gap-2 text-sm font-medium">
                  {{ p.label }}
                  <UBadge v-if="!p.secretSet" variant="subtle" color="warning" size="sm">Client secret not set</UBadge>
                </p>
                <p class="text-muted mt-1 truncate font-mono text-xs">{{ p.issuer }}</p>
                <p class="text-dimmed truncate font-mono text-xs">ID {{ p.clientId }}</p>
                <p class="text-muted mt-1 font-mono text-xs break-all">{{ publicOrigin }}/auth/callback/{{ p.id }}</p>
              </div>
              <div class="row-actions mt-3 flex justify-end gap-1 transition-opacity">
                <UPopover mode="hover" enable-touch>
                  <UButton
                    icon="i-lucide-pencil"
                    variant="ghost"
                    color="neutral"
                    size="sm"
                    :aria-label="`Edit ${p.label}`"
                    @click="openEditor(p)"
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
                    :aria-label="`Delete ${p.label}`"
                    :disabled="busy"
                    @click="askRemove(p)"
                  />
                  <template #content>
                    <div class="px-3 py-1.5 text-xs">Delete provider</div>
                  </template>
                </UPopover>
              </div>
            </UCard>
          </div>

          <!-- Desktop: table -->
          <UCard class="hidden md:block" :ui="{ root: 'shadow-sm', body: 'p-0 sm:p-0' }">
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
                <div class="row-actions flex justify-end gap-2 transition-opacity">
                  <UPopover mode="hover" enable-touch>
                    <UButton
                      icon="i-lucide-pencil"
                      variant="ghost"
                      color="neutral"
                      size="sm"
                      :aria-label="`Edit ${row.original.label}`"
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
                      :aria-label="`Delete ${row.original.label}`"
                      :disabled="busy"
                      @click="askRemove(row.original)"
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
    :title="editingId ? 'Edit provider' : 'New identity provider'"
    description="Register the redirect URL shown after saving in your OIDC provider"
    :dismissible="!busy"
    :close="!busy"
    @update:open="(v: boolean) => (editorOpen = v)"
  >
    <template #body>
      <UForm id="oidc-editor-form" :schema="oidcSchema" :state="form" class="space-y-4" @submit="saveProvider">
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
          role="alert"
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
          :disabled="!oidcLive.isSuccess.value"
          :label="editingId ? 'Save changes' : 'Create provider'"
          form="oidc-editor-form"
        />
      </div>
    </template>
  </UModal>

  <!-- delete confirm (same pattern as the vault/environment delete confirms) -->
  <UModal v-model:open="removeOpen" title="Delete provider" :dismissible="!busy" :close="!busy">
    <template #body>
      <div class="space-y-4">
        <p class="text-muted text-sm">
          Delete OIDC provider
          <span class="text-highlighted font-semibold">{{ pendingRemove?.label }}</span
          >? Anyone signing in through it loses that login option immediately.
        </p>
        <UAlert
          v-if="removeError"
          role="alert"
          icon="i-lucide-circle-alert"
          color="error"
          variant="subtle"
          :title="removeError"
          :ui="{ title: 'text-sm' }"
        />
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" color="neutral" label="Cancel" :disabled="busy" @click="pendingRemove = null" />
        <UButton icon="i-lucide-trash-2" color="error" label="Delete" :loading="busy" @click="removeProvider" />
      </div>
    </template>
  </UModal>
</template>
