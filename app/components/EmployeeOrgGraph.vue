<script setup lang="ts">
// Supervision-hierarchy org chart: ONE box per employee, ONE line per
// supervision edge, top-down layered tree with elbow connectors. The canvas
// flexes to the remaining viewport height and centers the tree inside itself
// (scrolls when a big org overflows — no zoom). Renders only the graph card
// incl. its empty state — the parent owns the view toggle.
import { computed } from 'vue';

import { nonNull } from '#shared/utils/non-null';
import { employeeAvatarUrl } from '~/utils/api-urls';
import type { EmployeeRow } from '~/utils/orpc-types';
import { kindLabel } from '~/utils/ui-labels';

// loading/error mirror the parent's list query — an empty graph while the query
// is still in flight (or failed) reads as 'no employees', which is a lie
const props = withDefaults(defineProps<{ rows: EmployeeRow[]; loading?: boolean; error?: boolean }>(), {
  loading: false,
  error: false,
});
const emit = defineEmits<{ retry: [] }>();

const rows = computed(() => props.rows);

const byId = computed(() => new Map(rows.value.map((r) => [r.id, r])));

/** roots = employees with no supervisor (or supervisor missing) — they sit on the top row */
const roots = computed(() =>
  rows.value.filter((r) => r.supervisorIds.length === 0 || r.supervisorIds.every((id) => !byId.value.has(id))),
);

/** the SVG is decoration to a screen reader: the same hierarchy as a plain list
 *  of reporting lines, one item per employee */
const reportingLines = computed(() =>
  rows.value.map((r) => {
    const supervisors = r.supervisorIds
      .map((id) => byId.value.get(id)?.name)
      .filter((n): n is string => !!n)
      .join(', ');
    return {
      id: r.id,
      text: `${r.name}${r.title ? `, ${r.title}` : ''} — ${supervisors ? `reports to ${supervisors}` : 'no supervisor'}`,
    };
  }),
);

/** ONE box per employee; ONE line per supervision edge.
 * TOP-DOWN layered layout (classic org chart): depth = row, subtree width =
 * leaf count; children centered under their parent, elbow connectors from the
 * parent's bottom-center to each child's top-center. Extra supervisor edges
 * (multi-parent) curve from the other supervisor's bottom to the child's top. */
type GraphNode = {
  row: EmployeeRow;
  depth: number;
  parentIndex: number;
  x: number;
  y: number;
};
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
  // width = number of leaves in the subtree (min 1); cycle-guarded by path
  const widthCache = new Map<string, number>();
  const subtreeWidth = (r: EmployeeRow, path: Set<string>): number => {
    if (path.has(r.id)) return 1;
    if (widthCache.has(r.id)) return nonNull(widthCache.get(r.id));
    const next = new Set(path).add(r.id);
    const ch = (kids.get(r.id) ?? []).filter((c) => primaryOf(c) === r.id);
    const w = ch.length ? ch.reduce((acc, c) => acc + Math.max(1, subtreeWidth(c, next)), 0) : 1;
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
  // orphans (supervisors outside the placed forest) become extra roots — Set-based
  const rootIds = new Set(rootList.map((r) => r.id));
  for (const r of rows.value) {
    if (rootIds.has(r.id) || indexById.has(r.id)) continue;
    if (!r.supervisorIds.some((id) => indexById.has(id))) {
      rootList.push(r);
      rootIds.add(r.id);
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

/** primary edges resolved to paths — the template iterates plain objects, so
 * the non-null contract lives here instead of in the markup */
const primaryEdgePaths = computed(() =>
  primaryEdgeIndices.value.map((pi) => ({ id: nonNull(graphLayout.value[pi]).row.id, d: primaryPath(pi) })),
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

/** hard-truncate a label to `max` chars with a real ellipsis (SVG has no text-overflow) */
function fitLabel(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…` : text;
}

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
  <UCard
    :ui="{
      root: 'shadow-sm flex min-h-0 flex-col',
      body: 'flex min-h-0 flex-1 flex-col p-0 sm:p-0',
    }"
  >
    <div v-if="loading" class="flex flex-1 flex-col items-center justify-center gap-3 py-10" aria-hidden="true">
      <USkeleton class="h-20 w-48 rounded-xl" />
      <USkeleton class="h-20 w-64 rounded-xl" />
    </div>
    <div
      v-else-if="error"
      role="alert"
      class="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-center"
    >
      <p class="text-error text-sm">Couldn't load the org chart — try again</p>
      <UButton size="sm" variant="soft" icon="i-lucide-refresh-cw" label="Retry" @click="emit('retry')" />
    </div>
    <div v-else-if="!rows.length" class="flex flex-1 flex-col items-center justify-center gap-2 py-10 text-center">
      <UIcon name="i-lucide-users" class="text-dimmed size-8" />
      <p class="text-muted text-sm">No employees yet — add the first human or AI teammate.</p>
    </div>
    <!-- the canvas fills the remaining viewport height (parent grants flex-1);
         the tree centers inside it and pans when a wide/tall org overflows.
         Below md the svg floors at 720px: plain w-full squeezed the chart into
         the viewport so overflow never engaged — the floor keeps node text at a
         legible scale and lets small screens pan. -->
    <div v-else class="flex min-h-0 flex-1 overflow-auto p-4">
      <ul class="sr-only" aria-label="Reporting lines">
        <li v-for="line in reportingLines" :key="line.id">{{ line.text }}</li>
      </ul>
      <svg
        :viewBox="`0 0 ${graphWidth} ${graphHeight}`"
        :width="graphWidth"
        :height="graphHeight"
        role="group"
        aria-label="Supervision hierarchy"
        class="m-auto h-auto w-full max-w-full min-w-[720px] shrink-0 md:h-auto md:w-auto md:min-w-0"
      >
        <!-- primary tree: elbow from parent bottom-center to child top-center -->
        <path
          v-for="e in primaryEdgePaths"
          :key="`p-${e.id}`"
          :d="e.d"
          fill="none"
          class="stroke-(--ui-border-accented)"
          stroke-width="2"
        />
        <!-- extra supervisor edges: solid curve parent-bottom -> child-top -->
        <path
          v-for="(e, k) in secondaryEdges"
          :key="`sec-${k}`"
          :d="secondaryTopPath(e.fromIndex, e.toIndex)"
          fill="none"
          class="stroke-(--ui-border-accented)"
          stroke-width="2"
        />
        <g
          v-for="n in graphLayout"
          :key="n.row.id"
          role="img"
          :aria-label="`${n.row.name}, ${n.row.title || n.row.email || 'no title'}, ${kindLabel(n.row.kind)}`"
          :transform="`translate(${n.x}, ${n.y})`"
        >
          <rect
            :width="NODE_W"
            :height="NODE_H"
            rx="10"
            class="fill-(--ui-bg-elevated) stroke-(--ui-border)"
            stroke-width="1.5"
          />
          <defs>
            <clipPath :id="`av-${n.row.id}`">
              <circle cx="28" cy="26" r="17" />
            </clipPath>
          </defs>
          <!-- avatar: same 34px circle for every node — photo, or initial with an
               AI tint matching the table badges -->
          <circle
            cx="28"
            cy="26"
            r="17"
            :class="
              n.row.kind === 'ai' ? 'fill-primary/15 stroke-primary/40' : 'fill-(--ui-bg) stroke-(--ui-border-accented)'
            "
            stroke-width="1.5"
          />
          <image
            v-if="n.row.hasAvatar"
            :href="employeeAvatarUrl(n.row.id)"
            x="11"
            y="9"
            width="34"
            height="34"
            :clip-path="`url(#av-${n.row.id})`"
            preserveAspectRatio="xMidYMid slice"
          />
          <text v-else x="28" y="30" text-anchor="middle" class="fill-(--ui-text-toned) text-[11px] font-semibold">
            {{ n.row.kind === 'ai' ? 'AI' : n.row.name.slice(0, 1) }}
          </text>
          <text x="52" y="22" class="fill-(--ui-text-highlighted) text-[12px] font-medium">
            {{ fitLabel(n.row.name, 14) }}
            <title>{{ n.row.name }}</title>
          </text>
          <text x="52" y="38" class="fill-(--ui-text-dimmed) text-[10px]">
            {{ fitLabel(n.row.title || n.row.email, 20) }}
            <title>{{ n.row.title || n.row.email }}</title>
          </text>
          <text x="8" :y="NODE_H - 12" class="fill-(--ui-text-dimmed) text-[10px]">
            {{ kindLabel(n.row.kind) }}
          </text>
        </g>
      </svg>
    </div>
  </UCard>
</template>
