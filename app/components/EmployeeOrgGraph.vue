<script setup lang="ts">
// Supervision-hierarchy org chart: ONE box per employee, ONE line per
// supervision edge, top-down layered tree with elbow connectors. Renders only
// the graph card incl. its empty state — the parent owns the view toggle.
import { computed } from 'vue';

import { nonNull } from '#shared/utils/non-null';
import type { EmployeeRow } from '~/utils/orpc-types';

const props = defineProps<{ rows: EmployeeRow[] }>();

const rows = computed(() => props.rows);

const byId = computed(() => new Map(rows.value.map((r) => [r.id, r])));

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
    if (widthCache.has(r.id)) return nonNull(widthCache.get(r.id));
    const next = new Set(path).add(r.id);
    const ch = (kids.get(r.id) ?? []).filter((c) => primaryOf(c) === r.id);
    let w = 1;
    for (const c of ch) w += subtreeWidth(c, next);
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
    const n = nonNull(nodes[i]);
    const primaryId = n.parentIndex >= 0 ? nonNull(nodes[n.parentIndex]).row.id : null;
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
  const n = nonNull(nodes[i]);
  const p = nonNull(nodes[n.parentIndex]);
  const px = p.x + NODE_W / 2;
  const py = p.y + NODE_H;
  const cx = n.x + NODE_W / 2;
  const cy = n.y;
  return `M ${px} ${py} V ${(py + cy) / 2} H ${cx} V ${cy}`;
}
function secondaryTopPath(fromIndex: number, toIndex: number): string {
  const nodes = graphLayout.value;
  const p = nonNull(nodes[fromIndex]);
  const c = nonNull(nodes[toIndex]);
  const px = p.x + NODE_W / 2;
  const py = p.y + NODE_H;
  const cx = c.x + NODE_W / 2;
  const cy = c.y;
  return `M ${px} ${py} C ${px} ${py + ROW_GAP * 0.6}, ${cx} ${cy - ROW_GAP * 0.6}, ${cx} ${cy}`;
}
</script>

<template>
  <UCard :ui="{ root: 'shadow-sm', body: 'p-0 sm:p-0' }">
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
</template>
