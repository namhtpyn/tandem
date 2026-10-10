<script setup lang="ts">
// Tasks: work items for human + AI employees. Mobile-first card list with
// status pills; editor modal follows the shared structure (body + #footer).
import { useQuery, useMutation } from '@tanstack/vue-query'
import type { EmployeeRow, TaskRow } from '~/../shared/types'


const { $orpc, $client } = useNuxtApp()
const tasksLive = useQuery<TaskRow[]>(($orpc.tasks.live as any).liveOptions())
const employeesLive = useQuery<import('~/../shared/types').EmployeeRow[]>(($orpc.employees.live as any).liveOptions())

const tasks = computed(() => (unref(tasksLive.data) ?? []) as TaskRow[])
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

const form = reactive({ title: '', description: '', assigneeId: '__none__' as string, status: 'todo' as 'todo' | 'doing' | 'done' })
const isEdit = computed(() => editingId.value !== null)

const createMutation = useMutation<any, any, any>(($orpc.tasks.create as any).mutationOptions())
const updateMutation = useMutation<any, any, any>(($orpc.tasks.update as any).mutationOptions())
const removeMutation = useMutation<any, any, any>(($orpc.tasks.remove as any).mutationOptions())

const assigneeOptions = computed(() => [
  { label: 'Unassigned', value: '__none__' },
  ...employees.value.map(e => ({ label: `${e.name}${e.kind === 'ai' ? ' (AI)' : ''}`, value: e.id })),
])
const assigneeNameById = computed(() => new Map(employees.value.map(e => [e.id, e.name])))

const statusOptions = [
  { label: 'To do', value: 'todo' },
  { label: 'Doing', value: 'doing' },
  { label: 'Done', value: 'done' },
]

function openEditor(row?: TaskRow) {
  editingId.value = row?.id ?? null
  form.title = row?.title ?? ''
  form.description = row?.description ?? ''
  form.assigneeId = row?.assigneeId ?? '__none__'
  form.status = row?.status ?? 'todo'
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
    }
    if (editingId.value) {
      await updateMutation.mutateAsync({ id: editingId.value, ...payload, status: form.status })
    }
    else {
      await createMutation.mutateAsync(payload)
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

async function setStatus(row: TaskRow, status: 'todo' | 'doing' | 'done') {
  if (row.status === status) return
  await updateMutation.mutateAsync({ id: row.id, status })
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
  return s === 'done' ? 'success' : s === 'doing' ? 'warning' : 'neutral'
}
</script>

<template>
  <UDashboardPanel>
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
        <UButton icon="i-lucide-plus" label="New task" @click="openEditor()" />
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

      <!-- mobile cards -->
      <div v-if="tasks.length" class="space-y-3 md:hidden">
        <UCard v-for="row in tasks" :key="row.id" :ui="{ root: 'shadow-sm' }">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <p class="truncate font-medium text-zinc-900 dark:text-white">{{ row.title }}</p>
              <p class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-400">
                <span>{{ assigneeNameById.get(row.assigneeId ?? '') ?? 'Unassigned' }}</span>
                <span v-if="row.assigneeKind === 'ai'" class="inline-flex items-center gap-1 text-primary"><UIcon name="i-lucide-bot" class="size-3" />AI</span>
              </p>
            </div>
            <UBadge :color="statusColor(row.status)" variant="subtle" size="sm">{{ row.status }}</UBadge>
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
              @update:model-value="(v: string) => setStatus(row, v as 'todo' | 'doing' | 'done')"
            />
            <div class="flex items-center gap-1">
              <UButton icon="i-lucide-pencil" variant="ghost" color="neutral" size="xs" aria-label="Edit task" @click="openEditor(row)" />
              <UButton icon="i-lucide-trash-2" variant="ghost" color="error" size="xs" aria-label="Delete task" @click="pendingDelete = row" />
            </div>
          </div>
        </UCard>
      </div>

      <!-- desktop table -->
      <UCard v-if="tasks.length" :ui="{ root: 'shadow-sm', body: 'p-0 sm:p-0' }" class="hidden md:block">
        <UTable :data="tasks" :columns="[
          { accessorKey: 'title', header: 'Task' },
          { accessorKey: 'assignee', header: 'Assignee' },
          { accessorKey: 'status', header: 'Status' },
          { accessorKey: 'actions', header: '' },
        ]">
          <template #title-cell="{ row }">
            <div class="min-w-0">
              <p class="truncate font-medium text-zinc-900 dark:text-white">{{ row.original.title }}</p>
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
              @update:model-value="(v: string) => setStatus(row.original, v as 'todo' | 'doing' | 'done')"
            />
          </template>
          <template #actions-cell="{ row }">
            <div class="flex justify-end gap-1">
              <UButton icon="i-lucide-pencil" variant="ghost" color="neutral" size="xs" aria-label="Edit task" @click="openEditor(row.original)" />
              <UButton icon="i-lucide-trash-2" variant="ghost" color="error" size="xs" aria-label="Delete task" @click="pendingDelete = row.original" />
            </div>
          </template>
        </UTable>
      </UCard>

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
            <UFormField label="Assignee" name="assigneeId">
              <template #hint><FormHint text="Human or AI agent responsible" /></template>
              <USelect v-model="form.assigneeId" :items="assigneeOptions" value-key="value" icon="i-lucide-user-check" class="w-full" />
            </UFormField>
            <UFormField v-if="isEdit" label="Status" name="status">
              <USelect v-model="form.status" :items="statusOptions" value-key="value" icon="i-lucide-circle-dot" class="w-full" />
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
  </UDashboardPanel>
</template>
