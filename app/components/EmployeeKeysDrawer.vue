<script setup lang="ts">
// Access-keys drawer for one employee: self-contained mint/rename/revoke with
// the one-time fresh-key alert. Loads the key list whenever it opens. Nothing
// to do with the model-provider API key picked in the editor.
import { useMutation } from '@tanstack/vue-query';
import { computed, nextTick, reactive, ref, watch } from 'vue';
import { z } from 'zod';

import { formatWhenShort } from '~/utils/format-when';
import { errorMessage } from '~/utils/forms';
import type { ApiKeyRow, EmployeeRow } from '~/utils/orpc-types';

const open = defineModel<boolean>('open', { default: false });
const props = defineProps<{ employee: EmployeeRow | null }>();

const { $orpc, $client } = useNuxtApp();

const createKeyMutation = useMutation($orpc.employees.createApiKey.mutationOptions());
const revokeKeyMutation = useMutation($orpc.employees.revokeApiKey.mutationOptions());
const listKeysCall = $orpc.employees.listApiKeys.call;

// the mint field lives in the footer — a UForm around it makes Enter submit
const mintSchema = z.object({ mintName: z.string().max(100) });
const mintState = reactive({ mintName: '' });

const keys = ref<ApiKeyRow[]>([]);
const keysBusy = ref(false);
const keysMessage = ref('');
const keysLoadError = ref(false);
const freshKey = ref('');
const renamingId = ref<string | null>(null);
const renameValue = ref('');
const revokeConfirmId = ref<string | null>(null);
const revokingKey = computed(() => keys.value.find((k) => k.id === revokeConfirmId.value) ?? null);
const revokeError = ref<string | null>(null);

async function refreshKeys() {
  if (!props.employee) return;
  keysBusy.value = true;
  keysLoadError.value = false;
  try {
    keys.value = await listKeysCall({ employeeId: props.employee.id });
  } catch (e) {
    keysLoadError.value = true;
    keysMessage.value = errorMessage(e, "Couldn't load keys — try again");
  } finally {
    keysBusy.value = false;
  }
}

// reset + load on every open (the old openKeys body) — keys clear BEFORE the
// fetch so employee B never sees A's list during the load or after a failure
watch(open, async (v) => {
  if (!v || !props.employee) return;
  keys.value = [];
  keysLoadError.value = false;
  keysMessage.value = '';
  freshKey.value = '';
  mintState.mintName = '';
  await refreshKeys();
});

async function mintKey() {
  if (!props.employee) return;
  keysBusy.value = true;
  keysMessage.value = '';
  try {
    const res = await createKeyMutation.mutateAsync({
      employeeId: props.employee.id,
      ...(mintState.mintName.trim() ? { name: mintState.mintName.trim() } : {}),
    });
    freshKey.value = res.key;
    if (!freshKey.value) {
      // type says key: string, but a server-side auth change could omit it —
      // never render a key panel around an empty string
      keysMessage.value = "Couldn't create the key — the server returned no key. Try again.";
      return;
    }
    mintState.mintName = '';
    await refreshKeys();
  } catch (e) {
    keysMessage.value = errorMessage(e, "Couldn't create the key — try again");
  } finally {
    keysBusy.value = false;
  }
}

function startRename(k: ApiKeyRow) {
  renamingId.value = k.id;
  renameValue.value = k.name ?? '';
}

async function saveRename() {
  if (!renamingId.value || !renameValue.value.trim()) return;
  keysBusy.value = true;
  try {
    await $client.employees.updateApiKey({ keyId: renamingId.value, name: renameValue.value.trim() });
    renamingId.value = null;
    await refreshKeys();
  } catch (e) {
    keysMessage.value = errorMessage(e, "Couldn't rename the key — try again");
  } finally {
    keysBusy.value = false;
  }
}

function askRevoke(keyId: string) {
  keysMessage.value = '';
  revokeError.value = null;
  revokeConfirmId.value = keyId;
}

async function revokeKey(keyId: string) {
  revokeError.value = null;
  keysBusy.value = true;
  try {
    await revokeKeyMutation.mutateAsync({ keyId });
    revokeConfirmId.value = null;
    await refreshKeys();
  } catch (e) {
    revokeError.value = errorMessage(e, "Couldn't revoke the key — try again");
  } finally {
    keysBusy.value = false;
  }
}

const copied = ref(false);

/** the one-time key panel takes focus the moment it appears: the footer form is
 *  gone by then, so keyboard users would otherwise land on nothing */
const keyPanel = ref<HTMLElement | null>(null);
watch(freshKey, async (v) => {
  if (!v) return;
  await nextTick();
  keyPanel.value?.focus();
});

/** explicit acknowledgement — the ONLY way out while the guard is on, and the
 *  point where the key is cleared from the DOM */
function finishKey() {
  freshKey.value = '';
  copied.value = false;
  mintState.mintName = '';
  open.value = false;
}

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
</script>

<template>
  <!-- dismissible + close both drop while the one-time fresh key is on screen —
       Esc/overlay AND the top-right X must not be able to destroy the only copy
       of the key (mirrors EmployeeEditorModal's minted-key guard) -->
  <UModal
    v-model:open="open"
    :dismissible="!freshKey && !keysBusy"
    :close="!freshKey && !keysBusy"
    :title="`${employee?.name ?? ''}'s access keys`"
  >
    <template #body>
      <div class="space-y-3">
        <p class="text-muted text-xs">
          Access keys authenticate API calls to Tandem as {{ employee?.name ?? 'this employee' }}.
        </p>
        <p v-if="keysMessage" role="alert" class="text-error text-sm">{{ keysMessage }}</p>
        <div
          v-if="freshKey"
          ref="keyPanel"
          role="status"
          aria-live="polite"
          tabindex="-1"
          class="text-primary bg-primary/10 focus-visible:ring-primary rounded-lg p-4 focus-visible:ring-2 focus-visible:outline-none"
        >
          <p class="flex items-center gap-2 text-sm font-semibold">
            <UIcon name="i-lucide-key-round" class="size-4" />
            New key — shown only once
          </p>
          <div class="mt-3 flex items-center gap-2">
            <code class="bg-default/60 flex-1 rounded-md px-2.5 py-2 font-mono text-sm break-all">{{ freshKey }}</code>
            <UButton
              :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
              :color="copied ? 'success' : 'neutral'"
              variant="soft"
              size="sm"
              :label="copied ? 'Copied' : 'Copy'"
              @click="copyKey(freshKey)"
            />
          </div>
        </div>
        <!-- pending first load: skeleton rows instead of a blank body -->
        <div v-if="keysBusy && !keys.length" class="space-y-2" aria-hidden="true">
          <USkeleton v-for="i in 2" :key="i" class="h-10 w-full rounded-md" />
        </div>
        <div v-else-if="keys.length" class="divide-default divide-y">
          <div
            v-for="k in keys"
            :key="k.id"
            data-testid="key-row"
            class="group flex items-center justify-between gap-2 py-2"
          >
            <div v-if="renamingId !== k.id" class="min-w-0">
              <p class="text-highlighted truncate text-sm">{{ k.name ?? 'Unnamed' }}</p>
              <p class="text-dimmed font-mono text-xs">{{ k.prefix }}{{ k.start }}…</p>
              <p class="text-dimmed text-xs" data-allow-mismatch>Created {{ formatWhenShort(k.createdAt) }}</p>
            </div>
            <div v-else class="flex min-w-0 flex-1 items-center gap-1">
              <UInput
                v-model="renameValue"
                size="sm"
                placeholder="Key name"
                aria-label="Key name"
                class="flex-1"
                @keydown.enter.prevent="saveRename"
              />
              <UPopover mode="hover" enable-touch
                ><UButton
                  icon="i-lucide-check"
                  variant="ghost"
                  color="primary"
                  size="sm"
                  aria-label="Save name"
                  :loading="keysBusy"
                  @click="saveRename"
                /><template #content><div class="px-3 py-1.5 text-xs">Save name</div></template></UPopover
              >
              <UPopover mode="hover" enable-touch
                ><UButton
                  icon="i-lucide-x"
                  variant="ghost"
                  color="neutral"
                  size="sm"
                  aria-label="Cancel rename"
                  @click="renamingId = null"
                /><template #content><div class="px-3 py-1.5 text-xs">Cancel</div></template></UPopover
              >
            </div>
            <div
              v-if="renamingId !== k.id"
              class="flex shrink-0 gap-1 transition-opacity md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
            >
              <UPopover mode="hover" enable-touch
                ><UButton
                  icon="i-lucide-pencil"
                  variant="ghost"
                  color="neutral"
                  size="sm"
                  :aria-label="`Rename ${k.name ?? 'unnamed key'}`"
                  :disabled="keysBusy"
                  @click="startRename(k)"
                /><template #content><div class="px-3 py-1.5 text-xs">Rename key</div></template></UPopover
              >
              <UPopover mode="hover" enable-touch
                ><UButton
                  icon="i-lucide-trash-2"
                  variant="ghost"
                  color="neutral"
                  size="sm"
                  class="text-muted hover:text-error"
                  :aria-label="`Revoke ${k.name ?? 'unnamed key'}`"
                  :disabled="keysBusy"
                  @click="askRevoke(k.id)"
                /><template #content><div class="px-3 py-1.5 text-xs">Revoke key</div></template></UPopover
              >
            </div>
          </div>
        </div>
        <!-- load failure: the alert above carries the message; retry re-runs the fetch -->
        <div v-else-if="!keysBusy && keysLoadError">
          <UButton size="sm" variant="soft" icon="i-lucide-refresh-cw" label="Try again" @click="refreshKeys" />
        </div>
        <p v-else-if="!keysBusy" class="text-muted text-sm">No keys yet — create one below.</p>
      </div>
    </template>
    <template #footer>
      <!-- while the one-time key is on screen the footer is a single acknowledgement:
           no mint form, no close — losing the copy is unrecoverable -->
      <div v-if="freshKey" class="flex w-full justify-end">
        <UButton icon="i-lucide-check" label="Done, key saved" @click="finishKey" />
      </div>
      <UForm
        v-else
        id="mint-key-form"
        :schema="mintSchema"
        :state="mintState"
        class="flex w-full items-end justify-between gap-3"
        @submit="mintKey"
      >
        <UFormField label="Key name" name="mintName" class="min-w-0 flex-1">
          <UInput
            v-model="mintState.mintName"
            icon="i-lucide-tag"
            placeholder="e.g. ci-deploy (optional)"
            class="w-full"
          />
        </UFormField>
        <UButton
          type="submit"
          form="mint-key-form"
          icon="i-lucide-key-round"
          size="sm"
          label="Create key"
          :loading="keysBusy"
        />
      </UForm>
    </template>
  </UModal>

  <!-- revoke confirm: apps using the key stop authenticating immediately -->
  <UModal
    :open="revokeConfirmId !== null"
    title="Revoke key?"
    :dismissible="!keysBusy"
    :close="!keysBusy"
    @update:open="
      (v: boolean) => {
        if (!v) revokeConfirmId = null;
      }
    "
  >
    <template #body>
      <p class="text-sm">
        Revoke <strong>{{ revokingKey?.name ?? 'Unnamed key' }}</strong
        >? Apps using it stop authenticating immediately.
      </p>
      <UAlert
        v-if="revokeError"
        role="alert"
        icon="i-lucide-circle-alert"
        color="error"
        variant="subtle"
        :title="revokeError"
        class="mt-3"
        :ui="{ title: 'text-sm' }"
      />
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" color="neutral" :disabled="keysBusy" @click="revokeConfirmId = null">Cancel</UButton>
        <UButton
          color="error"
          icon="i-lucide-trash-2"
          :loading="keysBusy"
          @click="revokeConfirmId && revokeKey(revokeConfirmId)"
          >Revoke key</UButton
        >
      </div>
    </template>
  </UModal>
</template>
