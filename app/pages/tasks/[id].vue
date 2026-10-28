<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query';

import { CHANGE_RESOURCE, RUN_STATUS } from '#shared/enums';
import { nonNull } from '#shared/utils/non-null';
// Task detail — Paperclip-style layout: chat-like main content (description bubble,
// run turns, activity notes, composer at the bottom) + right sidebar with task info
// (status, assignee, reviewers, workflow actions). Mobile-first: single column,
// sidebar collapses into a sheet. The page owns the task row and the shared
// workflow-action state; thread and sidebar panels are self-loading components
// (TaskActivityThread, TaskDetailsFields, TaskReviewPanel, TaskRoutingPanels,
// TaskWorkflowActions) that share query keys with the app-wide SSE subscription.
import { composerReady, useWorkflowActions } from '~/composables/useWorkflowActions';
import type { TaskRow, TaskRunRow, TaskStatusRow } from '~/utils/orpc-types';
import { categoryColor, composerPlaceholder } from '~/utils/ui-labels';

const route = useRoute();
const { $orpc } = useNuxtApp();
const session = useAppSession();

const tasksLive = useQuery($orpc.tasks.list.queryOptions({ queryKey: [CHANGE_RESOURCE.TASKS] }));

const tasks = computed(() => (unref(tasksLive.data) ?? []) as TaskRow[]);

const task = computed(() => tasks.value.find((t) => t.id === String(route.params.id)) ?? null);

// status badge in the thread header (the selects live in TaskDetailsFields)
const statusesLive = useQuery($orpc.statuses.list.queryOptions({ queryKey: [CHANGE_RESOURCE.STATUSES] }));
const statuses = computed(() => unref(statusesLive.data) ?? []);
const statusById = computed(() => new Map(statuses.value.map((x) => [x.id, x])));

// category (not the seeded uuid) decides the workflow gates: custom statuses in
// the working/waiting_answer/in_review categories behave like the seeded ones
const taskStatusCategory = computed<TaskStatusRow['category'] | null>(() =>
  task.value ? (statusById.value.get(task.value.status)?.category ?? null) : null,
);

// review verdicts are an explicit-reviewer surface — nobody else sees the box.
// Gate on ids, never names: a name is display data and two employees can share it.
const isReviewer = computed(() => !!session.value && !!task.value?.reviewers.includes(session.value.user.id));

// the workflow ladder (copy + invalidation) is shared with the list drawer
const { workflowNote, workflowBusy, workflowMessage, workflowOk, workflowFailed, wfAction, sendNote, resetWorkflow } =
  useWorkflowActions(() => task.value?.id ?? null);

/** composer verb: a null category (statuses loading/failed) must not read as 'note' */
const composerSendReady = computed(() => composerReady(taskStatusCategory.value, workflowNote.value));
function sendComposer() {
  if (!composerSendReady.value) return;
  void sendNote(taskStatusCategory.value === 'waiting_answer');
}

/** a live run turns the composer into a steer box; stopped = send dispatches */
const runsLive = useQuery({
  ...$orpc.tasks.runsList.queryOptions({
    queryKey: [CHANGE_RESOURCE.RUNS, String(route.params.id)],
    input: { taskId: String(route.params.id) },
  }),
  // client-only: the SSR prefetch of this query blanks the whole page render
  enabled: import.meta.client,
});
const runs = computed<TaskRunRow[]>(() => (unref(runsLive.data) ?? []) as TaskRunRow[]);
/** the wire token is SCREAMING (RUN_STATUS.RUNNING) — a lowercase compare never matched */
const agentRunning = computed(() => runs.value.some((r) => r.status === RUN_STATUS.RUNNING));
/** a pending run list means the lock state is UNKNOWN, not idle: keep the fields
 * locked behind a neutral hint instead of letting an edit race the settle */
const runsSettled = computed(() => runsLive.isSuccess.value || runsLive.isError.value);
const runLocked = computed(() => !runsSettled.value || agentRunning.value);

const infoSheetOpen = ref(false);
const subtaskEditorOpen = ref(false);

// task→task navigation REUSES this page instance: page-local workflow/review
// state belongs to the task it was typed for. Reset it here; the thread,
// review box and routing panels are also re-keyed by task id in the template so
// an armed reject or a half-typed note can never follow the navigation.
watch(
  () => route.params.id,
  () => {
    resetWorkflow();
    infoSheetOpen.value = false;
    subtaskEditorOpen.value = false;
  },
);

const parentTask = computed(() =>
  task.value?.parentTaskId ? (tasks.value.find((t) => t.id === nonNull(task.value).parentTaskId) ?? null) : null,
);

const retryInMin = computed(() => {
  if (!task.value?.dispatchAfter) return 0;
  const ms = new Date(task.value.dispatchAfter).getTime() - Date.now();
  return ms > 0 ? Math.max(1, Math.round(ms / 60_000)) : 0;
});

const queryClient = useQueryClient();

// the list page warms a different query key — on client nav this query is
// pending, and the not-found copy must NOT flash while it resolves
const tasksPending = computed(() => tasksLive.isPending.value);
// a settled query error is NOT 'task not found' — say so and offer a retry
const tasksError = computed(() => tasksLive.isError.value);

// bare title — app.vue's titleTemplate appends '- Tandem'; extra separators render 'X · Tandem - Tandem'
useHead({ title: () => (task.value ? task.value.title : 'Task') });

onServerPrefetch(() => Promise.all([tasksLive.suspense(), statusesLive.suspense()]));
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #body>
      <div class="task-gutter p-4 sm:p-6 lg:p-8">
        <!-- pending: client nav never warms this key — hold a skeleton, never the
             not-found copy, until the query settles -->
        <div v-if="tasksPending" class="space-y-4" aria-busy="true">
          <div class="flex items-start gap-2">
            <USkeleton class="mt-0.5 size-8 shrink-0 rounded-md" />
            <div class="flex-1 space-y-2">
              <USkeleton class="h-6 w-2/3" />
              <USkeleton class="h-4 w-1/3" />
            </div>
          </div>
          <USkeleton class="h-72 w-full rounded-lg" />
        </div>

        <div v-else-if="tasksError" role="alert" class="flex flex-col items-center gap-3 py-16 text-center">
          <p class="text-error text-sm">Couldn't load the task — try again</p>
          <UButton size="sm" variant="soft" icon="i-lucide-refresh-cw" label="Retry" @click="tasksLive.refetch()" />
        </div>

        <div v-else-if="!task" class="text-dimmed py-16 text-center text-sm">
          Task not found — it may have been deleted.
          <ULink to="/tasks" class="underline">Back to tasks</ULink>
        </div>

        <div v-else class="flex flex-col lg:h-(--task-h) lg:flex-row lg:gap-6">
          <!-- ============ main: the chat ============ -->
          <section class="flex min-w-0 flex-1 flex-col">
            <!-- thread header (mobile shows the info trigger here) -->
            <div class="mb-3 flex items-start gap-2">
              <NuxtLink
                to="/tasks"
                aria-label="Back to tasks"
                class="text-dimmed hover:bg-elevated hover:text-highlighted focus-visible:bg-elevated focus-visible:text-highlighted focus-visible:ring-primary mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:outline-none"
              >
                <UIcon name="i-lucide-arrow-left" class="size-4" />
              </NuxtLink>
              <div class="min-w-0 flex-1">
                <h1 class="text-highlighted truncate text-lg font-semibold" :title="task.title">{{ task.title }}</h1>
                <div class="text-muted flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                  <UBadge
                    v-if="statusById.get(task.status)?.name"
                    :color="categoryColor(statusById.get(task.status)?.category)"
                    variant="subtle"
                    size="sm"
                    >{{ statusById.get(task.status)?.name }}</UBadge
                  >
                  <NuxtLink
                    v-if="parentTask"
                    :to="`/tasks/${parentTask.id}`"
                    class="text-primary inline-flex items-center gap-1 hover:underline"
                    data-testid="parent-task-link"
                  >
                    <UIcon name="i-lucide-corner-left-up" class="size-3" /> Part of: {{ parentTask.title }}
                  </NuxtLink>
                  <!-- assignee lives HERE as the header badge (one display per
                   surface: Details owns the editable select, Assignment
                   history owns the trail — a third plain-text line read as a bug).
                   Neutral fill — the bot icon carries the AI kind; color stays CTA-only -->
                  <UBadge
                    v-if="task.assigneeName"
                    color="neutral"
                    variant="subtle"
                    size="sm"
                    :icon="task.assigneeKind === 'ai' ? 'i-lucide-bot' : 'i-lucide-user-round'"
                    >{{ task.assigneeName }}</UBadge
                  >
                </div>
              </div>
              <UButton
                size="xs"
                class="min-h-8 lg:hidden"
                variant="soft"
                icon="i-lucide-panel-right"
                aria-label="Task info"
                data-testid="task-info-trigger"
                @click="infoSheetOpen = true"
              />
            </div>

            <!-- retry banner -->
            <UAlert
              v-if="retryInMin > 0"
              class="mb-3"
              color="warning"
              variant="subtle"
              icon="i-lucide-refresh-cw"
              :title="`Retrying in ~${retryInMin} min`"
              :description="`${task.failStreak} consecutive failure${task.failStreak === 1 ? '' : 's'}. The most recent run's error is in the thread.`"
            />

            <!-- ONE card: the thread and the composer share a single border.
                 Shrink-to-fit when short (max-h, no fixed fill — a two-message
                 thread must not center itself in a viewport-tall void); the
                 composer stays pinned at its bottom. -->
            <div
              class="border-default bg-default flex min-h-0 flex-col rounded-lg border shadow-sm lg:max-h-[calc(var(--task-h)-4.5rem)]"
            >
              <!-- the thread (TaskActivityThread) -->
              <TaskActivityThread :key="task.id" :task="task" />

              <!-- composer: workflow note + primary actions -->
              <div class="border-default border-t p-2.5">
                <UTextarea
                  v-model="workflowNote"
                  :rows="1"
                  autoresize
                  :maxrows="6"
                  variant="none"
                  :disabled="workflowBusy"
                  :placeholder="composerPlaceholder(taskStatusCategory === 'waiting_answer')"
                  aria-label="Task note"
                  class="w-full"
                  :ui="{ base: 'px-1 py-1 text-sm placeholder:text-dimmed' }"
                />
                <div class="mt-1.5 flex items-center justify-between gap-2">
                  <p
                    v-if="workflowMessage"
                    class="text-xs"
                    :class="workflowOk ? 'text-success' : 'text-error'"
                    :role="workflowOk ? 'status' : 'alert'"
                  >
                    {{ workflowMessage }}
                  </p>
                  <!-- the ONE send hint — the send button carries no duplicate hover popover.
                       Terminal tasks never re-dispatch (server note verb), so the hint
                       must not promise it. -->
                  <span v-else class="text-muted shrink-0 text-xs">
                    {{
                      agentRunning
                        ? 'Sends a steering note to the running agent'
                        : taskStatusCategory === 'done' || taskStatusCategory === 'cancelled'
                          ? 'Adds the note to the thread'
                          : 'Sends the note and dispatches the agent'
                    }}
                  </span>
                  <UButton
                    size="lg"
                    color="primary"
                    :icon="agentRunning ? 'i-lucide-reply' : 'i-lucide-arrow-up'"
                    :aria-label="agentRunning ? 'Steer agent' : 'Send and dispatch'"
                    class="size-10 shrink-0"
                    :disabled="workflowBusy || !composerSendReady"
                    @click="sendComposer()"
                  />
                </div>
              </div>
            </div>

            <!-- GitHub-style review verdicts: own card, reviewers only, in review only -->
            <TaskReviewBox
              v-if="taskStatusCategory === 'in_review' && isReviewer"
              :key="task.id"
              class="mt-3"
              :busy="workflowBusy"
              :failed="workflowFailed"
              @verdict="
                (action: 'approve' | 'requestChanges' | 'reject', body?: string) =>
                  wfAction(action, { body: body || undefined })
              "
            />
          </section>

          <!-- ============ sidebar: task info (desktop docked; mobile via sheet above) ============ -->
          <aside
            class="border-default bg-elevated/50 hidden w-full shrink-0 self-start rounded-xl border p-3.5 lg:sticky lg:top-4 lg:mt-0 lg:block lg:max-h-[calc(var(--task-h)-1rem)] lg:w-72 lg:overflow-y-auto"
          >
            <div class="space-y-4">
              <TaskDetailsFields :key="task.id" :task="task" :run-locked="runLocked" :run-pending="!runsSettled" />
              <TaskReviewPanel v-if="task.reviewerNames.length" :key="task.id" :task-id="task.id" />
              <TaskRoutingPanels
                :key="task.id"
                :task-id="task.id"
                :status-by-id="statusById"
                @add-subtask="subtaskEditorOpen = true"
              />
            </div>
          </aside>
        </div>
      </div>
    </template>
  </UDashboardPanel>

  <!-- mobile info sheet: same sidebar content (OUTSIDE the panel — the panel
       renders only named slots, so a loose child blanks the body on client nav) -->
  <USlideover v-if="task" v-model:open="infoSheetOpen" title="Task info" side="right" class="lg:hidden">
    <template #body>
      <div class="space-y-4">
        <TaskDetailsFields :key="task.id" :task="task" :run-locked="runLocked" :run-pending="!runsSettled" />
        <TaskReviewPanel v-if="task.reviewerNames.length" :key="task.id" :task-id="task.id" />
        <TaskRoutingPanels :task-id="task.id" :status-by-id="statusById" @add-subtask="subtaskEditorOpen = true" />
      </div>
    </template>
  </USlideover>

  <TaskEditorModal
    v-if="subtaskEditorOpen"
    v-model:open="subtaskEditorOpen"
    :task="null"
    :parent-task-id="task?.id ?? null"
    @saved="queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASKS] })"
  />
</template>

<style scoped>
/* ONE viewport constant for the chat row height and the docked aside's max
   height — the two calcs used to drift as separate magic numbers */
.task-gutter {
  --task-h: calc(100vh - 7.5rem);
}
</style>
