<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
// The task-detail chat thread: the brief (description bubble), agent run turns
// and activity notes merged into one ordered timeline. Self-loads runs +
// activity + employees (same query keys the app-wide changes subscription
// invalidates; SSE law: first load is a conventional GET) and autoscrolls to
// the newest item. Props: the resolved `task` row.
import { computed, nextTick, onServerPrefetch, ref, watch } from 'vue';

import { CHANGE_RESOURCE } from '#shared/enums';
import { nonNull } from '#shared/utils/non-null';
import { formatWhenShort } from '~/utils/format-when';
import type { EmployeeRow, TaskRow } from '~/utils/orpc-types';
import { buildThread, parseRunEnvelope } from '~/utils/task-thread';
import type { ThreadItem } from '~/utils/task-thread';

const props = defineProps<{ task: TaskRow }>();

const { $orpc } = useNuxtApp();

const taskId = computed(() => props.task.id);

// ---- first-load data via GET + change-event invalidation (SSE law) -----------
// the unified conversation thread loads as one conventional GET as soon as the
// task resolves; the app-wide changes subscription refetches it on task-activity
// events (dispatch, notes, verdicts). No long-lived stream for initial data.
const threadQuery = useQuery(
  computed(() =>
    $orpc.tasks.threadList.queryOptions({
      input: { taskId: taskId.value },
      queryKey: [CHANGE_RESOURCE.TASK_ACTIVITY, taskId.value],
    }),
  ),
);
type ThreadRow = {
  id: string;
  body: string;
  createdAt: string;
  authorId: string | null;
  authorName: string | null;
  run: null | {
    id: string;
    status: string;
    output: string;
    prompt: string | null;
    agentName: string | null;
    exitCode: number | null;
    startedAt: string;
    finishedAt: string | null;
    outputs: Array<{ id: string; filename: string; mime: string; size: number }>;
  };
  activity: Record<string, unknown> | null;
};
const threadRows = computed(() => (unref(threadQuery.data) ?? []) as unknown as ThreadRow[]);
// the run's thread message carries the settled result body — attach it to the run feed
const runFeed = computed(() =>
  threadRows.value.flatMap((r) =>
    r.run ? [{ ...r.run, body: r.body, authorId: r.authorId, authorName: r.authorName }] : [],
  ),
);
const workflowFeed = computed(() =>
  threadRows.value
    .filter((r) => r.activity)
    .map((r) => ({
      id: r.id,
      kind: String(r.activity?.kind ?? ''),
      body: r.body,
      authorName: r.authorName,
      authorId: r.authorId,
      createdAt: r.createdAt,
    })),
);
const employeesLive = useQuery($orpc.employees.list.queryOptions({ queryKey: [CHANGE_RESOURCE.EMPLOYEES] }));
const employees = computed(() => (unref(employeesLive.data) ?? []) as EmployeeRow[]);
/** userId -> hasAvatar: chat avatars render via /api/employees/:userId/avatar, initials otherwise */
const hasAvatarByUserId = computed(() => new Map(employees.value.map((e) => [e.userId, e.hasAvatar])));

// the task creator opens the thread as the brief's author
const briefAuthor = computed(() => props.task.creatorName ?? null);

// run status reads as a word, not a pill: the task status badge owns color — a
// run turn's outcome stays a tiny neutral label so the two never look alike
type RunStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'timeout' | 'stopped';
function mapRunStatus(raw: string): RunStatus {
  const s = raw.toLowerCase();
  if (s === 'running') return 'running';
  if (s === 'done') return 'done';
  if (s === 'failed') return 'failed';
  if (s === 'cancelled') return 'cancelled';
  if (s === 'timeout') return 'timeout';
  return 'stopped';
}
const runStatusById = computed(() => {
  const m = new Map<string, RunStatus>();
  for (const r of runFeed.value) m.set(r.id, mapRunStatus(r.status));
  return m;
});
const RUN_LABEL: Record<RunStatus, string> = {
  running: 'Working',
  done: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  timeout: 'Timed out',
  stopped: 'Stopped',
};

// ---- one ordered timeline from runs + activity + description -----------------
const thread = computed<ThreadItem[]>(() =>
  buildThread({
    description: props.task.description ?? null,
    createdAt: props.task.createdAt ?? null,
    briefAuthorName: props.task.creatorName ?? null,
    briefAuthorId: props.task.createdBy ?? null,
    runs: runFeed.value.map((r) => ({
      id: r.id,
      status: (r.status.toLowerCase() === 'running'
        ? 'running'
        : r.status.toLowerCase() === 'done'
          ? 'done'
          : 'failed') as 'running' | 'done' | 'failed',
      output: r.output,
      prompt: r.prompt,
      body: r.body,
      agentName: r.agentName,
      authorId: r.authorId ?? null,
      authorName: r.authorName ?? null,
      exitCode: r.exitCode,
      startedAt: r.startedAt,
      finishedAt: null,
    })),
    activity: workflowFeed.value.map((a) => ({
      id: a.id,
      noteKind: a.kind,
      body: a.body,
      authorName: a.authorName,
      authorId: a.authorId,
      createdAt: a.createdAt,
    })),
  }),
);

const scroller = ref<HTMLElement | null>(null);

const outputsByRun = computed(() => {
  const m = new Map<string, Array<{ id: string; filename: string; mime: string; size: number }>>();
  for (const r of runFeed.value) if (r.outputs?.length) m.set(r.id, r.outputs);
  return m;
});
watch(
  () => thread.value.length,
  async () => {
    await nextTick();
    scroller.value?.scrollTo({ top: scroller.value.scrollHeight });
  },
);

function runOutputs(item: ThreadItem) {
  return item.kind === 'run' ? (outputsByRun.value.get(item.id) ?? []) : [];
}

/** split the brief description into text + attachment refs for rendering */
const briefParts = computed(() => {
  const desc = props.task.description ?? '';
  const parts: Array<
    | { type: 'text'; body: string }
    | { type: 'mention'; label: string }
    | { type: 'image'; id: string; alt: string }
    | { type: 'file'; id: string; name: string }
  > = [];
  // split attachments first, then employee mentions inside the text parts
  const re = /!\[([^\]]*)\]\(attachment-([^)]+)\)|@\[([^\]]*)\]\(attachment-([^)]+)\)/g;
  let last = 0;
  for (const m of desc.matchAll(re)) {
    if (nonNull(m.index) > last) pushText(desc.slice(last, m.index));
    if (m[2] !== undefined) parts.push({ type: 'image', id: nonNull(m[2]), alt: nonNull(m[1]) });
    else parts.push({ type: 'file', id: nonNull(m[4]), name: nonNull(m[3]) });
    last = nonNull(m.index) + m[0].length;
  }
  if (last < desc.length) pushText(desc.slice(last));
  return parts;

  function pushText(text: string) {
    // either tiptap link form `@[Label](mention-id)` or serialized span `[@ id="..." label="..."]`
    const re = /@\[([^\]]+)\]\(mention-[^)]+\)|\[@\s*id="[^"]*"\s+label="([^"]+)"\]/g;
    let at = 0;
    for (const m of text.matchAll(re)) {
      if (nonNull(m.index) > at) parts.push({ type: 'text', body: text.slice(at, m.index) });
      parts.push({ type: 'mention', label: m[1] ?? m[2] ?? '' });
      at = nonNull(m.index) + m[0].length;
    }
    if (at < text.length) parts.push({ type: 'text', body: text.slice(at) });
  }
});

function envelopeOf(item: ThreadItem) {
  return item.kind === 'run' ? parseRunEnvelope(item.output) : null;
}

onServerPrefetch(() => Promise.all([threadQuery.suspense(), employeesLive.suspense()]));
</script>

<template>
  <!-- the thread: content only — the page owns the single card border -->
  <div ref="scroller" class="max-h-[min(60dvh,42rem)] min-h-0 flex-1 space-y-4 overflow-y-auto p-3.5 lg:max-h-none">
    <p v-if="!thread.length" class="text-dimmed py-10 text-center text-xs">
      No activity yet — write a note below or dispatch the agent.
    </p>

    <template v-for="item in thread" :key="item.id">
      <!-- brief: the task description as the opening message -->
      <div v-if="item.kind === 'brief'" class="flex gap-2.5">
        <img
          v-if="item.authorId && hasAvatarByUserId.get(item.authorId)"
          :src="`/api/employees/${item.authorId}/avatar`"
          :alt="item.authorName ?? 'Task brief'"
          class="mt-0.5 size-8 shrink-0 rounded-full object-cover"
        />
        <div
          v-else
          class="bg-accented text-toned mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
        >
          {{ briefAuthor ? briefAuthor.slice(0, 2).toUpperCase() : 'T' }}
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-dimmed mb-1 text-[11px] font-medium">
            {{ briefAuthor ?? 'Task brief' }}
            <span v-if="item.createdAt" class="text-muted font-normal">· {{ formatWhenShort(item.createdAt) }}</span>
          </p>
          <!-- description: mention tokens -> @Name; attachment tokens -> inline images / file chips -->
          <div
            class="border-default bg-muted text-default inline-block max-w-[85%] rounded-xl rounded-tl-sm border px-3.5 py-2.5 text-sm leading-relaxed"
          >
            <template v-for="(p, i) in briefParts" :key="i">
              <span
                v-if="p.type === 'mention'"
                class="bg-primary/10 text-primary mx-0.5 inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium"
                >@{{ p.label }}</span
              >
              <span v-if="p.type === 'text'" class="whitespace-pre-wrap">{{ p.body }}</span>
              <img
                v-else-if="p.type === 'image'"
                :src="`/api/attachments/${p.id}`"
                :alt="p.alt"
                class="border-default my-1.5 max-h-64 rounded-lg border"
              />
              <a
                v-else-if="p.type === 'file'"
                :href="`/api/attachments/${p.id}`"
                target="_blank"
                class="border-default bg-default text-toned hover:border-primary/50 hover:text-primary my-1 inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium"
                ><UIcon name="i-lucide-file-text" class="size-3.5 shrink-0" />{{ p.name }}</a
              >
            </template>
          </div>
        </div>
      </div>

      <!-- run: an agent turn — rendered like any chat message: avatar + bubble -->
      <div v-else-if="item.kind === 'run'" class="flex gap-2.5">
        <img
          v-if="item.authorId && hasAvatarByUserId.get(item.authorId)"
          :src="`/api/employees/${item.authorId}/avatar`"
          :alt="item.agentName ?? 'Agent'"
          class="mt-0.5 size-8 shrink-0 rounded-full object-cover"
        />
        <div
          v-else
          class="bg-elevated text-muted mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
        >
          {{ (item.authorName ?? item.agentName ?? 'Agent').slice(0, 2).toUpperCase() }}
        </div>
        <div class="min-w-0 flex-1">
          <p class="mb-1 flex items-center gap-1.5 text-[11px] leading-none">
            <span class="text-toned font-semibold">{{ item.agentName ?? 'Agent' }}</span>
            <span class="text-primary">(AI)</span>
            <!-- tiny neutral run label — NOT a second status pill (the header badge owns task status) -->
            <span class="text-dimmed inline-flex items-center gap-1 text-[10px] font-medium tracking-wide uppercase">
              <UIcon
                v-if="runStatusById.get(item.id) === 'running'"
                name="i-lucide-loader-circle"
                class="size-3 animate-spin"
              />
              {{ RUN_LABEL[runStatusById.get(item.id) ?? 'stopped']
              }}<span v-if="runStatusById.get(item.id) === 'failed' && item.exitCode" class="font-normal normal-case">
                (exit code {{ item.exitCode }})</span
              >
            </span>
            <span class="text-muted ml-auto">{{ formatWhenShort(item.startedAt) }}</span>
          </p>
          <!-- message: the settled result body; envelope parse only as a pre-settle fallback -->
          <div
            v-if="item.body || envelopeOf(item)"
            class="bg-elevated text-default inline-block max-w-[85%] rounded-xl rounded-tl-sm px-3.5 py-2 text-sm leading-relaxed"
          >
            {{ item.body || envelopeOf(item)?.text || '(empty)' }}
          </div>
          <!-- collected output files (agent deliverables) -->
          <div v-if="runOutputs(item).length" class="mt-1.5 flex flex-wrap gap-1.5">
            <template v-for="f in runOutputs(item)" :key="f.id">
              <img
                v-if="f.mime.startsWith('image/')"
                :src="`/api/attachments/${f.id}`"
                :alt="f.filename"
                class="border-default max-h-48 rounded-lg border"
              />
              <a
                v-else
                :href="`/api/attachments/${f.id}`"
                target="_blank"
                class="border-default bg-default text-toned hover:border-primary/50 hover:text-primary inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium"
                ><UIcon
                  :name="f.mime === 'application/pdf' ? 'i-lucide-file-text' : 'i-lucide-file'"
                  class="size-3.5 shrink-0"
                />{{ f.filename
                }}<span class="text-dimmed font-normal">{{ Math.max(1, Math.round(f.size / 1024)) }}KB</span></a
              >
            </template>
          </div>
          <!-- raw input: the exact brief, expandable below the message -->
          <details v-if="item.prompt" class="group mt-1">
            <summary
              class="text-muted hover:bg-elevated focus-visible:ring-primary inline-flex cursor-pointer list-none items-center gap-1 rounded-md px-1.5 py-1 text-xs select-none focus-visible:ring-2 focus-visible:outline-none"
            >
              <UIcon name="i-lucide-chevron-right" class="size-3.5 transition-transform group-open:rotate-90" />
              input
            </summary>
            <pre
              class="bg-elevated text-toned mt-1 rounded-md px-2.5 py-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap"
              >{{ item.prompt }}</pre>
          </details>
          <!-- raw output: FULL transcript, expandable below the message -->
          <details v-if="item.output" class="group mt-1">
            <summary
              class="text-muted hover:bg-elevated focus-visible:ring-primary inline-flex cursor-pointer list-none items-center gap-1 rounded-md px-1.5 py-1 text-xs select-none focus-visible:ring-2 focus-visible:outline-none"
            >
              <UIcon name="i-lucide-chevron-right" class="size-3.5 transition-transform group-open:rotate-90" />
              output
            </summary>
            <pre
              class="mt-1 rounded-md bg-zinc-950 px-2.5 py-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-zinc-200"
              >{{ item.output }}</pre>
          </details>
        </div>
      </div>

      <!-- note: slim system/human activity row -->
      <!-- human note: left bubble with initials avatar -->
      <div v-else-if="item.authorName" class="flex gap-2.5">
        <img
          v-if="item.authorId && hasAvatarByUserId.get(item.authorId)"
          :src="`/api/employees/${item.authorId}/avatar`"
          :alt="item.authorName"
          class="mt-0.5 size-8 shrink-0 rounded-full object-cover"
        />
        <div
          v-else
          class="bg-elevated text-muted mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
        >
          {{ item.authorName.slice(0, 2).toUpperCase() }}
        </div>
        <div class="min-w-0 flex-1">
          <p class="mb-1 flex items-center gap-1.5 text-[11px] leading-none">
            <span class="text-toned font-semibold">{{ item.authorName }}</span>
            <span class="text-muted">{{ formatWhenShort(item.createdAt) }}</span>
          </p>
          <div
            v-if="item.body"
            class="bg-elevated text-default inline-block max-w-[85%] rounded-xl rounded-tl-sm px-3.5 py-2 text-sm leading-relaxed"
          >
            {{ item.body }}
          </div>
        </div>
      </div>
      <!-- system note: centered pill -->
      <div v-else class="flex justify-center py-0.5">
        <span
          class="bg-elevated/60 text-muted inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px]"
        >
          <UIcon
            :name="
              item.noteKind === 'question'
                ? 'i-lucide-help-circle'
                : item.noteKind === 'answer'
                  ? 'i-lucide-check-check'
                  : item.noteKind === 'forward'
                    ? 'i-lucide-corner-up-right'
                    : item.noteKind === 'verdict'
                      ? 'i-lucide-gavel'
                      : 'i-lucide-info'
            "
            class="size-3 shrink-0"
          />
          <span class="truncate">{{ item.body || item.noteKind }}</span>
          <span class="text-muted shrink-0">· {{ formatWhenShort(item.createdAt) }}</span>
        </span>
      </div>
    </template>
  </div>
</template>
