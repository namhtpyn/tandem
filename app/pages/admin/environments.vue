<script setup lang="ts">
// Environments (LIVE): oRPC live query — the table is a streaming snapshot;
// mutations go through oRPC and every client (this tab or another) updates
// instantly via the change bus + SSE.
import type { EnvironmentRow } from '~/../shared/types'
import { useQuery, useMutation } from '@tanstack/vue-query'

const { $orpc } = useNuxtApp()

const liveQuery = useQuery(($orpc as any).environments.live.liveOptions())
const rows = computed<EnvironmentRow[]>(() => (unref(liveQuery.data) ?? []) as EnvironmentRow[])

const editorOpen = ref(false)
const editingId = ref<string | null>(null)
const form = reactive({ name: '', host: '', port: '22', username: '' })
const busy = ref(false)
const message = ref('')
const probingId = ref<string | null>(null)
const pendingDelete = ref<EnvironmentRow | null>(null)
const deleteOpen = computed({
  get: () => pendingDelete.value !== null,
  set: (v: boolean) => { if (!v) pendingDelete.value = null },
})
const probeResults = ref<Record<string, { ok: boolean, detail: string, durationMs: number }>>({})

const createMutation = useMutation<any, any, any>(($orpc as any).environments.create.mutationOptions())
const updateMutation = useMutation<any, any, any>(($orpc as any).environments.update.mutationOptions())
const removeMutation = useMutation<any, any, any>(($orpc as any).environments.remove.mutationOptions())
const probeCall = ($orpc as any).environments.probe.call

const columns = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'host', header: 'Host' },
  { accessorKey: 'port', header: 'Port' },
  { accessorKey: 'username', header: 'User' },
  { accessorKey: 'probe', header: 'Connection' },
  { accessorKey: 'actions', header: '' },
]

function openEditor(row?: EnvironmentRow) {
  editingId.value = row?.id ?? null
  form.name = row?.name ?? ''
  form.host = row?.host ?? ''
  form.port = row?.port ?? '22'
  form.username = row?.username ?? ''
  message.value = ''
  editorOpen.value = true
}

async function save() {
  busy.value = true
  message.value = ''
  try {
    if (editingId.value) {
      await updateMutation.mutateAsync({ id: editingId.value, ...form })
    }
    else {
      await createMutation.mutateAsync({ ...form })
    }
    editorOpen.value = false
  }
  catch (e) {
    message.value = e instanceof Error ? e.message : 'save failed'
  }
  finally {
    busy.value = false
  }
  // live query pushes the fresh snapshot — no invalidation needed
}

function askRemove(row: EnvironmentRow) {
  pendingDelete.value = row
}

async function remove() {
  if (!pendingDelete.value) return
  busy.value = true
  message.value = ''
  try {
    await removeMutation.mutateAsync({ id: pendingDelete.value.id })
    pendingDelete.value = null
  }
  catch (e) {
    pendingDelete.value = null
    message.value = e instanceof Error ? e.message : 'delete failed'
  }
  finally {
    busy.value = false
  }
}

async function probe(row: EnvironmentRow) {
  probingId.value = row.id
  message.value = ''
  try {
    const res = await probeCall({ id: row.id })
    probeResults.value[row.id] = res as { ok: boolean, detail: string, durationMs: number }
  }
  catch (e) {
    probeResults.value[row.id] = { ok: false, detail: e instanceof Error ? e.message : 'probe failed', durationMs: 0 }
  }
  finally {
    probingId.value = null
  }
}
</script>

<template>
  <div class="space-y-6 p-6 lg:p-8">
    <div class="flex flex-wrap items-end justify-between gap-2">
      <div>
        <h2 class="text-lg font-semibold text-zinc-900 dark:text-white">Environments
          <span class="ml-1 inline-flex items-center gap-1 align-middle text-xs font-normal text-zinc-400"><span class="relative flex size-1.5"><span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" /><span class="relative inline-flex size-1.5 rounded-full bg-emerald-500" /></span>live</span>
        </h2>
        <p class="text-sm text-zinc-500">SSH targets that run the Hermes agent</p>
      </div>
      <UButton icon="i-lucide-plus" label="New environment" @click="openEditor()" />
    </div>

    <p v-if="message && !editorOpen" class="text-sm text-error">{{ message }}</p>

    <UCard v-if="rows.length" :ui="{ root: 'shadow-sm', body: 'p-0 sm:p-0' }">
      <UTable :data="rows" :columns="columns">
        <template #name-cell="{ row }">
          <span class="text-sm font-medium text-zinc-900 dark:text-white">{{ row.original.name }}</span>
        </template>
        <template #host-cell="{ row }">
          <span class="font-mono text-xs text-zinc-500">{{ row.original.username }}@{{ row.original.host }}:{{ row.original.port }}</span>
        </template>
        <template #probe-cell="{ row }">
          <div class="flex items-center gap-2">
            <template v-if="probeResults[row.original.id]">
              <UBadge :color="probeResults[row.original.id]!.ok ? 'success' : 'error'" variant="subtle" size="sm">
                {{ probeResults[row.original.id]!.ok ? 'ok' : 'failed' }}
              </UBadge>
              <span class="truncate text-xs text-zinc-400" :title="probeResults[row.original.id]!.detail">
                {{ probeResults[row.original.id]!.detail }} · {{ probeResults[row.original.id]!.durationMs }}ms
              </span>
            </template>
            <span v-else class="text-xs text-zinc-400">not probed</span>
          </div>
        </template>
        <template #actions-cell="{ row }">
          <div class="flex justify-end gap-1">
            <UButton
              icon="i-lucide-plug-zap"
              variant="ghost"
              color="neutral"
              size="sm"
              aria-label="Test connection"
              :loading="probingId === row.original.id"
              :disabled="busy || probingId !== null"
              @click="probe(row.original)"
            />
            <UButton icon="i-lucide-pencil" variant="ghost" color="neutral" size="sm" aria-label="Edit environment" :disabled="busy" @click="openEditor(row.original)" />
            <UButton icon="i-lucide-trash-2" variant="ghost" color="error" size="sm" aria-label="Delete environment" :disabled="busy" @click="askRemove(row.original)" />
          </div>
        </template>
      </UTable>
    </UCard>
    <UCard v-else :ui="{ root: 'shadow-sm' }">
      <div class="flex flex-col items-center gap-2 py-8 text-center">
        <UIcon name="i-lucide-server" class="size-8 text-zinc-300" />
        <p class="text-sm text-zinc-500">No environments yet — add the SSH target where your Hermes agents run.</p>
        <UButton icon="i-lucide-plus" size="sm" label="New environment" @click="openEditor()" />
      </div>
    </UCard>

    <UModal v-model:open="deleteOpen" title="Delete environment" :ui="{ content: 'max-w-sm' }">
      <template #body>
        <div class="space-y-4">
          <p class="text-sm text-zinc-600 dark:text-zinc-300">
            Delete environment <span class="font-semibold text-zinc-900 dark:text-white">{{ pendingDelete?.name }}</span>
            ({{ pendingDelete?.username }}@{{ pendingDelete?.host }})? AI agents configured on it will need reassigning.
          </p>
          <div class="flex justify-end gap-2">
            <UButton variant="ghost" color="neutral" label="Cancel" @click="pendingDelete = null" />
            <UButton icon="i-lucide-trash-2" color="error" label="Delete" :loading="busy" @click="remove" />
          </div>
        </div>
      </template>
    </UModal>

    <UModal v-model:open="editorOpen" :title="editingId ? 'Edit environment' : 'New environment'">
      <template #body>
        <UForm :state="form" class="space-y-4" @submit="save">
          <UFormField label="Name" name="name" hint="Unique label, e.g. ct112-tandem">
            <UInput v-model="form.name" icon="i-lucide-tag" placeholder="ct112-tandem" class="w-full" required />
          </UFormField>
          <UFormField label="Host" name="host">
            <UInput v-model="form.host" icon="i-lucide-server" placeholder="192.168.3.108" class="w-full" required />
          </UFormField>
          <UFormField label="Port" name="port">
            <UInput v-model="form.port" icon="i-lucide-network" placeholder="22" class="w-full" required />
          </UFormField>
          <UFormField label="Username" name="username" hint="Key auth only — the runner never uses passwords">
            <UInput v-model="form.username" icon="i-lucide-user" placeholder="tandem" class="w-full" required />
          </UFormField>
          <p v-if="message" class="text-sm text-error">{{ message }}</p>
          <div class="flex justify-end gap-2 pt-2">
            <UButton variant="ghost" color="neutral" label="Cancel" @click="editorOpen = false" />
            <UButton type="submit" :loading="busy" label="Save" />
          </div>
        </UForm>
      </template>
    </UModal>
  </div>
</template>
