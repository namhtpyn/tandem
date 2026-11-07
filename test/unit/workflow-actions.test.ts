// useWorkflowActions — the shared verb ladder. The oRPC client and the query
// client are stubbed at the seams (useNuxtApp / useQueryClient); every verb's
// input shape, copy and cache invalidation is pinned here.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: Array<{ proc: string; input: Record<string, unknown> }> = [];
let nextResult: unknown = { ok: true };
let nextError: unknown = null;
const invalidated: Array<readonly unknown[]> = [];

vi.mock('@tanstack/vue-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: (opts: { queryKey: readonly unknown[] }) => {
      invalidated.push(opts.queryKey);
    },
  }),
}));

const g = globalThis as Record<string, unknown>;
g.useNuxtApp = () => ({
  $client: {
    tasks: new Proxy(
      {},
      {
        get: (_t, proc: string) => (input: Record<string, unknown>) => {
          calls.push({ proc, input });
          if (nextError) throw nextError;
          return Promise.resolve(nextResult);
        },
      },
    ),
  },
});

// the composable reads taskId fresh on every call (navigation law)
let currentId: string | null | undefined = 'task-1';
let workflowNoteValue = '';

beforeEach(() => {
  calls.length = 0;
  invalidated.length = 0;
  nextResult = { ok: true };
  nextError = null;
  currentId = 'task-1';
  workflowNoteValue = '';
});

async function fresh() {
  const m = await import('../../app/composables/useWorkflowActions.ts');
  const wf = m.useWorkflowActions(() => currentId);
  wf.workflowNote.value = workflowNoteValue;
  return { m, wf };
}

import { CATEGORY } from '#shared/enums';
import { nonNull } from '#shared/utils/non-null';

describe('workflow copy helpers', () => {
  it('noteSuccessCopy names the outcome, never guesses', async () => {
    const m = await import('../../app/composables/useWorkflowActions.ts');
    expect(m.noteSuccessCopy({ steered: true })).toContain('running agent');
    expect(m.noteSuccessCopy({ steered: false, dispatched: true })).toContain('dispatched');
    expect(m.noteSuccessCopy({ steered: false })).toBe(m.WF_COPY.note.ok);
  });

  it('composerHint mirrors the note verb’s server rules (#265: every non-terminal, non-in-review AI task dispatches)', async () => {
    const m = await import('../../app/composables/useWorkflowActions.ts');
    expect(m.composerHint({ category: CATEGORY.READY, assigneeKind: 'ai', running: true })).toContain('steering');
    expect(m.composerHint({ category: CATEGORY.READY, assigneeKind: 'ai', running: false })).toContain('dispatches');
    // #265: the dispatch branch is the SERVER's rule — ready was a lie for
    // working/blocked/backlog/paused/waiting AI tasks (the send dispatches there)
    expect(m.composerHint({ category: CATEGORY.WORKING, assigneeKind: 'ai', running: false })).toContain('dispatches');
    expect(m.composerHint({ category: CATEGORY.PAUSED, assigneeKind: 'ai', running: false })).toContain('dispatches');
    expect(m.composerHint({ category: CATEGORY.BACKLOG, assigneeKind: 'ai', running: false })).toContain('dispatches');
    // waiting-answer routes the send to the ANSWER verb — its own wording, the
    // agent's turn re-arms on an AI assignee (#265 r2: the note verb's dispatch
    // promise can never ride a verb the send never reaches). Holder-scoped:
    // holder-ship uncomputable (no open obligation) reads neutral (r5)
    expect(m.composerHint({ category: CATEGORY.WAITING_ANSWER, assigneeKind: 'ai', running: false })).toBe(
      'Sends the note',
    );
    expect(m.composerHint({ category: CATEGORY.WAITING_ANSWER, assigneeKind: 'ai' })).toBe('Sends the note');
    expect(m.composerHint({ category: CATEGORY.WAITING_ANSWER, assigneeKind: 'human', viewerCanAnswer: true })).toBe(
      'Sends the answer',
    );
    // the answer verb's actor is the question's current holder — other viewers
    // read neutral wording (tasks.answer refuses non-chain senders, r4)
    expect(m.composerHint({ category: CATEGORY.WAITING_ANSWER, assigneeKind: 'ai', viewerCanAnswer: false })).toBe(
      'Sends the note',
    );
    expect(m.composerHint({ category: CATEGORY.WAITING_ANSWER, assigneeKind: 'ai', viewerCanAnswer: true })).toContain(
      'answer',
    );
    // a pending dispatch backoff defers the run — never promise it (r4)
    expect(m.composerHint({ category: CATEGORY.READY, assigneeKind: 'ai', backoffPending: true })).toBe(
      'Sends the note',
    );
    // exclusions mirror the server: in-review and terminal categories, humans
    expect(m.composerHint({ category: CATEGORY.IN_REVIEW, assigneeKind: 'ai', running: false })).toContain('thread');
    expect(m.composerHint({ category: CATEGORY.DONE, assigneeKind: 'ai', running: false })).toContain('thread');
    expect(m.composerHint({ category: CATEGORY.CANCELLED, assigneeKind: 'ai', running: false })).toContain('thread');
    expect(m.composerHint({ category: CATEGORY.READY, assigneeKind: 'human', running: false })).toContain('thread');
    expect(m.composerHint({ category: null, assigneeKind: null, running: false })).toContain('thread');
    // an UNKNOWN run state (feed pending/failed) promises nothing — no dispatch,
    // no steering, no thread-only claim it cannot back (#265 r1)
    expect(m.composerHint({ category: CATEGORY.READY, assigneeKind: 'ai', running: null })).toBe('Sends the note');
    expect(m.composerHint({ category: CATEGORY.READY, assigneeKind: 'ai', running: undefined })).toBe('Sends the note');
    expect(m.composerHint({ category: CATEGORY.WORKING, assigneeKind: 'ai', running: null })).toBe('Sends the note');
  });

  it('noteWillDispatch is the shared dispatch predicate (#265)', async () => {
    const m = await import('../../app/composables/useWorkflowActions.ts');
    for (const category of [CATEGORY.READY, CATEGORY.WORKING, CATEGORY.PAUSED, CATEGORY.BACKLOG])
      expect(m.noteWillDispatch({ category, assigneeKind: 'ai' }), category).toBe(true);
    // waiting-answer excluded: the send is the ANSWER verb there (r2)
    for (const category of [CATEGORY.IN_REVIEW, CATEGORY.DONE, CATEGORY.CANCELLED, CATEGORY.WAITING_ANSWER])
      expect(m.noteWillDispatch({ category, assigneeKind: 'ai' }), category).toBe(false);
    expect(m.noteWillDispatch({ category: CATEGORY.READY, assigneeKind: 'human' })).toBe(false);
    expect(m.noteWillDispatch({ category: CATEGORY.READY, assigneeKind: null })).toBe(false);
    expect(m.noteWillDispatch({ category: null, assigneeKind: 'ai' })).toBe(false);
  });

  it('WF_COPY names every verb', async () => {
    const m = await import('../../app/composables/useWorkflowActions.ts');
    for (const verb of [
      'dispatch',
      'note',
      'submit',
      'ask',
      'forward',
      'answer',
      'approve',
      'requestChanges',
      'reject',
      'abandon',
    ] as const) {
      expect(m.WF_COPY[verb].ok, verb).toBeTruthy();
      expect(m.WF_COPY[verb].fail, verb).toBeTruthy();
    }
  });

  it('composerAction + composerReady gate the send', async () => {
    const m = await import('../../app/composables/useWorkflowActions.ts');
    expect(m.composerAction('waiting_answer')).toBe('answer');
    expect(m.composerAction(CATEGORY.READY)).toBe('note');
    expect(m.composerAction(null)).toBe('note');
    expect(m.composerReady(null, 'hi')).toBe(false);
    expect(m.composerReady(CATEGORY.READY, '   ')).toBe(false);
    expect(m.composerReady(CATEGORY.READY, 'hi')).toBe(true);
  });
});

describe('wfAction', () => {
  it('dispatches with the task id and invalidates the three feeds', async () => {
    const { wf } = await fresh();
    await expect(wf.wfAction('dispatch')).resolves.toBe(true);
    expect(calls).toEqual([{ proc: 'dispatch', input: { taskId: 'task-1' } }]);
    expect(wf.workflowMessage.value).toBe('Agent dispatched');
    expect(wf.workflowOk.value).toBe(true);
    expect(invalidated.map((k) => k[0])).toEqual(['TASKS', 'TASK_ACTIVITY', 'RUNS']);
  });

  it('sends a note with a required body and reports steering/dispatch', async () => {
    workflowNoteValue = 'hello';
    const { wf } = await fresh();
    nextResult = { steered: false, dispatched: true };
    await expect(wf.sendNote(false)).resolves.toBe(true);
    expect(calls[0]).toEqual({ proc: 'note', input: { taskId: 'task-1', body: 'hello' } });
    expect(wf.workflowMessage.value).toContain('dispatched');
    // the sent text is cleared; nothing else is
    expect(wf.workflowNote.value).toBe('');
  });

  it('routes the composer to answer while waiting, and forward carries the target', async () => {
    workflowNoteValue = 'ans';
    const { wf } = await fresh();
    await expect(wf.sendNote(true)).resolves.toBe(true);
    expect(nonNull(calls[0]).proc).toBe('answer');
    await expect(wf.wfAction('forward', { toEmployeeId: 'e2' })).resolves.toBe(true);
    expect(nonNull(calls[1])).toEqual({ proc: 'forward', input: { taskId: 'task-1', toEmployeeId: 'e2' } });
  });

  it('ask and requestChanges ride the same ladder with required bodies', async () => {
    const { wf } = await fresh();
    await expect(wf.wfAction('ask', { body: 'what next?' })).resolves.toBe(true);
    expect(nonNull(calls[0]).proc).toBe('ask');
    await expect(wf.wfAction('requestChanges', { body: 'tighten it' })).resolves.toBe(true);
    expect(nonNull(calls[1]).proc).toBe('requestChanges');
    expect(wf.verdictFailed.value).toBe(false);
  });

  it('omits an empty body on submit (server defaults it)', async () => {
    const { wf } = await fresh();
    await expect(wf.wfAction('submit')).resolves.toBe(true);
    expect(calls[0].input).toEqual({ taskId: 'task-1', body: undefined });
  });

  it('survives a null task id and a busy ladder', async () => {
    currentId = null;
    const { wf } = await fresh();
    await expect(wf.wfAction('dispatch')).resolves.toBe(false);
    expect(calls).toHaveLength(0);

    // busy guard: a second verb while one is in flight is refused, not queued
    let release: (v: unknown) => void = () => {};
    nextResult = new Promise((r) => (release = r));
    currentId = 'task-1';
    const first = wf.wfAction('dispatch');
    await expect(wf.wfAction('dispatch')).resolves.toBe(false);
    release({ ok: true });
    await expect(first).resolves.toBe(true);
  });

  it('renders the server message on failure and marks the verb failed', async () => {
    const { wf } = await fresh();
    nextError = { data: { json: { message: 'task is running — status is locked' } } };
    await expect(wf.wfAction('dispatch')).resolves.toBe(false);
    expect(wf.workflowMessage.value).toBe('task is running — status is locked');
    expect(wf.workflowOk.value).toBe(false);
    expect(wf.workflowFailed.value).toBe(true);
    expect(invalidated).toHaveLength(0);
  });

  it('falls back to the verb copy when the failure has no server message', async () => {
    const { wf } = await fresh();
    nextError = 'no message'; // not an Error instance → the ladder reaches the verb copy
    await expect(wf.wfAction('abandon')).resolves.toBe(false);
    expect(wf.workflowMessage.value).toBe("Couldn't cancel the task — try again");
  });

  it('bumps verdictSeq on verdict verbs only — success clears it, failure flags it', async () => {
    currentId = 'task-1'; // tests shuffle — never trust the previous test's id
    const { wf } = await fresh();
    await expect(wf.wfAction('approve')).resolves.toBe(true);
    expect(wf.verdictSeq.value).toBe(1);
    expect(wf.verdictFailed.value).toBe(false);

    // requestChanges is a verdict verb too — it counts a bump
    await expect(wf.wfAction('requestChanges', { body: 'tighten the test' })).resolves.toBe(true);
    expect(calls.at(-1)).toMatchObject({ proc: 'requestChanges', input: { taskId: 'task-1' } });
    expect(wf.verdictSeq.value).toBe(2);

    nextError = new Error('no round');
    await expect(wf.wfAction('reject')).resolves.toBe(false);
    expect(wf.verdictSeq.value).toBe(3);
    expect(wf.verdictFailed.value).toBe(true);

    nextError = null; // the non-verdict arm runs clean again
    const before = wf.verdictSeq.value;
    await expect(wf.wfAction('dispatch')).resolves.toBe(true);
    expect(wf.verdictSeq.value).toBe(before);
  });

  it('resetWorkflow clears every writable field', async () => {
    const { wf } = await fresh();
    wf.workflowNote.value = 'draft';
    wf.workflowMessage.value = 'x';
    wf.workflowFailed.value = true;
    wf.verdictFailed.value = true;
    wf.resetWorkflow();
    expect(wf.workflowNote.value).toBe('');
    expect(wf.workflowMessage.value).toBe('');
    expect(wf.workflowFailed.value).toBe(false);
    expect(wf.verdictFailed.value).toBe(false);
    expect(wf.workflowOk.value).toBe(true);
  });

  it('a half-typed note survives a bodyless verb', async () => {
    workflowNoteValue = 'keep me';
    const { wf } = await fresh();
    await expect(wf.wfAction('approve')).resolves.toBe(true);
    expect(wf.workflowNote.value).toBe('keep me');
  });
});

// forwardReady — the Forward verb renders ONLY where the server accepts it
// (SPEC: waiting-answer + viewer is the current answer holder). The drawer
// showed the verb in ready/working/paused states where the server always
// rejected it (#92) and hid it in the only legal state.
describe('forwardReady gate', () => {
  it.each([
    ['waiting_answer + holder is the viewer', CATEGORY.WAITING_ANSWER, 'u-1', 'u-1', true],
    ['waiting_answer but a non-holder viewer', CATEGORY.WAITING_ANSWER, 'u-1', 'u-2', false],
    ['working state, even for the holder', CATEGORY.WORKING, 'u-1', 'u-1', false],
    ['ready state', CATEGORY.READY, 'u-1', 'u-1', false],
    ['in-review state', CATEGORY.IN_REVIEW, 'u-1', 'u-1', false],
  ])('%s', async (_label, category, holderId, userId, expected) => {
    const m = await import('../../app/composables/useWorkflowActions.ts');
    expect(m.forwardReady({ category, holderId, userId })).toBe(expected);
  });

  it('loading/failed statuses (null category) and a missing holder never arm the verb', async () => {
    const m = await import('../../app/composables/useWorkflowActions.ts');
    expect(m.forwardReady({ category: null, holderId: 'u-1', userId: 'u-1' })).toBe(false);
    expect(m.forwardReady({ category: undefined, holderId: 'u-1', userId: 'u-1' })).toBe(false);
    expect(m.forwardReady({ category: CATEGORY.WAITING_ANSWER, holderId: null, userId: 'u-1' })).toBe(false);
    expect(m.forwardReady({ category: CATEGORY.WAITING_ANSWER, holderId: undefined, userId: 'u-1' })).toBe(false);
    expect(m.forwardReady({ category: CATEGORY.WAITING_ANSWER, holderId: 'u-1', userId: null })).toBe(false);
  });
});

// task-page verb gates (#177, SPEC: verbs render ONLY where the server accepts
// them — requireDispatchable = ready category + AI assignee + no live run;
// submit = working category + HUMAN assignee; cancel = working states). A null
// category (statuses loading/failed) arms NOTHING.
describe('task-page verb gates (working/submit/dispatch)', () => {
  it.each([
    ['ready', CATEGORY.READY, true],
    ['working', CATEGORY.WORKING, true],
    ['paused', CATEGORY.PAUSED, true],
    ['in-review', CATEGORY.IN_REVIEW, false],
    ['waiting_answer', CATEGORY.WAITING_ANSWER, false],
    ['null category (statuses still loading)', null, false],
  ])('workingReady: %s', async (_label, category, expected) => {
    const m = await import('../../app/composables/useWorkflowActions.ts');
    expect(m.workingReady(category as never)).toBe(expected);
  });

  it.each([
    ['human assignee, in progress, viewer IS the assignee', CATEGORY.WORKING, 'u-1', 'human', 'u-1', true],
    ['viewer is NOT the assignee — server refuses', CATEGORY.WORKING, 'u-2', 'human', 'u-1', false],
    ['unassigned task — nobody can submit', CATEGORY.WORKING, null, null, 'u-1', false],
    ['AI assignee submits via the envelope, never the verb', CATEGORY.WORKING, 'ai-1', 'ai', 'ai-1', false],
    ['ready state is not in progress — server refuses', CATEGORY.READY, 'u-1', 'human', 'u-1', false],
    ['paused state — server refuses', CATEGORY.PAUSED, 'u-1', 'human', 'u-1', false],
    ['statuses not yet loaded (null category)', null, 'u-1', 'human', 'u-1', false],
  ])('submitReady: %s', async (_label, category, assigneeId, kind, userId, expected) => {
    const m = await import('../../app/composables/useWorkflowActions.ts');
    expect(
      m.submitReady({ category: category as never, assigneeId: assigneeId as never, assigneeKind: kind, userId }),
    ).toBe(expected);
  });

  // #223 VERB RENDER-PARITY: cancel obeys the SAME server truth as dispatch —
  // the abandon refuses over a live run ('cancel the running run first'), so a
  // live run hides the verb on every surface and the confirm copy never lies.
  it.each([
    ['owner in a work state, no live run', CATEGORY.READY, 'u-2', 'u-1', 'u-1', false, true],
    ['assignee in a work state, no live run', CATEGORY.WORKING, 'u-1', 'u-2', 'u-1', false, true],
    ['a live run blocks cancel — server refuses the abandon', CATEGORY.WORKING, 'u-1', 'u-1', 'u-1', true, false],
    ['live run in a ready state', CATEGORY.READY, 'u-2', 'u-1', 'u-1', true, false],
    ['third-party viewer — server refuses the abandon', CATEGORY.WORKING, 'u-2', 'u-2', 'u-1', false, false],
    ['terminal state (done)', CATEGORY.DONE, 'u-2', 'u-1', 'u-1', false, false],
    ['no session', CATEGORY.WORKING, 'u-2', 'u-1', null, false, false],
    ['statuses not yet loaded (null category)', null, 'u-2', 'u-1', 'u-1', false, false],
  ])('cancelReady: %s', async (_label, category, assigneeId, ownerId, userId, running, expected) => {
    const m = await import('../../app/composables/useWorkflowActions.ts');
    expect(
      m.cancelReady({ category: category as never, assigneeId: assigneeId as never, ownerId, userId, running }),
    ).toBe(expected);
  });

  it.each([
    ['AI assignee, ready, no live run', CATEGORY.READY, 'ai', false, true],
    ['a live run blocks re-dispatch', CATEGORY.READY, 'ai', true, false],
    ['left the ready category (doing)', CATEGORY.WORKING, 'ai', false, false],
    ['human assignee — nothing to dispatch', CATEGORY.READY, 'human', false, false],
    ['AI assignee, statuses not yet loaded', null, 'ai', false, false],
  ])('dispatchReady: %s', async (_label, category, kind, running, expected) => {
    const m = await import('../../app/composables/useWorkflowActions.ts');
    expect(m.dispatchReady({ category: category as never, assigneeKind: kind, running })).toBe(expected);
  });
});

// #229 STOP-RUN VERB: one click ends the task's live agent run. The gate is the
// pure run-state flag (the server's stopRunForTask owns every other rule —
// owner checks, the CAS against the settled turn), so the verb renders exactly
// while agentRunning and its truth table has NO other inputs.
describe('stop verb (#229)', () => {
  it('stopReady is exactly the live-run flag — no category/assignee field arms or leaks in', async () => {
    const m = await import('../../app/composables/useWorkflowActions.ts');
    expect(m.stopReady({ running: true })).toBe(true);
    // the gate takes NO other fields: `{ running }` alone must typecheck and
    // decide — a task's category/assignee state can never arm a stop button
    expect(m.stopReady({ running: false })).toBe(false);
  });

  it('calls the tasks.stop proxy with the task id, names the stop copy, invalidates the three feeds', async () => {
    const { wf } = await fresh();
    await expect(wf.wfAction('stop')).resolves.toBe(true);
    expect(calls).toEqual([{ proc: 'stop', input: { taskId: 'task-1' } }]);
    expect(wf.workflowMessage.value).toBe('Run stopped');
    expect(wf.workflowOk.value).toBe(true);
    // the same three feeds every verb invalidates: TASKS, TASK_ACTIVITY+id, RUNS+id
    expect(invalidated.map((k) => k[0])).toEqual(['TASKS', 'TASK_ACTIVITY', 'RUNS']);
    expect(invalidated[1]).toContain('task-1');
    expect(invalidated[2]).toContain('task-1');
  });

  it('falls back to the stop copy on failure and marks the verb failed', async () => {
    const { wf } = await fresh();
    nextError = 'no message'; // not an Error instance → the ladder reaches the verb copy
    await expect(wf.wfAction('stop')).resolves.toBe(false);
    expect(wf.workflowMessage.value).toBe("Couldn't stop the run — try again");
    expect(wf.workflowOk.value).toBe(false);
    expect(wf.workflowFailed.value).toBe(true);
    expect(invalidated).toHaveLength(0);
  });
});
