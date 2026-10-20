<script setup lang="ts">
// Secret vault: write-only secrets (AES-256-GCM server-side). Values are set
// once and never displayed again — only a last-4 hint. Mobile-first cards.
import { computed, ref } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import type { VaultSecretRow } from '~/../shared/types'

const { $orpc } = useNuxtApp()
const queryClient = useQueryClient()

const liveQuery = useQuery<VaultSecretRow[]>(($orpc.vault.secrets.list as any).queryOptions({ queryKey: ['vault'] }))
const foldersQuery = useQuery(($orpc.vault.folders.list as any).queryOptions({ queryKey: ['vault', 'folders'] }))
const folders = computed(() => (foldersQuery.data.value as { folders: Array<{ id: string, name: string, secrets: number }> } | undefined)?.folders ?? [])

// ---- folder filter chip row ----
const activeFolder = ref<string | null>(null) // null = All
const filteredRows = computed(() => activeFolder.value === null
  ? rows.value
  : rows.value.filter(r => r.folder === folders.value.find(f => f.id === activeFolder.value)?.name))

// ---- folders manager modal (statuses-style) ----
const folderManagerOpen = ref(false)
const folderEditorOpen = ref(false)
const folderEditingId = ref<string | null>(null)
const folderForm = ref({ name: '' })
const folderBusy = ref(false)
const folderError = ref<string | null>(null)
const folderConfirmId = ref<string | null>(null)
const folderConfirming = computed(() => folders.value.find(f => f.id === folderConfirmId.value) ?? null)

const folderSaveMutation = useMutation({ ...$orpc.vault.folders.save.mutationOptions() })
const folderRemoveMutation = useMutation({ ...$orpc.vault.folders.remove.mutationOptions() })

function openFolderEditor(id?: string) {
  folderError.value = null
  folderEditingId.value = id ?? null
  folderForm.value = { name: folders.value.find(f => f.id === id)?.name ?? '' }
  folderEditorOpen.value = true
}

async function saveFolder() {
  folderError.value = null
  if (!folderForm.value.name.trim()) { folderError.value = 'Name is required'; return }
  folderBusy.value = true
  try {
    await folderSaveMutation.mutateAsync({ ...(folderEditingId.value ? { id: folderEditingId.value } : {}), name: folderForm.value.name.trim() })
    folderEditorOpen.value = false
  } catch (e: any) {
    folderError.value = e?.message ?? 'Save failed'
  } finally {
    folderBusy.value = false
  }
}

async function removeFolder(id: string) {
  folderBusy.value = true
  try {
    await folderRemoveMutation.mutateAsync({ id })
    folderConfirmId.value = null
    if (activeFolder.value === id) activeFolder.value = null
  } finally {
    folderBusy.value = false
  }
}
const rows = computed(() => liveQuery.data.value ?? [])
const busy = ref(false)

const editorOpen = ref(false)
const isEdit = ref(false)
const editingId = ref<string | null>(null)
const form = ref({ name: '', description: '', value: '', folderName: '' })
const formError = ref<string | null>(null)
const showValue = ref(false)

const confirmingRow = computed(() => rows.value.find(r => r.id === confirming.value) ?? null)

const createMutation = useMutation({ ...$orpc.vault.secrets.create.mutationOptions() })
const updateMutation = useMutation({ ...$orpc.vault.secrets.update.mutationOptions() })
const removeMutation = useMutation({ ...$orpc.vault.secrets.remove.mutationOptions() })

function openEditor(row?: VaultSecretRow) {
  formError.value = null
  showValue.value = false
  if (row) {
    isEdit.value = true
    editingId.value = row.id
form.value = { name: row.name, description: row.description, value: '', folderName: row.folder ?? '' }
  } else {
    isEdit.value = false
    editingId.value = null
form.value = { name: '', description: '', value: '', folderName: '' }
  }
  editorOpen.value = true
}

async function save() {
  formError.value = null
  if (!form.value.name.trim()) { formError.value = 'Name is required'; return }
  // create needs the secret; edit without a value = metadata-only change (stored secret is kept)
  if (!isEdit.value && !form.value.value) { formError.value = 'Value is required (it is stored encrypted and never shown again)'; return }
  busy.value = true
  try {
    // resolve typed folder name -> id; unknown names become new folders
    let folderId: string | null = null
    const wanted = form.value.folderName.trim()
    if (wanted) {
      const existing = folders.value.find(f => f.name.toLowerCase() === wanted.toLowerCase())
      folderId = existing?.id ?? (await folderSaveMutation.mutateAsync({ name: wanted }) as { id: string }).id
    }
    if (isEdit.value && editingId.value) {
      const payload = {
        id: editingId.value,
        name: form.value.name.trim(),
        description: form.value.description.trim(),
        folderId,
        ...(form.value.value ? { value: form.value.value } : {}),
      }
      await updateMutation.mutateAsync(payload)
    } else {
      await createMutation.mutateAsync({ name: form.value.name.trim(), description: form.value.description.trim(), value: form.value.value, folderId })
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
    <template #body>
      <UDashboardNavbar title="Vault">
      <template #leading>
        <UDashboardSidebarCollapse />
      </template>
    </UDashboardNavbar>
      
    <div class="space-y-6 p-6 lg:p-8">
    <div class="flex flex-wrap items-end justify-between gap-2">
      <div>
        <p class="text-sm text-zinc-500">Encrypted secrets for SSH keys and API tokens — write-only, never displayed again</p>
      </div>
      <div class="flex items-center gap-2">
        <UPopover mode="hover">
          <template #content>
            <div class="px-3 py-1.5 text-xs">Audit log</div>
          </template>
        </UPopover>
        <UButton icon="i-lucide-folder" label="Folders" color="neutral" variant="outline" @click="folderManagerOpen = true" />
        <UButton icon="i-lucide-plus" label="New secret" @click="openEditor()" />
      </div>
    </div>

      <!-- Mobile: stacked cards -->
      <!-- folder filter chips: All + one per folder; manager defines the taxonomy -->
      <div v-if="folders.length" class="flex flex-wrap items-center gap-1.5">
        <UButton size="xs" :color="activeFolder === null ? 'primary' : 'neutral'" :variant="activeFolder === null ? 'solid' : 'soft'" label="All" @click="activeFolder = null" />
        <UButton
          v-for="f in folders" :key="f.id" size="xs"
          :color="activeFolder === f.id ? 'primary' : 'neutral'"
          :variant="activeFolder === f.id ? 'solid' : 'soft'"
          :icon="activeFolder === f.id ? 'i-lucide-folder-open' : 'i-lucide-folder'"
          :label="`${f.name} (${f.secrets})`"
          @click="activeFolder = activeFolder === f.id ? null : f.id"
        />
      </div>

      <DataTable v-if="filteredRows.length" :data="filteredRows" :columns="[
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
              <UPopover mode="hover">
                <UButton icon="i-lucide-pencil" variant="ghost" color="neutral" size="sm" aria-label="Replace secret" :disabled="busy" @click="openEditor(row.original)" />
                <template #content>
                  <div class="px-3 py-1.5 text-xs">Replace secret</div>
                </template>
              </UPopover>
              <UPopover mode="hover">
                <UButton icon="i-lucide-trash-2" variant="ghost" color="error" size="sm" aria-label="Delete secret" :disabled="busy" @click="askRemove(row.original)" />
                <template #content>
                  <div class="px-3 py-1.5 text-xs">Delete secret</div>
                </template>
              </UPopover>
            </div>
          </template>
        <template #mobile-item="{ row }">
          <UCard :ui="{ root: 'shadow-sm' }">
                  <div class="flex items-start justify-between gap-2">
                    <div class="min-w-0">
                      <p class="truncate text-sm font-medium text-zinc-900 dark:text-white">{{ row.name }}</p>
                      <p class="mt-1 font-mono text-xs text-zinc-400">•••• {{ row.lastFour }}</p>
                    </div>
                  </div>
                  <p v-if="row.description" class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{{ row.description }}</p>
                  <div class="mt-3 flex justify-end gap-1">
                    <UPopover mode="hover">
                      <UButton icon="i-lucide-pencil" variant="ghost" color="neutral" size="sm" aria-label="Replace secret" :disabled="busy" @click="openEditor(row)" />
                      <template #content>
                        <div class="px-3 py-1.5 text-xs">Replace secret</div>
                      </template>
                    </UPopover>
                    <UPopover mode="hover">
                      <UButton icon="i-lucide-trash-2" variant="ghost" color="error" size="sm" aria-label="Delete secret" :disabled="busy" @click="askRemove(row)" />
                      <template #content>
                        <div class="px-3 py-1.5 text-xs">Delete secret</div>
                      </template>
                    </UPopover>
                  </div>
        
          </UCard>
        </template>
      </DataTable>


      <UCard v-if="!filteredRows.length" :ui="{ root: 'shadow-sm' }">
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
    <UModal v-model:open="editorOpen" :title="isEdit ? 'Replace secret' : 'New secret'" :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }">
      <template #body>
        <div class="space-y-4">
          <UFormField label="Name" :error="formError && !form.name ? formError : undefined">
            <template #hint><FormHint text="unique" /></template>
            <UInput v-model="form.name" placeholder="Secret name" class="w-full" :disabled="busy" />
          </UFormField>
          <UFormField label="Description">
            <template #hint><FormHint text="optional note" /></template>
            <UTextarea v-model="form.description" placeholder="Description (optional)" :rows="2" class="w-full" :disabled="busy" />
          </UFormField>
          <UFormField label="Folder" name="folder">
            <AutoCompleteInput
              v-model="form.folderName"
              :items="folders.map(f => f.name)"
              icon="i-lucide-folder"
              placeholder="No folder — type to search or create"
              create-hint="A new folder will be created"
              :disabled="busy"
            />
          </UFormField>
          <UFormField label="Value"
            :error="formError && formError !== 'Name is required' ? formError : undefined">
            <template #hint>
              <FormHint :text="isEdit ? 'replaces the stored value' : 'encrypted, never shown again'" />
            </template>
            <div class="relative w-full">
              <UTextarea v-model="form.value" :placeholder="isEdit ? 'New secret value (leave empty to keep the current one)' : 'Secret value'" :rows="4" class="w-full" :disabled="busy"
                autocomplete="off" spellcheck="false"
                :class="showValue ? 'font-mono' : 'secret-masked font-mono'" />
              <UPopover mode="hover">
                <UButton :icon="showValue ? 'i-lucide-eye-off' : 'i-lucide-eye'" variant="link" color="neutral" size="sm"
                  :aria-label="showValue ? 'Hide value' : 'Show value'" tabindex="-1"
                  class="absolute right-1 top-1"
                  @click="showValue = !showValue" />
                <template #content>
                  <div class="px-3 py-1.5 text-xs">{{ showValue ? 'Hide value' : 'Show value' }}</div>
                </template>
              </UPopover>
            </div>
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

    <!-- folders manager (statuses-style) -->
    <UModal v-model:open="folderManagerOpen" title="Vault folders" :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }">
      <template #body>
        <div v-if="folderError" class="mb-3 rounded-md bg-error/10 px-3 py-2 text-xs text-error">{{ folderError }}</div>
        <div v-if="folders.length" class="divide-y divide-default">
          <div v-for="f in folders" :key="f.id" class="flex items-center gap-2 py-2.5">
            <UBadge color="neutral" variant="subtle" icon="i-lucide-folder">{{ f.name }}</UBadge>
            <span class="text-xs text-zinc-500">{{ f.secrets }} {{ f.secrets === 1 ? 'secret' : 'secrets' }}</span>
            <span class="flex-1" />
            <UPopover mode="hover">
              <UButton icon="i-lucide-pencil" size="xs" color="neutral" variant="ghost" aria-label="Rename folder" :disabled="folderBusy" @click="openFolderEditor(f.id)" />
              <template #content><div class="px-3 py-1.5 text-xs">Rename</div></template>
            </UPopover>
            <UPopover mode="hover">
              <UButton icon="i-lucide-trash-2" size="xs" color="neutral" variant="ghost" aria-label="Delete folder" :disabled="folderBusy" @click="folderConfirmId = f.id" />
              <template #content><div class="px-3 py-1.5 text-xs">Delete</div></template>
            </UPopover>
          </div>
        </div>
        <p v-else class="py-6 text-center text-sm text-zinc-500">No folders yet — create one to categorize secrets.</p>
      </template>
      <template #footer>
        <div class="flex w-full items-center justify-between gap-2">
          <UButton icon="i-lucide-plus" size="sm" label="New folder" @click="openFolderEditor()" />
        </div>
      </template>
    </UModal>

    <!-- folder editor (stacked on the manager) -->
    <UModal v-model:open="folderEditorOpen" :title="folderEditingId ? 'Rename folder' : 'New folder'" :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }">
      <template #body>
        <UFormField label="Name" name="name" required>
          <UInput v-model="folderForm.name" icon="i-lucide-folder" placeholder="e.g. Production keys" class="w-full" :disabled="folderBusy" />
        </UFormField>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="folderEditorOpen = false">Cancel</UButton>
          <UButton icon="i-lucide-check" :loading="folderBusy" @click="saveFolder">Save</UButton>
        </div>
      </template>
    </UModal>

    <!-- folder delete confirm: secrets survive -->
    <UModal :open="folderConfirmId !== null" @update:open="(v: boolean) => { if (!v) folderConfirmId = null }" title="Delete folder">
      <template #body>
        <p class="text-sm">
          Delete <strong>{{ folderConfirming?.name }}</strong>? Secrets in it stay — they just become uncategorized.
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" @click="folderConfirmId = null">Cancel</UButton>
          <UButton color="error" icon="i-lucide-trash-2" :loading="folderBusy" @click="removeFolder(folderConfirming!.id)">Delete</UButton>
        </div>
      </template>
    </UModal>
    </template>
    </UDashboardPanel>
</template>

<style scoped>
/* mask secret text while the eye toggle is closed (Chromium/WebKit) */
:deep(.secret-masked textarea) {
  -webkit-text-security: disc;
}
</style>
