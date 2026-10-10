<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query'
// Settings: auth policy for this Tandem instance. OIDC provider list is a
// UTable with a single add/edit modal (no v-model over v-for aliases — the
// dxup page transform breaks that pattern; pathbridge table+modal law).
interface OidcProviderRow {
  id: string
  label: string
  issuer: string
  clientId: string
  secretSet: boolean
}

const { $orpc, $client } = useNuxtApp()

const oidcLive = useQuery(($orpc as any).oidc.live.liveOptions())
const providersLive = useQuery(($orpc as any).providers.live.liveOptions())
const mProvList = computed(() => (unref(providersLive.data) ?? []) as Array<{ id: string, label: string, baseUrl: string, apiStyle: 'openai' | 'anthropic', extraHeaders: Record<string, string> | null, notes: string | null, modelNames: string[] }>)
const mProvEditorOpen = ref(false)
const mProvEditingId = ref<string | null>(null)
const mProvForm = reactive({ label: '', baseUrl: '', apiStyle: 'openai' as 'openai' | 'anthropic', extraHeaders: '', notes: '', modelNames: '' })
const mProvBusy = ref(false)
const mProvMessage = ref('')

function openMProvEditor(row?: { id: string, label: string, baseUrl: string, apiStyle: 'openai' | 'anthropic', extraHeaders: Record<string, string> | null, notes: string | null, modelNames: string[] }) {
  mProvEditingId.value = row?.id ?? null
  mProvForm.label = row?.label ?? ''
  mProvForm.baseUrl = row?.baseUrl ?? ''
  mProvForm.apiStyle = row?.apiStyle ?? 'openai'
  mProvForm.extraHeaders = row?.extraHeaders ? Object.entries(row.extraHeaders).map(([k, v]) => `${k}: ${v}`).join('\n') : ''
  mProvForm.notes = row?.notes ?? ''
  mProvForm.modelNames = row?.modelNames?.join('\n') ?? ''
  mProvMessage.value = ''
  mProvEditorOpen.value = true
}

async function saveMProv() {
  mProvBusy.value = true
  mProvMessage.value = ''
  try {
    const headers = mProvForm.extraHeaders.trim()
      ? Object.fromEntries(mProvForm.extraHeaders.split('\n').map(l => l.split(':').map(p => p.trim())).filter(p => p.length === 2).map(p => [p[0]!, p[1]!]))
      : undefined
    await ($client as any).providers.save({
      ...(mProvEditingId.value ? { id: mProvEditingId.value } : {}),
      label: mProvForm.label,
      baseUrl: mProvForm.baseUrl,
      apiStyle: mProvForm.apiStyle,
      ...(headers && Object.keys(headers).length ? { extraHeaders: headers } : {}),
      ...(mProvForm.notes ? { notes: mProvForm.notes } : {}),
      modelNames: mProvForm.modelNames.split('\n').map(l => l.trim()).filter(Boolean),
    })
    mProvEditorOpen.value = false
  }
  catch (e) {
    mProvMessage.value = e instanceof Error ? e.message : 'save failed'
  }
  finally {
    mProvBusy.value = false
  }
}

const provSyncKey = ref('')
const provSyncing = ref(false)
async function syncModels() {
  provSyncing.value = true
  mProvMessage.value = ''
  try {
    const res = await ($client as any).providers.fetchModels({
      baseUrl: mProvForm.baseUrl,
      apiStyle: mProvForm.apiStyle,
      ...(provSyncKey.value.trim() ? { key: provSyncKey.value.trim() } : {}),
      ...(mProvForm.extraHeaders.trim() ? { extraHeaders: Object.fromEntries(mProvForm.extraHeaders.split('\n').map(l => l.split(':').map(p => p.trim())).filter(p => p.length === 2).map(p => [p[0]!, p[1]!])) } : {}),
    })
    if (res.models?.length) mProvForm.modelNames = res.models.join('\n')
    else mProvMessage.value = 'Endpoint returned no models'
    provSyncKey.value = ''
  }
  catch (e) {
    mProvMessage.value = e instanceof Error ? e.message : 'sync failed'
  }
  finally {
    provSyncing.value = false
  }
}

async function removeMProv(id: string) {
  mProvBusy.value = true
  mProvMessage.value = ''
  try {
    await ($client as any).providers.remove({ id })
  }
  catch (e) {
    mProvMessage.value = e instanceof Error ? e.message : 'delete failed'
  }
  finally {
    mProvBusy.value = false
  }
}

const settingsLive = useQuery(($orpc as any).settings.live.liveOptions())

const providers = computed<OidcProviderRow[]>(() => ((unref(oidcLive.data) ?? []) as Array<{ id: string, label: string, issuer: string, clientId: string, hasSecret: boolean }>)
  .map(p => ({ id: p.id, label: p.label, issuer: p.issuer, clientId: p.clientId, secretSet: p.hasSecret })))

const disablePasswordLogin = ref(false)
const companyName = ref('Tandem')
watch(() => unref(settingsLive.data), (d) => {
  if (d) {
    const v = d as { disablePasswordLogin: boolean, companyName?: string }
    disablePasswordLogin.value = v.disablePasswordLogin
    companyName.value = v.companyName?.trim() || 'Tandem'
  }
}, { immediate: true })

const savingName = ref(false)
const nameMessage = ref('')
async function saveCompanyName() {
  savingName.value = true
  nameMessage.value = ''
  try {
    await ($client as any).settings.update({ companyName: companyName.value })
    nameMessage.value = 'Saved'
  } catch (e: any) {
    nameMessage.value = e?.message ?? 'Save failed'
  } finally {
    savingName.value = false
  }
}

const busy = ref(false)
const message = ref('')

const editorOpen = ref(false)
const editingId = ref<string | null>(null)
const form = reactive({ label: '', issuer: '', clientId: '', clientSecret: '' })

const publicOrigin = import.meta.client ? window.location.origin : ''

const providerColumns = [
  { accessorKey: 'label', header: 'Provider' },
  { accessorKey: 'issuer', header: 'Issuer' },
  { accessorKey: 'clientId', header: 'Client ID' },
  { accessorKey: 'callback', header: 'Callback URL' },
  { accessorKey: 'actions', header: '' },
]

function openEditor(row?: OidcProviderRow) {
  editingId.value = row?.id ?? null
  form.label = row?.label ?? ''
  form.issuer = row?.issuer ?? ''
  form.clientId = row?.clientId ?? ''
  form.clientSecret = ''
  editorOpen.value = true
}

async function saveProvider() {
  busy.value = true
  message.value = ''
  try {
    const list = providers.value
      .filter(p => p.id !== editingId.value)
      .map(p => ({ id: p.id, label: p.label, issuer: p.issuer, clientId: p.clientId }))
    const list2: Array<{ id: string | undefined, label: string, issuer: string, clientId: string, clientSecret?: string }> = list
    list2.push({
      id: editingId.value ?? undefined,
      label: form.label,
      issuer: form.issuer,
      clientId: form.clientId,
      ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}),
    })
    await ($client as any).oidc.replace({ providers: list2 })
    editorOpen.value = false
  }
  catch (e) {
    message.value = e instanceof Error ? e.message : 'save failed'
  }
  finally {
    busy.value = false
  }
}

async function removeProvider(row: OidcProviderRow) {
  const list = providers.value
    .filter(p => p.id !== row.id)
    .map(p => ({ id: p.id, label: p.label, issuer: p.issuer, clientId: p.clientId }))
  await ($client as any).oidc.replace({ providers: list })
}

async function savePasswordPolicy() {
  busy.value = true
  try {
    await ($client as any).settings.update({ disablePasswordLogin: disablePasswordLogin.value })
    message.value = 'Saved'
  }
  catch (e) {
    message.value = e instanceof Error ? e.message : 'save failed'
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0' }">
    <UDashboardNavbar title="Settings">
      <template #leading>
        <UDashboardSidebarCollapse />
      </template>
    </UDashboardNavbar>
    <div class="space-y-6 p-6 lg:p-8">
    <div>
            <p class="text-sm text-zinc-500">General and authentication for this workspace</p>
    </div>

    <UCard :ui="{ root: 'shadow-sm' }">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-building-2" class="size-4 text-zinc-400" />
          <h3 class="text-sm font-semibold text-zinc-900 dark:text-white">General</h3>
        </div>
      </template>
      <UForm :state="{ companyName }" class="flex flex-wrap items-end gap-3" @submit="saveCompanyName">
        <UFormField label="Company name" name="companyName" class="min-w-56 flex-1">
          <template #hint><FormHint text="Shown in the sidebar and on the login screen" /></template>
          <UInput v-model="companyName" icon="i-lucide-building-2" placeholder="Company name" class="w-full" :disabled="savingName" />
        </UFormField>
        <UButton type="submit" icon="i-lucide-save" :loading="savingName">Save</UButton>
        <span v-if="nameMessage" class="pb-2 text-xs" :class="nameMessage === 'Saved' ? 'text-success' : 'text-error'">{{ nameMessage }}</span>
      </UForm>
    </UCard>

    <UCard :ui="{ root: 'shadow-sm' }">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-cpu" class="size-4 text-zinc-400" />
          <h3 class="text-sm font-semibold text-zinc-900 dark:text-white">Model providers</h3>
        </div>
      </template>
      <div class="space-y-5">
        <div>
          <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h4 class="text-xs font-semibold uppercase tracking-wide text-zinc-400">Catalog</h4>
            <UButton icon="i-lucide-plus" size="sm" label="Add provider" @click="openMProvEditor()" />
          </div>
          <template v-if="mProvList.length">
            <UCard :ui="{ root: 'shadow-sm', body: 'p-0 sm:p-0' }">
              <UTable :data="mProvList" :columns="[
                { accessorKey: 'label', header: 'Provider' },
                { accessorKey: 'models', header: 'Models' },
                { accessorKey: 'actions', header: '' },
              ]">
                <template #label-cell="{ row }">
                  <div class="min-w-0">
                    <p class="truncate font-medium text-zinc-900 dark:text-white">{{ row.original.label }}</p>
                    <p class="truncate font-mono text-xs text-zinc-400">{{ row.original.baseUrl }}</p>
                  </div>
                </template>
                <template #models-cell="{ row }">
                  <div class="flex flex-wrap gap-1">
                    <UBadge v-for="m in row.original.modelNames.slice(0, 4)" :key="m" color="neutral" variant="subtle" size="sm">{{ m }}</UBadge>
                    <UBadge v-if="row.original.modelNames.length > 4" color="neutral" variant="subtle" size="sm">+{{ row.original.modelNames.length - 4 }}</UBadge>
                    <UBadge :color="row.original.apiStyle === 'anthropic' ? 'warning' : 'primary'" variant="subtle" size="sm">{{ row.original.apiStyle }}</UBadge>
                  </div>
                </template>
                <template #actions-cell="{ row }">
                  <div class="flex justify-end gap-1">
                    <UButton icon="i-lucide-pencil" variant="ghost" color="neutral" size="xs" aria-label="Edit provider" @click="openMProvEditor(row.original)" />
                    <UButton icon="i-lucide-trash-2" variant="ghost" color="error" size="xs" aria-label="Delete provider" :loading="mProvBusy" @click="removeMProv(row.original.id)" />
                  </div>
                </template>
              </UTable>
            </UCard>
            <p v-if="mProvMessage" class="mt-2 text-xs text-error">{{ mProvMessage }}</p>
          </template>
          <p v-else class="py-4 text-center text-sm text-zinc-500">No providers yet.</p>
        </div>
      </div>
    </UCard>

    <UCard :ui="{ root: 'shadow-sm' }">
      <template #header>
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-key-round" class="size-4 text-zinc-400" />
          <h3 class="text-sm font-semibold text-zinc-900 dark:text-white">Authentication</h3>
        </div>
      </template>
      <div class="space-y-5">
        <div>
          <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h4 class="text-xs font-semibold uppercase tracking-wide text-zinc-400">OIDC providers</h4>
            <UButton icon="i-lucide-plus" size="sm" label="Add provider" @click="openEditor()" />
          </div>
          <template v-if="providers.length">
            <UCard :ui="{ root: 'shadow-sm', body: 'p-0 sm:p-0' }">
              <UTable :data="providers" :columns="providerColumns">
                <template #provider-cell="{ row }">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="text-sm font-medium text-zinc-900 dark:text-white">{{ row.original.label }}</span>
                    <UBadge v-if="!row.original.secretSet" variant="subtle" color="warning" size="sm">no secret</UBadge>
                  </div>
                </template>
                <template #callback-cell="{ row }">
                  <span class="block font-mono text-xs break-all text-zinc-500">{{ publicOrigin }}/auth/callback/{{ row.original.id }}</span>
                </template>
                <template #actions-cell="{ row }">
                  <div class="flex justify-end gap-2">
                    <UButton icon="i-lucide-pencil" variant="ghost" color="neutral" size="sm" aria-label="Edit provider" @click="openEditor(row.original)" />
                    <UButton icon="i-lucide-trash-2" variant="ghost" color="error" size="sm" aria-label="Remove provider" @click="removeProvider(row.original)" />
                  </div>
                </template>
              </UTable>
            </UCard>
            <p class="mt-2 text-xs text-zinc-400">Register each callback URL above with its identity provider.</p>
          </template>
          <div v-else class="rounded-xl border border-dashed border-zinc-300 p-8 text-center dark:border-zinc-700">
            <p class="text-sm text-zinc-400">No OIDC providers — password login only.</p>
          </div>
        </div>

        <USeparator />

        <div class="flex items-center justify-between gap-4">
          <div>
            <p class="text-sm font-medium text-zinc-900 dark:text-white">Password login
              <UBadge v-if="!disablePasswordLogin" color="success" variant="subtle" size="sm">Enabled</UBadge>
              <UBadge v-else color="warning" variant="subtle" size="sm">Disabled — SSO only</UBadge>
            </p>
            <p class="text-xs text-zinc-400">{{ mProvList.length === 0 ? 'Cannot be disabled until an OIDC provider is configured.' : 'Turn off to require single sign-on.' }}</p>
          </div>
          <USwitch :model-value="!disablePasswordLogin" :disabled="mProvList.length === 0" @update:model-value="async (v: boolean) => { disablePasswordLogin = !v; await savePasswordPolicy() }" />
        </div>
      </div>
    </UCard>

    <!-- OIDC provider editor modal -->
    <UModal :open="editorOpen" :title="editingId ? 'Edit provider' : 'Add OIDC provider'" description="Register the redirect URL shown after saving in your OIDC provider" @update:open="(v: boolean) => editorOpen = v">
      <template #body>
        <UForm id="oidc-editor-form" :state="form" class="space-y-4" @submit="saveProvider">
          <UFormField name="label" label="Name" required help="Shown on the login button">
            <UInput v-model="form.label" icon="i-lucide-tag" class="w-full" placeholder="Display name" />
          </UFormField>
          <UFormField name="issuer" label="Issuer URL" required>
            <UInput v-model="form.issuer" icon="i-lucide-globe" class="w-full" placeholder="https://issuer-url" />
          </UFormField>
          <UFormField name="clientId" label="Client ID" required>
            <UInput v-model="form.clientId" class="w-full" placeholder="Client ID" />
          </UFormField>
          <UFormField name="secret" :label="editingId ? 'Client secret (blank = keep stored)' : 'Client secret'" :required="!editingId">
            <UInput v-model="form.clientSecret" type="password" icon="i-lucide-key-round" class="w-full" placeholder="Client secret" />
          </UFormField>
        </UForm>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton type="button" variant="ghost" color="neutral" label="Cancel" :disabled="busy" @click="editorOpen = false" />
          <UButton type="submit" icon="i-lucide-plus" :loading="busy" :label="editingId ? 'Save changes' : 'Add provider'" form="oidc-editor-form" />
        </div>
      </template>
    </UModal>

    <p v-if="message" class="text-xs text-zinc-400">{{ message }}</p>
  </div>
    <!-- model provider editor -->
    <UModal v-model:open="mProvEditorOpen" :title="mProvEditingId ? 'Edit provider' : 'Add provider'" :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]' }">
      <template #body>
        <UForm id="provider-editor-form" :state="mProvForm" class="space-y-4" @submit="saveMProv">
          <UFormField label="Label" name="label">
            <UInput v-model="mProvForm.label" icon="i-lucide-tag" placeholder="Provider name" class="w-full" required />
          </UFormField>
          <UFormField label="Base URL" name="baseUrl">
            <template #hint><FormHint text="OpenAI- or Anthropic-compatible endpoint root" /></template>
            <UInput v-model="mProvForm.baseUrl" icon="i-lucide-globe" placeholder="https://api.example.com/v1" class="w-full" required />
          </UFormField>
          <UFormField label="API style" name="apiStyle">
            <template #hint><FormHint text="Wire protocol the endpoint speaks" /></template>
            <USelect v-model="mProvForm.apiStyle" :items="[{ label: 'OpenAI-compatible', value: 'openai' }, { label: 'Anthropic messages', value: 'anthropic' }]" value-key="value" icon="i-lucide-plug" class="w-full" />
          </UFormField>
          <UFormField label="Models" name="modelNames">
            <template #hint><FormHint text="One model name per line — the agent's model dropdown" /></template>
            <div class="mb-2 flex flex-wrap items-end gap-2">
              <UInput v-model="provSyncKey" type="password" icon="i-lucide-key-round" placeholder="API key for sync (optional, never stored)" class="min-w-48 flex-1" :disabled="provSyncing" />
              <UButton icon="i-lucide-refresh-cw" size="sm" :loading="provSyncing" :disabled="!mProvForm.baseUrl" @click="syncModels">Sync from endpoint</UButton>
            </div>
            <UTextarea v-model="mProvForm.modelNames" placeholder="model-name&#10;another-model" :rows="4" class="w-full" />
          </UFormField>
          <UFormField label="Extra headers" name="extraHeaders">
            <template #hint><FormHint text="Optional, one 'Name: value' per line" /></template>
            <UTextarea v-model="mProvForm.extraHeaders" placeholder="HTTP-Referer: https://tandem.local" :rows="2" class="w-full" />
          </UFormField>
          <UFormField label="Notes" name="notes">
            <UInput v-model="mProvForm.notes" icon="i-lucide-notebook-pen" placeholder="Where keys live, budgets…" class="w-full" />
          </UFormField>
          <p v-if="mProvMessage" class="text-sm text-error">{{ mProvMessage }}</p>
        </UForm>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton variant="ghost" color="neutral" label="Cancel" :disabled="mProvBusy" @click="mProvEditorOpen = false" />
          <UButton type="submit" :loading="mProvBusy" :label="mProvEditingId ? 'Save changes' : 'Add provider'" form="provider-editor-form" />
        </div>
      </template>
    </UModal>
  </UDashboardPanel>
</template>
