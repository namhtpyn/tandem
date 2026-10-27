<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query';

import { CHANGE_RESOURCE } from '#shared/enums';
// Task detail — Paperclip-style layout: chat-like main content (description bubble,
// run turns, activity notes, composer at the bottom) + right sidebar with task info
// (status, assignee, reviewers, workflow actions). Mobile-first: single column,
// sidebar collapses into a sheet. The page owns the task row and the shared
// workflow-action state; thread and sidebar panels are self-loading components
// (TaskActivityThread, TaskDetailsFields, TaskReviewPanel, TaskRoutingPanels,
// TaskWorkflowActions) that share query keys with the app-wide SSE subscription.
import { nonNull } from '#shared/utils/non-null';
import type { TaskRow, TaskStatusRow } from '~/utils/orpc-types';
import { categoryColor } from '~/utils/ui-labels';

const route = useRoute();
const { $orpc, $client } = useNuxtApp();
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

// review verdicts are an explicit-reviewer surface — nobody else sees the box
const isReviewer = computed(() => !!task.value?.reviewerNames.includes(session.value?.user.name ?? ''));

const workflowNote = ref('');
const workflowBusy = ref(false);
const workflowMessage = ref('');
const workflowOk = ref(true); // message tone: success copy vs failure copy

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
  if (!task.value) return;
  workflowBusy.value = true;
  workflowMessage.value = '';
  try {
    const input = { taskId: task.value.id, ...extra };
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
    // TASKS refresh keeps the page's task row (and the drawer's snapshot) ahead
    // of the SSE round-trip — no double-submit window when the verb moves status
    void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASKS] });
    void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASK_ACTIVITY, task.value.id] });
    void queryClient.invalidateQueries({ queryKey: ['taskReviews', task.value.id] });
    workflowMessage.value = WF_COPY[action].ok;
    workflowOk.value = true;
  } catch (e) {
    const err = e as { data?: { json?: { message?: string }; message?: string }; message?: string };
    workflowMessage.value = err.data?.json?.message ?? err.data?.message ?? err.message ?? WF_COPY[action].fail;
    workflowOk.value = false;
  } finally {
    workflowBusy.value = false;
  }
}

/** while the task waits for an answer the composer's send IS the answer verb */
function sendComposer() {
  if (taskStatusCategory.value === 'waiting_answer') wfAction('answer', { body: workflowNote.value });
  else wfAction('note', { body: workflowNote.value });
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
const agentRunning = computed(() =>
  ((unref(runsLive.data) ?? []) as Array<{ status?: string }>).some((r) => r.status === 'running'),
);

const infoSheetOpen = ref(false);
const subtaskEditorOpen = ref(false);

const parentTask = computed(() =>
  task.value?.parentTaskId ? (tasks.value.find((t) => t.id === nonNull(task.value).parentTaskId) ?? null) : null,
);

const retryInMin = computed(() => {
  if (!task.value?.dispatchAfter) return 0;
  const ms = new Date(task.value.dispatchAfter).getTime() - Date.now();
  return ms > 0 ? Math.max(1, Math.round(ms / 60_000)) : 0;
});

const queryClient = useQueryClient();

// bare title — app.vue's titleTemplate appends '- Tandem'; extra separators render 'X · Tandem - Tandem'
useHead({ title: () => (task.value ? task.value.title : 'Task') });

onServerPrefetch(() => Promise.all([tasksLive.suspense(), statusesLive.suspense()]));
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #body>
      <div class="p-3 lg:p-6">
        <div v-if="!task" class="text-dimmed py-16 text-center text-sm">
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
                aria-label="Back to tasks"
                class="text-dimmed hover:bg-elevated hover:text-highlighted mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md"
              >
                <UIcon name="i-lucide-arrow-left" class="size-4" />
              </NuxtLink>
              <div class="min-w-0 flex-1">
                <h1 class="text-highlighted truncate text-lg font-semibold">{{ task.title }}</h1>
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
            <UAlert
              v-if="retryInMin > 0"
              class="mb-3"
              color="warning"
              variant="subtle"
              icon="i-lucide-refresh-cw"
              :title="`Retrying in ~${retryInMin} min`"
              :description="`${task.failStreak} consecutive failure${task.failStreak === 1 ? '' : 's'}. The most recent run's error is in the thread.`"
            />

            <!-- the thread (TaskActivityThread) -->
            <TaskActivityThread :task="task" />

            <!-- GitHub-style review verdicts: own input, reviewers only, in review only -->
            <TaskReviewBox
              v-if="taskStatusCategory === 'in_review' && isReviewer"
              class="mb-3"
              :busy="workflowBusy"
              @verdict="
                (action: 'approve' | 'requestChanges' | 'reject', body?: string) =>
                  wfAction(action, { body: body || undefined })
              "
            />

            <!-- composer: workflow note + primary actions -->
            <div class="border-default bg-default mt-3 rounded-2xl border p-2.5 shadow-sm">
              <UTextarea
                v-model="workflowNote"
                :rows="1"
                autoresize
                :maxrows="6"
                variant="none"
                :placeholder="taskStatusCategory === 'waiting_answer' ? 'Write an answer…' : 'Write a note…'"
                class="w-full"
                :ui="{ base: 'px-1 py-1 text-sm placeholder:text-dimmed' }"
              />
              <div class="mt-1.5 flex items-center justify-between">
                <p
                  v-if="workflowMessage"
                  class="text-xs"
                  :class="workflowOk ? 'text-success' : 'text-error'"
                  role="status"
                >
                  {{ workflowMessage }}
                </p>
                <span v-else class="text-dimmed text-[11px]">
                  ⏎ {{ agentRunning ? 'Send — steers the running agent' : 'Send — dispatches the agent' }}
                </span>
                <div class="ml-auto flex items-center gap-1.5">
                  <UPopover mode="hover" enable-touch>
                    <template #content>
                      <div class="px-3 py-1.5 text-xs">
                        {{
                          agentRunning ? 'Steer — the running agent gets this message' : 'Send — dispatches the agent'
                        }}
                      </div>
                    </template>
                    <UButton
                      size="lg"
                      color="primary"
                      :icon="agentRunning ? 'i-lucide-reply' : 'i-lucide-arrow-up'"
                      :aria-label="agentRunning ? 'Steer agent' : 'Send and dispatch'"
                      class="size-10"
                      :disabled="workflowBusy || !workflowNote.trim()"
                      @click="sendComposer()"
                  /></UPopover>
                </div>
              </div>
            </div>
          </section>

          <!-- ============ sidebar: task info (desktop docked; mobile via sheet above) ============ -->
          <aside
            class="border-default bg-elevated/50 hidden w-full shrink-0 self-start rounded-xl border p-3.5 lg:sticky lg:top-4 lg:mt-0 lg:block lg:max-h-[calc(100vh-8.5rem)] lg:w-72 lg:overflow-y-auto"
          >
            <div class="space-y-4">
              <TaskDetailsFields :task="task" :run-locked="agentRunning" />
              <TaskReviewPanel v-if="task.reviewerNames.length" :task-id="task.id" />
              <TaskRoutingPanels
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
        <TaskDetailsFields :task="task" :run-locked="agentRunning" />
        <TaskReviewPanel v-if="task.reviewerNames.length" :task-id="task.id" />
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
