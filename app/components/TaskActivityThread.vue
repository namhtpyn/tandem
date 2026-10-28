<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
// The task-detail chat thread: the brief (description bubble), agent run turns
// and activity notes merged into one ordered timeline. Self-loads runs +
// activity + employees (same query keys the app-wide changes subscription
// invalidates; SSE law: first load is a conventional GET) and autoscrolls to
// the newest item. Props: the resolved `task` row.
import { computed, nextTick, onMounted, onServerPrefetch, ref, watch } from 'vue';

import { ACTIVITY_KIND, CHANGE_RESOURCE } from '#shared/enums';
import { nonNull } from '#shared/utils/non-null';
import { attachmentUrl, employeeAvatarUrl } from '~/utils/api-urls';
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
      queryKey: [CHANGE_RESOURCE.TASK_ACTIVITY, taskId.value, 'thread'],
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
/** userId -> hasAvatar: chat avatars render via employeeAvatarUrl(), initials otherwise */
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

// system pills fall back to the note kind when there's no body — never leak the
// raw enum (the API stores SCREAMING kinds; older rows may hold lowercase)
const NOTE_KIND_LABELS: Record<string, string> = {
  [ACTIVITY_KIND.NOTE]: 'Note',
  [ACTIVITY_KIND.QUESTION]: 'Question',
  [ACTIVITY_KIND.ANSWER]: 'Answer',
  [ACTIVITY_KIND.VERDICT]: 'Review verdict',
  [ACTIVITY_KIND.FORWARD]: 'Forwarded',
  [ACTIVITY_KIND.STATUS]: 'Status',
};
function noteKindLabel(kind: string) {
  return NOTE_KIND_LABELS[kind] ?? NOTE_KIND_LABELS[kind.toUpperCase()] ?? humanizeEnum(kind);
}
function noteKindIcon(kind: string) {
  const k = kind.toLowerCase();
  if (k === 'question') return 'i-lucide-help-circle';
  if (k === 'answer') return 'i-lucide-check-check';
  if (k === 'forward') return 'i-lucide-corner-up-right';
  if (k === 'verdict') return 'i-lucide-gavel';
  return 'i-lucide-info';
}

// ---- one ordered timeline from runs + activity + description -----------------
const thread = computed<ThreadItem[]>(() =>
  buildThread({
    description: props.task.description ?? null,
    createdAt: props.task.createdAt ?? null,
    briefAuthorName: props.task.creatorName ?? null,
    briefAuthorId: props.task.createdBy ?? null,
    // pass the REAL settled status + finish time through — the display reads
    // runStatusById, but the item data should not lie about the run
    runs: runFeed.value.map((r) => ({
      id: r.id,
      status: mapRunStatus(r.status),
      output: r.output,
      prompt: r.prompt,
      body: r.body,
      agentName: r.agentName,
      authorId: r.authorId ?? null,
      authorName: r.authorName ?? null,
      exitCode: r.exitCode,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt ?? null,
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

// pending/error as script computeds — query flags must be read with an explicit
// .value (a bare template read is the ref object itself, always truthy)
const threadLoading = computed(() => threadQuery.isPending.value);
const threadFailed = computed(() => threadQuery.isError.value);

const outputsByRun = computed(() => {
  const m = new Map<string, Array<{ id: string; filename: string; mime: string; size: number }>>();
  for (const r of runFeed.value) if (r.outputs?.length) m.set(r.id, r.outputs);
  return m;
});
// anchor to the newest item on first arrival, then FOLLOW the reader: only keep
// autoscrolling while they're already near the bottom — scrolled-up history
// must not yank them back down on every new item
let anchored = false;
watch(
  () => thread.value.length,
  async () => {
    await nextTick();
    const el = scroller.value;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (!anchored || nearBottom) el.scrollTo({ top: el.scrollHeight });
    anchored = true;
  },
);
// SSR path: the thread hydrates FULL (suspense), so the length-watch never
// fires — anchor to the bottom once on mount instead
onMounted(async () => {
  await nextTick();
  const el = scroller.value;
  if (!el || !thread.value.length) return;
  el.scrollTo({ top: el.scrollHeight });
  anchored = true;
});

function runOutputs(item: ThreadItem) {
  return item.kind === 'run' ? (outputsByRun.value.get(item.id) ?? []) : [];
}

/** server ids are uuid/slug tokens — anything else must never reach href/src */
const ATTACHMENT_ID_RE = /^[A-Za-z0-9_-]+$/;

/** split the brief description into text + attachment refs for rendering */
const briefParts = computed(() => {
  const desc = props.task.description ?? '';
  const parts: Array<
    | { type: 'text'; body: string }
    | { type: 'mention'; label: string }
    | { type: 'image'; id: string; alt: string }
    | { type: 'file'; id: string; name: string }
  > = [];
  // split attachments first, then employee mentions inside the text parts.
  // Captured ids end up in href/src — anything outside the server's id alphabet
  // renders as its literal source text instead of building a URL from it.
  const re = /!\[([^\]]*)\]\(attachment-([^)]+)\)|@\[([^\]]*)\]\(attachment-([^)]+)\)/g;
  let last = 0;
  for (const m of desc.matchAll(re)) {
    if (nonNull(m.index) > last) pushText(desc.slice(last, m.index));
    const id = nonNull(m[2] ?? m[4]);
    if (ATTACHMENT_ID_RE.test(id)) {
      if (m[2] !== undefined) parts.push({ type: 'image', id, alt: nonNull(m[1]) });
      else parts.push({ type: 'file', id, name: nonNull(m[3]) });
    } else {
      parts.push({ type: 'text', body: m[0] });
    }
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
  <!-- the thread: content only — the page owns the single card border.
       Bottom-anchored: short conversations hug the composer (mt-auto), and the
       empty state sits centered in the scroller. -->
  <div ref="scroller" class="flex max-h-[min(60dvh,42rem)] min-h-0 flex-1 flex-col overflow-y-auto p-3.5 lg:max-h-none">
    <!-- pending: chat-bubble skeletons keep the bottom-anchored layout honest -->
    <div v-if="threadLoading" class="my-auto space-y-4" aria-hidden="true">
      <div class="flex gap-2.5">
        <USkeleton class="size-8 shrink-0 rounded-full" />
        <USkeleton class="h-12 w-2/3 rounded-xl" />
      </div>
      <div class="flex gap-2.5">
        <USkeleton class="size-8 shrink-0 rounded-full" />
        <USkeleton class="h-16 w-1/2 rounded-xl" />
      </div>
    </div>
    <p v-else-if="threadFailed" role="alert" class="text-error my-auto py-10 text-center text-xs">
      Couldn't load the activity thread
    </p>
    <p v-else-if="!thread.length" class="text-dimmed my-auto py-10 text-center text-xs">
      No activity yet — write a note below or dispatch the agent.
    </p>
    <div v-else :class="thread.length < 3 ? 'my-auto space-y-4' : 'mt-auto space-y-4'">
      <template v-for="item in thread" :key="item.id">
        <!-- brief: the task description as the opening message -->
        <div v-if="item.kind === 'brief'" class="flex gap-2.5">
          <img
            v-if="item.authorId && hasAvatarByUserId.get(item.authorId)"
            :src="employeeAvatarUrl(item.authorId)"
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
              <span v-if="item.createdAt" class="text-muted font-normal" data-allow-mismatch>{{
                formatWhenShort(item.createdAt)
              }}</span>
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
                  :src="attachmentUrl(p.id)"
                  :alt="p.alt"
                  class="border-default my-1.5 max-h-64 rounded-lg border"
                />
                <a
                  v-else-if="p.type === 'file'"
                  :href="attachmentUrl(p.id)"
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
            :src="employeeAvatarUrl(item.authorId)"
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
              <!-- meta cluster: the tiny neutral run label rides NEXT TO the time,
                 never orphaned mid-row on a narrow phone -->
              <span class="text-muted ml-auto inline-flex shrink-0 items-center gap-1.5">
                <span class="text-dimmed inline-flex items-center gap-1 text-xs">
                  <UIcon
                    v-if="runStatusById.get(item.id) === 'running'"
                    name="i-lucide-loader-circle"
                    class="size-3 motion-safe:animate-spin"
                  />
                  {{ RUN_LABEL[runStatusById.get(item.id) ?? 'stopped']
                  }}<span
                    v-if="runStatusById.get(item.id) === 'failed' && item.exitCode"
                    class="font-normal normal-case"
                  >
                    (exit code {{ item.exitCode }})</span
                  >
                </span>
                <span data-allow-mismatch>{{ formatWhenShort(item.startedAt) }}</span>
              </span>
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
                  :src="attachmentUrl(f.id)"
                  :alt="f.filename"
                  class="border-default max-h-48 rounded-lg border"
                />
                <a
                  v-else
                  :href="attachmentUrl(f.id)"
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
                class="text-muted hover:bg-elevated focus-visible:ring-primary inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-md px-1.5 py-1 text-xs select-none focus-visible:ring-2 focus-visible:outline-none"
              >
                <UIcon name="i-lucide-chevron-right" class="size-3.5 transition-transform group-open:rotate-90" />
                Input
              </summary>
              <pre
                class="bg-elevated text-toned mt-1 rounded-md px-2.5 py-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap"
                >{{ item.prompt }}</pre>
            </details>
            <!-- raw output: FULL transcript, expandable below the message -->
            <details v-if="item.output" class="group mt-1">
              <summary
                class="text-muted hover:bg-elevated focus-visible:ring-primary inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-md px-1.5 py-1 text-xs select-none focus-visible:ring-2 focus-visible:outline-none"
              >
                <UIcon name="i-lucide-chevron-right" class="size-3.5 transition-transform group-open:rotate-90" />
                Output
              </summary>
              <pre
                class="bg-inverted text-inverted mt-1 rounded-md px-2.5 py-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap"
                >{{ item.output }}</pre>
            </details>
          </div>
        </div>

        <!-- note: slim system/human activity row -->
        <!-- human note: left bubble with initials avatar -->
        <div v-else-if="item.authorName" class="flex gap-2.5">
          <img
            v-if="item.authorId && hasAvatarByUserId.get(item.authorId)"
            :src="employeeAvatarUrl(item.authorId)"
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
              <span class="text-muted" data-allow-mismatch>{{ formatWhenShort(item.createdAt) }}</span>
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
            class="bg-elevated/60 text-muted inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px]"
          >
            <UIcon :name="noteKindIcon(item.noteKind)" class="size-3 shrink-0" />
            <span class="truncate">{{ item.body || noteKindLabel(item.noteKind) }}</span>
            <span class="text-muted shrink-0" data-allow-mismatch>{{ formatWhenShort(item.createdAt) }}</span>
          </span>
        </div>
      </template>
    </div>
  </div>
</template>
