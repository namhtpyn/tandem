<script setup lang="ts">
import { useQuery, useMutation, useQueryClient } from '@tanstack/vue-query';

import { CHANGE_RESOURCE, PROPOSAL_KIND, type ProposalKind } from '#shared/enums';
import { STATUS } from '#shared/status';
// Task detail — Paperclip-style layout: chat-like main content (description bubble,
// run turns, activity notes, composer at the bottom) + right sidebar with task info
// (status, assignee, reviewers, workflow actions). Mobile-first: single column,
// sidebar collapses into a sheet. Streams stay persistent (one per feed, aborted
// on unmount) — see the stream law in AGENTS.md.
import { nonNull } from '#shared/utils/non-null';
import type { EmployeeRow, TaskRow } from '~/utils/orpc-types';
import { buildThread, formatThreadTime, parseRunEnvelope, runOutputWithoutEnvelope } from '~/utils/task-thread';
import type { ThreadItem } from '~/utils/task-thread';

const route = useRoute();
const { $orpc, $client } = useNuxtApp();

const tasksLive = useQuery($orpc.tasks.list.queryOptions({ queryKey: [CHANGE_RESOURCE.TASKS] }));

const tasks = computed(() => (unref(tasksLive.data) ?? []) as TaskRow[]);

const task = computed(() => tasks.value.find((t) => t.id === String(route.params.id)) ?? null);

const workflowNote = ref('');
const workflowBusy = ref(false);
const workflowMessage = ref('');

// ---- first-load data via GET + change-event invalidation (SSE law) -----------
// runs/activity start as a conventional GET the moment the task resolves; the
// app-wide changes subscription refetches them whenever the server says runs or
// activity changed. No long-lived stream is opened for initial data.
// Gated via `enabled` rather than skipToken — bundler-split copies of the
// skipToken symbol (oRPC vs vue-query chunks) defeat oRPC's skip detection and
// the queries fire with a serialized-away input (server: BAD_REQUEST).
const taskIdRef = computed(() => task.value?.id ?? '');
const runsQuery = useQuery(
  computed(() =>
    $orpc.tasks.runsList.queryOptions({
      input: { taskId: taskIdRef.value },
      queryKey: [CHANGE_RESOURCE.RUNS, taskIdRef.value],
      enabled: !!taskIdRef.value,
    }),
  ),
);
const runFeed = computed(
  () =>
    (unref(runsQuery.data) ?? []) as unknown as Array<{
      id: string;
      status: string;
      output: string;
      prompt?: string | null;
      agentName?: string | null;
      exitCode: number | null;
      startedAt: string;
      outputs?: Array<{ id: string; filename: string; mime: string; size: number }>;
    }>,
);

const activityQuery = useQuery(
  computed(() =>
    $orpc.tasks.activityList.queryOptions({
      input: { taskId: taskIdRef.value },
      queryKey: [CHANGE_RESOURCE.TASK_ACTIVITY, taskIdRef.value],
      enabled: !!taskIdRef.value,
    }),
  ),
);
const reviewsQuery = useQuery(
  computed(() =>
    $orpc.tasks.reviews.queryOptions({
      input: { taskId: taskIdRef.value },
      queryKey: ['taskReviews', taskIdRef.value],
      enabled: !!taskIdRef.value,
    }),
  ),
);
/** REVIEW LAW checklist: current-round verdicts per reviewer, history collapsed by round */
const reviewChecklist = computed(() => {
  const rows = (unref(reviewsQuery.data) ?? []) as unknown as Array<{
    reviewerId: string;
    round: number;
    status: string;
    note: string | null;
    source: string | null;
  }>;
  const employees = (unref(employeesLive.data) ?? []) as unknown as Array<{ userId: string; name: string }>;
  const nameOf = (id: string) => employees.find((e) => e.userId === id)?.name ?? 'reviewer';
  let maxRound = 0;
  for (const r of rows) maxRound = Math.max(maxRound, r.round);
  return {
    current: rows.filter((r) => r.round === maxRound).map((r) => ({ ...r, name: nameOf(r.reviewerId) })),
    history: rows.filter((r) => r.round < maxRound).map((r) => ({ ...r, name: nameOf(r.reviewerId) })),
  };
});
const workflowFeed = computed(
  () =>
    (unref(activityQuery.data) ?? []) as unknown as Array<{
      id: string;
      kind: string;
      body: string;
      authorName: string | null;
      authorId: string | null;
      createdAt: string;
    }>,
);
const infoSheetOpen = ref(false);
// the task creator opens the thread as the brief's author
const briefAuthor = computed(() => task.value?.creatorName ?? null);
const briefAuthorId = computed(() => task.value?.createdBy ?? null);

const retryInMin = computed(() => {
  if (!task.value?.dispatchAfter) return 0;
  const ms = new Date(task.value.dispatchAfter).getTime() - Date.now();
  return ms > 0 ? Math.max(1, Math.round(ms / 60_000)) : 0;
});

// ---- one ordered timeline from runs + activity + description -----------------
const thread = computed<ThreadItem[]>(() =>
  buildThread({
    description: task.value?.description ?? null,
    createdAt: task.value?.createdAt ?? null,
    briefAuthorName: task.value?.creatorName ?? null,
    briefAuthorId: task.value?.createdBy ?? null,
    runs: runFeed.value.map((r) => ({
      id: r.id,
      status: (r.status === 'running' ? 'running' : r.status === 'done' ? 'done' : 'failed') as
        | 'running'
        | 'done'
        | 'failed',
      output: r.output,
      prompt: r.prompt,
      agentName: r.agentName,
      exitCode: r.exitCode,
      startedAt: r.startedAt,
      finishedAt: null,
    })),
    activity: workflowFeed.value.map((a) => ({
      id: a.id,
      noteKind: a.kind,
      body: a.body,
      authorName: a.authorName,
      authorId: a.authorId,
      createdAt: a.createdAt,
    })),
  }),
);

const scroller = ref<HTMLElement | null>(null);

const outputsByRun = computed(() => {
  const m = new Map<string, Array<{ id: string; filename: string; mime: string; size: number }>>();
  for (const r of runFeed.value) if (r.outputs?.length) m.set(r.id, r.outputs);
  return m;
});
watch(
  () => thread.value.length,
  async () => {
    await nextTick();
    scroller.value?.scrollTo({ top: scroller.value.scrollHeight });
  },
);

function runOutputs(item: ThreadItem) {
  return item.kind === 'run' ? (outputsByRun.value.get(item.id) ?? []) : [];
}

/** split the brief description into text + attachment refs for rendering */
const briefParts = computed(() => {
  const desc = task.value?.description ?? '';
  const parts: Array<
    | { type: 'text'; body: string }
    | { type: 'mention'; label: string }
    | { type: 'image'; id: string; alt: string }
    | { type: 'file'; id: string; name: string }
  > = [];
  // split attachments first, then employee mentions inside the text parts
  const re = /!\[([^\]]*)\]\(attachment-([^)]+)\)|@\[([^\]]*)\]\(attachment-([^)]+)\)/g;
  let last = 0;
  for (const m of desc.matchAll(re)) {
    if (nonNull(m.index) > last) pushText(desc.slice(last, m.index));
    if (m[2] !== undefined) parts.push({ type: 'image', id: nonNull(m[2]), alt: nonNull(m[1]) });
    else parts.push({ type: 'file', id: nonNull(m[4]), name: nonNull(m[3]) });
    last = nonNull(m.index) + m[0].length;
  }
  if (last < desc.length) pushText(desc.slice(last));
  return parts;

  function pushText(text: string) {
    // either tiptap link form `@[Label](mention-id)` or serialized span `[@ id="..." label="..."]`
    const re = /@\[([^\]]+)\]\(mention-[^)]+\)|\[@\s*id="[^"]*"\s+label="([^"]+)"\]/g;
    let at = 0;
    for (const m of text.matchAll(re)) {
      if (nonNull(m.index) > at) parts.push({ type: 'text', body: text.slice(at, m.index) });
      parts.push({ type: 'mention', label: m[1] ?? m[2] ?? '' });
      at = nonNull(m.index) + m[0].length;
    }
    if (at < text.length) parts.push({ type: 'text', body: text.slice(at) });
  }
});

function envelopeOf(item: ThreadItem) {
  return item.kind === 'run' ? parseRunEnvelope(item.output) : null;
}
function envelopeColor(kind: string) {
  return kind === 'question' ? 'warning' : kind === 'blocked' ? 'error' : 'success';
}

async function wfAction(proc: string, extra: Record<string, unknown> = {}) {
  if (!task.value) return;
  workflowBusy.value = true;
  workflowMessage.value = '';
  try {
    await $fetch(`/rpc/tasks/${proc}`, { method: 'POST', body: { json: { taskId: task.value.id, ...extra } } });
    workflowNote.value = '';
    void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASK_ACTIVITY, task.value.id] });
    void queryClient.invalidateQueries({ queryKey: ['taskReviews', task.value.id] });
    workflowMessage.value = 'done';
  } catch (e) {
    const err = e as { data?: { json?: { message?: string }; message?: string }; message?: string };
    workflowMessage.value = err.data?.json?.message ?? err.data?.message ?? err.message ?? 'action failed';
  } finally {
    workflowBusy.value = false;
  }
}

// ---- subtasks, agent proposals, assignment history ---------------------------
const employeesLive = useQuery($orpc.employees.list.queryOptions({ queryKey: [CHANGE_RESOURCE.EMPLOYEES] }));
const employees = computed(() => (unref(employeesLive.data) ?? []) as EmployeeRow[]);
const employeeName = computed(() => new Map(employees.value.map((e) => [e.id, e.name])));
/** userId -> hasAvatar: chat avatars render via /api/employees/:userId/avatar, initials otherwise */
const hasAvatarByUserId = computed(() => new Map(employees.value.map((e) => [e.userId, e.hasAvatar])));

// ---- editable details (assignee / project / status) — reviewers deliberately excluded ----
const statusesLive = useQuery($orpc.statuses.list.queryOptions({ queryKey: [CHANGE_RESOURCE.STATUSES] }));
const statuses = computed(() => unref(statusesLive.data) ?? []);
const statusById = computed(() => new Map(statuses.value.map((x) => [x.id, x])));
const projectsLive = useQuery($orpc.projects.list.queryOptions({ queryKey: [CHANGE_RESOURCE.PROJECTS] }));
const projects = computed(() => (unref(projectsLive.data) ?? []) as Array<{ id: string; name: string }>);
const updateMutation = useMutation($orpc.tasks.update.mutationOptions());
const fieldBusy = ref(false);
const fieldError = ref('');
/** status select: current + the workflow-allowed next statuses (server enforces the same rule) */
const selectableStatuses = computed(() => {
  const cur = task.value?.status ? statusById.value.get(task.value.status) : null;
  if (!cur) return [];
  return [
    cur,
    ...cur.nextIds
      .filter((id) => id !== cur.id)
      .map((id) => statusById.value.get(id))
      .filter((s) => !!s),
  ];
});
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
  if (!task.value || fieldBusy.value) return;
  fieldBusy.value = true;
  fieldError.value = '';
  try {
    await updateMutation.mutateAsync({ id: task.value.id, ...patch });
    await queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASKS] });
  } catch (e) {
    const err = e as { data?: { json?: { message?: string } }; message?: string };
    fieldError.value = err.data?.json?.message ?? err.message ?? 'update failed';
  } finally {
    fieldBusy.value = false;
  }
}

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

const subtaskRows = ref<ChildRow[]>([]);
const proposalRows = ref<ProposalRow[]>([]);
const assignmentRows = ref<AssignmentRow[]>([]);
const proposalBusy = ref(false);
const proposalMessage = ref('');
const subtaskTitle = ref('');
const subtaskAssignee = ref('__none__');

async function refreshRoutingPanels(taskId: string) {
  try {
    const [st, pr, as] = await Promise.all([
      $fetch('/rpc/tasks/subtasks', { method: 'POST', body: { json: { taskId } } }) as unknown as Promise<{
        json: { items: ChildRow[] };
      }>,
      $fetch('/rpc/tasks/proposals', { method: 'POST', body: { json: { taskId } } }) as unknown as Promise<{
        json: { items: ProposalRow[] };
      }>,
      $fetch('/rpc/tasks/assignments', { method: 'POST', body: { json: { taskId } } }) as unknown as Promise<{
        json: { items: AssignmentRow[] };
      }>,
    ]);
    subtaskRows.value = st.json.items;
    proposalRows.value = pr.json.items;
    assignmentRows.value = as.json.items;
  } catch {
    /* panels are best-effort; the thread still works */
  }
}

watch(
  () => task.value?.id,
  (id) => {
    if (id) void refreshRoutingPanels(id);
  },
  { immediate: true },
);

async function createSubtask() {
  if (!task.value || !subtaskTitle.value.trim()) return;
  proposalBusy.value = true;
  proposalMessage.value = '';
  try {
    await $fetch('/rpc/tasks/create', {
      method: 'POST',
      body: {
        json: {
          title: subtaskTitle.value.trim(),
          parentId: task.value.id,
          assigneeId: subtaskAssignee.value === '__none__' ? null : subtaskAssignee.value,
        },
      },
    });
    subtaskTitle.value = '';
    subtaskAssignee.value = '__none__';
    await refreshRoutingPanels(task.value.id);
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
    const r = (await $fetch(`/rpc/tasks/${action}`, { method: 'POST', body: { json: { proposalId: id } } })) as {
      json: { events?: string[] };
    };
    proposalMessage.value = r.json.events?.length ? r.json.events.join('; ') : 'done';
    await refreshRoutingPanels(nonNull(task.value).id);
    void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASK_ACTIVITY, nonNull(task.value).id] });
    void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.RUNS, nonNull(task.value).id] });
  } catch (e) {
    proposalMessage.value =
      (e as { data?: { json?: { message?: string } }; message?: string }).data?.json?.message ?? (e as Error).message;
  } finally {
    proposalBusy.value = false;
  }
}

const parentTask = computed(() =>
  task.value?.parentTaskId ? (tasks.value.find((t) => t.id === nonNull(task.value).parentTaskId) ?? null) : null,
);
const openProposals = computed(() => proposalRows.value.filter((p) => p.status === 'proposed'));
const assignmentLines = computed(() => {
  const rows = [...assignmentRows.value].reverse(); // oldest first
  return rows.map((r, i) => {
    const from = i === 0 ? '∅' : rows[i - 1] ? nonNull(rows[i - 1]).employeeName : '∅';
    return `${from} → ${r.employeeName ?? '∅'}${r.reason ? ` (${r.reason})` : ''}`;
  });
});

const queryClient = useQueryClient();

useHead({ title: () => (task.value ? `${task.value.title} · Tandem` : 'Task · Tandem') });

onServerPrefetch(() =>
  Promise.all([
    tasksLive.suspense(),
    runsQuery.suspense(),
    activityQuery.suspense(),
    reviewsQuery.suspense(),
    employeesLive.suspense(),
    statusesLive.suspense(),
    projectsLive.suspense(),
  ]),
);
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #body>
      <div class="p-3 lg:p-6">
        <div v-if="!task" class="py-16 text-center text-sm text-zinc-400">
          Task not found — it may have been deleted.
          <ULink to="/tasks" class="underline">Back to tasks</ULink>
        </div>

        <div v-else class="flex flex-col lg:h-[calc(100vh-7.5rem)] lg:flex-row lg:gap-6">
          <!-- ============ main: the chat ============ -->
          <section class="flex min-w-0 flex-1 flex-col">
            <!-- thread header (mobile shows the info trigger here) -->
            <div class="mb-3 flex items-start gap-2">
              <NuxtLink
                to="/tasks"
                class="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
              >
                <UIcon name="i-lucide-arrow-left" class="size-4" />
              </NuxtLink>
              <div class="min-w-0 flex-1">
                <h1 class="truncate text-lg font-semibold text-zinc-900 dark:text-zinc-50">{{ task.title }}</h1>
                <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500">
                  <UBadge
                    :color="
                      task.status === STATUS.done ? 'success' : task.status === STATUS.todo ? 'neutral' : 'warning'
                    "
                    variant="subtle"
                    size="sm"
                    >{{ statusById.get(task.status)?.name ?? '' }}</UBadge
                  >
                  <NuxtLink
                    v-if="parentTask"
                    :to="`/tasks/${parentTask.id}`"
                    class="text-primary inline-flex items-center gap-1 hover:underline"
                    data-testid="parent-task-link"
                  >
                    <UIcon name="i-lucide-corner-left-up" class="size-3" /> part of: {{ parentTask.title }}
                  </NuxtLink>
                  <span v-if="task.assigneeName"
                    >{{ task.assigneeName
                    }}<span v-if="task.assigneeKind === 'ai'" class="text-primary">(AI)</span></span
                  >
                </div>
              </div>
              <UButton
                size="xs"
                variant="soft"
                icon="i-lucide-panel-right"
                aria-label="Task info"
                data-testid="task-info-trigger"
                class="lg:hidden"
                @click="infoSheetOpen = true"
              />
            </div>

            <!-- retry banner -->
            <div
              v-if="retryInMin > 0"
              class="border-warning/30 bg-warning/5 text-warning mb-3 rounded-lg border px-3.5 py-2.5 text-sm"
            >
              <span class="font-medium">Retrying in ~{{ retryInMin }} min</span>
              <span class="text-warning/80">
                — {{ task.failStreak }} consecutive failure{{ task.failStreak === 1 ? '' : 's' }}. The most recent run's
                error is in the thread.</span
              >
            </div>

            <!-- the thread -->
            <div
              ref="scroller"
              class="min-h-0 flex-1 space-y-4 overflow-y-auto rounded-xl border border-zinc-200/70 bg-white/50 p-3.5 lg:max-h-none dark:border-zinc-800 dark:bg-zinc-900/40"
            >
              <p v-if="!thread.length" class="py-10 text-center text-xs text-zinc-400">No activity yet.</p>

              <template v-for="item in thread" :key="item.id">
                <!-- brief: the task description as the opening message -->
                <div v-if="item.kind === 'brief'" class="flex gap-2.5">
                  <img
                    v-if="item.authorId && hasAvatarByUserId.get(item.authorId)"
                    :src="`/api/employees/${item.authorId}/avatar`"
                    :alt="item.authorName ?? 'Task brief'"
                    class="mt-0.5 size-8 shrink-0 rounded-full object-cover"
                  />
                  <div
                    v-else
                    class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-[11px] font-semibold text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300"
                  >
                    {{ briefAuthor ? briefAuthor.slice(0, 2).toUpperCase() : 'T' }}
                  </div>
                  <div class="min-w-0 flex-1">
                    <p class="mb-1 text-[11px] font-medium text-zinc-400">
                      {{ briefAuthor ?? 'Task brief' }}
                      <span v-if="item.createdAt" class="font-normal text-zinc-300 dark:text-zinc-500"
                        >· {{ formatThreadTime(item.createdAt) }}</span
                      >
                    </p>
                    <!-- description: mention tokens -> @Name; attachment tokens -> inline images / file chips -->
                    <div
                      class="rounded-xl rounded-tl-sm border border-zinc-200/70 bg-zinc-50 px-3.5 py-2.5 text-sm leading-relaxed text-zinc-800 dark:border-zinc-700/60 dark:bg-zinc-800/60 dark:text-zinc-200"
                    >
                      <template v-for="(p, i) in briefParts" :key="i">
                        <span
                          v-if="p.type === 'mention'"
                          class="bg-primary/10 text-primary mx-0.5 inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium"
                          >@{{ p.label }}</span
                        >
                        <span v-if="p.type === 'text'" class="whitespace-pre-wrap">{{ p.body }}</span>
                        <img
                          v-else-if="p.type === 'image'"
                          :src="`/api/attachments/${p.id}`"
                          :alt="p.alt"
                          class="my-1.5 max-h-64 rounded-lg border border-zinc-200 dark:border-zinc-700"
                        />
                        <a
                          v-else-if="p.type === 'file'"
                          :href="`/api/attachments/${p.id}`"
                          target="_blank"
                          class="hover:border-primary/50 hover:text-primary my-1 inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                          ><UIcon name="i-lucide-file-text" class="size-3.5 shrink-0" />{{ p.name }}</a
                        >
                      </template>
                    </div>
                  </div>
                </div>

                <!-- run: an agent turn — one message from the agent, avatar + name + bubble -->
                <div v-else-if="item.kind === 'run'" class="flex gap-2.5">
                  <div
                    class="bg-primary/10 text-primary mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
                  >
                    {{ (item.agentName ?? 'Agent').slice(0, 2).toUpperCase() }}
                  </div>
                  <div class="min-w-0 flex-1">
                    <p class="mb-1 flex items-center gap-1.5 text-[11px] leading-none">
                      <span class="font-semibold text-zinc-600 dark:text-zinc-300">{{
                        item.agentName ?? 'Agent'
                      }}</span>
                      <span class="text-primary">(AI)</span>
                      <span
                        v-if="item.status === 'running'"
                        class="bg-warning/15 text-warning inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-semibold"
                        ><UIcon name="i-lucide-loader-circle" class="size-3 animate-spin" />working</span
                      >
                      <span
                        v-else-if="item.status === 'done'"
                        class="rounded-full bg-zinc-100 px-1.5 py-0.5 font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                        >completed</span
                      >
                      <span
                        v-else
                        class="bg-error/10 text-error inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-semibold"
                        >failed<span v-if="item.exitCode !== null" class="font-normal opacity-80">
                          exit {{ item.exitCode }}</span
                        ></span
                      >
                      <span class="ml-auto text-zinc-300 dark:text-zinc-600">{{
                        formatThreadTime(item.startedAt)
                      }}</span>
                    </p>
                    <!-- envelope: the decision-model line, integrated not alarmist (max-w for rhythm) -->
                    <div
                      v-if="envelopeOf(item)"
                      :class="[
                        'max-w-[calc(100%-3rem)] rounded-xl rounded-tl-sm border-l-2 px-3.5 py-2.5 text-sm leading-relaxed',
                        envelopeOf(item)!.kind === 'question'
                          ? 'border-l-blue-400/70 bg-blue-50/40 text-zinc-800 dark:bg-blue-500/10 dark:text-zinc-200'
                          : envelopeOf(item)!.kind === 'blocked'
                            ? 'border-l-error/70 bg-error/5 dark:bg-error/5 text-zinc-800 dark:text-zinc-200'
                            : 'border-l-emerald-400/70 bg-emerald-50/40 text-zinc-800 dark:bg-emerald-500/10 dark:text-zinc-200',
                      ]"
                    >
                      <span
                        :class="[
                          'mr-1.5 align-middle text-[9px] font-bold tracking-widest uppercase',
                          envelopeOf(item)!.kind === 'question'
                            ? 'text-blue-500'
                            : envelopeOf(item)!.kind === 'blocked'
                              ? 'text-error'
                              : 'text-emerald-600 dark:text-emerald-400',
                        ]"
                        >{{ envelopeOf(item)!.kind }}</span
                      ><span class="align-middle">{{ envelopeOf(item)!.text || '(empty)' }}</span>
                    </div>
                    <!-- collected output files (agent deliverables) -->
                    <div v-if="runOutputs(item).length" class="mt-1.5 flex flex-wrap gap-1.5">
                      <template v-for="f in runOutputs(item)" :key="f.id">
                        <img
                          v-if="f.mime.startsWith('image/')"
                          :src="`/api/attachments/${f.id}`"
                          :alt="f.filename"
                          class="max-h-48 rounded-lg border border-zinc-200 dark:border-zinc-700"
                        />
                        <a
                          v-else
                          :href="`/api/attachments/${f.id}`"
                          target="_blank"
                          class="hover:border-primary/50 hover:text-primary inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                          ><UIcon
                            :name="f.mime === 'application/pdf' ? 'i-lucide-file-text' : 'i-lucide-file'"
                            class="size-3.5 shrink-0"
                          />{{ f.filename
                          }}<span class="font-normal text-zinc-400"
                            >{{ Math.max(1, Math.round(f.size / 1024)) }}KB</span
                          ></a
                        >
                      </template>
                    </div>
                    <!-- exact prompt (brief) sent for this turn -->
                    <details v-if="item.prompt" class="group mt-1">
                      <summary
                        class="cursor-pointer text-xs text-zinc-400 select-none hover:text-zinc-600 dark:hover:text-zinc-300"
                      >
                        input
                      </summary>
                      <pre
                        class="mt-1 max-h-64 overflow-y-auto rounded-md bg-zinc-100 px-2.5 py-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-zinc-800 dark:bg-zinc-800/70 dark:text-zinc-300"
                        >{{ item.prompt }}</pre>
                    </details>
                    <!-- raw output (collapsed details keeps the thread chat-like; auto-open while the agent runs) -->
                    <details
                      v-if="runOutputWithoutEnvelope(item.output)"
                      class="group mt-1"
                      :open="item.status === 'running'"
                    >
                      <summary
                        class="cursor-pointer text-xs text-zinc-400 select-none hover:text-zinc-600 dark:hover:text-zinc-300"
                      >
                        output
                      </summary>
                      <pre
                        class="mt-1 max-h-96 overflow-y-auto rounded-md bg-zinc-950 px-2.5 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-200"
                        >{{ runOutputWithoutEnvelope(item.output) }}</pre>
                    </details>
                  </div>
                </div>

                <!-- note: slim system/human activity row -->
                <!-- human note: left bubble with initials avatar -->
                <div v-else-if="item.authorName" class="flex gap-2.5">
                  <img
                    v-if="item.authorId && hasAvatarByUserId.get(item.authorId)"
                    :src="`/api/employees/${item.authorId}/avatar`"
                    :alt="item.authorName"
                    class="mt-0.5 size-8 shrink-0 rounded-full object-cover"
                  />
                  <div
                    v-else
                    class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-[11px] font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
                  >
                    {{ item.authorName.slice(0, 2).toUpperCase() }}
                  </div>
                  <div class="min-w-0 flex-1">
                    <p class="mb-1 flex items-center gap-1.5 text-[11px] leading-none">
                      <span class="font-semibold text-zinc-600 dark:text-zinc-300">{{ item.authorName }}</span>
                      <span class="text-zinc-300 dark:text-zinc-600">{{ formatThreadTime(item.createdAt) }}</span>
                    </p>
                    <div
                      v-if="item.body"
                      class="inline-block max-w-full rounded-xl rounded-tl-sm bg-zinc-100 px-3.5 py-2 text-sm leading-relaxed text-zinc-800 dark:bg-zinc-800/70 dark:text-zinc-200"
                    >
                      {{ item.body }}
                    </div>
                  </div>
                </div>
                <!-- system note: centered pill -->
                <div v-else class="flex justify-center py-0.5">
                  <span
                    class="inline-flex max-w-full items-center gap-1.5 rounded-full bg-zinc-100/80 px-2.5 py-1 text-[11px] text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400"
                  >
                    <UIcon
                      :name="
                        item.noteKind === 'question'
                          ? 'i-lucide-help-circle'
                          : item.noteKind === 'answer'
                            ? 'i-lucide-check-check'
                            : item.noteKind === 'forward'
                              ? 'i-lucide-corner-up-right'
                              : item.noteKind === 'verdict'
                                ? 'i-lucide-gavel'
                                : 'i-lucide-info'
                      "
                      class="size-3 shrink-0"
                    />
                    <span class="truncate">{{ item.body || item.noteKind }}</span>
                    <span class="shrink-0 text-zinc-300 dark:text-zinc-600"
                      >· {{ formatThreadTime(item.createdAt) }}</span
                    >
                  </span>
                </div>
              </template>
            </div>

            <!-- composer: workflow note + primary actions -->
            <div
              class="mt-3 rounded-2xl border border-zinc-200 bg-white p-2.5 shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              <UTextarea
                v-model="workflowNote"
                :rows="1"
                autoresize
                :maxrows="6"
                variant="none"
                placeholder="Write a note or review…"
                class="w-full"
                :ui="{ base: 'px-1 py-1 text-sm placeholder:text-zinc-400' }"
              />
              <div class="mt-1.5 flex items-center justify-between">
                <p
                  v-if="workflowMessage"
                  class="text-xs"
                  :class="workflowMessage === 'done' ? 'text-success' : 'text-error'"
                >
                  {{ workflowMessage }}
                </p>
                <span v-else class="text-[11px] text-zinc-400 dark:text-zinc-500">⏎ submit · ▶ dispatch agent</span>
                <div class="ml-auto flex items-center gap-1.5">
                  <UPopover mode="hover" enable-touch>
                    <template #content><div class="px-3 py-1.5 text-xs">Dispatch to the AI assignee</div></template>
                    <UButton
                      size="lg"
                      color="primary"
                      variant="soft"
                      icon="i-lucide-play"
                      aria-label="Run agent"
                      class="size-10"
                      :disabled="workflowBusy || !task.assigneeKind || task.assigneeKind !== 'ai'"
                      @click="wfAction('dispatch')"
                  /></UPopover>
                  <UPopover mode="hover" enable-touch>
                    <template #content><div class="px-3 py-1.5 text-xs">Submit note to the thread</div></template>
                    <UButton
                      size="lg"
                      color="primary"
                      icon="i-lucide-arrow-up"
                      aria-label="Submit"
                      class="size-10"
                      :disabled="workflowBusy"
                      @click="wfAction('submit', { body: workflowNote || undefined })"
                  /></UPopover>
                </div>
              </div>
            </div>
          </section>

          <!-- ============ sidebar: task info (desktop docked; mobile via sheet above) ============ -->
          <aside
            class="hidden w-full shrink-0 self-start rounded-xl border border-zinc-200/70 bg-zinc-50/70 p-3.5 lg:sticky lg:top-4 lg:mt-0 lg:block lg:max-h-[calc(100vh-8.5rem)] lg:w-72 lg:overflow-y-auto dark:border-zinc-800 dark:bg-zinc-900/60"
          >
            <div class="space-y-4">
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
                        :disabled="fieldBusy"
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
                        :disabled="fieldBusy"
                        aria-label="Task assignee"
                        class="w-40"
                        @update:model-value="
                          (v: string) => task && updateField({ assigneeId: v === '__none__' ? null : v })
                        "
                      />
                    </dd>
                  </div>
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
                        @update:model-value="
                          (v: string) => task && updateField({ projectId: v === '__none__' ? null : v })
                        "
                      />
                    </dd>
                  </div>
                </dl>
                <p v-if="fieldError" class="text-error mt-1.5 text-xs">{{ fieldError }}</p>
              </div>

              <div v-if="task.reviewerNames.length">
                <p class="mb-2 text-xs font-semibold tracking-wide text-zinc-400 uppercase">Review</p>
                <ul class="space-y-1 text-sm">
                  <li v-for="r in reviewChecklist.current" :key="r.reviewerId" class="flex items-start gap-1.5">
                    <UIcon
                      :name="
                        r.status === 'approved'
                          ? 'i-lucide-badge-check'
                          : r.status === 'change_requested'
                            ? 'i-lucide-undo-2'
                            : r.status === 'rejected'
                              ? 'i-lucide-x-circle'
                              : 'i-lucide-user'
                      "
                      class="mt-0.5 size-3.5 shrink-0"
                      :class="
                        r.status === 'approved'
                          ? 'text-success'
                          : r.status === 'pending'
                            ? 'text-zinc-400'
                            : 'text-warning'
                      "
                    />
                    <span class="min-w-0">
                      <span class="block truncate text-zinc-800 dark:text-zinc-200"
                        >{{ r.name }}
                        <span class="text-xs text-zinc-400">({{ r.source === 'ai' ? 'AI' : 'human' }})</span></span
                      >
                      <span v-if="r.note" class="block truncate text-xs text-zinc-400" :title="r.note">{{
                        r.note
                      }}</span>
                    </span>
                  </li>
                  <li v-if="reviewChecklist.history.length" class="pt-1 text-xs text-zinc-400">
                    {{ reviewChecklist.history.length }} earlier-round verdict(s)
                  </li>
                </ul>
              </div>

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
                      <UBadge
                        :color="c.status === 'done' ? 'success' : c.status === 'blocked' ? 'error' : 'neutral'"
                        variant="subtle"
                        size="sm"
                        >{{ c.status }}</UBadge
                      >
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

              <div>
                <p class="mb-2 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">Workflow</p>
                <div class="grid grid-cols-2 gap-2">
                  <UButton
                    size="md"
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-help-circle"
                    class="justify-start"
                    :disabled="workflowBusy"
                    @click="wfAction('ask', { body: workflowNote || 'question' })"
                    >Ask</UButton
                  >
                  <UButton
                    size="md"
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-corner-up-right"
                    class="justify-start"
                    :disabled="workflowBusy"
                    @click="wfAction('forward', { body: workflowNote || undefined })"
                    >Forward</UButton
                  >
                  <UButton
                    size="md"
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-check-check"
                    class="justify-start"
                    :disabled="workflowBusy"
                    @click="wfAction('answer', { body: workflowNote || 'answer' })"
                    >Answer</UButton
                  >
                  <UButton
                    size="md"
                    color="success"
                    variant="outline"
                    icon="i-lucide-thumbs-up"
                    class="justify-start"
                    :disabled="workflowBusy"
                    @click="wfAction('approve', { body: workflowNote || undefined })"
                    >Approve</UButton
                  >
                  <UButton
                    size="md"
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-undo-2"
                    class="justify-start"
                    :disabled="workflowBusy"
                    @click="wfAction('request-changes', { body: workflowNote || 'needs changes' })"
                    >Request changes</UButton
                  >
                  <UButton
                    size="md"
                    color="error"
                    variant="outline"
                    icon="i-lucide-x-circle"
                    class="justify-start"
                    :disabled="workflowBusy"
                    @click="wfAction('reject', { body: workflowNote || undefined })"
                    >Reject</UButton
                  >
                  <UButton
                    size="md"
                    color="error"
                    variant="outline"
                    icon="i-lucide-ban"
                    class="justify-start"
                    :disabled="workflowBusy"
                    @click="wfAction('abandon', { body: workflowNote || undefined })"
                    >Abandon</UButton
                  >
                </div>
              </div>
            </div>
          </aside>
        </div>

        <!-- mobile info sheet: same sidebar content -->
        <USlideover v-if="task" v-model:open="infoSheetOpen" title="Task info" side="right" class="lg:hidden">
          <template #body>
            <div class="space-y-4">
              <div>
                <p class="mb-2 text-xs font-semibold tracking-wide text-zinc-400 uppercase">Details</p>
                <dl class="space-y-1.5 text-sm">
                  <div class="flex items-center justify-between gap-2">
                    <dt class="text-xs text-zinc-500">Status</dt>
                    <dd>
                      <USelect
                        :model-value="task.status"
                        :items="statusOptions"
                        value-key="value"
                        size="md"
                        :disabled="fieldBusy"
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
                        :disabled="fieldBusy"
                        aria-label="Task assignee"
                        class="w-40"
                        @update:model-value="
                          (v: string) => task && updateField({ assigneeId: v === '__none__' ? null : v })
                        "
                      />
                    </dd>
                  </div>
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
                        @update:model-value="
                          (v: string) => task && updateField({ projectId: v === '__none__' ? null : v })
                        "
                      />
                    </dd>
                  </div>
                </dl>
                <p v-if="fieldError" class="text-error mt-1.5 text-xs">{{ fieldError }}</p>
              </div>
              <div v-if="task.reviewerNames.length">
                <p class="mb-2 text-xs font-semibold tracking-wide text-zinc-400 uppercase">Review</p>
                <ul class="space-y-1 text-sm">
                  <li v-for="r in reviewChecklist.current" :key="r.reviewerId" class="flex items-start gap-1.5">
                    <UIcon
                      :name="
                        r.status === 'approved'
                          ? 'i-lucide-badge-check'
                          : r.status === 'change_requested'
                            ? 'i-lucide-undo-2'
                            : r.status === 'rejected'
                              ? 'i-lucide-x-circle'
                              : 'i-lucide-user'
                      "
                      class="mt-0.5 size-3.5 shrink-0"
                      :class="
                        r.status === 'approved'
                          ? 'text-success'
                          : r.status === 'pending'
                            ? 'text-zinc-400'
                            : 'text-warning'
                      "
                    />
                    <span class="min-w-0">
                      <span class="block truncate text-zinc-800 dark:text-zinc-200"
                        >{{ r.name }}
                        <span class="text-xs text-zinc-400">({{ r.source === 'ai' ? 'AI' : 'human' }})</span></span
                      >
                      <span v-if="r.note" class="block truncate text-xs text-zinc-400" :title="r.note">{{
                        r.note
                      }}</span>
                    </span>
                  </li>
                  <li v-if="reviewChecklist.history.length" class="pt-1 text-xs text-zinc-400">
                    {{ reviewChecklist.history.length }} earlier-round verdict(s)
                  </li>
                </ul>
              </div>
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
                      <UBadge
                        :color="c.status === 'done' ? 'success' : c.status === 'blocked' ? 'error' : 'neutral'"
                        variant="subtle"
                        size="sm"
                        >{{ c.status }}</UBadge
                      >
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

              <div>
                <p class="mb-2 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">Workflow</p>
                <div class="grid grid-cols-2 gap-2">
                  <UButton
                    size="md"
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-help-circle"
                    class="justify-start"
                    :disabled="workflowBusy"
                    @click="wfAction('ask', { body: workflowNote || 'question' })"
                    >Ask</UButton
                  >
                  <UButton
                    size="md"
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-corner-up-right"
                    class="justify-start"
                    :disabled="workflowBusy"
                    @click="wfAction('forward', { body: workflowNote || undefined })"
                    >Forward</UButton
                  >
                  <UButton
                    size="md"
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-check-check"
                    class="justify-start"
                    :disabled="workflowBusy"
                    @click="wfAction('answer', { body: workflowNote || 'answer' })"
                    >Answer</UButton
                  >
                  <UButton
                    size="md"
                    color="success"
                    variant="outline"
                    icon="i-lucide-thumbs-up"
                    class="justify-start"
                    :disabled="workflowBusy"
                    @click="wfAction('approve', { body: workflowNote || undefined })"
                    >Approve</UButton
                  >
                  <UButton
                    size="md"
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-undo-2"
                    class="justify-start"
                    :disabled="workflowBusy"
                    @click="wfAction('request-changes', { body: workflowNote || 'needs changes' })"
                    >Request changes</UButton
                  >
                  <UButton
                    size="md"
                    color="error"
                    variant="outline"
                    icon="i-lucide-x-circle"
                    class="justify-start"
                    :disabled="workflowBusy"
                    @click="wfAction('reject', { body: workflowNote || undefined })"
                    >Reject</UButton
                  >
                  <UButton
                    size="md"
                    color="error"
                    variant="outline"
                    icon="i-lucide-ban"
                    class="justify-start"
                    :disabled="workflowBusy"
                    @click="wfAction('abandon', { body: workflowNote || undefined })"
                    >Abandon</UButton
                  >
                </div>
              </div>
            </div>
          </template>
        </USlideover>
      </div>
    </template>
  </UDashboardPanel>
</template>
