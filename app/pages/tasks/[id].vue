<script setup lang="ts">
// Task detail — Paperclip-style layout: chat-like main content (description bubble,
// run turns, activity notes, composer at the bottom) + right sidebar with task info
// (status, assignee, reviewers, workflow actions). Mobile-first: single column,
// sidebar collapses into a sheet. Streams stay persistent (one per feed, aborted
// on unmount) — see the stream law in AGENTS.md.
import { useQuery } from '@tanstack/vue-query'
import type { EmployeeRow, TaskRow } from '~/../shared/types'
import { buildThread, parseRunEnvelope, runOutputWithoutEnvelope } from '~/utils/task-thread'
import type { ThreadItem } from '~/utils/task-thread'

const route = useRoute()
const { $orpc, $client } = useNuxtApp()

const tasksLive = useQuery<TaskRow[]>(($orpc.tasks.live as any).liveOptions())

const tasks = computed(() => (unref(tasksLive.data) ?? []) as TaskRow[])

const task = computed(() => tasks.value.find(t => t.id === String(route.params.id)) ?? null)

const workflowNote = ref('')
const workflowBusy = ref(false)
const workflowMessage = ref('')
const workflowFeed = ref<Array<{ id: string, kind: string, body: string, authorName: string | null, createdAt: string }>>([])
const runFeed = ref<Array<{ id: string, status: string, output: string, exitCode: number | null, startedAt: string }>>([])
const infoSheetOpen = ref(false)
const retryInMin = computed(() => {
  if (!task.value?.dispatchAfter) return 0
  const ms = new Date(task.value.dispatchAfter).getTime() - Date.now()
  return ms > 0 ? Math.max(1, Math.round(ms / 60_000)) : 0
})

// ---- one ordered timeline from runs + activity + description -----------------
const thread = computed<ThreadItem[]>(() => buildThread({
  description: task.value?.description ?? null,
  createdAt: task.value?.createdAt ?? null,
  runs: runFeed.value.map(r => ({
    id: r.id,
    status: (r.status === 'running' ? 'running' : r.status === 'done' ? 'done' : 'failed') as 'running' | 'done' | 'failed',
    output: r.output,
    exitCode: r.exitCode,
    startedAt: r.startedAt,
    finishedAt: null,
  })),
  activity: workflowFeed.value.map(a => ({
    id: a.id,
    noteKind: a.kind,
    body: a.body,
    authorName: a.authorName,
    createdAt: a.createdAt,
  })),
}))

const scroller = ref<HTMLElement | null>(null)
watch(() => thread.value.length, async () => {
  await nextTick()
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight })
})

function envelopeOf(item: ThreadItem) {
  return item.kind === 'run' ? parseRunEnvelope(item.output) : null
}
function envelopeColor(kind: string) {
  return kind === 'question' ? 'warning' : kind === 'blocked' ? 'error' : 'success'
}

// ---- persistent streams (unchanged model) ------------------------------------
let runsAbort: AbortController | null = null
let feedAbort: AbortController | null = null

async function streamRuns(taskId: string, signal: AbortSignal) {
  try {
    for await (const rows of await $client.tasks.runs({ taskId }, { signal })) {
      runFeed.value = (rows ?? []) as unknown as typeof runFeed.value
    }
  }
  catch { /* aborted or transport error — stopped below */ }
}

async function streamFeed(taskId: string, signal: AbortSignal) {
  try {
    for await (const rows of await $client.tasks.activity({ taskId }, { signal })) {
      workflowFeed.value = (rows ?? []) as unknown as typeof workflowFeed.value
    }
  }
  catch { /* aborted or transport error — stopped below */ }
}

async function refreshFeed(taskId: string) {
  // one-shot fallback after a workflow action (stream picks up the change too, but the
  // immediate refresh keeps the UI snappy)
  try {
    for await (const rows of await $client.tasks.activity({ taskId })) {
      workflowFeed.value = (rows ?? []) as unknown as typeof workflowFeed.value
      return
    }
  }
  catch { /* best-effort */ }
}

async function wfAction(proc: string, extra: Record<string, unknown> = {}) {
  if (!task.value) return
  workflowBusy.value = true
  workflowMessage.value = ''
  try {
    await $fetch(`/rpc/tasks/${proc}`, { method: 'POST', body: { json: { taskId: task.value.id, ...extra } } })
    workflowNote.value = ''
    await refreshFeed(task.value.id)
    workflowMessage.value = 'done'
  }
  catch (e) {
    const err = e as { data?: { json?: { message?: string }, message?: string }, message?: string }
    workflowMessage.value = err.data?.json?.message ?? err.data?.message ?? err.message ?? 'action failed'
  }
  finally {
    workflowBusy.value = false
  }
}

function startStreams() {
  const id = task.value?.id
  if (!id) return
  runsAbort = new AbortController()
  feedAbort = new AbortController()
  void streamRuns(id, runsAbort.signal)
  void streamFeed(id, feedAbort.signal)
}

function stopStreams() {
  runsAbort?.abort()
  feedAbort?.abort()
  runsAbort = null
  feedAbort = null
}

onMounted(startStreams)
onBeforeUnmount(stopStreams)
watch(() => task.value?.id, (id, old) => {
  stopStreams()
  if (id && id !== old) startStreams()
})

useHead({ title: () => task.value ? `${task.value.title} · Tandem` : 'Task · Tandem' })
</script>

<template>
  <div>
    <div v-if="!task" class="py-16 text-center text-sm text-zinc-400">
      Task not found — it may have been deleted.
      <ULink to="/tasks" class="underline">Back to tasks</ULink>
    </div>

    <div v-else class="flex flex-col lg:h-[calc(100vh-7.5rem)] lg:flex-row lg:gap-6">
      <!-- ============ main: the chat ============ -->
      <section class="flex min-w-0 flex-1 flex-col">
        <!-- thread header (mobile shows the info trigger here) -->
        <div class="mb-3 flex items-start gap-2">
          <NuxtLink to="/tasks" class="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200">
            <UIcon name="i-lucide-arrow-left" class="size-4" />
          </NuxtLink>
          <div class="min-w-0 flex-1">
            <h1 class="truncate text-lg font-semibold text-zinc-900 dark:text-zinc-50">{{ task.title }}</h1>
            <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500">
              <UBadge :color="(task.status === 'done') ? 'success' : (task.status === 'todo') ? 'neutral' : 'warning'" variant="subtle" size="sm">{{ task.status }}</UBadge>
              <span v-if="task.assigneeName">{{ task.assigneeName }}<span v-if="task.assigneeKind === 'ai'" class="text-primary">(AI)</span></span>
            </div>
          </div>
          <UButton size="xs" variant="soft" icon="i-lucide-panel-right" aria-label="Task info" data-testid="task-info-trigger" class="lg:hidden" @click="infoSheetOpen = true" />
        </div>

        <!-- retry banner -->
        <div v-if="retryInMin > 0" class="mb-3 rounded-lg border border-warning/30 bg-warning/5 px-3.5 py-2.5 text-sm text-warning">
          <span class="font-medium">Retrying in ~{{ retryInMin }} min</span>
          <span class="text-warning/80"> — {{ task.failStreak }} consecutive failure{{ task.failStreak === 1 ? '' : 's' }}. The most recent run's error is in the thread.</span>
        </div>

        <!-- the thread -->
        <div ref="scroller" class="min-h-0 flex-1 space-y-3 overflow-y-auto rounded-lg border border-zinc-200 p-3 dark:border-zinc-800 lg:max-h-none">
          <p v-if="!thread.length" class="py-10 text-center text-xs text-zinc-400">No activity yet.</p>

          <template v-for="item in thread" :key="item.id">
            <!-- brief: the task description as the opening message -->
            <div v-if="item.kind === 'brief'" class="flex gap-2.5">
              <div class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-xs font-semibold text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">T</div>
              <div class="min-w-0 flex-1">
                <p class="mb-0.5 text-xs font-medium text-zinc-500">Task brief <span class="font-normal text-zinc-400">· {{ new Date(item.createdAt).toLocaleString() }}</span></p>
                <!-- description is tiptap markdown with @[Name](mention-id) tokens -->
                <div class="rounded-lg rounded-tl-sm bg-zinc-100 px-3 py-2 text-sm whitespace-pre-wrap text-zinc-700 dark:bg-zinc-800/70 dark:text-zinc-200">{{ item.body.replace(/@\[([^\]]*)\]\(mention-[^)]+\)/g, '@$1') }}</div>
              </div>
            </div>

            <!-- run: an agent turn -->
            <div v-else-if="item.kind === 'run'" class="flex gap-2.5">
              <div class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                <UIcon v-if="item.status === 'running'" name="i-lucide-loader-circle" class="size-4 animate-spin" />
                <UIcon v-else-if="item.status === 'done'" name="i-lucide-bot" class="size-4" />
                <UIcon v-else name="i-lucide-circle-x" class="size-4 text-error" />
              </div>
              <div class="min-w-0 flex-1">
                <p class="mb-0.5 flex items-center gap-1.5 text-xs font-medium text-zinc-500">
                  <span v-if="item.status === 'running'" class="inline-flex items-center gap-1 text-warning"><span class="inline-block size-1.5 animate-pulse rounded-full bg-warning" />working…</span>
                  <span v-else-if="item.status === 'done'">Agent · completed</span>
                  <span v-else class="text-error">Agent · failed<span v-if="item.exitCode !== null"> (exit {{ item.exitCode }})</span></span>
                  <span class="font-normal text-zinc-400">· {{ new Date(item.startedAt).toLocaleString() }}</span>
                </p>
                <!-- envelope first: the decision-model line rendered prominently -->
                <div v-if="envelopeOf(item)" :class="['rounded-lg rounded-tl-sm px-3 py-2 text-sm', envelopeOf(item)!.kind === 'question' ? 'border border-warning/40 bg-warning/10 text-warning-600 dark:text-warning' : envelopeOf(item)!.kind === 'blocked' ? 'border border-error/40 bg-error/10 text-error-600 dark:text-error' : 'bg-primary/10 text-zinc-800 dark:text-zinc-100']">
                  <span class="mr-1.5 inline-block rounded px-1 py-px text-[10px] font-semibold uppercase tracking-wide" :class="envelopeOf(item)!.kind === 'question' ? 'bg-warning/20' : envelopeOf(item)!.kind === 'blocked' ? 'bg-error/20' : 'bg-primary/20'">{{ envelopeOf(item)!.kind }}</span>{{ envelopeOf(item)!.text || '(empty)' }}
                </div>
                <!-- raw output (collapsed details keeps the thread chat-like) -->
                <details v-if="runOutputWithoutEnvelope(item.output)" class="group mt-1">
                  <summary class="cursor-pointer select-none text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">output</summary>
                  <pre class="mt-1 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md bg-zinc-950 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-zinc-200">{{ runOutputWithoutEnvelope(item.output) }}</pre>
                </details>
              </div>
            </div>

            <!-- note: slim system/human activity row -->
            <div v-else class="flex items-center gap-2 py-0.5 pl-1 text-xs text-zinc-400">
              <UIcon :name="item.noteKind === 'question' ? 'i-lucide-help-circle' : item.noteKind === 'answer' ? 'i-lucide-check-check' : item.noteKind === 'forward' ? 'i-lucide-corner-up-right' : item.noteKind === 'verdict' ? 'i-lucide-gavel' : 'i-lucide-info'" class="size-3.5 shrink-0" />
              <span class="shrink-0 font-medium">{{ item.authorName ?? 'system' }}</span>
              <span v-if="item.body" class="truncate">{{ item.body }}</span>
              <span class="ml-auto shrink-0">{{ new Date(item.createdAt).toLocaleTimeString() }}</span>
            </div>
          </template>
        </div>

        <!-- composer: workflow note + primary actions -->
        <div class="mt-3 rounded-lg border border-zinc-200 p-2.5 dark:border-zinc-800">
          <div class="flex gap-1.5">
            <UTextarea v-model="workflowNote" :rows="1" autoresize :maxrows="6" placeholder="Note / question / review comment…" class="min-w-0 flex-1" />
            <div class="flex flex-col gap-1.5">
              <UButton size="xs" color="primary" icon="i-lucide-play" :disabled="workflowBusy || !task.assigneeKind || task.assigneeKind !== 'ai'" @click="wfAction('dispatch')">Run</UButton>
              <UButton size="xs" variant="soft" icon="i-lucide-send" :disabled="workflowBusy" @click="wfAction('submit', { body: workflowNote || undefined })">Submit</UButton>
            </div>
          </div>
          <p v-if="workflowMessage" class="mt-1.5 text-xs" :class="workflowMessage === 'done' ? 'text-success' : 'text-error'">{{ workflowMessage }}</p>
        </div>
      </section>

      <!-- ============ sidebar: task info (desktop docked; mobile via sheet above) ============ -->
      <aside class="hidden w-full shrink-0 lg:mt-0 lg:block lg:w-72 lg:overflow-y-auto">
        <div class="space-y-4 rounded-lg border border-zinc-200 p-3.5 dark:border-zinc-800">
          <div>
            <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Details</p>
            <dl class="space-y-1.5 text-sm">
              <div class="flex items-center justify-between gap-3">
                <dt class="text-xs text-zinc-500">Status</dt>
                <dd><UBadge :color="(task.status === 'done') ? 'success' : (task.status === 'todo') ? 'neutral' : 'warning'" variant="subtle" size="sm">{{ task.status }}</UBadge></dd>
              </div>
              <div class="flex items-center justify-between gap-3">
                <dt class="text-xs text-zinc-500">Assignee</dt>
                <dd class="truncate text-right text-zinc-800 dark:text-zinc-200">{{ task.assigneeName ?? '—' }}<span v-if="task.assigneeKind === 'ai'" class="text-primary"> (AI)</span></dd>
              </div>
              <div class="flex items-center justify-between gap-3">
                <dt class="text-xs text-zinc-500">Owner</dt>
                <dd class="truncate text-right text-zinc-800 dark:text-zinc-200">{{ task.ownerName ?? '—' }}</dd>
              </div>
              <div class="flex items-center justify-between gap-3">
                <dt class="text-xs text-zinc-500">Project</dt>
                <dd class="truncate text-right text-zinc-800 dark:text-zinc-200">{{ task.projectName ?? '—' }}</dd>
              </div>
            </dl>
          </div>

          <div v-if="task.reviewerNames.length">
            <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Review</p>
            <ul class="space-y-1 text-sm">
              <li v-for="name in task.reviewerNames" :key="name" class="flex items-center gap-1.5">
                <UIcon :name="task.reviewApprovals.includes(task.reviewers[task.reviewerNames.indexOf(name)] ?? '') ? 'i-lucide-badge-check' : 'i-lucide-user'" class="size-3.5 shrink-0" :class="task.reviewApprovals.includes(task.reviewers[task.reviewerNames.indexOf(name)] ?? '') ? 'text-success' : 'text-zinc-400'" />
                <span class="truncate text-zinc-800 dark:text-zinc-200">{{ name }}</span>
              </li>
            </ul>
          </div>

          <div>
            <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Workflow</p>
            <div class="flex flex-wrap gap-1.5">
              <UButton size="xs" color="warning" variant="soft" icon="i-lucide-help-circle" :disabled="workflowBusy" @click="wfAction('ask', { body: workflowNote || 'question' })">Ask</UButton>
              <UButton size="xs" color="warning" variant="soft" icon="i-lucide-corner-up-right" :disabled="workflowBusy" @click="wfAction('forward', { body: workflowNote || undefined })">Forward</UButton>
              <UButton size="xs" color="warning" variant="soft" icon="i-lucide-check-check" :disabled="workflowBusy" @click="wfAction('answer', { body: workflowNote || 'answer' })">Answer</UButton>
              <UButton size="xs" color="success" variant="soft" icon="i-lucide-thumbs-up" :disabled="workflowBusy" @click="wfAction('approve', { body: workflowNote || undefined })">Approve</UButton>
              <UButton size="xs" color="success" variant="soft" icon="i-lucide-undo-2" :disabled="workflowBusy" @click="wfAction('request-changes', { body: workflowNote || 'needs changes' })">Request changes</UButton>
              <UButton size="xs" color="error" variant="soft" icon="i-lucide-ban" :disabled="workflowBusy" @click="wfAction('abandon', { body: workflowNote || undefined })">Abandon</UButton>
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
            <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Details</p>
            <dl class="space-y-1.5 text-sm">
              <div class="flex items-center justify-between gap-3">
                <dt class="text-xs text-zinc-500">Status</dt>
                <dd><UBadge :color="(task.status === 'done') ? 'success' : (task.status === 'todo') ? 'neutral' : 'warning'" variant="subtle" size="sm">{{ task.status }}</UBadge></dd>
              </div>
              <div class="flex items-center justify-between gap-3">
                <dt class="text-xs text-zinc-500">Assignee</dt>
                <dd class="truncate text-right text-zinc-800 dark:text-zinc-200">{{ task.assigneeName ?? '—' }}<span v-if="task.assigneeKind === 'ai'" class="text-primary"> (AI)</span></dd>
              </div>
              <div class="flex items-center justify-between gap-3">
                <dt class="text-xs text-zinc-500">Owner</dt>
                <dd class="truncate text-right text-zinc-800 dark:text-zinc-200">{{ task.ownerName ?? '—' }}</dd>
              </div>
              <div class="flex items-center justify-between gap-3">
                <dt class="text-xs text-zinc-500">Project</dt>
                <dd class="truncate text-right text-zinc-800 dark:text-zinc-200">{{ task.projectName ?? '—' }}</dd>
              </div>
            </dl>
          </div>
          <div v-if="task.reviewerNames.length">
            <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Review</p>
            <ul class="space-y-1 text-sm">
              <li v-for="name in task.reviewerNames" :key="name" class="flex items-center gap-1.5">
                <UIcon name="i-lucide-user" class="size-3.5 text-zinc-400" />
                <span class="truncate text-zinc-800 dark:text-zinc-200">{{ name }}</span>
              </li>
            </ul>
          </div>
          <div>
            <p class="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Workflow</p>
            <div class="flex flex-wrap gap-1.5">
              <UButton size="xs" color="warning" variant="soft" icon="i-lucide-help-circle" :disabled="workflowBusy" @click="wfAction('ask', { body: workflowNote || 'question' })">Ask</UButton>
              <UButton size="xs" color="warning" variant="soft" icon="i-lucide-corner-up-right" :disabled="workflowBusy" @click="wfAction('forward', { body: workflowNote || undefined })">Forward</UButton>
              <UButton size="xs" color="warning" variant="soft" icon="i-lucide-check-check" :disabled="workflowBusy" @click="wfAction('answer', { body: workflowNote || 'answer' })">Answer</UButton>
              <UButton size="xs" color="success" variant="soft" icon="i-lucide-thumbs-up" :disabled="workflowBusy" @click="wfAction('approve', { body: workflowNote || undefined })">Approve</UButton>
              <UButton size="xs" color="success" variant="soft" icon="i-lucide-undo-2" :disabled="workflowBusy" @click="wfAction('request-changes', { body: workflowNote || 'needs changes' })">Request changes</UButton>
              <UButton size="xs" color="error" variant="soft" icon="i-lucide-ban" :disabled="workflowBusy" @click="wfAction('abandon', { body: workflowNote || undefined })">Abandon</UButton>
            </div>
          </div>
        </div>
      </template>
    </USlideover>
  </div>
</template>
