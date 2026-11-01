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

import { CATEGORY, CHANGE_RESOURCE } from '#shared/enums';
import { nonNull } from '#shared/utils/non-null';
import {
  cancelReady,
  composerHint,
  composerReady,
  forwardReady,
  submitReady,
  useWorkflowActions,
} from '~/composables/useWorkflowActions';
import { formatWhenShort } from '~/utils/format-when';
import { NONE_ID, errorMessage, saveFailed } from '~/utils/forms';
import type { EmployeeRow, TaskRow, TaskRunRow, ThreadPage, ThreadRow } from '~/utils/orpc-types';
import { activityNotes, buildThread, parseRunEnvelope, threadTime, type ThreadNoteItem } from '~/utils/task-thread';
import {
  activityView,
  aiOptionLabel,
  categoryColor,
  categoryIcon,
  categoryText,
  composerPlaceholder,
  dotClass,
  employeeOptions,
  statusLabel,
  runStatus,
  waitingOnLabel,
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

// server-side filters: status chips + needs-my-decision (inbox) + the
// company-wide awaiting-decision queue — rows come pre-filtered from the API
const statusId = ref<string | null>(null);
const needsDecision = ref(false);
// deep link: /tasks?awaiting=1 opens the company queue (#91); the toggle keeps
// the URL in sync so a filtered view survives a share/reload
const route = useRoute();
const router = useRouter();
const awaitingDecision = ref(route.query.awaiting === '1');
watch(awaitingDecision, (v) => {
  void router.replace({ query: { ...route.query, awaiting: v ? '1' : undefined } });
});
watch([statusId, needsDecision, awaitingDecision], () => {
  page.value = 1;
});
function toggleStatusFilter(id: string) {
  statusId.value = statusId.value === id ? null : id;
}
/** any active server-side filter (search / status chip / inbox / awaiting) — drives the empty-state copy */
const listFiltered = computed(
  () => !!searchDebounced.value || statusId.value !== null || needsDecision.value || awaitingDecision.value,
);

/** empty-state copy names WHICH filter came up empty — 'no results' under the inbox toggle reads as a bug */
const emptyCopy = computed(() => {
  // the built-in empty state renders its own headline ('No tasks yet' / 'No
  // matches yet') — repeating a 'No …' sentence here printed it twice
  if (!listFiltered.value) return 'Create the first one for your humans or agents.';
  if (needsDecision.value) return 'Nothing is waiting on your decision right now.';
  if (awaitingDecision.value) return 'Nothing is waiting on a decision right now.';
  if (statusId.value !== null)
    return `Nothing in ${statusLabel(statusId.value, statusById.value)} — try another filter.`;
  return 'Try a different search.';
});
const emptyNoun = computed(() => (listFiltered.value ? 'matches' : 'tasks'));

const pagedQuery = useQuery(
  computed(() =>
    $orpc.tasks.listPaged.queryOptions({
      input: {
        page: page.value,
        pageSize: pageSize.value,
        q: searchDebounced.value || undefined,
        statusId: statusId.value ?? undefined,
        inboxOfMe: needsDecision.value,
        awaitingDecision: awaitingDecision.value,
      },
      queryKey: [
        CHANGE_RESOURCE.TASKS,
        'paged',
        page.value,
        pageSize.value,
        searchDebounced.value,
        statusId.value ?? 'all',
        needsDecision.value,
        awaitingDecision.value,
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
// ---- company queue count (#91): same listPaged total the overview card uses ----
const awaitingCountQuery = useQuery(
  $orpc.tasks.listPaged.queryOptions({
    input: { page: 1, pageSize: 1, awaitingDecision: true },
    queryKey: [CHANGE_RESOURCE.TASKS, 'count', 'awaiting'],
  }),
);
const awaitingCount = computed(() => unref(awaitingCountQuery.data)?.total ?? 0);
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

/** "Waiting on …" badge text for one row (#91) — null hides the badge */
function waitingForRow(row: TaskRow) {
  return waitingOnLabel(row, statusById.value.get(row.status)?.category);
}

// ---- mutations (list rows) ----
const queryClient = useQueryClient();
const setStatusMutation = useMutation($orpc.tasks.setStatus.mutationOptions());
const removeMutation = useMutation($orpc.tasks.remove.mutationOptions());
const assignMutation = useMutation($orpc.statuses.assign.mutationOptions());

const busy = ref(false);
const message = ref('');
const messageOk = ref(false); // message tone: only auto-assign success renders green

// optimistic row status (same contract as the detail page's selects): the chosen
// value shows at once, and is dropped the moment the live row catches up
const pendingStatus = ref(new Map<string, string>());
function rowStatus(row: TaskRow): string {
  return pendingStatus.value.get(row.id) ?? row.status;
}
watch(rows, (list) => {
  for (const r of list) {
    if (pendingStatus.value.get(r.id) === r.status) pendingStatus.value.delete(r.id);
  }
});

async function setStatus(row: TaskRow, status: string) {
  if (rowStatus(row) === status || busy.value) return;
  // manual status is FREE (owner ruling 2026-10-27): every status is reachable from
  // every surface — the server is the only gate. busy gates selects + drops so a
  // second move can't race the first one's refetch.
  message.value = '';
  messageOk.value = false;
  busy.value = true;
  pendingStatus.value.set(row.id, status);
  try {
    await setStatusMutation.mutateAsync({ id: row.id, status });
    // SSE-down backstop: the list must refetch even without the change bus
    await queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASKS] });
  } catch (e) {
    pendingStatus.value.delete(row.id);
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
      // the score is a routing detail, not something the owner can act on
      message.value = `Assigned to ${assigneeNameById.value.get(res.employeeId) ?? 'employee'}`;
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
/** arming the confirm always starts with a clean error slot — a failure from the
 *  previous task must not read as this one's */
function openDelete(row: TaskRow) {
  deleteError.value = '';
  pendingDelete.value = row;
}
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
// the fallback row freezes at open time; when the drawer's task leaves the current
// page/filter (a verdict moved it), the unfiltered list snapshot is the truthful
// source — otherwise the drawer would show yesterday's status forever
const workflowSnapshotQuery = useQuery(
  computed(() => ({
    ...$orpc.tasks.list.queryOptions({ queryKey: [CHANGE_RESOURCE.TASKS] }),
    enabled: workflowOpen.value && !!workflowTaskId.value && !workflowTaskLive.value,
  })),
);
const workflowTaskSnapshot = computed<TaskRow | null>(() => {
  const all = (unref(workflowSnapshotQuery.data) ?? []) as TaskRow[];
  return all.find((t) => t.id === workflowTaskId.value) ?? null;
});
const workflowTask = computed<TaskRow | null>(
  () => workflowTaskLive.value ?? workflowTaskSnapshot.value ?? workflowTaskFallback.value,
);
watch(workflowTaskLive, (t) => {
  if (t) workflowTaskFallback.value = t;
});
// gone from the snapshot too = deleted elsewhere: close instead of showing a ghost
watch([workflowTaskLive, workflowTaskSnapshot, () => workflowSnapshotQuery.isFetched.value], () => {
  if (
    workflowSnapshotQuery.isFetched.value &&
    workflowOpen.value &&
    !workflowTaskLive.value &&
    !workflowTaskSnapshot.value
  ) {
    workflowOpen.value = false;
    workflowTaskId.value = null;
  }
});
// the workflow ladder (copy + invalidation) is shared with the task page
const {
  workflowNote,
  workflowBusy,
  workflowMessage,
  workflowOk,
  verdictSeq,
  verdictFailed,
  wfAction,
  sendNote,
  resetWorkflow,
} = useWorkflowActions(() => workflowTask.value?.id ?? null);
// the workflow gate keys off the status CATEGORY (not seeded uuids) via the
// shared server-truth helpers below — submit/cancel render ONLY where the
// server accepts them (#177)
const workflowStatusCategory = computed(() =>
  workflowTask.value ? (statusById.value.get(workflowTask.value.status)?.category ?? null) : null,
);
// the SAME gates as the task-page verbs (submit = viewer is the human assignee
// in a working-category status; cancel = owner or assignee in a work state) —
// the drawer renders no verb the server would refuse (#177)
const drawerCanSubmit = computed(() =>
  submitReady({
    category: workflowStatusCategory.value,
    assigneeId: workflowTask.value?.assigneeId,
    assigneeKind: workflowTask.value?.assigneeKind,
    userId: session.value?.user.id,
  }),
);
const drawerCanCancel = computed(() =>
  cancelReady({
    category: workflowStatusCategory.value,
    assigneeId: workflowTask.value?.assigneeId,
    ownerId: workflowTask.value?.ownerId,
    userId: session.value?.user.id,
  }),
);

/** drawer composer: send is the answer verb while the task waits for one; a null
 *  category (statuses loading/failed) disables send instead of defaulting to note */
const drawerSendReady = computed(() => composerReady(workflowStatusCategory.value, workflowNote.value));
function sendDrawerNote() {
  if (!drawerSendReady.value) return;
  void sendNote(workflowStatusCategory.value === CATEGORY.WAITING_ANSWER);
}
const forwardTo = ref(NONE_ID);
/** forward picker options — the current question holder can't forward to themselves;
 *  hoisted so the template stays markup (an inline array rebuilt every render) */
const forwardItems = computed(() =>
  employeeOptions(employees.value, { noneLabel: 'Not forwarded', excludeId: workflowTask.value?.questionHolderId }),
);
/** cancel is terminal — the drawer arms a confirm block instead of firing at once */
const cancelArmed = ref(false);
async function confirmCancel() {
  if (await wfAction('abandon')) cancelArmed.value = false;
}

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
// the drawer timeline reads the SAME source as the task page (threadList, which
// already drops STATUS bookkeeping rows) through the same buildThread merge —
// the old raw activity feed showed a different, noisier timeline than the thread
const drawerThreadQuery = useQuery(
  computed(() =>
    $orpc.tasks.threadList.queryOptions({
      input: { taskId: drawerTaskId.value },
      queryKey: [CHANGE_RESOURCE.TASK_ACTIVITY, drawerTaskId.value, 'thread'],
      enabled: !!drawerTaskId.value,
    }),
  ),
);
const drawerOlderRows = ref<ThreadRow[]>([]);
const drawerOlderHasMore = ref<boolean | null>(null); // null: never paginated — the newest page decides
const drawerThreadRows = computed<ThreadRow[]>(() => {
  // THREAD BOUNDING LAW (#175): same bounded envelope as the task page — the
  // newest page rides the GET, older pages accumulate on demand below it; SSE
  // refetches replace only the newest page (id-dedupe absorbs boundary overlap)
  const newest = (unref(drawerThreadQuery.data) ?? null) as ThreadPage | null;
  const items = newest?.items ?? [];
  if (!drawerOlderRows.value.length) return items;
  const seen = new Set<string>();
  const merged: ThreadRow[] = [];
  for (const r of [...drawerOlderRows.value, ...items]) {
    if (!seen.has(r.id)) merged.push(r);
    seen.add(r.id);
  }
  return merged;
});
const drawerHasMore = computed(
  () => drawerOlderHasMore.value ?? (unref(drawerThreadQuery.data) as ThreadPage | null)?.hasMore ?? false,
);
const drawerOlderLoading = ref(false);
const drawerOlderFailed = ref(false);
// a drawer opened for another task starts at the newest page — held older pages
// must never leak across tasks (this component is not remounted per task)
watch(drawerTaskId, () => {
  drawerOlderRows.value = [];
  drawerOlderHasMore.value = null;
  drawerOlderFailed.value = false;
});
/** one-shot previous page ($client imperative GET — queryOptions stay on $orpc);
 * cursor = the OLDEST held row's (createdAt,id), same contract as the task page */
async function loadDrawerOlderPage() {
  const oldest = drawerThreadRows.value[0];
  if (!oldest || drawerOlderLoading.value || !drawerHasMore.value) return;
  drawerOlderLoading.value = true;
  drawerOlderFailed.value = false;
  try {
    const page = await $client.tasks.threadOlderPage({
      taskId: drawerTaskId.value,
      before: { createdAt: oldest.createdAt, id: oldest.id },
    });
    drawerOlderRows.value = [...page.items, ...drawerOlderRows.value];
    drawerOlderHasMore.value = page.hasMore;
  } catch {
    drawerOlderFailed.value = true; // the pager button stays — it is the retry
  } finally {
    drawerOlderLoading.value = false;
  }
}
// runs render in their own card above, so the feed keeps notes only
const workflowFeed = computed<ThreadNoteItem[]>(() =>
  buildThread({
    runs: [],
    activity: activityNotes(drawerThreadRows.value),
  }).filter((i): i is ThreadNoteItem => i.kind === 'note'),
);
/** one view lookup per activity row — label and glyph always agree */
const activityViewById = computed(() => new Map(workflowFeed.value.map((a) => [a.id, activityView(a.noteKind)])));

/** RUN-TRANSCRIPT LAW (#130 slice 2): settled runs' transcript text is fetched
 * on demand once per run (cached for the drawer's lifetime) — the live run's
 * output rides the snapshot; drawer cards keep the always-visible transcript */
const drawerTranscripts = ref(new Map<string, { output: string; prompt: string | null }>());
const drawerTranscriptInFlight = new Set<string>();
async function ensureDrawerTranscript(runId: string) {
  if (drawerTranscripts.value.has(runId) || drawerTranscriptInFlight.has(runId)) return;
  drawerTranscriptInFlight.add(runId);
  try {
    // one-shot imperative GET — $orpc is the TanStack utils surface (queryOptions
    // only); raw procedure calls ride $client (same client useChangeEvents uses)
    const row = await $client.tasks.runTranscript({ runId });
    drawerTranscripts.value = new Map(drawerTranscripts.value).set(runId, {
      output: row.output,
      prompt: row.prompt,
    });
  } catch {
    // unknown/gone run: leave uncached — the card simply renders no transcript
  } finally {
    drawerTranscriptInFlight.delete(runId);
  }
}
// pull transcripts for every run the drawer shows without live output (once —
// the in-flight guard + cache keep SSE refetches from re-downloading them)
watch(runFeed, (rows) => {
  for (const r of rows) {
    if (r.output == null && r.hasOutput) void ensureDrawerTranscript(r.id);
  }
});

/** a run's transcript text — live stream, else the fetched transcript; rendered
 * as the thread shows it: the envelope's text, else raw */
function runText(r: TaskRunRow): string {
  const output = r.output ?? drawerTranscripts.value.get(r.id)?.output ?? '';
  return parseRunEnvelope(output)?.text ?? output;
}

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
  // a note/verdict for the previously open task must not leak into this one
  resetWorkflow();
  cancelArmed.value = false;
  // reset the forward picker too — a stale pre-armed selection would fire the
  // next Forward at whoever was picked for a previous task
  forwardTo.value = NONE_ID;
  workflowOpen.value = true;
}

// review verdicts are an explicit-reviewer surface — gate on ids, never names:
// a name is display data and two employees can share one
const session = useAppSession();
const drawerCanReview = computed(
  () => !!session.value && !!workflowTask.value?.reviewers.includes(session.value.user.id),
);
/** forward renders ONLY where the server accepts it (SPEC): the task is
 *  waiting-answer AND the viewer is the pending answer obligation's holder —
 *  never while the task is merely working (the server rejects that, #92). */
const canForward = computed(() =>
  forwardReady({
    category: workflowStatusCategory.value,
    holderId: workflowTask.value?.questionHolderId,
    userId: session.value?.user.id,
  }),
);

// ---- board (kanban) view ----
// Persisted client-side only (localStorage via VueUse) — deliberately NOT a DB setting.
const view = useLocalStorage<'list' | 'board'>('tasks:view', 'list');
const draggingId = ref<string | null>(null);
const dropTarget = ref<string | null>(null);
const boardColumns = computed(() => statuses.value);

// board card kebab menu items — the actions hide behind one menu instead of an
// always-on icon row (accent rationing: delete is a menu item, not a red button)
// kebab menu items are phone-first tap targets (MOBILE-FIRST law: ≥44px) —
// the menu is the ONLY action surface on mobile cards
const BOARD_MENU_ITEM =
  'flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-xs text-muted transition-colors hover:bg-elevated hover:text-highlighted';

// manual status is FREE on every surface (owner ruling) — any column is a legal drop

function tasksByStatus(status: string) {
  return rows.value.filter((t) => rowStatus(t) === status);
}

function onDragStart(e: DragEvent, id: string) {
  draggingId.value = id;
  if (!e.dataTransfer) return;
  // the payload IS the task id — the drop handler reads it back instead of
  // trusting a ref that a second drag (or another window) could have moved
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', id);
}

function onDrop(status: string, e: DragEvent) {
  if (busy.value) return;
  const id = e.dataTransfer?.getData('text/plain') || draggingId.value;
  draggingId.value = null;
  dropTarget.value = null;
  const row = rows.value.find((t) => t.id === id);
  if (!row || rowStatus(row) === status) return;
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
        v-if="total > 0 || !!search || listFiltered"
        v-model="search"
        icon="i-lucide-search"
        placeholder="Search tasks…"
        size="sm"
        class="w-full sm:max-w-xs"
        aria-label="Search tasks"
      />
      <!-- #99: the List/Board toggle is pinned OUTSIDE the right-aligned action
           scroller — inside it, the overflow group pushed the toggle out of the
           visible row at 390×844 and board view had no touch entry point.
           44px tap targets at phone widths (MOBILE-FIRST law), compact from sm. -->
      <div
        class="border-default bg-default inline-flex overflow-hidden rounded-md border"
        role="group"
        aria-label="View"
      >
        <button
          type="button"
          class="h-11 px-3 py-1.5 text-sm font-medium transition-colors sm:h-8"
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
          class="border-default h-11 border-l px-3 py-1.5 text-sm font-medium transition-colors sm:h-8"
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
      <!-- #103: the action scroller gets the same right-edge affordance as the
           status strip below — a trailing control clipped by the edge reads as
           scrollable (fade + peek padding), never as broken. pr-16 lets the
           last control scroll fully clear of the fade. -->
      <div class="relative ms-auto flex min-w-0 items-center">
        <div
          class="flex [scrollbar-width:thin] items-center gap-2 overflow-x-auto [mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)] pr-16"
        >
          <UButton
            color="neutral"
            :variant="needsDecision ? 'solid' : 'outline'"
            size="sm"
            class="h-11 sm:h-8"
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
                v-if="inboxQuery.isPending.value"
                class="bg-accented text-muted inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-4 font-semibold"
                data-testid="inbox-count-pending"
                aria-label="Loading the decision count"
                >…</span
              >
              <span
                v-else-if="inboxQuery.isError.value"
                class="bg-error/15 text-error inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-4 font-semibold"
                data-testid="inbox-count-error"
                title="Couldn't load the decision count — reopen the page to retry"
                aria-label="Decision count unavailable"
                >!</span
              >
              <span
                v-else-if="inboxCount > 0"
                class="bg-accented text-default inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-4 font-semibold"
                data-testid="inbox-count"
                >{{ inboxCount }}</span
              >
            </span>
          </UButton>
          <UButton
            color="neutral"
            :variant="awaitingDecision ? 'solid' : 'outline'"
            size="sm"
            class="h-11 sm:h-8"
            aria-label="Awaiting decision"
            :aria-pressed="awaitingDecision"
            data-testid="awaiting-decision-toggle"
            @click="awaitingDecision = !awaitingDecision"
          >
            <span class="inline-flex items-center gap-1.5">
              <UIcon name="i-lucide-hourglass" class="size-4" />
              <!-- mobile shows the short label — the full words wrap at 390px -->
              <span class="whitespace-nowrap sm:hidden">Awaiting</span>
              <span class="hidden whitespace-nowrap sm:inline">Awaiting decision</span>
              <span
                v-if="awaitingCount > 0"
                class="bg-accented text-default inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] leading-4 font-semibold"
                data-testid="awaiting-count"
                >{{ awaitingCount }}</span
              >
            </span>
          </UButton>
          <UButton
            icon="i-lucide-settings-2"
            label="Statuses"
            color="neutral"
            variant="outline"
            size="sm"
            class="h-11 sm:h-8"
            @click="statusManagerOpen = true"
          />
          <UButton
            v-if="rows.length > 0 || listFiltered"
            icon="i-lucide-plus"
            label="New task"
            size="sm"
            class="h-11 sm:h-8"
            @click="openEditor()"
          />
        </div>
        <div
          class="from-default pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l to-transparent"
          aria-hidden="true"
        />
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
        class="flex [scrollbar-width:thin] items-center gap-1.5 overflow-x-auto [mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)] pr-16"
        role="group"
        aria-label="Filter by status"
      >
        <UButton
          size="sm"
          color="neutral"
          variant="soft"
          class="h-11 shrink-0 sm:h-7"
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
          class="h-11 shrink-0 sm:h-7"
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
      :empty-noun="emptyNoun"
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
          <p v-if="waitingForRow(row.original)" class="flex w-fit items-center gap-1 text-xs">
            <UBadge color="warning" variant="subtle" size="sm" icon="i-lucide-hourglass" class="gap-1">
              {{ waitingForRow(row.original) }}
            </UBadge>
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
          :model-value="rowStatus(row.original)"
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
              :class="statusDot(rowStatus(row.original))"
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
              @click="openDelete(row.original)"
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
                    :class="statusDot(rowStatus(row))"
                    aria-hidden="true"
                  />
                  {{ statusLabel(rowStatus(row), statusById) }}
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
              <p v-if="waitingForRow(row)" class="mt-0.5 flex w-fit items-center gap-1 text-xs">
                <UBadge color="warning" variant="subtle" size="sm" icon="i-lucide-hourglass" class="gap-1">
                  {{ waitingForRow(row) }}
                </UBadge>
              </p>
            </div>
            <!-- every card action hides behind one kebab — no visible trash row
                 to mis-tap on a phone; Move to… is the touch/keyboard status path.
                 The trigger's ::after hit-area bleed keeps the small icon ≥44px
                 tappable without growing the visible glyph. -->
            <UPopover :ui="{ content: 'w-44 p-1' }">
              <UButton
                icon="i-lucide-ellipsis-vertical"
                size="sm"
                color="neutral"
                variant="ghost"
                :aria-label="`Actions for ${row.title}`"
                class="relative shrink-0 after:absolute after:-inset-2 after:content-['']"
              />
              <template #content>
                <div class="flex flex-col">
                  <button type="button" :class="BOARD_MENU_ITEM" :disabled="busy" @click="autoAssign(row)">
                    <UIcon name="i-lucide-wand-sparkles" class="size-3.5 shrink-0" />Auto-assign
                  </button>
                  <button type="button" :class="BOARD_MENU_ITEM" @click="openWorkflow(row)">
                    <UIcon name="i-lucide-message-circle-more" class="size-3.5 shrink-0" />Workflow
                  </button>
                  <p class="text-dimmed px-2 pt-1.5 pb-1 text-[10px] font-medium">Move to…</p>
                  <div class="max-h-40 overflow-y-auto">
                    <button
                      v-for="st in statuses"
                      :key="st.id"
                      type="button"
                      :class="BOARD_MENU_ITEM"
                      :disabled="busy || rowStatus(row) === st.id"
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
                    @click="openDelete(row)"
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
      <div
        class="flex h-[min(72dvh,44rem)] min-h-72 snap-x [scrollbar-width:thin] items-stretch gap-4 overflow-x-auto pb-2"
      >
        <section
          v-for="col in boardColumns"
          :key="col.id"
          :aria-labelledby="`board-col-${col.id}`"
          data-testid="board-column"
          class="border-default bg-muted/40 flex min-w-[260px] flex-1 snap-start flex-col rounded-lg border"
          :class="dropTarget === col.id ? 'ring-primary ring-2' : ''"
          @dragover.prevent="dropTarget = col.id"
          @dragleave="dropTarget === col.id && (dropTarget = null)"
          @drop.prevent="onDrop(col.id, $event)"
        >
          <header class="border-default flex items-center justify-between gap-2 border-b px-3 py-2">
            <h3 :id="`board-col-${col.id}`" class="text-toned flex min-w-0 items-center gap-1.5 text-sm font-medium">
              <UIcon
                :name="categoryIcon(col.category)"
                class="size-4 shrink-0"
                :class="categoryText(col.category)"
                aria-hidden="true"
              />
              <span class="truncate">{{ col.name }}</span>
            </h3>
            <UBadge
              color="neutral"
              variant="subtle"
              size="sm"
              class="shrink-0"
              :title="pageCount > 1 ? 'Counts tasks on this page only — use the pager for the rest' : undefined"
            >
              {{ tasksByStatus(col.id).length }}
              {{ pageCount > 1 ? 'on this page' : 'tasks' }}
            </UBadge>
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
                  statusById.get(rowStatus(row))?.category === CATEGORY.DONE ? 'opacity-70' : '',
                ]"
                @dragstart="onDragStart($event, row.id)"
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
                      class="relative transition-opacity after:absolute after:-inset-2 after:content-[''] max-md:opacity-100 md:opacity-0 md:group-focus-within/card:opacity-100 md:group-hover/card:opacity-100"
                    />
                    <template #content>
                      <div class="flex flex-col">
                        <button type="button" :class="BOARD_MENU_ITEM" :disabled="busy" @click="autoAssign(row)">
                          <UIcon name="i-lucide-wand-sparkles" class="size-3.5 shrink-0" />Auto-assign
                        </button>
                        <!-- Workflow: the same drawer the desktop row button opens —
                           at phone widths the drawer's only entry is this item -->
                        <button type="button" :class="BOARD_MENU_ITEM" @click="openWorkflow(row)">
                          <UIcon name="i-lucide-message-circle-more" class="size-3.5 shrink-0" />Workflow
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
                            :disabled="busy || rowStatus(row) === st.id"
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
                          @click="openDelete(row)"
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
                <p v-if="waitingForRow(row)" class="mt-1 flex w-fit items-center gap-1 text-xs">
                  <UBadge color="warning" variant="subtle" size="sm" icon="i-lucide-hourglass" class="gap-1">
                    {{ waitingForRow(row) }}
                  </UBadge>
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
      <span class="text-muted px-2 text-xs" aria-live="polite">Page {{ page }} of {{ pageCount }}</span>
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
          <!-- contextual verbs only (owner rulings 2026-10-26): notes/answers ride the composer.
               Working states carry submit + cancel — each gated by the SHARED server-truth
               helpers (submit = viewer is the human assignee, working category; cancel = owner
               or assignee); Forward lives in its own block below — the server accepts it only
               from the answer holder while waiting-answer (#92). -->
          <div v-if="drawerCanSubmit || drawerCanCancel" class="flex flex-wrap gap-2">
            <UButton
              v-if="drawerCanSubmit"
              size="sm"
              color="primary"
              variant="soft"
              icon="i-lucide-send"
              :disabled="workflowBusy"
              @click="wfAction('submit', { body: workflowNote })"
              >Submit for review</UButton
            >
            <UButton
              v-if="drawerCanCancel"
              size="sm"
              color="error"
              variant="soft"
              icon="i-lucide-ban"
              :disabled="workflowBusy"
              @click="cancelArmed = true"
              >Cancel task</UButton
            >
          </div>
          <!-- forward: renders ONLY where it can succeed — waiting-answer + the
               viewer is the pending answer obligation's holder (SPEC, #92) -->
          <div v-if="canForward" class="flex flex-wrap gap-2">
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
          </div>
          <!-- cancelling is terminal: confirm it inline instead of firing on one click -->
          <div
            v-if="cancelArmed"
            class="border-error/40 bg-error/10 space-y-2 rounded-md border p-2.5 text-xs"
            role="alertdialog"
            aria-label="Confirm cancelling the task"
          >
            <p class="text-toned">Cancelling ends this task: the agent stops and it can no longer be dispatched.</p>
            <div class="flex gap-2">
              <UButton size="xs" color="error" label="Cancel task" :loading="workflowBusy" @click="confirmCancel" />
              <UButton size="xs" color="neutral" variant="ghost" label="Keep it" @click="cancelArmed = false" />
            </div>
          </div>
          <!-- forward picker rides the forward verb's own gate (waiting-answer + holder) -->
          <USelect
            v-if="canForward"
            v-model="forwardTo"
            :items="forwardItems"
            value-key="value"
            size="sm"
            class="w-full"
            aria-label="Forward to"
          />
          <TaskReviewBox
            v-if="workflowStatusCategory === CATEGORY.IN_REVIEW && drawerCanReview"
            :key="workflowTask?.id"
            :busy="workflowBusy"
            :verdict-seq="verdictSeq"
            :verdict-failed="verdictFailed"
            @verdict="
              (action: 'approve' | 'requestChanges' | 'reject', body?: string) =>
                wfAction(action, { body: body || undefined })
            "
          />
          <UTextarea
            v-model="workflowNote"
            :rows="3"
            :disabled="workflowBusy"
            :placeholder="composerPlaceholder(workflowStatusCategory === CATEGORY.WAITING_ANSWER)"
            aria-label="Task note"
            class="w-full"
          />
          <UButton
            size="sm"
            color="primary"
            variant="soft"
            icon="i-lucide-arrow-up"
            :disabled="workflowBusy || !drawerSendReady"
            @click="sendDrawerNote()"
          >
            {{ workflowStatusCategory === CATEGORY.WAITING_ANSWER ? 'Send answer' : 'Send' }}
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
                v-if="runText(r)"
                class="bg-inverted text-inverted max-h-72 overflow-y-auto rounded-b-md px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
                >{{ runText(r) }}</pre>
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
            <!-- THREAD BOUNDING LAW: older activity loads on demand, above the feed -->
            <div v-if="drawerHasMore" class="text-center">
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-lucide-chevron-up"
                label="Load earlier activity"
                :loading="drawerOlderLoading"
                class="min-h-11"
                data-testid="drawer-thread-older"
                @click="loadDrawerOlderPage"
              />
            </div>
            <p v-if="drawerOlderFailed" role="alert" class="text-error text-xs">Couldn't load earlier activity.</p>
            <div v-for="a in workflowFeed" :key="a.id" class="border-default rounded-md border px-2.5 py-2 text-xs">
              <p class="text-toned flex items-center gap-1.5 font-medium">
                <UIcon :name="activityViewById.get(a.id)?.icon ?? 'i-lucide-info'" class="size-3.5" />
                {{ activityViewById.get(a.id)?.label ?? 'Note' }}
                <span class="text-muted font-normal">{{ a.authorName ?? 'system' }}</span>
                <span class="text-dimmed ml-auto shrink-0 font-normal" data-allow-mismatch>{{
                  formatWhenShort(threadTime(a))
                }}</span>
              </p>
              <p v-if="a.body" class="text-muted mt-1">{{ a.body }}</p>
            </div>
            <div v-if="drawerThreadQuery.isPending.value" class="space-y-2" aria-hidden="true">
              <USkeleton class="h-10 w-full rounded-md" />
            </div>
            <p v-else-if="drawerThreadQuery.isError.value" role="alert" class="text-error text-xs">
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
