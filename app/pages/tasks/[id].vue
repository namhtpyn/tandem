<script setup lang="ts">
// Task detail — Paperclip-style layout: chat-like main content (description bubble,
// run turns, activity notes, composer at the bottom) + right sidebar with task info
// (status, assignee, reviewers, workflow actions). Mobile-first: single column,
// sidebar collapses into a sheet. Streams stay persistent (one per feed, aborted
// on unmount) — see the stream law in AGENTS.md.
import { useQuery, skipToken, useQueryClient } from '@tanstack/vue-query'
import type { EmployeeRow, TaskRow } from '~/../shared/types'
import { buildThread, formatThreadTime, parseRunEnvelope, runAgentMessage, runOutputWithoutEnvelope } from '~/utils/task-thread'
import type { ThreadItem } from '~/utils/task-thread'

const route = useRoute()
const { $orpc, $client } = useNuxtApp()

const tasksLive = useQuery<TaskRow[]>(($orpc.tasks.list as any).queryOptions({ queryKey: ['tasks'] }))

const tasks = computed(() => (unref(tasksLive.data) ?? []) as TaskRow[])

const task = computed(() => tasks.value.find(t => t.id === String(route.params.id)) ?? null)

const workflowNote = ref('')
const workflowBusy = ref(false)
const workflowMessage = ref('')

// ---- first-load data via GET + change-event invalidation (SSE law) -----------
// runs/activity start as a conventional GET the moment the task resolves; the
// app-wide changes subscription refetches them whenever the server says runs or
// activity changed. No long-lived stream is opened for initial data.
const runsQuery = useQuery(computed(() => ($orpc.tasks.runsList as any).queryOptions({
  input: (task.value?.id ? { taskId: task.value.id } : skipToken),
  queryKey: ['runs', task.value?.id ?? ''],
})))
const runFeed = computed(() => (unref(runsQuery.data) ?? []) as unknown as Array<{ id: string, status: string, output: string, prompt?: string | null, agentName?: string | null, exitCode: number | null, startedAt: string, outputs?: Array<{ id: string, filename: string, mime: string, size: number }> }>)

const activityQuery = useQuery(computed(() => ($orpc.tasks.activityList as any).queryOptions({
  input: (task.value?.id ? { taskId: task.value.id } : skipToken),
  queryKey: ['taskActivity', task.value?.id ?? ''],
})))
const workflowFeed = computed(() => (unref(activityQuery.data) ?? []) as unknown as Array<{ id: string, kind: string, body: string, authorName: string | null, createdAt: string }>)
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
    prompt: r.prompt,
    agentName: r.agentName,
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

const outputsByRun = computed(() => {
  const m = new Map<string, Array<{ id: string, filename: string, mime: string, size: number }>>()
  for (const r of runFeed.value) if (r.outputs?.length) m.set(r.id, r.outputs)
  return m
})
watch(() => thread.value.length, async () => {
  await nextTick()
  scroller.value?.scrollTo({ top: scroller.value.scrollHeight })
})

function runOutputs(item: ThreadItem) {
  return item.kind === 'run' ? (outputsByRun.value.get(item.id) ?? []) : []
}

/** split the brief description into text + attachment refs for rendering */
const briefParts = computed(() => {
  const desc = task.value?.description ?? ''
  const parts: Array<{ type: 'text', body: string } | { type: 'mention', label: string } | { type: 'image', id: string, alt: string } | { type: 'file', id: string, name: string }> = []
  // split attachments first, then employee mentions inside the text parts
  const re = /!\[([^\]]*)\]\(attachment-([^)]+)\)|@\[([^\]]*)\]\(attachment-([^)]+)\)/g
  let last = 0
  for (const m of desc.matchAll(re)) {
    if (m.index! > last) pushText(desc.slice(last, m.index))
    if (m[2] !== undefined) parts.push({ type: 'image', id: m[2]!, alt: m[1]! })
    else parts.push({ type: 'file', id: m[4]!, name: m[3]! })
    last = m.index! + m[0].length
  }
  if (last < desc.length) pushText(desc.slice(last))
  return parts

  function pushText(text: string) {
    // either tiptap link form `@[Label](mention-id)` or serialized span `[@ id="..." label="..."]`
    const re = /@\[([^\]]+)\]\(mention-[^)]+\)|\[@\s*id="[^"]*"\s+label="([^"]+)"\]/g
    let at = 0
    for (const m of text.matchAll(re)) {
      if (m.index! > at) parts.push({ type: 'text', body: text.slice(at, m.index) })
      parts.push({ type: 'mention', label: m[1] ?? m[2] ?? '' })
      at = m.index! + m[0].length
    }
    if (at < text.length) parts.push({ type: 'text', body: text.slice(at) })
  }
})

function envelopeOf(item: ThreadItem) {
  return item.kind === 'run' ? parseRunEnvelope(item.output) : null
}
function envelopeColor(kind: string) {
  return kind === 'question' ? 'warning' : kind === 'blocked' ? 'error' : 'success'
}

async function wfAction(proc: string, extra: Record<string, unknown> = {}) {
  if (!task.value) return
  workflowBusy.value = true
  workflowMessage.value = ''
  try {
    await $fetch(`/rpc/tasks/${proc}`, { method: 'POST', body: { json: { taskId: task.value.id, ...extra } } })
    workflowNote.value = ''
    void queryClient.invalidateQueries({ queryKey: ['taskActivity', task.value.id] })
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

// ---- subtasks, agent proposals, assignment history ---------------------------
const employeesLive = useQuery(($orpc.employees.list as any).queryOptions({ queryKey: ['employees'] }))
const employees = computed(() => (unref(employeesLive.data) ?? []) as EmployeeRow[])
const employeeName = computed(() => new Map(employees.value.map(e => [e.id, e.name])))

interface ChildRow { id: string, title: string, status: string, assigneeId: string | null }
interface ProposalRow { id: string, kind: 'subtasks' | 'reassign', payload: Record<string, any>, status: string, decisionNote: string, createdAt: string }
interface AssignmentRow { id: string, employeeName: string | null, reason: string, startedAt: string, endedAt: string | null }

const subtaskRows = ref<ChildRow[]>([])
const proposalRows = ref<ProposalRow[]>([])
const assignmentRows = ref<AssignmentRow[]>([])
const proposalBusy = ref(false)
const proposalMessage = ref('')
const subtaskTitle = ref('')
const subtaskAssignee = ref('')

async function refreshRoutingPanels(taskId: string) {
  try {
    const [st, pr, as] = await Promise.all([
      ($fetch('/rpc/tasks/subtasks', { method: 'POST', body: { json: { taskId } } }) as unknown as Promise<{ json: { items: ChildRow[] } }>),
      ($fetch('/rpc/tasks/proposals', { method: 'POST', body: { json: { taskId } } }) as unknown as Promise<{ json: { items: ProposalRow[] } }>),
      ($fetch('/rpc/tasks/assignments', { method: 'POST', body: { json: { taskId } } }) as unknown as Promise<{ json: { items: AssignmentRow[] } }>),
    ])
    subtaskRows.value = st.json.items
    proposalRows.value = pr.json.items
    assignmentRows.value = as.json.items
  }
  catch { /* panels are best-effort; the thread still works */ }
}

watch(() => task.value?.id, (id) => { if (id) void refreshRoutingPanels(id) }, { immediate: true })

async function createSubtask() {
  if (!task.value || !subtaskTitle.value.trim()) return
  proposalBusy.value = true
  proposalMessage.value = ''
  try {
    await $fetch('/rpc/tasks/create', { method: 'POST', body: { json: { title: subtaskTitle.value.trim(), parentId: task.value.id, assigneeId: subtaskAssignee.value || null } } })
    subtaskTitle.value = ''
    subtaskAssignee.value = ''
    await refreshRoutingPanels(task.value.id)
    proposalMessage.value = 'subtask created'
  }
  catch (e) {
    proposalMessage.value = (e as { data?: { json?: { message?: string } }, message?: string }).data?.json?.message ?? (e as Error).message
  }
  finally { proposalBusy.value = false }
}

async function decideProposal(id: string, action: 'confirmProposal' | 'rejectProposal') {
  proposalBusy.value = true
  proposalMessage.value = ''
  try {
    const r = await $fetch(`/rpc/tasks/${action}`, { method: 'POST', body: { json: { proposalId: id } } }) as { json: { events?: string[] } }
    proposalMessage.value = r.json.events?.length ? r.json.events.join('; ') : 'done'
    await refreshRoutingPanels(task.value!.id)
    void queryClient.invalidateQueries({ queryKey: ['taskActivity', task.value!.id] })
    void queryClient.invalidateQueries({ queryKey: ['runs', task.value!.id] })
  }
  catch (e) {
    proposalMessage.value = (e as { data?: { json?: { message?: string } }, message?: string }).data?.json?.message ?? (e as Error).message
  }
  finally { proposalBusy.value = false }
}

const parentTask = computed(() => task.value?.parentTaskId ? tasks.value.find(t => t.id === task.value!.parentTaskId) ?? null : null)
const openProposals = computed(() => proposalRows.value.filter(p => p.status === 'proposed'))
const assignmentLines = computed(() => {
  const rows = [...assignmentRows.value].reverse() // oldest first
  return rows.map((r, i) => {
    const from = i === 0 ? '∅' : rows[i - 1]!.employeeName ?? '∅'
    return `${from} → ${r.employeeName ?? '∅'}${r.reason ? ` (${r.reason})` : ''}`
  })
})

const queryClient = useQueryClient()

useHead({ title: () => task.value ? `${task.value.title} · Tandem` : 'Task · Tandem' })
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
          <NuxtLink to="/tasks" class="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200">
            <UIcon name="i-lucide-arrow-left" class="size-4" />
          </NuxtLink>
          <div class="min-w-0 flex-1">
            <h1 class="truncate text-lg font-semibold text-zinc-900 dark:text-zinc-50">{{ task.title }}</h1>
            <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500">
              <UBadge :color="(task.status === 'done') ? 'success' : (task.status === 'todo') ? 'neutral' : 'warning'" variant="subtle" size="sm">{{ task.status }}</UBadge>
              <NuxtLink v-if="parentTask" :to="`/tasks/${parentTask.id}`" class="inline-flex items-center gap-1 text-primary hover:underline" data-testid="parent-task-link">
                <UIcon name="i-lucide-corner-left-up" class="size-3" /> part of: {{ parentTask.title }}
              </NuxtLink>
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
        <div ref="scroller" class="min-h-0 flex-1 space-y-4 overflow-y-auto rounded-xl border border-zinc-200/70 bg-white/50 p-3.5 dark:border-zinc-800 dark:bg-zinc-900/40 lg:max-h-none">
          <p v-if="!thread.length" class="py-10 text-center text-xs text-zinc-400">No activity yet.</p>

          <template v-for="item in thread" :key="item.id">
            <!-- brief: the task description as the opening message -->
            <div v-if="item.kind === 'brief'" class="flex gap-2.5">
              <div class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-[11px] font-semibold text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">T</div>
              <div class="min-w-0 flex-1">
                <p class="mb-1 text-[11px] font-medium text-zinc-400">Task brief <span v-if="item.createdAt" class="font-normal text-zinc-300 dark:text-zinc-500">· {{ formatThreadTime(item.createdAt) }}</span></p>
                <!-- description: mention tokens -> @Name; attachment tokens -> inline images / file chips -->
                <div class="rounded-xl rounded-tl-sm border border-zinc-200/70 bg-zinc-50 px-3.5 py-2.5 text-sm leading-relaxed text-zinc-800 dark:border-zinc-700/60 dark:bg-zinc-800/60 dark:text-zinc-200">
                  <template v-for="(p, i) in briefParts" :key="i">
                    <span v-if="p.type === 'mention'" class="mx-0.5 inline-flex items-center rounded-md bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">@{{ p.label }}</span>
                    <span v-if="p.type === 'text'" class="whitespace-pre-wrap">{{ p.body }}</span>
                    <img v-else-if="p.type === 'image'" :src="`/api/attachments/${p.id}`" :alt="p.alt" class="my-1.5 max-h-64 rounded-lg border border-zinc-200 dark:border-zinc-700">
                    <a v-else-if="p.type === 'file'" :href="`/api/attachments/${p.id}`" target="_blank" class="my-1 inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:border-primary/50 hover:text-primary dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"><UIcon name="i-lucide-file-text" class="size-3.5 shrink-0" />{{ p.name }}</a>
                  </template>
                </div>
              </div>
            </div>

            <!-- run: an agent turn -->
            <div v-else-if="item.kind === 'run'" class="flex gap-2.5">
              <div class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <UIcon v-if="item.status === 'running'" name="i-lucide-loader-circle" class="size-4 animate-spin" />
                <UIcon v-else-if="item.status === 'done'" name="i-lucide-bot" class="size-4" />
                <UIcon v-else name="i-lucide-circle-x" class="size-4 text-error" />
              </div>
              <div class="min-w-0 flex-1">
                <p class="mb-1 flex items-center gap-1.5 text-[11px] leading-none">
                  <span v-if="item.status === 'running'" class="inline-flex items-center gap-1 rounded-full bg-warning/15 px-1.5 py-0.5 font-semibold text-warning"><span class="inline-block size-1.5 animate-pulse rounded-full bg-warning" />working</span>
                  <span v-else-if="item.status === 'done'" class="rounded-full bg-zinc-100 px-1.5 py-0.5 font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">completed</span>
                  <span v-else class="inline-flex items-center gap-1 rounded-full bg-error/10 px-1.5 py-0.5 font-semibold text-error">failed<span v-if="item.exitCode !== null" class="font-normal opacity-80"> exit {{ item.exitCode }}</span></span>
                  <span class="ml-auto text-zinc-300 dark:text-zinc-600">{{ formatThreadTime(item.startedAt) }}</span>
                </p>
                <!-- envelope: the decision-model line, integrated not alarmist (max-w for rhythm) -->
                <div v-if="envelopeOf(item)" :class="['max-w-[calc(100%-3rem)] rounded-xl rounded-tl-sm border-l-2 px-3.5 py-2.5 text-sm leading-relaxed', envelopeOf(item)!.kind === 'question' ? 'border-l-blue-400/70 bg-blue-50/40 text-zinc-800 dark:bg-blue-500/10 dark:text-zinc-200' : envelopeOf(item)!.kind === 'blocked' ? 'border-l-error/70 bg-error/5 text-zinc-800 dark:bg-error/5 dark:text-zinc-200' : 'border-l-emerald-400/70 bg-emerald-50/40 text-zinc-800 dark:bg-emerald-500/10 dark:text-zinc-200']">
                  <span :class="['mr-1.5 align-middle text-[9px] font-bold uppercase tracking-widest', envelopeOf(item)!.kind === 'question' ? 'text-blue-500' : envelopeOf(item)!.kind === 'blocked' ? 'text-error' : 'text-emerald-600 dark:text-emerald-400']">{{ envelopeOf(item)!.kind }}</span><span class="align-middle">{{ envelopeOf(item)!.text || '(empty)' }}</span>
                </div>
                <!-- the agent's own message, as chat -->
                <div v-if="runAgentMessage(item.output)" class="mt-1.5 flex items-start gap-2">
                  <div class="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">{{
                    (item.agentName ?? 'Agent').slice(0, 2).toUpperCase() }}</div>
                  <div class="min-w-0 flex-1">
                    <p class="mb-0.5 text-[11px] leading-none"><span class="font-semibold text-zinc-600 dark:text-zinc-300">{{ item.agentName ?? 'Agent' }}</span><span class="text-primary"> (AI)</span></p>
                    <div class="inline-block max-w-full whitespace-pre-wrap break-words rounded-xl rounded-tr-sm bg-primary/5 px-3.5 py-2 text-sm leading-relaxed text-zinc-800 dark:bg-primary/10 dark:text-zinc-200">{{ runAgentMessage(item.output) }}</div>
                  </div>
                </div>
                <!-- collected output files (agent deliverables) -->
                <div v-if="runOutputs(item).length" class="mt-1.5 flex flex-wrap gap-1.5">
                  <template v-for="f in runOutputs(item)" :key="f.id">
                    <img v-if="f.mime.startsWith('image/')" :src="`/api/attachments/${f.id}`" :alt="f.filename" class="max-h-48 rounded-lg border border-zinc-200 dark:border-zinc-700">
                    <a v-else :href="`/api/attachments/${f.id}`" target="_blank" class="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 hover:border-primary/50 hover:text-primary dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"><UIcon :name="f.mime === 'application/pdf' ? 'i-lucide-file-text' : 'i-lucide-file'" class="size-3.5 shrink-0" />{{ f.filename }}<span class="font-normal text-zinc-400">{{ Math.max(1, Math.round(f.size / 1024)) }}KB</span></a>
                  </template>
                </div>
                <!-- exact prompt (brief) sent for this turn -->
                <details v-if="item.prompt" class="group mt-1">
                  <summary class="cursor-pointer select-none text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">input</summary>
                  <pre class="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-zinc-100 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-zinc-800 dark:bg-zinc-800/70 dark:text-zinc-300">{{ item.prompt }}</pre>
                </details>
                <!-- raw output (collapsed details keeps the thread chat-like) -->
                <details v-if="runOutputWithoutEnvelope(item.output)" class="group mt-1">
                  <summary class="cursor-pointer select-none text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">output</summary>
                  <pre class="mt-1 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md bg-zinc-950 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-zinc-200">{{ runOutputWithoutEnvelope(item.output) }}</pre>
                </details>
              </div>
            </div>

            <!-- note: slim system/human activity row -->
            <!-- human note: left bubble with initials avatar -->
            <div v-else-if="item.authorName" class="flex gap-2.5">
              <div class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-[11px] font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">{{ item.authorName.slice(0, 2).toUpperCase() }}</div>
              <div class="min-w-0 flex-1">
                <p class="mb-1 flex items-center gap-1.5 text-[11px] leading-none">
                  <span class="font-semibold text-zinc-600 dark:text-zinc-300">{{ item.authorName }}</span>
                  <span class="text-zinc-300 dark:text-zinc-600">{{ formatThreadTime(item.createdAt) }}</span>
                </p>
                <div v-if="item.body" class="inline-block max-w-full rounded-xl rounded-tl-sm bg-zinc-100 px-3.5 py-2 text-sm leading-relaxed text-zinc-800 dark:bg-zinc-800/70 dark:text-zinc-200">{{ item.body }}</div>
              </div>
            </div>
            <!-- system note: centered pill -->
            <div v-else class="flex justify-center py-0.5">
              <span class="inline-flex max-w-full items-center gap-1.5 rounded-full bg-zinc-100/80 px-2.5 py-1 text-[11px] text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400">
                <UIcon :name="item.noteKind === 'question' ? 'i-lucide-help-circle' : item.noteKind === 'answer' ? 'i-lucide-check-check' : item.noteKind === 'forward' ? 'i-lucide-corner-up-right' : item.noteKind === 'verdict' ? 'i-lucide-gavel' : 'i-lucide-info'" class="size-3 shrink-0" />
                <span class="truncate">{{ item.body || item.noteKind }}</span>
                <span class="shrink-0 text-zinc-300 dark:text-zinc-600">· {{ formatThreadTime(item.createdAt) }}</span>
              </span>
            </div>
          </template>
        </div>

        <!-- composer: workflow note + primary actions -->
        <div class="mt-3 rounded-2xl border border-zinc-200 bg-white p-2.5 shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
          <UTextarea v-model="workflowNote" :rows="1" autoresize :maxrows="6" variant="none" placeholder="Write a note or review…" class="w-full" :ui="{ base: 'px-1 py-1 text-sm placeholder:text-zinc-400' }" />
          <div class="mt-1.5 flex items-center justify-between">
            <p v-if="workflowMessage" class="text-xs" :class="workflowMessage === 'done' ? 'text-success' : 'text-error'">{{ workflowMessage }}</p>
            <span v-else class="text-[11px] text-zinc-400 dark:text-zinc-500">⏎ submit · ▶ dispatch agent</span>
            <div class="ml-auto flex items-center gap-1.5">
              <UTooltip text="Dispatch to the AI assignee"><UButton size="lg" color="primary" variant="soft" icon="i-lucide-play" aria-label="Run agent" class="size-10" :disabled="workflowBusy || !task.assigneeKind || task.assigneeKind !== 'ai'" @click="wfAction('dispatch')" /></UTooltip>
              <UTooltip text="Submit note to the thread"><UButton size="lg" color="primary" icon="i-lucide-arrow-up" aria-label="Submit" class="size-10" :disabled="workflowBusy" @click="wfAction('submit', { body: workflowNote || undefined })" /></UTooltip>
            </div>
          </div>
        </div>
      </section>

      <!-- ============ sidebar: task info (desktop docked; mobile via sheet above) ============ -->
      <aside class="hidden w-full shrink-0 self-start rounded-xl border border-zinc-200/70 bg-zinc-50/70 p-3.5 lg:sticky lg:top-4 lg:mt-0 lg:block lg:max-h-[calc(100vh-8.5rem)] lg:w-72 lg:overflow-y-auto dark:border-zinc-800 dark:bg-zinc-900/60">
        <div class="space-y-4">
          <div>
            <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Details</p>
            <dl class="space-y-1.5 text-sm">
              <div class="flex items-center justify-between gap-2">
                <dt class="text-xs text-zinc-500">Status</dt>
                <dd><UBadge :color="(task.status === 'done') ? 'success' : (task.status === 'todo') ? 'neutral' : 'warning'" variant="subtle" size="sm">{{ task.status }}</UBadge></dd>
              </div>
              <div class="flex items-center justify-between gap-2">
                <dt class="text-xs text-zinc-500">Assignee</dt>
                <dd class="truncate text-right" :class="task.assigneeName ? 'text-zinc-800 dark:text-zinc-200' : 'italic text-zinc-400'">{{ task.assigneeName ?? 'Unassigned' }}<span v-if="task.assigneeKind === 'ai'" class="text-primary"> (AI)</span></dd>
              </div>
              <div class="flex items-center justify-between gap-2">
                <dt class="text-xs text-zinc-500">Owner</dt>
                <dd class="truncate text-right" :class="task.ownerName ? 'text-zinc-800 dark:text-zinc-200' : 'italic text-zinc-400'">{{ task.ownerName ?? 'None' }}</dd>
              </div>
              <div class="flex items-center justify-between gap-2">
                <dt class="text-xs text-zinc-500">Project</dt>
                <dd class="truncate text-right" :class="task.projectName ? 'text-zinc-800 dark:text-zinc-200' : 'italic text-zinc-400'">{{ task.projectName ?? 'No project' }}</dd>
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

          <div v-if="openProposals.length" data-testid="proposal-panel">
            <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Agent proposals</p>
            <div class="space-y-2">
              <div v-for="p in openProposals" :key="p.id" class="rounded-lg border border-zinc-200 bg-white p-2.5 text-sm dark:border-zinc-800 dark:bg-zinc-900">
                <p class="mb-1 flex items-center gap-1.5 font-medium text-zinc-800 dark:text-zinc-200">
                  <UIcon :name="p.kind === 'subtasks' ? 'i-lucide-git-branch' : 'i-lucide-corner-up-right'" class="size-3.5 text-primary" />
                  {{ p.kind === 'subtasks' ? 'Split into subtasks' : 'Reassign ticket' }}
                </p>
                <ul v-if="p.kind === 'subtasks'" class="mb-2 space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
                  <li v-for="(item, i) in (p.payload.items ?? [])" :key="i" class="truncate">
                    • {{ item.title }}<span v-if="item.assigneeName" class="text-zinc-400"> — {{ item.assigneeName }}</span>
                  </li>
                </ul>
                <p v-else class="mb-2 truncate text-xs text-zinc-600 dark:text-zinc-400">→ {{ p.payload.targetName }}<span v-if="p.payload.reason"> — {{ p.payload.reason }}</span></p>
                <div class="flex gap-2">
                  <UButton size="xs" color="primary" icon="i-lucide-check" :disabled="proposalBusy" @click="decideProposal(p.id, 'confirmProposal')">Confirm</UButton>
                  <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-x" :disabled="proposalBusy" @click="decideProposal(p.id, 'rejectProposal')">Reject</UButton>
                </div>
              </div>
            </div>
          </div>

          <div data-testid="subtask-panel">
            <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Subtasks</p>
            <ul class="space-y-1 text-sm">
              <li v-for="c in subtaskRows" :key="c.id">
                <NuxtLink :to="`/tasks/${c.id}`" class="flex items-center justify-between gap-2 rounded px-1.5 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                  <span class="truncate text-zinc-800 dark:text-zinc-200">{{ c.title }}</span>
                  <UBadge :color="(c.status === 'done') ? 'success' : (c.status === 'blocked') ? 'error' : 'neutral'" variant="subtle" size="sm">{{ c.status }}</UBadge>
                </NuxtLink>
              </li>
            </ul>
            <div class="mt-2 flex gap-1.5">
              <UInput v-model="subtaskTitle" placeholder="New subtask…" size="xs" class="flex-1" :disabled="proposalBusy" @keydown.enter.prevent="createSubtask" />
              <USelect v-model="subtaskAssignee" :items="[{ label: 'Unassigned', value: '' }, ...employees.map(e => ({ label: e.name, value: e.id }))]" size="xs" class="w-28" />
              <UButton size="xs" icon="i-lucide-plus" :disabled="proposalBusy || !subtaskTitle.trim()" @click="createSubtask" />
            </div>
          </div>

          <div v-if="assignmentLines.length" data-testid="assignment-history">
            <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Assignees</p>
            <ul class="space-y-0.5 text-xs text-zinc-500">
              <li v-for="(line, i) in assignmentLines" :key="i" class="truncate">{{ line }}</li>
            </ul>
          </div>

          <div>
            <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Workflow</p>
            <div class="grid grid-cols-2 gap-2">
              <UButton size="md" color="neutral" variant="outline" icon="i-lucide-help-circle" class="justify-start" :disabled="workflowBusy" @click="wfAction('ask', { body: workflowNote || 'question' })">Ask</UButton>
              <UButton size="md" color="neutral" variant="outline" icon="i-lucide-corner-up-right" class="justify-start" :disabled="workflowBusy" @click="wfAction('forward', { body: workflowNote || undefined })">Forward</UButton>
              <UButton size="md" color="neutral" variant="outline" icon="i-lucide-check-check" class="justify-start" :disabled="workflowBusy" @click="wfAction('answer', { body: workflowNote || 'answer' })">Answer</UButton>
              <UButton size="md" color="success" variant="outline" icon="i-lucide-thumbs-up" class="justify-start" :disabled="workflowBusy" @click="wfAction('approve', { body: workflowNote || undefined })">Approve</UButton>
              <UButton size="md" color="neutral" variant="outline" icon="i-lucide-undo-2" class="justify-start" :disabled="workflowBusy" @click="wfAction('request-changes', { body: workflowNote || 'needs changes' })">Request changes</UButton>
              <UButton size="md" color="error" variant="outline" icon="i-lucide-ban" class="justify-start" :disabled="workflowBusy" @click="wfAction('abandon', { body: workflowNote || undefined })">Abandon</UButton>
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
              <div class="flex items-center justify-between gap-2">
                <dt class="text-xs text-zinc-500">Status</dt>
                <dd><UBadge :color="(task.status === 'done') ? 'success' : (task.status === 'todo') ? 'neutral' : 'warning'" variant="subtle" size="sm">{{ task.status }}</UBadge></dd>
              </div>
              <div class="flex items-center justify-between gap-2">
                <dt class="text-xs text-zinc-500">Assignee</dt>
                <dd class="truncate text-right" :class="task.assigneeName ? 'text-zinc-800 dark:text-zinc-200' : 'italic text-zinc-400'">{{ task.assigneeName ?? 'Unassigned' }}<span v-if="task.assigneeKind === 'ai'" class="text-primary"> (AI)</span></dd>
              </div>
              <div class="flex items-center justify-between gap-2">
                <dt class="text-xs text-zinc-500">Owner</dt>
                <dd class="truncate text-right" :class="task.ownerName ? 'text-zinc-800 dark:text-zinc-200' : 'italic text-zinc-400'">{{ task.ownerName ?? 'None' }}</dd>
              </div>
              <div class="flex items-center justify-between gap-2">
                <dt class="text-xs text-zinc-500">Project</dt>
                <dd class="truncate text-right" :class="task.projectName ? 'text-zinc-800 dark:text-zinc-200' : 'italic text-zinc-400'">{{ task.projectName ?? 'No project' }}</dd>
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
          <div v-if="openProposals.length" data-testid="proposal-panel">
            <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Agent proposals</p>
            <div class="space-y-2">
              <div v-for="p in openProposals" :key="p.id" class="rounded-lg border border-zinc-200 bg-white p-2.5 text-sm dark:border-zinc-800 dark:bg-zinc-900">
                <p class="mb-1 flex items-center gap-1.5 font-medium text-zinc-800 dark:text-zinc-200">
                  <UIcon :name="p.kind === 'subtasks' ? 'i-lucide-git-branch' : 'i-lucide-corner-up-right'" class="size-3.5 text-primary" />
                  {{ p.kind === 'subtasks' ? 'Split into subtasks' : 'Reassign ticket' }}
                </p>
                <ul v-if="p.kind === 'subtasks'" class="mb-2 space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
                  <li v-for="(item, i) in (p.payload.items ?? [])" :key="i" class="truncate">
                    • {{ item.title }}<span v-if="item.assigneeName" class="text-zinc-400"> — {{ item.assigneeName }}</span>
                  </li>
                </ul>
                <p v-else class="mb-2 truncate text-xs text-zinc-600 dark:text-zinc-400">→ {{ p.payload.targetName }}<span v-if="p.payload.reason"> — {{ p.payload.reason }}</span></p>
                <div class="flex gap-2">
                  <UButton size="xs" color="primary" icon="i-lucide-check" :disabled="proposalBusy" @click="decideProposal(p.id, 'confirmProposal')">Confirm</UButton>
                  <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-x" :disabled="proposalBusy" @click="decideProposal(p.id, 'rejectProposal')">Reject</UButton>
                </div>
              </div>
            </div>
          </div>

          <div data-testid="subtask-panel">
            <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Subtasks</p>
            <ul class="space-y-1 text-sm">
              <li v-for="c in subtaskRows" :key="c.id">
                <NuxtLink :to="`/tasks/${c.id}`" class="flex items-center justify-between gap-2 rounded px-1.5 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-800">
                  <span class="truncate text-zinc-800 dark:text-zinc-200">{{ c.title }}</span>
                  <UBadge :color="(c.status === 'done') ? 'success' : (c.status === 'blocked') ? 'error' : 'neutral'" variant="subtle" size="sm">{{ c.status }}</UBadge>
                </NuxtLink>
              </li>
            </ul>
            <div class="mt-2 flex gap-1.5">
              <UInput v-model="subtaskTitle" placeholder="New subtask…" size="xs" class="flex-1" :disabled="proposalBusy" @keydown.enter.prevent="createSubtask" />
              <USelect v-model="subtaskAssignee" :items="[{ label: 'Unassigned', value: '' }, ...employees.map(e => ({ label: e.name, value: e.id }))]" size="xs" class="w-28" />
              <UButton size="xs" icon="i-lucide-plus" :disabled="proposalBusy || !subtaskTitle.trim()" @click="createSubtask" />
            </div>
          </div>

          <div v-if="assignmentLines.length" data-testid="assignment-history">
            <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Assignees</p>
            <ul class="space-y-0.5 text-xs text-zinc-500">
              <li v-for="(line, i) in assignmentLines" :key="i" class="truncate">{{ line }}</li>
            </ul>
          </div>

          <div>
            <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Workflow</p>
            <div class="grid grid-cols-2 gap-2">
              <UButton size="md" color="neutral" variant="outline" icon="i-lucide-help-circle" class="justify-start" :disabled="workflowBusy" @click="wfAction('ask', { body: workflowNote || 'question' })">Ask</UButton>
              <UButton size="md" color="neutral" variant="outline" icon="i-lucide-corner-up-right" class="justify-start" :disabled="workflowBusy" @click="wfAction('forward', { body: workflowNote || undefined })">Forward</UButton>
              <UButton size="md" color="neutral" variant="outline" icon="i-lucide-check-check" class="justify-start" :disabled="workflowBusy" @click="wfAction('answer', { body: workflowNote || 'answer' })">Answer</UButton>
              <UButton size="md" color="success" variant="outline" icon="i-lucide-thumbs-up" class="justify-start" :disabled="workflowBusy" @click="wfAction('approve', { body: workflowNote || undefined })">Approve</UButton>
              <UButton size="md" color="neutral" variant="outline" icon="i-lucide-undo-2" class="justify-start" :disabled="workflowBusy" @click="wfAction('request-changes', { body: workflowNote || 'needs changes' })">Request changes</UButton>
              <UButton size="md" color="error" variant="outline" icon="i-lucide-ban" class="justify-start" :disabled="workflowBusy" @click="wfAction('abandon', { body: workflowNote || undefined })">Abandon</UButton>
            </div>
          </div>
        </div>
      </template>
    </USlideover>
    </div>
    </template>
  </UDashboardPanel>
</template>
