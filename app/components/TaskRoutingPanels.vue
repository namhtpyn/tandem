<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query';
// Routing panels: agent proposals (SUBTASKS/REASSIGN awaiting a decision), the
// subtask list + creator, and the assignment history. Rows load as conventional
// GETs keyed on TASKS/TASK_ACTIVITY so the app-wide changes subscription
// refetches them live (SSE law) — proposals/subtasks/assignments track run
// settlements, decisions and task edits without polling. Subtask badges join the
// statuses list (passed down from the page) to render the status NAME in the
// category color, never the raw id. Self-loads employees for the subtask
// assignee picker. Props: `taskId`, `statusById`.
import { computed, ref } from 'vue';

import { CHANGE_RESOURCE, PROPOSAL_KIND, type ProposalKind } from '#shared/enums';
import { nonNull } from '#shared/utils/non-null';
import type { EmployeeRow, TaskStatusRow } from '~/utils/orpc-types';

const props = defineProps<{ taskId: string; statusById: Map<string, TaskStatusRow> }>();

const { $client, $orpc } = useNuxtApp();
const queryClient = useQueryClient();

const employeesLive = useQuery($orpc.employees.list.queryOptions({ queryKey: [CHANGE_RESOURCE.EMPLOYEES] }));
const employees = computed(() => (unref(employeesLive.data) ?? []) as EmployeeRow[]);

interface ChildRow {
  id: string;
  title: string;
  status: string;
  assigneeId: string | null;
}
interface ProposalRow {
  id: string;
  kind: ProposalKind;
  payload: {
    items?: Array<{ title: string; assigneeName?: string }>;
    targetName?: string;
    reason?: string;
  };
  status: string;
  decisionNote: string;
  createdAt: string;
}
interface AssignmentRow {
  id: string;
  employeeName: string | null;
  reason: string;
  startedAt: string;
  endedAt: string | null;
}

// ---- GET-first + change-event invalidation (SSE law): the query keys carry the
// resource prefix, so every TASKS/TASK_ACTIVITY change event (run settles,
// proposal decided, subtask created) refetches the matching panel ----
const subtasksQuery = useQuery(
  computed(() =>
    $orpc.tasks.subtasks.queryOptions({
      input: { taskId: props.taskId },
      queryKey: [CHANGE_RESOURCE.TASKS, props.taskId, 'subtasks'],
    }),
  ),
);
const subtaskRows = computed(() => (unref(subtasksQuery.data)?.items ?? []) as ChildRow[]);

const proposalsQuery = useQuery(
  computed(() =>
    $orpc.tasks.proposals.queryOptions({
      input: { taskId: props.taskId },
      queryKey: [CHANGE_RESOURCE.TASK_ACTIVITY, props.taskId, 'proposals'],
    }),
  ),
);
const proposalRows = computed(() => (unref(proposalsQuery.data)?.items ?? []) as ProposalRow[]);

const assignmentsQuery = useQuery(
  computed(() =>
    $orpc.tasks.assignments.queryOptions({
      input: { taskId: props.taskId },
      queryKey: [CHANGE_RESOURCE.TASKS, props.taskId, 'assignments'],
    }),
  ),
);
const assignmentRows = computed(() => (unref(assignmentsQuery.data)?.items ?? []) as AssignmentRow[]);

const proposalBusy = ref(false);
const proposalMessage = ref('');
const subtaskTitle = ref('');
const subtaskAssignee = ref('__none__');

async function createSubtask() {
  if (!subtaskTitle.value.trim()) return;
  proposalBusy.value = true;
  proposalMessage.value = '';
  try {
    await $client.tasks.create({
      title: subtaskTitle.value.trim(),
      parentId: props.taskId,
      assigneeId: subtaskAssignee.value === '__none__' ? null : subtaskAssignee.value,
    });
    subtaskTitle.value = '';
    subtaskAssignee.value = '__none__';
    // fuse: refetch the subtasks panel now; the SSE event re-syncs the rest
    void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASKS, props.taskId] });
    proposalMessage.value = 'subtask created';
  } catch (e) {
    proposalMessage.value =
      (e as { data?: { json?: { message?: string } }; message?: string }).data?.json?.message ?? (e as Error).message;
  } finally {
    proposalBusy.value = false;
  }
}

async function decideProposal(id: string, action: 'confirmProposal' | 'rejectProposal') {
  proposalBusy.value = true;
  proposalMessage.value = '';
  try {
    const r =
      action === 'confirmProposal'
        ? await $client.tasks.confirmProposal({ proposalId: id })
        : await $client.tasks.rejectProposal({ proposalId: id });
    const events: string[] = 'events' in r && Array.isArray(r.events) ? r.events : [];
    proposalMessage.value = events.length ? events.join('; ') : 'done';
    // fuse: the decision mutates proposals + subtasks + the task row
    void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASKS, props.taskId] });
    void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASK_ACTIVITY, props.taskId] });
    void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.RUNS, props.taskId] });
  } catch (e) {
    proposalMessage.value =
      (e as { data?: { json?: { message?: string } }; message?: string }).data?.json?.message ?? (e as Error).message;
  } finally {
    proposalBusy.value = false;
  }
}

const openProposals = computed(() => proposalRows.value.filter((p) => p.status === 'proposed'));
const assignmentLines = computed(() => {
  const rows = [...assignmentRows.value].reverse(); // oldest first
  return rows.map((r, i) => {
    const from = i === 0 ? '∅' : rows[i - 1] ? nonNull(rows[i - 1]).employeeName : '∅';
    return `${from} → ${r.employeeName ?? '∅'}${r.reason ? ` (${r.reason})` : ''}`;
  });
});

/** subtask badge: joined status row — its NAME in the category color (never the raw id) */
function subtaskBadge(c: ChildRow): { label: string; color: 'primary' | 'success' | 'warning' | 'error' | 'info' | 'neutral' } {
  const st = props.statusById.get(c.status);
  const category = st?.category;
  return {
    label: st?.name ?? c.status,
    color:
      category === 'done'
        ? 'success'
        : category === 'cancelled'
          ? 'error'
          : category === 'in_review'
            ? 'info'
            : category === 'working' || category === 'waiting_answer'
              ? 'warning'
              : 'neutral',
  };
}
</script>

<template>
  <div v-if="openProposals.length" data-testid="proposal-panel">
    <p class="mb-2 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">Agent proposals</p>
    <div class="space-y-2">
      <div
        v-for="p in openProposals"
        :key="p.id"
        class="rounded-lg border border-zinc-200 bg-white p-2.5 text-sm dark:border-zinc-800 dark:bg-zinc-900"
      >
        <p class="mb-1 flex items-center gap-1.5 font-medium text-zinc-800 dark:text-zinc-200">
          <UIcon
            :name="p.kind === PROPOSAL_KIND.SUBTASKS ? 'i-lucide-git-branch' : 'i-lucide-corner-up-right'"
            class="text-primary size-3.5"
          />
          {{ p.kind === PROPOSAL_KIND.SUBTASKS ? 'Split into subtasks' : 'Reassign ticket' }}
        </p>
        <ul
          v-if="p.kind === PROPOSAL_KIND.SUBTASKS"
          class="mb-2 space-y-1 text-xs text-zinc-600 dark:text-zinc-400"
        >
          <li v-for="(item, i) in p.payload.items ?? []" :key="i" class="truncate">
            • {{ item.title
            }}<span v-if="item.assigneeName" class="text-zinc-400"> — {{ item.assigneeName }}</span>
          </li>
        </ul>
        <p v-else class="mb-2 truncate text-xs text-zinc-600 dark:text-zinc-400">
          → {{ p.payload.targetName }}<span v-if="p.payload.reason"> — {{ p.payload.reason }}</span>
        </p>
        <div class="flex gap-2">
          <UButton
            size="xs"
            color="primary"
            icon="i-lucide-check"
            :disabled="proposalBusy"
            @click="decideProposal(p.id, 'confirmProposal')"
            >Confirm</UButton
          >
          <UButton
            size="xs"
            color="neutral"
            variant="outline"
            icon="i-lucide-x"
            :disabled="proposalBusy"
            @click="decideProposal(p.id, 'rejectProposal')"
            >Reject</UButton
          >
        </div>
      </div>
    </div>
  </div>

  <div data-testid="subtask-panel">
    <p class="mb-2 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">Subtasks</p>
    <ul class="space-y-1 text-sm">
      <li v-for="c in subtaskRows" :key="c.id">
        <NuxtLink
          :to="`/tasks/${c.id}`"
          class="flex items-center justify-between gap-2 rounded px-1.5 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <span class="truncate text-zinc-800 dark:text-zinc-200">{{ c.title }}</span>
          <UBadge :color="subtaskBadge(c).color" variant="subtle" size="sm">{{ subtaskBadge(c).label }}</UBadge>
        </NuxtLink>
      </li>
    </ul>
    <div class="mt-2 flex gap-1.5">
      <UInput
        v-model="subtaskTitle"
        placeholder="New subtask…"
        size="xs"
        class="flex-1"
        :disabled="proposalBusy"
        @keydown.enter.prevent="createSubtask"
      />
      <USelect
        v-model="subtaskAssignee"
        :items="[
          { label: 'Unassigned', value: '__none__' },
          ...employees.map((e) => ({ label: e.name, value: e.id })),
        ]"
        size="xs"
        class="w-28"
      />
      <UButton
        size="xs"
        icon="i-lucide-plus"
        :disabled="proposalBusy || !subtaskTitle.trim()"
        @click="createSubtask"
      />
    </div>
  </div>

  <div v-if="assignmentLines.length" data-testid="assignment-history">
    <p class="mb-2 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">Assignees</p>
    <ul class="space-y-0.5 text-xs text-zinc-500">
      <li v-for="(line, i) in assignmentLines" :key="i" class="truncate">{{ line }}</li>
    </ul>
  </div>
</template>
