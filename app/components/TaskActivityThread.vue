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
import type { EmployeeRow, TaskRow } from '~/utils/orpc-types';
import { buildThread, formatThreadTime, parseRunEnvelope } from '~/utils/task-thread';
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
const runFeed = computed(() => threadRows.value.flatMap((r) => (r.run ? [r.run] : [])));
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
      agentName: r.agentName,
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
<!-- the thread -->
<div
  ref="scroller"
  class="min-h-0 flex-1 space-y-4 overflow-y-auto rounded-xl border border-zinc-200/70 bg-white/50 p-3.5 lg:max-h-none dark:border-zinc-800 dark:bg-zinc-900/40"
>
  <p v-if="!thread.length" class="py-10 text-center text-xs text-zinc-400">No activity yet.</p>

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
        class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-[11px] font-semibold text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300"
      >
        {{ briefAuthor ? briefAuthor.slice(0, 2).toUpperCase() : 'T' }}
      </div>
      <div class="min-w-0 flex-1">
        <p class="mb-1 text-[11px] font-medium text-zinc-400">
          {{ briefAuthor ?? 'Task brief' }}
          <span v-if="item.createdAt" class="font-normal text-zinc-300 dark:text-zinc-500"
            >· {{ formatThreadTime(item.createdAt) }}</span
          >
        </p>
        <!-- description: mention tokens -> @Name; attachment tokens -> inline images / file chips -->
        <div
          class="rounded-xl rounded-tl-sm border border-zinc-200/70 bg-zinc-50 px-3.5 py-2.5 text-sm leading-relaxed text-zinc-800 dark:border-zinc-700/60 dark:bg-zinc-800/60 dark:text-zinc-200"
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
              class="my-1.5 max-h-64 rounded-lg border border-zinc-200 dark:border-zinc-700"
            />
            <a
              v-else-if="p.type === 'file'"
              :href="`/api/attachments/${p.id}`"
              target="_blank"
              class="hover:border-primary/50 hover:text-primary my-1 inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
              ><UIcon name="i-lucide-file-text" class="size-3.5 shrink-0" />{{ p.name }}</a
            >
          </template>
        </div>
      </div>
    </div>

    <!-- run: an agent turn — one message from the agent, avatar + name + bubble -->
    <div v-else-if="item.kind === 'run'" class="flex gap-2.5">
      <div
        class="bg-primary/10 text-primary mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
      >
        {{ (item.agentName ?? 'Agent').slice(0, 2).toUpperCase() }}
      </div>
      <div class="min-w-0 flex-1">
        <p class="mb-1 flex items-center gap-1.5 text-[11px] leading-none">
          <span class="font-semibold text-zinc-600 dark:text-zinc-300">{{
            item.agentName ?? 'Agent'
          }}</span>
          <span class="text-primary">(AI)</span>
          <span
            v-if="item.status === 'running'"
            class="bg-warning/15 text-warning inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-semibold"
            ><UIcon name="i-lucide-loader-circle" class="size-3 animate-spin" />working</span
          >
          <span
            v-else-if="item.status === 'done'"
            class="rounded-full bg-zinc-100 px-1.5 py-0.5 font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
            >completed</span
          >
          <span
            v-else
            class="bg-error/10 text-error inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-semibold"
            >failed<span v-if="item.exitCode !== null" class="font-normal opacity-80">
              exit {{ item.exitCode }}</span
            ></span
          >
          <span class="ml-auto text-zinc-300 dark:text-zinc-600">{{
            formatThreadTime(item.startedAt)
          }}</span>
        </p>
        <!-- envelope: the decision-model line, integrated not alarmist (max-w for rhythm) -->
        <div
          v-if="envelopeOf(item)"
          :class="[
            'max-w-[calc(100%-3rem)] rounded-xl rounded-tl-sm border-l-2 px-3.5 py-2.5 text-sm leading-relaxed',
            envelopeOf(item)!.kind === 'question'
              ? 'border-l-blue-400/70 bg-blue-50/40 text-zinc-800 dark:bg-blue-500/10 dark:text-zinc-200'
              : envelopeOf(item)!.kind === 'blocked'
                ? 'border-l-error/70 bg-error/5 dark:bg-error/5 text-zinc-800 dark:text-zinc-200'
                : 'border-l-emerald-400/70 bg-emerald-50/40 text-zinc-800 dark:bg-emerald-500/10 dark:text-zinc-200',
          ]"
        >
          <span
            :class="[
              'mr-1.5 align-middle text-[9px] font-bold tracking-widest uppercase',
              envelopeOf(item)!.kind === 'question'
                ? 'text-blue-500'
                : envelopeOf(item)!.kind === 'blocked'
                  ? 'text-error'
                  : 'text-emerald-600 dark:text-emerald-400',
            ]"
            >{{ envelopeOf(item)!.kind }}</span
          ><span class="align-middle">{{ envelopeOf(item)!.text || '(empty)' }}</span>
        </div>
        <!-- collected output files (agent deliverables) -->
        <div v-if="runOutputs(item).length" class="mt-1.5 flex flex-wrap gap-1.5">
          <template v-for="f in runOutputs(item)" :key="f.id">
            <img
              v-if="f.mime.startsWith('image/')"
              :src="`/api/attachments/${f.id}`"
              :alt="f.filename"
              class="max-h-48 rounded-lg border border-zinc-200 dark:border-zinc-700"
            />
            <a
              v-else
              :href="`/api/attachments/${f.id}`"
              target="_blank"
              class="hover:border-primary/50 hover:text-primary inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
              ><UIcon
                :name="f.mime === 'application/pdf' ? 'i-lucide-file-text' : 'i-lucide-file'"
                class="size-3.5 shrink-0"
              />{{ f.filename
              }}<span class="font-normal text-zinc-400"
                >{{ Math.max(1, Math.round(f.size / 1024)) }}KB</span
              ></a
            >
          </template>
        </div>
        <!-- raw output: FULL transcript, never trimmed, never folded -->
        <pre
          v-if="item.output"
          class="mt-1 rounded-md bg-zinc-950 px-2.5 py-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-zinc-200"
          >{{ item.output }}</pre>
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
        class="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-[11px] font-semibold text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
      >
        {{ item.authorName.slice(0, 2).toUpperCase() }}
      </div>
      <div class="min-w-0 flex-1">
        <p class="mb-1 flex items-center gap-1.5 text-[11px] leading-none">
          <span class="font-semibold text-zinc-600 dark:text-zinc-300">{{ item.authorName }}</span>
          <span class="text-zinc-300 dark:text-zinc-600">{{ formatThreadTime(item.createdAt) }}</span>
        </p>
        <div
          v-if="item.body"
          class="inline-block max-w-full rounded-xl rounded-tl-sm bg-zinc-100 px-3.5 py-2 text-sm leading-relaxed text-zinc-800 dark:bg-zinc-800/70 dark:text-zinc-200"
        >
          {{ item.body }}
        </div>
      </div>
    </div>
    <!-- system note: centered pill -->
    <div v-else class="flex justify-center py-0.5">
      <span
        class="inline-flex max-w-full items-center gap-1.5 rounded-full bg-zinc-100/80 px-2.5 py-1 text-[11px] text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400"
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
        <span class="shrink-0 text-zinc-300 dark:text-zinc-600"
          >· {{ formatThreadTime(item.createdAt) }}</span
        >
      </span>
    </div>
  </template>
</div>
</template>
