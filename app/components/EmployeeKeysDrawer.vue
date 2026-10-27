<script setup lang="ts">
// Access-keys drawer for one employee: self-contained mint/rename/revoke with
// the one-time fresh-key alert. Loads the key list whenever it opens. Nothing
// to do with the model-provider API key picked in the editor.
import { useMutation } from '@tanstack/vue-query';
import { computed, ref, watch } from 'vue';

import { formatWhenShort } from '~/utils/format-when';
import type { ApiKeyRow, EmployeeRow } from '~/utils/orpc-types';

const open = defineModel<boolean>('open', { default: false });
const props = defineProps<{ employee: EmployeeRow | null }>();

const { $orpc, $client } = useNuxtApp();

const createKeyMutation = useMutation($orpc.employees.createApiKey.mutationOptions());
const revokeKeyMutation = useMutation($orpc.employees.revokeApiKey.mutationOptions());
const listKeysCall = $orpc.employees.listApiKeys.call;

const keys = ref<ApiKeyRow[]>([]);
const keysBusy = ref(false);
const keysMessage = ref('');
const freshKey = ref('');
const mintName = ref('');
const renamingId = ref<string | null>(null);
const renameValue = ref('');
const revokeConfirmId = ref<string | null>(null);
const revokingKey = computed(() => keys.value.find((k) => k.id === revokeConfirmId.value) ?? null);
const revokeError = ref<string | null>(null);

async function refreshKeys() {
  if (!props.employee) return;
  keysBusy.value = true;
  try {
    keys.value = (await listKeysCall({ employeeId: props.employee.id })) as ApiKeyRow[];
  } catch (e) {
    keysMessage.value = e instanceof Error ? e.message : "Couldn't load keys — try again.";
  } finally {
    keysBusy.value = false;
  }
}

// reset + load on every open (the old openKeys body)
watch(open, async (v) => {
  if (!v || !props.employee) return;
  keysMessage.value = '';
  freshKey.value = '';
  mintName.value = '';
  await refreshKeys();
});

async function mintKey() {
  if (!props.employee) return;
  keysBusy.value = true;
  keysMessage.value = '';
  try {
    const res = await createKeyMutation.mutateAsync({
      employeeId: props.employee.id,
      ...(mintName.value.trim() ? { name: mintName.value.trim() } : {}),
    });
    freshKey.value = res.key as string;
    mintName.value = '';
    await refreshKeys();
  } catch (e) {
    keysMessage.value = e instanceof Error ? e.message : "Couldn't create the key — try again.";
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
    keysMessage.value = e instanceof Error ? e.message : "Couldn't rename the key — try again.";
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
    revokeError.value = e instanceof Error ? e.message : "Couldn't revoke the key — try again.";
  } finally {
    keysBusy.value = false;
  }
}

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
</script>

<template>
  <UModal v-model:open="open" :title="`Access keys — ${employee?.name ?? ''}`">
    <template #body>
      <div class="space-y-3">
        <p class="text-muted text-xs">
          Access keys authenticate API calls to Tandem as {{ employee?.name ?? 'this employee' }} — nothing to do with
          the model provider API key in the editor.
        </p>
        <p v-if="keysMessage" class="text-error text-sm">{{ keysMessage }}</p>
        <div v-if="freshKey" class="text-primary bg-primary/10 rounded-lg p-4">
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
        <div v-if="keys.length" class="divide-default divide-y">
          <div v-for="k in keys" :key="k.id" class="group flex items-center justify-between gap-2 py-2">
            <div v-if="renamingId !== k.id" class="min-w-0">
              <p class="text-highlighted truncate text-sm">{{ k.name ?? 'unnamed' }}</p>
              <p class="text-dimmed font-mono text-xs">
                {{ k.prefix }}{{ k.start }}… · created {{ formatWhenShort(k.createdAt) }}
              </p>
            </div>
            <div v-else class="flex min-w-0 flex-1 items-center gap-1">
              <UInput
                v-model="renameValue"
                size="xs"
                placeholder="Key name"
                class="flex-1"
                @keydown.enter.prevent="saveRename"
              />
              <UPopover mode="hover"
                ><UButton
                  icon="i-lucide-check"
                  variant="ghost"
                  color="primary"
                  size="xs"
                  aria-label="Save name"
                  :loading="keysBusy"
                  @click="saveRename"
                /><template #content><div class="px-3 py-1.5 text-xs">Save name</div></template></UPopover
              >
              <UPopover mode="hover"
                ><UButton
                  icon="i-lucide-x"
                  variant="ghost"
                  color="neutral"
                  size="xs"
                  aria-label="Cancel rename"
                  @click="renamingId = null"
                /><template #content><div class="px-3 py-1.5 text-xs">Cancel</div></template></UPopover
              >
            </div>
            <div
              v-if="renamingId !== k.id"
              class="flex shrink-0 gap-1 transition-opacity md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
            >
              <UPopover mode="hover"
                ><UButton
                  icon="i-lucide-pencil"
                  variant="ghost"
                  color="neutral"
                  size="xs"
                  aria-label="Rename key"
                  :disabled="keysBusy"
                  @click="startRename(k)"
                /><template #content><div class="px-3 py-1.5 text-xs">Rename key</div></template></UPopover
              >
              <UPopover mode="hover"
                ><UButton
                  icon="i-lucide-trash-2"
                  variant="ghost"
                  color="neutral"
                  size="xs"
                  class="text-muted hover:text-error"
                  aria-label="Revoke key"
                  :disabled="keysBusy"
                  @click="askRevoke(k.id)"
                /><template #content><div class="px-3 py-1.5 text-xs">Revoke key</div></template></UPopover
              >
            </div>
          </div>
        </div>
        <p v-else-if="!keysBusy" class="text-muted text-sm">No keys.</p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full items-end justify-between gap-3">
        <UFormField label="Key name" name="mintName" class="min-w-0 flex-1">
          <UInput v-model="mintName" icon="i-lucide-tag" placeholder="e.g. ci-deploy (optional)" class="w-full" />
        </UFormField>
        <UButton icon="i-lucide-key-round" size="sm" label="Create key" :loading="keysBusy" @click="mintKey" />
      </div>
    </template>
  </UModal>

  <!-- revoke confirm: apps using the key stop authenticating immediately -->
  <UModal
    :open="revokeConfirmId !== null"
    title="Revoke key?"
    @update:open="
      (v: boolean) => {
        if (!v) revokeConfirmId = null;
      }
    "
  >
    <template #body>
      <p class="text-sm">
        Revoke <strong>{{ revokingKey?.name ?? 'unnamed key' }}</strong
        >? Apps using it stop authenticating immediately.
      </p>
      <UAlert
        v-if="revokeError"
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
        <UButton variant="ghost" color="neutral" @click="revokeConfirmId = null">Cancel</UButton>
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
