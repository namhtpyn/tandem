<script setup lang="ts">
// Channels card (SPEC: Channel settings UI, #271 slice 4): the admin config
// surface for the `channels` settings key. Self-loading — owns the
// channels.list query (SETTINGS cache key: any settings write, including this
// card's own mutations, refreshes it) and the replace-array update mutation.
// The server is the source of truth: frontend validation is presence-only and
// the server's refusal reason is what the UI shows.
import { useQuery } from '@tanstack/vue-query';
import { z } from 'zod';

import { CHANGE_RESOURCE } from '#shared/enums';
import { NONE_ID, saveFailed } from '~/utils/forms';
import { employeeOptions } from '~/utils/ui-labels';
import type { VaultSecretOptionRow } from '~/utils/vault-options';
import { groupedSecretOptions } from '~/utils/vault-options';

const { $orpc, $client } = useNuxtApp();

type Binding = { platformUserId: string; userId: string };
type ChannelEntry = {
  kind: string;
  enabled: boolean;
  homeserverUrl: string;
  tokenSecretId: string;
  bindings: Binding[];
  defaultAssigneeId: string | null;
};
type ListEntry = {
  status: 'ok' | 'dropped';
  reason: string;
  key: string | null;
  entry: ChannelEntry | null;
  raw: unknown;
};
type HealthEntry = {
  key: string;
  connected?: boolean;
  healthOk?: boolean;
  lastSyncOkAt?: number | null;
};

const channelsLive = useQuery($orpc.channels.list.queryOptions({ queryKey: [CHANGE_RESOURCE.SETTINGS, 'channels'] }));
const data = computed(
  () =>
    unref(channelsLive.data) as
      | { kinds: string[]; corrupt: string | null; entries: ListEntry[]; health: { channels?: HealthEntry[] } | null }
      | undefined,
);
const entries = computed(() => data.value?.entries ?? []);
const okEntries = computed(() => entries.value.flatMap((e) => (e.status === 'ok' && e.entry ? [e.entry] : [])));
const droppedEntries = computed(() => entries.value.filter((e) => e.status === 'dropped'));

// ---------- health chip (per-entry, keyed like the runtime adapter key) ----------
function healthFor(e: ListEntry): HealthEntry | undefined {
  const list = data.value?.health?.channels;
  if (!list || !e.key) return undefined;
  return list.find((h) => h.key === e.key);
}
function healthLabel(e: ListEntry): string {
  const h = healthFor(e);
  if (!h) return 'no stamp';
  if (!h.connected) return 'down';
  const last = h.lastSyncOkAt;
  if (typeof last !== 'number') return 'connected (no sync yet)';
  const mins = Math.max(0, Math.round((Date.now() - last) / 60_000));
  return mins < 60 ? `connected · sync ${mins}m ago` : `connected · sync ${Math.round(mins / 60)}h ago`;
}

// ---------- pickers ----------
const vaultLive = useAllVaultSecrets();
const secretOptions = computed(() => groupedSecretOptions((unref(vaultLive.data) ?? []) as VaultSecretOptionRow[]));
const employeesLive = useQuery($orpc.employees.list.queryOptions({ queryKey: [CHANGE_RESOURCE.EMPLOYEES] }));
const employeeRows = computed(() => (unref(employeesLive.data) ?? []) as Array<{ id: string; name: string }>);
const assigneeOptions = computed(() => employeeOptions(employeeRows.value, { noneLabel: 'None' }));
const bindingUserOptions = computed(() => employeeOptions(employeeRows.value));

// ---------- editor ----------
const editorOpen = ref(false);
const form = reactive<{
  kind: string;
  enabled: boolean;
  homeserverUrl: string;
  tokenSecretId: string | null;
  defaultAssigneeId: string | null;
  bindings: Binding[];
}>({
  kind: '',
  enabled: true,
  homeserverUrl: '',
  tokenSecretId: null,
  defaultAssigneeId: null,
  bindings: [],
});
// loose frontend schema (repo law): presence only — the server re-validates
// shape, kind registry, canonicalization, dedupe and existence
const schema = z.object({
  kind: z.string().trim().min(1, 'Pick a channel kind'),
  homeserverUrl: z.string().trim().min(1, 'Homeserver URL is required'),
  tokenSecretId: z
    .string({ message: 'Pick a vault secret for the bot token' })
    .min(1, 'Pick a vault secret for the bot token'),
});

/** exact-content identity: adapter KEYS are not unique across stored entries
 * (the runtime tolerates an enabled+disabled pair under one key), so row
 * operations target the row whose FULL content matches the snapshot taken
 * when the flow opened — a refetch preserves content, so this survives it,
 * and twins can never swallow each other's writes */
const fingerprint = (e: ChannelEntry) => JSON.stringify(e);
const editingFingerprint = ref<string | null>(null);

function openEditor(entry?: ChannelEntry) {
  editingFingerprint.value = entry ? fingerprint(entry) : null;
  form.kind = entry?.kind ?? (data.value?.kinds.length === 1 ? (data.value?.kinds[0] as string) : '');
  form.enabled = entry?.enabled ?? true;
  form.homeserverUrl = entry?.homeserverUrl ?? '';
  form.tokenSecretId = entry?.tokenSecretId ?? null;
  form.defaultAssigneeId = entry?.defaultAssigneeId ?? null;
  form.bindings = entry?.bindings.map((b) => ({ ...b })) ?? [];
  message.value = '';
  editorOpen.value = true;
}
function addBinding() {
  form.bindings.push({ platformUserId: '', userId: '' });
}
function removeBinding(i: number) {
  form.bindings.splice(i, 1);
}

// ---------- save: the whole stored array is REPLACEd on every write ----------
const busy = ref(false);
const message = ref('');
const messageOk = ref(false);
const droppedRewriteHint = computed(() => droppedEntries.value.length > 0);

function buildArray(editor: ChannelEntry | null): ChannelEntry[] {
  // the edited entry is located by CONTENT at save time — a mid-edit refetch
  // that replaced row objects can never clobber the wrong entry, and two
  // same-key rows (hand-edited twins) each keep their own content
  const rest = editor
    ? okEntries.value.filter((e) => fingerprint(e) !== editingFingerprint.value)
    : [...okEntries.value];
  return editor ? [...rest, editor] : rest;
}

/** schema-level (.input) refusals wrap the zod issues in error.data — surface
 * the first field reason instead of oRPC's generic 'Input validation failed' */
function refusalDetail(e: unknown, base: string): string {
  const issues = (e as { data?: { issues?: Array<{ path?: Array<string | number>; message?: string }> } })?.data
    ?.issues;
  const first = Array.isArray(issues)
    ? issues.find((i) => i && typeof i.message === 'string' && i.message.length > 0)
    : undefined;
  if (!first?.message) return base;
  const path = Array.isArray(first.path) && first.path.length > 0 ? `${first.path.join('.')}: ` : '';
  return `${base}: ${path}${first.message}`;
}

async function saveChannels(arr: ChannelEntry[], successMsg: string) {
  if (busy.value) return; // one write at a time — a double-click must not double-write
  busy.value = true;
  message.value = '';
  messageOk.value = false;
  try {
    await $client.channels.update({ channels: arr });
    message.value = successMsg;
    messageOk.value = true;
  } catch (e) {
    message.value = refusalDetail(e, saveFailed(e, 'channels'));
    messageOk.value = false;
  } finally {
    busy.value = false;
  }
}

async function saveEditor() {
  // an edit must still find the row it opened for: if the entry changed under
  // the editor (another admin's write), refusing beats guessing which row to
  // replace — the admin reopens and sees the current state
  if (editingFingerprint.value !== null && !okEntries.value.some((e) => fingerprint(e) === editingFingerprint.value)) {
    message.value = 'This channel changed since the editor opened — reopen it and try again';
    messageOk.value = false;
    return;
  }
  const editor: ChannelEntry = {
    kind: form.kind.trim(),
    enabled: form.enabled,
    homeserverUrl: form.homeserverUrl.trim(),
    tokenSecretId: form.tokenSecretId ?? '',
    bindings: form.bindings
      .map((b) => ({ platformUserId: b.platformUserId.trim(), userId: b.userId }))
      .filter((b) => b.platformUserId.length > 0 || b.userId.length > 0),
    defaultAssigneeId: form.defaultAssigneeId && form.defaultAssigneeId !== NONE_ID ? form.defaultAssigneeId : null,
  };
  await saveChannels(buildArray(editor), editingFingerprint.value !== null ? 'Channel saved' : 'Channel created');
  if (messageOk.value) editorOpen.value = false;
}

// ---------- quick toggles + delete (CONTENT identity, never object refs or
// array indexes — the [SETTINGS] query refetches on any settings write and
// replaces row objects mid-flight; exact content survives that AND keeps
// same-key twins distinct) ----------
const pendingToggle = ref<string | null>(null);
async function toggleEnabled(e: ListEntry) {
  const row = e.entry;
  if (!row || e.status !== 'ok' || busy.value || pendingToggle.value) return;
  const fp = fingerprint(row);
  pendingToggle.value = fp;
  const arr = okEntries.value.map((r) => (fingerprint(r) === fp ? { ...r, enabled: !r.enabled } : r));
  try {
    await saveChannels(arr, 'Channel updated');
  } finally {
    pendingToggle.value = null;
  }
}

const pendingRemove = ref<{ fp: string | null; label: string } | null>(null);
const removeOpen = computed({
  get: () => pendingRemove.value !== null,
  set: (v: boolean) => {
    if (!v) pendingRemove.value = null;
  },
});
function askRemove(e: ListEntry) {
  // fp only for OK rows: a dropped row (incl. a dropped DUPLICATE that carries
  // a parseable cfg and a shared key) is removed by the REPLACE write itself
  pendingRemove.value = {
    fp: e.status === 'ok' && e.entry ? fingerprint(e.entry) : null,
    label: rowHomeserver(e),
  };
}
async function removeChannel() {
  if (!pendingRemove.value) return;
  const fp = pendingRemove.value.fp;
  // an ok row is removed by content at confirm time (a refetch between
  // confirm-open and confirm can never leave the write matching nothing, and
  // same-key twins keep their own content); a dropped row isn't in the ok
  // list — the REPLACE write itself drops it (the confirm warned about the
  // rewrite); a vanished row (removed by another admin mid-confirm) writes
  // the unchanged ok list — the intent (row gone) already holds
  const arr = fp ? okEntries.value.filter((e) => fingerprint(e) !== fp) : okEntries.value;
  await saveChannels(arr, 'Channel removed');
  if (messageOk.value) pendingRemove.value = null;
}

/** display homeserver of a list row (dropped rows show their raw value) */
function rowHomeserver(e: ListEntry): string {
  if (e.entry) return e.entry.homeserverUrl;
  const raw = e.raw as { homeserverUrl?: unknown } | null;
  return typeof raw?.homeserverUrl === 'string' ? raw.homeserverUrl : '(unreadable entry)';
}

onServerPrefetch(() => channelsLive.suspense());
</script>

<template>
  <UCard :ui="{ root: 'shadow-sm' }">
    <template #header>
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-radio" class="text-dimmed size-4" />
        <h2 class="text-highlighted text-sm font-semibold">Channels</h2>
      </div>
    </template>
    <div class="space-y-5">
      <div>
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 class="text-highlighted text-sm font-semibold">Channel configs</h3>
          <UButton icon="i-lucide-plus" size="sm" label="New channel" @click="openEditor()" />
        </div>

        <UAlert
          v-if="data?.corrupt"
          role="alert"
          icon="i-lucide-triangle-alert"
          color="warning"
          variant="subtle"
          :title="`Stored channels value is corrupt: ${data.corrupt}`"
          :ui="{ title: 'text-sm' }"
        />

        <!-- desktop table -->
        <UCard v-if="entries.length" :ui="{ root: 'shadow-sm hidden md:block', body: 'p-0 sm:p-0' }">
          <UTable
            :data="entries"
            :columns="[
              { id: 'channel', header: 'Channel' },
              { id: 'bindings', header: 'Bindings' },
              { id: 'health', header: 'Health' },
              { id: 'enabled', header: 'Enabled' },
              { id: 'actions', header: 'Actions', meta: { class: { th: 'sr-only' } } },
            ]"
          >
            <template #channel-cell="{ row }">
              <div class="min-w-0">
                <p class="text-highlighted flex items-center gap-2 truncate font-medium">
                  {{ row.original.entry?.kind ?? '?' }}
                  <UBadge v-if="row.original.status === 'dropped'" color="error" variant="subtle" size="sm"
                    >invalid</UBadge
                  >
                </p>
                <p class="text-dimmed truncate font-mono text-xs">{{ rowHomeserver(row.original) }}</p>
                <p
                  v-if="row.original.status === 'dropped'"
                  class="text-error mt-0.5 line-clamp-2 text-xs"
                  :title="row.original.reason"
                >
                  {{ row.original.reason }}
                </p>
              </div>
            </template>
            <template #bindings-cell="{ row }">
              <span class="text-muted text-sm">{{ row.original.entry?.bindings.length ?? 0 }}</span>
            </template>
            <template #health-cell="{ row }">
              <UBadge
                v-if="row.original.entry && row.original.status === 'ok'"
                :color="healthFor(row.original)?.connected ? 'success' : 'neutral'"
                variant="subtle"
                size="sm"
                class="max-w-56 truncate"
                >{{ healthLabel(row.original) }}</UBadge
              >
              <span v-else class="text-dimmed text-xs">—</span>
            </template>
            <template #enabled-cell="{ row }">
              <!-- controls exist only on ok rows: a dropped entry with a
               parseable cfg (enabled-duplicate) must offer no live actions -->
              <USwitch
                v-if="row.original.entry && row.original.status === 'ok'"
                :model-value="row.original.entry.enabled"
                :disabled="busy"
                :aria-label="`Enable ${row.original.entry.kind}`"
                @update:model-value="toggleEnabled(row.original)"
              />
              <span v-else class="text-dimmed text-xs">—</span>
            </template>
            <template #actions-cell="{ row }">
              <div class="row-actions flex justify-end gap-1 transition-opacity">
                <UPopover v-if="row.original.entry && row.original.status === 'ok'" mode="hover" enable-touch>
                  <UButton
                    icon="i-lucide-pencil"
                    variant="ghost"
                    color="neutral"
                    size="sm"
                    :aria-label="`Edit ${row.original.entry.kind} channel`"
                    :disabled="busy"
                    @click="openEditor(row.original.entry!)"
                  />
                  <template #content>
                    <div class="px-3 py-1.5 text-xs">Edit channel</div>
                  </template>
                </UPopover>
                <UPopover mode="hover" enable-touch>
                  <UButton
                    icon="i-lucide-trash-2"
                    variant="ghost"
                    color="neutral"
                    class="text-muted hover:text-error"
                    size="sm"
                    :aria-label="`Delete ${rowHomeserver(row.original)}`"
                    :disabled="busy"
                    @click="askRemove(row.original)"
                  />
                  <template #content>
                    <div class="px-3 py-1.5 text-xs">Delete channel</div>
                  </template>
                </UPopover>
              </div>
            </template>
          </UTable>
        </UCard>

        <!-- mobile: stacked cards -->
        <div v-if="entries.length" class="space-y-3 md:hidden">
          <UCard v-for="(e, i) in entries" :key="`${e.key ?? 'raw'}-${i}`" :ui="{ root: 'shadow-sm' }">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <p class="text-highlighted truncate text-sm font-medium">
                  {{ e.entry?.kind ?? '?' }}
                  <UBadge v-if="e.status === 'dropped'" color="error" variant="subtle" size="sm">invalid</UBadge>
                </p>
                <p class="text-dimmed truncate font-mono text-xs">{{ rowHomeserver(e) }}</p>
                <p v-if="e.status === 'dropped'" class="text-error mt-0.5 line-clamp-2 text-xs" :title="e.reason">
                  {{ e.reason }}
                </p>
              </div>
              <USwitch
                v-if="e.entry && e.status === 'ok'"
                :model-value="e.entry.enabled"
                :disabled="busy"
                :aria-label="`Enable ${e.entry.kind}`"
                @update:model-value="toggleEnabled(e)"
              />
            </div>
            <div class="mt-2 flex flex-wrap items-center gap-2">
              <UBadge class="text-muted" variant="subtle" size="sm"
                >{{ e.entry?.bindings.length ?? 0 }} binding(s)</UBadge
              >
              <UBadge
                v-if="e.entry && e.status === 'ok'"
                :color="healthFor(e)?.connected ? 'success' : 'neutral'"
                variant="subtle"
                size="sm"
                class="max-w-52 truncate"
                >{{ healthLabel(e) }}</UBadge
              >
            </div>
            <div class="row-actions mt-3 flex justify-end gap-1 transition-opacity">
              <UButton
                v-if="e.entry && e.status === 'ok'"
                icon="i-lucide-pencil"
                variant="ghost"
                color="neutral"
                size="sm"
                :aria-label="`Edit ${e.entry.kind}`"
                :disabled="busy"
                @click="openEditor(e.entry)"
              />
              <UButton
                icon="i-lucide-trash-2"
                variant="ghost"
                color="neutral"
                size="sm"
                class="text-muted hover:text-error"
                :aria-label="`Delete ${rowHomeserver(e)}`"
                :disabled="busy"
                @click="askRemove(e)"
              />
            </div>
          </UCard>
        </div>

        <template v-if="channelsLive.isPending.value">
          <div class="space-y-3 md:hidden" aria-hidden="true">
            <USkeleton class="h-20 w-full rounded-lg" />
            <USkeleton class="h-20 w-full rounded-lg" />
          </div>
          <UCard class="hidden md:block" :ui="{ root: 'shadow-sm', body: 'p-0 sm:p-0' }">
            <div class="space-y-2 p-4" aria-hidden="true">
              <USkeleton class="h-8 w-full rounded" />
            </div>
          </UCard>
        </template>
        <p v-else-if="channelsLive.isError.value" role="alert" class="text-error py-4 text-center text-sm">
          Couldn't load channels
        </p>
        <div
          v-else-if="!entries.length"
          class="border-default flex flex-col items-center gap-3 rounded-xl border border-dashed p-8 text-center"
        >
          <UIcon name="i-lucide-radio" class="text-toned size-10" aria-hidden="true" />
          <p class="text-muted text-sm">No channels yet — add one to relay tasks from a chat platform.</p>
          <UButton icon="i-lucide-plus" size="sm" label="New channel" @click="openEditor()" />
        </div>

        <p v-if="droppedRewriteHint" class="text-muted mt-2 text-xs">
          Saving rewrites the stored config — invalid rows are dropped.
        </p>
        <p
          v-if="message"
          class="mt-2 text-sm"
          :class="messageOk ? 'text-success' : 'text-error'"
          :role="messageOk ? 'status' : 'alert'"
        >
          {{ message }}
        </p>
      </div>
    </div>
  </UCard>

  <!-- channel editor -->
  <UModal
    v-model:open="editorOpen"
    :title="editingFingerprint !== null ? 'Edit channel' : 'New channel'"
    :dismissible="!busy"
    :close="!busy"
    :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }"
  >
    <template #body>
      <UForm id="channel-editor-form" :schema="schema" :state="form" class="space-y-4" @submit="saveEditor">
        <UFormField label="Kind" name="kind" required>
          <USelect
            v-model="form.kind"
            :items="data?.kinds ?? []"
            icon="i-lucide-radio"
            placeholder="Channel kind"
            class="w-full"
          />
        </UFormField>
        <UFormField label="Homeserver URL" name="homeserverUrl" required>
          <template #hint><FormHint text="Matrix homeserver the bot account lives on" /></template>
          <UInput
            v-model="form.homeserverUrl"
            icon="i-lucide-globe"
            placeholder="https://matrix.example.org"
            class="w-full"
          />
        </UFormField>
        <UFormField label="Token secret" name="tokenSecretId" required>
          <template #hint><FormHint text="Vault secret holding the bot access token" /></template>
          <USelectMenu
            v-model="form.tokenSecretId"
            :items="secretOptions"
            value-key="value"
            :search-input="{ placeholder: 'Search secrets' }"
            icon="i-lucide-key-round"
            placeholder="Pick a vault secret"
            class="w-full"
          />
        </UFormField>
        <UFormField label="Enabled" name="enabled">
          <USwitch v-model="form.enabled" :disabled="busy" />
        </UFormField>

        <UFormField label="Default assignee" name="defaultAssigneeId">
          <template #hint><FormHint text="User attached to tasks created from this channel" /></template>
          <USelect
            v-model="form.defaultAssigneeId"
            :items="assigneeOptions"
            value-key="value"
            icon="i-lucide-user-check"
            class="w-full"
          />
        </UFormField>

        <UFormField label="Bindings" name="bindings">
          <template #hint
            ><FormHint
              text="Platform user id → Tandem user. A bound platform user acts as that user; unbound senders are refused (default deny)."
          /></template>
          <div class="space-y-2">
            <div v-for="(b, i) in form.bindings" :key="i" class="flex items-center gap-2">
              <UInput
                v-model="b.platformUserId"
                placeholder="@user:example.org"
                :aria-label="`Platform user id ${i + 1}`"
                class="flex-1"
              />
              <USelect
                v-model="b.userId"
                :items="bindingUserOptions"
                value-key="value"
                placeholder="Tandem user"
                :aria-label="`Tandem user ${i + 1}`"
                class="flex-1"
              />
              <UButton
                icon="i-lucide-x"
                variant="ghost"
                color="neutral"
                size="sm"
                :aria-label="`Remove binding ${i + 1}`"
                @click="removeBinding(i)"
              />
            </div>
            <UButton icon="i-lucide-plus" variant="soft" size="sm" label="Add binding" @click="addBinding" />
          </div>
        </UFormField>
        <!-- failure tone only — success is announced by the card-level status;
             a success toast styled as an alert inside a closing modal is noise -->
        <p v-if="message && !messageOk" role="alert" class="text-error text-sm">{{ message }}</p>
      </UForm>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" color="neutral" label="Cancel" :disabled="busy" @click="editorOpen = false" />
        <UButton
          type="submit"
          :loading="busy"
          :label="editingFingerprint !== null ? 'Save changes' : 'Create channel'"
          form="channel-editor-form"
        />
      </div>
    </template>
  </UModal>

  <!-- delete confirm -->
  <UModal v-model:open="removeOpen" title="Delete channel" :dismissible="!busy" :close="!busy">
    <template #body>
      <div class="space-y-4">
        <p class="text-muted text-sm">
          Delete channel
          <span class="text-highlighted font-semibold">{{ pendingRemove?.label }}</span
          >? Messages from its rooms will no longer be relayed.
        </p>
        <!-- the refusal renders INSIDE the open modal: behind the overlay the
             card-level message would stay illegible until Cancel -->
        <UAlert
          v-if="message && !messageOk"
          role="alert"
          icon="i-lucide-circle-alert"
          color="error"
          variant="subtle"
          :title="message"
          :ui="{ title: 'text-sm' }"
        />
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton variant="ghost" color="neutral" label="Cancel" :disabled="busy" @click="pendingRemove = null" />
        <UButton icon="i-lucide-trash-2" color="error" label="Delete" :loading="busy" @click="removeChannel" />
      </div>
    </template>
  </UModal>
</template>
