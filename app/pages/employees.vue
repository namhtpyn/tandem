<script setup lang="ts">
import { useQuery, useMutation } from '@tanstack/vue-query';

import { PROVIDER_KIND, endpointKind, isModelsEndpoint } from '#shared/api-styles';
import { CHANGE_RESOURCE } from '~/../shared/enums';
// Employees (LIVE): oRPC live query over user + supervision graph +
// AI extension rows. Mutations ride the same change-bus — every client
// updates instantly. AI-ness is derived (extension row exists), never a
// column, and kind is immutable after create.
import type { ApiKeyRow, EmployeeRow, EnvironmentRow } from '~/utils/orpc-types';
import { groupedSecretOptions } from '~/utils/vault-options';

const { $orpc, $client } = useNuxtApp();

const liveQuery = useQuery($orpc.employees.list.queryOptions({ queryKey: [CHANGE_RESOURCE.EMPLOYEES] }));
const rows = computed<EmployeeRow[]>(() => (unref(liveQuery.data) ?? []) as EmployeeRow[]);

const envQuery = useQuery($orpc.environments.list.queryOptions({ queryKey: [CHANGE_RESOURCE.ENVIRONMENTS] }));
const environments = computed<EnvironmentRow[]>(() => (unref(envQuery.data) ?? []) as EnvironmentRow[]);

const byId = computed(() => new Map(rows.value.map((r) => [r.id, r])));

// ---- graph (hierarchy) view ----
const view = ref<'list' | 'graph'>('list');
/** children map: supervisorId -> direct reports (in row order) */
const childrenOf = computed(() => {
  const m = new Map<string, EmployeeRow[]>();
  for (const r of rows.value) {
    for (const sup of r.supervisorIds) {
      const arr = m.get(sup) ?? [];
      arr.push(r);
      m.set(sup, arr);
    }
  }
  return m;
});
/** roots = employees with no supervisor (or supervisor missing) */
const roots = computed(() =>
  rows.value.filter((r) => r.supervisorIds.length === 0 || r.supervisorIds.every((id) => !byId.value.has(id))),
);
/** ONE box per employee; ONE line per supervision edge.
 * TOP-DOWN layered layout (classic org chart): depth = row, subtree width =
 * leaf count; children centered under their parent, elbow connectors from the
 * parent's bottom-center to each child's top-center. Extra supervisor edges
 * (multi-parent) curve from the other supervisor's bottom to the child's top. */
interface GraphNode {
  row: EmployeeRow;
  depth: number;
  parentIndex: number;
  x: number;
  y: number;
}
const NODE_W = 168;
const NODE_H = 84;
const COL_GAP = 16;
const ROW_GAP = 64;

const graphLayout = computed(() => {
  const nodes: GraphNode[] = [];
  const indexById = new Map<string, number>();
  // children arrays in stable order
  const kids = new Map<string, EmployeeRow[]>();
  for (const r of rows.value) {
    for (const sup of r.supervisorIds) {
      const arr = kids.get(sup) ?? [];
      if (!arr.some((x) => x.id === r.id)) arr.push(r);
      kids.set(sup, arr);
    }
  }
  const primaryOf = (r: EmployeeRow): string | null => {
    for (const sup of r.supervisorIds) if (byId.value.has(sup)) return sup;
    return null;
  };
  // width = number of leaves in subtree (min 1)
  const widthCache = new Map<string, number>();
  const subtreeWidth = (r: EmployeeRow, path: Set<string>): number => {
    if (path.has(r.id)) return 1;
    if (widthCache.has(r.id)) return widthCache.get(r.id)!;
    const next = new Set(path).add(r.id);
    const ch = (kids.get(r.id) ?? []).filter((c) => primaryOf(c) === r.id);
    let w = 1;
    for (const c of ch) ((w += subtreeWidth(c, next) - 1 + 1), (w += 0));
    // each child contributes max(1, its own width); accumulate:
    w = ch.length ? ch.reduce((acc, c) => acc + Math.max(1, subtreeWidth(c, next)), 0) : 1;
    widthCache.set(r.id, w);
    return w;
  };
  const place = (r: EmployeeRow, depth: number, parentIndex: number, leftX: number, path: Set<string>) => {
    if (indexById.has(r.id) || path.has(r.id)) return;
    indexById.set(r.id, nodes.length);
    const i = nodes.length;
    const w = Math.max(1, subtreeWidth(r, new Set()));
    const x = leftX + (w * (NODE_W + COL_GAP) - COL_GAP) / 2 - NODE_W / 2;
    nodes.push({ row: r, depth, parentIndex, x, y: depth * (NODE_H + ROW_GAP) });
    const next = new Set(path).add(r.id);
    const ch = (kids.get(r.id) ?? []).filter((c) => primaryOf(c) === r.id && !indexById.has(c.id));
    let cursor = leftX;
    for (const c of ch) {
      place(c, depth + 1, i, cursor, next);
      cursor += Math.max(1, subtreeWidth(c, next)) * (NODE_W + COL_GAP);
    }
  };
  let cursor = 0;
  const rootList = [...roots.value];
  for (const r of rows.value)
    if (
      !indexById.has(r.id) &&
      !rootList.some((x) => x.id === r.id) &&
      ![...indexById.keys()].includes(r.id) &&
      !r.supervisorIds.some((id) => indexById.has(id))
    ) {
      if (!indexById.has(r.id)) {
        rootList.push(r);
      }
    }
  for (const r of rootList) {
    if (indexById.has(r.id)) continue;
    place(r, 0, -1, cursor, new Set());
    cursor += Math.max(1, subtreeWidth(r, new Set())) * (NODE_W + COL_GAP);
  }
  return nodes;
});

/** indices of nodes with a placement parent (primary tree edges) */
const primaryEdgeIndices = computed(() =>
  graphLayout.value.map((n, i) => (n.parentIndex >= 0 ? i : -1)).filter((i) => i >= 0),
);

/** extra supervisor edges beyond the placement parent */
const secondaryEdges = computed(() => {
  const nodes = graphLayout.value;
  const indexById = new Map(nodes.map((n, i) => [n.row.id, i]));
  const edges: Array<{ fromIndex: number; toIndex: number }> = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    const primaryId = n.parentIndex >= 0 ? nodes[n.parentIndex]!.row.id : null;
    const drawn = new Set<number>();
    for (const sup of n.row.supervisorIds) {
      if (sup === primaryId) continue;
      const supIdx = indexById.get(sup);
      if (supIdx === undefined || supIdx === i || drawn.has(supIdx)) continue;
      drawn.add(supIdx);
      edges.push({ fromIndex: supIdx, toIndex: i });
    }
  }
  return edges;
});

const graphWidth = computed(() => Math.max(360, ...graphLayout.value.map((n) => n.x + NODE_W)) + 8);
const graphHeight = computed(() => (Math.max(0, ...graphLayout.value.map((n) => n.depth)) + 1) * (NODE_H + ROW_GAP));
function primaryPath(i: number): string {
  const nodes = graphLayout.value;
  const n = nodes[i]!;
  const p = nodes[n.parentIndex]!;
  const px = p.x + NODE_W / 2;
  const py = p.y + NODE_H;
  const cx = n.x + NODE_W / 2;
  const cy = n.y;
  return `M ${px} ${py} V ${(py + cy) / 2} H ${cx} V ${cy}`;
}
function secondaryTopPath(fromIndex: number, toIndex: number): string {
  const nodes = graphLayout.value;
  const p = nodes[fromIndex]!;
  const c = nodes[toIndex]!;
  const px = p.x + NODE_W / 2;
  const py = p.y + NODE_H;
  const cx = c.x + NODE_W / 2;
  const cy = c.y;
  return `M ${px} ${py} C ${px} ${py + ROW_GAP * 0.6}, ${cx} ${cy - ROW_GAP * 0.6}, ${cx} ${cy}`;
}
const envName = (id: string | null) => environments.value.find((e) => e.id === id)?.name ?? null;

const createMutation = useMutation($orpc.employees.create.mutationOptions());
const updateMutation = useMutation($orpc.employees.update.mutationOptions());
const removeMutation = useMutation($orpc.employees.remove.mutationOptions());
const createKeyMutation = useMutation($orpc.employees.createApiKey.mutationOptions());
const revokeKeyMutation = useMutation($orpc.employees.revokeApiKey.mutationOptions());
const listKeysCall = $orpc.employees.listApiKeys.call;

// ---- editor ----
const titlesQuery = useQuery(
  $orpc.employees.titles.list.queryOptions({ queryKey: [CHANGE_RESOURCE.EMPLOYEES, 'titles'] }),
);
const titles = computed(
  () =>
    (titlesQuery.data.value as { titles: Array<{ id: string; name: string; employees: number }> } | undefined)
      ?.titles ?? [],
);

// ---- titles manager modal (statuses-style) ----
const titleManagerOpen = ref(false);
const titleEditorOpen = ref(false);
const titleEditingId = ref<string | null>(null);
const titleForm = ref({ name: '' });
const titleBusy = ref(false);
const titleError = ref<string | null>(null);
const titleConfirmId = ref<string | null>(null);
const titleConfirming = computed(() => titles.value.find((t) => t.id === titleConfirmId.value) ?? null);

const titleSaveMutation = useMutation({ ...$orpc.employees.titles.save.mutationOptions() });
const titleRemoveMutation = useMutation({ ...$orpc.employees.titles.remove.mutationOptions() });

function openTitleEditor(id?: string) {
  titleError.value = null;
  titleEditingId.value = id ?? null;
  titleForm.value = { name: titles.value.find((t) => t.id === id)?.name ?? '' };
  titleEditorOpen.value = true;
}

async function saveTitle() {
  titleError.value = null;
  if (!titleForm.value.name.trim()) {
    titleError.value = 'Name is required';
    return;
  }
  titleBusy.value = true;
  try {
    await titleSaveMutation.mutateAsync({
      ...(titleEditingId.value ? { id: titleEditingId.value } : {}),
      name: titleForm.value.name.trim(),
    });
    titleEditorOpen.value = false;
  } catch (e: any) {
    titleError.value = e?.message ?? 'Save failed';
  } finally {
    titleBusy.value = false;
  }
}

async function removeTitle(id: string) {
  titleBusy.value = true;
  try {
    await titleRemoveMutation.mutateAsync({ id });
    titleConfirmId.value = null;
  } finally {
    titleBusy.value = false;
  }
}

const editorOpen = ref(false);
const editingId = ref<string | null>(null);
const avatarUrl = ref<string | null>(null); // existing avatar (endpoint URL)
const avatarDirty = ref(false); // true when the user picked a NEW file
const form = reactive({
  name: '',
  email: '',
  kind: 'human' as 'human' | 'ai',
  image: null as string | null,
  title: '',
  supervisorIds: [] as string[],
  environmentId: '' as string,
  instructions: '',
  executable: '',
  providerId: '__none__' as string,
  model: '',
  apiKeySecretId: null as string | null,
});
const busy = ref(false);
const message = ref('');
const mintedKey = ref('');
const copied = ref(false);

async function copyKey(key: string) {
  try {
    await navigator.clipboard.writeText(key);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch {
    /* clipboard unavailable — manual selection still possible */
  }
}
const pendingDelete = ref<EmployeeRow | null>(null);
const deleteOpen = computed({
  get: () => pendingDelete.value !== null,
  set: (v: boolean) => {
    if (!v) pendingDelete.value = null;
  },
});

const isEdit = computed(() => editingId.value !== null);
const editingIsAi = computed(() => (editingId.value ? byId.value.get(editingId.value)?.kind === 'ai' : false));
const showAiFields = computed(() => (!isEdit.value ? form.kind === 'ai' : editingIsAi.value));

const supervisorItems = computed(() =>
  rows.value.filter((r) => r.id !== editingId.value).map((r) => ({ label: r.name, value: r.id })),
);

const providersLive = useQuery($orpc.providers.list.queryOptions({ queryKey: [CHANGE_RESOURCE.PROVIDERS] }));
const modelProviders = computed(() =>
  ((unref(providersLive.data) ?? []) as Array<{ id: string; label: string; endpoints: string[] }>).filter((p) =>
    (p.endpoints ?? []).some((st) => endpointKind(st) === PROVIDER_KIND.LLM),
  ),
);
const modelItems = ref<string[]>([]);
const modelLoading = ref(false);
const providerHasModelsEndpoint = computed(() => {
  const p = ((unref(providersLive.data) ?? []) as Array<{ id: string; endpoints: string[] }>).find(
    (x) => x.id === form.providerId,
  );
  return (p?.endpoints ?? []).some((st) => isModelsEndpoint(st));
});
watch(
  [() => form.providerId, () => form.apiKeySecretId],
  async ([providerId, keySecretId]) => {
    modelItems.value = [];
    if (providerId === '__none__' || !providerHasModelsEndpoint.value) return;
    modelLoading.value = true;
    try {
      const res = await $client.providers.models({
        providerId,
        ...(keySecretId ? { keySecretId } : {}),
      });
      modelItems.value = res.models ?? [];
    } catch {
      /* autocomplete is best-effort; freetext still allowed */
    } finally {
      modelLoading.value = false;
    }
  },
  { immediate: false },
);
const secretsLive = useQuery(
  $orpc.vault.secrets.list.queryOptions({
    input: { page: 1, pageSize: 100 },
    queryKey: [CHANGE_RESOURCE.VAULT, 'all'],
  }),
);
const secretItems = computed((): any =>
  groupedSecretOptions(
    (unref(secretsLive.data)?.data ?? []) as Array<{
      id: string;
      name: string;
      lastFour: string;
      folder: string | null;
    }>,
  ),
);
const environmentItems = computed(() => environments.value.map((e) => ({ label: e.name, value: e.id })));

/** read + downscale an avatar to a 256px JPEG data URL */
async function onAvatarPicked(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('read failed'));
    fr.readAsDataURL(file);
  });
  const img = new Image();
  await new Promise((resolve, reject) => {
    ((img.onload = resolve), (img.onerror = reject), (img.src = dataUrl));
  });
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const side = Math.min(img.width, img.height);
  ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
  form.image = canvas.toDataURL('image/jpeg', 0.85);
  avatarDirty.value = true;
}

function openEditor(row?: EmployeeRow) {
  editingId.value = row?.id ?? null;
  form.name = row?.name ?? '';
  form.email = row?.email ?? '';
  form.kind = row?.kind ?? 'human';
  form.image = null;
  avatarDirty.value = false;
  if (row?.hasAvatar) {
    // existing avatar only enters the form as the preview src; not re-uploaded unless replaced
    avatarUrl.value = `/api/employees/${row.id}/avatar`;
  } else {
    avatarUrl.value = null;
  }
  form.title = row?.title ?? '';
  form.supervisorIds = row?.supervisorIds ? [...row.supervisorIds] : [];
  form.environmentId = row?.environmentId ?? '';
  form.instructions = row?.instructions ?? '';
  form.executable = row?.executable ?? '';
  form.providerId = row?.providerId ?? '__none__';
  form.model = row?.model ?? '';
  form.apiKeySecretId = row?.apiKeySecretId ?? null;
  message.value = '';
  mintedKey.value = '';
  editorOpen.value = true;
}

async function save() {
  busy.value = true;
  message.value = '';
  try {
    if ((editingId.value ? showAiFields.value : form.kind === 'ai') && !form.executable.trim()) {
      message.value = 'AI employees need an ACP executable (e.g. "hermes acp")';
      busy.value = false;
      return;
    }
    // typed-but-unknown titles join the catalog so they autocomplete next time
    if (form.title.trim() && !titles.value.some((t) => t.name === form.title.trim())) {
      await titleSaveMutation.mutateAsync({ name: form.title.trim() }).catch(() => {});
    }
    if (editingId.value) {
      await updateMutation.mutateAsync({
        id: editingId.value,
        name: form.name,
        email: form.email,
        ...(avatarDirty.value ? { image: form.image } : {}),
        title: form.title,
        supervisorIds: form.supervisorIds,
        ...(showAiFields.value && form.environmentId ? { environmentId: form.environmentId } : {}),
        ...(showAiFields.value ? { instructions: form.instructions } : {}),
        ...(showAiFields.value ? { executable: form.executable.trim() } : {}),
        ...(showAiFields.value ? { providerId: form.providerId === '__none__' ? null : form.providerId } : {}),
        ...(showAiFields.value ? { model: form.model || null } : {}),
        ...(showAiFields.value ? { apiKeySecretId: form.apiKeySecretId ?? null } : {}),
      });
    } else {
      const res = await createMutation.mutateAsync({
        name: form.name,
        email: form.email,
        ...(form.image ? { image: form.image } : {}),
        kind: form.kind,
        title: form.title,
        supervisorIds: form.supervisorIds,
        ...(form.kind === 'ai'
          ? {
              environmentId: form.environmentId,
              instructions: form.instructions,
              executable: form.executable.trim(),
              providerId: form.providerId === '__none__' ? null : form.providerId,
              model: form.model || null,
              apiKeySecretId: form.apiKeySecretId ?? null,
            }
          : {}),
      });
      // the API key returns ONCE — surface it before the modal closes
      if (res?.apiKey) mintedKey.value = res.apiKey as string;
    }
    if (!mintedKey.value) editorOpen.value = false;
  } catch (e) {
    message.value = e instanceof Error ? e.message : 'save failed';
  } finally {
    busy.value = false;
  }
}

function askRemove(row: EmployeeRow) {
  pendingDelete.value = row;
}

async function remove() {
  if (!pendingDelete.value) return;
  busy.value = true;
  try {
    await removeMutation.mutateAsync({ id: pendingDelete.value.id });
    pendingDelete.value = null;
  } catch (e) {
    pendingDelete.value = null;
    message.value = e instanceof Error ? e.message : 'delete failed';
  } finally {
    busy.value = false;
  }
}

// ---- Access keys drawer (any employee) ----
const keysOpen = ref(false);
const keysEmployee = ref<EmployeeRow | null>(null);
const keys = ref<ApiKeyRow[]>([]);
const keysBusy = ref(false);
const keysMessage = ref('');
const freshKey = ref('');
const mintName = ref('');
const renamingId = ref<string | null>(null);
const renameValue = ref('');

async function openKeys(row: EmployeeRow) {
  keysEmployee.value = row;
  keysOpen.value = true;
  keysMessage.value = '';
  freshKey.value = '';
  mintName.value = '';
  await refreshKeys();
}

async function refreshKeys() {
  if (!keysEmployee.value) return;
  keysBusy.value = true;
  try {
    keys.value = (await listKeysCall({ employeeId: keysEmployee.value.id })) as ApiKeyRow[];
  } catch (e) {
    keysMessage.value = e instanceof Error ? e.message : 'load failed';
  } finally {
    keysBusy.value = false;
  }
}

async function mintKey() {
  if (!keysEmployee.value) return;
  keysBusy.value = true;
  keysMessage.value = '';
  try {
    const res = await createKeyMutation.mutateAsync({
      employeeId: keysEmployee.value.id,
      ...(mintName.value.trim() ? { name: mintName.value.trim() } : {}),
    });
    freshKey.value = res.key as string;
    mintName.value = '';
    await refreshKeys();
  } catch (e) {
    keysMessage.value = e instanceof Error ? e.message : 'mint failed';
  } finally {
    keysBusy.value = false;
  }
}

async function startRename(k: ApiKeyRow) {
  renamingId.value = k.id;
  renameValue.value = k.name ?? '';
}

async function saveRename() {
  if (!renamingId.value || !renameValue.value.trim()) return;
  keysBusy.value = true;
  try {
    await $client.employees.updateApiKey({ keyId: renamingId.value, name: renameValue.value.trim() });
    renamingId.value = null;
    await refreshKeys();
  } catch (e) {
    keysMessage.value = e instanceof Error ? e.message : 'rename failed';
  } finally {
    keysBusy.value = false;
  }
}

async function revokeKey(keyId: string) {
  keysBusy.value = true;
  keysMessage.value = '';
  try {
    await revokeKeyMutation.mutateAsync({ keyId });
    await refreshKeys();
  } catch (e) {
    keysMessage.value = e instanceof Error ? e.message : 'revoke failed';
  } finally {
    keysBusy.value = false;
  }
}

const columns = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'title', header: 'Title' },
  { accessorKey: 'kind', header: 'Kind' },
  { accessorKey: 'supervisors', header: 'Supervisors' },
  { accessorKey: 'environment', header: 'Environment' },
  { accessorKey: 'actions', header: '' },
];

onServerPrefetch(() =>
  Promise.all([
    liveQuery.suspense(),
    envQuery.suspense(),
    titlesQuery.suspense(),
    providersLive.suspense(),
    secretsLive.suspense(),
  ]),
);
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
            <div
              class="inline-flex overflow-hidden rounded-md border border-zinc-300 dark:border-zinc-700"
              role="group"
              aria-label="View"
            >
              <button
                type="button"
                class="px-3 py-1.5 text-sm font-medium transition-colors"
                :class="
                  view === 'list'
                    ? 'bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-400'
                    : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                "
                aria-label="List view"
                @click="view = 'list'"
              >
                List
              </button>
              <button
                type="button"
                class="border-l border-zinc-300 px-3 py-1.5 text-sm font-medium transition-colors dark:border-zinc-700"
                :class="
                  view === 'graph'
                    ? 'bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-400'
                    : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                "
                aria-label="Graph view"
                @click="view = 'graph'"
              >
                Graph
              </button>
            </div>
            <UButton
              icon="i-lucide-briefcase"
              label="Titles"
              color="neutral"
              variant="outline"
              @click="titleManagerOpen = true"
            />
            <UButton icon="i-lucide-plus" label="New employee" @click="openEditor()" />
          </div>
        </div>

        <p v-if="message && !editorOpen" class="text-error text-sm">{{ message }}</p>

        <!-- Mobile: stacked cards (list view) -->
        <DataTable v-if="rows.length && view === 'list'" :data="rows" :columns="columns">
          <template #name-cell="{ row }">
            <div class="flex items-center gap-2">
              <span class="flex items-center gap-2">
                <img
                  v-if="row.original.hasAvatar"
                  :src="`/api/employees/${row.original.id}/avatar`"
                  :alt="row.original.name"
                  class="size-6 shrink-0 rounded-full object-cover"
                />
                <span class="text-sm font-medium text-zinc-900 dark:text-white">{{ row.original.name }}</span>
              </span>
              <span class="truncate font-mono text-xs text-zinc-400">{{ row.original.email }}</span>
            </div>
          </template>
          <template #title-cell="{ row }">
            <span class="text-sm text-zinc-600 dark:text-zinc-300">{{ row.original.title }}</span>
          </template>
          <template #kind-cell="{ row }">
            <UBadge
              :color="row.original.kind === 'ai' ? 'primary' : 'neutral'"
              variant="subtle"
              size="sm"
              :icon="row.original.kind === 'ai' ? 'i-lucide-bot' : 'i-lucide-user'"
            >
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
            <span
              v-if="row.original.kind === 'ai' && row.original.environmentId"
              class="font-mono text-xs text-zinc-500"
              >{{ envName(row.original.environmentId) }}</span
            >
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
                <UButton
                  icon="i-lucide-pencil"
                  variant="ghost"
                  color="neutral"
                  size="sm"
                  aria-label="Edit employee"
                  :disabled="busy"
                  @click="openEditor(row.original)"
                />
                <template #content>
                  <div class="px-3 py-1.5 text-xs">Edit employee</div>
                </template>
              </UPopover>
              <UPopover mode="hover">
                <UButton
                  icon="i-lucide-trash-2"
                  variant="ghost"
                  color="error"
                  size="sm"
                  aria-label="Delete employee"
                  :disabled="busy"
                  @click="askRemove(row.original)"
                />
                <template #content>
                  <div class="px-3 py-1.5 text-xs">Delete employee</div>
                </template>
              </UPopover>
            </div>
          </template>
          <template #mobile-item="{ row }">
            <UCard :ui="{ root: 'shadow-sm' }">
              <div class="flex items-start justify-between gap-2">
                <div class="flex min-w-0 items-center gap-2">
                  <img
                    v-if="row.hasAvatar"
                    :src="`/api/employees/${row.id}/avatar`"
                    :alt="row.name"
                    class="size-8 shrink-0 rounded-full object-cover"
                  />
                  <p class="truncate text-sm font-medium text-zinc-900 dark:text-white">{{ row.name }}</p>
                  <p class="truncate font-mono text-xs text-zinc-400">{{ row.email }}</p>
                  <p v-if="row.title" class="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{{ row.title }}</p>
                </div>
                <UBadge
                  :color="row.kind === 'ai' ? 'primary' : 'neutral'"
                  variant="subtle"
                  size="sm"
                  :icon="row.kind === 'ai' ? 'i-lucide-bot' : 'i-lucide-user'"
                >
                  {{ row.kind }}
                </UBadge>
              </div>
              <div
                v-if="row.supervisorIds.length || (row.kind === 'ai' && row.environmentId)"
                class="mt-2 flex flex-wrap gap-1"
              >
                <UBadge v-for="sid in row.supervisorIds" :key="sid" color="neutral" variant="soft" size="sm">
                  {{ byId.get(sid)?.name ?? sid.slice(0, 8) }}
                </UBadge>
                <UBadge
                  v-if="row.kind === 'ai' && row.environmentId"
                  color="info"
                  variant="soft"
                  size="sm"
                  icon="i-lucide-server"
                >
                  {{ envName(row.environmentId) }}
                </UBadge>
              </div>
              <div class="mt-3 flex justify-end gap-1">
                <UPopover mode="hover">
                  <UButton
                    icon="i-lucide-key-round"
                    variant="ghost"
                    color="neutral"
                    size="sm"
                    aria-label="Access keys"
                    :disabled="busy"
                    @click="openKeys(row)"
                  />
                  <template #content>
                    <div class="px-3 py-1.5 text-xs">Access keys</div>
                  </template>
                </UPopover>
                <UPopover mode="hover">
                  <UButton
                    icon="i-lucide-pencil"
                    variant="ghost"
                    color="neutral"
                    size="sm"
                    aria-label="Edit employee"
                    :disabled="busy"
                    @click="openEditor(row)"
                  />
                  <template #content>
                    <div class="px-3 py-1.5 text-xs">Edit employee</div>
                  </template>
                </UPopover>
                <UPopover mode="hover">
                  <UButton
                    icon="i-lucide-trash-2"
                    variant="ghost"
                    color="error"
                    size="sm"
                    aria-label="Delete employee"
                    :disabled="busy"
                    @click="askRemove(row)"
                  />
                  <template #content>
                    <div class="px-3 py-1.5 text-xs">Delete employee</div>
                  </template>
                </UPopover>
              </div>
            </UCard>
          </template>
        </DataTable>

        <UCard v-else-if="view === 'list'" :ui="{ root: 'shadow-sm' }">
          <div class="flex flex-col items-center gap-2 py-8 text-center">
            <UIcon name="i-lucide-users" class="size-8 text-zinc-300" />
            <p class="text-sm text-zinc-500">No employees yet — add the first human or AI teammate.</p>
            <UButton
              icon="i-lucide-briefcase"
              size="sm"
              label="Titles"
              color="neutral"
              variant="outline"
              @click="titleManagerOpen = true"
            />
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
            <svg :width="graphWidth" :height="graphHeight" role="img" aria-label="Supervision hierarchy">
              <!-- primary tree: elbow from parent bottom-center to child top-center -->
              <path
                v-for="pi in primaryEdgeIndices"
                :key="`p-${graphLayout[pi]!.row.id}`"
                :d="primaryPath(pi)"
                fill="none"
                class="stroke-zinc-400 dark:stroke-zinc-600"
                stroke-width="2"
              />
              <!-- extra supervisor edges: solid curve parent-bottom -> child-top -->
              <path
                v-for="(e, k) in secondaryEdges"
                :key="`sec-${k}`"
                :d="secondaryTopPath(e.fromIndex, e.toIndex)"
                fill="none"
                class="stroke-zinc-400 dark:stroke-zinc-600"
                stroke-width="2"
              />
              <g v-for="(n, i) in graphLayout" :key="n.row.id" :transform="`translate(${n.x}, ${n.y})`">
                <rect
                  :width="NODE_W"
                  :height="NODE_H"
                  rx="10"
                  class="fill-white stroke-zinc-200 dark:fill-zinc-900 dark:stroke-zinc-700"
                  stroke-width="1.5"
                />
                <defs>
                  <clipPath :id="`av-${n.row.id}`">
                    <circle cx="28" cy="26" r="17" />
                  </clipPath>
                </defs>
                <circle
                  cx="28"
                  cy="26"
                  r="17"
                  :class="
                    n.row.kind === 'ai'
                      ? 'fill-primary-100 stroke-primary-400 dark:fill-primary-500/20'
                      : 'fill-zinc-100 stroke-zinc-300 dark:fill-zinc-800'
                  "
                  stroke-width="1.5"
                />
                <image
                  v-if="n.row.hasAvatar"
                  :href="`/api/employees/${n.row.id}/avatar`"
                  x="11"
                  y="9"
                  width="34"
                  height="34"
                  :clip-path="`url(#av-${n.row.id})`"
                  preserveAspectRatio="xMidYMid slice"
                />
                <text
                  v-else
                  x="28"
                  y="30"
                  text-anchor="middle"
                  class="fill-zinc-600 text-[11px] font-semibold dark:fill-zinc-300"
                >
                  {{ n.row.kind === 'ai' ? 'AI' : n.row.name.slice(0, 1) }}
                </text>
                <text x="52" y="22" class="fill-zinc-900 text-[12px] font-medium dark:fill-white">
                  {{ n.row.name.length > 14 ? n.row.name.slice(0, 14) + '…' : n.row.name }}
                </text>
                <text x="52" y="38" class="fill-zinc-400 text-[10px]">
                  {{ (n.row.title || n.row.email).slice(0, 16) }}
                </text>
                <text x="8" :y="NODE_H - 12" class="fill-zinc-400 text-[10px]">
                  {{ n.row.kind === 'ai' ? 'AI agent' : 'Human' }}
                </text>
              </g>
            </svg>
          </div>
        </UCard>

        <!-- titles manager (statuses-style) -->
        <UModal
          v-model:open="titleManagerOpen"
          title="Employee titles"
          :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }"
        >
          <template #body>
            <div v-if="titleError" class="bg-error/10 text-error mb-3 rounded-md px-3 py-2 text-xs">
              {{ titleError }}
            </div>
            <div v-if="titles.length" class="divide-default divide-y">
              <div v-for="t in titles" :key="t.id" class="flex items-center gap-2 py-2.5">
                <UBadge color="neutral" variant="subtle" icon="i-lucide-briefcase">{{ t.name }}</UBadge>
                <span class="text-xs text-zinc-500"
                  >{{ t.employees }} {{ t.employees === 1 ? 'employee' : 'employees' }}</span
                >
                <span class="flex-1" />
                <UPopover mode="hover">
                  <UButton
                    icon="i-lucide-pencil"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    aria-label="Rename title"
                    :disabled="titleBusy"
                    @click="openTitleEditor(t.id)"
                  />
                  <template #content><div class="px-3 py-1.5 text-xs">Rename</div></template>
                </UPopover>
                <UPopover mode="hover">
                  <UButton
                    icon="i-lucide-trash-2"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    aria-label="Delete title"
                    :disabled="titleBusy"
                    @click="titleConfirmId = t.id"
                  />
                  <template #content><div class="px-3 py-1.5 text-xs">Delete</div></template>
                </UPopover>
              </div>
            </div>
            <p v-else class="py-6 text-center text-sm text-zinc-500">
              No titles yet — create one to standardize roles.
            </p>
          </template>
          <template #footer>
            <div class="flex w-full items-center justify-between gap-2">
              <UButton icon="i-lucide-plus" size="sm" label="New title" @click="openTitleEditor()" />
            </div>
          </template>
        </UModal>

        <!-- title editor -->
        <UModal
          v-model:open="titleEditorOpen"
          :title="titleEditingId ? 'Rename title' : 'New title'"
          :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }"
        >
          <template #body>
            <UFormField label="Name" name="name" required>
              <UInput
                v-model="titleForm.name"
                icon="i-lucide-briefcase"
                placeholder="e.g. Senior Engineer"
                class="w-full"
                :disabled="titleBusy"
              />
            </UFormField>
            <p class="mt-2 text-xs text-zinc-500">Renaming updates every employee who holds this title.</p>
          </template>
          <template #footer>
            <div class="flex w-full justify-end gap-2">
              <UButton variant="ghost" color="neutral" @click="titleEditorOpen = false">Cancel</UButton>
              <UButton icon="i-lucide-check" :loading="titleBusy" @click="saveTitle">Save</UButton>
            </div>
          </template>
        </UModal>

        <!-- title delete confirm: employees keep their text -->
        <UModal
          :open="titleConfirmId !== null"
          @update:open="
            (v: boolean) => {
              if (!v) titleConfirmId = null;
            }
          "
          title="Delete title"
        >
          <template #body>
            <p class="text-sm">
              Delete <strong>{{ titleConfirming?.name }}</strong> from the catalog? Employees keep their title text — it
              just stops being offered in the picker.
            </p>
          </template>
          <template #footer>
            <div class="flex w-full justify-end gap-2">
              <UButton variant="ghost" color="neutral" @click="titleConfirmId = null">Cancel</UButton>
              <UButton
                color="error"
                icon="i-lucide-trash-2"
                :loading="titleBusy"
                @click="removeTitle(titleConfirming!.id)"
                >Delete</UButton
              >
            </div>
          </template>
        </UModal>

        <UModal
          v-model:open="editorOpen"
          :title="isEdit ? 'Edit employee' : 'New employee'"
          :ui="{ content: 'max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-4rem)]', body: 'overflow-y-auto' }"
        >
          <template #body>
            <div class="max-h-[55dvh] overflow-y-auto px-4 sm:px-6">
              <UForm id="employee-editor-form" :state="form" class="space-y-4" @submit="save">
                <UFormField label="Name" name="name">
                  <UInput v-model="form.name" icon="i-lucide-user" placeholder="Full name" class="w-full" required />
                </UFormField>
                <UFormField label="Email (login)" name="email">
                  <template #hint
                    ><FormHint text="Humans sign in with it; AI employees authenticate by API key"
                  /></template>
                  <UInput
                    v-model="form.email"
                    icon="i-lucide-at-sign"
                    placeholder="name@company.com"
                    class="w-full"
                    required
                  />
                </UFormField>
                <UFormField label="Avatar" name="avatar">
                  <template #hint><FormHint text="square photo, resized to 256px" /></template>
                  <div class="flex items-center gap-3">
                    <span
                      class="bg-elevated text-muted inline-flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-full text-lg font-semibold"
                    >
                      <img
                        v-if="form.image"
                        :src="form.image"
                        alt="avatar preview"
                        class="size-12 rounded-full object-cover"
                      />
                      <img
                        v-else-if="avatarUrl"
                        :src="avatarUrl"
                        alt="avatar preview"
                        class="size-12 rounded-full object-cover"
                      />
                      <template v-else>{{ form.kind === 'ai' ? 'AI' : form.name.slice(0, 1) || '?' }}</template>
                    </span>
                    <input
                      type="file"
                      accept="image/*"
                      class="w-full text-xs"
                      :disabled="busy"
                      @change="onAvatarPicked"
                    />
                    <UButton
                      v-if="form.image"
                      icon="i-lucide-x"
                      size="xs"
                      color="neutral"
                      variant="soft"
                      aria-label="Remove avatar"
                      @click="
                        form.image = null;
                        avatarDirty = true;
                        avatarUrl = null;
                      "
                    />
                  </div>
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
                  <UBadge
                    :color="editingIsAi ? 'primary' : 'neutral'"
                    variant="subtle"
                    :icon="editingIsAi ? 'i-lucide-bot' : 'i-lucide-user'"
                  >
                    {{ editingIsAi ? 'AI agent (immutable)' : 'Human (immutable)' }}
                  </UBadge>
                </UFormField>
                <UFormField label="Title" name="title">
                  <template #hint><FormHint text="Place in the company, e.g. Senior Engineer" /></template>
                  <AutoCompleteInput
                    v-model="form.title"
                    :items="titles.map((t) => t.name)"
                    icon="i-lucide-briefcase"
                    placeholder="Job title"
                    create-hint="A new title will be added to the catalog"
                    :disabled="busy"
                  />
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
                  <UFormField label="ACP executable" name="executable" required>
                    <template #hint
                      ><FormHint text="Command that starts an ACP server on stdio in the environment"
                    /></template>
                    <UInput
                      v-model="form.executable"
                      icon="i-lucide-terminal"
                      placeholder="hermes acp"
                      class="w-full"
                      data-testid="acp-executable-input"
                    />
                  </UFormField>
                  <UFormField label="Provider" name="providerId">
                    <template #hint><FormHint text="Model endpoint this agent uses" /></template>
                    <USelect
                      v-model="form.providerId"
                      :items="[
                        { label: 'No provider', value: '__none__' },
                        ...modelProviders.map((p) => ({ label: p.label, value: p.id })),
                      ]"
                      value-key="value"
                      icon="i-lucide-plug"
                      placeholder="Select a provider"
                      class="w-full"
                    />
                  </UFormField>
                  <UFormField label="Model" name="model">
                    <template #hint
                      ><FormHint text="Model name the agent runs — pick from the list or type your own"
                    /></template>
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
                    <template #hint
                      ><FormHint text="Vault secret holding the key (per-agent, injected per run)"
                    /></template>
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
                    <UTextarea
                      v-model="form.instructions"
                      :rows="4"
                      placeholder="Custom instructions for this agent…"
                      class="w-full"
                    />
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
                <div
                  v-if="mintedKey"
                  class="rounded-lg border-2 border-amber-400/70 bg-amber-50 p-4 dark:bg-amber-950/40"
                >
                  <p class="flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-200">
                    <UIcon name="i-lucide-key-round" class="size-4" />
                    API key created — shown only once
                  </p>
                  <p class="mt-1 text-xs text-amber-700 dark:text-amber-300">
                    Copy it now; it cannot be retrieved later.
                  </p>
                  <div class="mt-3 flex items-center gap-2">
                    <code
                      class="flex-1 rounded-md bg-white/70 px-2.5 py-2 font-mono text-sm break-all text-amber-900 dark:bg-black/30 dark:text-amber-100"
                      >{{ mintedKey }}</code
                    >
                    <UButton
                      :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
                      :color="copied ? 'success' : 'neutral'"
                      variant="soft"
                      size="sm"
                      :label="copied ? 'Copied' : 'Copy'"
                      @click="copyKey(mintedKey)"
                    />
                  </div>
                  <UButton
                    class="mt-3"
                    size="sm"
                    color="primary"
                    variant="solid"
                    label="Done — I saved the key"
                    @click="editorOpen = false"
                  />
                </div>
              </UForm>
            </div>
          </template>
          <template #footer>
            <div class="flex w-full justify-end gap-2">
              <UButton variant="ghost" color="neutral" label="Cancel" :disabled="busy" @click="editorOpen = false" />
              <UButton
                type="submit"
                :loading="busy"
                :label="isEdit ? 'Save changes' : 'Create employee'"
                form="employee-editor-form"
              />
            </div>
          </template>
        </UModal>

        <UModal v-model:open="deleteOpen" title="Delete employee" :ui="{ content: 'max-w-sm' }">
          <template #body>
            <div class="space-y-4">
              <p class="text-sm text-zinc-600 dark:text-zinc-300">
                Delete <span class="font-semibold text-zinc-900 dark:text-white">{{ pendingDelete?.name }}</span> ({{
                  pendingDelete?.email
                }})? Their login, supervision links, API keys{{
                  pendingDelete?.kind === 'ai' ? ', and AI extension' : ''
                }}
                are removed permanently.
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
                Access keys authenticate API calls to Tandem as {{ keysEmployee?.name ?? 'this employee' }} — nothing to
                do with the model provider API key in the editor.
              </p>
              <p v-if="keysMessage" class="text-error text-sm">{{ keysMessage }}</p>
              <div v-if="freshKey" class="rounded-lg border-2 border-amber-400/70 bg-amber-50 p-4 dark:bg-amber-950/40">
                <p class="flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-200">
                  <UIcon name="i-lucide-key-round" class="size-4" />
                  New key — shown only once
                </p>
                <div class="mt-3 flex items-center gap-2">
                  <code
                    class="flex-1 rounded-md bg-white/70 px-2.5 py-2 font-mono text-sm break-all text-amber-900 dark:bg-black/30 dark:text-amber-100"
                    >{{ freshKey }}</code
                  >
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
                    <p class="font-mono text-xs text-zinc-400">
                      {{ k.prefix }}{{ k.start }}… · created {{ new Date(k.createdAt).toLocaleDateString() }}
                    </p>
                  </div>
                  <div v-else class="flex min-w-0 flex-1 items-center gap-1">
                    <UInput
                      v-model="renameValue"
                      size="xs"
                      placeholder="Key name"
                      class="flex-1"
                      @keydown.enter.prevent="saveRename"
                    />
                    <UPopover mode="hover"
                      ><UButton
                        icon="i-lucide-check"
                        variant="ghost"
                        color="primary"
                        size="xs"
                        aria-label="Save name"
                        :loading="keysBusy"
                        @click="saveRename"
                      /><template #content><div class="px-3 py-1.5 text-xs">Save name</div></template></UPopover
                    >
                    <UPopover mode="hover"
                      ><UButton
                        icon="i-lucide-x"
                        variant="ghost"
                        color="neutral"
                        size="xs"
                        aria-label="Cancel rename"
                        @click="renamingId = null"
                      /><template #content><div class="px-3 py-1.5 text-xs">Cancel</div></template></UPopover
                    >
                  </div>
                  <div v-if="renamingId !== k.id" class="flex shrink-0 gap-1">
                    <UPopover mode="hover"
                      ><UButton
                        icon="i-lucide-pencil"
                        variant="ghost"
                        color="neutral"
                        size="xs"
                        aria-label="Rename key"
                        :disabled="keysBusy"
                        @click="startRename(k)"
                      /><template #content><div class="px-3 py-1.5 text-xs">Rename key</div></template></UPopover
                    >
                    <UPopover mode="hover"
                      ><UButton
                        icon="i-lucide-trash-2"
                        variant="ghost"
                        color="error"
                        size="xs"
                        aria-label="Revoke key"
                        :loading="keysBusy"
                        @click="revokeKey(k.id)"
                      /><template #content><div class="px-3 py-1.5 text-xs">Revoke key</div></template></UPopover
                    >
                  </div>
                </div>
              </div>
              <p v-else-if="!keysBusy" class="text-sm text-zinc-500">No keys.</p>
              <UFormField label="Key name" name="mintName" class="pt-1">
                <UInput v-model="mintName" icon="i-lucide-tag" placeholder="e.g. ci-deploy (optional)" class="w-full" />
              </UFormField>
              <div class="flex justify-end gap-2 pt-1">
                <UButton
                  icon="i-lucide-key-round"
                  size="sm"
                  label="Mint new key"
                  :loading="keysBusy"
                  @click="mintKey"
                />
              </div>
            </div>
          </template>
        </UModal>
      </div>
    </template>
  </UDashboardPanel>
</template>
