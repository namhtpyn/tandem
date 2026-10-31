<script setup lang="ts">
import { useQuery } from '@tanstack/vue-query';
// The task-detail chat thread: the brief (description bubble), agent run turns
// and activity notes merged into one ordered timeline. Self-loads runs +
// activity + employees (same query keys the app-wide changes subscription
// invalidates; SSE law: first load is a conventional GET) and autoscrolls to
// the newest item. Props: the resolved `task` row.
import { computed, nextTick, onMounted, onServerPrefetch, ref, watch } from 'vue';

import { CHANGE_RESOURCE } from '#shared/enums';
import { FLAG_TASKS_TURN_DURATIONS } from '#shared/flags';
import { nonNull } from '#shared/utils/non-null';
import { attachmentUrl, employeeAvatarUrl } from '~/utils/api-urls';
import { formatWhenShort, turnDurationLabel } from '~/utils/format-when';
import type { EmployeeRow, TaskRow, ThreadRow } from '~/utils/orpc-types';
import { activityNotes, buildThread, parseRunEnvelope } from '~/utils/task-thread';
import type { ThreadItem } from '~/utils/task-thread';
import { parseTaskText } from '~/utils/task-tokens';
import {
  activityIcon,
  activityLabel,
  aiOptionLabel,
  runStatus,
  AGENT_RUN_VIEW,
  type AgentRunStatus,
} from '~/utils/ui-labels';

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
const threadRows = computed(() => (unref(threadQuery.data) ?? []) as ThreadRow[]);
// the run's thread message carries the settled result body — attach it to the run feed
const runFeed = computed(() =>
  threadRows.value.flatMap((r) =>
    r.run ? [{ ...r.run, body: r.body, authorId: r.authorId, authorName: r.authorName }] : [],
  ),
);
const workflowFeed = computed(() => activityNotes(threadRows.value));
const employeesLive = useQuery($orpc.employees.list.queryOptions({ queryKey: [CHANGE_RESOURCE.EMPLOYEES] }));
const employees = computed(() => (unref(employeesLive.data) ?? []) as EmployeeRow[]);
/** userId -> hasAvatar: chat avatars render via employeeAvatarUrl(), initials otherwise */
const hasAvatarByUserId = computed(() => new Map(employees.value.map((e) => [e.userId, e.hasAvatar])));

// the task creator opens the thread as the brief's author
const briefAuthor = computed(() => props.task.creatorName ?? null);

// run status reads as a word, not a pill: the task status badge owns color — a
// run turn's outcome stays a tiny neutral label so the two never look alike.
// Normalization + labels come from the SHARED ui-labels vocabulary.
const runStatusById = computed(() => {
  const m = new Map<string, AgentRunStatus>();
  for (const r of runFeed.value) m.set(r.id, runStatus(r.status));
  return m;
});

// system pills fall back to the note kind when there's no body — never leak the
// raw enum (the API stores SCREAMING kinds; older rows may hold lowercase)

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
      status: runStatus(r.status),
      output: r.output,
      prompt: r.prompt,
      body: r.body,
      agentName: r.agentName,
      authorId: r.authorId ?? null,
      authorName: r.authorName ?? null,
      exitCode: r.exitCode,
      attempts: r.attempts ?? 1,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt ?? null,
    })),
    activity: workflowFeed.value,
  }),
);

// flagged surface (SPEC: Settings > Feature flags): settled run turns render
// their wall-clock duration ONLY when the flag is explicitly on — off state
// renders exactly the pre-flag header (off-state default)
const settingsLive = useQuery($orpc.settings.list.queryOptions({ queryKey: [CHANGE_RESOURCE.SETTINGS] }));
const turnDurationsOn = computed(() => unref(settingsLive.data)?.flags?.[FLAG_TASKS_TURN_DURATIONS] ?? false);
const durationLabels = computed(() => {
  const m = new Map<string, string>();
  if (!turnDurationsOn.value) return m;
  for (const item of thread.value) {
    if (item.kind !== 'run') continue;
    const label = turnDurationLabel(item.startedAt, item.finishedAt);
    if (label) m.set(item.id, label);
  }
  return m;
});

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

/** human byte size with a space and an MB rollover — '1 KB', '1.4 MB' */
function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** run result bodies: one parse per run turn — settled body -> renderable parts +
 * the attachment ids the body already carries (the gallery must not duplicate them).
 * envelope parse stays the pre-settle fallback (see envelopeById). */
const runBodyById = computed(() => {
  const m = new Map<string, { parts: ReturnType<typeof parseTaskText>; inlined: Set<string> }>();
  for (const item of thread.value) {
    if (item.kind !== 'run') continue;
    const body = item.body || envelopeOf(item)?.text || '';
    const parts = parseTaskText(body);
    const inlined = new Set(parts.flatMap((p) => (p.type === 'image' || p.type === 'file' ? [p.id] : [])));
    m.set(item.id, { parts, inlined });
  }
  return m;
});

function runOutputs(item: ThreadItem) {
  if (item.kind !== 'run') return [];
  const all = outputsByRun.value.get(item.id) ?? [];
  // RESULT-MESSAGE ATTACHMENTS: images the body already inlines leave the gallery
  const inlined = runBodyById.value.get(item.id)?.inlined;
  return inlined && inlined.size ? all.filter((f) => !inlined.has(f.id)) : all;
}

/** split the brief description into text + attachment + mention parts — the
 *  token grammar is shared with the editor that writes it (utils/task-tokens) */
const briefParts = computed(() => parseTaskText(props.task.description ?? ''));

/** one parse per run turn: the template used to call parseRunEnvelope() twice
 *  per item (body fallback + text fallback) on every render */
const envelopeById = computed(() => {
  const m = new Map<string, ReturnType<typeof parseRunEnvelope>>();
  for (const item of thread.value) if (item.kind === 'run') m.set(item.id, parseRunEnvelope(item.output));
  return m;
});

function envelopeOf(item: ThreadItem) {
  return item.kind === 'run' ? (envelopeById.value.get(item.id) ?? null) : null;
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
    <div v-else-if="threadFailed" role="alert" class="my-auto py-10 text-center">
      <p class="text-error text-xs">Couldn't load the activity thread — the connection dropped.</p>
      <UButton
        class="mt-2"
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-lucide-refresh-cw"
        label="Retry"
        @click="threadQuery.refetch()"
      />
    </div>
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
              <TaskTextParts :parts="briefParts" />
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
              <span class="text-toned font-semibold">{{ aiOptionLabel(item.agentName ?? 'Agent', 'ai') }}</span>
              <!-- meta cluster: the tiny neutral run label rides NEXT TO the time,
                 never orphaned mid-row on a narrow phone -->
              <span class="text-muted ml-auto inline-flex shrink-0 items-center gap-1.5">
                <span class="text-dimmed inline-flex items-center gap-1 text-xs">
                  <UIcon
                    v-if="runStatusById.get(item.id) === 'running'"
                    name="i-lucide-loader-circle"
                    class="size-3 motion-safe:animate-spin"
                  />
                  {{ AGENT_RUN_VIEW[runStatusById.get(item.id) ?? 'stopped'].label
                  }}<span v-if="(item.attempts ?? 1) > 1" class="font-normal normal-case">
                    (attempt {{ item.attempts }})</span
                  ><span
                    v-if="runStatusById.get(item.id) === 'failed' && item.exitCode"
                    class="font-normal normal-case"
                  >
                    (exit code {{ item.exitCode }})</span
                  >
                </span>
                <span data-allow-mismatch>{{ formatWhenShort(item.startedAt) }}</span
                ><span
                  v-if="durationLabels.get(item.id)"
                  class="text-dimmed normal-case tabular-nums"
                  data-testid="run-duration"
                  >· {{ durationLabels.get(item.id) }}</span
                >
              </span>
            </p>
            <!-- message: the settled result body; envelope parse only as a pre-settle fallback.
                 Body tokens render like the brief (RESULT-MESSAGE ATTACHMENTS): the collected
                 screenshots ride the message itself, not only the gallery below. -->
            <div
              v-if="item.body || envelopeOf(item)"
              class="bg-elevated text-default inline-block max-w-[85%] rounded-xl rounded-tl-sm px-3.5 py-2 text-sm leading-relaxed"
            >
              <TaskTextParts :parts="runBodyById.get(item.id)?.parts ?? []" />
              <span v-if="!runBodyById.get(item.id)?.parts.length">No output</span>
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
                  />{{ f.filename }}<span class="text-dimmed font-normal">{{ fileSize(f.size) }}</span></a
                >
              </template>
            </div>
            <!-- raw input: the exact brief, expandable below the message -->
            <details v-if="item.prompt" class="group mt-1">
              <summary
                class="text-muted hover:bg-elevated focus-visible:ring-primary inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-md px-1.5 py-1 text-xs select-none focus-visible:ring-2 focus-visible:outline-none"
              >
                <UIcon name="i-lucide-chevron-right" class="size-3.5 transition-transform group-open:rotate-90" />
                Input sent to {{ item.agentName ?? 'the agent' }}
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
                Full output from {{ item.agentName ?? 'the agent' }}
              </summary>
              <pre
                class="bg-elevated text-toned mt-1 rounded-md px-2.5 py-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap"
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
            <UIcon :name="activityIcon(item.noteKind)" class="size-3 shrink-0" />
            <span class="truncate">{{ item.body || activityLabel(item.noteKind) }}</span>
            <span class="text-muted shrink-0" data-allow-mismatch>{{ formatWhenShort(item.createdAt) }}</span>
          </span>
        </div>
      </template>
    </div>
  </div>
</template>
