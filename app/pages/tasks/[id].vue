<script setup lang="ts">
// Task info page: full detail — description, meta, workflow actions, agent runs
// (with error output), and the activity feed. Reached by clicking a task row.
import { useQuery } from '@tanstack/vue-query'
import type { EmployeeRow, TaskRow } from '~/../shared/types'

const route = useRoute()
const { $orpc } = useNuxtApp()

const tasksLive = useQuery<TaskRow[]>(($orpc.tasks.live as any).liveOptions())
const employeesLive = useQuery<EmployeeRow[]>(($orpc.employees.live as any).liveOptions())

const tasks = computed(() => (unref(tasksLive.data) ?? []) as TaskRow[])
const employees = computed(() => (unref(employeesLive.data) ?? []) as EmployeeRow[])
const nameById = computed(() => new Map(employees.value.map(e => [e.id, e.name])))

const task = computed(() => tasks.value.find(t => t.id === String(route.params.id)) ?? null)

const workflowNote = ref('')
const workflowBusy = ref(false)
const workflowMessage = ref('')
const workflowFeed = ref<Array<{ id: string, kind: string, body: string, authorName: string | null, createdAt: string }>>([])
const runFeed = ref<Array<{ id: string, status: string, output: string, exitCode: number | null, startedAt: string }>>([])
let pollTimer: ReturnType<typeof setInterval> | null = null

const retryInMin = computed(() => {
  if (!task.value?.dispatchAfter) return 0
  const ms = new Date(task.value.dispatchAfter).getTime() - Date.now()
  return ms > 0 ? Math.max(1, Math.round(ms / 60_000)) : 0
})

async function refreshFeed(taskId: string) {
  // activity is a live procedure (SSE): read the FIRST data event, then abort
  try {
    const ac = new AbortController()
    const res = await fetch(`/rpc/tasks/activity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { taskId } }),
      signal: ac.signal,
    })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const { value } = await reader.read()
      buffer += decoder.decode(value!, { stream: true })
      const m = /data:(.+)/.exec(buffer)
      if (m) {
        ac.abort()
        const payload = JSON.parse(m[1]!.trim())
        workflowFeed.value = (payload?.json ?? payload ?? []) as typeof workflowFeed.value
        return
      }
    }
    ac.abort()
  }
  catch { /* stream aborted or closed */ }
}

async function refreshRuns(taskId: string) {
  // runs is a live procedure (SSE): read the FIRST data event, then abort
  const ac = new AbortController()
  try {
    const res = await fetch('/rpc/tasks/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { taskId } }),
      signal: ac.signal,
    })
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      const { value } = await reader.read()
      buffer += decoder.decode(value!, { stream: true })
      const m = /data:(.+)/.exec(buffer)
      if (m) {
        ac.abort()
        const payload = JSON.parse(m[1]!.trim())
        runFeed.value = (payload?.json ?? payload ?? []) as typeof runFeed.value
        return
      }
    }
    ac.abort()
  }
  catch { /* stream aborted or closed */ }
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

function startPolling() {
  const id = task.value?.id
  if (!id) return
  void refreshRuns(id)
  void refreshFeed(id)
  pollTimer = setInterval(() => {
    const current = task.value?.id
    if (!current) { if (pollTimer) clearInterval(pollTimer); return }
    void refreshRuns(current)
    void refreshFeed(current)
  }, 2000)
}

onMounted(startPolling)
onBeforeUnmount(() => { if (pollTimer) clearInterval(pollTimer) })
watch(() => task.value?.id, (id, old) => {
  if (pollTimer) clearInterval(pollTimer)
  if (id && id !== old) startPolling()
})

useHead({ title: () => task.value ? `${task.value.title} · Tandem` : 'Task · Tandem' })
</script>

<template>
  <div>
    <NuxtLink to="/tasks" class="mb-4 inline-flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200">
      <UIcon name="i-lucide-arrow-left" class="size-4" /> Tasks
    </NuxtLink>

    <div v-if="!task" class="py-16 text-center text-sm text-zinc-400">
      Task not found — it may have been deleted.
      <ULink to="/tasks" class="underline">Back to tasks</ULink>
    </div>

    <div v-else class="mx-auto max-w-3xl space-y-5">
      <!-- header -->
      <div>
        <h1 class="text-xl font-semibold text-zinc-900 dark:text-zinc-50">{{ task.title }}</h1>
        <div class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
          <UBadge :color="(task.status === 'done') ? 'success' : (task.status === 'todo') ? 'neutral' : 'warning'" variant="subtle" size="sm">{{ task.status }}</UBadge>
          <span v-if="task.assigneeName" class="inline-flex items-center gap-1">
            <UIcon name="i-lucide-user-check" class="size-3.5" />{{ task.assigneeName }}<span v-if="task.assigneeKind === 'ai'" class="text-primary">(AI)</span>
          </span>
          <span v-if="task.ownerName" class="inline-flex items-center gap-1"><UIcon name="i-lucide-route" class="size-3.5" />Owner: {{ task.ownerName }}</span>
          <span v-if="task.reviewerNames.length" class="inline-flex items-center gap-1"><UIcon name="i-lucide-users" class="size-3.5" />Reviewers: {{ task.reviewerNames.join(', ') }}</span>
        </div>
        <p v-if="task.description" class="mt-3 whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-300">{{ task.description }}</p>
      </div>

      <!-- retry banner -->
      <div v-if="retryInMin > 0" class="rounded-lg border border-warning/30 bg-warning/5 px-3.5 py-2.5 text-sm text-warning">
        <span class="font-medium">Retrying in ~{{ retryInMin }} min</span>
        <span class="text-warning/80"> — {{ task.failStreak }} consecutive failure{{ task.failStreak === 1 ? '' : 's' }}. The most recent run's error is below.</span>
      </div>

      <!-- workflow actions -->
      <div class="rounded-lg border border-zinc-200 p-3.5 dark:border-zinc-800">
        <p class="mb-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">Workflow</p>
        <div class="flex flex-wrap gap-1.5">
          <UButton size="xs" color="warning" variant="soft" icon="i-lucide-help-circle" :disabled="workflowBusy" @click="wfAction('ask', { body: workflowNote || 'question' })">Ask</UButton>
          <UButton size="xs" color="warning" variant="soft" icon="i-lucide-corner-up-right" :disabled="workflowBusy" @click="wfAction('forward', { body: workflowNote || undefined })">Forward</UButton>
          <UButton size="xs" color="warning" variant="soft" icon="i-lucide-check-check" :disabled="workflowBusy" @click="wfAction('answer', { body: workflowNote || 'answer' })">Answer</UButton>
          <UButton size="xs" color="primary" variant="soft" icon="i-lucide-send" :disabled="workflowBusy" @click="wfAction('submit', { body: workflowNote || undefined })">Submit</UButton>
          <UButton size="xs" color="success" variant="soft" icon="i-lucide-thumbs-up" :disabled="workflowBusy" @click="wfAction('approve', { body: workflowNote || undefined })">Approve</UButton>
          <UButton size="xs" color="success" variant="soft" icon="i-lucide-undo-2" :disabled="workflowBusy" @click="wfAction('request-changes', { body: workflowNote || 'needs changes' })">Request changes</UButton>
          <UButton size="xs" color="error" variant="soft" icon="i-lucide-ban" :disabled="workflowBusy" @click="wfAction('abandon', { body: workflowNote || undefined })">Abandon</UButton>
          <UButton size="xs" variant="soft" icon="i-lucide-play" :disabled="workflowBusy || !task.assigneeKind || task.assigneeKind !== 'ai'" @click="wfAction('dispatch')">Dispatch now</UButton>
        </div>
        <UTextarea v-model="workflowNote" :rows="3" placeholder="Question / answer / review note" class="mt-2.5 w-full" />
        <p v-if="workflowMessage" class="mt-1.5 text-xs" :class="workflowMessage === 'done' ? 'text-success' : 'text-error'">{{ workflowMessage }}</p>
      </div>

      <!-- agent runs -->
      <div class="rounded-lg border border-zinc-200 p-3.5 dark:border-zinc-800">
        <p class="mb-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">Agent runs</p>
        <div class="space-y-2">
          <div v-for="r in runFeed" :key="r.id" class="rounded-md border border-zinc-200 dark:border-zinc-800">
            <p class="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-zinc-600 dark:text-zinc-300">
              <span v-if="r.status === 'running'" class="inline-block size-2 animate-pulse rounded-full bg-warning" />
              <span v-else-if="r.status === 'done'" class="inline-block size-2 rounded-full bg-success" />
              <span v-else class="inline-block size-2 rounded-full bg-error" />
              {{ r.status }}<span v-if="r.exitCode !== null"> · exit {{ r.exitCode }}</span>
              <span class="ml-auto text-zinc-400">{{ new Date(r.startedAt).toLocaleString() }}</span>
            </p>
            <pre v-if="r.output" class="max-h-64 overflow-auto whitespace-pre-wrap rounded-b-md bg-zinc-950 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-zinc-200">{{ r.output }}</pre>
          </div>
          <p v-if="!runFeed.length" class="text-xs text-zinc-400">No runs yet.</p>
        </div>
      </div>

      <!-- activity -->
      <div class="rounded-lg border border-zinc-200 p-3.5 dark:border-zinc-800">
        <p class="mb-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-400">Activity</p>
        <div class="space-y-2">
          <div v-for="a in workflowFeed" :key="a.id" class="rounded-md border border-zinc-200 px-2.5 py-2 text-xs dark:border-zinc-800">
            <p class="flex items-center gap-1.5 font-medium text-zinc-600 dark:text-zinc-300">
              <UIcon :name="a.kind === 'question' ? 'i-lucide-help-circle' : a.kind === 'answer' ? 'i-lucide-check-check' : a.kind === 'forward' ? 'i-lucide-corner-up-right' : a.kind === 'verdict' ? 'i-lucide-gavel' : 'i-lucide-info'" class="size-3.5" />
              {{ a.kind }} · {{ a.authorName ?? 'system' }}
            </p>
            <p v-if="a.body" class="mt-1 text-zinc-500 dark:text-zinc-400">{{ a.body }}</p>
          </div>
          <p v-if="!workflowFeed.length" class="text-xs text-zinc-400">No activity yet.</p>
        </div>
      </div>
    </div>
  </div>
</template>
