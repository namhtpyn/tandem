<script setup lang="ts">
import { PROVIDER_KIND, endpointKind, isModelsEndpoint } from '#shared/api-styles'
// Employees (LIVE): oRPC live query over tandem_user + supervision graph +
// AI extension rows. Mutations ride the same change-bus — every client
// updates instantly. AI-ness is derived (extension row exists), never a
// column, and kind is immutable after create.
import type { ApiKeyRow, EmployeeRow, EnvironmentRow } from '~/../shared/types'
import { useQuery, useMutation } from '@tanstack/vue-query'

const { $orpc, $client } = useNuxtApp()

const liveQuery = useQuery(($orpc as any).employees.live.liveOptions())
const rows = computed<EmployeeRow[]>(() => (unref(liveQuery.data) ?? []) as EmployeeRow[])

const envQuery = useQuery(($orpc as any).environments.live.liveOptions())
const environments = computed<EnvironmentRow[]>(() => (unref(envQuery.data) ?? []) as EnvironmentRow[])

const byId = computed(() => new Map(rows.value.map(r => [r.id, r])))

// ---- graph (hierarchy) view ----
const view = ref<'list' | 'graph'>('list')
/** children map: supervisorId -> direct reports (in row order) */
const childrenOf = computed(() => {
  const m = new Map<string, EmployeeRow[]>()
  for (const r of rows.value) {
    for (const sup of r.supervisorIds) {
      const arr = m.get(sup) ?? []
      arr.push(r)
      m.set(sup, arr)
    }
  }
  return m
})
/** roots = employees with no supervisor (or supervisor missing) */
const roots = computed(() => rows.value.filter(r => r.supervisorIds.length === 0 || r.supervisorIds.every(id => !byId.value.has(id))))
/** ordered node list for layout: DFS from roots */
const graphNodes = computed(() => {
  const out: Array<{ row: EmployeeRow, depth: number, parentIndex: number }> = []
  const indexById = new Map<string, number>()
  const seen = new Set<string>()
  const walk = (row: EmployeeRow, depth: number, parentIndex: number) => {
    if (seen.has(row.id)) return
    seen.add(row.id)
    indexById.set(row.id, out.length)
    out.push({ row, depth, parentIndex })
    for (const child of childrenOf.value.get(row.id) ?? []) walk(child, depth + 1, indexById.get(row.id)!)
  }
  for (const r of roots.value) walk(r, 0, -1)
  // orphans not reachable from roots (cycles — server guards them, belt and braces)
  for (const r of rows.value) if (!seen.has(r.id)) walk(r, 0, -1)
  return out
})
function nodeY(i: number) {
  return i * (NODE_H + ROW_GAP) + ROW_GAP / 2 - 12
}
const NODE_H = 56
const ROW_GAP = 24
const graphHeight = computed(() => graphNodes.value.length * (NODE_H + ROW_GAP) + ROW_GAP)
const maxDepthX = computed(() => Math.max(0, ...graphNodes.value.map(n => n.depth)) * 28)
const envName = (id: string | null) => environments.value.find(e => e.id === id)?.name ?? null

const createMutation = useMutation<any, any, any>(($orpc as any).employees.create.mutationOptions())
const updateMutation = useMutation<any, any, any>(($orpc as any).employees.update.mutationOptions())
const removeMutation = useMutation<any, any, any>(($orpc as any).employees.remove.mutationOptions())
const createKeyMutation = useMutation<any, any, any>(($orpc as any).employees.createApiKey.mutationOptions())
const revokeKeyMutation = useMutation<any, any, any>(($orpc as any).employees.revokeApiKey.mutationOptions())
const listKeysCall = ($orpc as any).employees.listApiKeys.call

// ---- editor ----
const editorOpen = ref(false)
const editingId = ref<string | null>(null)
const form = reactive({
  name: '',
  email: '',
  kind: 'human' as 'human' | 'ai',
  title: '',
  supervisorIds: [] as string[],
  environmentId: '' as string,
  instructions: '',
  harness: 'hermes' as 'hermes',
  executable: '',
  providerId: '__none__' as string,
  model: '',
  apiKeySecretId: null as string | null,
})
const busy = ref(false)
const message = ref('')
const mintedKey = ref('')
const copied = ref(false)

async function copyKey(key: string) {
  try {
    await navigator.clipboard.writeText(key)
    copied.value = true
    setTimeout(() => { copied.value = false }, 2000)
  }
  catch { /* clipboard unavailable — manual selection still possible */ }
}
const pendingDelete = ref<EmployeeRow | null>(null)
const deleteOpen = computed({
  get: () => pendingDelete.value !== null,
  set: (v: boolean) => { if (!v) pendingDelete.value = null },
})

const isEdit = computed(() => editingId.value !== null)
const editingIsAi = computed(() => (editingId.value ? byId.value.get(editingId.value)?.kind === 'ai' : false))
const showAiFields = computed(() => !isEdit.value ? form.kind === 'ai' : editingIsAi.value)

const supervisorItems = computed(() =>
  rows.value
    .filter(r => r.id !== editingId.value)
    .map(r => ({ label: r.name, value: r.id })),
)

const providersLive = useQuery(($orpc as any).providers.live.liveOptions())
const modelProviders = computed(() => ((unref(providersLive.data) ?? []) as Array<{ id: string, label: string, endpoints: string[] }>).filter(p => (p.endpoints ?? []).some(st => endpointKind(st) === PROVIDER_KIND.LLM)))
const modelItems = ref<string[]>([])
const modelLoading = ref(false)
const providerHasModelsEndpoint = computed(() => {
  const p = ((unref(providersLive.data) ?? []) as Array<{ id: string, endpoints: string[] }>).find(x => x.id === form.providerId)
  return (p?.endpoints ?? []).some(st => isModelsEndpoint(st))
})
watch([() => form.providerId, () => form.apiKeySecretId], async ([providerId, keySecretId]) => {
  modelItems.value = []
  if (providerId === '__none__' || !providerHasModelsEndpoint.value) return
  modelLoading.value = true
  try {
    const res = await ($client as any).providers.models({
      providerId,
      ...(keySecretId ? { keySecretId } : {}),
    })
    modelItems.value = res.models ?? []
  }
  catch { /* autocomplete is best-effort; freetext still allowed */ }
  finally {
    modelLoading.value = false
  }
}, { immediate: false })
const secretsLive = useQuery(($orpc as any).vault.live.liveOptions())
const secretItems = computed(() => ((unref(secretsLive.data) ?? []) as Array<{ id: string, name: string, lastFour: string }>)
  .map(sec => ({ label: `${sec.name} (•••• ${sec.lastFour})`, value: sec.id })))
const environmentItems = computed(() =>
  environments.value.map(e => ({ label: e.name, value: e.id })),
)

function openEditor(row?: EmployeeRow) {
  editingId.value = row?.id ?? null
  form.name = row?.name ?? ''
  form.email = row?.email ?? ''
  form.kind = row?.kind ?? 'human'
  form.title = row?.title ?? ''
  form.supervisorIds = row?.supervisorIds ? [...row.supervisorIds] : []
  form.environmentId = row?.environmentId ?? ''
  form.instructions = row?.instructions ?? ''
  form.harness = (row?.harness as 'hermes') ?? 'hermes'
  form.executable = row?.executable && row.executable !== 'hermes' ? row.executable : ''
  form.providerId = row?.providerId ?? '__none__'
  form.model = row?.model ?? ''
  form.apiKeySecretId = row?.apiKeySecretId ?? null
  message.value = ''
  mintedKey.value = ''
  editorOpen.value = true
}

async function save() {
  busy.value = true
  message.value = ''
  try {
    if (editingId.value) {
      await updateMutation.mutateAsync({
        id: editingId.value,
        name: form.name,
        email: form.email,
        title: form.title,
        supervisorIds: form.supervisorIds,
        ...(showAiFields.value && form.environmentId ? { environmentId: form.environmentId } : {}),
        ...(showAiFields.value ? { instructions: form.instructions } : {}),
        ...(showAiFields.value ? { harness: form.harness } : {}),
        ...(showAiFields.value && form.executable.trim() ? { executable: form.executable.trim() } : {}),
        ...(showAiFields.value ? { providerId: form.providerId === '__none__' ? null : form.providerId } : {}),
        ...(showAiFields.value ? { model: form.model || null } : {}),
        ...(showAiFields.value ? { apiKeySecretId: form.apiKeySecretId ?? null } : {}),
      })
    }
    else {
      const res = await createMutation.mutateAsync({
        name: form.name,
        email: form.email,
        kind: form.kind,
        title: form.title,
        supervisorIds: form.supervisorIds,
        ...(form.kind === 'ai' ? {
          environmentId: form.environmentId,
          instructions: form.instructions,
          harness: form.harness,
          ...(form.executable.trim() ? { executable: form.executable.trim() } : {}),
          providerId: form.providerId === '__none__' ? null : form.providerId,
          model: form.model || null,
          apiKeySecretId: form.apiKeySecretId ?? null,
        } : {}),
      })
      // the API key returns ONCE — surface it before the modal closes
      if (res?.apiKey) mintedKey.value = res.apiKey as string
    }
    if (!mintedKey.value) editorOpen.value = false
  }
  catch (e) {
    message.value = e instanceof Error ? e.message : 'save failed'
  }
  finally {
    busy.value = false
  }
}

function askRemove(row: EmployeeRow) {
  pendingDelete.value = row
}

async function remove() {
  if (!pendingDelete.value) return
  busy.value = true
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

// ---- Access keys drawer (any employee) ----
const keysOpen = ref(false)
const keysEmployee = ref<EmployeeRow | null>(null)
const keys = ref<ApiKeyRow[]>([])
const keysBusy = ref(false)
const keysMessage = ref('')
const freshKey = ref('')
const mintName = ref('')
const renamingId = ref<string | null>(null)
const renameValue = ref('')

async function openKeys(row: EmployeeRow) {
  keysEmployee.value = row
  keysOpen.value = true
  keysMessage.value = ''
  freshKey.value = ''
  mintName.value = ''
  await refreshKeys()
}

async function refreshKeys() {
  if (!keysEmployee.value) return
  keysBusy.value = true
  try {
    keys.value = await listKeysCall({ employeeId: keysEmployee.value.id }) as ApiKeyRow[]
  }
  catch (e) {
    keysMessage.value = e instanceof Error ? e.message : 'load failed'
  }
  finally {
    keysBusy.value = false
  }
}

async function mintKey() {
  if (!keysEmployee.value) return
  keysBusy.value = true
  keysMessage.value = ''
  try {
    const res = await createKeyMutation.mutateAsync({ employeeId: keysEmployee.value.id, ...(mintName.value.trim() ? { name: mintName.value.trim() } : {}) })
    freshKey.value = res.key as string
    mintName.value = ''
    await refreshKeys()
  }
  catch (e) {
    keysMessage.value = e instanceof Error ? e.message : 'mint failed'
  }
  finally {
    keysBusy.value = false
  }
}

async function startRename(k: ApiKeyRow) {
  renamingId.value = k.id
  renameValue.value = k.name ?? ''
}

async function saveRename() {
  if (!renamingId.value || !renameValue.value.trim()) return
  keysBusy.value = true
  try {
    await ($client as any).employees.updateApiKey({ keyId: renamingId.value, name: renameValue.value.trim() })
    renamingId.value = null
    await refreshKeys()
  }
  catch (e) {
    keysMessage.value = e instanceof Error ? e.message : 'rename failed'
  }
  finally {
    keysBusy.value = false
  }
}

async function revokeKey(keyId: string) {
  keysBusy.value = true
  keysMessage.value = ''
  try {
    await revokeKeyMutation.mutateAsync({ keyId })
    await refreshKeys()
  }
  catch (e) {
    keysMessage.value = e instanceof Error ? e.message : 'revoke failed'
  }
  finally {
    keysBusy.value = false
  }
}

const columns = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'title', header: 'Title' },
  { accessorKey: 'kind', header: 'Kind' },
  { accessorKey: 'supervisors', header: 'Supervisors' },
  { accessorKey: 'environment', header: 'Environment' },
  { accessorKey: 'actions', header: '' },
]
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <template #body>
      <UDashboardNavbar title="Employees">
      <template #leading>
        <UDashboardSidebarCollapse />
      </template>
    </UDashboardNavbar>
      <div class="space-y-6 p-6 lg:p-8">
    <div class="flex flex-wrap items-end justify-between gap-2">
      <div>
                <p class="text-sm text-zinc-500">Humans and AI agents, one hierarchy — every employee is a login</p>
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
            :class="view === 'graph' ? 'bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-400' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'"
            aria-label="Graph view"
            @click="view = 'graph'"
          >Graph</button>
        </div>
        <UButton icon="i-lucide-plus" label="New employee" @click="openEditor()" />
      </div>
    </div>

    <p v-if="message && !editorOpen" class="text-sm text-error">{{ message }}</p>

    <!-- Mobile: stacked cards (list view) -->
    <div v-if="rows.length && view === 'list'" class="space-y-3 md:hidden">
      <UCard v-for="row in rows" :key="row.id" :ui="{ root: 'shadow-sm' }">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="truncate text-sm font-medium text-zinc-900 dark:text-white">{{ row.name }}</p>
            <p class="truncate font-mono text-xs text-zinc-400">{{ row.email }}</p>
            <p v-if="row.title" class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{{ row.title }}</p>
          </div>
          <UBadge :color="row.kind === 'ai' ? 'primary' : 'neutral'" variant="subtle" size="sm" :icon="row.kind === 'ai' ? 'i-lucide-bot' : 'i-lucide-user'">
            {{ row.kind }}
          </UBadge>
        </div>
        <div v-if="row.supervisorIds.length || (row.kind === 'ai' && row.environmentId)" class="mt-2 flex flex-wrap gap-1">
          <UBadge v-for="sid in row.supervisorIds" :key="sid" color="neutral" variant="soft" size="sm">
            {{ byId.get(sid)?.name ?? sid.slice(0, 8) }}
          </UBadge>
          <UBadge v-if="row.kind === 'ai' && row.environmentId" color="info" variant="soft" size="sm" icon="i-lucide-server">
            {{ envName(row.environmentId) }}
          </UBadge>
        </div>
        <div class="mt-3 flex justify-end gap-1">
          <UPopover mode="hover">
            <UButton
            icon="i-lucide-key-round" variant="ghost" color="neutral" size="sm"
            aria-label="Access keys" :disabled="busy" @click="openKeys(row)"
          />
            <template #content>
              <div class="px-3 py-1.5 text-xs">Access keys</div>
            </template>
          </UPopover>
          <UPopover mode="hover">
            <UButton icon="i-lucide-pencil" variant="ghost" color="neutral" size="sm" aria-label="Edit employee" :disabled="busy" @click="openEditor(row)" />
            <template #content>
              <div class="px-3 py-1.5 text-xs">Edit employee</div>
            </template>
          </UPopover>
          <UPopover mode="hover">
            <UButton icon="i-lucide-trash-2" variant="ghost" color="error" size="sm" aria-label="Delete employee" :disabled="busy" @click="askRemove(row)" />
            <template #content>
              <div class="px-3 py-1.5 text-xs">Delete employee</div>
            </template>
          </UPopover>
        </div>
      </UCard>
    </div>

    <!-- Desktop: table -->
    <UCard v-if="rows.length && view === 'list'" :ui="{ root: 'shadow-sm hidden md:block', body: 'p-0 sm:p-0' }">
      <UTable :data="rows" :columns="columns">
        <template #name-cell="{ row }">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium text-zinc-900 dark:text-white">{{ row.original.name }}</span>
            <span class="truncate font-mono text-xs text-zinc-400">{{ row.original.email }}</span>
          </div>
        </template>
        <template #title-cell="{ row }">
          <span class="text-sm text-zinc-600 dark:text-zinc-300">{{ row.original.title }}</span>
        </template>
        <template #kind-cell="{ row }">
          <UBadge :color="row.original.kind === 'ai' ? 'primary' : 'neutral'" variant="subtle" size="sm" :icon="row.original.kind === 'ai' ? 'i-lucide-bot' : 'i-lucide-user'">
            {{ row.original.kind }}
          </UBadge>
        </template>
        <template #supervisors-cell="{ row }">
          <div class="flex flex-wrap gap-1">
            <template v-if="row.original.supervisorIds.length">
              <UBadge v-for="sid in row.original.supervisorIds" :key="sid" color="neutral" variant="soft" size="sm">
                {{ byId.get(sid)?.name ?? sid.slice(0, 8) }}
              </UBadge>
            </template>
            <span v-else class="text-xs text-zinc-400">—</span>
          </div>
        </template>
        <template #environment-cell="{ row }">
          <span v-if="row.original.kind === 'ai' && row.original.environmentId" class="font-mono text-xs text-zinc-500">{{ envName(row.original.environmentId) }}</span>
          <span v-else class="text-xs text-zinc-400">—</span>
        </template>
        <template #actions-cell="{ row }">
          <div class="flex justify-end gap-1">
            <UPopover mode="hover">
              <UButton
              icon="i-lucide-key-round"
              variant="ghost"
              color="neutral"
              size="sm"
              aria-label="Access keys"
              :disabled="busy"
              @click="openKeys(row.original)"
            />
              <template #content>
                <div class="px-3 py-1.5 text-xs">Access keys</div>
              </template>
            </UPopover>
            <UPopover mode="hover">
              <UButton icon="i-lucide-pencil" variant="ghost" color="neutral" size="sm" aria-label="Edit employee" :disabled="busy" @click="openEditor(row.original)" />
              <template #content>
                <div class="px-3 py-1.5 text-xs">Edit employee</div>
              </template>
            </UPopover>
            <UPopover mode="hover">
              <UButton icon="i-lucide-trash-2" variant="ghost" color="error" size="sm" aria-label="Delete employee" :disabled="busy" @click="askRemove(row.original)" />
              <template #content>
                <div class="px-3 py-1.5 text-xs">Delete employee</div>
              </template>
            </UPopover>
          </div>
        </template>
            </UTable>
    </UCard>

    <UCard v-else-if="view === 'list'" :ui="{ root: 'shadow-sm' }">
      <div class="flex flex-col items-center gap-2 py-8 text-center">
        <UIcon name="i-lucide-users" class="size-8 text-zinc-300" />
        <p class="text-sm text-zinc-500">No employees yet — add the first human or AI teammate.</p>
        <UButton icon="i-lucide-plus" size="sm" label="New employee" @click="openEditor()" />
      </div>
    </UCard>

    <!-- graph view: supervision hierarchy -->
    <UCard v-if="view === 'graph'" :ui="{ root: 'shadow-sm', body: 'p-0 sm:p-0' }">
      <div v-if="!rows.length" class="flex flex-col items-center gap-2 py-10 text-center">
        <UIcon name="i-lucide-users" class="size-8 text-zinc-300" />
        <p class="text-sm text-zinc-500">No employees yet.</p>
      </div>
      <div v-else class="overflow-x-auto p-4">
        <svg :width="Math.max(360, maxDepthX + 290)" :height="graphHeight" role="img" aria-label="Supervision hierarchy">
          <template v-for="(n, i) in graphNodes" :key="n.row.id">
            <path
              v-if="n.parentIndex >= 0"
              :d="`M ${(n.depth - 1) * 28 + 24} ${nodeY(n.parentIndex) + NODE_H} V ${nodeY(i) + NODE_H / 2} H ${n.depth * 28}`"
              fill="none"
              class="stroke-zinc-300 dark:stroke-zinc-700"
              stroke-width="1.5"
            />
            <g :transform="`translate(${n.depth * 28}, ${nodeY(i)})`">
              <rect width="248" :height="NODE_H" rx="10" class="fill-white stroke-zinc-200 dark:fill-zinc-900 dark:stroke-zinc-700" stroke-width="1.5" />
              <circle cx="24" :cy="NODE_H / 2" r="14" :class="n.row.kind === 'ai' ? 'fill-primary-100 stroke-primary-400 dark:fill-primary-500/20' : 'fill-zinc-100 stroke-zinc-300 dark:fill-zinc-800'" stroke-width="1.5" />
              <text x="24" :y="NODE_H / 2 + 4" text-anchor="middle" class="fill-zinc-600 text-[11px] font-semibold dark:fill-zinc-300">{{ n.row.kind === 'ai' ? 'AI' : n.row.name.slice(0, 1) }}</text>
              <text x="48" y="24" class="fill-zinc-900 text-[13px] font-medium dark:fill-white">{{ n.row.name.length > 24 ? n.row.name.slice(0, 24) + '…' : n.row.name }}</text>
              <text x="48" :y="NODE_H - 14" class="fill-zinc-400 text-[11px]">{{ (n.row.title || n.row.email).slice(0, 28) }}</text>
              <circle v-if="childrenOf.get(n.row.id)?.length" cx="240" :cy="NODE_H / 2" r="4" class="fill-zinc-300" />
            </g>
          </template>
        </svg>
      </div>
    </UCard>

    <UModal v-model:open="editorOpen" :title="isEdit ? 'Edit employee' : 'New employee'" :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]' }">
      <template #body>
        <div class="max-h-[55dvh] overflow-y-auto px-4 sm:px-6">
        <UForm id="employee-editor-form" :state="form" class="space-y-4" @submit="save">
          <UFormField label="Name" name="name">
            <UInput v-model="form.name" icon="i-lucide-user" placeholder="Full name" class="w-full" required />
          </UFormField>
          <UFormField label="Email (login)" name="email">
            <template #hint><FormHint text="Humans sign in with it; AI employees authenticate by API key" /></template>
            <UInput v-model="form.email" icon="i-lucide-at-sign" placeholder="name@company.com" class="w-full" required />
          </UFormField>
          <UFormField v-if="!isEdit" label="Kind" name="kind">
            <URadioGroup
              v-model="form.kind"
              :items="[
                { label: 'Human — password/SSO login', value: 'human' },
                { label: 'AI agent — API key, runs on an environment', value: 'ai' },
              ]"
              variant="card"
              class="w-full"
            />
          </UFormField>
          <UFormField v-else name="kind">
            <UBadge :color="editingIsAi ? 'primary' : 'neutral'" variant="subtle" :icon="editingIsAi ? 'i-lucide-bot' : 'i-lucide-user'">
              {{ editingIsAi ? 'AI agent (immutable)' : 'Human (immutable)' }}
            </UBadge>
          </UFormField>
          <UFormField label="Title" name="title">
            <template #hint><FormHint text="Place in the company, e.g. Senior Engineer" /></template>
            <UInput v-model="form.title" icon="i-lucide-briefcase" placeholder="Job title" class="w-full" required />
          </UFormField>
          <UFormField label="Supervisors" name="supervisorIds">
            <template #hint><FormHint text="Many-to-many — an employee can report to several" /></template>
            <USelectMenu
              v-model="form.supervisorIds"
              :items="supervisorItems"
              multiple
              value-key="value"
              placeholder="No supervisors"
              class="w-full"
            />
          </UFormField>
          <template v-if="showAiFields">
            <UFormField label="Environment" name="environmentId">
            <template #hint><FormHint text="SSH target this agent runs on" /></template>
              <USelectMenu
                v-model="form.environmentId"
                :items="environmentItems"
                value-key="value"
                placeholder="Select an environment"
                class="w-full"
              />
            </UFormField>
            <UFormField label="Harness" name="harness">
              <template #hint><FormHint text="Agent harness that runs this employee" /></template>
              <USelectMenu
                v-model="form.harness"
                :items="[{ label: 'Hermes agents', value: 'hermes' }]"
                value-key="value"
                placeholder="Select a harness"
                class="w-full"
              />
            </UFormField>
            <UFormField label="Executable" name="executable">
              <template #hint><FormHint text="Executable name on the environment if not the default 'hermes'" /></template>
              <UInput
                v-model="form.executable"
                icon="i-lucide-terminal"
                placeholder="hermes (default)"
                class="w-full"
              />
            </UFormField>
            <UFormField label="Provider" name="providerId">
              <template #hint><FormHint text="Model endpoint this agent uses" /></template>
              <USelect
                v-model="form.providerId"
                :items="[{ label: 'No provider', value: '__none__' }, ...modelProviders.map(p => ({ label: p.label, value: p.id }))]"
                value-key="value"
                icon="i-lucide-plug"
                placeholder="Select a provider"
                class="w-full"
              />
            </UFormField>
            <UFormField label="Model" name="model">
              <template #hint><FormHint text="Model name the agent runs — pick from the list or type your own" /></template>
              <UInputMenu
                v-model="form.model"
                :items="modelItems"
                :loading="modelLoading"
                icon="i-lucide-cpu"
                placeholder="Model name"
                class="w-full"
              />
            </UFormField>
            <UFormField label="API key" name="apiKeySecretId">
              <template #hint><FormHint text="Vault secret holding the key (per-agent, injected per run)" /></template>
              <USelectMenu
                v-model="form.apiKeySecretId"
                :items="secretItems"
                value-key="value"
                :search-input="{ placeholder: 'Search secrets' }"
                clear
                icon="i-lucide-key-round"
                placeholder="Vault secret with the API key"
                class="w-full"
              />
            </UFormField>
            <UFormField label="Instructions" name="instructions">
            <template #hint><FormHint text="System prompt for this agent" /></template>
              <UTextarea v-model="form.instructions" :rows="4" placeholder="Custom instructions for this agent…" class="w-full" />
            </UFormField>
          </template>
          <UAlert
            v-if="message"
            icon="i-lucide-circle-alert"
            color="error"
            variant="subtle"
            :title="message"
            :ui="{ title: 'text-sm' }"
          />
          <div v-if="mintedKey" class="rounded-lg border-2 border-amber-400/70 bg-amber-50 p-4 dark:bg-amber-950/40">
            <p class="flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-200">
              <UIcon name="i-lucide-key-round" class="size-4" />
              API key created — shown only once
            </p>
            <p class="mt-1 text-xs text-amber-700 dark:text-amber-300">Copy it now; it cannot be retrieved later.</p>
            <div class="mt-3 flex items-center gap-2">
              <code class="flex-1 break-all rounded-md bg-white/70 px-2.5 py-2 font-mono text-sm text-amber-900 dark:bg-black/30 dark:text-amber-100">{{ mintedKey }}</code>
              <UButton
                :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
                :color="copied ? 'success' : 'neutral'"
                variant="soft"
                size="sm"
                :label="copied ? 'Copied' : 'Copy'"
                @click="copyKey(mintedKey)"
              />
            </div>
            <UButton class="mt-3" size="sm" color="primary" variant="solid" label="Done — I saved the key" @click="editorOpen = false" />
          </div>
        </UForm>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" label="Cancel" :disabled="busy" @click="editorOpen = false" />
          <UButton type="submit" :loading="busy" :label="isEdit ? 'Save changes' : 'Create employee'" form="employee-editor-form" />
        </div>
      </template>
    </UModal>

    <UModal v-model:open="deleteOpen" title="Delete employee" :ui="{ content: 'max-w-sm' }">
      <template #body>
        <div class="space-y-4">
          <p class="text-sm text-zinc-600 dark:text-zinc-300">
            Delete <span class="font-semibold text-zinc-900 dark:text-white">{{ pendingDelete?.name }}</span>
            ({{ pendingDelete?.email }})? Their login, supervision links, API keys{{ pendingDelete?.kind === 'ai' ? ', and AI extension' : '' }} are removed permanently.
          </p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" label="Cancel" @click="pendingDelete = null" />
          <UButton icon="i-lucide-trash-2" color="error" label="Delete" :loading="busy" @click="remove" />
        </div>
      </template>
    </UModal>

    <UModal v-model:open="keysOpen" :title="`Access keys — ${keysEmployee?.name ?? ''}`">
      <template #body>
        <div class="space-y-3">
          <p class="text-xs text-zinc-500 dark:text-zinc-400">
            Access keys authenticate API calls to Tandem as {{ keysEmployee?.name ?? 'this employee' }} — nothing to do with the model provider API key in the editor.
          </p>
          <p v-if="keysMessage" class="text-sm text-error">{{ keysMessage }}</p>
          <div v-if="freshKey" class="rounded-lg border-2 border-amber-400/70 bg-amber-50 p-4 dark:bg-amber-950/40">
            <p class="flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-200">
              <UIcon name="i-lucide-key-round" class="size-4" />
              New key — shown only once
            </p>
            <div class="mt-3 flex items-center gap-2">
              <code class="flex-1 break-all rounded-md bg-white/70 px-2.5 py-2 font-mono text-sm text-amber-900 dark:bg-black/30 dark:text-amber-100">{{ freshKey }}</code>
              <UButton
                :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
                :color="copied ? 'success' : 'neutral'"
                variant="soft"
                size="sm"
                :label="copied ? 'Copied' : 'Copy'"
                @click="copyKey(freshKey)"
              />
            </div>
          </div>
          <div v-if="keys.length" class="divide-y divide-zinc-200 dark:divide-zinc-800">
            <div v-for="k in keys" :key="k.id" class="flex items-center justify-between gap-2 py-2">
              <div v-if="renamingId !== k.id" class="min-w-0">
                <p class="truncate text-sm text-zinc-900 dark:text-white">{{ k.name ?? 'unnamed' }}</p>
                <p class="font-mono text-xs text-zinc-400">{{ k.prefix }}{{ k.start }}… · created {{ new Date(k.createdAt).toLocaleDateString() }}</p>
              </div>
              <div v-else class="flex min-w-0 flex-1 items-center gap-1">
                <UInput v-model="renameValue" size="xs" placeholder="Key name" class="flex-1" @keydown.enter.prevent="saveRename" />
                <UPopover mode="hover"><UButton icon="i-lucide-check" variant="ghost" color="primary" size="xs" aria-label="Save name" :loading="keysBusy" @click="saveRename" /><template #content><div class="px-3 py-1.5 text-xs">Save name</div></template></UPopover>
                <UPopover mode="hover"><UButton icon="i-lucide-x" variant="ghost" color="neutral" size="xs" aria-label="Cancel rename" @click="renamingId = null" /><template #content><div class="px-3 py-1.5 text-xs">Cancel</div></template></UPopover>
              </div>
              <div v-if="renamingId !== k.id" class="flex shrink-0 gap-1">
                <UPopover mode="hover"><UButton icon="i-lucide-pencil" variant="ghost" color="neutral" size="xs" aria-label="Rename key" :disabled="keysBusy" @click="startRename(k)"/><template #content><div class="px-3 py-1.5 text-xs">Rename key</div></template></UPopover>
                <UPopover mode="hover"><UButton icon="i-lucide-trash-2" variant="ghost" color="error" size="xs" aria-label="Revoke key" :loading="keysBusy" @click="revokeKey(k.id)" /><template #content><div class="px-3 py-1.5 text-xs">Revoke key</div></template></UPopover>
              </div>
            </div>
          </div>
          <p v-else-if="!keysBusy" class="text-sm text-zinc-500">No keys.</p>
          <UFormField label="Key name" name="mintName" class="pt-1">
            <UInput v-model="mintName" icon="i-lucide-tag" placeholder="e.g. ci-deploy (optional)" class="w-full" />
          </UFormField>
          <div class="flex justify-end gap-2 pt-1">
            <UButton icon="i-lucide-key-round" size="sm" label="Mint new key" :loading="keysBusy" @click="mintKey" />
          </div>
        </div>
      </template>
    </UModal>
  </div>
    </template>
</UDashboardPanel>
</template>
