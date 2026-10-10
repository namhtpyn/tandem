<script setup lang="ts">
// Secret vault: write-only secrets (AES-256-GCM server-side). Values are set
// once and never displayed again — only a last-4 hint. Mobile-first cards.
import { computed, ref } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import type { VaultAuditRow, VaultSecretRow } from '~/../shared/types'

const { $orpc } = useNuxtApp()
const queryClient = useQueryClient()

const liveQuery = useQuery<VaultSecretRow[]>(($orpc.vault.live as any).liveOptions())
const auditQuery = useQuery<VaultAuditRow[]>(($orpc.vault.audit as any).queryOptions({}))
const rows = computed(() => liveQuery.data.value ?? [])
const audit = computed(() => auditQuery.data.value ?? [])
const busy = ref(false)

const editorOpen = ref(false)
const isEdit = ref(false)
const editingId = ref<string | null>(null)
const form = ref({ name: '', description: '', value: '' })
const formError = ref<string | null>(null)
const showValue = ref(false)

const auditOpen = ref(false)
const confirmingRow = computed(() => rows.value.find(r => r.id === confirming.value) ?? null)

const invalidateAudit = () => { void auditQuery.refetch() }
const createMutation = useMutation({ ...$orpc.vault.create.mutationOptions(), onSuccess: invalidateAudit })
const updateMutation = useMutation({ ...$orpc.vault.update.mutationOptions(), onSuccess: invalidateAudit })
const removeMutation = useMutation({ ...$orpc.vault.remove.mutationOptions(), onSuccess: invalidateAudit })

function openEditor(row?: VaultSecretRow) {
  formError.value = null
  showValue.value = false
  if (row) {
    isEdit.value = true
    editingId.value = row.id
form.value = { name: row.name, description: row.description, value: '' }
  } else {
    isEdit.value = false
    editingId.value = null
form.value = { name: '', description: '', value: '' }
  }
  editorOpen.value = true
}

async function save() {
  formError.value = null
  if (!form.value.name.trim()) { formError.value = 'Name is required'; return }
  if (!form.value.value) { formError.value = 'Value is required (it is stored encrypted and never shown again)'; return }
  busy.value = true
  try {
    if (isEdit.value && editingId.value) {
      await updateMutation.mutateAsync({ id: editingId.value, name: form.value.name.trim(), description: form.value.description.trim(), value: form.value.value })
    } else {
      await createMutation.mutateAsync({ name: form.value.name.trim(), description: form.value.description.trim(), value: form.value.value })
    }
    editorOpen.value = false
  } catch (e: any) {
    formError.value = e?.message ?? 'Save failed'
  } finally {
    busy.value = false
  }
}

const confirming = ref<string | null>(null)
async function askRemove(row: VaultSecretRow) {
  confirming.value = row.id
}
async function reallyRemove(row: VaultSecretRow) {
  confirming.value = null
  busy.value = true
  try { await removeMutation.mutateAsync({ id: row.id }) } finally { busy.value = false }
}

function kindIcon(): string {
  return 'i-lucide-shield'
}
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <UDashboardNavbar title="Vault">
      <template #leading>
        <UDashboardSidebarCollapse />
      </template>
      <template #trailing>
        <UButton icon="i-lucide-history" variant="ghost" color="neutral" aria-label="Audit log" @click="auditOpen = true" />
        <UButton icon="i-lucide-plus" size="sm" @click="openEditor()">New secret</UButton>
      </template>
    </UDashboardNavbar>

    <div class="space-y-6 p-6 lg:p-8">
      <UAlert icon="i-lucide-shield-check" color="primary" variant="subtle" title="Write-only secrets"
        description="Values are encrypted (AES-256-GCM) and can be replaced, but never displayed again after saving." />

      <!-- Mobile: stacked cards -->
      <div v-if="rows.length" class="space-y-3 md:hidden">
        <UCard v-for="row in rows" :key="row.id" :ui="{ root: 'shadow-sm' }">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="truncate text-sm font-medium text-zinc-900 dark:text-white">{{ row.name }}</p>
              <p class="mt-1 font-mono text-xs text-zinc-400">•••• {{ row.lastFour }}</p>
            </div>
          </div>
          <p v-if="row.description" class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{{ row.description }}</p>
          <div class="mt-3 flex justify-end gap-1">
            <UButton icon="i-lucide-pencil" variant="ghost" color="neutral" size="sm" aria-label="Replace secret" :disabled="busy" @click="openEditor(row)" />
            <UButton icon="i-lucide-trash-2" variant="ghost" color="error" size="sm" aria-label="Delete secret" :disabled="busy" @click="askRemove(row)" />
          </div>
        </UCard>
      </div>

      <!-- Desktop: table -->
      <UCard v-if="rows.length" :ui="{ root: 'shadow-sm hidden md:block', body: 'p-0 sm:p-0' }">
        <UTable :data="rows" :columns="[
          { accessorKey: 'name', header: 'Name' },
          { accessorKey: 'description', header: 'Description' },
          { accessorKey: 'lastFour', header: 'Value' },
          { accessorKey: 'updatedAt', header: 'Updated' },
          { id: 'actions', header: '' },
        ]">
          <template #description-cell="{ row }">
            <span class="text-xs text-zinc-500 dark:text-zinc-400">{{ row.original.description || '—' }}</span>
          </template>
          <template #lastFour-cell="{ row }">
            <span class="font-mono text-xs text-zinc-400">•••• {{ row.original.lastFour }}</span>
          </template>
          <template #updatedAt-cell="{ row }">
            <span class="text-xs text-zinc-500">{{ new Date(row.original.updatedAt).toLocaleString() }}</span>
          </template>
          <template #actions-cell="{ row }">
            <div class="flex justify-end gap-1">
              <UButton icon="i-lucide-pencil" variant="ghost" color="neutral" size="sm" aria-label="Replace secret" :disabled="busy" @click="openEditor(row.original)" />
              <UButton icon="i-lucide-trash-2" variant="ghost" color="error" size="sm" aria-label="Delete secret" :disabled="busy" @click="askRemove(row.original)" />
            </div>
          </template>
        </UTable>
      </UCard>

      <UCard v-if="!rows.length" :ui="{ root: 'shadow-sm' }">
        <template #body>
          <div class="flex flex-col items-center gap-2 py-6 text-center">
            <UIcon name="i-lucide-shield" class="size-8 text-zinc-300 dark:text-zinc-600" />
            <p class="text-sm text-zinc-500">No secrets yet. Store SSH keys and API tokens here — encrypted at rest.</p>
            <UButton icon="i-lucide-plus" size="sm" class="mt-2" @click="openEditor()">New secret</UButton>
          </div>
        </template>
      </UCard>
    </div>

    <!-- editor: create / replace -->
    <UModal v-model:open="editorOpen" :title="isEdit ? 'Replace secret' : 'New secret'" :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]' }">
      <template #body>
        <div class="space-y-4">
          <UFormField label="Name" hint="unique" :error="formError && !form.name ? formError : undefined">
            <UInput v-model="form.name" placeholder="ssh-prod-key" class="w-full" :disabled="busy" />
          </UFormField>
          <UFormField label="Description" hint="optional note">
            <UTextarea v-model="form.description" placeholder="What is this secret for?" :rows="2" class="w-full" :disabled="busy" />
          </UFormField>
          <UFormField label="Value" :hint="isEdit ? 'replaces the stored value' : 'encrypted, never shown again'"
            :error="formError && formError !== 'Name is required' ? formError : undefined">
            <UInput v-model="form.value" :type="showValue ? 'text' : 'password'" placeholder="secret value"
              class="w-full" :disabled="busy" autocomplete="off"
              :ui="{ trailing: 'pe-1' }">
              <template #trailing>
                <UButton :icon="showValue ? 'i-lucide-eye-off' : 'i-lucide-eye'" variant="link" color="neutral"
                  :aria-label="showValue ? 'Hide value' : 'Show value'" tabindex="-1" @click="showValue = !showValue" />
              </template>
            </UInput>
          </UFormField>
          <UAlert v-if="formError && !formError.includes('required')" icon="i-lucide-alert-circle" color="error" variant="subtle" :title="formError" />
        </div>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" :disabled="busy" @click="editorOpen = false">Cancel</UButton>
          <UButton :loading="busy" @click="save">{{ isEdit ? 'Replace' : 'Save' }}</UButton>
        </div>
      </template>
    </UModal>

    <!-- audit drawer -->
    <UModal v-model:open="auditOpen" title="Vault audit log" :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]' }">
      <template #body>
        <div class="space-y-2">
          <p v-if="!audit.length" class="py-4 text-center text-sm text-zinc-500">No audit entries yet.</p>
          <div v-for="entry in audit" :key="entry.id" class="flex items-center justify-between gap-2 border-b border-zinc-100 pb-2 text-sm dark:border-zinc-800">
            <div class="min-w-0">
              <p class="truncate font-medium text-zinc-900 dark:text-white">{{ entry.secretName }}</p>
              <p class="text-xs text-zinc-400">{{ entry.actorId }} · {{ new Date(entry.at).toLocaleString() }}</p>
            </div>
            <UBadge :color="entry.action === 'delete' ? 'error' : entry.action === 'use' ? 'warning' : 'neutral'" variant="subtle" size="sm">{{ entry.action }}</UBadge>
          </div>
        </div>
      </template>
    </UModal>

    <!-- delete confirm -->
    <UModal :open="confirming !== null" title="Delete secret" @update:open="(o: boolean) => { if (!o) confirming = null }">
      <template #body>
        <p class="text-sm text-zinc-600 dark:text-zinc-300">
          Delete <span class="font-medium text-zinc-900 dark:text-white">{{ confirmingRow?.name }}</span>?
          Anything using it (e.g. the SSH runner) will stop working. This cannot be undone.
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="confirming = null">Cancel</UButton>
          <UButton color="error" icon="i-lucide-trash-2" @click="reallyRemove(confirmingRow!)">Delete</UButton>
        </div>
      </template>
    </UModal>
  </UDashboardPanel>
</template>
