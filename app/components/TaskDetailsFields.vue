<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
// Details section of the task sidebar: status/assignee/project selects + owner
// display. Self-loads statuses/employees/projects (vue-query dedupes with the
// other panels' display queries) and owns the tasks.update mutation. Reviewers
// are deliberately excluded: the review flow is workflow-governed.
import { computed, onServerPrefetch, ref } from 'vue';

import { CHANGE_RESOURCE } from '#shared/enums';
import { NONE_ID, errorMessage } from '~/utils/forms';
import type { EmployeeRow, TaskRow } from '~/utils/orpc-types';
import { aiOptionLabel } from '~/utils/ui-labels';

const props = defineProps<{ task: TaskRow; runLocked?: boolean }>();

const { $orpc } = useNuxtApp();
const queryClient = useQueryClient();

const statusesLive = useQuery($orpc.statuses.list.queryOptions({ queryKey: [CHANGE_RESOURCE.STATUSES] }));
const statuses = computed(() => unref(statusesLive.data) ?? []);
const statusById = computed(() => new Map(statuses.value.map((x) => [x.id, x])));
const employeesLive = useQuery($orpc.employees.list.queryOptions({ queryKey: [CHANGE_RESOURCE.EMPLOYEES] }));
const employees = computed(() => (unref(employeesLive.data) ?? []) as EmployeeRow[]);
const projectsLive = useQuery($orpc.projects.list.queryOptions({ queryKey: [CHANGE_RESOURCE.PROJECTS] }));
const projects = computed(() => (unref(projectsLive.data) ?? []) as Array<{ id: string; name: string }>);

const updateMutation = useMutation($orpc.tasks.update.mutationOptions());
const setStatusMutation = useMutation($orpc.tasks.setStatus.mutationOptions());
const fieldBusy = ref(false);
const fieldError = ref('');
/** status select: every status is manually reachable (owner ruling 2026-10-27) */
const selectableStatuses = computed(() => [...statusById.value.values()]);
const statusOptions = computed(() => selectableStatuses.value.map((s) => ({ label: s.name, value: s.id })));
const assigneeOptions = computed(() => [
  { label: 'Unassigned', value: NONE_ID },
  ...employees.value.map((e) => ({ label: aiOptionLabel(e.name, e.kind), value: e.id })),
]);
const projectOptions = computed(() => [
  { label: 'No project', value: NONE_ID },
  ...projects.value.map((p) => ({ label: p.name, value: p.id })),
]);
// script-setup helper for template comparisons — an imported binding used
// directly inside a template arrow function trips vue-tsc's maybe-ref unwrap
const isNoneId = (v: string | null | undefined) => v === NONE_ID;
async function updateField(patch: { status?: string; assigneeId?: string | null; projectId?: string | null }) {
  if (fieldBusy.value) return;
  fieldBusy.value = true;
  fieldError.value = '';
  try {
    if (patch.status) {
      await setStatusMutation.mutateAsync({ id: props.task.id, status: patch.status });
    } else {
      await updateMutation.mutateAsync({ id: props.task.id, ...patch });
    }
    await queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASKS] });
  } catch (e) {
    fieldError.value = errorMessage(e, "Couldn't save the change — try again");
  } finally {
    fieldBusy.value = false;
  }
}

onServerPrefetch(() => Promise.all([statusesLive.suspense(), employeesLive.suspense(), projectsLive.suspense()]));
</script>

<template>
  <div>
    <h2 class="text-muted mb-2 text-xs font-medium">Details</h2>
    <!-- one [label | field] grid: every select stretches to the same right edge -->
    <dl class="space-y-1.5 text-sm">
      <div class="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-2">
        <dt class="text-muted text-xs">Status</dt>
        <dd class="min-w-0">
          <USelect
            :model-value="task.status"
            :items="statusOptions"
            value-key="value"
            size="md"
            :disabled="fieldBusy || runLocked"
            aria-label="Task status"
            class="w-full"
            @update:model-value="(v: string) => task && v !== task.status && updateField({ status: v })"
          />
        </dd>
      </div>
      <div class="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-2">
        <dt class="text-muted text-xs">Assignee</dt>
        <dd class="min-w-0">
          <USelect
            :model-value="task.assigneeId ?? NONE_ID"
            :items="assigneeOptions"
            value-key="value"
            size="md"
            :disabled="fieldBusy || runLocked"
            aria-label="Task assignee"
            class="w-full"
            @update:model-value="(v: string) => task && updateField({ assigneeId: isNoneId(v) ? null : v })"
          />
        </dd>
      </div>
      <p v-if="runLocked" class="text-dimmed text-[11px]">Status and assignee are locked while the agent runs.</p>
      <!-- owner is read-only (owner routing lives on the task row): label + subtle chip -->
      <div class="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-2">
        <dt class="text-muted text-xs">Owner</dt>
        <dd class="min-w-0">
          <span class="bg-muted text-toned inline-flex max-w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs">
            <UIcon name="i-lucide-user-round" class="size-3 shrink-0" />
            <span class="truncate" :class="task.ownerName ? '' : 'text-dimmed italic'">{{
              task.ownerName ?? 'Unassigned'
            }}</span>
          </span>
        </dd>
      </div>
      <div class="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-2">
        <dt class="text-muted text-xs">Project</dt>
        <dd class="min-w-0">
          <USelect
            :model-value="task.projectId ?? NONE_ID"
            :items="projectOptions"
            value-key="value"
            size="md"
            :disabled="fieldBusy"
            aria-label="Task project"
            class="w-full"
            @update:model-value="(v: string) => task && updateField({ projectId: isNoneId(v) ? null : v })"
          />
        </dd>
      </div>
    </dl>
    <p v-if="fieldError" role="alert" class="text-error mt-1.5 text-xs">{{ fieldError }}</p>
  </div>
</template>
