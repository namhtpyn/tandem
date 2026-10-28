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

import { CHANGE_RESOURCE } from '#shared/enums';
import { nonNull } from '#shared/utils/non-null';
import { formatWhenShort } from '~/utils/format-when';
import { NONE_ID, errorMessage, saveFailed } from '~/utils/forms';
import type { EmployeeRow, TaskRow, TaskRunRow } from '~/utils/orpc-types';
import {
  activityIcon,
  activityLabel,
  aiOptionLabel,
  categoryColor,
  categoryIcon,
  categoryText,
  composerPlaceholder,
  dotClass,
  statusLabel,
  runStatus,
  AGENT_RUN_VIEW,
} from '~/utils/ui-labels';

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
/** any active server-side filter (search / status chip / inbox) — drives the empty-state copy */
const listFiltered = computed(() => !!searchDebounced.value || statusId.value !== null || needsDecision.value);

/** empty-state copy names WHICH filter came up empty — 'no results' under the inbox toggle reads as a bug */
const emptyCopy = computed(() => {
  if (!listFiltered.value) return 'No tasks yet — create the first one for your humans or agents.';
  if (needsDecision.value) return 'Nothing is waiting on your decision right now.';
  if (statusId.value !== null)
    return `No tasks in ${statusLabel(statusId.value, statusById.value)} — try another filter.`;
  return 'No results — try a different search.';
});

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

// deleting the last row of a high page (or an emptied list) clamps back into
// range — keepPreviousData keeps the previous total while a page fetch lands,
// so a transient zero can only mean a genuinely empty result (page 1)
watch(total, (t) => {
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
type InboxItem = {
  taskId: string;
  role: string;
  title: string;
  status: string;
};
const inboxItems = computed<InboxItem[]>(
  () => (unref(inboxQuery.data) as { items?: InboxItem[] } | undefined)?.items ?? [],
);
const inboxCount = computed(() => inboxItems.value.length);

const statusOptions = computed(() => statuses.value.map((x) => ({ label: x.name, value: x.id })));

// one shared category→color mapping (ui-labels) — statuses agree with the detail page

// solid-dot color for the borderless status selects (list row + mobile card):
// the shared category→color mapping, rendered as a filled dot instead of a badge
function statusDot(s: string) {
  return dotClass(categoryColor(statusById.value.get(s)?.category));
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
  if (row.status === status || busy.value) return;
  // manual status is FREE (owner ruling 2026-10-27): every status is reachable from
  // every surface — the server is the only gate. busy gates selects + drops so a
  // second move can't race the first one's refetch.
  message.value = '';
  messageOk.value = false;
  busy.value = true;
  try {
    await setStatusMutation.mutateAsync({ id: row.id, status });
    // SSE-down backstop: the list must refetch even without the change bus
    await queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASKS] });
  } catch (e) {
    message.value = saveFailed(e, 'status', 'save');
  } finally {
    busy.value = false;
  }
}

async function autoAssign(row: TaskRow) {
  if (busy.value) return;
  message.value = '';
  messageOk.value = false;
  busy.value = true;
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
    // SSE-down backstop: the list must refetch even without the change bus
    await queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASKS] });
  } catch (e) {
    message.value = saveFailed(e, 'assignment', 'save');
  } finally {
    busy.value = false;
  }
}

const pendingDelete = ref<TaskRow | null>(null);
const deleteError = ref('');
const deleteOpen = computed({
  get: () => pendingDelete.value !== null,
  set: (v: boolean) => {
    if (!v) pendingDelete.value = null;
  },
});

async function remove() {
  if (!pendingDelete.value || busy.value) return;
  busy.value = true;
  deleteError.value = '';
  try {
    await removeMutation.mutateAsync({ id: pendingDelete.value.id });
    pendingDelete.value = null;
    // SSE-down backstop: the list must refetch even without the change bus
    await queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASKS] });
  } catch (e) {
    deleteError.value = saveFailed(e, 'task', 'delete');
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
// the review box disarms its reject confirm + keeps the note on a failed verdict
const workflowFailed = ref(false);
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
const forwardTo = ref(NONE_ID);

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
const runFeed = computed<TaskRunRow[]>(() => (unref(drawerRunsQuery.data) ?? []) as TaskRunRow[]);
const drawerActivityQuery = useQuery(
  computed(() =>
    $orpc.tasks.activityList.queryOptions({
      input: { taskId: drawerTaskId.value },
      queryKey: [CHANGE_RESOURCE.TASK_ACTIVITY, drawerTaskId.value, 'activity'],
      enabled: !!drawerTaskId.value,
    }),
  ),
);
const workflowFeed = computed(() => unref(drawerActivityQuery.data) ?? []);

// run rows read as sentences — 'Run failed (exit code 1)', never bare status jargon.
// Status normalization + dot + words come from the SHARED ui-labels vocabulary.
function runLabel(r: { status: string; exitCode: number | null }) {
  const s = runStatus(r.status);
  return s === 'failed' && r.exitCode ? `Run failed (exit code ${r.exitCode})` : AGENT_RUN_VIEW[s].run;
}
function runDot(r: { status: string }) {
  return AGENT_RUN_VIEW[runStatus(r.status)].dot;
}

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
  // reset the forward picker too — a stale pre-armed selection would fire the
  // next Forward at whoever was picked for a previous task
  forwardTo.value = NONE_ID;
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
  if (!workflowTask.value || workflowBusy.value) return;
  const taskId = workflowTask.value.id;
  workflowBusy.value = true;
  workflowMessage.value = '';
  workflowFailed.value = false;
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
    // invalidate ALL drawer feeds: TASKS re-syncs the drawer's task row
    // (status/reviewers), TASK_ACTIVITY keeps the thread and activity feed
    // current, RUNS refreshes the run cards a dispatch/verdict just changed
    void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASKS] });
    void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASK_ACTIVITY, taskId] });
    void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.RUNS, taskId] });
    workflowMessage.value = WF_COPY[action].ok;
    workflowOk.value = true;
  } catch (e) {
    // surface the server's oRPC message, not ofetch's generic '[POST] …: 400'
    workflowMessage.value = errorMessage(e, WF_COPY[action].fail);
    workflowOk.value = false;
    workflowFailed.value = true;
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

// board card kebab menu items — the actions hide behind one menu instead of an
// always-on icon row (accent rationing: delete is a menu item, not a red button)
const BOARD_MENU_ITEM =
  'flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-xs text-muted transition-colors hover:bg-elevated hover:text-highlighted';

// manual status is FREE on every surface (owner ruling) — any column is a legal drop

function tasksByStatus(status: string) {
  return rows.value.filter((t) => t.status === status);
}

function onDrop(status: string) {
  if (busy.value) return;
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
  { id: 'actions', header: 'Actions', meta: { class: { th: 'sr-only' } } },
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
  <div class="flex min-h-0 flex-1 flex-col">
    <!-- ONE toolbar row: search left, every action right, same baseline.
         The search box is pointless over an empty, unfiltered list — hide it there. -->
    <div class="flex flex-wrap items-center gap-2">
      <UInput
        v-if="total > 0 || !!search"
        v-model="search"
        icon="i-lucide-search"
        placeholder="Search tasks…"
        size="sm"
        class="w-full sm:max-w-xs"
        aria-label="Search tasks"
      />
      <div class="ms-auto flex items-center gap-2 overflow-x-auto">
        <div
          class="border-default bg-default inline-flex overflow-hidden rounded-md border"
          role="group"
          aria-label="View"
        >
          <button
            type="button"
            class="h-8 px-3 py-1.5 text-sm font-medium transition-colors"
            :class="
              view === 'list' ? 'bg-elevated text-highlighted' : 'text-muted hover:bg-elevated hover:text-highlighted'
            "
            aria-label="List view"
            :aria-pressed="view === 'list'"
            @click="view = 'list'"
          >
            List
          </button>
          <button
            type="button"
            class="border-default h-8 border-l px-3 py-1.5 text-sm font-medium transition-colors"
            :class="
              view === 'board' ? 'bg-elevated text-highlighted' : 'text-muted hover:bg-elevated hover:text-highlighted'
            "
            aria-label="Board view"
            :aria-pressed="view === 'board'"
            @click="view = 'board'"
          >
            Board
          </button>
        </div>
        <UButton
          color="neutral"
          :variant="needsDecision ? 'solid' : 'outline'"
          size="sm"
          aria-label="Needs my decision"
          :aria-pressed="needsDecision"
          data-testid="needs-decision-toggle"
          @click="needsDecision = !needsDecision"
        >
          <span class="inline-flex items-center gap-1.5">
            <UIcon name="i-lucide-inbox" class="size-4" />
            <!-- mobile shows the short label — the full words wrap to 3 lines at 390px -->
            <span class="whitespace-nowrap sm:hidden">Decisions</span>
            <span class="hidden whitespace-nowrap sm:inline">Needs my decision</span>
            <span
              v-if="inboxCount > 0"
              class="bg-accented text-default inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-4 font-semibold"
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
        <UButton icon="i-lucide-plus" label="New task" size="sm" @click="openEditor()" />
      </div>
    </div>

    <p
      v-if="message"
      class="mt-3 text-sm"
      :class="messageOk ? 'text-success' : 'text-error'"
      :role="messageOk ? 'status' : 'alert'"
    >
      {{ message }}
    </p>

    <!-- status filter chips (server-side statusId filter) — one scrollable row on
         mobile; active = neutral fill + highlighted text (no per-chip dots — the
         active indicator is the text color alone). The right-edge fade telegraphs
         the horizontal scroll. -->
    <div v-if="statuses.length" class="relative mt-3">
      <div
        class="flex [scrollbar-width:thin] items-center gap-1.5 overflow-x-auto pr-16"
        role="group"
        aria-label="Filter by status"
      >
        <UButton
          size="sm"
          color="neutral"
          variant="soft"
          class="shrink-0"
          :class="statusId === null ? 'text-highlighted' : 'text-muted'"
          :aria-pressed="statusId === null"
          @click="statusId = null"
        >
          All
        </UButton>
        <UButton
          v-for="st in statuses"
          :key="st.id"
          size="sm"
          color="neutral"
          variant="soft"
          class="shrink-0"
          :class="statusId === st.id ? 'text-highlighted' : 'text-muted'"
          :aria-pressed="statusId === st.id"
          @click="toggleStatusFilter(st.id)"
        >
          {{ st.name }}
        </UButton>
      </div>
      <div
        class="from-default pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l to-transparent"
        aria-hidden="true"
      />
    </div>

    <!-- server-paged list (desktop table + mobile cards) -->
    <DataTable
      v-if="view === 'list'"
      class="mt-3"
      :data="rows"
      :loading="pagedQuery.isFetching.value || pagedQuery.isPlaceholderData.value"
      :error="pagedQuery.isError.value"
      v-model:page="page"
      :page-count="pageCount"
      :page-size="pageSize"
      :columns="tableColumns"
      show-empty-state
      empty-noun="tasks"
      :empty-text="emptyCopy"
      :empty-icon="listFiltered ? 'i-lucide-search-x' : 'i-lucide-list-todo'"
    >
      <template #empty-cta>
        <UButton v-if="!listFiltered" icon="i-lucide-plus" label="New task" @click="openEditor()" />
      </template>
      <template #error-cta>
        <UButton size="sm" variant="soft" icon="i-lucide-refresh-cw" label="Retry" @click="pagedQuery.refetch()" />
      </template>
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
      <template #assigneeName-cell="{ row }">
        <span
          class="flex items-center gap-1.5 text-sm"
          :class="row.original.assigneeName ? 'text-toned' : 'text-muted'"
        >
          <UIcon v-if="row.original.assigneeKind === 'ai'" name="i-lucide-bot" class="text-primary size-3.5 shrink-0" />
          <UIcon
            v-else-if="!row.original.assigneeName"
            name="i-lucide-user-round"
            class="text-dimmed size-3.5 shrink-0"
          />
          {{ row.original.assigneeName || 'Unassigned' }}
        </span>
      </template>
      <template #status-cell="{ row }">
        <!-- borderless select: the row already reads as a table — no OS chrome,
             just a category dot + name + chevron, hover reveals an elevated bg -->
        <USelect
          :model-value="row.original.status"
          :items="statusOptions"
          value-key="value"
          size="sm"
          variant="none"
          :disabled="busy"
          class="hover:bg-elevated rounded-md"
          :aria-label="`Status for ${row.original.title}`"
          @update:model-value="(v: string) => setStatus(row.original, v)"
        >
          <template #leading>
            <span
              class="inline-block size-2 shrink-0 rounded-full"
              :class="statusDot(row.original.status)"
              aria-hidden="true"
            />
          </template>
        </USelect>
      </template>
      <template #updatedAt-cell="{ row }">
        <span data-allow-mismatch class="text-muted text-xs">{{ formatWhenShort(row.original.updatedAt) }}</span>
      </template>
      <template #actions-cell="{ row }">
        <div
          class="flex justify-end gap-1 opacity-0 transition-opacity max-md:opacity-100 md:focus-within:opacity-100 md:[tr:hover_&]:opacity-100"
        >
          <UPopover mode="hover" enable-touch>
            <UButton
              icon="i-lucide-wand-sparkles"
              variant="ghost"
              color="neutral"
              size="sm"
              :aria-label="`Auto-assign ${row.original.title}`"
              :disabled="busy"
              @click="autoAssign(row.original)"
            />
            <template #content>
              <div class="px-3 py-1.5 text-xs">Auto-assign</div>
            </template>
          </UPopover>
          <UPopover mode="hover" enable-touch>
            <UButton
              icon="i-lucide-message-circle-more"
              variant="ghost"
              color="neutral"
              size="sm"
              :aria-label="`Workflow for ${row.original.title}`"
              @click="openWorkflow(row.original)"
            />
            <template #content>
              <div class="px-3 py-1.5 text-xs">Workflow &amp; activity</div>
            </template>
          </UPopover>
          <UPopover mode="hover" enable-touch>
            <UButton
              icon="i-lucide-pencil"
              variant="ghost"
              color="neutral"
              size="sm"
              :aria-label="`Edit ${row.original.title}`"
              @click="openEditor(row.original)"
            />
            <template #content>
              <div class="px-3 py-1.5 text-xs">Edit task</div>
            </template>
          </UPopover>
          <UPopover mode="hover" enable-touch>
            <UButton
              icon="i-lucide-trash-2"
              variant="ghost"
              color="neutral"
              class="text-muted hover:text-error"
              size="sm"
              :aria-label="`Delete ${row.original.title}`"
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
              <NuxtLink :to="`/tasks/${row.id}`" class="text-highlighted line-clamp-2 font-medium hover:underline">{{
                row.title
              }}</NuxtLink>
              <p v-if="row.projectName" class="text-primary mt-0.5 flex items-center gap-1 text-xs">
                <UIcon name="i-lucide-folder-kanban" class="size-3" />{{ row.projectName }}
              </p>
              <p class="text-dimmed mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                <!-- category dot + name: the status reads without a second badge -->
                <span class="inline-flex items-center gap-1">
                  <span
                    class="inline-block size-2 shrink-0 rounded-full"
                    :class="statusDot(row.status)"
                    aria-hidden="true"
                  />
                  {{ statusLabel(row.status, statusById) }}
                </span>
                <span class="inline-flex items-center gap-1" :class="row.assigneeKind === 'ai' ? 'text-primary' : ''">
                  <UIcon v-if="row.assigneeKind === 'ai'" name="i-lucide-bot" class="size-3 shrink-0" />
                  {{ aiOptionLabel(row.assigneeName || 'Unassigned', row.assigneeKind) }}
                </span>
              </p>
              <p class="text-dimmed mt-0.5 flex items-center gap-1 text-xs">
                <UIcon name="i-lucide-clock" class="size-3 shrink-0" />
                <span data-allow-mismatch>{{ formatWhenShort(row.updatedAt) }}</span>
              </p>
            </div>
            <!-- every card action hides behind one kebab — no visible trash row
                 to mis-tap on a phone; Move to… is the touch/keyboard status path -->
            <UPopover :ui="{ content: 'w-44 p-1' }">
              <UButton
                icon="i-lucide-ellipsis-vertical"
                size="sm"
                color="neutral"
                variant="ghost"
                :aria-label="`Actions for ${row.title}`"
                class="shrink-0"
              />
              <template #content>
                <div class="flex flex-col">
                  <button type="button" :class="BOARD_MENU_ITEM" :disabled="busy" @click="autoAssign(row)">
                    <UIcon name="i-lucide-wand-sparkles" class="size-3.5 shrink-0" />Auto-assign
                  </button>
                  <p class="text-dimmed px-2 pt-1.5 pb-1 text-[10px] font-medium">Move to…</p>
                  <div class="max-h-40 overflow-y-auto">
                    <button
                      v-for="st in statuses"
                      :key="st.id"
                      type="button"
                      :class="BOARD_MENU_ITEM"
                      :disabled="busy || row.status === st.id"
                      @click="setStatus(row, st.id)"
                    >
                      <span
                        class="inline-block size-2 shrink-0 rounded-full"
                        :class="statusDot(st.id)"
                        aria-hidden="true"
                      />
                      {{ st.name }}
                    </button>
                  </div>
                  <div class="border-default my-1 border-t" aria-hidden="true" />
                  <button type="button" :class="BOARD_MENU_ITEM" @click="openEditor(row)">
                    <UIcon name="i-lucide-pencil" class="size-3.5 shrink-0" />Edit
                  </button>
                  <button
                    type="button"
                    :class="[BOARD_MENU_ITEM, 'text-error hover:bg-error/10 hover:text-error']"
                    @click="pendingDelete = row"
                  >
                    <UIcon name="i-lucide-trash-2" class="size-3.5 shrink-0" />Delete
                  </button>
                </div>
              </template>
            </UPopover>
          </div>
        </UCard>
      </template>
    </DataTable>

    <!-- kanban board view (over the same server-paged rows): one horizontally
         scrollable row of columns; the column IS the status — cards move by
         drag & drop OR the card kebab's Move-to list (touch/keyboard path),
         empty columns stay compact dashed drop zones. The row fills the
         available height; the right-edge fade telegraphs the scroll. -->
    <div v-if="view === 'board'" class="relative mt-3 min-h-0 flex-1">
      <div
        v-if="pagedQuery.isError.value"
        role="alert"
        class="border-error/40 bg-error/5 text-error mb-3 flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
      >
        <span>Couldn't load tasks</span>
        <UButton
          size="sm"
          color="error"
          variant="soft"
          icon="i-lucide-refresh-cw"
          label="Retry"
          @click="pagedQuery.refetch()"
        />
      </div>
      <div class="flex h-[min(72dvh,44rem)] min-h-72 items-stretch gap-4 overflow-x-auto pb-2">
        <section
          v-for="col in boardColumns"
          :key="col.id"
          data-testid="board-column"
          class="border-default bg-muted/40 flex min-w-[260px] flex-1 flex-col rounded-lg border"
          :class="dropTarget === col.id ? 'ring-primary ring-2' : ''"
          @dragover.prevent="dropTarget = col.id"
          @dragleave="dropTarget === col.id && (dropTarget = null)"
          @drop.prevent="onDrop(col.id)"
        >
          <header class="border-default flex items-center justify-between gap-2 border-b px-3 py-2">
            <p class="text-toned flex min-w-0 items-center gap-1.5 text-sm font-medium">
              <UIcon :name="categoryIcon(col.category)" class="size-4 shrink-0" :class="categoryText(col.category)" />
              <span class="truncate">{{ col.name }}</span>
            </p>
            <UBadge color="neutral" variant="subtle" size="sm" class="shrink-0">{{
              tasksByStatus(col.id).length
            }}</UBadge>
          </header>
          <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
            <!-- pending first page: skeleton cards, never bare empty columns -->
            <div v-if="pagedQuery.isPending.value" class="space-y-2" aria-hidden="true">
              <USkeleton class="h-20 w-full rounded-lg" />
              <USkeleton class="h-20 w-4/5 rounded-lg" />
            </div>
            <template v-else>
              <article
                v-for="row in tasksByStatus(col.id)"
                :key="row.id"
                draggable="true"
                class="border-default bg-default group/card relative cursor-grab rounded-lg border p-2.5 shadow-sm active:cursor-grabbing"
                :class="[
                  draggingId === row.id ? 'opacity-40' : '',
                  statusById.get(row.status)?.category === 'done' ? 'opacity-70' : '',
                ]"
                @dragstart="draggingId = row.id"
                @dragend="
                  draggingId = null;
                  dropTarget = null;
                "
              >
                <div class="flex items-start justify-between gap-1">
                  <NuxtLink
                    :to="`/tasks/${row.id}`"
                    draggable="false"
                    class="text-highlighted line-clamp-2 min-w-0 flex-1 text-sm font-medium hover:underline"
                    >{{ row.title }}</NuxtLink
                  >
                  <UPopover :ui="{ content: 'w-40 p-1' }">
                    <UButton
                      icon="i-lucide-ellipsis-vertical"
                      size="sm"
                      color="neutral"
                      variant="ghost"
                      :aria-label="`Actions for ${row.title}`"
                      class="transition-opacity max-md:opacity-100 md:opacity-0 md:group-focus-within/card:opacity-100 md:group-hover/card:opacity-100"
                    />
                    <template #content>
                      <div class="flex flex-col">
                        <button type="button" :class="BOARD_MENU_ITEM" :disabled="busy" @click="autoAssign(row)">
                          <UIcon name="i-lucide-wand-sparkles" class="size-3.5 shrink-0" />Auto-assign
                        </button>
                        <!-- Move to…: the same setStatus the drag fires — the
                           touch/keyboard path onto the drag-only board -->
                        <p class="text-dimmed px-2 pt-1.5 pb-1 text-[10px] font-medium">Move to…</p>
                        <div class="max-h-40 overflow-y-auto">
                          <button
                            v-for="st in statuses"
                            :key="st.id"
                            type="button"
                            :class="BOARD_MENU_ITEM"
                            :disabled="busy || row.status === st.id"
                            @click="setStatus(row, st.id)"
                          >
                            <span
                              class="inline-block size-2 shrink-0 rounded-full"
                              :class="statusDot(st.id)"
                              aria-hidden="true"
                            />
                            {{ st.name }}
                          </button>
                        </div>
                        <div class="border-default my-1 border-t" aria-hidden="true" />
                        <button type="button" :class="BOARD_MENU_ITEM" @click="openEditor(row)">
                          <UIcon name="i-lucide-pencil" class="size-3.5 shrink-0" />Edit
                        </button>
                        <button
                          type="button"
                          :class="[BOARD_MENU_ITEM, 'text-error hover:bg-error/10 hover:text-error']"
                          @click="pendingDelete = row"
                        >
                          <UIcon name="i-lucide-trash-2" class="size-3.5 shrink-0" />Delete
                        </button>
                      </div>
                    </template>
                  </UPopover>
                </div>
                <p v-if="row.projectName" class="text-primary mt-1 flex items-center gap-1 text-xs">
                  <UIcon name="i-lucide-folder-kanban" class="size-3 shrink-0" />{{ row.projectName }}
                </p>
                <p class="text-dimmed mt-1 flex items-center gap-1 text-xs">
                  <UIcon v-if="row.assigneeKind === 'ai'" name="i-lucide-bot" class="text-primary size-3 shrink-0" />
                  <UIcon v-else name="i-lucide-user-round" class="size-3 shrink-0" />
                  {{ row.assigneeName || 'Unassigned' }}
                </p>
              </article>
              <!-- the drop zone is a SETTLED empty column's affordance — during a
                 load or an error it would read as a broken board -->
              <div
                v-if="!tasksByStatus(col.id).length && pagedQuery.isSuccess.value"
                class="border-default text-dimmed mx-1 mb-1 flex max-h-40 min-h-[120px] items-center justify-center rounded-md border border-dashed text-xs"
              >
                Drop tasks here
              </div>
            </template>
          </div>
        </section>
      </div>
      <div
        class="from-default pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l to-transparent"
        aria-hidden="true"
      />
    </div>

    <!-- board pager (the kanban view paginates over the same server-paged rows) -->
    <div
      v-if="view === 'board' && pageCount > 1"
      class="border-default mt-3 flex items-center justify-end gap-1 border-t pt-3"
    >
      <span class="text-muted me-auto text-xs">{{ total }} {{ total === 1 ? 'task' : 'tasks' }}</span>
      <UButton
        icon="i-lucide-chevron-left"
        color="neutral"
        variant="outline"
        :disabled="page <= 1"
        aria-label="Previous page"
        @click="page--"
      />
      <span class="text-muted px-2 text-xs">{{ page }} / {{ pageCount }}</span>
      <UButton
        icon="i-lucide-chevron-right"
        color="neutral"
        variant="outline"
        :disabled="page >= pageCount"
        aria-label="Next page"
        @click="page++"
      />
    </div>
    <UModal
      v-model:open="workflowOpen"
      title="Task workflow"
      :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }"
    >
      <template #body>
        <div v-if="workflowTask" class="space-y-4">
          <div>
            <p class="font-medium">{{ workflowTask.title }}</p>
            <div class="text-dimmed mt-0.5 space-y-0.5 text-xs">
              <p>{{ statusLabel(workflowTask.status, statusById) }}</p>
              <p v-if="workflowTask.questionHolderName">Waiting on {{ workflowTask.questionHolderName }}</p>
              <p v-if="workflowTask.reviewers.length">Reviewers: {{ workflowTask.reviewerNames.join(', ') }}</p>
            </div>
          </div>
          <!-- contextual verbs only (owner rulings 2026-10-26): notes/answers ride the composer -->
          <div v-if="workflowIsWorking" class="flex flex-wrap gap-2">
            <UButton
              v-if="workflowTask.assigneeKind !== 'ai'"
              size="sm"
              color="primary"
              variant="soft"
              icon="i-lucide-send"
              :disabled="workflowBusy"
              @click="wfAction('submit', { body: workflowNote })"
              >Submit for review</UButton
            >
            <UButton
              size="sm"
              color="neutral"
              variant="soft"
              icon="i-lucide-corner-up-right"
              :disabled="workflowBusy || !forwardTo || forwardTo === NONE_ID"
              @click="
                forwardTo &&
                forwardTo !== NONE_ID &&
                wfAction('forward', { toEmployeeId: forwardTo, body: workflowNote })
              "
              >Forward</UButton
            >
            <UButton
              size="sm"
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
              { label: 'Not forwarded', value: NONE_ID },
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
            :failed="workflowFailed"
            @verdict="
              (action: 'approve' | 'requestChanges' | 'reject', body?: string) =>
                wfAction(action, { body: body || undefined })
            "
          />
          <UTextarea
            v-model="workflowNote"
            :rows="3"
            :placeholder="composerPlaceholder(workflowStatusCategory === 'waiting_answer')"
            aria-label="Task note"
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
          <p
            v-if="workflowMessage"
            class="text-xs"
            :class="workflowOk ? 'text-success' : 'text-error'"
            :role="workflowOk ? 'status' : 'alert'"
          >
            {{ workflowMessage }}
          </p>
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <h3 class="text-muted text-xs font-medium">Agent runs</h3>
              <!-- dispatch is an agent verb — humans have nothing to dispatch, so
                   the button hides instead of sitting disabled with no why -->
              <UButton
                v-if="workflowTask?.assigneeKind === 'ai'"
                size="sm"
                variant="soft"
                icon="i-lucide-play"
                :disabled="workflowBusy"
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
                class="bg-inverted text-inverted max-h-72 overflow-y-auto rounded-b-md px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
                >{{ r.output }}</pre>
            </div>
            <div v-if="drawerRunsQuery.isPending.value" class="space-y-2" aria-hidden="true">
              <USkeleton class="h-10 w-full rounded-md" />
            </div>
            <p v-else-if="drawerRunsQuery.isError.value" role="alert" class="text-error text-xs">
              Couldn't load agent runs
            </p>
            <p v-else-if="!runFeed.length" class="text-dimmed text-xs">No runs yet — dispatch the agent.</p>
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
                <UIcon :name="activityIcon(a.kind)" class="size-3.5" />
                {{ activityLabel(a.kind) }}
                <span class="text-muted font-normal">{{ a.authorName ?? 'system' }}</span>
                <span class="text-dimmed ml-auto shrink-0 font-normal" data-allow-mismatch>{{
                  formatWhenShort(a.createdAt)
                }}</span>
              </p>
              <p v-if="a.body" class="text-muted mt-1">{{ a.body }}</p>
            </div>
            <div v-if="drawerActivityQuery.isPending.value" class="space-y-2" aria-hidden="true">
              <USkeleton class="h-10 w-full rounded-md" />
            </div>
            <p v-else-if="drawerActivityQuery.isError.value" role="alert" class="text-error text-xs">
              Couldn't load activity
            </p>
            <p v-else-if="!workflowFeed.length" class="text-dimmed text-xs">
              No activity yet — notes and verdicts land here.
            </p>
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
        <UAlert
          v-if="deleteError"
          role="alert"
          icon="i-lucide-circle-alert"
          color="error"
          variant="subtle"
          :title="deleteError"
          class="mt-3"
          :ui="{ title: 'text-sm' }"
        />
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
