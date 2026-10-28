<script setup lang="ts">
// 'Task statuses' manager: workflow status CRUD — the list modal, the
// status editor modal and its transitions picker. Self-loads the statuses
// query + save/remove mutations.
import { useMutation, useQuery } from '@tanstack/vue-query';
import { computed, reactive, ref } from 'vue';

import { CHANGE_RESOURCE } from '#shared/enums';
import { nonNull } from '#shared/utils/non-null';
import type { TaskStatusRow } from '~/utils/orpc-types';
import { categoryColor, categoryLabel } from '~/utils/ui-labels';

const open = defineModel<boolean>('open', { default: false });

const { $orpc } = useNuxtApp();

const statusesLive = useQuery($orpc.statuses.list.queryOptions({ queryKey: [CHANGE_RESOURCE.STATUSES] }));
const statuses = computed(() => unref(statusesLive.data) ?? []);
const statusById = computed(() => new Map(statuses.value.map((x) => [x.id, x])));

// ---- status editor (opened from the manager list) ----
const statusEditorOpen = computed({
  get: () => editingStatusId.value !== null || statusEditorTouched.value,
  set: (v: boolean) => {
    if (!v) {
      editingStatusId.value = null;
      statusEditorTouched.value = false;
    }
  },
});
const statusEditorTouched = ref(false);
const statusBusy = ref(false);
const statusMessage = ref('');
const editingStatusId = ref<string | null>(null);
const statusForm = reactive({
  name: '',
  color: 'neutral' as 'neutral' | 'primary' | 'success' | 'warning' | 'error' | 'info',
  position: 0,
  category: 'backlog' as
    | 'backlog'
    | 'ready'
    | 'working'
    | 'paused'
    | 'waiting_answer'
    | 'in_review'
    | 'done'
    | 'cancelled',
  nextIds: [] as string[],
});

const statusSaveMutation = useMutation($orpc.statuses.save.mutationOptions());
const statusRemoveMutation = useMutation($orpc.statuses.remove.mutationOptions());

const pendingDelete = ref<TaskStatusRow | null>(null);
const deleteOpen = computed({
  get: () => pendingDelete.value !== null,
  set: (v: boolean) => {
    if (!v) pendingDelete.value = null;
  },
});

function openStatusEditor(row?: TaskStatusRow) {
  editingStatusId.value = row?.id ?? null;
  statusForm.name = row?.name ?? '';
  statusForm.color = (row?.color as typeof statusForm.color | undefined) ?? 'neutral';
  statusForm.position = row?.position ?? statuses.value.length;
  statusForm.category = (row?.category as typeof statusForm.category | undefined) ?? 'backlog';
  statusForm.nextIds = row ? [...row.nextIds] : statuses.value.length > 0 ? [nonNull(statuses.value[0]).id] : [];
  statusMessage.value = '';
  statusEditorTouched.value = true;
  // the manager modal STAYS OPEN underneath — the editor stacks on top of it
  // (EmployeeTitlesManager pattern): closing it here would leave no way back
  // to the list and save would never reopen it
}

async function saveStatus() {
  if (!statusForm.name.trim()) return;
  statusBusy.value = true;
  statusMessage.value = '';
  try {
    await statusSaveMutation.mutateAsync({
      ...(editingStatusId.value ? { id: editingStatusId.value } : {}),
      name: statusForm.name.trim(),
      color: statusForm.color,
      position: statusForm.position,
      category: statusForm.category,
      nextIds: statusForm.nextIds,
    });
    statusEditorTouched.value = false;
    editingStatusId.value = null;
  } catch (e) {
    statusMessage.value = e instanceof Error ? e.message : 'Save failed';
  } finally {
    statusBusy.value = false;
  }
}

async function removeStatus() {
  if (!pendingDelete.value) return;
  statusBusy.value = true;
  statusMessage.value = '';
  try {
    await statusRemoveMutation.mutateAsync({ id: pendingDelete.value.id });
    pendingDelete.value = null;
  } catch (e) {
    statusMessage.value = e instanceof Error ? e.message : 'Delete failed';
  } finally {
    statusBusy.value = false;
  }
}

const colorOptions = [
  { label: 'Neutral', value: 'neutral' },
  { label: 'Primary', value: 'primary' },
  { label: 'Success', value: 'success' },
  { label: 'Warning', value: 'warning' },
  { label: 'Error', value: 'error' },
  { label: 'Info', value: 'info' },
];
const categoryOptions = [
  { label: 'Backlog', description: 'Parked, nobody works on it', value: 'backlog' },
  { label: 'Ready', description: 'Assigned agent picks it up', value: 'ready' },
  { label: 'Working', description: 'Hands off, in progress', value: 'working' },
  { label: 'Paused', description: 'Halted, not terminal', value: 'paused' },
  { label: 'Waiting answer', description: 'Question routed, work paused', value: 'waiting_answer' },
  { label: 'In review', description: 'Result awaits unanimous approval', value: 'in_review' },
  { label: 'Done', description: 'Completed, agents stop', value: 'done' },
  { label: 'Cancelled', description: 'Agents stop', value: 'cancelled' },
];
// badge colors + labels come from the SHARED ui-labels mapping (imported above) —
// statuses render the same words/colors as every other surface
</script>

<template>
  <div>
    <UModal
      v-model:open="open"
      title="Task statuses"
      :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }"
    >
      <template #body>
        <div class="space-y-4">
          <p class="text-muted text-xs">
            Define the workflow statuses and which moves are allowed between them (used by the board and the task
            editor).
          </p>
          <p v-if="statusMessage" role="alert" class="text-error text-sm">{{ statusMessage }}</p>
          <div v-if="statuses.length" class="divide-default divide-y">
            <div v-for="st in statuses" :key="st.id" class="flex items-center justify-between gap-2 py-2">
              <div class="min-w-0">
                <p class="text-highlighted flex items-center gap-2 truncate text-sm font-medium">
                  <UBadge :color="st.color as typeof statusForm.color" variant="subtle" size="sm">{{ st.name }}</UBadge>
                  <UBadge :color="categoryColor(st.category)" variant="subtle" size="sm">{{
                    categoryLabel(st.category)
                  }}</UBadge>
                </p>
                <p class="text-dimmed truncate text-xs">
                  {{
                    st.nextIds.length
                      ? `→ ${st.nextIds.map((n) => statusById.get(n)?.name ?? 'Unknown status').join(', ')}`
                      : 'No transitions'
                  }}
                </p>
              </div>
              <div class="flex shrink-0 gap-1">
                <UPopover mode="hover" enable-touch>
                  <UButton
                    icon="i-lucide-pencil"
                    variant="ghost"
                    color="neutral"
                    size="sm"
                    aria-label="Edit status"
                    :disabled="statusBusy"
                    @click="openStatusEditor(st)"
                  />
                  <template #content>
                    <div class="px-3 py-1.5 text-xs">Edit status</div>
                  </template>
                </UPopover>
                <UPopover mode="hover" enable-touch>
                  <UButton
                    icon="i-lucide-trash-2"
                    variant="ghost"
                    color="neutral"
                    class="text-muted hover:text-error"
                    size="sm"
                    aria-label="Delete status"
                    :disabled="statusBusy"
                    @click="pendingDelete = st"
                  />
                  <template #content>
                    <div class="px-3 py-1.5 text-xs">Delete status</div>
                  </template>
                </UPopover>
              </div>
            </div>
          </div>
          <div v-else-if="statusesLive.isPending.value" class="space-y-2" aria-hidden="true">
            <USkeleton class="h-10 w-full rounded-lg" />
            <USkeleton class="h-10 w-full rounded-lg" />
          </div>
          <p v-else-if="statusesLive.isError.value" role="alert" class="text-error text-sm">Couldn't load statuses</p>
          <div
            v-else
            class="border-default flex flex-col items-center gap-3 rounded-xl border border-dashed p-8 text-center"
          >
            <UIcon name="i-lucide-list-todo" class="text-toned size-10" aria-hidden="true" />
            <p class="text-muted text-sm">No statuses yet — define the steps your tasks move through.</p>
            <UButton icon="i-lucide-plus" size="sm" label="New status" @click="openStatusEditor()" />
          </div>
          <div class="flex justify-end">
            <UButton icon="i-lucide-plus" size="sm" label="New status" @click="openStatusEditor()" />
          </div>
        </div>
      </template>
    </UModal>

    <!-- delete confirm (same pattern as the vault/environment delete confirms) -->
    <UModal v-model:open="deleteOpen" title="Delete status">
      <template #body>
        <div class="space-y-4">
          <p class="text-toned text-sm">
            Delete status
            <span class="text-highlighted font-semibold">{{ pendingDelete?.name }}</span
            >? A status still used by tasks can't be deleted, and transitions pointing at it are removed.
          </p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" label="Cancel" @click="pendingDelete = null" />
          <UButton icon="i-lucide-trash-2" color="error" label="Delete" :loading="statusBusy" @click="removeStatus" />
        </div>
      </template>
    </UModal>

    <!-- status editor -->
    <UModal v-model:open="statusEditorOpen" :title="editingStatusId ? 'Edit status' : 'New status'">
      <template #body>
        <div class="space-y-4">
          <UFormField label="Name" name="statusName">
            <UInput v-model="statusForm.name" placeholder="e.g. In review" class="w-full" />
          </UFormField>
          <UFormField label="Color" name="statusColor">
            <USelect v-model="statusForm.color" :items="colorOptions" value-key="value" class="w-full" />
          </UFormField>
          <UFormField label="Position" name="statusPosition">
            <UInput v-model.number="statusForm.position" type="number" min="0" max="99" class="w-full" />
          </UFormField>
          <UFormField label="Meaning" name="statusCategory">
            <template #hint
              ><FormHint text="ready = agents pick tasks up from here; done/cancelled = agents stop working"
            /></template>
            <USelect v-model="statusForm.category" :items="categoryOptions" value-key="value" class="w-full" />
          </UFormField>
          <UFormField label="Can move to" name="statusNext">
            <template #hint><FormHint text="Allowed transitions from this status" /></template>
            <USelectMenu
              v-model="statusForm.nextIds"
              :items="statuses.filter((x) => x.id !== editingStatusId).map((x) => ({ label: x.name, value: x.id }))"
              value-key="value"
              multiple
              class="w-full"
              placeholder="Pick allowed next statuses"
            />
          </UFormField>
          <p v-if="statusMessage" role="alert" class="text-error text-sm">{{ statusMessage }}</p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" label="Cancel" @click="statusEditorOpen = false" />
          <UButton
            icon="i-lucide-check"
            label="Save status"
            :loading="statusBusy"
            :disabled="!statusForm.name.trim()"
            @click="saveStatus"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
