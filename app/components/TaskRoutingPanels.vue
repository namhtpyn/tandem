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
import { formatWhenShort } from '~/utils/format-when';
import type { EmployeeRow, TaskStatusRow } from '~/utils/orpc-types';
import { categoryColor } from '~/utils/ui-labels';

const emit = defineEmits<{ 'add-subtask': [] }>();
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
const proposalOk = ref(false); // message tone: confirmed decisions green, failures red

async function decideProposal(id: string, action: 'confirmProposal' | 'rejectProposal') {
  proposalBusy.value = true;
  proposalMessage.value = '';
  try {
    const r =
      action === 'confirmProposal'
        ? await $client.tasks.confirmProposal({ proposalId: id })
        : await $client.tasks.rejectProposal({ proposalId: id });
    const events: string[] = 'events' in r && Array.isArray(r.events) ? r.events : [];
    proposalMessage.value = events.length
      ? events.join('; ')
      : action === 'confirmProposal'
        ? 'Proposal applied'
        : 'Proposal declined';
    proposalOk.value = true;
    // fuse: the decision mutates proposals + subtasks + the task row
    void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASKS, props.taskId] });
    void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASK_ACTIVITY, props.taskId] });
    void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.RUNS, props.taskId] });
  } catch (e) {
    proposalMessage.value =
      (e as { data?: { json?: { message?: string } }; message?: string }).data?.json?.message ??
      (e as Error).message ??
      "Couldn't decide the proposal — try again";
    proposalOk.value = false;
  } finally {
    proposalBusy.value = false;
  }
}

const openProposals = computed(() => proposalRows.value.filter((p) => p.status?.toLowerCase() === 'proposed'));

/** subtask badge: joined status row — its NAME in the shared category color (never the raw id) */
function subtaskBadge(c: ChildRow): {
  label: string;
  color: 'primary' | 'success' | 'warning' | 'error' | 'info' | 'neutral';
} {
  const st = props.statusById.get(c.status);
  return { label: st?.name ?? 'Unknown status', color: categoryColor(st?.category) };
}
</script>

<template>
  <div v-if="openProposals.length" data-testid="proposal-panel">
    <h2 class="text-muted mb-2 text-xs font-medium">Agent proposals</h2>
    <div class="space-y-2">
      <div v-for="p in openProposals" :key="p.id" class="border-default bg-default rounded-lg border p-2.5 text-sm">
        <p class="text-default mb-1 flex items-center gap-1.5 font-medium">
          <UIcon
            :name="p.kind === PROPOSAL_KIND.SUBTASKS ? 'i-lucide-git-branch' : 'i-lucide-corner-up-right'"
            class="text-primary size-3.5"
          />
          {{ p.kind === PROPOSAL_KIND.SUBTASKS ? 'Split into subtasks' : 'Reassign task' }}
        </p>
        <ul v-if="p.kind === PROPOSAL_KIND.SUBTASKS" class="text-toned mb-2 space-y-1 text-xs">
          <li v-for="(item, i) in p.payload.items ?? []" :key="i">
            <span class="text-default">• {{ item.title }}</span>
            <span v-if="item.assigneeName" class="text-dimmed">Assigned to {{ item.assigneeName }}</span>
          </li>
        </ul>
        <p v-else class="text-toned mb-2 truncate text-xs">
          Moves to: {{ p.payload.targetName }}<span v-if="p.payload.reason"> ({{ p.payload.reason }})</span>
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
    <p
      v-if="proposalMessage"
      class="mt-2 text-xs"
      :class="proposalOk ? 'text-success' : 'text-error'"
      :role="proposalOk ? 'status' : 'alert'"
    >
      {{ proposalMessage }}
    </p>
  </div>

  <div data-testid="subtask-panel">
    <h2 class="text-muted mb-2 text-xs font-medium">Subtasks</h2>
    <div v-if="subtasksQuery.isPending.value" class="space-y-1.5" aria-hidden="true">
      <USkeleton class="h-7 w-full rounded" />
      <USkeleton class="h-7 w-4/5 rounded" />
    </div>
    <p v-else-if="subtasksQuery.isError.value" role="alert" class="text-error text-xs">Couldn't load subtasks</p>
    <p v-else-if="!subtaskRows.length" class="text-dimmed text-xs">No subtasks yet</p>
    <ul v-else class="space-y-1 text-sm">
      <li v-for="c in subtaskRows" :key="c.id">
        <NuxtLink
          :to="`/tasks/${c.id}`"
          class="hover:bg-elevated flex items-center justify-between gap-2 rounded px-1.5 py-1"
        >
          <span class="text-default truncate">{{ c.title }}</span>
          <UBadge :color="subtaskBadge(c).color" variant="subtle" size="sm">{{ subtaskBadge(c).label }}</UBadge>
        </NuxtLink>
      </li>
    </ul>
    <UButton
      class="mt-2"
      size="xs"
      color="neutral"
      variant="soft"
      icon="i-lucide-plus"
      label="Add subtask"
      @click="emit('add-subtask')"
    />
  </div>

  <div v-if="assignmentRows.length" data-testid="assignment-history">
    <h2 class="text-muted mb-2 text-xs font-medium">Assignees</h2>
    <ul class="space-y-1 text-xs">
      <!-- who + when — the when replaces dev-speak reason tags like '(on create)' -->
      <li v-for="a in assignmentRows" :key="a.id" class="flex items-baseline justify-between gap-2">
        <span class="text-toned min-w-0 truncate">Assigned to {{ a.employeeName ?? 'Unassigned' }}</span>
        <span class="text-dimmed shrink-0" suppressHydration-warning>{{ formatWhenShort(a.startedAt) }}</span>
      </li>
    </ul>
  </div>
</template>
