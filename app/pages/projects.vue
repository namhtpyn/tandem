<script setup lang="ts">
// Projects: nestable containers for tasks. Mobile-first: stacked tree cards,
// desktop table; create/edit modal follows the #footer submit law.
import { computed, reactive, ref, unref } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { ProjectRow } from '~/../shared/types'

useSeoMeta({ title: 'Projects · Tandem' })

const { $orpc, $client } = useNuxtApp()
const queryClient = useQueryClient()

const liveQuery = useQuery(($orpc.projects.list as any).queryOptions({ queryKey: ['projects'] }))
const rows = computed(() => (unref(liveQuery.data) ?? []) as ProjectRow[])
const busy = ref(false)
const message = ref('')
const editorOpen = ref(false)
const editingId = ref<string | null>(null)
const confirmId = ref<string | null>(null)
const form = reactive({ name: '', description: '', parentId: '__none__' as string, status: 'active' as 'active' | 'archived' })

// flattened tree with depth for indentation
interface FlatRow extends ProjectRow { depth: number, path: string }
const flat = computed<FlatRow[]>(() => {
  const byParent = new Map<string | null, ProjectRow[]>()
  for (const r of rows.value) {
    const list = byParent.get(r.parentId) ?? []
    list.push(r)
    byParent.set(r.parentId, list)
  }
  const out: FlatRow[] = []
  const walk = (parent: string | null, depth: number, path: string) => {
    for (const r of (byParent.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      const label = depth === 0 ? r.name : `${path} / ${r.name}`
      out.push({ ...r, depth, path: label })
      walk(r.id, depth + 1, label)
    }
  }
  walk(null, 0, '')
  return out
})

// parent options for the picker: any project except self and its descendants
const parentItems = computed(() => {
  const excluded = new Set<string>()
  if (editingId.value) {
    excluded.add(editingId.value)
    const byParent = new Map<string | null, ProjectRow[]>()
    for (const r of rows.value) {
      const list = byParent.get(r.parentId) ?? []
      list.push(r)
      byParent.set(r.parentId, list)
    }
    const walk = (id: string) => {
      for (const c of (byParent.get(id) ?? [])) {
        excluded.add(c.id)
        walk(c.id)
      }
    }
    walk(editingId.value)
  }
  return [
    { label: 'No parent (top level)', value: '__none__' },
    ...flat.value.filter(r => !excluded.has(r.id)).map(r => ({ label: r.path, value: r.id })),
  ]
})

function openEditor(row?: FlatRow) {
  editingId.value = row?.id ?? null
  form.name = row?.name ?? ''
  form.description = row?.description ?? ''
  form.parentId = row?.parentId ?? '__none__'
  form.status = row?.status ?? 'active'
  message.value = ''
  editorOpen.value = true
}

async function save() {
  busy.value = true
  message.value = ''
  try {
    const payload = {
      name: form.name,
      description: form.description,
      parentId: form.parentId === '__none__' ? null : form.parentId,
      ...(editingId.value ? { status: form.status } : {}),
    }
    if (editingId.value) await ($client as any).projects.update({ id: editingId.value, ...payload })
    else await ($client as any).projects.create(payload)
    editorOpen.value = false
  }
  catch (e) {
    message.value = e instanceof Error ? e.message : 'save failed'
  }
  finally {
    busy.value = false
  }
}

async function askRemove(row: FlatRow) {
  confirmId.value = row.id
}

async function remove_() {
  if (!confirmId.value) return
  busy.value = true
  try {
    await ($client as any).projects.remove({ id: confirmId.value })
    confirmId.value = null
  }
  catch (e) {
    message.value = e instanceof Error ? e.message : 'delete failed'
  }
  finally {
    busy.value = false
  }
}

const statusColor = (s: string) => (s === 'archived' ? 'neutral' : 'success')
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #body>
      <UDashboardNavbar title="Projects">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
      </UDashboardNavbar>
      <div class="space-y-6 p-6 lg:p-8">
        <div class="flex flex-wrap items-end justify-between gap-2">
          <div>
            <p class="text-sm text-zinc-500">Group work into nestable projects</p>
          </div>
          <UButton icon="i-lucide-plus" label="New project" @click="openEditor()" />
        </div>

        <p v-if="message && !editorOpen" class="text-sm text-error">{{ message }}</p>

        <!-- Mobile: stacked tree cards -->
        <div v-if="flat.length" class="space-y-3 md:hidden">
          <UCard v-for="row in flat" :key="row.id" :ui="{ root: 'shadow-sm' }" :class="row.depth > 0 ? 'ml-4' : ''">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <p class="truncate text-sm font-medium text-zinc-900 dark:text-white">
                  <UIcon v-if="row.depth > 0" name="i-lucide-corner-down-right" class="mr-1 size-3.5 text-zinc-400" />
                  {{ row.name }}
                </p>
                <p v-if="row.description" class="mt-0.5 line-clamp-2 text-xs text-zinc-500">{{ row.description }}</p>
              </div>
              <UBadge :color="statusColor(row.status)" variant="subtle" size="sm">{{ row.status }}</UBadge>
            </div>
            <div class="mt-3 flex justify-end gap-1">
              <UPopover mode="hover">
                <UButton icon="i-lucide-plus" variant="ghost" color="neutral" size="sm" aria-label="Add subproject" @click="openEditor(undefined); form.parentId = row.id" />
                <template #content>
                  <div class="px-3 py-1.5 text-xs">Add subproject</div>
                </template>
              </UPopover>
              <UPopover mode="hover">
                <UButton icon="i-lucide-pencil" variant="ghost" color="neutral" size="sm" aria-label="Edit project" @click="openEditor(row)" />
                <template #content>
                  <div class="px-3 py-1.5 text-xs">Edit project</div>
                </template>
              </UPopover>
              <UPopover mode="hover">
                <UButton icon="i-lucide-trash-2" variant="ghost" color="error" size="sm" aria-label="Delete project" :disabled="busy" @click="askRemove(row)" />
                <template #content>
                  <div class="px-3 py-1.5 text-xs">Delete project</div>
                </template>
              </UPopover>
            </div>
          </UCard>
        </div>

        <!-- Desktop: table -->
        <UCard v-if="flat.length" :ui="{ root: 'shadow-sm hidden md:block', body: 'p-0 sm:p-0' }">
          <UTable :data="flat" :columns="[
            { accessorKey: 'name', header: 'Project' },
            { accessorKey: 'status', header: 'Status' },
            { accessorKey: 'actions', header: '' },
          ]">
            <template #name-cell="{ row }">
              <div class="min-w-0" :style="{ paddingLeft: `${row.original.depth * 1.25}rem` }">
                <p class="truncate font-medium text-zinc-900 dark:text-white">
                  <UIcon v-if="row.original.depth > 0" name="i-lucide-corner-down-right" class="mr-1 size-3.5 text-zinc-400" />
                  {{ row.original.name }}
                </p>
                <p v-if="row.original.description" class="truncate text-xs text-zinc-400">{{ row.original.description }}</p>
              </div>
            </template>
            <template #status-cell="{ row }">
              <UBadge :color="statusColor(row.original.status)" variant="subtle" size="sm">{{ row.original.status }}</UBadge>
            </template>
            <template #actions-cell="{ row }">
              <div class="flex justify-end gap-1">
                <UPopover mode="hover">
                  <UButton icon="i-lucide-plus" variant="ghost" color="neutral" size="xs" aria-label="Add subproject" @click="openEditor(undefined); form.parentId = row.original.id" />
                  <template #content>
                    <div class="px-3 py-1.5 text-xs">Add subproject</div>
                  </template>
                </UPopover>
                <UPopover mode="hover">
                  <UButton icon="i-lucide-pencil" variant="ghost" color="neutral" size="xs" aria-label="Edit project" @click="openEditor(row.original)" />
                  <template #content>
                    <div class="px-3 py-1.5 text-xs">Edit project</div>
                  </template>
                </UPopover>
                <UPopover mode="hover">
                  <UButton icon="i-lucide-trash-2" variant="ghost" color="error" size="xs" aria-label="Delete project" :disabled="busy" @click="askRemove(row.original)" />
                  <template #content>
                    <div class="px-3 py-1.5 text-xs">Delete project</div>
                  </template>
                </UPopover>
              </div>
            </template>
          </UTable>
        </UCard>

        <p v-else class="py-8 text-center text-sm text-zinc-500">No projects yet.</p>
      </div>

      <!-- editor modal -->
      <UModal v-model:open="editorOpen" :title="editingId ? 'Edit project' : 'New project'" :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]' }">
        <template #body>
          <UForm id="project-editor-form" :state="form" class="space-y-4" @submit="save">
            <UFormField label="Name" name="name">
              <UInput v-model="form.name" icon="i-lucide-folder" placeholder="Project name" class="w-full" required />
            </UFormField>
            <UFormField label="Parent" name="parentId">
              <template #hint><FormHint text="Nest this project under another" /></template>
              <USelectMenu
                v-model="form.parentId"
                :items="parentItems"
                value-key="value"
                :search-input="{ placeholder: 'Search projects' }"
                icon="i-lucide-folder-tree"
                placeholder="No parent (top level)"
                class="w-full"
              />
            </UFormField>
            <UFormField v-if="editingId" label="Status" name="status">
              <USelect v-model="form.status" :items="[{ label: 'Active', value: 'active' }, { label: 'Archived', value: 'archived' }]" value-key="value" icon="i-lucide-circle-dot" class="w-full" />
            </UFormField>
            <UFormField label="Description" name="description">
              <UTextarea v-model="form.description" placeholder="What this project is about" :rows="3" class="w-full" />
            </UFormField>
            <p v-if="message" class="text-sm text-error">{{ message }}</p>
          </UForm>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton variant="ghost" color="neutral" label="Cancel" :disabled="busy" @click="editorOpen = false" />
            <UButton type="submit" :loading="busy" :label="editingId ? 'Save changes' : 'Create project'" form="project-editor-form" />
          </div>
        </template>
      </UModal>

      <!-- delete confirm -->
      <UModal :open="confirmId !== null" title="Delete project" @update:open="confirmId = null">
        <template #body>
          <p class="text-sm text-zinc-600 dark:text-zinc-300">
            Delete this project? Its tasks become unscoped and subprojects move to the top level.
          </p>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton variant="ghost" color="neutral" label="Cancel" @click="confirmId = null" />
            <UButton color="error" label="Delete" :loading="busy" @click="remove_()" />
          </div>
        </template>
      </UModal>
    </template>
  </UDashboardPanel>
</template>
