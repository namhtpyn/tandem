<script setup lang="ts">
// 'Task statuses' manager: workflow status CRUD — the list modal, the
// status editor modal and its transitions picker. Self-loads the statuses
// query + save/remove mutations.
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, reactive, ref } from 'vue';
import { z } from 'zod';

import { CATEGORIES, CATEGORY, CHANGE_RESOURCE, type Category } from '#shared/enums';
import { saveFailed } from '~/utils/forms';
import type { TaskStatusRow } from '~/utils/orpc-types';
import { categoryColor, categoryLabel } from '~/utils/ui-labels';

const open = defineModel<boolean>('open', { default: false });

const { $orpc } = useNuxtApp();
const queryClient = useQueryClient();

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
      // a save error belongs to the editor that produced it, not the next open
      statusMessage.value = '';
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
  category: CATEGORY.BACKLOG as Category,
  nextIds: [] as string[],
});

const statusSaveMutation = useMutation($orpc.statuses.save.mutationOptions());
const statusRemoveMutation = useMutation($orpc.statuses.remove.mutationOptions());

const deleteError = ref('');
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
  // new statuses land at the END of the workflow, not at the row count (custom
  // positions may be sparse or duplicated)
  let maxPos = -1;
  for (const st of statuses.value) maxPos = Math.max(maxPos, st.position);
  statusForm.position = row?.position ?? maxPos + 1;
  statusForm.category = (row?.category as Category | undefined) ?? CATEGORY.BACKLOG;
  statusForm.nextIds = row ? [...row.nextIds] : [];
  statusMessage.value = '';
  statusEditorTouched.value = true;
  // the manager modal STAYS OPEN underneath — the editor stacks on top of it
  // (EmployeeTitlesManager pattern): closing it here would leave no way back
  // to the list and save would never reopen it
}

async function saveStatus() {
  // one write at a time — a double-click or stray Enter must not double-create
  if (statusBusy.value) return;
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
    // SSE-down backstop: the manager's own list must refetch even without the bus
    void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.STATUSES] });
  } catch (e) {
    statusMessage.value = saveFailed(e, 'status');
  } finally {
    statusBusy.value = false;
  }
}

async function removeStatus() {
  if (!pendingDelete.value || statusBusy.value) return;
  statusBusy.value = true;
  try {
    await statusRemoveMutation.mutateAsync({ id: pendingDelete.value.id });
    pendingDelete.value = null;
    // SSE-down backstop: the manager's own list must refetch even without the bus
    void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.STATUSES] });
  } catch (e) {
    // in-modal law: the confirm stays open, the failure renders inside it
    deleteError.value = saveFailed(e, 'status', 'delete');
  } finally {
    statusBusy.value = false;
  }
}

// loose frontend schema (repo law): name presence only — the server owns the rest
const statusSchema = z.object({ name: z.string().min(1, 'Name is required') });

const colorOptions = [
  { label: 'Neutral', value: 'neutral' },
  { label: 'Primary', value: 'primary' },
  { label: 'Success', value: 'success' },
  { label: 'Warning', value: 'warning' },
  { label: 'Error', value: 'error' },
  { label: 'Info', value: 'info' },
];
/** category copy only — the SET comes from the shared CATEGORY enum, so a new
 *  category can't be offered in the UI without existing on the server */
const CATEGORY_COPY: Record<Category, string> = {
  [CATEGORY.BACKLOG]: 'Parked, nobody works on it',
  [CATEGORY.READY]: 'Assigned agent picks it up',
  [CATEGORY.WORKING]: 'Hands off, in progress',
  [CATEGORY.PAUSED]: 'Halted, not terminal',
  [CATEGORY.WAITING_ANSWER]: 'Question routed, work paused',
  [CATEGORY.IN_REVIEW]: 'Result awaits unanimous approval',
  [CATEGORY.DONE]: 'Completed, agents stop',
  [CATEGORY.CANCELLED]: 'Agents stop',
};
const categoryOptions = CATEGORIES.map((value) => ({
  label: categoryLabel(value),
  description: CATEGORY_COPY[value],
  value,
}));
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
                    :aria-label="`Edit ${st.name}`"
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
                    :aria-label="`Delete ${st.name}`"
                    :disabled="statusBusy"
                    @click="
                      deleteError = '';
                      pendingDelete = st;
                    "
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
          <div v-if="statuses.length" class="flex justify-end">
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
            <span class="text-highlighted font-semibold">{{ pendingDelete?.name }}</span> will disappear from the
            workflow. If any task still sits in it the delete is refused — move those tasks to another status first.
            Transitions pointing at it are removed with it.
          </p>
          <UAlert
            v-if="deleteError"
            role="alert"
            icon="i-lucide-circle-alert"
            color="error"
            variant="subtle"
            :title="deleteError"
            :ui="{ title: 'text-sm' }"
          />
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
        <UForm
          id="status-editor-form"
          :schema="statusSchema"
          :state="statusForm"
          class="space-y-4"
          @submit="saveStatus"
        >
          <UFormField label="Name" name="name">
            <UInput v-model="statusForm.name" placeholder="e.g. In review" class="w-full" />
          </UFormField>
          <UFormField label="Color" name="color">
            <USelect v-model="statusForm.color" :items="colorOptions" value-key="value" class="w-full" />
          </UFormField>
          <UFormField label="Position" name="position">
            <UInput v-model.number="statusForm.position" type="number" min="0" max="99" class="w-full" />
          </UFormField>
          <UFormField label="Meaning" name="category">
            <template #hint
              ><FormHint
                text="Agents pick up tasks whose status sits in Ready; they stop working on Done and Cancelled statuses"
            /></template>
            <USelect v-model="statusForm.category" :items="categoryOptions" value-key="value" class="w-full" />
          </UFormField>
          <UFormField label="Can move to" name="nextIds">
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
        </UForm>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" label="Cancel" @click="statusEditorOpen = false" />
          <UButton
            type="submit"
            form="status-editor-form"
            icon="i-lucide-check"
            :label="editingStatusId ? 'Save changes' : 'Create status'"
            :loading="statusBusy"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
