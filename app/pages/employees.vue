<script setup lang="ts">
// Employees (LIVE): oRPC live query over tandem_user + supervision graph +
// AI extension rows. Mutations ride the same change-bus — every client
// updates instantly. AI-ness is derived (extension row exists), never a
// column, and kind is immutable after create.
import type { ApiKeyRow, EmployeeRow, EnvironmentRow } from '~/../shared/types'
import { useQuery, useMutation } from '@tanstack/vue-query'

const { $orpc } = useNuxtApp()

const liveQuery = useQuery(($orpc as any).employees.live.liveOptions())
const rows = computed<EmployeeRow[]>(() => (unref(liveQuery.data) ?? []) as EmployeeRow[])

const envQuery = useQuery(($orpc as any).environments.live.liveOptions())
const environments = computed<EnvironmentRow[]>(() => (unref(envQuery.data) ?? []) as EnvironmentRow[])

const byId = computed(() => new Map(rows.value.map(r => [r.id, r])))
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
        title: form.title,
        supervisorIds: form.supervisorIds,
        ...(showAiFields.value && form.environmentId ? { environmentId: form.environmentId } : {}),
        ...(showAiFields.value ? { instructions: form.instructions } : {}),
      })
    }
    else {
      const res = await createMutation.mutateAsync({
        name: form.name,
        email: form.email,
        kind: form.kind,
        title: form.title,
        supervisorIds: form.supervisorIds,
        ...(form.kind === 'ai' ? { environmentId: form.environmentId, instructions: form.instructions } : {}),
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

// ---- API keys drawer (AI employees) ----
const keysOpen = ref(false)
const keysEmployee = ref<EmployeeRow | null>(null)
const keys = ref<ApiKeyRow[]>([])
const keysBusy = ref(false)
const keysMessage = ref('')
const freshKey = ref('')

async function openKeys(row: EmployeeRow) {
  keysEmployee.value = row
  keysOpen.value = true
  keysMessage.value = ''
  freshKey.value = ''
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
    const res = await createKeyMutation.mutateAsync({ employeeId: keysEmployee.value.id })
    freshKey.value = res.key as string
    await refreshKeys()
  }
  catch (e) {
    keysMessage.value = e instanceof Error ? e.message : 'mint failed'
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
      <UButton icon="i-lucide-plus" label="New employee" @click="openEditor()" />
    </div>

    <p v-if="message && !editorOpen" class="text-sm text-error">{{ message }}</p>

    <!-- Mobile: stacked cards -->
    <div v-if="rows.length" class="space-y-3 md:hidden">
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
          <UButton
            v-if="row.kind === 'ai'" icon="i-lucide-key-round" variant="ghost" color="neutral" size="sm"
            aria-label="API keys" :disabled="busy" @click="openKeys(row)"
          />
          <UButton icon="i-lucide-pencil" variant="ghost" color="neutral" size="sm" aria-label="Edit employee" :disabled="busy" @click="openEditor(row)" />
          <UButton icon="i-lucide-trash-2" variant="ghost" color="error" size="sm" aria-label="Delete employee" :disabled="busy" @click="askRemove(row)" />
        </div>
      </UCard>
    </div>

    <!-- Desktop: table -->
    <UCard v-if="rows.length" :ui="{ root: 'shadow-sm hidden md:block', body: 'p-0 sm:p-0' }">
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
            <UButton
              v-if="row.original.kind === 'ai'"
              icon="i-lucide-key-round"
              variant="ghost"
              color="neutral"
              size="sm"
              aria-label="API keys"
              :disabled="busy"
              @click="openKeys(row.original)"
            />
            <UButton icon="i-lucide-pencil" variant="ghost" color="neutral" size="sm" aria-label="Edit employee" :disabled="busy" @click="openEditor(row.original)" />
            <UButton icon="i-lucide-trash-2" variant="ghost" color="error" size="sm" aria-label="Delete employee" :disabled="busy" @click="askRemove(row.original)" />
          </div>
        </template>
            </UTable>
    </UCard>

    <UCard v-else :ui="{ root: 'shadow-sm' }">
      <div class="flex flex-col items-center gap-2 py-8 text-center">
        <UIcon name="i-lucide-users" class="size-8 text-zinc-300" />
        <p class="text-sm text-zinc-500">No employees yet — add the first human or AI teammate.</p>
        <UButton icon="i-lucide-plus" size="sm" label="New employee" @click="openEditor()" />
      </div>
    </UCard>

    <UModal v-model:open="editorOpen" :title="isEdit ? 'Edit employee' : 'New employee'" :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]' }">
      <template #body>
        <div class="max-h-[55dvh] overflow-y-auto px-4 sm:px-6">
        <UForm :state="form" class="space-y-4" @submit="save">
          <UFormField label="Name" name="name">
            <UInput v-model="form.name" icon="i-lucide-user" placeholder="Full name" class="w-full" required />
          </UFormField>
          <UFormField v-if="!isEdit" label="Email (login)" name="email">
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
          <div v-else class="sticky bottom-0 -mx-4 mt-2 flex justify-end gap-2 border-t border-zinc-200 bg-white/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6 dark:border-zinc-800 dark:bg-zinc-950/95">
            <UButton variant="ghost" color="neutral" label="Cancel" @click="editorOpen = false" />
            <UButton type="submit" :loading="busy" label="Save" />
          </div>
        </UForm>
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
          <div class="flex justify-end gap-2">
            <UButton variant="ghost" color="neutral" label="Cancel" @click="pendingDelete = null" />
            <UButton icon="i-lucide-trash-2" color="error" label="Delete" :loading="busy" @click="remove" />
          </div>
        </div>
      </template>
    </UModal>

    <UModal v-model:open="keysOpen" :title="`API keys — ${keysEmployee?.name ?? ''}`">
      <template #body>
        <div class="space-y-3">
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
              <div class="min-w-0">
                <p class="truncate text-sm text-zinc-900 dark:text-white">{{ k.name ?? 'unnamed' }}</p>
                <p class="font-mono text-xs text-zinc-400">{{ k.prefix }}{{ k.start }}… · created {{ new Date(k.createdAt).toLocaleDateString() }}</p>
              </div>
              <UButton icon="i-lucide-trash-2" variant="ghost" color="error" size="xs" aria-label="Revoke key" :loading="keysBusy" @click="revokeKey(k.id)" />
            </div>
          </div>
          <p v-else-if="!keysBusy" class="text-sm text-zinc-500">No keys.</p>
          <div class="flex justify-end gap-2 pt-1">
            <UButton icon="i-lucide-key-round" size="sm" label="Mint new key" :loading="keysBusy" @click="mintKey" />
          </div>
        </div>
      </template>
    </UModal>
  </div>
  </UDashboardPanel>
</template>
