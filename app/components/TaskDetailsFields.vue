<script setup lang="ts">
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
// Details section of the task sidebar: status/assignee/project selects + owner
// display. Self-loads statuses/employees/projects (vue-query dedupes with the
// other panels' display queries) and owns the tasks.update mutation. Reviewers
// are deliberately excluded: the review flow is workflow-governed.
import { computed, onServerPrefetch, ref } from 'vue';

import { CHANGE_RESOURCE } from '#shared/enums';
import type { EmployeeRow, TaskRow } from '~/utils/orpc-types';

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
  { label: 'Unassigned', value: '__none__' },
  ...employees.value.map((e) => ({ label: e.kind === 'ai' ? `${e.name} (AI)` : e.name, value: e.id })),
]);
const projectOptions = computed(() => [
  { label: 'No project', value: '__none__' },
  ...projects.value.map((p) => ({ label: p.name, value: p.id })),
]);
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
    const err = e as { data?: { json?: { message?: string } }; message?: string };
    fieldError.value = err.data?.json?.message ?? err.message ?? 'update failed';
  } finally {
    fieldBusy.value = false;
  }
}

onServerPrefetch(() => Promise.all([statusesLive.suspense(), employeesLive.suspense(), projectsLive.suspense()]));
</script>

<template>
  <div>
    <p class="mb-2 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">Details</p>
    <dl class="space-y-1.5 text-sm">
      <div class="flex items-center justify-between gap-2">
        <dt class="text-xs text-zinc-500">Status</dt>
        <dd>
          <USelect
            :model-value="task.status"
            :items="statusOptions"
            value-key="value"
            size="md"
            :disabled="fieldBusy || runLocked"
            aria-label="Task status"
            class="w-40"
            @update:model-value="(v: string) => task && v !== task.status && updateField({ status: v })"
          />
        </dd>
      </div>
      <div class="flex items-center justify-between gap-2">
        <dt class="text-xs text-zinc-500">Assignee</dt>
        <dd>
          <USelect
            :model-value="task.assigneeId ?? '__none__'"
            :items="assigneeOptions"
            value-key="value"
            size="md"
            :disabled="fieldBusy || runLocked"
            aria-label="Task assignee"
            class="w-40"
            @update:model-value="(v: string) => task && updateField({ assigneeId: v === '__none__' ? null : v })"
          />
        </dd>
      </div>
      <p v-if="runLocked" class="text-[11px] text-zinc-400">Locked while the agent runs.</p>
      <div class="flex items-center justify-between gap-2">
        <dt class="text-xs text-zinc-500">Owner</dt>
        <dd
          class="truncate text-right"
          :class="task.ownerName ? 'text-zinc-800 dark:text-zinc-200' : 'text-zinc-400 italic'"
        >
          {{ task.ownerName ?? 'None' }}
        </dd>
      </div>
      <div class="flex items-center justify-between gap-2">
        <dt class="text-xs text-zinc-500">Project</dt>
        <dd>
          <USelect
            :model-value="task.projectId ?? '__none__'"
            :items="projectOptions"
            value-key="value"
            size="md"
            :disabled="fieldBusy"
            aria-label="Task project"
            class="w-40"
            @update:model-value="(v: string) => task && updateField({ projectId: v === '__none__' ? null : v })"
          />
        </dd>
      </div>
    </dl>
    <p v-if="fieldError" class="text-error mt-1.5 text-xs">{{ fieldError }}</p>
  </div>
</template>
