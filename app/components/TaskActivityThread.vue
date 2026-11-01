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
import type { EmployeeRow, TaskRow, ThreadPage, ThreadRow } from '~/utils/orpc-types';
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

const { $orpc, $client } = useNuxtApp();

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
// ---- THREAD BOUNDING LAW (#175): the GET returns a bounded envelope — the newest
// up to 200 visible items + hasMore. Older history loads on demand page by page:
// each fetched page is strictly older than the oldest held row, so prepending
// keeps the union chronological; SSE refetches replace only the newest page and
// the id-dedupe absorbs the boundary overlap.
const newestPage = computed(() => (unref(threadQuery.data) ?? null) as ThreadPage | null);
const olderRows = ref<ThreadRow[]>([]);
const olderHasMore = ref<boolean | null>(null); // null: never paginated — the newest page decides
const threadRows = computed<ThreadRow[]>(() => {
  const newest = newestPage.value?.items ?? [];
  if (!olderRows.value.length) return newest;
  const seen = new Set<string>();
  const merged: ThreadRow[] = [];
  for (const r of [...olderRows.value, ...newest]) {
    if (!seen.has(r.id)) merged.push(r);
    seen.add(r.id);
  }
  return merged;
});
const hasMoreRows = computed(() => olderHasMore.value ?? newestPage.value?.hasMore ?? false);
const olderLoading = ref(false);
const olderFailed = ref(false);
/** one-shot previous page ($client imperative GET — same pattern as
 * ensureTranscript; $orpc stays queryOptions-only). The cursor is the OLDEST held
 * row's (createdAt,id). Prepends must not yank the reader's scroll position:
 * the viewport shifts by exactly the height the new rows added. */
async function loadOlderPage() {
  const oldest = threadRows.value[0];
  if (!oldest || olderLoading.value || !hasMoreRows.value) return;
  olderLoading.value = true;
  olderFailed.value = false;
  const el = scroller.value;
  const prevHeight = el?.scrollHeight ?? 0;
  try {
    const page = await $client.tasks.threadOlderPage({
      taskId: taskId.value,
      before: { createdAt: oldest.createdAt, id: oldest.id },
    });
    olderRows.value = [...page.items, ...olderRows.value];
    olderHasMore.value = page.hasMore;
    await nextTick();
    if (el) el.scrollTop += el.scrollHeight - prevHeight;
  } catch {
    olderFailed.value = true; // the pager button stays — it is the retry
  } finally {
    olderLoading.value = false;
  }
}
// the run's thread message carries the settled result body — attach it to the run feed
const runFeed = computed(() =>
  threadRows.value.flatMap((r) =>
    r.run ? [{ ...r.run, body: r.body, authorId: r.authorId, authorName: r.authorName }] : [],
  ),
);

// ---- RUN-TRANSCRIPT LAW (#130 slice 2): snapshots carry transcript text only
// for the LIVE run; settled transcripts + prompts fetch on demand via
// tasks.runTranscript the first time a fold opens (cached for the view)
type RunTranscript = { output: string; prompt: string | null };
const transcripts = ref(new Map<string, RunTranscript>());
const openOutputs = ref(new Set<string>());
const transcriptInFlight = new Set<string>();
async function ensureTranscript(runId: string) {
  if (transcripts.value.has(runId) || transcriptInFlight.has(runId)) return;
  transcriptInFlight.add(runId);
  try {
    // one-shot imperative GET — $orpc is the TanStack utils surface (queryOptions
    // only); raw procedure calls ride $client (same client useChangeEvents uses)
    const row = await $client.tasks.runTranscript({ runId });
    transcripts.value = new Map(transcripts.value).set(runId, { output: row.output, prompt: row.prompt });
  } catch {
    // unknown/gone run: leave uncached — the fold simply renders empty
  } finally {
    transcriptInFlight.delete(runId);
  }
}
/** output text for a run turn: the live stream, else the fetched transcript */
function transcriptOf(item: ThreadItem): string {
  if (item.kind !== 'run') return '';
  return item.output ?? transcripts.value.get(item.id)?.output ?? '';
}
/** prompt text for a run turn: always fetched on demand (never in snapshots) */
function promptOf(item: ThreadItem): string | null {
  if (item.kind !== 'run') return null;
  return item.prompt ?? transcripts.value.get(item.id)?.prompt ?? null;
}
function toggleOutput(item: ThreadItem, open: boolean) {
  if (item.kind !== 'run') return;
  if (open) {
    openOutputs.value = new Set(openOutputs.value).add(item.id);
    if (item.output == null && item.hasOutput) void ensureTranscript(item.id);
  } else {
    // cache stays — reopening must not re-download; only the open-set shrinks
    openOutputs.value = new Set([...openOutputs.value].filter((id) => id !== item.id));
  }
}
function togglePrompt(item: ThreadItem, open: boolean) {
  if (item.kind !== 'run') return;
  if (open) void ensureTranscript(item.id);
}
// a run settled while its output fold was open: the snapshot dropped the live
// output — pull the settled transcript so the open fold doesn't go blank
// (watches runFeed — declared above; `thread` is a TDZ hazard from here)
watch(runFeed, (rows) => {
  for (const r of rows) {
    if (r.output != null || !r.hasOutput) continue;
    if (openOutputs.value.has(r.id)) void ensureTranscript(r.id);
  }
});
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
      output: r.output ?? null,
      hasOutput: r.hasOutput ?? false,
      hasPrompt: r.hasPrompt ?? false,
      prompt: r.prompt ?? null,
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
      <!-- THREAD BOUNDING LAW: older history loads on demand — the pager sits at
           the top of the timeline and prepends without moving the viewport -->
      <div v-if="hasMoreRows" class="flex justify-center pb-1">
        <UButton
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-chevron-up"
          label="Load earlier messages"
          :loading="olderLoading"
          class="min-h-11"
          data-testid="thread-older"
          @click="loadOlderPage"
        />
      </div>
      <p v-if="olderFailed" role="alert" class="text-error text-center text-xs">
        Couldn't load earlier messages — try again.
      </p>
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
            <!-- raw input: the exact brief — RUN-TRANSCRIPT LAW: prompts never ride
                 snapshots; the fold fetches the transcript on first open -->
            <details
              v-if="item.hasPrompt"
              class="group mt-1"
              @toggle="togglePrompt(item, ($event.target as HTMLDetailsElement).open)"
            >
              <summary
                class="text-muted hover:bg-elevated focus-visible:ring-primary inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-md px-1.5 py-1 text-xs select-none focus-visible:ring-2 focus-visible:outline-none"
              >
                <UIcon name="i-lucide-chevron-right" class="size-3.5 transition-transform group-open:rotate-90" />
                Input sent to {{ item.agentName ?? 'the agent' }}
              </summary>
              <pre
                class="bg-elevated text-toned mt-1 rounded-md px-2.5 py-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap"
                >{{ promptOf(item) }}</pre>
            </details>
            <!-- raw output: FULL transcript, expandable below the message — the live
                 run streams inline (snapshot carries RUNNING output); settled runs
                 fetch the transcript on first open (RUN-TRANSCRIPT LAW) -->
            <details
              v-if="item.output || item.hasOutput"
              class="group mt-1"
              @toggle="toggleOutput(item, ($event.target as HTMLDetailsElement).open)"
            >
              <summary
                class="text-muted hover:bg-elevated focus-visible:ring-primary inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded-md px-1.5 py-1 text-xs select-none focus-visible:ring-2 focus-visible:outline-none"
              >
                <UIcon name="i-lucide-chevron-right" class="size-3.5 transition-transform group-open:rotate-90" />
                Full output from {{ item.agentName ?? 'the agent' }}
              </summary>
              <pre
                class="bg-elevated text-toned mt-1 rounded-md px-2.5 py-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap"
                >{{ transcriptOf(item) }}</pre>
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
