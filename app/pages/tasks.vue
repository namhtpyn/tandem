<script setup lang="ts">
// Tasks: work items for human + AI employees. Mobile-first card list with
// status pills; editor modal follows the shared structure (body + #footer).
import { useQuery, useMutation } from '@tanstack/vue-query'
import type { EmployeeRow, TaskRow } from '~/../shared/types'


const { $orpc, $client } = useNuxtApp()
const tasksLive = useQuery<TaskRow[]>(($orpc.tasks.live as any).liveOptions())
const statusesLive = useQuery<import('~/../shared/types').TaskStatusRow[]>(($orpc.statuses.live as any).liveOptions())
const employeesLive = useQuery<import('~/../shared/types').EmployeeRow[]>(($orpc.employees.live as any).liveOptions())
const projectsLive = useQuery(($orpc.projects.live as any).liveOptions())

const tasks = computed(() => (unref(tasksLive.data) ?? []) as TaskRow[])
const statuses = computed(() => (unref(statusesLive.data) ?? []) as import('~/../shared/types').TaskStatusRow[])
const statusById = computed(() => new Map(statuses.value.map(x => [x.id, x])))
const firstStatusId = computed(() => statuses.value[0]?.id ?? 'todo')
const employees = computed(() => (unref(employeesLive.data) ?? []) as EmployeeRow[])

const editorOpen = ref(false)
const editingId = ref<string | null>(null)
const busy = ref(false)
const message = ref('')
const pendingDelete = ref<TaskRow | null>(null)
const deleteOpen = computed({
  get: () => pendingDelete.value !== null,
  set: (v: boolean) => { if (!v) pendingDelete.value = null },
})

const form = reactive({ title: '', description: '', assigneeId: '__none__' as string, status: 'todo' as string, projectId: '__none__' as string, ownerId: '__none__' as string, reviewers: [] as string[] })
const isEdit = computed(() => editingId.value !== null)

const assignMutation = useMutation<any, any, any>(($orpc.statuses.assign as any).mutationOptions())

async function autoAssign(row: TaskRow) {
  message.value = ''
  try {
    const res = await assignMutation.mutateAsync({ taskId: row.id })
    if (res.assigned) {
      message.value = `Assigned to ${assigneeNameById.value.get(res.employeeId) ?? 'employee'} (confidence ${(res.confidence * 100).toFixed(0)}%)`
    }
    else {
      message.value = `Not assigned: ${res.reason ?? 'decision engine declined'}`
    }
  }
  catch (e) {
    message.value = e instanceof Error ? e.message : 'auto-assign failed'
  }
}

const createMutation = useMutation<any, any, any>(($orpc.tasks.create as any).mutationOptions())
const updateMutation = useMutation<any, any, any>(($orpc.tasks.update as any).mutationOptions())
const removeMutation = useMutation<any, any, any>(($orpc.tasks.remove as any).mutationOptions())

const assigneeOptions = computed(() => [
  { label: 'Unassigned', value: '__none__' },
  ...employees.value.map(e => ({ label: `${e.name}${e.kind === 'ai' ? ' (AI)' : ''}`, value: e.id })),
])
const assigneeNameById = computed(() => new Map(employees.value.map(e => [e.id, e.name])))
const projectRows = computed(() => (unref(projectsLive.data) ?? []) as Array<{ id: string, name: string }>)
const projectOptions = computed(() => [
  { label: 'No project', value: '__none__' },
  ...projectRows.value.map(p => ({ label: p.name, value: p.id })),
])
const projectNameById = computed(() => new Map(projectRows.value.map(p => [p.id, p.name])))

const statusOptions = computed(() => statuses.value.map(x => ({ label: x.name, value: x.id })))

// ---- status management ----
const statusManagerOpen = ref(false)
const statusEditorOpen = computed({
  get: () => editingStatusId.value !== null || statusEditorTouched.value,
  set: (v: boolean) => { if (!v) { editingStatusId.value = null; statusEditorTouched.value = false } },
})
const statusEditorTouched = ref(false)
const statusBusy = ref(false)
const statusMessage = ref('')
const editingStatusId = ref<string | null>(null)
const statusForm = reactive({ name: '', color: 'neutral' as 'neutral' | 'primary' | 'success' | 'warning' | 'error' | 'info', position: 0, category: 'backlog' as 'backlog' | 'ready' | 'working' | 'paused' | 'waiting_answer' | 'in_review' | 'done' | 'cancelled', nextIds: [] as string[] })

const statusSaveMutation = useMutation<any, any, any>(($orpc.statuses.save as any).mutationOptions())
const statusRemoveMutation = useMutation<any, any, any>(($orpc.statuses.remove as any).mutationOptions())

function openStatusEditor(row?: import('~/../shared/types').TaskStatusRow) {
  editingStatusId.value = row?.id ?? null
  statusForm.name = row?.name ?? ''
  statusForm.color = (row?.color as any) ?? 'neutral'
  statusForm.position = row?.position ?? statuses.value.length
  statusForm.category = row?.category ?? 'backlog'
  statusForm.nextIds = row ? [...row.nextIds] : (statuses.value.length > 0 ? [statuses.value[0]!.id] : [])
  statusMessage.value = ''
  statusEditorTouched.value = true
  statusManagerOpen.value = false
}

async function saveStatus() {
  if (!statusForm.name.trim()) return
  statusBusy.value = true
  statusMessage.value = ''
  try {
    await statusSaveMutation.mutateAsync({
      ...(editingStatusId.value ? { id: editingStatusId.value } : {}),
      name: statusForm.name.trim(),
      color: statusForm.color,
      position: statusForm.position,
      category: statusForm.category,
      nextIds: statusForm.nextIds,
    })
    statusEditorTouched.value = false
    editingStatusId.value = null
  }
  catch (e) {
    statusMessage.value = e instanceof Error ? e.message : 'save failed'
  }
  finally {
    statusBusy.value = false
  }
}

async function removeStatus(id: string) {
  statusBusy.value = true
  statusMessage.value = ''
  try {
    await statusRemoveMutation.mutateAsync({ id })
  }
  catch (e) {
    statusMessage.value = e instanceof Error ? e.message : 'delete failed'
  }
  finally {
    statusBusy.value = false
  }
}

const colorOptions = ['neutral', 'primary', 'success', 'warning', 'error', 'info']
const categoryOptions = [
  { label: 'Backlog — parked, nobody works on it', value: 'backlog' },
  { label: 'Ready — assigned agent picks it up', value: 'ready' },
  { label: 'Working — hands off, in progress', value: 'working' },
  { label: 'Paused — halted, not terminal', value: 'paused' },
  { label: 'Waiting answer — question routed, work paused', value: 'waiting_answer' },
  { label: 'In review — result awaits unanimous approval', value: 'in_review' },
  { label: 'Done — completed, agents stop', value: 'done' },
  { label: 'Cancelled — abandoned, agents stop', value: 'cancelled' },
]
function categoryColor(c: string) {
  return c === 'ready' ? 'primary' : c === 'working' ? 'warning' : c === 'waiting_answer' ? 'warning' : c === 'in_review' ? 'info' : c === 'done' ? 'success' : c === 'cancelled' ? 'error' : 'neutral'
}

// ---- board (kanban) view ----
const view = ref<'list' | 'board'>('list')
const draggingId = ref<string | null>(null)
const dropTarget = ref<string | null>(null)
const columns = computed(() => statuses.value)
function allowedTargets(statusId: string): string[] {
  return statusById.value.get(statusId)?.nextIds ?? []
}

function tasksByStatus(status: string) {
  return tasks.value.filter(t => t.status === status)
}

function onDrop(status: string) {
  const id = draggingId.value
  draggingId.value = null
  dropTarget.value = null
  const row = tasks.value.find(t => t.id === id)
  if (!row || row.status === status) return
  if (!allowedTargets(row.status).includes(status)) return // column not highlighted for this card
  setStatus(row, status)
}

function openEditor(row?: TaskRow) {
  editingId.value = row?.id ?? null
  form.title = row?.title ?? ''
  form.description = row?.description ?? ''
  form.assigneeId = row?.assigneeId ?? '__none__'
  form.projectId = row?.projectId ?? '__none__'
  form.ownerId = row?.ownerId ?? '__none__'
  form.reviewers = row?.reviewers ? [...row.reviewers] : []
  form.status = row?.status ?? firstStatusId.value
  message.value = ''
  editorOpen.value = true
}

async function save() {
  busy.value = true
  message.value = ''
  try {
    const payload = {
      title: form.title,
      description: form.description,
      assigneeId: form.assigneeId === '__none__' ? null : form.assigneeId,
      projectId: form.projectId === '__none__' ? null : form.projectId,
      ownerId: form.ownerId === '__none__' ? null : form.ownerId,
      reviewers: form.reviewers,
    }
    if (editingId.value) {
      await updateMutation.mutateAsync({ id: editingId.value, ...payload, status: form.status })
    }
    else {
      await createMutation.mutateAsync({ ...payload, status: form.status })
    }
    editorOpen.value = false
  }
  catch (e) {
    message.value = e instanceof Error ? e.message : 'save failed'
  }
  finally {
    busy.value = false
  }
}

const workflowOpen = ref(false)
const workflowTask = ref<TaskRow | null>(null)
const workflowNote = ref('')
const workflowBusy = ref(false)
const workflowMessage = ref('')
const workflowFeed = ref<import('~/../shared/types').TaskActivityRow[]>([])
const forwardTo = ref('__none__')

async function openWorkflow(row: TaskRow) {
  workflowTask.value = row
  workflowNote.value = ''
  workflowMessage.value = ''
  workflowOpen.value = true
  await refreshFeed(row.id)
}

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
        workflowFeed.value = (payload?.json ?? payload ?? []) as import('~/../shared/types').TaskActivityRow[]
        return
      }
    }
    ac.abort()
    workflowFeed.value = []
  }
  catch { workflowFeed.value = [] }
}

async function wfAction(proc: string, extra: Record<string, unknown> = {}) {
  if (!workflowTask.value) return
  workflowBusy.value = true
  workflowMessage.value = ''
  try {
    await $fetch(`/rpc/tasks/${proc}`, { method: 'POST', body: { json: { taskId: workflowTask.value.id, ...extra } } })
    workflowNote.value = ''
    await refreshFeed(workflowTask.value.id)
    workflowMessage.value = 'done'
  }
  catch (e) {
    workflowMessage.value = e instanceof Error ? e.message : 'action failed'
  }
  finally {
    workflowBusy.value = false
  }
}

async function setStatus(row: TaskRow, status: string) {
  if (row.status === status) return
  const cur = statusById.value.get(row.status)
  if (cur && !cur.nextIds.includes(status)) {
    message.value = `cannot move from '${cur.name}' to '${statusById.value.get(status)?.name ?? status}'`
    return
  }
  message.value = ''
  try {
    await updateMutation.mutateAsync({ id: row.id, status })
  }
  catch (e) {
    message.value = e instanceof Error ? e.message : 'status change failed'
  }
}

async function remove() {
  if (!pendingDelete.value) return
  busy.value = true
  try {
    await removeMutation.mutateAsync({ id: pendingDelete.value.id })
    pendingDelete.value = null
  }
  catch (e) {
    message.value = e instanceof Error ? e.message : 'delete failed'
  }
  finally {
    busy.value = false
  }
}

function statusColor(s: string) {
  const c = statusById.value.get(s)?.color
  if (c === 'primary' || c === 'success' || c === 'warning' || c === 'error' || c === 'info' || c === 'neutral') return c
  return 'neutral'
}
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #body>
      <UDashboardNavbar title="Tasks">
      <template #leading>
        <UDashboardSidebarCollapse />
      </template>
    </UDashboardNavbar>
      <div class="space-y-6 p-6 lg:p-8">
      <div class="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p class="text-sm text-zinc-500">Work items for humans and AI agents</p>
        </div>
        <div class="flex items-center gap-2">
          <div class="inline-flex overflow-hidden rounded-md border border-zinc-300 dark:border-zinc-700" role="group" aria-label="View">
            <button
              type="button"
              class="px-3 py-1.5 text-sm font-medium transition-colors"
              :class="view === 'list' ? 'bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-400' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'"
              aria-label="List view"
              @click="view = 'list'"
            >List</button>
            <button
              type="button"
              class="border-l border-zinc-300 px-3 py-1.5 text-sm font-medium transition-colors dark:border-zinc-700"
              :class="view === 'board' ? 'bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-400' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'"
              aria-label="Board view"
              @click="view = 'board'"
            >Board</button>
          </div>
          <UButton icon="i-lucide-settings-2" label="Statuses" color="neutral" variant="outline" size="sm" @click="statusManagerOpen = true" />
          <UButton icon="i-lucide-plus" label="New task" @click="openEditor()" />
        </div>
      </div>

      <p v-if="message" class="text-sm text-error">{{ message }}</p>

      <!-- empty state -->
      <UCard v-if="!tasks.length" :ui="{ root: 'shadow-sm' }">
        <div class="flex flex-col items-center gap-2 py-8 text-center">
          <UIcon name="i-lucide-list-todo" class="size-8 text-zinc-300" />
          <p class="text-sm text-zinc-500">No tasks yet — create the first one.</p>
          <UButton icon="i-lucide-plus" size="sm" label="New task" variant="soft" @click="openEditor()" />
        </div>
      </UCard>

      <!-- mobile cards (list view) -->
      <div v-if="tasks.length && view === 'list'" class="space-y-3 md:hidden">
        <UCard v-for="row in tasks" :key="row.id" :ui="{ root: 'shadow-sm' }">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <p class="truncate font-medium text-zinc-900 dark:text-white">{{ row.title }}</p>
              <p v-if="row.projectName" class="mt-0.5 flex items-center gap-1 text-xs text-primary"><UIcon name="i-lucide-folder-kanban" class="size-3" />{{ row.projectName }}</p>
              <p class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-400">
                <span>{{ assigneeNameById.get(row.assigneeId ?? '') ?? 'Unassigned' }}</span>
                <span v-if="row.assigneeKind === 'ai'" class="inline-flex items-center gap-1 text-primary"><UIcon name="i-lucide-bot" class="size-3" />AI</span>
              </p>
            </div>
            <UBadge :color="statusColor(row.status)" variant="subtle" size="sm">{{ statusById.get(row.status)?.name ?? row.status }}</UBadge>
          </div>
          <p v-if="row.description" class="mt-2 line-clamp-2 text-sm text-zinc-500">{{ row.description }}</p>
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
                <UButton icon="i-lucide-wand-sparkles" variant="ghost" color="neutral" size="xs" aria-label="Auto-assign" :disabled="busy" @click="autoAssign(row)" />
                <template #content>
                  <div class="px-3 py-1.5 text-xs">Auto-assign (Jev)</div>
                </template>
              </UPopover>
              <UPopover mode="hover">
                <UButton icon="i-lucide-message-circle-more" variant="ghost" color="neutral" size="xs" aria-label="Task workflow" @click="openWorkflow(row)" />
                <template #content>
                  <div class="px-3 py-1.5 text-xs">Workflow &amp; activity</div>
                </template>
              </UPopover>
              <UPopover mode="hover">
                <UButton icon="i-lucide-pencil" variant="ghost" color="neutral" size="xs" aria-label="Edit task" @click="openEditor(row)" />
                <template #content>
                  <div class="px-3 py-1.5 text-xs">Edit task</div>
                </template>
              </UPopover>
              <UPopover mode="hover">
                <UButton icon="i-lucide-trash-2" variant="ghost" color="error" size="xs" aria-label="Delete task" @click="pendingDelete = row" />
                <template #content>
                  <div class="px-3 py-1.5 text-xs">Delete task</div>
                </template>
              </UPopover>
            </div>
          </div>
        </UCard>
      </div>

      <!-- desktop table -->
      <UCard v-if="tasks.length && view === 'list'" :ui="{ root: 'shadow-sm', body: 'p-0 sm:p-0' }" class="hidden md:block">
        <UTable :data="tasks" :columns="[
          { accessorKey: 'title', header: 'Task' },
          { accessorKey: 'assignee', header: 'Assignee' },
          { accessorKey: 'status', header: 'Status' },
          { accessorKey: 'actions', header: '' },
        ]">
          <template #title-cell="{ row }">
            <div class="min-w-0">
              <p class="truncate font-medium text-zinc-900 dark:text-white">{{ row.original.title }}</p>
              <p v-if="row.original.projectName" class="flex items-center gap-1 text-xs text-primary"><UIcon name="i-lucide-folder-kanban" class="size-3" />{{ row.original.projectName }}</p>
              <p v-if="row.original.description" class="truncate text-xs text-zinc-400">{{ row.original.description }}</p>
            </div>
          </template>
          <template #assignee-cell="{ row }">
            <span class="flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-300">
              <UIcon v-if="row.original.assigneeKind === 'ai'" name="i-lucide-bot" class="size-3.5 text-primary" />
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
          <template #actions-cell="{ row }">
            <div class="flex justify-end gap-1">
              <UPopover mode="hover">
                <UButton icon="i-lucide-wand-sparkles" variant="ghost" color="neutral" size="xs" aria-label="Auto-assign" :disabled="busy" @click="autoAssign(row.original)" />
                <template #content>
                  <div class="px-3 py-1.5 text-xs">Auto-assign (Jev)</div>
                </template>
              </UPopover>
              <UPopover mode="hover">
                <UButton icon="i-lucide-pencil" variant="ghost" color="neutral" size="xs" aria-label="Edit task" @click="openEditor(row.original)" />
                <template #content>
                  <div class="px-3 py-1.5 text-xs">Edit task</div>
                </template>
              </UPopover>
              <UPopover mode="hover">
                <UButton icon="i-lucide-trash-2" variant="ghost" color="error" size="xs" aria-label="Delete task" @click="pendingDelete = row.original" />
                <template #content>
                  <div class="px-3 py-1.5 text-xs">Delete task</div>
                </template>
              </UPopover>
            </div>
          </template>
        </UTable>
      </UCard>

      <!-- kanban board view -->
      <div v-if="view === 'board'" class="space-y-4">
        <div class="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div
            v-for="col in columns"
            :key="col.id"
            class="flex min-h-40 flex-col rounded-lg border border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-900/40"
            :class="dropTarget === col.id ? 'ring-2 ring-primary' : ''"
            @dragover.prevent="dropTarget = col.id"
            @dragleave="dropTarget === col.id && (dropTarget = null)"
            @drop.prevent="onDrop(col.id)"
          >
            <div class="flex items-center justify-between gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
              <p class="flex items-center gap-1.5 text-sm font-medium text-zinc-700 dark:text-zinc-200">
                <UIcon name="i-lucide-circle-dot" class="size-4" :class="col.color === 'success' ? 'text-success' : col.color === 'warning' ? 'text-warning' : 'text-zinc-400'" />
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
                @dragend="draggingId = null; dropTarget = null"
                @dragenter="dropTarget === null && allowedTargets(row.status).includes(col.id) && (dropTarget = col.id)"
              >
                <div class="min-w-0">
                  <p class="truncate text-sm font-medium text-zinc-900 dark:text-white">{{ row.title }}</p>
                  <p v-if="row.projectName" class="mt-0.5 flex items-center gap-1 text-xs text-primary"><UIcon name="i-lucide-folder-kanban" class="size-3" />{{ row.projectName }}</p>
                  <p class="mt-0.5 flex items-center gap-1 text-xs text-zinc-400">
                    <UIcon v-if="row.assigneeKind === 'ai'" name="i-lucide-bot" class="size-3 text-primary" />
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
                      <UButton icon="i-lucide-wand-sparkles" variant="ghost" color="neutral" size="xs" aria-label="Auto-assign" :disabled="busy" @click="autoAssign(row)" />
                      <template #content>
                        <div class="px-3 py-1.5 text-xs">Auto-assign (Jev)</div>
                      </template>
                    </UPopover>
                    <UPopover mode="hover">
                      <UButton icon="i-lucide-pencil" variant="ghost" color="neutral" size="xs" aria-label="Edit task" @click="openEditor(row)" />
                      <template #content>
                        <div class="px-3 py-1.5 text-xs">Edit task</div>
                      </template>
                    </UPopover>
                    <UPopover mode="hover">
                      <UButton icon="i-lucide-trash-2" variant="ghost" color="error" size="xs" aria-label="Delete task" @click="pendingDelete = row" />
                      <template #content>
                        <div class="px-3 py-1.5 text-xs">Delete task</div>
                      </template>
                    </UPopover>
                  </div>
                </div>
              </UCard>
              <p v-if="!tasksByStatus(col.id).length" class="py-4 text-center text-xs text-zinc-400">Drop tasks here</p>
            </div>
          </div>
        </div>
      </div>

      <!-- status manager -->
      <UModal v-model:open="workflowOpen" title="Task workflow">
        <template #body>
          <div v-if="workflowTask" class="space-y-4">
            <div>
              <p class="font-medium">{{ workflowTask.title }}</p>
              <p class="mt-0.5 text-xs text-zinc-400">
                {{ statusById.get(workflowTask.status)?.name ?? workflowTask.status }}
                <template v-if="workflowTask.questionHolderName"> · waiting on {{ workflowTask.questionHolderName }}</template>
                <template v-if="workflowTask.reviewers.length"> · reviewers: {{ workflowTask.reviewerNames.join(', ') }}</template>
              </p>
            </div>
            <div class="flex flex-wrap gap-2">
              <UButton size="xs" color="warning" variant="soft" icon="i-lucide-help-circle" :disabled="workflowBusy" @click="wfAction('ask', { body: workflowNote || 'question' })">Ask</UButton>
              <UButton size="xs" color="neutral" variant="soft" icon="i-lucide-corner-up-right" :disabled="workflowBusy || !forwardTo" @click="forwardTo && wfAction('forward', { toEmployeeId: forwardTo, body: workflowNote })">Forward</UButton>
              <UButton size="xs" color="primary" variant="soft" icon="i-lucide-check-check" :disabled="workflowBusy" @click="wfAction('answer', { body: workflowNote || 'answer' })">Answer</UButton>
              <UButton size="xs" color="info" variant="soft" icon="i-lucide-send" :disabled="workflowBusy" @click="wfAction('submit', { body: workflowNote })">Submit</UButton>
              <UButton size="xs" color="success" variant="soft" icon="i-lucide-thumbs-up" :disabled="workflowBusy" @click="wfAction('approve')">Approve</UButton>
              <UButton size="xs" color="warning" variant="soft" icon="i-lucide-undo-2" :disabled="workflowBusy || !workflowNote" @click="wfAction('requestChanges', { body: workflowNote })">Request changes</UButton>
              <UButton size="xs" color="error" variant="soft" icon="i-lucide-x-circle" :disabled="workflowBusy" @click="wfAction('abandon')">Abandon</UButton>
            </div>
            <USelect
              v-model="forwardTo"
              :items="[{ label: 'Forward to…', value: '__none__' }, ...employees.filter(e => e.id !== workflowTask?.questionHolderId).map(e => ({ label: e.name, value: e.id }))]"
              value-key="value"
              size="sm"
              class="w-full"
              aria-label="Forward to"
            />
            <UTextarea v-model="workflowNote" :rows="3" placeholder="Question / answer / review note" class="w-full" />
            <p v-if="workflowMessage" class="text-xs" :class="workflowMessage === 'done' ? 'text-success' : 'text-error'">{{ workflowMessage }}</p>
            <div class="space-y-2">
              <p class="text-xs font-semibold uppercase tracking-wide text-zinc-400">Activity</p>
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
        </template>
      </UModal>

      <UModal v-model:open="statusManagerOpen" title="Task statuses" :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]' }">
        <template #body>
          <div class="space-y-4">
            <p class="text-xs text-zinc-500 dark:text-zinc-400">Define the workflow statuses and which moves are allowed between them (used by the board and the task editor).</p>
            <p v-if="statusMessage" class="text-sm text-error">{{ statusMessage }}</p>
            <div v-if="statuses.length" class="divide-y divide-zinc-200 dark:divide-zinc-800">
              <div v-for="st in statuses" :key="st.id" class="flex items-center justify-between gap-2 py-2">
                <div class="min-w-0">
                  <p class="flex items-center gap-2 truncate text-sm font-medium text-zinc-900 dark:text-white">
                    <UBadge :color="(st.color as any)" variant="subtle" size="sm">{{ st.name }}</UBadge>
                    <UBadge :color="categoryColor(st.category)" variant="subtle" size="sm">{{ st.category }}</UBadge>
                  </p>
                  <p class="truncate text-xs text-zinc-400">{{ st.nextIds.length ? `→ ${st.nextIds.map(n => statusById.get(n)?.name ?? n).join(', ')}` : 'no transitions' }}</p>
                </div>
                <div class="flex shrink-0 gap-1">
                  <UPopover mode="hover">
                    <UButton icon="i-lucide-pencil" variant="ghost" color="neutral" size="xs" aria-label="Edit status" :disabled="statusBusy" @click="openStatusEditor(st)" />
                    <template #content>
                      <div class="px-3 py-1.5 text-xs">Edit status</div>
                    </template>
                  </UPopover>
                  <UPopover mode="hover">
                    <UButton icon="i-lucide-trash-2" variant="ghost" color="error" size="xs" aria-label="Delete status" :disabled="statusBusy" @click="removeStatus(st.id)" />
                    <template #content>
                      <div class="px-3 py-1.5 text-xs">Delete status</div>
                    </template>
                  </UPopover>
                </div>
              </div>
            </div>
            <p v-else class="text-sm text-zinc-500">No statuses defined.</p>
            <div class="flex justify-end">
              <UButton icon="i-lucide-plus" size="sm" label="New status" @click="openStatusEditor()" />
            </div>
          </div>
        </template>
      </UModal>

      <!-- status editor -->
      <UModal v-model:open="statusEditorOpen" :title="editingStatusId ? 'Edit status' : 'New status'">
        <template #body>
          <div class="space-y-4">
            <UFormField label="Name" name="statusName">
              <UInput v-model="statusForm.name" placeholder="e.g. In review" class="w-full" />
            </UFormField>
            <UFormField label="Color" name="statusColor">
              <USelect v-model="statusForm.color" :items="colorOptions" class="w-full" />
            </UFormField>
            <UFormField label="Position" name="statusPosition">
              <UInput v-model.number="statusForm.position" type="number" min="0" max="99" class="w-full" />
            </UFormField>
            <UFormField label="Meaning" name="statusCategory">
              <template #hint><FormHint text="ready = agents pick tasks up from here; done/cancelled = agents stop working" /></template>
              <USelect v-model="statusForm.category" :items="categoryOptions" value-key="value" class="w-full" />
            </UFormField>
            <UFormField label="Can move to" name="statusNext">
              <template #hint><FormHint text="Allowed transitions from this status" /></template>
              <USelectMenu
                v-model="statusForm.nextIds"
                :items="statuses.filter(x => x.id !== editingStatusId).map(x => ({ label: x.name, value: x.id }))"
                value-key="value"
                multiple
                class="w-full"
                placeholder="Pick allowed next statuses"
              />
            </UFormField>
            <p v-if="statusMessage" class="text-sm text-error">{{ statusMessage }}</p>
          </div>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton variant="ghost" color="neutral" label="Cancel" @click="statusEditorOpen = false" />
            <UButton icon="i-lucide-check" label="Save status" :loading="statusBusy" :disabled="!statusForm.name.trim()" @click="saveStatus" />
          </div>
        </template>
      </UModal>

      <!-- editor -->
      <UModal v-model:open="editorOpen" :title="isEdit ? 'Edit task' : 'New task'" :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]' }">
        <template #body>
          <UForm id="task-editor-form" :state="form" class="space-y-4" @submit="save">
            <UFormField label="Title" name="title">
              <template #hint><FormHint text="Short summary of the work" /></template>
              <UInput v-model="form.title" icon="i-lucide-list-todo" placeholder="Task title" class="w-full" required />
            </UFormField>
            <UFormField label="Description" name="description">
              <template #hint><FormHint text="What needs to be done; AI agents receive it as their instructions" /></template>
              <UTextarea v-model="form.description" placeholder="Description (optional)" :rows="4" class="w-full" />
            </UFormField>
            <UFormField label="Project" name="projectId">
              <template #hint><FormHint text="Group this task under a project" /></template>
              <USelectMenu v-model="form.projectId" :items="projectOptions" value-key="value" :search-input="{ placeholder: 'Search projects' }" icon="i-lucide-folder-kanban" placeholder="No project" class="w-full" />
            </UFormField>
            <UFormField label="Assignee" name="assigneeId">
              <template #hint><FormHint text="Human or AI agent responsible" /></template>
              <USelect v-model="form.assigneeId" :items="assigneeOptions" value-key="value" icon="i-lucide-user-check" class="w-full" />
            </UFormField>
            <UFormField v-if="isEdit" label="Status" name="status">
              <USelect v-model="form.status" :items="statusOptions" value-key="value" icon="i-lucide-circle-dot" class="w-full" />
              <UFormField label="Owner (routes questions)" name="owner">
                <USelect
                  v-model="form.ownerId"
                  :items="[{ label: 'Creator (default)', value: '__none__' }, ...employees.map(e => ({ label: e.name, value: e.id }))]"
                  value-key="value"
                  icon="i-lucide-user-cog"
                  class="w-full"
                />
              </UFormField>
              <UFormField label="Reviewers (all must approve)" name="reviewers">
                <div class="flex flex-wrap gap-2">
                  <UButton
                    v-for="e in employees"
                    :key="e.id"
                    size="xs"
                    :variant="form.reviewers.includes(e.id) ? 'solid' : 'soft'"
                    :color="form.reviewers.includes(e.id) ? 'primary' : 'neutral'"
                    @click="form.reviewers.includes(e.id) ? form.reviewers = form.reviewers.filter(x => x !== e.id) : form.reviewers.push(e.id)"
                  >
                    {{ e.name }}
                  </UButton>
                </div>
              </UFormField>
            </UFormField>
            <p v-if="message" class="text-sm text-error">{{ message }}</p>

          </UForm>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton variant="ghost" color="neutral" label="Cancel" :disabled="busy" @click="editorOpen = false" />
            <UButton type="submit" :loading="busy" :label="isEdit ? 'Save changes' : 'Create task'" form="task-editor-form" />
          </div>
        </template>
      </UModal>

      <!-- delete confirm -->
      <UModal v-model:open="deleteOpen" title="Delete task" :ui="{ content: 'max-w-sm' }">
        <template #body>
          <p class="text-sm text-zinc-600 dark:text-zinc-300">
            Delete <span class="font-semibold text-zinc-900 dark:text-white">{{ pendingDelete?.title }}</span>?
            This cannot be undone.
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
</UDashboardPanel>
</template>
