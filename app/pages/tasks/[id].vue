<script setup lang="ts">
import { useQuery, useQueryClient } from '@tanstack/vue-query';

import { CHANGE_RESOURCE } from '#shared/enums';
import { STATUS } from '#shared/status';
// Task detail — Paperclip-style layout: chat-like main content (description bubble,
// run turns, activity notes, composer at the bottom) + right sidebar with task info
// (status, assignee, reviewers, workflow actions). Mobile-first: single column,
// sidebar collapses into a sheet. The page owns the task row and the shared
// workflow-action state; thread and sidebar panels are self-loading components
// (TaskActivityThread, TaskDetailsFields, TaskReviewPanel, TaskRoutingPanels,
// TaskWorkflowActions) that share query keys with the app-wide SSE subscription.
import { nonNull } from '#shared/utils/non-null';
import type { TaskRow, TaskStatusRow } from '~/utils/orpc-types';

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
    workflowMessage.value = 'done';
  } catch (e) {
    const err = e as { data?: { json?: { message?: string }; message?: string }; message?: string };
    workflowMessage.value = err.data?.json?.message ?? err.data?.message ?? err.message ?? 'action failed';
  } finally {
    workflowBusy.value = false;
  }
}

/** while the task waits for an answer the composer's send IS the answer verb */
function sendComposer() {
  if (taskStatusCategory.value === 'waiting_answer') wfAction('answer', { body: workflowNote.value });
  else wfAction('note', { body: workflowNote.value });
}

const infoSheetOpen = ref(false);

const parentTask = computed(() =>
  task.value?.parentTaskId ? (tasks.value.find((t) => t.id === nonNull(task.value).parentTaskId) ?? null) : null,
);

const retryInMin = computed(() => {
  if (!task.value?.dispatchAfter) return 0;
  const ms = new Date(task.value.dispatchAfter).getTime() - Date.now();
  return ms > 0 ? Math.max(1, Math.round(ms / 60_000)) : 0;
});

const queryClient = useQueryClient();

useHead({ title: () => (task.value ? `${task.value.title} · Tandem` : 'Task · Tandem') });

onServerPrefetch(() => Promise.all([tasksLive.suspense(), statusesLive.suspense()]));
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
            <div
              class="mt-3 rounded-2xl border border-zinc-200 bg-white p-2.5 shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              <UTextarea
                v-model="workflowNote"
                :rows="1"
                autoresize
                :maxrows="6"
                variant="none"
                :placeholder="taskStatusCategory === 'waiting_answer' ? 'Write an answer…' : 'Write a note…'"
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
                <span v-else class="text-[11px] text-zinc-400 dark:text-zinc-500">
                  ⏎ {{ taskStatusCategory === 'waiting_answer' ? 'send answer' : 'post note' }} · ▶ dispatch agent
                </span>
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
                    <template #content>
                      <div class="px-3 py-1.5 text-xs">
                        {{
                          taskStatusCategory === 'waiting_answer'
                            ? 'Send answer — the agent resumes'
                            : 'Post note to the conversation'
                        }}
                      </div>
                    </template>
                    <UButton
                      size="lg"
                      color="primary"
                      :icon="taskStatusCategory === 'waiting_answer' ? 'i-lucide-reply' : 'i-lucide-arrow-up'"
                      :aria-label="taskStatusCategory === 'waiting_answer' ? 'Send answer' : 'Send note'"
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
            class="hidden w-full shrink-0 self-start rounded-xl border border-zinc-200/70 bg-zinc-50/70 p-3.5 lg:sticky lg:top-4 lg:mt-0 lg:block lg:max-h-[calc(100vh-8.5rem)] lg:w-72 lg:overflow-y-auto dark:border-zinc-800 dark:bg-zinc-900/60"
          >
            <div class="space-y-4">
              <TaskDetailsFields :task="task" />
              <TaskReviewPanel v-if="task.reviewerNames.length" :task-id="task.id" />
              <TaskRoutingPanels :task-id="task.id" :status-by-id="statusById" />
              <TaskWorkflowActions
                :busy="workflowBusy"
                :note="workflowNote"
                :status-category="taskStatusCategory"
                :assignee-kind="task.assigneeKind"
                @action="wfAction"
              />
            </div>
          </aside>
        </div>

        <!-- mobile info sheet: same sidebar content -->
        <USlideover v-if="task" v-model:open="infoSheetOpen" title="Task info" side="right" class="lg:hidden">
          <template #body>
            <div class="space-y-4">
              <TaskDetailsFields :task="task" />
              <TaskReviewPanel v-if="task.reviewerNames.length" :task-id="task.id" />
              <TaskRoutingPanels :task-id="task.id" :status-by-id="statusById" />
              <TaskWorkflowActions
                :busy="workflowBusy"
                :note="workflowNote"
                :status-category="taskStatusCategory"
                :assignee-kind="task.assigneeKind"
                @action="wfAction"
              />
            </div>
          </template>
        </USlideover>
      </div>
    </template>
  </UDashboardPanel>
</template>
