// Shared workflow verbs for a task: the dispatch/note/submit/ask/forward/answer/
// verdict/abandon ladder, its copy, and the cache feeds every verb invalidates.
// The task page and the privacy drawer drive the SAME ladder — duplicating the
// switch in two components let the two surfaces drift (one cleared the note, the
// other kept it; one refreshed runs, the other didn't).
import { useQueryClient } from '@tanstack/vue-query';
import { ref } from 'vue';

import { CATEGORY, CHANGE_RESOURCE, type Category } from '#shared/enums';
import { nonNull } from '#shared/utils/non-null';
import { errorMessage } from '~/utils/forms';

export type WorkflowAction =
  | 'dispatch'
  | 'note'
  | 'submit'
  | 'ask'
  | 'forward'
  | 'answer'
  | 'approve'
  | 'requestChanges'
  | 'reject'
  | 'abandon';

export type WorkflowExtra = { body?: string; toEmployeeId?: string };

/** what the note verb reports back: steered a live run, dispatched, or thread-only */
export type NoteOutcome = { steered: boolean; dispatched?: true };

const VERDICT_ACTIONS: ReadonlySet<WorkflowAction> = new Set(['approve', 'requestChanges', 'reject']);

/** success copy per note outcome — the server decides, the UI never guesses */
export function noteSuccessCopy(outcome: NoteOutcome): string {
  if (outcome.steered) return 'Note sent — the running agent has it';
  if (outcome.dispatched) return 'Note sent — agent dispatched';
  return WF_COPY.note.ok;
}

/**
 * Composer hint that matches the note verb's server rules: only a READY task
 * with an AI assignee dispatches; a live run steers; everything else is a
 * thread-only note (done/cancelled/in-review and human assignees never dispatch).
 */
export function composerHint(input: {
  category: Category | null | undefined;
  assigneeKind: string | null | undefined;
  running: boolean;
}): string {
  if (input.running) return 'Sends a steering note to the running agent';
  if (input.category === CATEGORY.READY && input.assigneeKind === 'ai')
    return 'Sends the note and dispatches the agent';
  return 'Adds the note to the thread';
}

// every verb names what just happened (and what to retry) — no bare 'done'/'action failed'
export const WF_COPY: Record<WorkflowAction, { ok: string; fail: string }> = {
  dispatch: { ok: 'Agent dispatched', fail: "Couldn't dispatch — try again" },
  note: { ok: 'Note added', fail: "Couldn't add the note — try again" },
  submit: { ok: 'Sent for review', fail: "Couldn't submit for review — try again" },
  ask: { ok: 'Question sent', fail: "Couldn't send the question — try again" },
  forward: { ok: 'Forwarded', fail: "Couldn't forward — try again" },
  answer: { ok: 'Answer sent', fail: "Couldn't send the answer — try again" },
  approve: { ok: 'Approved', fail: "Couldn't approve — try again" },
  requestChanges: { ok: 'Changes requested', fail: "Couldn't request changes — try again" },
  reject: { ok: 'Rejected', fail: "Couldn't reject — try again" },
  abandon: { ok: 'Task cancelled', fail: "Couldn't cancel the task — try again" },
};

/**
 * @param taskId resolves the CURRENT task id on every call (the page navigates
 *   between tasks without remounting, and passing a captured id is how a note
 *   typed for task A landed on task B).
 */
export function useWorkflowActions(taskId: () => string | null | undefined) {
  const { $client } = useNuxtApp();
  const queryClient = useQueryClient();

  const workflowNote = ref('');
  const workflowBusy = ref(false);
  const workflowMessage = ref('');
  const workflowOk = ref(true); // message tone: success copy vs failure copy
  // the review box disarms its reject confirm + keeps the note on a failed verdict
  const workflowFailed = ref(false);
  // verdict-specific settlement signal (bumped once per approve/requestChanges/
  // reject, success or failure) — the review box clears on THIS, never on the
  // shared busy flag (a composer send or an upload finishing must not wipe a
  // half-written review note)
  const verdictSeq = ref(0);
  const verdictFailed = ref(false);

  /** returns true when the verb landed (callers gate on it before closing a drawer) */
  async function wfAction(action: WorkflowAction, extra: WorkflowExtra = {}): Promise<boolean> {
    // capture the id BEFORE the await: the page can navigate mid-flight and
    // task.value would then point at a different task (or null)
    const id = taskId();
    if (!id || workflowBusy.value) return false;
    workflowBusy.value = true;
    workflowMessage.value = '';
    workflowFailed.value = false;
    let ok = false;
    try {
      const input = { taskId: id, ...extra };
      const result = await {
        dispatch: () => $client.tasks.dispatch({ taskId: input.taskId }),
        note: () => $client.tasks.note({ ...input, body: nonNull(input.body) }),
        // body is optional server-side (submitResult defaults it) — an empty note is fine
        submit: () => $client.tasks.submit({ ...input, body: input.body || undefined }),
        ask: () => $client.tasks.ask({ ...input, body: nonNull(input.body) }),
        forward: () => $client.tasks.forward({ ...input, toEmployeeId: nonNull(input.toEmployeeId) }),
        answer: () => $client.tasks.answer({ ...input, body: nonNull(input.body) }),
        approve: () => $client.tasks.approve(input),
        requestChanges: () => $client.tasks.requestChanges({ ...input, body: nonNull(input.body) }),
        reject: () => $client.tasks.reject(input),
        abandon: () => $client.tasks.abandon(input),
      }[action]();
      // only clear the text this call actually sent — a bodyless verb carries no
      // note, and a note typed while the request was in flight must survive
      if (extra.body !== undefined && workflowNote.value === extra.body) workflowNote.value = '';
      // invalidate ALL dependent feeds: TASKS re-syncs the row (status/reviewers),
      // TASK_ACTIVITY keeps the thread, review checklist and activity feed current
      // (the reviews cache sits under the TASK_ACTIVITY prefix), RUNS refreshes the
      // run cards a dispatch/verdict just changed.
      void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASKS] });
      void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASK_ACTIVITY, id] });
      void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.RUNS, id] });
      // the note verb reports whether the send steered a live run or dispatched —
      // the success copy must say what actually happened, never guess
      workflowMessage.value = action === 'note' ? noteSuccessCopy(result as NoteOutcome) : WF_COPY[action].ok;
      workflowOk.value = true;
      ok = true;
      return true;
    } catch (e) {
      // surface the server's oRPC message, not ofetch's generic '[POST] …: 400'
      workflowMessage.value = errorMessage(e, WF_COPY[action].fail);
      workflowOk.value = false;
      workflowFailed.value = true;
      return false;
    } finally {
      workflowBusy.value = false;
      if (VERDICT_ACTIONS.has(action)) {
        verdictFailed.value = !ok;
        verdictSeq.value += 1;
      }
    }
  }

  /** the composer's send IS the answer verb while the task waits for an answer */
  function sendNote(waitingAnswer: boolean) {
    return waitingAnswer
      ? wfAction('answer', { body: workflowNote.value })
      : wfAction('note', { body: workflowNote.value });
  }

  /** reset on task switch: a note dragged across a navigation is a wrong-task submit */
  function resetWorkflow() {
    workflowNote.value = '';
    workflowMessage.value = '';
    workflowFailed.value = false;
    verdictFailed.value = false;
    workflowOk.value = true;
  }

  return {
    workflowNote,
    workflowBusy,
    workflowMessage,
    workflowOk,
    workflowFailed,
    verdictSeq,
    verdictFailed,
    wfAction,
    sendNote,
    resetWorkflow,
  };
}

/**
 * Working gate (the drawer + task-page verbs): ready/working/paused are the
 * work states where cancel applies (the server's abandon accepts exactly
 * these). A null category (statuses loading or failed) is NEVER a working
 * state — the verbs would render where the server cannot tell the task's
 * state yet.
 */
export function workingReady(category: string | null | undefined): boolean {
  return category === CATEGORY.READY || category === CATEGORY.WORKING || category === CATEGORY.PAUSED;
}

/**
 * Submit gate (SPEC #177 + the server's submitResult: working category AND the
 * viewer IS the human assignee — nobody else's submit lands, 'only the
 * assignee can submit'; AI assignees submit via the run envelope). In-progress
 * only: ready/paused submit is refused server-side, so the verb never renders
 * there.
 */
export function submitReady(input: {
  category: string | null | undefined;
  assigneeId: string | null | undefined;
  assigneeKind: string | null | undefined;
  userId: string | null | undefined;
}): boolean {
  return (
    input.category === CATEGORY.WORKING &&
    input.assigneeKind !== 'ai' &&
    !!input.assigneeId &&
    input.assigneeId === input.userId
  );
}

/**
 * Cancel gate (the server's abandon in work states: the task's owner or its
 * assignee — a third-party viewer gets a refused verb, never a dead button).
 */
export function cancelReady(input: {
  category: string | null | undefined;
  assigneeId: string | null | undefined;
  ownerId: string | null | undefined;
  userId: string | null | undefined;
}): boolean {
  return (
    workingReady(input.category) &&
    !!input.userId &&
    (input.ownerId === input.userId || input.assigneeId === input.userId)
  );
}

/**
 * Dispatch gate (SPEC #177): Dispatch now renders ONLY for an AI assignee in a
 * ready-category status with NO live run — the server (requireDispatchable)
 * refuses everything else, so the verb renders exactly then, never disabled.
 */
export function dispatchReady(input: {
  category: string | null | undefined;
  assigneeKind: string | null | undefined;
  running: boolean;
}): boolean {
  return !input.running && input.category === CATEGORY.READY && input.assigneeKind === 'ai';
}

/**
 * Forward gate (SPEC: workflow verbs render ONLY where the server accepts
 * them): the server rejects forward unless the task is waiting-answer AND the
 * caller is the pending answer obligation's holder — so the verb renders
 * exactly then, never while the task is merely working.
 */
export function forwardReady(input: {
  category: string | null | undefined;
  holderId: string | null | undefined;
  userId: string | null | undefined;
}): boolean {
  return input.category === CATEGORY.WAITING_ANSWER && !!input.holderId && input.holderId === input.userId;
}

/**
 * Composer/send gate: `statuses` must have resolved AND named a category. While a
 * status list is loading (or failed) the category is null, and defaulting to the
 * note verb would silently post a note where the user expected an answer.
 */
export function composerAction(category: string | null | undefined): 'answer' | 'note' {
  return category === 'waiting_answer' ? 'answer' : 'note';
}

export function composerReady(category: string | null | undefined, text: string): boolean {
  return !!category && text.trim().length > 0;
}
