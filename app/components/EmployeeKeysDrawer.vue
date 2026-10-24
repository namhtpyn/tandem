<script setup lang="ts">
// Access-keys drawer for one employee: self-contained mint/rename/revoke with
// the one-time fresh-key alert. Loads the key list whenever it opens. Nothing
// to do with the model-provider API key picked in the editor.
import { useMutation } from '@tanstack/vue-query';
import { ref, watch } from 'vue';

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

async function refreshKeys() {
  if (!props.employee) return;
  keysBusy.value = true;
  try {
    keys.value = (await listKeysCall({ employeeId: props.employee.id })) as ApiKeyRow[];
  } catch (e) {
    keysMessage.value = e instanceof Error ? e.message : 'load failed';
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
    keysMessage.value = e instanceof Error ? e.message : 'mint failed';
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
    keysMessage.value = e instanceof Error ? e.message : 'rename failed';
  } finally {
    keysBusy.value = false;
  }
}

async function revokeKey(keyId: string) {
  keysBusy.value = true;
  keysMessage.value = '';
  try {
    await revokeKeyMutation.mutateAsync({ keyId });
    await refreshKeys();
  } catch (e) {
    keysMessage.value = e instanceof Error ? e.message : 'revoke failed';
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
        <p class="text-xs text-zinc-500 dark:text-zinc-400">
          Access keys authenticate API calls to Tandem as {{ employee?.name ?? 'this employee' }} — nothing to do with
          the model provider API key in the editor.
        </p>
        <p v-if="keysMessage" class="text-error text-sm">{{ keysMessage }}</p>
        <div v-if="freshKey" class="rounded-lg border-2 border-amber-400/70 bg-amber-50 p-4 dark:bg-amber-950/40">
          <p class="flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-200">
            <UIcon name="i-lucide-key-round" class="size-4" />
            New key — shown only once
          </p>
          <div class="mt-3 flex items-center gap-2">
            <code
              class="flex-1 rounded-md bg-white/70 px-2.5 py-2 font-mono text-sm break-all text-amber-900 dark:bg-black/30 dark:text-amber-100"
              >{{ freshKey }}</code
            >
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
        <div v-if="keys.length" class="divide-y divide-zinc-200 dark:divide-zinc-800">
          <div v-for="k in keys" :key="k.id" class="flex items-center justify-between gap-2 py-2">
            <div v-if="renamingId !== k.id" class="min-w-0">
              <p class="truncate text-sm text-zinc-900 dark:text-white">{{ k.name ?? 'unnamed' }}</p>
              <p class="font-mono text-xs text-zinc-400">
                {{ k.prefix }}{{ k.start }}… · created {{ new Date(k.createdAt).toLocaleDateString() }}
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
            <div v-if="renamingId !== k.id" class="flex shrink-0 gap-1">
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
                  color="error"
                  size="xs"
                  aria-label="Revoke key"
                  :loading="keysBusy"
                  @click="revokeKey(k.id)"
                /><template #content><div class="px-3 py-1.5 text-xs">Revoke key</div></template></UPopover
              >
            </div>
          </div>
        </div>
        <p v-else-if="!keysBusy" class="text-sm text-zinc-500">No keys.</p>
        <UFormField label="Key name" name="mintName" class="pt-1">
          <UInput v-model="mintName" icon="i-lucide-tag" placeholder="e.g. ci-deploy (optional)" class="w-full" />
        </UFormField>
        <div class="flex justify-end gap-2 pt-1">
          <UButton icon="i-lucide-key-round" size="sm" label="Mint new key" :loading="keysBusy" @click="mintKey" />
        </div>
      </div>
    </template>
  </UModal>
</template>
