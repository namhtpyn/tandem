// Shared workflow verbs for a task: the dispatch/note/submit/ask/forward/answer/
// verdict/abandon ladder, its copy, and the cache feeds every verb invalidates.
// The task page and the privacy drawer drive the SAME ladder — duplicating the
// switch in two components let the two surfaces drift (one cleared the note, the
// other kept it; one refreshed runs, the other didn't).
import { useQueryClient } from '@tanstack/vue-query';
import { ref } from 'vue';

import { CHANGE_RESOURCE } from '#shared/enums';
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

  /** returns true when the verb landed (callers gate on it before closing a drawer) */
  async function wfAction(action: WorkflowAction, extra: WorkflowExtra = {}): Promise<boolean> {
    // capture the id BEFORE the await: the page can navigate mid-flight and
    // task.value would then point at a different task (or null)
    const id = taskId();
    if (!id || workflowBusy.value) return false;
    workflowBusy.value = true;
    workflowMessage.value = '';
    workflowFailed.value = false;
    try {
      const input = { taskId: id, ...extra };
      await {
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
      // only clear the text this call actually sent: a note typed while the
      // request was in flight must survive the success clear
      if (workflowNote.value === (extra.body ?? workflowNote.value)) workflowNote.value = '';
      // invalidate ALL dependent feeds: TASKS re-syncs the row (status/reviewers),
      // TASK_ACTIVITY keeps the thread, review checklist and activity feed current
      // (the reviews cache sits under the TASK_ACTIVITY prefix), RUNS refreshes the
      // run cards a dispatch/verdict just changed.
      void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASKS] });
      void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.TASK_ACTIVITY, id] });
      void queryClient.invalidateQueries({ queryKey: [CHANGE_RESOURCE.RUNS, id] });
      workflowMessage.value = WF_COPY[action].ok;
      workflowOk.value = true;
      return true;
    } catch (e) {
      // surface the server's oRPC message, not ofetch's generic '[POST] …: 400'
      workflowMessage.value = errorMessage(e, WF_COPY[action].fail);
      workflowOk.value = false;
      workflowFailed.value = true;
      return false;
    } finally {
      workflowBusy.value = false;
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
    workflowOk.value = true;
  }

  return {
    workflowNote,
    workflowBusy,
    workflowMessage,
    workflowOk,
    workflowFailed,
    wfAction,
    sendNote,
    resetWorkflow,
  };
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
