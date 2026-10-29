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

  it('composerHint mirrors the note verb’s server rules', async () => {
    const m = await import('../../app/composables/useWorkflowActions.ts');
    expect(m.composerHint({ category: CATEGORY.READY, assigneeKind: 'ai', running: true })).toContain('steering');
    expect(m.composerHint({ category: CATEGORY.READY, assigneeKind: 'ai', running: false })).toContain('dispatches');
    expect(m.composerHint({ category: CATEGORY.READY, assigneeKind: 'human', running: false })).toContain('thread');
    expect(m.composerHint({ category: CATEGORY.DONE, assigneeKind: 'ai', running: false })).toContain('thread');
    expect(m.composerHint({ category: null, assigneeKind: null, running: false })).toContain('thread');
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

    // escalate is a verdict verb too: it posts to tasks.escalate and counts a bump
    await expect(wf.wfAction('escalate', { body: 'escalate to Zed for reviewing — no vault access' })).resolves.toBe(
      true,
    );
    expect(calls.at(-1)).toMatchObject({ proc: 'escalate', input: { taskId: 'task-1' } });
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
