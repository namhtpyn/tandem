<script setup lang="ts">
// Self-contained tasks manager: server-paged/searched/filtered list
// (tasks.listPaged — q + statusId + inboxOfMe), the statuses/employees/projects
// display joins, the needs-my-decision inbox toggle (badge from tasks.inbox,
// list filtered server-side), status filter chips, the List/Board toggle with
// kanban board, the workflow drawer, the delete confirm and composition of the
// task editor + statuses manager.
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/vue-query';
import { watchDebounced } from '@vueuse/core';
import { computed, ref, watch } from 'vue';

import { ACTIVITY_KIND, CHANGE_RESOURCE } from '#shared/enums';
import { formatWhen } from '~/utils/format-when';
import type { EmployeeRow, TaskRow } from '~/utils/orpc-types';
import { categoryColor } from '~/utils/ui-labels';

const { $orpc, $client } = useNuxtApp();

const page = ref(1);
const pageSize = ref(20);
const search = ref('');
const searchDebounced = ref('');
watchDebounced(
  search,
  (v) => {
    searchDebounced.value = v.trim();
    page.value = 1;
  },
  { debounce: 300, maxWait: 1000 },
);

// server-side filters: status chips + needs-my-decision (inbox) — rows come
// pre-filtered from the API
const statusId = ref<string | null>(null);
const needsDecision = ref(false);
watch([statusId, needsDecision], () => {
  page.value = 1;
});
function toggleStatusFilter(id: string) {
  statusId.value = statusId.value === id ? null : id;
}

const pagedQuery = useQuery(
  computed(() =>
    $orpc.tasks.listPaged.queryOptions({
      input: {
        page: page.value,
        pageSize: pageSize.value,
        q: searchDebounced.value || undefined,
        statusId: statusId.value ?? undefined,
        inboxOfMe: needsDecision.value,
      },
      queryKey: [
        CHANGE_RESOURCE.TASKS,
        'paged',
        page.value,
        pageSize.value,
        searchDebounced.value,
        statusId.value ?? 'all',
        needsDecision.value,
      ],
      placeholderData: keepPreviousData,
    }),
  ),
);
const rows = computed<TaskRow[]>(() => pagedQuery.data.value?.data ?? []);
const total = computed(() => pagedQuery.data.value?.total ?? 0);
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));

// deleting the last row of a high page clamps back into range — skip transient totals
watch(total, (t) => {
  if (!t) return;
  const maxPage = Math.max(1, Math.ceil(t / pageSize.value));
  if (page.value > maxPage) page.value = maxPage;
});

// display joins (small): status names/colors, employee names, project names
const statusesLive = useQuery($orpc.statuses.list.queryOptions({ queryKey: [CHANGE_RESOURCE.STATUSES] }));
const employeesLive = useQuery($orpc.employees.list.queryOptions({ queryKey: [CHANGE_RESOURCE.EMPLOYEES] }));
const projectsLive = useQuery($orpc.projects.list.queryOptions({ queryKey: [CHANGE_RESOURCE.PROJECTS] }));
const statuses = computed(() => unref(statusesLive.data) ?? []);
const statusById = computed(() => new Map(statuses.value.map((x) => [x.id, x])));
const employees = computed(() => (unref(employeesLive.data) ?? []) as EmployeeRow[]);
const assigneeNameById = computed(() => new Map(employees.value.map((e) => [e.id, e.name])));
const projectRows = computed(() => (unref(projectsLive.data) ?? []) as Array<{ id: string; name: string }>);
const projectNameById = computed(() => new Map(projectRows.value.map((p) => [p.id, p.name])));

// ---- "needs my decision" inbox: this query drives the COUNT/badge only; the
// list itself is filtered server-side via the inboxOfMe input ----
const inboxQuery = useQuery($orpc.tasks.inbox.queryOptions({ queryKey: [CHANGE_RESOURCE.TASKS, 'inbox'] }));
interface InboxItem {
  taskId: string;
  role: string;
  title: string;
  status: string;
}
const inboxItems = computed<InboxItem[]>(
  () => (unref(inboxQuery.data) as { items?: InboxItem[] } | undefined)?.items ?? [],
);
const inboxCount = computed(() => inboxItems.value.length);

const statusOptions = computed(() => statuses.value.map((x) => ({ label: x.name, value: x.id })));

// one shared category→color mapping (ui-labels) — statuses agree with the detail page
function statusColor(s: string) {
  return categoryColor(statusById.value.get(s)?.category);
}

// ---- mutations (list rows) ----
const queryClient = useQueryClient();
const setStatusMutation = useMutation($orpc.tasks.setStatus.mutationOptions());
const removeMutation = useMutation($orpc.tasks.remove.mutationOptions());
const assignMutation = useMutation($orpc.statuses.assign.mutationOptions());

const busy = ref(false);
const message = ref('');
const messageOk = ref(false); // message tone: only auto-assign success renders green

async function setStatus(row: TaskRow, status: string) {
  if (row.status === status) return;
  // manual status is FREE (owner ruling 2026-10-27): every status is reachable from
  // every surface — the server is the only gate
  message.value = '';
  messageOk.value = false;
  try {
    await setStatusMutation.mutateAsync({ id: row.id, status });
  } catch (e) {
    message.value = e instanceof Error ? e.message : "Couldn't update status — try again";
  }
}

async function autoAssign(row: TaskRow) {
  message.value = '';
  messageOk.value = false;
  try {
    const res = await assignMutation.mutateAsync({ taskId: row.id });
    if (res.assigned) {
      message.value = `Assigned to ${assigneeNameById.value.get(res.employeeId) ?? 'employee'} — match confidence ${(
        res.confidence * 100
      ).toFixed(0)}%`;
      messageOk.value = true;
    } else {
      message.value = 'No confident match — nobody was auto-assigned';
    }
  } catch (e) {
    message.value = e instanceof Error ? e.message : "Couldn't auto-assign — try again";
  }
}

const pendingDelete = ref<TaskRow | null>(null);
const deleteOpen = computed({
  get: () => pendingDelete.value !== null,
  set: (v: boolean) => {
    if (!v) pendingDelete.value = null;
  },
});

async function remove() {
  if (!pendingDelete.value) return;
  busy.value = true;
  try {
    await removeMutation.mutateAsync({ id: pendingDelete.value.id });
    pendingDelete.value = null;
  } catch (e) {
    message.value = e instanceof Error ? e.message : "Couldn't delete the task — try again";
  } finally {
    busy.value = false;
  }
}

// ---- composed controls ----
const editorOpen = ref(false);
const editingTask = ref<TaskRow | null>(null);
function openEditor(row?: TaskRow) {
  editingTask.value = row ?? null;
  editorOpen.value = true;
}
const statusManagerOpen = ref(false);

function onSaved() {
  // SSE invalidates on the change event too; this keeps non-SSE contexts fresh
  void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASKS] });
}

// ---- workflow drawer ----
const workflowOpen = ref(false);
// the drawer holds the task ID, not a frozen row copy: the displayed task
// re-resolves from the live paged list on every TASKS invalidation so a verdict
// or submit immediately reflects (status change, reviewer state, …). The last
// fresh row is kept as fallback for when the row leaves the current page/filter.
const workflowTaskId = ref<string | null>(null);
const workflowTaskFallback = ref<TaskRow | null>(null);
const workflowTaskLive = computed(() => rows.value.find((t) => t.id === workflowTaskId.value) ?? null);
const workflowTask = computed<TaskRow | null>(() => workflowTaskLive.value ?? workflowTaskFallback.value);
watch(workflowTaskLive, (t) => {
  if (t) workflowTaskFallback.value = t;
});
const workflowNote = ref('');
const workflowBusy = ref(false);
const workflowMessage = ref('');
const workflowOk = ref(true); // message tone: success copy vs failure copy
// the workflow gate keys off the status CATEGORY (not seeded uuids): ready /
// working / paused are the work states where forward/abandon/submit apply
const workflowStatusCategory = computed(() =>
  workflowTask.value ? (statusById.value.get(workflowTask.value.status)?.category ?? null) : null,
);
const workflowIsWorking = computed(
  () =>
    workflowStatusCategory.value === 'ready' ||
    workflowStatusCategory.value === 'working' ||
    workflowStatusCategory.value === 'paused',
);

/** drawer composer: send is the answer verb while the task waits for one */
function sendDrawerNote() {
  if (!workflowTask.value) return;
  if (workflowStatusCategory.value === 'waiting_answer') wfAction('answer', { body: workflowNote.value });
  else wfAction('note', { body: workflowNote.value });
}
const forwardTo = ref('__none__');

// ---- drawer data: conventional GETs + change-event invalidation (SSE law) ----
// runs/activity load as plain GETs once the drawer opens; the app-wide changes
// subscription refetches them while it stays open — no polling, no per-drawer
// SSE streams. Gated with `enabled`, NOT skipToken: bundlers can duplicate the
// skipToken symbol across chunks (oRPC vs vue-query), which silently defeats
// oRPC's own skip detection and the query fires with a serialized-away input.
const drawerTaskId = computed(() => (workflowOpen.value && workflowTask.value ? workflowTask.value.id : ''));
const drawerRunsQuery = useQuery(
  computed(() =>
    $orpc.tasks.runsList.queryOptions({
      input: { taskId: drawerTaskId.value },
      queryKey: [CHANGE_RESOURCE.RUNS, drawerTaskId.value],
      enabled: !!drawerTaskId.value,
    }),
  ),
);
const runFeed = computed(
  () =>
    (unref(drawerRunsQuery.data) ?? []) as unknown as Array<{
      id: string;
      status: string;
      output: string;
      exitCode: number | null;
      startedAt: string;
    }>,
);
const drawerActivityQuery = useQuery(
  computed(() =>
    $orpc.tasks.activityList.queryOptions({
      input: { taskId: drawerTaskId.value },
      queryKey: [CHANGE_RESOURCE.TASK_ACTIVITY, drawerTaskId.value],
      enabled: !!drawerTaskId.value,
    }),
  ),
);
const workflowFeed = computed(() => unref(drawerActivityQuery.data) ?? []);

// run rows read as sentences — 'Run failed (exit code 1)', never bare status jargon
function runLabel(r: { status: string; exitCode: number | null }) {
  const s = r.status.toLowerCase();
  if (s === 'running') return 'Run in progress';
  if (s === 'done') return 'Run completed';
  if (s === 'failed') return r.exitCode ? `Run failed (exit code ${r.exitCode})` : 'Run failed';
  if (s === 'cancelled') return 'Run cancelled';
  if (s === 'timeout') return 'Run timed out';
  return 'Run stopped';
}
// same mapping as runLabel, for the status dot color (cancelled/timeout stay neutral)
function runDot(r: { status: string }) {
  const s = r.status.toLowerCase();
  if (s === 'running') return 'bg-warning animate-pulse';
  if (s === 'done') return 'bg-success';
  if (s === 'failed') return 'bg-error';
  return 'bg-accented';
}

// activity kinds read as words, not enum fragments
const ACTIVITY_LABELS: Record<string, string> = {
  [ACTIVITY_KIND.NOTE]: 'Note',
  [ACTIVITY_KIND.QUESTION]: 'Question',
  [ACTIVITY_KIND.ANSWER]: 'Answer',
  [ACTIVITY_KIND.VERDICT]: 'Review verdict',
  [ACTIVITY_KIND.FORWARD]: 'Forwarded',
  [ACTIVITY_KIND.STATUS]: 'Status changed',
};

// board column dot: category-driven text color (mirrors categoryColor's mapping)
const CATEGORY_TEXT: Record<string, string> = {
  done: 'text-success',
  cancelled: 'text-error',
  blocked: 'text-error',
  working: 'text-warning',
  waiting_answer: 'text-warning',
  in_review: 'text-info',
  todo: 'text-dimmed',
};

const retryInMin = computed(() => {
  const t = workflowTask.value;
  if (!t?.dispatchAfter) return 0;
  const ms = new Date(t.dispatchAfter).getTime() - Date.now();
  return ms > 0 ? Math.max(1, Math.round(ms / 60_000)) : 0;
});

function openWorkflow(row: TaskRow) {
  workflowTaskId.value = row.id;
  workflowTaskFallback.value = row;
  workflowNote.value = '';
  workflowMessage.value = '';
  workflowOpen.value = true;
}

// zod strips unknown keys, so optional extras ride along safely
type WorkflowAction =
  | 'dispatch'
  | 'note'
  | 'submit'
  | 'ask'
  | 'forward'
  | 'answer'
  | 'approve'
  | 'requestChanges'
  | 'reject'
  | 'abandon';

// every verb names what just happened (and what to retry) — no bare 'done'/'action failed'
const WF_COPY: Record<WorkflowAction, { ok: string; fail: string }> = {
  dispatch: { ok: 'Agent dispatched', fail: "Couldn't dispatch — try again" },
  note: { ok: 'Note added', fail: "Couldn't add the note — try again" },
  submit: { ok: 'Sent for review', fail: "Couldn't submit for review — try again" },
  ask: { ok: 'Question sent', fail: "Couldn't send the question — try again" },
  forward: { ok: 'Forwarded', fail: "Couldn't forward — try again" },
  answer: { ok: 'Answer sent', fail: "Couldn't send the answer — try again" },
  approve: { ok: 'Approved', fail: "Couldn't approve — try again" },
  requestChanges: { ok: 'Changes requested', fail: "Couldn't request changes — try again" },
  reject: { ok: 'Rejected', fail: "Couldn't reject — try again" },
  abandon: { ok: 'Task abandoned', fail: "Couldn't abandon the task — try again" },
};

async function wfAction(action: WorkflowAction, extra: { body?: string; toEmployeeId?: string } = {}) {
  if (!workflowTask.value) return;
  const taskId = workflowTask.value.id;
  workflowBusy.value = true;
  workflowMessage.value = '';
  try {
    const input = { taskId, ...extra };
    await {
      dispatch: () => $client.tasks.dispatch({ taskId: input.taskId }),
      note: () => $client.tasks.note({ ...input, body: nonNull(input.body) }),
      // body is optional server-side (submitResult defaults it) — an empty note is fine
      submit: () => $client.tasks.submit({ ...input, body: input.body || undefined }),
      ask: () => $client.tasks.ask({ ...input, body: nonNull(input.body) }),
      forward: () => $client.tasks.forward({ ...input, toEmployeeId: nonNull(input.toEmployeeId) }),
      answer: () => $client.tasks.answer({ ...input, body: nonNull(input.body) }),
      approve: () => $client.tasks.approve(input),
      requestChanges: () => $client.tasks.requestChanges({ ...input, body: nonNull(input.body) }),
      reject: () => $client.tasks.reject(input),
      abandon: () => $client.tasks.abandon(input),
    }[action]();
    workflowNote.value = '';
    // invalidate BOTH feeds: TASKS re-syncs the drawer's task row (status/reviewers),
    // TASK_ACTIVITY keeps the thread and activity feed current
    void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASKS] });
    void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASK_ACTIVITY, taskId] });
    workflowMessage.value = WF_COPY[action].ok;
    workflowOk.value = true;
  } catch (e) {
    // surface the server's oRPC message, not ofetch's generic '[POST] …: 400'
    const err = e as { data?: { json?: { message?: string }; message?: string }; message?: string };
    workflowMessage.value = err.data?.json?.message ?? err.data?.message ?? err.message ?? WF_COPY[action].fail;
    workflowOk.value = false;
  } finally {
    workflowBusy.value = false;
  }
}

// review verdicts are an explicit-reviewer surface — nobody else sees the box
const session = useAppSession();
const drawerCanReview = computed(() => !!workflowTask.value?.reviewerNames.includes(session.value?.user.name ?? ''));

// ---- board (kanban) view ----
// Persisted client-side only (localStorage via VueUse) — deliberately NOT a DB setting.
const view = useLocalStorage<'list' | 'board'>('tasks:view', 'list');
const draggingId = ref<string | null>(null);
const dropTarget = ref<string | null>(null);
const boardColumns = computed(() => statuses.value);

// manual status is FREE on every surface (owner ruling) — any column is a legal drop

function tasksByStatus(status: string) {
  return rows.value.filter((t) => t.status === status);
}

function onDrop(status: string) {
  const id = draggingId.value;
  draggingId.value = null;
  dropTarget.value = null;
  const row = rows.value.find((t) => t.id === id);
  if (!row || row.status === status) return;
  void setStatus(row, status);
}

const tableColumns = [
  { accessorKey: 'title', header: 'Task' },
  { accessorKey: 'assigneeName', header: 'Assignee' },
  { accessorKey: 'status', header: 'Status' },
  { accessorKey: 'updatedAt', header: 'Updated' },
  { id: 'actions', header: '' },
];

onServerPrefetch(() =>
  Promise.all([
    pagedQuery.suspense(),
    statusesLive.suspense(),
    employeesLive.suspense(),
    projectsLive.suspense(),
    inboxQuery.suspense(),
  ]),
);
</script>

<template>
  <div>
    <div class="flex flex-wrap items-center justify-end gap-2">
      <div class="border-default inline-flex overflow-hidden rounded-md border" role="group" aria-label="View">
        <button
          type="button"
          class="px-3 py-1.5 text-sm font-medium transition-colors"
          :class="view === 'list' ? 'bg-primary/10 text-primary' : 'text-muted hover:text-highlighted'"
          aria-label="List view"
          @click="view = 'list'"
        >
          List
        </button>
        <button
          type="button"
          class="border-default border-l px-3 py-1.5 text-sm font-medium transition-colors"
          :class="view === 'board' ? 'bg-primary/10 text-primary' : 'text-muted hover:text-highlighted'"
          aria-label="Board view"
          @click="view = 'board'"
        >
          Board
        </button>
      </div>
      <UButton
        :color="needsDecision ? 'primary' : 'neutral'"
        :variant="needsDecision ? 'solid' : 'outline'"
        size="sm"
        :aria-pressed="needsDecision"
        data-testid="needs-decision-toggle"
        @click="needsDecision = !needsDecision"
      >
        <span class="inline-flex items-center gap-1.5">
          <UIcon name="i-lucide-inbox" class="size-4" />
          Needs my decision
          <span
            v-if="inboxCount > 0"
            class="bg-primary text-inverted inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-4 font-semibold"
            data-testid="inbox-count"
            >{{ inboxCount }}</span
          >
        </span>
      </UButton>
      <UButton
        icon="i-lucide-settings-2"
        label="Statuses"
        color="neutral"
        variant="outline"
        size="sm"
        @click="statusManagerOpen = true"
      />
      <UButton icon="i-lucide-plus" label="New task" @click="openEditor()" />
    </div>

    <p v-if="message" class="text-sm" :class="messageOk ? 'text-success' : 'text-error'" role="status">
      {{ message }}
    </p>

    <!-- status filter chips (server-side statusId filter) -->
    <div v-if="statuses.length" class="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by status">
      <UButton
        size="xs"
        :variant="statusId === null ? 'solid' : 'soft'"
        :color="statusId === null ? 'primary' : 'neutral'"
        :aria-pressed="statusId === null"
        @click="statusId = null"
        >All</UButton
      >
      <UButton
        v-for="st in statuses"
        :key="st.id"
        size="xs"
        :variant="statusId === st.id ? 'solid' : 'soft'"
        :color="statusId === st.id ? 'primary' : 'neutral'"
        :aria-pressed="statusId === st.id"
        @click="toggleStatusFilter(st.id)"
      >
        {{ st.name }}
      </UButton>
    </div>

    <!-- server-paged list (desktop table + mobile cards) -->
    <DataTable
      v-if="view === 'list'"
      v-model:search="search"
      searchable
      search-placeholder="Search tasks…"
      :data="rows"
      v-model:page="page"
      :page-count="pageCount"
      :page-size="pageSize"
      :columns="tableColumns"
    >
      <template #title-cell="{ row }">
        <div class="min-w-0">
          <NuxtLink :to="`/tasks/${row.original.id}`" class="text-highlighted truncate font-medium hover:underline">{{
            row.original.title
          }}</NuxtLink>
          <p v-if="row.original.projectName" class="text-primary flex items-center gap-1 text-xs">
            <UIcon name="i-lucide-folder-kanban" class="size-3" />{{ row.original.projectName }}
          </p>
        </div>
      </template>
      <template #assignee-cell="{ row }">
        <span class="text-toned flex items-center gap-1.5 text-sm">
          <UIcon v-if="row.original.assigneeKind === 'ai'" name="i-lucide-bot" class="text-primary size-3.5" />
          {{ row.original.assigneeName ?? 'Unassigned' }}
        </span>
      </template>
      <template #status-cell="{ row }">
        <USelect
          :model-value="row.original.status"
          :items="statusOptions"
          value-key="value"
          size="sm"
          class="w-32"
          :aria-label="`Status for ${row.original.title}`"
          @update:model-value="(v: string) => setStatus(row.original, v)"
        />
      </template>
      <template #updatedAt-cell="{ row }">
        <span suppressHydration-warning class="text-muted text-xs">{{ formatWhen(row.original.updatedAt) }}</span>
      </template>
      <template #actions-cell="{ row }">
        <div class="flex justify-end gap-1">
          <UPopover mode="hover">
            <UButton
              icon="i-lucide-wand-sparkles"
              variant="ghost"
              color="neutral"
              size="xs"
              aria-label="Auto-assign"
              :disabled="busy"
              @click="autoAssign(row.original)"
            />
            <template #content>
              <div class="px-3 py-1.5 text-xs">Auto-assign</div>
            </template>
          </UPopover>
          <UPopover mode="hover">
            <UButton
              icon="i-lucide-message-circle-more"
              variant="ghost"
              color="neutral"
              size="xs"
              aria-label="Task workflow"
              @click="openWorkflow(row.original)"
            />
            <template #content>
              <div class="px-3 py-1.5 text-xs">Workflow &amp; activity</div>
            </template>
          </UPopover>
          <UPopover mode="hover">
            <UButton
              icon="i-lucide-pencil"
              variant="ghost"
              color="neutral"
              size="xs"
              aria-label="Edit task"
              @click="openEditor(row.original)"
            />
            <template #content>
              <div class="px-3 py-1.5 text-xs">Edit task</div>
            </template>
          </UPopover>
          <UPopover mode="hover">
            <UButton
              icon="i-lucide-trash-2"
              variant="ghost"
              color="error"
              size="xs"
              aria-label="Delete task"
              @click="pendingDelete = row.original"
            />
            <template #content>
              <div class="px-3 py-1.5 text-xs">Delete task</div>
            </template>
          </UPopover>
        </div>
      </template>
      <template #mobile-item="{ row }">
        <UCard :ui="{ root: 'shadow-sm' }">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <NuxtLink :to="`/tasks/${row.id}`" class="text-highlighted truncate font-medium hover:underline">{{
                row.title
              }}</NuxtLink>
              <p v-if="row.projectName" class="text-primary mt-0.5 flex items-center gap-1 text-xs">
                <UIcon name="i-lucide-folder-kanban" class="size-3" />{{ row.projectName }}
              </p>
              <p class="text-dimmed mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                <span>{{ assigneeNameById.get(row.assigneeId ?? '') ?? 'Unassigned' }}</span>
                <span v-if="row.assigneeKind === 'ai'" class="text-primary inline-flex items-center gap-1"
                  ><UIcon name="i-lucide-bot" class="size-3" />AI</span
                >
              </p>
            </div>
            <UBadge :color="statusColor(row.status)" variant="subtle" size="sm">{{
              statusById.get(row.status)?.name ?? row.status
            }}</UBadge>
          </div>
          <div class="mt-3 flex items-center justify-between">
            <USelect
              :model-value="row.status"
              :items="statusOptions"
              value-key="value"
              size="sm"
              class="w-32"
              icon="i-lucide-circle-dot"
              :aria-label="`Status for ${row.title}`"
              @update:model-value="(v: string) => setStatus(row, v)"
            />
            <div class="flex items-center gap-1">
              <UPopover mode="hover">
                <UButton
                  icon="i-lucide-wand-sparkles"
                  variant="ghost"
                  color="neutral"
                  size="sm"
                  aria-label="Auto-assign"
                  :disabled="busy"
                  @click="autoAssign(row)"
                />
                <template #content>
                  <div class="px-3 py-1.5 text-xs">Auto-assign</div>
                </template>
              </UPopover>
              <UPopover mode="hover">
                <UButton
                  icon="i-lucide-message-circle-more"
                  variant="ghost"
                  color="neutral"
                  size="sm"
                  aria-label="Task workflow"
                  @click="openWorkflow(row)"
                />
                <template #content>
                  <div class="px-3 py-1.5 text-xs">Workflow &amp; activity</div>
                </template>
              </UPopover>
              <UPopover mode="hover">
                <UButton
                  icon="i-lucide-pencil"
                  variant="ghost"
                  color="neutral"
                  size="sm"
                  aria-label="Edit task"
                  @click="openEditor(row)"
                />
                <template #content>
                  <div class="px-3 py-1.5 text-xs">Edit task</div>
                </template>
              </UPopover>
              <UPopover mode="hover">
                <UButton
                  icon="i-lucide-trash-2"
                  variant="ghost"
                  color="error"
                  size="sm"
                  aria-label="Delete task"
                  @click="pendingDelete = row"
                />
                <template #content>
                  <div class="px-3 py-1.5 text-xs">Delete task</div>
                </template>
              </UPopover>
            </div>
          </div>
        </UCard>
      </template>
    </DataTable>

    <!-- empty state -->
    <UCard v-if="view === 'list' && !rows.length" :ui="{ root: 'shadow-sm' }">
      <template #body>
        <div class="flex flex-col items-center gap-2 py-6 text-center">
          <UIcon name="i-lucide-list-todo" class="text-dimmed size-8" />
          <p class="text-muted text-sm">
            {{
              statusId || needsDecision || searchDebounced
                ? 'No tasks match the current filters.'
                : 'No tasks yet. Create the first one for your humans or agents.'
            }}
          </p>
          <UButton icon="i-lucide-plus" size="sm" class="mt-2" @click="openEditor()">New task</UButton>
        </div>
      </template>
    </UCard>

    <!-- kanban board view (over the same server-paged rows) -->
    <div v-if="view === 'board'" class="space-y-4">
      <div class="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div
          v-for="col in boardColumns"
          :key="col.id"
          class="border-default bg-muted/60 flex min-h-40 flex-col rounded-lg border"
          :class="dropTarget === col.id ? 'ring-primary ring-2' : ''"
          @dragover.prevent="dropTarget = col.id"
          @dragleave="dropTarget === col.id && (dropTarget = null)"
          @drop.prevent="onDrop(col.id)"
        >
          <div class="border-default flex items-center justify-between gap-2 border-b px-3 py-2">
            <p class="text-toned flex items-center gap-1.5 text-sm font-medium">
              <UIcon name="i-lucide-circle-dot" class="size-4" :class="CATEGORY_TEXT[col.category] ?? 'text-dimmed'" />
              {{ col.name }}
            </p>
            <UBadge color="neutral" variant="subtle" size="sm">{{ tasksByStatus(col.id).length }}</UBadge>
          </div>
          <div class="flex-1 space-y-2 p-2">
            <UCard
              v-for="row in tasksByStatus(col.id)"
              :key="row.id"
              :ui="{ root: 'shadow-sm cursor-grab active:cursor-grabbing' }"
              draggable="true"
              :class="draggingId === row.id ? 'opacity-40' : ''"
              @dragstart="draggingId = row.id"
              @dragend="
                draggingId = null;
                dropTarget = null;
              "
            >
              <div class="min-w-0">
                <NuxtLink
                  :to="`/tasks/${row.id}`"
                  class="text-highlighted truncate text-sm font-medium hover:underline"
                  >{{ row.title }}</NuxtLink
                >
                <p v-if="row.projectName" class="text-primary mt-0.5 flex items-center gap-1 text-xs">
                  <UIcon name="i-lucide-folder-kanban" class="size-3" />{{ row.projectName }}
                </p>
                <p class="text-dimmed mt-0.5 flex items-center gap-1 text-xs">
                  <UIcon v-if="row.assigneeKind === 'ai'" name="i-lucide-bot" class="text-primary size-3" />
                  {{ row.assigneeName ?? 'Unassigned' }}
                </p>
              </div>
              <div class="mt-2 flex items-center justify-between gap-2">
                <USelect
                  :model-value="row.status"
                  :items="statusOptions"
                  value-key="value"
                  size="xs"
                  class="w-28"
                  :aria-label="`Status for ${row.title}`"
                  @update:model-value="(v: string) => setStatus(row, v)"
                />
                <div class="flex items-center gap-1">
                  <UPopover mode="hover">
                    <UButton
                      icon="i-lucide-wand-sparkles"
                      variant="ghost"
                      color="neutral"
                      size="xs"
                      aria-label="Auto-assign"
                      :disabled="busy"
                      @click="autoAssign(row)"
                    />
                    <template #content>
                      <div class="px-3 py-1.5 text-xs">Auto-assign</div>
                    </template>
                  </UPopover>
                  <UPopover mode="hover">
                    <UButton
                      icon="i-lucide-pencil"
                      variant="ghost"
                      color="neutral"
                      size="xs"
                      aria-label="Edit task"
                      @click="openEditor(row)"
                    />
                    <template #content>
                      <div class="px-3 py-1.5 text-xs">Edit task</div>
                    </template>
                  </UPopover>
                  <UPopover mode="hover">
                    <UButton
                      icon="i-lucide-trash-2"
                      variant="ghost"
                      color="error"
                      size="xs"
                      aria-label="Delete task"
                      @click="pendingDelete = row"
                    />
                    <template #content>
                      <div class="px-3 py-1.5 text-xs">Delete task</div>
                    </template>
                  </UPopover>
                </div>
              </div>
            </UCard>
            <p v-if="!tasksByStatus(col.id).length" class="text-dimmed py-4 text-center text-xs">Drop tasks here</p>
          </div>
        </div>
      </div>
    </div>

    <!-- workflow drawer -->
    <UModal
      v-model:open="workflowOpen"
      title="Task workflow"
      :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }"
    >
      <template #body>
        <div v-if="workflowTask" class="space-y-4">
          <div>
            <p class="font-medium">{{ workflowTask.title }}</p>
            <p class="text-dimmed mt-0.5 text-xs">
              {{ statusById.get(workflowTask.status)?.name ?? workflowTask.status }}
              <template v-if="workflowTask.questionHolderName">
                · waiting on {{ workflowTask.questionHolderName }}</template
              >
              <template v-if="workflowTask.reviewers.length">
                · reviewers: {{ workflowTask.reviewerNames.join(', ') }}</template
              >
            </p>
          </div>
          <!-- contextual verbs only (owner rulings 2026-10-26): notes/answers ride the composer -->
          <div v-if="workflowIsWorking" class="flex flex-wrap gap-2">
            <UButton
              v-if="workflowTask.assigneeKind !== 'ai'"
              size="xs"
              color="primary"
              variant="soft"
              icon="i-lucide-send"
              :disabled="workflowBusy"
              @click="wfAction('submit', { body: workflowNote })"
              >Submit for review</UButton
            >
            <UButton
              size="xs"
              color="neutral"
              variant="soft"
              icon="i-lucide-corner-up-right"
              :disabled="workflowBusy || !forwardTo || forwardTo === '__none__'"
              @click="
                forwardTo &&
                forwardTo !== '__none__' &&
                wfAction('forward', { toEmployeeId: forwardTo, body: workflowNote })
              "
              >Forward</UButton
            >
            <UButton
              size="xs"
              color="error"
              variant="soft"
              icon="i-lucide-ban"
              :disabled="workflowBusy"
              @click="wfAction('abandon')"
              >Abandon</UButton
            >
          </div>
          <!-- forward picker only applies while the task is in a working state -->
          <USelect
            v-if="workflowIsWorking"
            v-model="forwardTo"
            :items="[
              { label: 'Not forwarded', value: '__none__' },
              ...employees
                .filter((e) => e.id !== workflowTask?.questionHolderId)
                .map((e) => ({ label: e.name, value: e.id })),
            ]"
            value-key="value"
            size="sm"
            class="w-full"
            aria-label="Forward to"
          />
          <TaskReviewBox
            v-if="workflowStatusCategory === 'in_review' && drawerCanReview"
            :busy="workflowBusy"
            @verdict="
              (action: 'approve' | 'requestChanges' | 'reject', body?: string) =>
                wfAction(action, { body: body || undefined })
            "
          />
          <UTextarea
            v-model="workflowNote"
            :rows="3"
            :placeholder="
              workflowStatusCategory === 'waiting_answer' ? 'Write an answer — the agent resumes' : 'Write a note…'
            "
            class="w-full"
          />
          <UButton
            size="sm"
            color="primary"
            variant="soft"
            icon="i-lucide-arrow-up"
            :disabled="workflowBusy || !workflowNote.trim()"
            @click="sendDrawerNote()"
          >
            {{ workflowStatusCategory === 'waiting_answer' ? 'Send answer' : 'Send' }}
          </UButton>
          <p v-if="workflowMessage" class="text-xs" :class="workflowOk ? 'text-success' : 'text-error'" role="status">
            {{ workflowMessage }}
          </p>
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <h3 class="text-muted text-xs font-medium">Agent runs</h3>
              <UButton
                size="xs"
                variant="soft"
                icon="i-lucide-play"
                :disabled="workflowBusy || workflowTask?.assigneeKind !== 'ai'"
                @click="wfAction('dispatch')"
              >
                Dispatch now
              </UButton>
            </div>
            <div v-for="r in runFeed" :key="r.id" class="border-default rounded-md border">
              <p class="text-toned flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium">
                <span class="inline-block size-2 rounded-full" :class="runDot(r)" />
                {{ runLabel(r) }}
              </p>
              <pre
                v-if="r.output"
                class="max-h-72 overflow-y-auto rounded-b-md bg-zinc-950 px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-200"
                >{{ r.output }}</pre>
            </div>
            <p v-if="!runFeed.length" class="text-dimmed text-xs">No runs yet.</p>
            <p v-if="retryInMin > 0" class="text-warning text-xs font-medium">
              Retrying in ~{{ retryInMin }} min ({{ workflowTask?.failStreak ?? 0 }} consecutive failure{{
                (workflowTask?.failStreak ?? 0) === 1 ? '' : 's'
              }})
            </p>
          </div>
          <div class="space-y-2">
            <h3 class="text-muted text-xs font-medium">Activity</h3>
            <div v-for="a in workflowFeed" :key="a.id" class="border-default rounded-md border px-2.5 py-2 text-xs">
              <p class="text-toned flex items-center gap-1.5 font-medium">
                <UIcon
                  :name="
                    a.kind === ACTIVITY_KIND.QUESTION
                      ? 'i-lucide-help-circle'
                      : a.kind === ACTIVITY_KIND.ANSWER
                        ? 'i-lucide-check-check'
                        : a.kind === ACTIVITY_KIND.FORWARD
                          ? 'i-lucide-corner-up-right'
                          : a.kind === ACTIVITY_KIND.VERDICT
                            ? 'i-lucide-gavel'
                            : 'i-lucide-info'
                  "
                  class="size-3.5"
                />
                {{ ACTIVITY_LABELS[a.kind] ?? a.kind }} · {{ a.authorName ?? 'system' }}
              </p>
              <p v-if="a.body" class="text-muted mt-1">{{ a.body }}</p>
            </div>
            <p v-if="!workflowFeed.length" class="text-dimmed text-xs">No activity yet.</p>
          </div>
        </div>
      </template>
    </UModal>

    <TaskStatusesManager v-model:open="statusManagerOpen" />
    <TaskEditorModal v-model:open="editorOpen" :task="editingTask" @saved="onSaved" />

    <!-- delete confirm -->
    <UModal v-model:open="deleteOpen" title="Delete task" :ui="{ content: 'max-w-sm' }">
      <template #body>
        <p class="text-toned text-sm">
          Delete <span class="text-highlighted font-semibold">{{ pendingDelete?.title }}</span
          >? This cannot be undone.
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" label="Cancel" @click="pendingDelete = null" />
          <UButton icon="i-lucide-trash-2" color="error" label="Delete" :loading="busy" @click="remove" />
        </div>
      </template>
    </UModal>
  </div>
</template>
